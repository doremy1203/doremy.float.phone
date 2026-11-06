"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";

import { loadCharacters } from "@/lib/character-storage";
import { CLOUD_BACKUP_BUCKET, normalizeBackupUrl } from "@/lib/cloud-backup/config";
import { pollRealityBridgeNow, REALITY_BRIDGE_FEED_UPDATED_EVENT } from "@/components/reality-bridge-scheduler";
import { previewBridgeRuleText, testRunRule } from "@/lib/reality-bridge/engine";
import {
  bridgeConnection,
  clearBridgeFeed,
  getBridgeRuleLastRunAt,
  loadBridgeDataItems,
  loadBridgeFeed,
  loadBridgeRules,
  loadBridgeSettings,
  loadBridgeShortcutActions,
  saveShortcutEmailReady,
  loadScreenChatSettings,
  parseBridgeActionParameterSchema,
  readBridgeStateSnapshot,
  sanitizeBridgeDataKey,
  saveBridgeDataItems,
  saveBridgeRules,
  saveBridgeSettings,
  saveBridgeShortcutActions,
  saveScreenChatSettings,
  type BridgeDataItem,
  type BridgeShortcutAction,
  type ScreenChatSettings,
} from "@/lib/reality-bridge/storage";
import type { BridgeRule } from "@/lib/reality-bridge/types";
import { buildChatPromptMessages, sendLLMRequest } from "@/lib/chat-engine";
import { loadChatMessages, loadChatSessions } from "@/lib/chat-storage";
import { createShortcutCommand, loadRecentShortcutCommands, type ShortcutCommand } from "@/lib/shortcut-command-client";
import { enableOfflinePush, isShellEnvironment, sendShellTestPush } from "@/lib/push-client";
import { describeBridgePlatform } from "@/lib/shell-detect";
import {
  isPersonalPushCloudActive,
  isPersonalScreenChatCloudReady,
  personalPushFetch,
} from "@/lib/personal-push-cloud";
import { isValidShortcutEmailAddress, shortcutEmailSubjectTag } from "@/lib/shortcut-email";
import { readPerceptionDiagnostics } from "@/lib/perception";
import { RESERVED_INTERNAL_TOOL_NAMES } from "@/lib/internal-capability-storage";
import { DEVICE_ACTION_LABEL, loadDeviceActionConfig, TOGGLEABLE_ACTIONS, hasDeviceActionBridge } from "@/lib/device-action";
import { getEnabledTools } from "@/lib/tool-storage";

type TabId = "main" | "history";

type ShortcutEmailStatus = {
  providerConfigured: boolean;
  senderAddress: string;
  recipient: string;
  verified: boolean;
  verificationExpiresAt?: string;
};

function newRule(): BridgeRule {
  return {
    id: `rule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    matchType: "",
    enabled: true,
    process: { mode: "raw", template: "", prompt: "" },
    actions: {},
    createdAt: new Date().toISOString(),
  };
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

const SHORTCUT_PARAMETER_SCHEMAS = {
  none: "{}",
  text: JSON.stringify({
    type: "object",
    properties: {
      content: { type: "string", description: "要交给快捷指令处理的内容" },
    },
    required: ["content"],
  }, null, 2),
  wait: JSON.stringify({
    type: "object",
    properties: {
      waitSeconds: { type: "number", description: "打开目标 APP 后等待多少秒，默认 2", minimum: 0, maximum: 10 },
    },
  }, null, 2),
} as const;

/* 参数清单 ↔ JSON Schema 互转：用户只填参数行，Schema 自动生成 */
type ShortcutParamRow = { key: string; type: "string" | "number"; description: string };

function parseShortcutParamRows(schemaText: string): ShortcutParamRow[] | null {
  try {
    const parsed = JSON.parse(schemaText || "{}") as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const props = (parsed as { properties?: unknown }).properties;
    if (props === undefined) return [];
    if (!props || typeof props !== "object" || Array.isArray(props)) return null;
    const rows: ShortcutParamRow[] = [];
    for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) return null;
      const type = String((def as { type?: unknown }).type ?? "string");
      if (type !== "string" && type !== "number" && type !== "integer") return null;
      rows.push({
        key,
        type: type === "integer" ? "number" : type as ShortcutParamRow["type"],
        description: String((def as { description?: unknown }).description ?? ""),
      });
    }
    return rows;
  } catch {
    return null;
  }
}

function buildShortcutParamSchema(rows: ShortcutParamRow[]): string {
  const clean = rows.filter(row => row.key.trim());
  if (clean.length === 0) return "{}";
  const properties: Record<string, unknown> = {};
  for (const row of clean) {
    properties[row.key.trim()] = {
      type: row.type,
      ...(row.description.trim() ? { description: row.description.trim() } : {}),
    };
  }
  return JSON.stringify({ type: "object", properties, required: clean.map(row => row.key.trim()) }, null, 2);
}

/*
 * 从一个工具的 parameterSchema 里抽出「有哪些参数、什么类型、必填不必填、是干什么的」。
 *
 * 现实桥选工具那一步原本只给一个空白 JSON 框，用户不知道这个工具接哪些键
 * （实测反馈）。而这些信息就在 EnabledTool.parameterSchema 里，纯粹是没用上。
 *
 * 解析失败一律返回空数组——宁可退回原来的「手写 JSON」，也不能因为某个工具的
 * schema 不规范就把这一步整个弄崩。
 */
type ToolParamField = { key: string; type: string; required: boolean; description: string };

function parseToolParamFields(schemaText?: string): ToolParamField[] {
  if (!schemaText) return [];
  try {
    const parsed = JSON.parse(schemaText) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const props = parsed.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return [];
    const required = Array.isArray(parsed.required) ? parsed.required.map(String) : [];
    const fields: ToolParamField[] = [];
    for (const [key, def] of Object.entries(props as Record<string, unknown>)) {
      if (!def || typeof def !== "object" || Array.isArray(def)) continue;
      const raw = (def as { type?: unknown }).type;
      // 联合类型（如 ["number","string"]）取第一个可识别的
      const type = Array.isArray(raw) ? String(raw[0] ?? "string") : String(raw ?? "string");
      fields.push({
        key,
        type,
        required: required.includes(key),
        description: String((def as { description?: unknown }).description ?? ""),
      });
    }
    return fields;
  } catch {
    return [];
  }
}

function newDataItem(): BridgeDataItem {
  return {
    id: `data_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    key: "",
    description: "",
    createdAt: new Date().toISOString(),
  };
}

function newShortcutAction(): BridgeShortcutAction {
  return {
    id: `shortcut_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: "",
    shortcutName: "",
    description: "",
    parameterSchema: SHORTCUT_PARAMETER_SCHEMAS.none,
    resultMode: "none",
    deliveryMode: "push",
    expiresInSeconds: 120,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function shortcutStatusLabel(status: ShortcutCommand["status"]): string {
  if (status === "pending") return "等待执行";
  if (status === "claimed") return "执行中";
  if (status === "succeeded") return "已完成";
  if (status === "failed") return "失败";
  if (status === "expired") return "已过期";
  return "已取消";
}

function fmtHM(ms: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

const FREQ_OPTIONS = [
  { value: 15, label: "15秒" },
  { value: 20, label: "20秒" },
  { value: 30, label: "30秒" },
  { value: 60, label: "1分" },
  { value: 300, label: "5分" },
] as const;

/* 细线图标（与参考风格一致的 stroke 图形） */
const RB_SVG = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
const RB_ICON_PHONE = <svg {...RB_SVG}><rect x="7" y="2" width="10" height="20" rx="2.5" /><path d="M11 18h2" /></svg>;
const RB_ICON_CHAT = <svg {...RB_SVG}><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" /></svg>;
const RB_ICON_BOOK = <svg {...RB_SVG}><path d="M4 19V5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" /><path d="M9 7h6" /></svg>;
const RB_ICON_CALENDAR = <svg {...RB_SVG}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>;
const RB_ICON_BELL = <svg {...RB_SVG}><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>;
const RB_ICON_CARD = <svg {...RB_SVG}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3 10h18" /></svg>;
const RB_ICON_BROADCAST = <svg {...RB_SVG}><circle cx="12" cy="12" r="2" /><path d="M7.5 7.5a6.5 6.5 0 0 0 0 9M16.5 7.5a6.5 6.5 0 0 1 0 9" /></svg>;
const RB_ICON_INBOX = <svg {...RB_SVG}><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6z" /></svg>;
const RB_ICON_GEAR = <svg {...RB_SVG}><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /></svg>;
const RB_ICON_HISTORY = <svg {...RB_SVG}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>;
const RB_ICON_REFRESH = <svg {...RB_SVG}><path d="M21 12a9 9 0 1 1-3-6.7L21 8" /><path d="M21 3v5h-5" /></svg>;
const RB_ICON_CHEVRON = <svg {...RB_SVG}><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>;
const RB_ICON_DOTS = <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.9" /><circle cx="12" cy="12" r="1.9" /><circle cx="19" cy="12" r="1.9" /></svg>;
const RB_ICON_ARROW = <svg {...RB_SVG}><path d="M9.5 5.5 16 12l-6.5 6.5" /></svg>;
const RB_ICON_TRASH = <svg {...RB_SVG}><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></svg>;
const RB_ICON_CROSS = <svg {...RB_SVG}><path d="M6 6l12 12M18 6 6 18" /></svg>;
const RB_ICON_CLOCK = <svg {...RB_SVG}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const RB_ICON_CHECK = <svg {...RB_SVG}><path d="M4.5 12.5 10 18 19.5 6.5" /></svg>;

/* 联动的「直接操作手机」动作：切换动作时给一份能直接用的默认参数，
   省得用户面对一堆空字段不知道填什么。 */
const DEVICE_ACTION_DEFAULT_ARGS: Record<string, Record<string, unknown>> = {
  torch: { on: true },
  volume: { stream: "media", mode: "up" },
  brightness: { level: 50 },
  dnd: { on: true },
  openApp: { app: "" },
  alarm: { hour: 22, minute: 30 },
  timer: { minutes: 20 },
  media: { mode: "toggle" },
  openUrl: { url: "" },
};

/**
 * 场景模板：把「我想让角色做的事」直接翻译成一条预填好的规则。
 *
 * 为什么需要它：规则的字段全是给机器看的（matchType / payloadFilter / process.mode /
 * actions.*），新手得先弄懂「信号名是什么」「加工和动作什么关系」才配得出第一条，
 * 最常见的结局是配完了却永远不触发——因为信号名跟实际发出的对不上（实测反馈）。
 *
 * ⚠️ 下面每个 matchType 必须与 lib/perception/engine.ts 里真正 emit 的 type
 * 一字不差。写错的后果不是报错，而是规则静默永不触发——那比没有模板更糟。
 */
type RuleSceneTemplate = {
  id: string;
  /** 卡片标题：用用户的话说「我想让角色……」 */
  title: string;
  desc: string;
  tag: "本机信号" | "定时" | "操作手机";
  /** 信号来自安卓本机桥（感知），iOS 上不会产生 */
  needsAndroid?: boolean;
  build: (ctx: { characterId: string }) => BridgeRule;
};

/**
 * 定时/提醒类模板给角色看的那句提示。
 *
 * 写成括号包住的旁白、而不是角色的台词：让角色**自己组织语言**开口，
 * 每次说法不一样才有活人感。若直接把台词写死，每天收到的都是同一句。
 */
const SCENE_NUDGE_PREFIX = "（";
const SCENE_NUDGE_SUFFIX = "）";

function sceneNudge(text: string): string {
  return `${SCENE_NUDGE_PREFIX}${text}${SCENE_NUDGE_SUFFIX}`;
}

const RULE_SCENE_TEMPLATES: RuleSceneTemplate[] = [
  {
    id: "scene_back_to_phone",
    title: "我回到小手机时理我一下",
    desc: "离开一会儿再回来，角色会察觉并主动开口。不需要任何权限。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "我回到小手机时理我一下",
      matchType: "回到手机",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 15,
    }),
  },
  {
    id: "scene_long_use",
    title: "连续刷手机太久时提醒我",
    desc: "同一个应用连续用太久（多久算久在「感知」里调），角色会看出来并提醒你。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "刷太久时提醒我",
      matchType: "长时间使用",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 30,
    }),
  },
  {
    id: "scene_battery_low",
    title: "电量低时告诉我",
    desc: "电量掉到阈值以下，角色会知道并提醒你充电。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "电量低时告诉我",
      matchType: "电量偏低",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_charging_start",
    title: "插上充电时告诉我",
    desc: "检测到开始充电时触发；角色可结合当下情境自然回应。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "开始充电时互动",
      matchType: "充电开始",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_charging_end",
    title: "充电结束时告诉我",
    desc: "检测到停止充电时触发，适合提醒或轻松互动。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "充电结束时互动",
      matchType: "充电结束",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_network_wifi",
    title: "连上 Wi-Fi 时告诉我",
    desc: "网络状态切换到 Wi-Fi 时触发；只在设备实际检测到变化时发生。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "连接 Wi-Fi 时互动",
      matchType: "连接到 WiFi",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_network_change",
    title: "切换到移动网络时告诉我",
    desc: "网络切换到移动网络时触发；避免把网络变化直接当作精确位置。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "切换到移动网络时互动",
      matchType: "网络切换到移动网络",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },



  {
    id: "scene_app_usage",
    title: "某个应用累计用太久时提醒我",
    desc: "按当天累计使用时长触发；可在规则里填写应用名过滤词，并在感知设置中调整阈值。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "应用累计使用提醒",
      matchType: "应用用太久",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_battery_change",
    title: "电量明显变化时告诉我",
    desc: "电量变化达到感知设置的步进阈值时触发。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "电量变化时互动",
      matchType: "电量变化",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 60,
    }),
  },
  {
    id: "scene_late_night",
    title: "深夜还醒着时关心我",
    desc: "到达感知设置的深夜时段时触发；按天去重。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "深夜关心",
      matchType: "深夜还醒着",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 720,
    }),
  },
  {
    id: "scene_first_open",
    title: "每天第一次打开时打招呼",
    desc: "当天首次打开小手机时触发；不需要 Android 原生权限。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "每日首次见面",
      matchType: "今天第一次打开",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 720,
    }),
  },
  {
    id: "scene_no_talk",
    title: "很久没聊天时主动找我",
    desc: "超过感知设置中的沉默时长后触发；一天最多一次。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "久未聊天主动联系",
      matchType: "很久没聊天",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 720,
    }),
  },
  {
    id: "scene_sit_still",
    title: "久坐不动时提醒我",
    desc: "需要步数/活动识别权限，并且检测到持续使用手机；阈值在感知设置中调整。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "久坐提醒",
      matchType: "久坐不动",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 120,
    }),
  },
  {
    id: "scene_location_change",
    title: "位置变化时让角色知道",
    desc: "需要定位权限；只在检测到足够明显的位置变化时触发，地名可能不准确。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "位置变化互动",
      matchType: "到达新位置",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 180,
    }),
  },
  {
    id: "scene_wake_up",
    title: "检测到睡醒时问候我",
    desc: "需要 Health Connect 睡眠数据及授权；只能依据可读到的睡眠记录触发。",
    tag: "本机信号",
    needsAndroid: true,
    build: ({ characterId }) => ({
      ...newRule(),
      name: "睡醒问候",
      matchType: "睡醒了",
      actions: { chat: { characterId, role: "system", requestReply: true } },
      cooldownMinutes: 360,
    }),
  },
  {
    id: "scene_morning",
    title: "每天早上说句早安",
    desc: "到点角色自己开口，不用你先说话。时间可以改。",
    tag: "定时",
    build: ({ characterId }) => ({
      ...newRule(),
      name: "每天早上说早安",
      matchType: "",
      process: { mode: "template", template: sceneNudge("现在是早上，主动跟{{user}}说声早安吧"), prompt: "" },
      schedule: { kind: "daily", time: "08:00" },
      actions: { chat: { characterId, role: "system", requestReply: true } },
    }),
  },
  {
    id: "scene_sleep_remind",
    title: "睡前提醒我去睡",
    desc: "到点角色提醒你该休息了。时间可以改。",
    tag: "定时",
    build: ({ characterId }) => ({
      ...newRule(),
      name: "睡前提醒我",
      matchType: "",
      process: { mode: "template", template: sceneNudge("已经很晚了，提醒{{user}}该休息了"), prompt: "" },
      schedule: { kind: "daily", time: "23:00" },
      actions: { chat: { characterId, role: "system", requestReply: true } },
    }),
  },
  {
    id: "scene_dim_screen",
    title: "睡前帮我调暗屏幕",
    desc: "到点直接把屏幕亮度调低。需要先在「设置 → 操作设备」里打开亮度开关并授权。",
    tag: "操作手机",
    needsAndroid: true,
    build: () => ({
      ...newRule(),
      name: "睡前调暗屏幕",
      matchType: "",
      schedule: { kind: "daily", time: "23:00" },
      actions: { deviceAction: { action: "brightness", args: { level: 25 } } },
    }),
  },
  {
    id: "scene_dark_flashlight",
    title: "环境很暗时自动开手电筒",
    desc: "照度低于约 15 lux 时直接打开手电筒。需要开启设备操作总开关并允许手电筒动作；启用后会显示 Android 常驻监测通知。强制停止或关机时不会运行。",
    tag: "操作手机",
    needsAndroid: true,
    build: () => ({
      ...newRule(),
      name: "环境很暗时打开手电筒",
      matchType: "环境光线",
      payloadFilter: "很暗",
      cooldownMinutes: 10,
      process: { mode: "template", template: "检测到环境很暗，尝试帮你打开手电筒。", prompt: "" },
      actions: { deviceAction: { action: "torch", args: { on: true } } },
    }),
  },

];

const WIZ_STEP_NAMES = ["接通管道", "创建快捷指令", "选择信号", "加工内容", "决定动作", "测试与保存"] as const;
const SWIZ_STEP_NAMES = ["接通通道", "动作是什么", "触发方式", "参数与结果", "创建快捷指令", "测试与保存"] as const;
const DWIZ_STEP_NAMES = ["接通通道", "数据项是什么", "创建上传快捷指令", "测试与保存"] as const;
const SCREEN_WIZ_STEP_NAMES = ["接通个人云", "选择角色", "创建快捷指令", "确认与启用"] as const;
const SCREEN_CHAT_SHORTCUT_URL = "https://www.icloud.com/shortcuts/d0ce177469a34aceb4c44b6eb14baae0";

function ruleIcon(rule: BridgeRule) {
  if (rule.schedule) return RB_ICON_CLOCK;
  const a = rule.actions ?? {};
  if (a.chat) return RB_ICON_CHAT;
  if (a.card) return RB_ICON_CARD;
  if (a.memory || a.timeline) return RB_ICON_BOOK;
  if (a.calendar) return RB_ICON_CALENDAR;
  if (a.notify) return RB_ICON_BELL;
  if (a.deviceAction) return RB_ICON_GEAR;
  if (a.outbox) return RB_ICON_PHONE;
  if (a.broadcast) return RB_ICON_BROADCAST;
  return RB_ICON_INBOX;
}

/**
 * 现实桥里那些「去设置 → X」的落点。
 *
 * 取值必须是设置页 SubPage 里真实存在的 id（见 phone-settings-app.tsx 的
 * SubPage 联合类型）——写错一个字，用户点下去会落到设置首页而不是目标页。
 */
export type SettingsDeepLinkPage =
  | "perception"
  | "deviceAction"
  | "data"
  | "cloud"
  | "screenshot"
  | "toolbox";

export function RealityBridgeApp({ onClose, onNotice, onOpenSettings }: {
  onClose: () => void;
  onNotice?: (text: string) => void;
  /**
   * 打开设置里的某个子页。安卓桥分区的详细开关都住在设置里，
   * 这里只给一个「去设置 →」的跳板——同一份配置只维护一处，
   * 不在这页重复造开关（造了就会两边不一致）。
   */
  onOpenSettings?: (page: SettingsDeepLinkPage) => void;
}) {
  const [tab, setTab] = useState<TabId>("main");
  const [settings, setSettings] = useState(() => loadBridgeSettings());
  const [rules, setRules] = useState<BridgeRule[]>(() => loadBridgeRules());
  const [deviceActionConfigRevision, setDeviceActionConfigRevision] = useState(0);
  useEffect(() => {
    const onDeviceActionsChanged = () => setDeviceActionConfigRevision(value => value + 1);
    window.addEventListener("device-action-config-changed", onDeviceActionsChanged);
    return () => window.removeEventListener("device-action-config-changed", onDeviceActionsChanged);
  }, []);
  // 安卓壳内把同一份规则同步给原生本机引擎。该链路只写本地 SharedPreferences，
  // 不上传事件；网页关闭后，已同步的系统电源规则仍可独立匹配。
  useEffect(() => {
    if (typeof window === "undefined" || !isShellEnvironment()) return;
    const shell = (window as Window & {
      AndroidShell?: { configureNativeRealityBridge?: (json: string) => boolean };
    }).AndroidShell;
    if (!shell?.configureNativeRealityBridge) return;
    const deviceActionConfig = loadDeviceActionConfig();
    const nativeRules = rules
      .filter(rule => !rule.schedule)
      .map(rule => {
        const chosenAction = rule.actions.deviceAction;
        // Native rules that run with the WebView closed intentionally sync only torch:
        // other actions often need foreground UI, permissions, or user confirmation.
        const canSyncAction = !!chosenAction && chosenAction.action === "torch" && deviceActionConfig.enabled === true && deviceActionConfig.actions[chosenAction.action as keyof typeof deviceActionConfig.actions] === true;
        return {
          id: rule.id,
          name: rule.name,
          matchType: rule.matchType,
          payloadFilter: rule.payloadFilter || "",
          enabled: rule.enabled === true,
          cooldownMinutes: rule.cooldownMinutes || 0,
          process: {
            mode: rule.process?.mode || "raw",
            template: rule.process?.mode === "template" ? rule.process?.template || "" : "",
          },
          offlineReplies: (rule.offlineReplies || []).filter(line => line.trim()).slice(0, 80),
          characterName: loadCharacters().find(character => character.id === rule.actions.chat?.characterId)?.name || "",
          ...(canSyncAction ? { deviceAction: { action: chosenAction!.action, args: chosenAction!.args ?? {} } } : {}),
        };
      });
    const watchesAmbientLight = rules.some(rule => rule.enabled === true && !rule.schedule && rule.matchType === "环境光线" && rule.actions.deviceAction?.action === "torch" && String(rule.actions.deviceAction.args?.on).toLowerCase() === "true" && deviceActionConfig.enabled === true && deviceActionConfig.actions.torch === true);

    try {
      shell.configureNativeRealityBridge(JSON.stringify({
        enabled: settings.enabled !== false,
        deviceActionsEnabled: deviceActionConfig.enabled === true,
        allowedDeviceActions: TOGGLEABLE_ACTIONS.filter(action => deviceActionConfig.actions[action] === true),
        watchAmbientLight: watchesAmbientLight,
        rules: nativeRules,
      }));
    } catch {
      // 原生桥暂不可用时保留网页规则，不让设置页崩溃。
    }
  }, [settings.enabled, rules, deviceActionConfigRevision]);

  const [nativeLog, setNativeLog] = useState<Array<{ eventId?: string; type?: string; payload?: string; rule?: string; result?: string; at?: number }>>([]);
  const [nativeLogAvailable, setNativeLogAvailable] = useState(false);
  const refreshNativeLog = useCallback(() => {
    if (typeof window === "undefined" || !isShellEnvironment()) {
      setNativeLogAvailable(false);
      setNativeLog([]);
      return;
    }
    const shell = (window as Window & { AndroidShell?: { getNativeRealityBridgeLog?: () => string } }).AndroidShell;
    if (!shell?.getNativeRealityBridgeLog) {
      setNativeLogAvailable(false);
      setNativeLog([]);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(shell.getNativeRealityBridgeLog());
      setNativeLog(Array.isArray(parsed) ? parsed.filter(item => item && typeof item === "object") as Array<{ eventId?: string; type?: string; payload?: string; rule?: string; result?: string; at?: number }> : []);
      setNativeLogAvailable(true);
    } catch {
      setNativeLogAvailable(false);
      setNativeLog([]);
    }
  }, []);

  const [feed, setFeed] = useState(() => loadBridgeFeed());
  const [editing, setEditing] = useState<BridgeRule | null>(null);
  const [offlineReplyGenerating, setOfflineReplyGenerating] = useState(false);

  const [dataItems, setDataItems] = useState<BridgeDataItem[]>(() => loadBridgeDataItems());
  const [editingItem, setEditingItem] = useState<BridgeDataItem | null>(null);
  const [shortcutActions, setShortcutActions] = useState<BridgeShortcutAction[]>(() => loadBridgeShortcutActions());
  const [editingShortcut, setEditingShortcut] = useState<BridgeShortcutAction | null>(null);
  const [recentCommands, setRecentCommands] = useState<ShortcutCommand[]>([]);
  const [testingShortcut, setTestingShortcut] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  /* 规则试跑：示例数据 + 结果。以前第 6 步只有一句「保存后自己回 iPhone 试」，
     用户配完心里没底。见 runRuleTest。 */
  const [ruleTest, setRuleTest] = useState<{ type: string; payload: string }>({ type: "", payload: "" });
  const [ruleTestBusy, setRuleTestBusy] = useState(false);
  const [ruleTestResult, setRuleTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState("");

  // 换一个动作/重新打开向导时清掉上次的测试结果
  useEffect(() => { setTestResult(null); }, [editingShortcut?.id]);
  const [shortcutEmailStatus, setShortcutEmailStatus] = useState<ShortcutEmailStatus | null>(null);
  const [shortcutEmailInput, setShortcutEmailInput] = useState("");
  const [shortcutEmailCode, setShortcutEmailCode] = useState("");
  const [shortcutEmailBusy, setShortcutEmailBusy] = useState<"send" | "verify" | "remove" | null>(null);
  const [copiedText, setCopiedText] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [bridgeToken, setBridgeToken] = useState("");
  const [closing, setClosing] = useState(false);
  const [spinTurns, setSpinTurns] = useState(0);
  /**
   * 这台设备上现实桥该走哪一套。只算一次——UA 在一次会话里不会变。
   * 它决定：默认落在哪个分区、导航里出现哪一组、以及哪一屏该提醒不适用。
   *
   * ⚠️ 这个定义必须与下面所有 `platform.xxx` 的引用同时存在：
   *   漏掉这里会让引用处直接 ReferenceError，整页白屏。
   */
  const platform = useMemo(() => describeBridgePlatform(), []);
  /**
   * 规则编辑器在安卓上用「一页到底的长表单」，在 iOS 上仍走分步向导。
   *
   * 为什么分两套：向导是按 iOS 那条线设计的——先接通云端、再建上传数据的
   * 快捷指令、然后等信号进来。而安卓有本机桥，感知与定时自己就产生信号，
   * 前两步对纯安卓用户是纯粹的弯路（实测反馈：不要一步步的卡片引导，
   * 想把能改的一次摆在眼前）。
   *
   * 注意安卓同样能收云端传来的快捷指令数据，所以云端相关内容只是收进折叠区，
   * 没有删掉。
   */
  /**
   * 规则编辑器用「一页到底的长表单」还是「分步向导」。
   *
   * 只有 iPhone / iPad 走向导——那套流程（接通云端 → 建上传数据的快捷指令 →
   * 等信号进来）本来就是为 iOS 设计的。其余情况一律平铺页。
   *
   * ⚠️ 判断条件改过一次，这里记一下原因：最早写的是
   *   `platform.androidBridge === "ready"`
   * 而这个值**只在「安卓壳 WebView 内」才成立**（见 shell-detect 的
   * isShellEnvironment：UA 里得有 FloatShell/）。于是从本机桥点进「去创建联动」时，
   * 只要不是壳内打开（安卓浏览器、加到桌面的 PWA），仍然掉回六步向导——
   * 用户看到的现象就是「明明说是安卓页，怎么还是那张 iOS 卡片」。
   * 现在按「是不是 iOS」分：不是 iPhone/iPad 就给平铺页。
   *
   * 安卓即使没装壳，平铺页也读得懂：能力清单、以及「按时间自动」的定时规则
   * 本来就不依赖壳；反过来硬塞一套 iOS 教程给他们才是真的没用。
   */
  const flatRuleEditor = platform.home !== "ios";
  /** 当前展示的是「你那套」还是「另一套」的入口。默认当然是你的那套。 */
  const [showOtherPlatform, setShowOtherPlatform] = useState(false);
  const [mainSec, setMainSec] = useState<"overview" | "android" | "rules" | "shortcuts" | "queries" | "screen">("overview");
  // 安卓桥分区的只读快照。这里刻意不订阅变化事件：这页只是总览，
  // 用户改完设置回来时组件会重新挂载，读到的自然是最新值。
  const perceptionDiag = useMemo(() => readPerceptionDiagnostics(), []);
  const deviceActionCfg = useMemo(() => loadDeviceActionConfig(), []);
  const deviceActionBridgeOk = useMemo(() => hasDeviceActionBridge(), []);
  const deviceActionEnabled = deviceActionCfg.enabled;
  const deviceActionOnCount = TOGGLEABLE_ACTIONS.filter(id => deviceActionCfg.actions[id] === true).length;
  const [screenChat, setScreenChat] = useState<ScreenChatSettings>(() => loadScreenChatSettings());
  const [editingScreenChat, setEditingScreenChat] = useState<ScreenChatSettings | null>(null);
  const [histSec, setHistSec] = useState<"feed" | "commands" | "native">("feed");
  useEffect(() => {
    if (tab === "history" && histSec === "native") refreshNativeLog();
  }, [tab, histSec, refreshNativeLog]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [wizStep, setWizStep] = useState(1);
  const [wizMax, setWizMax] = useState(1);
  const [swizStep, setSwizStep] = useState(1);
  const [swizMax, setSwizMax] = useState(1);
  const [paramRows, setParamRows] = useState<ShortcutParamRow[]>([]);
  const [paramAdvanced, setParamAdvanced] = useState(false);
  const [dwizStep, setDwizStep] = useState(1);
  const [dwizMax, setDwizMax] = useState(1);
  const [screenWizStep, setScreenWizStep] = useState(1);
  const [screenWizMax, setScreenWizMax] = useState(1);
  const [dataSnapshot, setDataSnapshot] = useState<{ text: string; updatedAt?: string } | "none" | null>(null);
  const [dataSnapshotBusy, setDataSnapshotBusy] = useState(false);
  const characters = useMemo(() => loadCharacters().map(c => ({ id: c.id, name: c.name })), []);
  /* 「调用一个工具」可选的清单：内置能力 / REST / 组合 / MCP / 自定义 APP 一把抓。 */
  const availableTools = useMemo(() => getEnabledTools("chat"), []);
  const charName = useCallback((id?: string) => characters.find(c => c.id === id)?.name ?? "角色", [characters]);
  const { config, ready } = bridgeConnection();

  useEffect(() => {
    const refresh = () => setFeed(loadBridgeFeed());
    window.addEventListener(REALITY_BRIDGE_FEED_UPDATED_EVENT, refresh);
    return () => window.removeEventListener(REALITY_BRIDGE_FEED_UPDATED_EVENT, refresh);
  }, []);


  useEffect(() => {
    if (tab !== "history" && mainSec !== "overview") return;
    let cancelled = false;
    void loadRecentShortcutCommands(8)
      .then(commands => { if (!cancelled) setRecentCommands(commands); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [tab]);

  const refreshShortcutEmailStatus = useCallback(async () => {
    const response = await fetch("/api/push/shortcut-email", { credentials: "include", cache: "no-store" });
    const data = await response.json().catch(() => ({})) as ShortcutEmailStatus & { ok?: boolean; error?: string };
    if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱状态读取失败。");
    setShortcutEmailStatus(data);
    setShortcutEmailInput(data.recipient || "");
    // 离线目录要同步知道邮件通道能不能用（提示词组装是同步的，取不了接口）
    saveShortcutEmailReady(data.providerConfigured === true && data.verified === true);
  }, []);

  /* 快捷动作向导选了邮件模式时，拉取邮箱验证状态 */
  const editingShortcutDelivery = editingShortcut?.deliveryMode;
  useEffect(() => {
    if (editingShortcutDelivery === "email") void refreshShortcutEmailStatus().catch(() => undefined);
  }, [editingShortcutDelivery, refreshShortcutEmailStatus]);

  /* 已经登记过邮件送达的动作：进页面就刷一次状态，把离线目录的就绪缓存校准。
     只在"有邮件动作"时打这个接口，没用邮件的用户不会平白多一次请求。 */
  const hasEnabledEmailAction = shortcutActions.some(item => item.enabled && item.deliveryMode === "email");
  useEffect(() => {
    if (!hasEnabledEmailAction) {
      saveShortcutEmailReady(false);
      return;
    }
    void refreshShortcutEmailStatus().catch(() => undefined);
  }, [hasEnabledEmailAction, refreshShortcutEmailStatus]);

  const sendShortcutEmailCode = useCallback(async () => {
    const recipient = shortcutEmailInput.trim().toLowerCase();
    if (!isValidShortcutEmailAddress(recipient)) {
      onNotice?.("请输入有效的邮箱地址");
      return;
    }
    setShortcutEmailBusy("send");
    try {
      const response = await fetch("/api/push/shortcut-email", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipient }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string; verificationExpiresAt?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "验证码发送失败。");
      setShortcutEmailStatus(previous => ({
        providerConfigured: previous?.providerConfigured ?? true,
        senderAddress: previous?.senderAddress || "",
        recipient,
        verified: false,
        verificationExpiresAt: data.verificationExpiresAt,
      }));
      onNotice?.("验证码已发送");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [shortcutEmailInput, onNotice]);

  const verifyShortcutEmailCode = useCallback(async () => {
    if (!/^\d{6}$/.test(shortcutEmailCode.trim())) {
      onNotice?.("请输入六位验证码");
      return;
    }
    setShortcutEmailBusy("verify");
    try {
      const response = await fetch("/api/push/shortcut-email", {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: shortcutEmailCode.trim() }),
      });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱验证失败。");
      setShortcutEmailCode("");
      await refreshShortcutEmailStatus();
      onNotice?.("接收邮箱已验证");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [shortcutEmailCode, refreshShortcutEmailStatus, onNotice]);

  const removeShortcutEmail = useCallback(async () => {
    setShortcutEmailBusy("remove");
    try {
      const response = await fetch("/api/push/shortcut-email", { method: "DELETE", credentials: "include" });
      const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || data.ok === false) throw new Error(data.error || "邮箱解绑失败。");
      setShortcutEmailStatus(previous => previous ? { ...previous, recipient: "", verified: false } : null);
      setShortcutEmailInput("");
      setShortcutEmailCode("");
      onNotice?.("接收邮箱已解绑");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setShortcutEmailBusy(null);
    }
  }, [onNotice]);

  const updateSettings = useCallback((patch: Partial<ReturnType<typeof loadBridgeSettings>>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveBridgeSettings(next);
      return next;
    });
  }, []);

  const updateScreenChat = useCallback((patch: Partial<ScreenChatSettings>) => {
    setScreenChat(prev => {
      const next = { ...prev, ...patch };
      saveScreenChatSettings(next);
      return next;
    });
  }, []);

  const persistRules = useCallback((next: BridgeRule[]) => {
    setRules(next);
    saveBridgeRules(next);
  }, []);

  const syncNow = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      const count = await pollRealityBridgeNow();
      setFeed(loadBridgeFeed());
      onNotice?.(count > 0 ? `收到 ${count} 条新消息` : "暂时没有新消息");
    } finally {
      setSyncing(false);
    }
  }, [syncing, onNotice]);

  const generateOfflineReplies = useCallback(async () => {
    const characterId = editing?.actions.chat?.characterId;
    if (!editing || !characterId) {
      onNotice?.("先在「要做什么」里选择一个角色，再生成离线回复。");
      return;
    }
    const character = characters.find(item => item.id === characterId);
    const session = loadChatSessions().find(item => item.contactId === characterId && !item.isGroup);
    if (!character || !session) {
      onNotice?.("找不到这个角色的聊天会话，请先打开一次该角色的聊天室。");
      return;
    }
    setOfflineReplyGenerating(true);
    try {
      const history = loadChatMessages(session.id, 30);
      const instruction = [
        `规则名称：${editing.name || "现实桥联动"}`,
        `触发信号：${editing.matchType || "任意信号"}`,
        `事件正文：{payload}（这是运行时会替换的占位符）`,
        "请据此生成离线回复库。",
      ].join("\n");
      const syntheticMessage = {
        id: `offline-library-${Date.now()}`,
        sessionId: session.id,
        role: "user" as const,
        content: instruction,
        status: "sent" as const,
        createdAt: new Date().toISOString(),
      };
      const built = await buildChatPromptMessages(session, [...history, syntheticMessage], {
        appId: "reality_bridge",
        appTags: ["reality_bridge", "offline_library"],
      });
      const generated = await sendLLMRequest(
        built.config,
        built.preset,
        built.llmMessages,
        built.regexes,
        { characterName: character.name },
        { appId: "reality_bridge", appTags: ["reality_bridge", "offline_library"], skipOutputRegex: true },
      );
      const lines = generated.split(/\r?\n/)
        .map(line => line.replace(/^\s*(?:[-*•]|\d+[.)、])\s*/, "").trim())
        .filter(line => line.length > 0 && line.length <= 220)
        .slice(0, 30);
      if (!lines.length) throw new Error("模型没有返回可用的逐行回复，请重试。");
      setEditing(previous => previous ? { ...previous, offlineReplies: lines } : previous);
      onNotice?.(`已按 ${character.name} 的角色上下文生成 ${lines.length} 条离线回复，可继续手动修改后保存。`);
    } catch (error) {
      onNotice?.(error instanceof Error ? `生成失败：${error.message}` : "生成离线回复失败，请检查模型配置和网络。");
    } finally {
      setOfflineReplyGenerating(false);
    }
  }, [editing, characters, onNotice]);

  const saveEditing = useCallback(() => {
    if (!editing) return;
    if (!editing.schedule && !editing.matchType.trim()) {
      onNotice?.("请填写要接收的信号名");
      return;
    }
    const schedule = editing.schedule;
    const fallbackName = schedule
      ? schedule.kind === "interval"
        ? `每隔 ${schedule.minutes ?? 60} 分钟`
        : `${schedule.kind === "weekly" ? ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][schedule.weekday ?? 1] : "每天"} ${schedule.time ?? "08:00"}`
      : `当收到「${editing.matchType.trim()}」`;
    const name = editing.name.trim() || fallbackName;
    // 过滤词留空时写 undefined 而不是空串：旧规则本来就没有这个键，
    // 保持「没有就是不限」的同一种存盘形状，导出/对比时也干净。
    const payloadFilter = (editing.payloadFilter ?? "").trim().slice(0, 60);
    const cleaned: BridgeRule = {
      ...editing,
      name: name.slice(0, 30),
      matchType: editing.matchType.trim().slice(0, 60),
      payloadFilter: payloadFilter || undefined,
    };
    const exists = rules.some(rule => rule.id === cleaned.id);
    persistRules(exists ? rules.map(rule => rule.id === cleaned.id ? cleaned : rule) : [cleaned, ...rules]);
    setEditing(null);
    onNotice?.("联动已保存");
  }, [editing, rules, persistRules, onNotice]);

  const summarize = useCallback((rule: BridgeRule): string => {
    const parts: string[] = [];
    const schedule = rule.schedule;
    // 过滤条件放在最前：它决定「这条规则到底会不会被触发」，
    // 比后面执行了什么更该一眼看到，否则用户会以为规则坏了。
    if (!schedule && rule.payloadFilter?.trim()) parts.push(`只看含「${rule.payloadFilter.trim()}」的信号`);
    if (schedule) {
      if (schedule.kind === "interval") parts.push(`每隔 ${schedule.minutes ?? 60} 分钟`);
      else if (schedule.kind === "weekly") parts.push(`每周${["日", "一", "二", "三", "四", "五", "六"][schedule.weekday ?? 1]} ${schedule.time ?? "08:00"}`);
      else parts.push(`每天 ${schedule.time ?? "08:00"}`);
    }
    const a = rule.actions;
    if (a.chat) {
      const who = charName(a.chat.characterId);
      const effectiveRole = a.chat.historyRole || a.chat.role;
      const base = a.chat.role === "assistant" ? `以${who}的口吻记下`
        : a.chat.role === "system" ? `旁白记给${who}`
        : `告诉${who}`;
      parts.push(base + (a.chat.requestReply && effectiveRole !== "assistant" ? "并等TA回话" : ""));
    }
    if (a.memory) parts.push(`让${charName(a.memory.characterId)}记住`);
    if (a.timeline) parts.push("记入短期记忆");
    if (a.card) parts.push("做成卡片发过去");
    if (a.notify) parts.push("弹通知提醒我");
    if (a.calendar) parts.push("记到日历");
    if (a.shortcut) {
      const shortcutName = shortcutActions.find(item => item.id === a.shortcut?.actionId)?.name;
      parts.push(shortcutName ? `执行「${shortcutName}」` : "执行快捷动作");
    }
    if (a.deviceAction) {
      const label = DEVICE_ACTION_LABEL[a.deviceAction.action as keyof typeof DEVICE_ACTION_LABEL];
      parts.push(label ? `直接操作手机（${label}）` : "直接操作手机");
    }
    if (a.outbox) parts.push("回传到 iPhone");
    if (a.broadcast) parts.push("转发给其他 APP");
    const summary = parts.length ? parts.join("、") : (schedule ? "什么都不做" : "只是收下来看看");
    const delay = Number(rule.delayMinutes) || 0;
    const withDelay = delay > 0 ? `延后 ${delay} 分钟` : "";
    const cooldown = Number(rule.cooldownMinutes) || 0;
    if (cooldown <= 0) return withDelay ? `${summary}（${withDelay}执行）` : summary;
    const label = cooldown % 60 === 0 ? `${cooldown / 60} 小时` : `${cooldown} 分钟`;
    return withDelay
      ? `${summary}（${withDelay}执行，${label}内只触发一次）`
      : `${summary}（${label}内只触发一次）`;
  }, [charName, shortcutActions]);

  const uploadUrl = `${config.url || "https://你的项目.supabase.co"}/storage/v1/object/${CLOUD_BACKUP_BUCKET}/bridge-inbox/[文件名].json`;
  const siteOrigin = typeof window !== "undefined" ? window.location.origin : "https://你的小手机域名";
  // 个人云激活时唤醒入口在用户自己的网关（离线扫描由用户库的 cron 驱动）；否则走站点
  const personalPushActive = isPersonalPushCloudActive();
  const personalScreenChatReady = isPersonalScreenChatCloudReady();
  const wakeUrl = bridgeToken
    ? personalPushActive
      ? `${normalizeBackupUrl(config.url)}/functions/v1/ai-phone-push?action=bridge-wake&token=${bridgeToken}`
      : `${siteOrigin}/api/push/bridge-wake?token=${bridgeToken}`
    : "";

  // 屏幕速聊同步入口（部署在用户个人云上的 screen-chat 函数）
  const screenChatUrl = `${normalizeBackupUrl(config.url) || "https://你的项目.supabase.co"}/functions/v1/screen-chat`;

  // 屏幕速聊令牌只从个人云读取，绝不回退到站点主项目。
  const wantWakeToken = editing !== null || mainSec === "screen";
  useEffect(() => {
    if (!wantWakeToken || bridgeToken) return;
    if (mainSec === "screen" && !personalScreenChatReady) return;
    let cancelled = false;
    const request = personalPushActive
      ? personalPushFetch("bridge-config")
      : fetch("/api/push/bridge-config", { credentials: "include" });
    void request
      .then(response => response.ok ? response.json() : null)
      .then((data: { ok?: boolean; bridgeToken?: string } | null) => {
        if (!cancelled && data?.ok && data.bridgeToken) setBridgeToken(data.bridgeToken);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [wantWakeToken, bridgeToken, personalPushActive, personalScreenChatReady, mainSec]);
  const stateUrl = useCallback((key: string) =>
    `${config.url || "https://你的项目.supabase.co"}/storage/v1/object/${CLOUD_BACKUP_BUCKET}/bridge-state/${key || "[标识]"}.json`, [config.url]);

  const persistDataItems = useCallback((next: BridgeDataItem[]) => {
    setDataItems(next);
    saveBridgeDataItems(next);
  }, []);

  const persistShortcutActions = useCallback((next: BridgeShortcutAction[]) => {
    setShortcutActions(next);
    saveBridgeShortcutActions(next);
  }, []);

  const saveEditingItem = useCallback(() => {
    if (!editingItem) return;
    const name = editingItem.name.trim().slice(0, 20);
    const key = sanitizeBridgeDataKey(editingItem.key);
    if (!name || !key) {
      onNotice?.("名称和标识都需要填写");
      return;
    }
    if (RESERVED_INTERNAL_TOOL_NAMES.includes(name)) {
      onNotice?.(`「${name}」是内置工具的名字，请换一个`);
      return;
    }
    if (dataItems.some(item => item.id !== editingItem.id && (item.name === name || item.key === key))) {
      onNotice?.("名称或标识与已有数据项重复");
      return;
    }
    const cleaned: BridgeDataItem = { ...editingItem, name, key, description: editingItem.description.trim().slice(0, 200) };
    const exists = dataItems.some(item => item.id === cleaned.id);
    persistDataItems(exists ? dataItems.map(item => item.id === cleaned.id ? cleaned : item) : [...dataItems, cleaned]);
    setEditingItem(null);
    onNotice?.("数据项已保存");
  }, [editingItem, dataItems, persistDataItems, onNotice]);

  const saveEditingShortcut = useCallback(() => {
    if (!editingShortcut) return;
    const name = editingShortcut.name.trim().slice(0, 30);
    const shortcutName = editingShortcut.shortcutName.trim().slice(0, 80);
    const description = editingShortcut.description.trim().slice(0, 300);
    const parameterSchema = editingShortcut.parameterSchema.trim() || "{}";
    if (!name || !shortcutName || !description) {
      onNotice?.("工具名称、快捷指令名称和用途说明都需要填写");
      return;
    }
    if (!parseBridgeActionParameterSchema(parameterSchema)) {
      onNotice?.("参数定义不是有效的 JSON 对象");
      return;
    }
    if (parameterSchema.length > 8000) {
      onNotice?.("参数定义过长");
      return;
    }
    // 保留名同时包含内置工具（否则与「查看TA的手机」等撞名后，
    // 内置工具会被影子覆盖）与本页已有数据项。
    const reservedNames = new Set([...RESERVED_INTERNAL_TOOL_NAMES, ...dataItems.map(item => item.name)]);
    if (reservedNames.has(name)) {
      onNotice?.(`「${name}」是内置工具的名字，请换一个`);
      return;
    }
    if (shortcutActions.some(item => item.id !== editingShortcut.id && item.name === name)) {
      onNotice?.("工具名称与已有快捷动作重复");
      return;
    }
    const cleaned: BridgeShortcutAction = {
      ...editingShortcut,
      name,
      shortcutName,
      description,
      parameterSchema,
      expiresInSeconds: Math.max(30, Math.min(900, Number(editingShortcut.expiresInSeconds) || 120)),
    };
    const exists = shortcutActions.some(item => item.id === cleaned.id);
    persistShortcutActions(exists
      ? shortcutActions.map(item => item.id === cleaned.id ? cleaned : item)
      : [...shortcutActions, cleaned]);
    setEditingShortcut(null);
    onNotice?.("快捷动作已加入现实桥工具箱");
  }, [editingShortcut, shortcutActions, dataItems, persistShortcutActions, onNotice]);

  const testEditingShortcut = useCallback(async () => {
    if (!editingShortcut || testingShortcut) return;
    setTestingShortcut(true);
    try {
      // "已发送"只代表推送服务接收，旧设备的僵尸订阅也会计入——先把本设备
      // 的订阅强制刷新一遍，保证测试通知一定包含当前手机。
      if (editingShortcut.deliveryMode !== "email" && !isShellEnvironment()) {
        const enabled = await enableOfflinePush();
        if (!enabled.ok) {
          setTestResult({ ok: false, text: `本设备推送订阅未就绪：${enabled.error || "未知原因"}` });
          return;
        }
      }
      const schema = parseBridgeActionParameterSchema(editingShortcut.parameterSchema) || {};
      const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
        ? schema.properties as Record<string, { type?: unknown }>
        : {};
      const args: Record<string, unknown> = {};
      for (const [key, definition] of Object.entries(properties)) {
        args[key] = definition?.type === "number" || definition?.type === "integer"
          ? (key === "waitSeconds" ? 2 : 1)
          : definition?.type === "boolean" ? true : "来自小手机的测试";
      }
      const created = await createShortcutCommand(editingShortcut, args);
      if (created.delivered) {
        setTestResult({
          ok: true,
          text: editingShortcut.deliveryMode === "email"
            ? "测试邮件已发送"
            : created.line === "personal"
              ? "已发送，点弹出的通知即可运行"
              : isPersonalPushCloudActive()
                ? "已发送（站点旧通道）。请到「云服务部署」重新部署离线推送后再测"
                : "已发送。前台不弹通知，锁屏或退后台等通知即可",
        });
      } else {
        const detail = created.push?.error || created.email?.error || "";
        setTestResult({ ok: false, text: `测试命令未能送达${detail ? `：${detail}` : "，请确认本设备已开启离线推送"}` });
      }
    } catch (err) {
      setTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setTestingShortcut(false);
    }
  }, [editingShortcut, testingShortcut]);

  /* 刷新键丝滑旋转：每次同步期间按 850ms 一圈递增角度，CSS 过渡负责缓动 */
  useEffect(() => {
    if (!syncing) return;
    setSpinTurns(t => t + 1);
    const id = window.setInterval(() => setSpinTurns(t => t + 1), 850);
    return () => window.clearInterval(id);
  }, [syncing]);

  /* 返回：按钮先渐隐再真正关闭 */
  const handleClose = useCallback(() => {
    setClosing(true);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  /* 联动向导：打开时重置步骤；编辑已有联动可自由跳步 */
  const openRuleEditor = useCallback((rule: BridgeRule, existing: boolean) => {
    setEditing(rule);
    setWizStep(1);
    setWizMax(existing ? 6 : 1);
    // 换一条规则就清掉上次的试跑结果，免得把上一条的效果错认成这一条的
    // 保留示例数据、只清结果：同一份示例常在几条规则之间反复试，
    // 每次清空要重敲一遍（实测反馈）。示例存本机，下次打开也还在。
    setRuleTestResult(null);
  }, []);

  /** 从场景模板开一条已经填好的规则：用户只需微调，不必懂信号名与动作的组合。 */
  const openSceneTemplate = useCallback((template: RuleSceneTemplate) => {
    // 动作需要角色时，用第一个角色兜底；没有角色卡的话模板仍然可开，
    // 只是「告诉一个角色」那项会指向空 id，由保存时的既有校验拦下并提示。
    const rule = template.build({ characterId: characters[0]?.id ?? "" });
    setEditing(rule);
    setWizStep(1);
    setWizMax(6);
    // 保留示例数据、只清结果：同一份示例常在几条规则之间反复试，
    // 每次清空要重敲一遍（实测反馈）。示例存本机，下次打开也还在。
    setRuleTestResult(null);
  }, [characters]);


  /** 一键补齐当前已实现的本机感知规则。新装规则默认关闭，避免首次进入就突然刷消息。 */
  const installPerceptionRules = useCallback(() => {
    const characterId = characters[0]?.id ?? "";
    if (!characterId) {
      onNotice?.("请先创建至少一个角色，再安装感知规则");
      return;
    }
    const templates = RULE_SCENE_TEMPLATES.filter(template => template.tag === "本机信号");
    const existingNames = new Set(rules.map(rule => rule.name));
    const additions = templates
      .filter(template => !existingNames.has(template.build({ characterId }).name))
      .map(template => ({ ...template.build({ characterId }), enabled: false }));
    if (additions.length === 0) {
      onNotice?.("本机感知规则已经齐全，没有重复添加");
      return;
    }
    persistRules([...rules, ...additions].slice(0, 100));
    onNotice?.(`已添加 ${additions.length} 条感知规则，默认关闭；请逐条检查角色、关键词、阈值和权限后再开启`);
  }, [characters, rules, persistRules, onNotice]);

  /**
   * 试跑当前编辑中的规则：真的执行一遍「加工 → 动作」。
   *
   * 与快捷动作的「发送测试通知」同一个用意——让用户在保存前就看到会发生什么，
   * 而不是保存完回 iPhone 那边碰运气。动作是真的会执行的（该写聊天就写、
   * 该弹通知就弹），这一点在界面上必须先说清楚，不能让人以为只是预演。
   */
  const runRuleTest = useCallback(async () => {
    if (!editing || ruleTestBusy) return;
    setRuleTestBusy(true);
    try {
      const result = await testRunRule(editing, {
        type: ruleTest.type.trim() || editing.matchType.trim() || editing.name.trim() || "试跑数据",
        payload: ruleTest.payload.trim() || "这是一条试跑数据",
      });
      if (result.error) {
        setRuleTestResult({ ok: false, text: `试跑时出错：${result.error}` });
        return;
      }
      // 信号名/过滤词没对上：**这是试跑最该报出来的结论**。
      // 老实现无条件往下跑，于是「信号名填错」这种最常见的配置错误在试跑里
      // 完全看不出来——用户以为配好了，真信号来了却一条都不触发。
      if (!result.matched) {
        setRuleTestResult({ ok: false, text: result.notes.join("\n") });
        return;
      }
      const lines: string[] = ["✓ 匹配通过（真收到这样的信号，这条规则会触发）"];
      lines.push(...result.notes);
      // 把加工结果也回显出来：用户最关心的就是「AI 先处理」那一步到底处理成了什么
      if (result.processed && result.processed !== ruleTest.payload.trim()) {
        lines.push(`加工后：${result.processed}`);
      }
      const acted = result.actions.length > 0
        ? result.actions.join("、")
        : "这条规则没有配置任何动作，收到信号也只会存档";
      lines.push(`实际执行：${acted}`);
      setRuleTestResult({ ok: true, text: lines.join("\n") });
    } catch (err) {
      setRuleTestResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRuleTestBusy(false);
    }
  }, [editing, ruleTest, ruleTestBusy]);

  const runPreview = useCallback(async () => {
    if (!editing || previewBusy) return;
    setPreviewBusy(true);
    setPreviewResult("");
    try {
      const text = await previewBridgeRuleText(editing, {
        id: "preview-" + Date.now().toString(36),
        type: ruleTest.type.trim() || editing.matchType.trim() || editing.name.trim() || "试跑数据",
        payload: ruleTest.payload.trim() || "抖音 今天已累计使用 90 分钟",
        createdAt: new Date().toISOString(),
      });
      setPreviewResult(text);
    } catch (error) {
      setPreviewResult("预览失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      setPreviewBusy(false);
    }
  }, [editing, ruleTest, previewBusy]);

  const wizNext = useCallback(() => {
    if (!editing) return;
    // 定时规则不看信号名，只校验时间/间隔是否填了
    if (wizStep === 3 && !editing.schedule && !editing.matchType.trim()) {
      onNotice?.("请先填写或点选一个信号名");
      return;
    }
    if (wizStep === 3 && editing.schedule) {
      if (editing.schedule.kind === "interval" && !(Number(editing.schedule.minutes) > 0)) {
        onNotice?.("请填写间隔分钟数");
        return;
      }
      if (editing.schedule.kind !== "interval" && !/^\d{1,2}:\d{2}$/.test(editing.schedule.time ?? "")) {
        onNotice?.("请填写触发时间");
        return;
      }
    }
    if (wizStep >= 6) {
      saveEditing();
      return;
    }
    const next = wizStep + 1;
    setWizStep(next);
    setWizMax(m => Math.max(m, next));
  }, [editing, wizStep, saveEditing, onNotice]);

  /* 快捷动作向导：打开时重置步骤；编辑已有动作可自由跳步 */
  const openShortcutEditor = useCallback((action: BridgeShortcutAction, existing: boolean) => {
    setEditingShortcut(action);
    setSwizStep(1);
    setSwizMax(existing ? 6 : 1);
    const rows = parseShortcutParamRows(action.parameterSchema);
    setParamRows(rows ?? []);
    setParamAdvanced(rows === null);
  }, []);

  const swizNext = useCallback(() => {
    if (!editingShortcut) return;
    if (swizStep === 2 && !editingShortcut.name.trim()) {
      onNotice?.("请先给这个动作起个名字");
      return;
    }
    if (swizStep === 5 && !editingShortcut.shortcutName.trim()) {
      onNotice?.("请填写快捷指令名称");
      return;
    }
    if (swizStep >= 6) {
      saveEditingShortcut();
      return;
    }
    const next = swizStep + 1;
    setSwizStep(next);
    setSwizMax(m => Math.max(m, next));
  }, [editingShortcut, swizStep, saveEditingShortcut, onNotice]);

  /* 数据项向导：打开时重置步骤与快照预览 */
  const openDataItemEditor = useCallback((item: BridgeDataItem, existing: boolean) => {
    setEditingItem(item);
    setDwizStep(1);
    setDwizMax(existing ? 4 : 1);
    setDataSnapshot(null);
  }, []);

  const dwizNext = useCallback(() => {
    if (!editingItem) return;
    if (dwizStep === 2 && (!editingItem.name.trim() || !sanitizeBridgeDataKey(editingItem.key))) {
      onNotice?.("请先填写名称和标识");
      return;
    }
    if (dwizStep >= 4) {
      saveEditingItem();
      return;
    }
    const next = dwizStep + 1;
    setDwizStep(next);
    setDwizMax(m => Math.max(m, next));
  }, [editingItem, dwizStep, saveEditingItem, onNotice]);

  /* 屏幕速聊向导：单例配置也沿用其他能力的「卡片 → 分步编辑」交互。 */
  const openScreenChatEditor = useCallback((existing: boolean) => {
    setEditingScreenChat({
      enabled: existing ? screenChat.enabled : true,
      characterId: screenChat.characterId || characters[0]?.id || "",
    });
    setScreenWizStep(1);
    setScreenWizMax(existing ? 4 : 1);
  }, [screenChat, characters]);

  const screenWizNext = useCallback(() => {
    if (!editingScreenChat) return;
    if (screenWizStep === 1 && !personalScreenChatReady) {
      onNotice?.(personalPushActive ? "请先重新部署最新版个人云" : "请先部署个人云");
      return;
    }
    if (screenWizStep === 2 && !editingScreenChat.characterId) {
      onNotice?.("请先选择一个角色");
      return;
    }
    if (screenWizStep >= 4) {
      setScreenChat(editingScreenChat);
      saveScreenChatSettings(editingScreenChat);
      setEditingScreenChat(null);
      onNotice?.("屏幕速聊已保存");
      return;
    }
    const next = screenWizStep + 1;
    setScreenWizStep(next);
    setScreenWizMax(max => Math.max(max, next));
  }, [editingScreenChat, screenWizStep, personalScreenChatReady, personalPushActive, onNotice]);

  /* 读取云端最新快照，验证上传链路是否打通 */
  const checkDataSnapshot = useCallback(async () => {
    if (!editingItem || dataSnapshotBusy) return;
    const key = sanitizeBridgeDataKey(editingItem.key);
    if (!key) {
      onNotice?.("请先在第②步填写标识");
      return;
    }
    setDataSnapshotBusy(true);
    try {
      const snapshot = await readBridgeStateSnapshot(config, key);
      setDataSnapshot(snapshot ?? "none");
    } catch (err) {
      onNotice?.(err instanceof Error ? err.message : String(err));
    } finally {
      setDataSnapshotBusy(false);
    }
  }, [editingItem, dataSnapshotBusy, config, onNotice]);

  /* 概览页统计：把 feed / rules / shortcutActions 揉成一组可读结论。
     不引图表库——这里要的是「一眼看出有没有在动」，几个数字就够。 */
  const stats = useMemo(() => {
    const today = feed.filter(entry => isToday(entry.receivedAt));
    const days: { label: string; count: number }[] = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const count = feed.filter(entry => {
        const t = new Date(entry.receivedAt);
        return `${t.getFullYear()}-${t.getMonth()}-${t.getDate()}` === key;
      }).length;
      days.push({ label: `${d.getDate()}`, count });
    }
    const byType = new Map<string, number>();
    for (const entry of feed) {
      const t = (entry.type || "未知").trim() || "未知";
      byType.set(t, (byType.get(t) ?? 0) + 1);
    }
    const topTypes = Array.from(byType.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const failed = feed.filter(entry => Boolean(entry.error));
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const last24h = feed.filter(entry => {
      const t = Date.parse(entry.receivedAt);
      return Number.isFinite(t) && t >= since;
    }).length;
    const peak = days.reduce((max, d) => Math.max(max, d.count), 0);
    const commands = recentCommands.length;
    const commandsFailed = recentCommands.filter(c => c.status === "failed" || c.status === "expired").length;
    return { today: today.length, total: feed.length, days, topTypes, failed, last24h, peak, commands, commandsFailed };
  }, [feed, recentCommands]);

  /* 收到过的信号名去重，供向导第②步点选 */
  const feedSignals = useMemo(() => {
    const seen: string[] = [];
    for (const entry of feed) {
      const t = (entry.type || "").trim();
      if (t && !seen.includes(t)) seen.push(t);
      if (seen.length >= 8) break;
    }
    return seen;
  }, [feed]);

  const copy = useCallback((text: string, label: string) => {
    const done = () => {
      setCopiedText(text);
      window.setTimeout(() => setCopiedText(current => current === text ? "" : current), 1600);
      onNotice?.(label + "已复制");
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => done());
    } else done();
  }, [onNotice]);

  /* 规则第⑤步「直接操作手机」的参数行：每个动作要的字段不一样，按类型渲染。
     值统一先当字符串收，数字在设备动作引擎里再转——那里本来就做宽松解析。 */
  const renderDeviceActionArgs = (
    action: string,
    args: Record<string, unknown>,
    update: (next: Record<string, unknown>) => void,
  ) => {
    const field = (key: string, label: string, placeholder: string, type: "text" | "number" = "text") => (
      <label key={key}>{label}
        <input type={type} value={String(args[key] ?? "")} placeholder={placeholder}
          onChange={event => update({ ...args, [key]: event.target.value })} />
      </label>
    );
    const pick = (key: string, label: string, options: { value: string; label: string }[]) => (
      <label key={key}>{label}
        <select value={String(args[key] ?? options[0].value)}
          onChange={event => update({ ...args, [key]: event.target.value })}>
          {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
    );
    switch (action) {
      case "torch":
      case "dnd":
        return pick("on", "状态", [{ value: "true", label: "打开" }, { value: "false", label: "关闭" }]);
      case "brightness":
        return field("level", "亮度百分比", "1-100", "number");
      case "volume":
        return (
          <>
            {pick("stream", "音量类型", [
              { value: "media", label: "媒体" },
              { value: "ring", label: "铃声" },
              { value: "alarm", label: "闹钟" },
              { value: "notification", label: "通知" },
            ])}
            {pick("mode", "操作", [
              { value: "up", label: "调大" },
              { value: "down", label: "调小" },
              { value: "set", label: "设为数值" },
              { value: "mute", label: "静音" },
            ])}
          </>
        );
      case "openApp":
        return field("app", "应用名或包名", "例如 微信，或填 {payload} 用收到的内容");
      case "alarm":
        return (
          <>
            {field("hour", "小时", "0-23", "number")}
            {field("minute", "分钟", "0-59", "number")}
          </>
        );
      case "timer":
        return field("minutes", "多少分钟后", "例如 20", "number");
      case "media":
        return pick("mode", "操作", [
          { value: "toggle", label: "播放 / 暂停" },
          { value: "play", label: "继续播放" },
          { value: "pause", label: "暂停" },
          { value: "next", label: "下一首" },
          { value: "prev", label: "上一首" },
        ]);
      case "openUrl":
        return field("url", "网址", "https://…");
      default:
        return null;
    }
  };

  const isExistingRule = editing !== null && rules.some(rule => rule.id === editing.id);

  /**
   * 「去设置 →」跳板。
   *
   * 凡是需要用户去设置里改某个开关的地方，都必须用这个**可点**的按钮，
   * 而不是在文案里写一句「设置 → 操作设备」就完事。
   *
   * 之前的教训：好几处提示写着「去「设置 → 操作设备」打开」，那行字却
   * 是死的——用户照着念了一遍、退出去一层层翻，翻不到就以为功能坏了。
   * 一句能点的话，省掉他找路径的全部成本。
   */
  const settingsJump = (label: string, page: SettingsDeepLinkPage) => (
    onOpenSettings ? (
      <button
        type="button"
        className="rb-link rb-jump"
        onClick={() => { setMenuOpen(false); onOpenSettings(page); }}
      >{label} →</button>
    ) : null
  );

  /* 联动向导第②步内联的快捷指令教程 */
  const shortcutSteps = (
    <>
      <div className="rb-substep">
        <i>1</i>
        <div className="rb-substep-body">
          <p><b>新建自动化</b>：打开系统「快捷指令」→「自动化」→ 新建，触发条件按需选择。</p>
          <div className="rb-kv"><span className="rb-eg">示例</span><span>收到包含“消费”的短信时</span></div>
        </div>
      </div>
      <div className="rb-substep">
        <i>2</i>
        <div className="rb-substep-body">
          <p><b>添加操作</b>：选择「获取 URL 内容」，URL 填写以下地址：</p>
          <div className="rb-code" onClick={() => copy(uploadUrl, "地址")}><code>{uploadUrl}</code><span className="rb-copy">复制</span></div>
          <p>粘贴后把地址里的 <b>[文件名]</b> 三个字删掉，在原位置插入「当前日期」变量，再轻点该变量把日期格式选「自定义」填 <button type="button" className="rb-copychip" onClick={() => copy("yyyyMMddHHmmss", "日期格式")}>yyyyMMddHHmmss</button>，变量后保留 .json——这样每条数据的文件名都不会重复。</p>
        </div>
      </div>
      <div className="rb-substep">
        <i>3</i>
        <div className="rb-substep-body">
          <p><b>配置请求</b>：展开地址下方的选项，方法选 <b>POST</b>，请求体选 <b>JSON</b>。</p>
          <p>「头部」新增一项：名称填 <button type="button" className="rb-copychip" onClick={() => copy("Authorization", "头部名称")}>Authorization</button>，值填下方密钥：</p>
          <div className="rb-code" onClick={() => copy(`Bearer ${config.key || ""}`, "密钥")}>
            <code>{config.key ? `Bearer ${config.key.slice(0, 12)}……${config.key.slice(-6)}` : "<请先完成第一步>"}</code>
            <span className="rb-copy">复制</span>
          </div>
          <p>再到「请求体」里新增两个「<b>文本</b>」类型字段：<b>type</b> 填信号名（例：duanxin）；<b>payload</b> 填要回传给小手机的正文（可插入「短信正文」等变量）。</p>
          <p className="rb-hint">{"payload 里可以写 {{user}}/{{char}} 宏，送达时会自动替换成对应名字。"}</p>
        </div>
      </div>
      <div className="rb-substep">
        <i>4</i>
        <div className="rb-substep-body">
          <p><b>完成</b>：关闭「运行前询问」并保存，然后<b>手动运行一次</b>发送测试数据。</p>
        </div>
      </div>
    </>
  );

  const isExistingShortcut = editingShortcut !== null && shortcutActions.some(item => item.id === editingShortcut.id);

  /* 快捷动作向导第⑤步：从参数 Schema 提取键名，生成个性化施工清单 */
  const shortcutParamKeys = (() => {
    if (!editingShortcut) return [] as string[];
    const schema = parseBridgeActionParameterSchema(editingShortcut.parameterSchema);
    const properties = schema?.properties;
    return properties && typeof properties === "object" && !Array.isArray(properties)
      ? Object.keys(properties as Record<string, unknown>)
      : [];
  })();

  /* 邮箱验证交互块：快捷动作向导第③步邮件 tab 使用 */
  const shortcutEmailVerifyBlock = shortcutEmailStatus && !shortcutEmailStatus.providerConfigured ? (
    <p className="rb-hint">服务端尚未配置 RESEND_API_KEY 与 REALITY_BRIDGE_EMAIL_FROM。</p>
  ) : shortcutEmailStatus?.verified ? (
    <div className="rb-email-verified">
      <span className="rb-email-verified-value">
        <small>已验证</small>
        <b>{shortcutEmailStatus.recipient}</b>
      </span>
      <button type="button" className="rb-btn ghost rb-email-unlink" disabled={shortcutEmailBusy !== null}
        onClick={() => void removeShortcutEmail()}>
        {shortcutEmailBusy === "remove" ? "解绑中…" : "解绑邮箱"}
      </button>
    </div>
  ) : (
    <>
      <div className="rb-email-form">
        <input type="email" value={shortcutEmailInput} placeholder="你的接收邮箱"
          aria-label="接收邮箱" autoComplete="email" inputMode="email"
          onChange={event => setShortcutEmailInput(event.target.value)} />
        <button type="button"
          className={`rb-btn ghost rb-email-submit${shortcutEmailBusy === "send" ? " is-busy" : shortcutEmailStatus?.verificationExpiresAt ? " is-sent" : ""}`}
          disabled={shortcutEmailBusy !== null || shortcutEmailStatus?.providerConfigured === false}
          onClick={() => void sendShortcutEmailCode()}>
          {shortcutEmailBusy === "send" ? "发送中…" : shortcutEmailStatus?.verificationExpiresAt ? "重新发送" : "发送验证码"}
        </button>
      </div>
      {shortcutEmailStatus?.verificationExpiresAt ? (
        <div className="rb-email-form">
          <input inputMode="numeric" maxLength={6} value={shortcutEmailCode} placeholder="六位验证码"
            aria-label="六位验证码" autoComplete="one-time-code"
            onChange={event => setShortcutEmailCode(event.target.value.replace(/\D/g, "").slice(0, 6))} />
          <button type="button"
            className={`rb-btn rb-email-submit${shortcutEmailBusy === "verify" ? " is-busy" : ""}`}
            disabled={shortcutEmailBusy !== null}
            onClick={() => void verifyShortcutEmailCode()}>
            {shortcutEmailBusy === "verify" ? "验证中…" : "确认验证"}
          </button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="reality-bridge-app-shell">
      <div className="reality-bridge-app">
        <header className={`rb-header${closing ? " closing" : ""}`}>
          <button type="button" className="rb-back" onClick={handleClose} aria-label="返回桌面">{RB_ICON_CHEVRON}</button>
          {tab === "history" ? (
            <div className="rb-header-actions">
              {histSec === "feed" && feed.length > 0 ? (
                <button type="button" className="rb-iconbtn rb-trash" onClick={() => setConfirmClear(true)} aria-label="清空接收记录">{RB_ICON_TRASH}</button>
              ) : null}
              <button
                type="button"
                className="rb-iconbtn"
                onClick={() => void syncNow()}
                disabled={syncing || !ready}
                aria-label="刷新"
              ><span className="rb-refresh" style={{ transform: `rotate(${spinTurns * 360}deg)` }}>{RB_ICON_REFRESH}</span></button>
            </div>
          ) : (
            <button type="button" className="rb-iconbtn" onClick={() => setMenuOpen(true)} aria-label="桥接设置">{RB_ICON_DOTS}</button>
          )}
        </header>

        {tab === "history" ? (
          <div className="rb-chipbar rb-fixedbar">
            <div className="rb-chips">
              <button type="button" className={`rb-chip${histSec === "feed" ? " active" : ""}`} onClick={() => setHistSec("feed")}>最近收到</button>
              <button type="button" className={`rb-chip${histSec === "commands" ? " active" : ""}`} onClick={() => setHistSec("commands")}>最近快捷指令</button>
              <button type="button" className={`rb-chip${histSec === "native" ? " active" : ""}`} onClick={() => setHistSec("native")}>本机执行记录</button>
            </div>
          </div>
        ) : null}

        <div className="rb-body">
          {tab === "main" ? (
            <section>
              <div className="rb-hello">
                <h3>现实桥</h3>
                <button
                  type="button"
                  className="rb-add"
                  // 「本机安卓桥」那一屏没有可新建的东西（配置都在设置里），
                  // 但不再把它禁掉——用户打开现实桥十有八九就是想建联动，
                  // 一个灰掉的＋只会让他以为「这里没有新建入口」。
                  // 现在任何一屏的＋都能点：安卓桥那屏直接带他去新建联动。
                  disabled={mainSec === "screen" && Boolean(screenChat.characterId)}
                  aria-label={mainSec === "shortcuts" ? "新建快捷动作" : mainSec === "queries" ? "新建数据项" : mainSec === "screen" ? (screenChat.characterId ? "屏幕速聊已配置" : "配置屏幕速聊") : "新建联动"}
                  onClick={() => {
                    if (mainSec === "android") {
                      setMainSec("rules");
                      openRuleEditor(newRule(), false);
                      return;
                    }
                    if (mainSec === "rules") openRuleEditor(newRule(), false);
                    else if (mainSec === "shortcuts") openShortcutEditor(newShortcutAction(), false);
                    else if (mainSec === "queries") openDataItemEditor(newDataItem(), false);
                    else openScreenChatEditor(false);
                  }}
                >＋</button>
              </div>

              {/* 概览屏自带统计，这里只在其余分区显示一条紧凑状态行 */}
              {mainSec !== "overview" ? (
                <div className="rb-statusline">
                  <span className={ready ? "ok" : "warn"}>{ready ? "云端已连接" : "云端未配置"}</span>
                  <em />
                  <span>今日 {feed.filter(entry => isToday(entry.receivedAt)).length} 条</span>
                  <em />
                  <span>联动 {rules.filter(rule => rule.enabled).length}/{rules.length}</span>
                </div>
              ) : null}

            </section>
          ) : null}

          {tab === "history" ? (
            <section>
              {histSec === "feed" ? (
                <>
                  {feed.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有收到数据</b>
                      <p>
                        {platform.androidBridge === "ready"
                          ? "「设置 → 感知」打开后信号会自己来；想定时做事也可以直接建一条「按时间自动」的联动，不需要任何外部工具。"
                          : "在「设置」页新建联动，向导会带你完成快捷指令配置；运行一次后点右上角刷新。"}
                      </p>
                      <button type="button" className="rb-btn" onClick={() => { setMainSec("rules"); setTab("main"); }}>去创建联动</button>
                    </div>
                  ) : feed.slice(0, 20).map(entry => (
                    <div key={entry.id + entry.receivedAt} className="rb-card rb-feed-item">
                      <div className="rb-feed-head">
                        <span className="rb-type">{entry.type}</span>
                        <span className="rb-time">{fmtTime(entry.receivedAt)}</span>
                      </div>
                      <p className="rb-payload">{(entry.processed || entry.payload).slice(0, 120)}</p>
                      <p className="rb-meta">{entry.actions.join("、")}{entry.error ? ` · 出了点问题：${entry.error}` : ""}</p>
                    </div>
                  ))}
                </>
              ) : histSec === "commands" ? (
                recentCommands.length === 0 ? (
                  <div className="rb-empty">
                    <b>还没有调用记录</b>
                    <p>角色调用快捷动作后，这里会显示每条命令的执行状态。</p>
                  </div>
                ) : (
                  recentCommands.map(command => (
                    <div className="rb-card rb-feed-item" key={command.id}>
                      <div className="rb-feed-head">
                        <span className="rb-type">{command.deliveryMode === "email" ? "邮件" : "推送"}</span>
                        <span className="rb-time">{fmtTime(command.createdAt)}</span>
                      </div>
                      <p className="rb-payload rb-cmd-name">
                        {command.actionName}
                        <span className={`rb-cmd-mark ${command.status}`} title={shortcutStatusLabel(command.status)} aria-label={shortcutStatusLabel(command.status)}>
                          {command.status === "succeeded" ? RB_ICON_CHECK
                            : command.status === "failed" || command.status === "expired" || command.status === "cancelled" ? RB_ICON_CROSS
                            : RB_ICON_CLOCK}
                        </span>
                      </p>
                    </div>
                  ))
                )
              ) : (
                <>
                  <div className="rb-inline-actions" style={{ justifyContent: "flex-end", marginBottom: 10 }}>
                    <button type="button" className="rb-btn ghost" onClick={refreshNativeLog}>{RB_ICON_REFRESH} 刷新本机记录</button>
                  </div>
                  {!nativeLogAvailable ? (
                    <div className="rb-empty"><b>本机记录仅在 Android APK 中提供</b><p>网页版本没有原生系统事件执行器。请在 APK 内打开此页查看本机保存的记录。</p></div>
                  ) : nativeLog.length === 0 ? (
                    <div className="rb-empty"><b>还没有本机执行记录</b><p>记录保存在这台 Android 设备本地。可先测试充电开始/结束或电量偏低等系统信号；通知权限关闭时也会记录失败原因。</p></div>
                  ) : nativeLog.slice().sort((a, b) => (b.at || 0) - (a.at || 0)).slice(0, 50).map((entry, index) => (
                    <div className="rb-card rb-feed-item" key={`${entry.eventId || "native"}-${entry.at || index}-${index}`}>
                      <div className="rb-feed-head"><span className="rb-type">{entry.type || "本机事件"}</span><span className="rb-time">{entry.at ? fmtTime(new Date(entry.at).toISOString()) : ""}</span></div>
                      <p className="rb-payload">{(entry.payload || "").slice(0, 180)}</p>
                      <p className="rb-meta">匹配规则：{entry.rule || "无"} · {entry.result || "无结果信息"}</p>
                    </div>
                  ))}
                </>
              )}
            </section>
          ) : null}

          {tab === "main" ? (
            <section>
              <>
                  {/* ── 分区导航：按平台分组 ──
                      安卓本机桥与 iPhone 快捷指令是两套毫不相干的东西（一套不经云端，
                      一套必须配 Supabase），配置步骤没有一步相同。混在一个导航里并列，
                      结果是每个用户都得先读完六项才知道哪三项跟自己有关。
                      这里只把「你那套」摆出来，另一套收进下方一行切换入口——
                      想了解对面那套的人点得到，不需要的人不必先趟一遍。 */}
                  {(() => {
                    const isAndroidHome = platform.home === "android";
                    const showAndroidGroup = isAndroidHome !== showOtherPlatform;
                    return (
                      <div className="rb-chipbar">
                        <div className="rb-chips">
                          <button type="button" className={`rb-chip${mainSec === "overview" ? " active" : ""}`} onClick={() => setMainSec("overview")}>概览</button>
                          <button type="button" className={`rb-chip${mainSec === "rules" ? " active" : ""}`} onClick={() => setMainSec("rules")}>联动</button>
                          {showAndroidGroup ? (
                            <button type="button" className={`rb-chip${mainSec === "android" ? " active" : ""}`} onClick={() => setMainSec("android")}>本机桥<em>安卓</em></button>
                          ) : (
                            <>
                              <button type="button" className={`rb-chip${mainSec === "shortcuts" ? " active" : ""}`} onClick={() => setMainSec("shortcuts")}>快捷动作<em>iOS</em></button>
                              <button type="button" className={`rb-chip${mainSec === "queries" ? " active" : ""}`} onClick={() => setMainSec("queries")}>查询<em>iOS</em></button>
                              <button type="button" className={`rb-chip${mainSec === "screen" ? " active" : ""}`} onClick={() => setMainSec("screen")}>速聊<em>iOS</em></button>
                            </>
                          )}
                        </div>
                        {platform.home ? (
                          <button
                            type="button"
                            className="rb-platform-switch"
                            onClick={() => {
                              const next = !showOtherPlatform;
                              setShowOtherPlatform(next);
                              // 切过去时顺手落到那组的第一屏，不然会停在一个已经不显示的标签上
                              setMainSec(next ? (isAndroidHome ? "shortcuts" : "android") : (isAndroidHome ? "android" : "shortcuts"));
                            }}
                          >
                            {showOtherPlatform
                              ? `回到适合${platform.label}的这套`
                              : isAndroidHome ? "我其实用 iPhone？" : "我其实用安卓？"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })()}

                  {/* ── 平台提示：你现在看的这套，是不是你设备上的那套 ──
                      只在「不匹配」时出现。文案里必须给出**下一步该做什么**，
                      光说「不适用于你」等于把用户丢在原地。 */}
                  {(() => {
                    const androidSecs = mainSec === "android";
                    const iosSecs = mainSec === "shortcuts" || mainSec === "queries" || mainSec === "screen";
                    if (androidSecs && platform.androidBridge !== "ready") {
                      return (
                        <div className="rb-platform-note">
                          <b>这套是安卓本机桥</b>
                          <p>
                            {platform.kind === "android-browser"
                              ? "需要先装「小手机」安卓 App：装好后它会直接读你手机的状态、也能直接做事，全程不经云端。"
                              : "换到安卓手机上的「小手机」App 里才有这套；你现在的设备走 iPhone 那条路更合适。"}
                          </p>
                          {platform.kind === "android-browser"
                            ? <p className="rb-platform-note-hint">App 装好后回到这里，这一屏就会变成可用状态。</p>
                            : null}
                        </div>
                      );
                    }
                    if (iosSecs && platform.iosBridge !== "ready") {
                      return (
                        <div className="rb-platform-note">
                          <b>这套是 iPhone 的快捷指令路线</b>
                          <p>
                            {platform.home === "android"
                              ? "它靠 iPhone 快捷指令上传数据、必须配 Supabase，在安卓上跑不了。安卓有更省事的一套：本机桥直接读手机状态，不经过云端。"
                              : "要在 iPhone / iPad 上打开才有这套。「快捷动作」「查询」「速聊」都依赖 iPhone 快捷指令与离线推送。"}
                          </p>
                          {platform.home === "android" ? (
                            <button type="button" className="rb-platform-note-jump" onClick={() => { setShowOtherPlatform(false); setMainSec("android"); }}>
                              去看安卓本机桥 →
                            </button>
                          ) : null}
                        </div>
                      );
                    }
                    return null;
                  })()}

                  {/* ── 本机安卓桥 ──
                      与上面的 iPhone 快捷指令路线并列的第二条信号源：
                      安卓壳能**直接**读到手机状态（不经云端、不出设备），也能直接做事。
                      这里只做「总览 + 引导」——详细开关分别在
                      「设置 → 感知」和「设置 → 操作设备」里，避免同一份配置两处维护。 */}
                  {mainSec === "overview" ? (
                    <>
                      {/* ── 概览：先回答「现在到底在不在动」 ── */}
                      <div className="rb-stat-hero">
                        <div className="rb-stat-hero-main">
                          <b>{stats.last24h}</b>
                          <i>近 24 小时收到</i>
                        </div>
                        <div className="rb-stat-hero-side">
                          <span><b>{stats.today}</b> 今天</span>
                          <span><b>{stats.total}</b> 累计</span>
                        </div>
                      </div>

                      <div className="rb-card rb-chart-card">
                        <div className="rb-chart-head">
                          <b>近 7 天</b>
                          <span>{stats.total === 0 ? "还没有数据" : `峰值 ${stats.peak} 条/天`}</span>
                        </div>
                        <div className="rb-chart">
                          {stats.days.map((day, index) => (
                            <div className="rb-chart-col" key={index}>
                              <span
                                className={`rb-chart-bar${day.count > 0 ? " has" : ""}`}
                                style={{ height: `${stats.peak > 0 ? Math.max(6, Math.round((day.count / stats.peak) * 100)) : 6}%` }}
                                title={`${day.count} 条`}
                              />
                              <i>{day.label}</i>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rb-grid">
                        <div className="rb-rcard" onClick={() => setMainSec("rules")}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_BROADCAST}</span>
                            <span className="rb-type">{rules.filter(r => r.enabled).length} 开</span>
                          </div>
                          <b>自动联动</b>
                          <p className="rb-rsum">{rules.length === 0 ? "还没建过" : `共 ${rules.length} 条规则`}</p>
                        </div>
                        <div className="rb-rcard" onClick={() => setMainSec("shortcuts")}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_PHONE}</span>
                            <span className="rb-type">{stats.commands} 次调用</span>
                          </div>
                          <b>快捷动作</b>
                          <p className="rb-rsum">{shortcutActions.length === 0 ? "还没建过" : `共 ${shortcutActions.length} 个动作`}</p>
                        </div>
                      </div>

                      {stats.topTypes.length > 0 ? (
                        <div className="rb-card">
                          <span className="rb-card-title">信号来源</span>
                          <div className="rb-rank">
                            {stats.topTypes.map(([type, count]) => {
                              const pct = Math.round((count / stats.total) * 100);
                              return (
                                <div className="rb-rank-row" key={type}>
                                  <span className="rb-rank-name">{type}</span>
                                  <span className="rb-rank-track"><i style={{ width: `${pct}%` }} /></span>
                                  <span className="rb-rank-num">{count}</span>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {stats.failed.length > 0 || (stats.total > 0 && rules.length === 0) ? (
                        <div className="rb-card rb-attention">
                          {stats.failed.length > 0 ? (
                            <div className="rb-attn-row">
                              <span className="rb-icchip">{RB_ICON_BELL}</span>
                              <div className="rb-main-text">
                                <b>{stats.failed.length} 条执行出错</b>
                                <p>{stats.failed[0].error?.slice(0, 60)}</p>
                              </div>
                              <button type="button" className="rb-link" onClick={() => { setTab("history"); setHistSec("feed"); }}>查看</button>
                            </div>
                          ) : null}
                          {stats.total > 0 && rules.length === 0 ? (
                            <div className="rb-attn-row">
                              <span className="rb-icchip">{RB_ICON_INBOX}</span>
                              <div className="rb-main-text">
                                <b>收到数据，但没规则</b>
                                <p>建条联动，让这些信号真的做点什么</p>
                              </div>
                              <button type="button" className="rb-link" onClick={() => { setMainSec("rules"); openRuleEditor(newRule(), false); }}>去建</button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                      {/* 云端提示要看平台说话。
                          安卓本机桥的「定时联动」是纯本地能力，压根不需要 Supabase——
                          对这类用户无条件喊「还没配置云端存储」，只会让他以为功能没配好、
                          白去折腾一套用不上的东西。 */}
                      {!ready ? (
                        <div className="rb-jump-row" style={{ margin: "8px 4px 0" }}>
                          <p className="rb-hint">
                            {platform.androidBridge === "ready"
                              ? "还没配置云端存储。云端只在「接 iPhone 快捷指令」和「小手机关着也要触发的联动」时才需要——安卓本机桥的定时联动机不用它，可以照常建。"
                              : "还没配置云端存储——现实桥与云端备份共用同一个存储空间，配一次两边都能用。"}
                          </p>
                          {settingsJump("去设置配置云端", "data")}
                        </div>
                      ) : null}
                    </>
                  ) : null}

                  {mainSec === "android" ? (
                    <>
                      <div className="rb-hint" style={{ padding: "8px 4px 0" }}>
                        不需要快捷指令、不经过云端、数据不出本机。开关在设置里，这里只让你看清现状。
                      </div>

                      <div className="rb-grid" style={{ marginTop: 10 }}>
                        <div className="rb-rcard" onClick={() => { setMenuOpen(false); onOpenSettings?.("perception"); }}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_PHONE}</span>
                            <span className="rb-type">{perceptionDiag.bridgeAvailable ? "已接通" : "需更新壳"}</span>
                          </div>
                          <b>感知 · 角色能看见什么</b>
                          <p className="rb-rsum">
                            {perceptionDiag.running ? "引擎运行中" : "引擎已停止"}
                            {" · "}
                            {perceptionDiag.accessibility ? "无障碍已开" : "无障碍未开"}
                            {" · 本小时 "}{perceptionDiag.hourlyUsed}/{perceptionDiag.hourlyLimit}{" 条信号"}
                          </p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">电量 / 网络 / 前台应用 / 步数 / 回到手机</span>
                            <span className="rb-link">去设置 →</span>
                          </div>
                        </div>

                        <div className="rb-rcard" onClick={() => { setMenuOpen(false); onOpenSettings?.("deviceAction"); }}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_GEAR}</span>
                            <span className="rb-type">{deviceActionBridgeOk ? "已接通" : "需更新壳"}</span>
                          </div>
                          <b>操作设备 · 角色能做什么</b>
                          <p className="rb-rsum">
                            {deviceActionEnabled
                              ? `${deviceActionOnCount}/${TOGGLEABLE_ACTIONS.length} 个动作已开启`
                              : "总开关已关闭，角色动不了你的设备"}
                          </p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">手电筒 / 音量 / 亮度 / 勿扰 / 打开应用</span>
                            <span className="rb-link">去设置 →</span>
                          </div>
                        </div>
                      </div>

                      <div className="rb-hint" style={{ padding: "12px 4px 0" }}>
                        感知只读（默认开）；操作设备会真的改手机（默认全关，逐个打开）。
                      </div>

                      {/* 这一屏原本只讲「本机能力在哪配」，于是很多人逛完就走，
                          完全没发现右侧还有「自动联动」这一套。这里补一个明确的去处。 */}
                      <div className="rb-grid" style={{ marginTop: 12 }}>
                        <div
                          className="rb-rcard"
                          onClick={() => {
                            setMainSec("rules");
                            // 一条都没有时**直接开新建**，别再让用户去 rules 分区找那个「＋」。
                            // 从本机桥点过来的人意图很明确：他就是想建第一条。
                            // 已经建过的就去列表——那时他多半是想看看或改改，
                            // 直接弹编辑器会挡住列表。
                            if (rules.length === 0) openRuleEditor(newRule(), false);
                          }}
                        >
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_BROADCAST}</span>
                            <span className="rb-type">{rules.length === 0 ? "下一步" : "已建"}</span>
                          </div>
                          <b>{rules.length === 0 ? "去创建自动联动" : "管理自动联动"}</b>
                          <p className="rb-rsum">收到信号时自动做一件事（写进聊天、记进记忆、操作手机……）</p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">共 {rules.length} 条联动</span>
                            <span className="rb-link">{rules.length === 0 ? "开始创建 →" : "去「联动」→"}</span>
                          </div>
                        </div>
                      </div>
                    </>
                  ) : null}

                  {mainSec === "rules" ? (rules.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有联动</b>
                      <p>联动可以是「收到某个信号时做一件事」，也可以是「每天几点做一件事」——比如每天早上让角色跟你说句话。</p>
                      <button type="button" className="rb-btn" onClick={() => openRuleEditor(newRule(), false)}>新建联动</button>
                    </div>
                  ) : (
                    <div className="rb-grid">
                      {rules.map(rule => {
                        const lastRun = getBridgeRuleLastRunAt(rule.id);
                        const fired = rule.enabled && lastRun > 0 && Date.now() - lastRun < 10 * 60_000;
                        return (
                          <div
                            key={rule.id}
                            className={`rb-rcard${rule.enabled ? "" : " off"}`}
                            onClick={() => openRuleEditor({ ...rule, process: { ...rule.process }, actions: { ...rule.actions } }, true)}
                          >
                            <div className="rb-rtop">
                              <span className="rb-icchip">{ruleIcon(rule)}</span>
                              {fired ? <span className="rb-fired-tag">{fmtHM(lastRun)} 已触发</span> : null}
                            </div>
                            <b>{rule.name || `当收到「${rule.matchType}」`}</b>
                            <p className="rb-rsum">{summarize(rule)}</p>
                            <div className="rb-rfoot">
                              <span className="rb-rstate">{rule.enabled ? "开启" : "已停用"}</span>
                              <button
                                type="button"
                                className={`rb-switch small ${rule.enabled ? "on" : ""}`}
                                onClick={event => {
                                  event.stopPropagation();
                                  persistRules(rules.map(r => r.id === rule.id ? { ...r, enabled: !r.enabled } : r));
                                }}
                                aria-label="启用联动"
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )) : null}

                  {mainSec === "shortcuts" ? (shortcutActions.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有快捷动作</b>
                      <p>把角色工具绑定到你的快捷指令。角色调用时发系统通知，轻点后运行。</p>
                      <button type="button" className="rb-btn" onClick={() => openShortcutEditor(newShortcutAction(), false)}>新建快捷动作</button>
                    </div>
                  ) : (
                    <div className="rb-grid">
                      {shortcutActions.map(action => (
                        <div key={action.id} className={`rb-rcard${action.enabled ? "" : " off"}`}
                          onClick={() => openShortcutEditor({ ...action }, true)}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_PHONE}</span>
                            <span className="rb-type">{action.deliveryMode === "email" ? "邮件自动" : "通知点击"}</span>
                          </div>
                          <b>{action.name}</b>
                          <p className="rb-rsum">{action.shortcutName} · {action.description}</p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">{action.resultMode === "none" ? "不等待结果" : action.resultMode === "image" ? "回传图片" : "回传文本"}</span>
                            <button
                              type="button"
                              className={`rb-switch small ${action.enabled ? "on" : ""}`}
                              onClick={event => {
                                event.stopPropagation();
                                persistShortcutActions(shortcutActions.map(item => item.id === action.id ? { ...item, enabled: !item.enabled } : item));
                              }}
                              aria-label="启用快捷动作"
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  )) : null}

                  {mainSec === "queries" ? (dataItems.length === 0 ? (
                    <div className="rb-empty">
                      <b>还没有数据项</b>
                      <p>定义数据项后，角色即可查询手机的实时状态，需配合快捷指令定期上传，配置方法见教程。</p>
                      <button type="button" className="rb-btn" onClick={() => openDataItemEditor(newDataItem(), false)}>新建数据项</button>
                    </div>
                  ) : (
                    <>
                      <div className="rb-grid">
                        {dataItems.map(item => (
                          <div key={item.id} className="rb-rcard" onClick={() => openDataItemEditor({ ...item }, true)}>
                            <div className="rb-rtop">
                              <span className="rb-type">{item.key}</span>
                            </div>
                            <b>{item.name}</b>
                            <p className="rb-rsum">{item.description || "（未填写说明）"}</p>
                            <div className="rb-rfoot">
                              <button type="button" className="rb-link" onClick={event => { event.stopPropagation(); copy(stateUrl(item.key), "上传地址"); }}>复制上传地址</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )) : null}

                  {mainSec === "screen" ? (
                    screenChat.characterId ? (
                      <div className="rb-grid">
                        <div className={`rb-rcard${screenChat.enabled ? "" : " off"}`} onClick={() => openScreenChatEditor(true)}>
                          <div className="rb-rtop">
                            <span className="rb-icchip">{RB_ICON_CHAT}</span>
                            <span className="rb-type">{personalScreenChatReady ? "个人云已连接" : "需要更新个人云"}</span>
                          </div>
                          <b>屏幕速聊</b>
                          <p className="rb-rsum">双击悬浮球，把当前屏幕交给 {charName(screenChat.characterId)}，并在系统弹窗里连续聊天。</p>
                          <div className="rb-rfoot">
                            <span className="rb-rstate">{screenChat.enabled ? "开启" : "已停用"}</span>
                            <button
                              type="button"
                              className={`rb-switch small ${screenChat.enabled ? "on" : ""}`}
                              onClick={event => {
                                event.stopPropagation();
                                if (!screenChat.enabled && !personalScreenChatReady) {
                                  onNotice?.(personalPushActive ? "请先重新部署最新版个人云" : "请先部署个人云");
                                  return;
                                }
                                updateScreenChat({ enabled: !screenChat.enabled });
                              }}
                              aria-label={screenChat.enabled ? "停用屏幕速聊" : "启用屏幕速聊"}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="rb-empty">
                        <b>还没有配置屏幕速聊</b>
                        <p>双击悬浮球，把当前屏幕发给角色，并在系统弹窗里连续聊天。</p>
                        <button type="button" className="rb-btn" onClick={() => openScreenChatEditor(false)}>开始配置</button>
                      </div>
                    )
                  ) : null}
              </>
            </section>
          ) : null}

        </div>

        {confirmClear ? (
          <div className="rb-modal-mask rb-menu-mask" onClick={() => setConfirmClear(false)}>
            <div className="rb-modal rb-glass-modal" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">清空接收记录？</b>
              <p className="rb-help">只删除本地流水列表；已执行的动作（写入的消息、记忆、日历）不受影响。</p>
              <div className="rb-editor-btns">
                <button type="button" className="rb-btn ghost" onClick={() => setConfirmClear(false)}>取消</button>
                <button type="button" className="rb-btn ghost danger" onClick={() => {
                  clearBridgeFeed();
                  setFeed([]);
                  setConfirmClear(false);
                  onNotice?.("接收记录已清空");
                }}>清空</button>
              </div>
            </div>
          </div>
        ) : null}

        {menuOpen ? (
          <div className="rb-modal-mask rb-menu-mask" onClick={() => setMenuOpen(false)}>
            <div className="rb-modal rb-glass-modal" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">桥接设置</b>
              <div className="rb-main-row">
                <span className="rb-icchip">{RB_ICON_PHONE}</span>
                <div className="rb-main-text">
                  <b>接收快捷指令消息</b>
                  <p>{ready ? "应用打开或后台保活期间自动接收" : "要先配置云端存储才能收"}</p>
                </div>
                <button
                  type="button"
                  className={`rb-switch ${settings.enabled ? "on" : ""}`}
                  onClick={() => updateSettings({ enabled: !settings.enabled })}
                  aria-label="接收快捷指令消息"
                />
              </div>
              {!ready ? (
                <div className="rb-jump-row">{settingsJump("去设置配置云端", "data")}</div>
              ) : null}
              {settings.enabled ? (
                <div className="rb-freq">
                  {FREQ_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      type="button"
                      className={settings.pollSeconds === opt.value ? "sel" : ""}
                      onClick={() => updateSettings({ pollSeconds: opt.value })}
                    >{opt.label}</button>
                  ))}
                </div>
              ) : null}
              <div className="rb-main-row">
                <span className="rb-icchip">{RB_ICON_BROADCAST}</span>
                <div className="rb-main-text">
                  <b>允许自定义APP订阅</b>
                  <p>每条收到的数据都转发给订阅了 bridge.data 的自定义APP</p>
                </div>
                <button
                  type="button"
                  className={`rb-switch ${settings.broadcastToApps ? "on" : ""}`}
                  onClick={() => updateSettings({ broadcastToApps: !settings.broadcastToApps })}
                  aria-label="允许自定义APP订阅"
                />
              </div>
            </div>
          </div>
        ) : null}

        {editing ? (
          <div className="rb-modal-mask" onClick={() => setEditing(null)}>
          <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
            <b className="rb-modal-title">{isExistingRule ? "编辑联动" : "新建联动"}</b>

            {/* 场景模板：只在新建时出现，按「我想让角色……」的说法排列。
                点一下就把信号、加工、动作全部填好，用户只需微调时间或选角色。
                编辑已有规则时不出现——那时候用户心里已经有明确目标了，
                再摆一排模板只会碍事。 */}
            {flatRuleEditor && !isExistingRule ? (
              <div className="rb-fieldset" style={{ marginTop: 4 }}>
                <p className="rb-wiz-tip">选一个最接近的，点开就是填好的规则，改改时间就能用：</p>
                <div className="rb-signal-chips">
                  {RULE_SCENE_TEMPLATES.filter(tpl => !tpl.needsAndroid || platform.androidBridge === "ready").map(tpl => (
                    <button
                      key={tpl.id}
                      type="button"
                      className="rb-signal-chip"
                      title={`${tpl.tag} · ${tpl.desc}`}
                      onClick={() => openSceneTemplate(tpl)}
                    >{tpl.title}</button>
                  ))}
                </div>
                <button type="button" className="rb-btn" style={{ marginTop: 8 }} onClick={installPerceptionRules}>
                  一键补齐全部本机感知规则（默认关闭）
                </button>
                <p className="rb-hint">批量添加只创建规则，不会自动开启；你可以逐条修改角色、关键词、冷却和动作，再用卡片开关启用。也可以不理模板，直接在下面自己配。</p>
                {/* 「操作手机」类模板会真的改手机状态，前提是设备操作总开关已经打开。
                    这里必须是**可点**的跳转：只写一句「去设置里打开」用户翻不到，
                    这正是这个页面最早的教训（见 settingsJump 的注释）。 */}
                {!deviceActionEnabled ? (
                  <div className="rb-jump-row">
                    <span className="rb-hint">带「操作手机」的模板需要先打开设备操作总开关</span>
                    {settingsJump("去打开", "deviceAction")}
                  </div>
                ) : null}
              </div>
            ) : null}

            {flatRuleEditor ? (
              <p className="rb-wiz-label">整条联动都在这一页，从上往下改，底部对勾保存</p>
            ) : (
            <>
            <div className="rb-wiz-steps">
              {[1, 2, 3, 4, 5, 6].map(n => (
                <Fragment key={n}>
                  {n > 1 ? <i className={`rb-wiz-line${n <= wizMax ? " done" : ""}`} /> : null}
                  <button
                    type="button"
                    className={`rb-wiz-dot${n === wizStep ? " cur" : n < wizStep ? " done" : ""}`}
                    /* 新建时也允许直接点任意一步：6 步走下来常要回头改前面填的东西，
                       原来没走到的步骤禁用，想改只能一步步退回去（实测反馈）。
                       校验没有放松——必填项仍在「下一步」和「保存」时把关。 */
                    onClick={() => setWizStep(n)}
                    aria-label={`第${n}步 ${WIZ_STEP_NAMES[n - 1]}`}
                  >{n < wizStep ? "✓" : n}</button>
                </Fragment>
              ))}
            </div>
            <p className="rb-wiz-label">{WIZ_STEP_NAMES[wizStep - 1]}</p>
            </>
            )}

            {/* 安卓：第 1 步不作为「一步」出现。云端只在要收快捷指令传来的数据时才需要，
                本机信号（感知、定时）根本不经云端——所以这里降级成一行条件提示，
                没配就提醒一句，配了什么都不显示。 */}
            {flatRuleEditor ? (
              ready ? null : (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-warn">还没配置云端存储</div>
                  <p className="rb-help">只影响「接收 iPhone 快捷指令传来的数据」；本机的感知与定时信号不经过云端，不受影响。</p>
                  <div className="rb-jump-row">{settingsJump("去设置配置云端", "data")}</div>
                </div>
              )
            ) : wizStep === 1 ? (
              <div className="rb-wiz-page">
                <p className="rb-wiz-intro">联动的作用：当某个信号出现时，自动执行你安排好的动作。信号可以由小手机自己产生（安卓：电量、网络、位置、定时……），也可以由快捷指令从外面传进来（iOS）。</p>
                {ready ? (
                  <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                ) : (
                  <>
                    <div className="rb-wiz-warn">尚未配置云端存储</div>
                    <p className="rb-help">需要填写 Supabase 项目地址与密钥。现实桥与云端备份共用同一个存储空间，配一次两边都能用。</p>
                    <div className="rb-jump-row">{settingsJump("去设置配置云端", "data")}</div>
                  </>
                )}
                <p className="rb-hint">如果你用安卓，「本机桥」里的感知与定时会自己产生信号，不需要任何外部工具；用 iPhone 才需要一条上传数据的快捷指令。</p>
              </div>
            ) : null}

            {/* 第 2 步整块都是「怎么在 iPhone 上建上传数据的快捷指令」——安卓上没这东西，
                直接不出现（安卓的信号来自本机桥）。 */}
            {!flatRuleEditor && wizStep === 2 ? (
              <div className="rb-wiz-page">
                {feedSignals.length > 0 ? (
                  <>
                    <div className="rb-wiz-ok">✓ 已收到过信号，说明快捷指令在正常工作，可直接下一步</div>
                    <details className="rb-more">
                      <summary>需要再建一条快捷指令？展开教程</summary>
                      <div className="rb-more-body">{shortcutSteps}</div>
                    </details>
                  </>
                ) : (
                  <>
                    <p className="rb-wiz-tip">在 iPhone 的「快捷指令」里创建一个上传数据的自动化：</p>
                    {shortcutSteps}
                    <p className="rb-hint">创建好后手动运行一次发送测试数据，下一步就能直接点选它的信号名。</p>
                  </>
                )}
                <details className="rb-more">
                  <summary>可选：离线增强（小手机关着也能触发）</summary>
                  <div className="rb-more-body">
                    <p className="rb-hint">在这条自动化的「获取 URL 内容」（上传数据）之后，<b>再添加一个「获取 URL 内容」</b>，以 GET 方法请求以下地址（无需任何头部与请求体）。加上后，小手机完全关闭时，带「让TA回话」的联动会由服务端代为执行、回复通过系统通知推送；小手机在线时服务端自动让位，没有任何副作用。</p>
                    {wakeUrl ? (
                      <div className="rb-code" onClick={() => copy(wakeUrl, "唤醒地址")}><code>{wakeUrl}</code><span className="rb-copy">复制</span></div>
                    ) : (
                      <p className="rb-hint">（登录账号后这里会生成你的专属唤醒地址）</p>
                    )}
                    <p className="rb-hint">前提：聊天设置已开启「离线推送」。唤醒地址含你的专属令牌，请勿分享。</p>
                  </div>
                </details>
              </div>
            ) : null}

            {(flatRuleEditor || wizStep === 3) ? (
            <div className="rb-wiz-page">
            {flatRuleEditor ? <p className="rb-wiz-tip">什么时候触发</p> : null}
            {feedSignals.length > 0 ? (
              <>
                <p className="rb-wiz-tip">从最近收到过的信号里点选，保证和快捷指令那头一致：</p>
                <div className="rb-signal-chips">
                  {feedSignals.map(signal => (
                    <button
                      key={signal}
                      type="button"
                      className={`rb-signal-chip${editing.matchType === signal ? " sel" : ""}`}
                      onClick={() => setEditing({ ...editing, matchType: signal })}
                    >{signal}</button>
                  ))}
                </div>
              </>
            ) : (
              <p className="rb-help">
              {platform.androidBridge === "ready"
                ? "还没收到过信号。去「设置 → 感知」把它打开，信号就会自己来了；也可以直接在下框手动填信号名，或用下面的「按时间自动」完全绕开信号。"
                : "还没收到过信号。回上一步照教程建一条快捷指令，运行一次就会出现在这里。"}
            </p>
            )}
            <button type="button" className="rb-btn ghost" disabled={syncing || !ready} onClick={() => void syncNow()}>
              {syncing ? "正在刷新…" : "刷新一下信号列表"}
            </button>
            {/* 触发方式：默认「收到信号」，也可以完全不依赖外部信号、按时间自己跑。 */}
            <div className="rb-seg">
              <button type="button" className={!editing.schedule ? "sel" : ""}
                onClick={() => setEditing({ ...editing, schedule: undefined })}>收到信号时</button>
              <button type="button" className={editing.schedule ? "sel" : ""}
                onClick={() => setEditing({
                  ...editing,
                  schedule: editing.schedule ?? { kind: "daily", time: "08:00" },
                })}>按时间自动</button>
            </div>

            {editing.schedule ? (
              <>
                <div className="rb-seg">
                  {([["daily", "每天"], ["weekly", "每周"], ["interval", "每隔"]] as const).map(([kind, label]) => (
                    <button key={kind} type="button"
                      className={editing.schedule!.kind === kind ? "sel" : ""}
                      onClick={() => setEditing({
                        ...editing,
                        schedule: kind === "interval"
                          ? { kind, minutes: editing.schedule!.minutes ?? 60 }
                          : { kind, time: editing.schedule!.time ?? "08:00", weekday: editing.schedule!.weekday ?? 1 },
                      })}>{label}</button>
                  ))}
                </div>
                {editing.schedule.kind === "interval" ? (
                  <label>每隔多少分钟
                    <input type="number" min={1} max={10080} value={editing.schedule.minutes ?? 60}
                      onChange={event => setEditing({
                        ...editing,
                        schedule: { kind: "interval", minutes: Math.max(1, Math.min(10080, Number(event.target.value) || 1)) },
                      })} />
                  </label>
                ) : (
                  <div className="rb-action-body grid2">
                    {editing.schedule.kind === "weekly" ? (
                      <label>星期
                        <select value={editing.schedule.weekday ?? 1}
                          onChange={event => setEditing({
                            ...editing,
                            schedule: { ...editing.schedule!, kind: "weekly", weekday: Number(event.target.value) },
                          })}>
                          {["周日", "周一", "周二", "周三", "周四", "周五", "周六"].map((label, index) => (
                            <option key={index} value={index}>{label}</option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label>时间
                      <input type="time" value={editing.schedule.time ?? "08:00"}
                        onChange={event => setEditing({
                          ...editing,
                          schedule: { ...editing.schedule!, kind: editing.schedule!.kind === "weekly" ? "weekly" : "daily", time: event.target.value || "08:00" },
                        })} />
                    </label>
                  </div>
                )}
                <p className="rb-hint">到点自动执行，不需要任何信号。只在小手机打开或后台保活时触发；错过的时间点不会补齐。</p>
              </>
            ) : (
              <>
                <label>信号名
                  <input value={editing.matchType} maxLength={60} placeholder="例如 duanxin（要和快捷指令里填的一致）"
                    onChange={event => setEditing({ ...editing, matchType: event.target.value })} />
                </label>
                <p className="rb-hint">信号名是你给这类消息起的名字。填 * 表示什么消息都算。</p>

                {/* 只看包含：信号类型太粗（「长时间使用」会同时罩住刷抖音、刷 B 站），
                    想「只有刷抖音才提醒我」就得再按正文过滤一层。 */}
                <label>只看包含
                  <input value={editing.payloadFilter ?? ""} maxLength={60} placeholder="留空 = 不限；例如 抖音，或 抖音|快手"
                    onChange={event => setEditing({ ...editing, payloadFilter: event.target.value })} />
                </label>
                <p className="rb-hint">
                  留空表示这条信号全都算。填了就只在收到内容里出现该词的信号时才触发，多个词用 | 隔开。
                  比如信号名填「长时间使用」、这里填「抖音」，就是「只有刷抖音才提醒」。
                </p>
              </>
            )}
            <label>触发间隔
              <select
                value={editing.cooldownMinutes ?? 0}
                onChange={event => setEditing({ ...editing, cooldownMinutes: Number(event.target.value) || 0 })}
              >
                <option value={0}>不限制，每次都触发</option>
                <option value={5}>5 分钟内只触发一次</option>
                <option value={15}>15 分钟内只触发一次</option>
                <option value={30}>30 分钟内只触发一次</option>
                <option value={60}>1 小时内只触发一次</option>
                <option value={180}>3 小时内只触发一次</option>
                <option value={720}>12 小时内只触发一次</option>
                <option value={1440}>24 小时内只触发一次</option>
              </select>
            </label>
            <p className="rb-hint">短时间反复收到同一信号（比如一小时内多次打开某个 APP）时，间隔内的重复消息只存档，不再打扰角色。</p>
            <label>延迟执行
              <select
                value={editing.delayMinutes ?? 0}
                onChange={event => setEditing({ ...editing, delayMinutes: Number(event.target.value) || 0 })}
              >
                <option value={0}>立刻执行</option>
                <option value={1}>1 分钟后</option>
                <option value={5}>5 分钟后</option>
                <option value={10}>10 分钟后</option>
                <option value={30}>30 分钟后</option>
                <option value={60}>1 小时后</option>
                <option value={180}>3 小时后</option>
              </select>
            </label>
            <p className="rb-hint">设了延迟就不会当场执行，而是到点再做（例如发现你熬夜，十分钟后再提醒）。小手机开着或后台保活时到点即执行；完全关闭期间到点的，下次打开时补上。</p>
            </div>
            ) : null}

            {(flatRuleEditor || wizStep === 4 || wizStep === 5) ? (
            <div className="rb-wiz-page">
            <p className="rb-wiz-tip">收到的原始内容（比如整条短信）交给角色前，可以先加工一下：</p>
            <div className="rb-seg">
              {([["raw", "原样使用"], ["template", "套个句式"], ["ai", "AI 先处理"]] as const).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={editing.process.mode === mode ? "sel" : ""}
                  onClick={() => setEditing({ ...editing, process: { ...editing.process, mode } })}
                >{label}</button>
              ))}
            </div>
            {editing.process.mode === "template" ? (
              <label>句式（{"{payload}"} 代表收到的内容）
                <input value={editing.process.template ?? ""} placeholder="例：我今天走了 {payload} 步"
                  onChange={event => setEditing({ ...editing, process: { ...editing.process, template: event.target.value } })} />
              </label>
            ) : null}
            {editing.process.mode === "ai" ? (
              <label>告诉 AI 怎么处理
                <textarea value={editing.process.prompt ?? ""} rows={2} placeholder="例：结合角色设定，把这条信号变成自然的关心话"
                  onChange={event => setEditing({ ...editing, process: { ...editing.process, prompt: event.target.value } })} />
              </label>
            ) : null}
            <div className="rb-field-group">
            <label>可选的离线回复文案（每行一条，断网时从中选用）
              <textarea
                value={(editing.offlineReplies || []).join("\n")}
                rows={4}
                placeholder={"例：\n又在刷手机啦？眼睛休息一下。\n我看到你电量不多了，记得充电。\n忙完记得回来找我。"}
                onChange={event => setEditing({
                  ...editing,
                  offlineReplies: event.target.value.split("\n").map(line => line.trim()).filter(Boolean).slice(0, 80),
                })}
              />
            </label>
            <small className="rb-hint">这只是断网时备用的话术，不负责执行设备动作。纯设备动作规则可以留空；需要角色回复时，联网后可按角色卡、预设、世界书与近期聊天语境预生成，再保存在本机规则配置里，断网时不临时调用模型。</small>
            <button type="button" className="rb-btn ghost" disabled={offlineReplyGenerating || !editing.actions.chat?.characterId} onClick={() => void generateOfflineReplies()}>
              {offlineReplyGenerating ? "正在让角色准备回复…" : (editing.offlineReplies?.length ? "重新生成并替换回复库" : "让角色 AI 预写离线回复")}
            </button>
            </div>
            </div>
            ) : null}

            {(flatRuleEditor || wizStep === 5) ? (
            <div className="rb-wiz-page">
            <p className="rb-wiz-tip">要做什么（可多选，会按顺序执行）</p>
            <p className="rb-help">这里不只有角色说话：每个动作都是独立可选的。只勾选“直接操作手机”就能做设备动作，不必勾选“告诉一个角色”；“调用一个工具”会执行你已经启用的工具。</p>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.chat}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      chat: event.target.checked
                        ? { characterId: characters[0]?.id ?? "", role: "user", requestReply: true }
                        : undefined,
                    },
                  })} />
                告诉一个角色
              </label>
              {editing.actions.chat ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.chat.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {(editing.actions.chat.historyRole || editing.actions.chat.role) !== "assistant" ? (
                    <label className="rb-check small">
                      <input type="checkbox" checked={editing.actions.chat.requestReply}
                        onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, requestReply: event.target.checked } } })} />
                      让TA回话
                    </label>
                  ) : <span aria-hidden="true" />}
                  <select value={editing.actions.chat.role}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, chat: { ...editing.actions.chat!, role: event.target.value as "user" | "assistant" | "system" } } })}>
                    <option value="user">显示为我说的</option>
                    <option value="assistant">显示为TA说的</option>
                    <option value="system">显示为旁白小字</option>
                  </select>
                  <select value={editing.actions.chat.historyRole ?? ""}
                    onChange={event => setEditing({
                      ...editing,
                      actions: {
                        ...editing.actions,
                        chat: {
                          ...editing.actions.chat!,
                          historyRole: (event.target.value || undefined) as "user" | "assistant" | "system" | undefined,
                        },
                      },
                    })}>
                    <option value="">TA记成：跟显示一致</option>
                    <option value="user">TA记成：我说的话</option>
                    <option value="assistant">TA记成：自己说的话</option>
                    <option value="system">TA记成：发生的事件</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.memory}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, memory: event.target.checked ? { characterId: characters[0]?.id ?? "", type: "long_term" } : undefined },
                  })} />
                让角色记住这件事
              </label>
              {editing.actions.memory ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.memory.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, memory: { ...editing.actions.memory!, characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <select value={editing.actions.memory.type}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, memory: { ...editing.actions.memory!, type: event.target.value as "long_term" | "core" } } })}>
                    <option value="long_term">普通记忆</option>
                    <option value="core">重要记忆</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.timeline}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, timeline: event.target.checked ? { characterId: characters[0]?.id ?? "" } : undefined },
                  })} />
                记入和角色的短期记忆
              </label>
              {editing.actions.timeline ? (
                <div className="rb-action-body grid2">
                  <select value={editing.actions.timeline.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, timeline: { characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.card}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, card: event.target.checked ? { characterId: characters[0]?.id ?? "" } : undefined },
                  })} />
                做成卡片发到聊天里
              </label>
              {editing.actions.card ? (
                <div className="rb-action-body">
                  <select value={editing.actions.card.characterId}
                    onChange={event => setEditing({ ...editing, actions: { ...editing.actions, card: { characterId: event.target.value } } })}>
                    {characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.calendar}
                  onChange={event => setEditing({
                    ...editing,
                    actions: { ...editing.actions, calendar: event.target.checked ? { direction: "future" as const, durationMinutes: 60 } : undefined },
                  })} />
                记到今天的日历上
              </label>
              {editing.actions.calendar ? (
                <div className="rb-action-body grid2">
                  <select
                    value={editing.actions.calendar.direction ?? "future"}
                    onChange={event => setEditing({
                      ...editing,
                      actions: { ...editing.actions, calendar: { ...editing.actions.calendar!, direction: event.target.value === "past" ? "past" : "future", durationMinutes: editing.actions.calendar!.durationMinutes ?? 60 } },
                    })}
                  >
                    <option value="past">记录刚过去的</option>
                    <option value="future">记录接下来的</option>
                  </select>
                  <select
                    value={editing.actions.calendar.durationMinutes ?? 60}
                    onChange={event => setEditing({
                      ...editing,
                      actions: { ...editing.actions, calendar: { ...editing.actions.calendar!, direction: editing.actions.calendar!.direction ?? "future", durationMinutes: Number(event.target.value) || 60 } },
                    })}
                  >
                    <option value={15}>15 分钟</option>
                    <option value={30}>30 分钟</option>
                    <option value={60}>1 小时</option>
                    <option value={90}>1.5 小时</option>
                    <option value={120}>2 小时</option>
                    <option value={180}>3 小时</option>
                  </select>
                </div>
              ) : null}
            </div>

            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.shortcut}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      shortcut: event.target.checked
                        ? { actionId: shortcutActions.find(item => item.enabled && item.deliveryMode !== "email")?.id ?? "" }
                        : undefined,
                    },
                  })} />
                执行一个快捷动作
              </label>
              {editing.actions.shortcut ? (
                <div className="rb-action-body">
                  {shortcutActions.some(item => item.enabled && item.deliveryMode !== "email") ? (
                    <>
                      <select value={editing.actions.shortcut.actionId}
                        onChange={event => setEditing({ ...editing, actions: { ...editing.actions, shortcut: { actionId: event.target.value } } })}>
                        {shortcutActions.filter(item => item.enabled && item.deliveryMode !== "email").map(item => (
                          <option key={item.id} value={item.id}>{item.name}</option>
                        ))}
                      </select>
                      <p className="rb-help">命中时发出该快捷动作的运行通知，点通知即执行；App 被杀时由个人云代发。</p>
                    </>
                  ) : (
                    <p className="rb-help">还没有可用的推送类快捷动作——先到「快捷动作」页创建一个。</p>
                  )}
                </div>
              ) : null}
            </div>

            {/* 直接操作手机：这台安卓手机自己的「手」，与上面的快捷动作并列。
                放最后是因为它是唯一会当场改变手机状态的选项，用户看完别的
                再决定要不要给它这个权限。 */}
            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.deviceAction}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      deviceAction: event.target.checked
                        ? { action: "torch", args: { ...DEVICE_ACTION_DEFAULT_ARGS.torch } }
                        : undefined,
                    },
                  })} />
                直接操作手机（不需要 iPhone）
              </label>
              <p className="rb-help">纯设备动作可以单独运行。小手机界面关闭后，当前原生后台直连只支持“环境光线 → 手电筒”；亮度、音量、勿扰、打开应用等其它动作需要小手机运行中触发或用户确认。</p>
              {editing.actions.deviceAction ? (
                <div className="rb-action-body">
                  <select value={editing.actions.deviceAction.action}
                    onChange={event => {
                      const next = event.target.value;
                      setEditing({
                        ...editing,
                        actions: {
                          ...editing.actions,
                          deviceAction: {
                            action: next,
                            args: { ...(DEVICE_ACTION_DEFAULT_ARGS[next] ?? {}) },
                          },
                        },
                      });
                    }}>
                    {TOGGLEABLE_ACTIONS.map(id => (
                      <option key={id} value={id}>{DEVICE_ACTION_LABEL[id]}</option>
                    ))}
                  </select>
                  <div className="rb-action-body grid2">
                    {renderDeviceActionArgs(
                      editing.actions.deviceAction.action,
                      editing.actions.deviceAction.args ?? {},
                      next => setEditing({
                        ...editing,
                        actions: {
                          ...editing.actions,
                          deviceAction: { ...editing.actions.deviceAction!, args: next },
                        },
                      }),
                    )}
                  </div>
                  {/* 这行里 {payload} 必须写成 {"{payload}"}：JSX 中裸的 {payload}
                      会被当表达式求值，而组件作用域里没有这个变量——直接抛
                      ReferenceError，让整个规则编辑器白屏（实测反馈：联动页报
                      「payload is not defined」）。平铺模式下各步同时渲染，
                      所以是一打开就炸，不像向导走到第 5 步才炸。 */}
                  <p className="rb-help">收到的内容可以填进参数里（用 {"{payload}"} 或 {"{type}"}），例如「打开 {"{payload}"}」。</p>
                  {!deviceActionEnabled ? (
                    <p className="rb-help">还没打开「操作设备」总开关，这条联动会执行失败。</p>
                  ) : deviceActionCfg.actions[editing.actions.deviceAction.action as keyof typeof deviceActionCfg.actions] !== true ? (
                    <p className="rb-help">「{DEVICE_ACTION_LABEL[editing.actions.deviceAction.action as keyof typeof DEVICE_ACTION_LABEL]}」这个动作还没单独打开。</p>
                  ) : null}
                  {!deviceActionEnabled || deviceActionCfg.actions[editing.actions.deviceAction.action as keyof typeof deviceActionCfg.actions] !== true
                    ? <div className="rb-jump-row">{settingsJump("去设置里打开它", "deviceAction")}</div>
                    : null}
                </div>
              ) : null}
            </div>

            {/* 调用一个工具：把角色在聊天里能干的事原样搬进规则里。
                工具的覆盖面最广（内置能力 + 工具箱 REST/组合 + MCP + 自定义 APP），
                所以放在最后，让用户先看完语义明确的那几个动作。 */}
            <div className="rb-action">
              <label className="rb-check">
                <input type="checkbox" checked={!!editing.actions.tool}
                  onChange={event => setEditing({
                    ...editing,
                    actions: {
                      ...editing.actions,
                      tool: event.target.checked
                        ? { name: availableTools[0]?.name ?? "", args: {} }
                        : undefined,
                    },
                  })} />
                调用一个工具
              </label>
              <p className="rb-help">这里执行已在工具箱启用的内置能力、REST/组合工具、MCP 或自定义 APP 工具。规则在小手机运行时调用工具执行器；界面完全关闭后，目前不会在原生后台任意执行工具，只有单独支持的手电筒规则例外。</p>
              {editing.actions.tool ? (
                <div className="rb-action-body">
                  {availableTools.length === 0 ? (
                    <p className="rb-help">还没有可用的工具。先在「工具箱」里添加，或到「工具箱 → 内置能力」开启一个。</p>
                  ) : (
                    <>
                      <select value={editing.actions.tool.name}
                        onChange={event => setEditing({
                          ...editing,
                          actions: { ...editing.actions, tool: { ...editing.actions.tool!, name: event.target.value, args: {} } },
                        })}>
                        {availableTools.map(item => (
                          <option key={`${item.source}:${item.sourceId}`} value={item.name}>{item.name}</option>
                        ))}
                      </select>
                      {/* 这个工具能传什么参数：直接从它的 parameterSchema 生成提示与一键填入。
                          以前只给一个空白 JSON 框 + 一句「参数（JSON，可留空）」，用户
                          根本不知道这个工具接哪些键（实测反馈）。数据本来就在手边，
                          不用白不用。 */}
                      {(() => {
                        const picked = availableTools.find(item => item.name === editing.actions.tool!.name);
                        const fields = parseToolParamFields(picked?.parameterSchema);
                        if (fields.length === 0) return null;
                        // 只列前 8 个：参数特别多的工具（比如组合工具）会把这一屏撑爆，
                        // 而真正需要那么多参数的人本来就会去写 JSON。
                        const shown = fields.slice(0, 8);
                        return (
                          <div className="rb-action-body" style={{ display: "block" }}>
                            <p className="rb-hint" style={{ marginTop: 0 }}>这个工具支持的参数（点一下直接填进去）：</p>
                            <div className="rb-signal-chips">
                              {shown.map(field => (
                                <button
                                  key={field.key}
                                  type="button"
                                  className="rb-signal-chip"
                                  title={`${field.type}${field.required ? "，必填" : "，可选"}${field.description ? ` · ${field.description}` : ""}`}
                                  onClick={() => {
                                    setEditing({
                                      ...editing,
                                      actions: {
                                        ...editing.actions,
                                        tool: {
                                          ...editing.actions.tool!,
                                          args: {
                                            ...(editing.actions.tool!.args ?? {}),
                                            [field.key]: field.type === "number" || field.type === "integer" ? 0 : field.type === "boolean" ? true : "",
                                          },
                                        },
                                      },
                                    });
                                  }}
                                >{field.key}{field.required ? " *" : ""}</button>
                              ))}
                            </div>
                            {shown.filter(f => f.description).slice(0, 4).map(field => (
                              <p className="rb-hint" key={field.key} style={{ margin: "2px 0" }}>
                                <b>{field.key}</b>：{field.description}
                              </p>
                            ))}
                            {fields.length > shown.length ? (
                              <p className="rb-hint" style={{ margin: "2px 0" }}>还有 {fields.length - shown.length} 个参数，可在下方 JSON 里手动填。</p>
                            ) : null}
                          </div>
                        );
                      })()}
                      <label>参数（JSON，可留空）
                        <textarea
                          /* key 里带上 args 的序列化：点上面的参数标签填入后，args 一变
                             就重新挂载一次，框里立刻能看到刚填进去的那个键。只写工具名的话
                             defaultValue 永远不会刷新，用户点了标签会以为没反应。 */
                          key={`${editing.actions.tool.name}:${JSON.stringify(editing.actions.tool.args ?? {})}`}
                          rows={2}
                          defaultValue={Object.keys(editing.actions.tool.args ?? {}).length > 0
                            ? JSON.stringify(editing.actions.tool.args, null, 2)
                            : ""}
                          placeholder='例：{"focus":"battery"}；值里可以用 {payload} 取收到的内容'
                          onBlur={event => {
                            const raw = event.target.value.trim();
                            if (!raw) {
                              setEditing({ ...editing, actions: { ...editing.actions, tool: { ...editing.actions.tool!, args: {} } } });
                              return;
                            }
                            try {
                              const parsed = JSON.parse(raw) as unknown;
                              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                                onNotice?.("参数要是一个 JSON 对象");
                                return;
                              }
                              setEditing({ ...editing, actions: { ...editing.actions, tool: { ...editing.actions.tool!, args: parsed as Record<string, unknown> } } });
                            } catch {
                              onNotice?.("参数不是合法的 JSON");
                            }
                          }} />
                      </label>
                      <p className="rb-help">参数里的 {"{payload}"}、{"{type}"} 会替换成收到的内容或信号名。组合工具、MCP 工具都在这个列表里，等于规则可以直接串联它们。</p>
                    </>
                  )}
                </div>
              ) : null}
            </div>

            </div>
            ) : null}

            {(flatRuleEditor || wizStep === 6) ? (
              <div className="rb-wiz-page">
                {flatRuleEditor ? <p className="rb-wiz-tip">试跑与保存</p> : null}
                <div className="rb-wiz-summary">
                  <b>{editing.name.trim() || (editing.schedule ? "定时联动" : `当收到「${editing.matchType.trim() || "……"}」`)}</b>
                  <p>{summarize(editing)}</p>
                </div>

                {/* 试跑：保存前先真的跑一遍，别让用户配完还得回 iPhone 碰运气。 */}
                <div className="rb-fieldset" style={{ border: "none", padding: 0, margin: "4px 0 0" }}>
                  <p className="rb-wiz-tip">试跑一次（可选，但强烈建议）</p>
                  <p className="rb-hint">填一条示例数据，<b>先检查匹配、再真的跑一遍动作</b>——这样既能看出「信号名/过滤词有没有填错」（填错的话真信号来了根本不会触发），也能看出「触发之后会发生什么」。<b>动作会真的执行</b>：该写进聊天就写、该弹通知就弹；但不会记进接收记录，也不占用触发间隔。试跑满意再保存。</p>
                  <label>示例信号名
                    <input value={ruleTest.type} maxLength={60}
                      placeholder={editing.schedule ? "定时规则用不到信号名，可留空" : editing.matchType.trim() || "默认用你上面填的信号名"}
                      onChange={event => setRuleTest({ ...ruleTest, type: event.target.value })} />
                  </label>
                  <label>示例内容（就是 {"{payload}"}）
                    <textarea rows={2} value={ruleTest.payload} maxLength={500}
                      placeholder={editing.process.mode === "ai" ? "填一段真实点的内容，才看得出 AI 会加工成什么" : "例如：已连续使用抖音 25 分钟"}
                      onChange={event => setRuleTest({ ...ruleTest, payload: event.target.value })} />
                  </label>
                  <button type="button" className="rb-btn ghost" disabled={ruleTestBusy} onClick={() => void runRuleTest()}>
                    {ruleTestBusy ? "正在试跑…" : "试跑一次"}
                  </button>
                  <button type="button" className="rb-btn ghost" disabled={previewBusy} onClick={() => void runPreview()}>
                    {previewBusy ? "正在生成预览…" : "只预览角色会说的话（不执行动作）"}
                  </button>
                  {previewResult && (
                    <div className="rb-hint" style={{ marginTop: 8, padding: 10, borderRadius: 10, background: "rgba(0,0,0,.04)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                      <b>加工预览：</b>{previewResult}
                    </div>
                  )}
                  {ruleTestResult && (
                    <p className="rb-hint" style={{ color: ruleTestResult.ok ? "var(--c-success, #16a34a)" : "var(--c-danger, #dc2626)", wordBreak: "break-word", whiteSpace: "pre-wrap" }} role="status">
                      {ruleTestResult.text}
                    </p>
                  )}
                </div>

                {/* 保存之后的验证方式两部分不一样：定时规则不用去 iPhone 跑任何东西。 */}
                {editing.schedule ? (
                  <p className="rb-help">保存后到点会自动执行。前提是小手机开着或后台保活——完全关闭期间错过的时刻不会补跑。</p>
                ) : flatRuleEditor ? (
                  <p className="rb-help">保存后，等本机信号出现（电量变化、打开某个应用、到点等）就会自动触发；能在「历史」页看到记录。</p>
                ) : (
                  <p className="rb-help">保存后，在 iPhone 上运行一次对应的快捷指令，再到「历史」页刷新；看到这条数据出现，说明联动已经生效。</p>
                )}
                {isExistingRule ? (
                  <button
                    type="button"
                    className="rb-del-link"
                    onClick={() => {
                      persistRules(rules.filter(rule => rule.id !== editing.id));
                      setEditing(null);
                      onNotice?.("联动已删除");
                    }}
                  >删除这条联动</button>
                ) : null}
              </div>
            ) : null}

            {flatRuleEditor ? (
              /* 平铺模式没有「下一步」，底部就是一个保存。校验仍走 saveEditing——
                 它会把「信号名没填」这类问题当场说清楚，而不是静默不保存。 */
              <div className="rb-wiz-nav">
                <button type="button" className="rb-wiz-next" onClick={saveEditing} aria-label="保存联动">{RB_ICON_CHECK}</button>
              </div>
            ) : (
            <div className="rb-wiz-nav">
              {wizStep > 1 ? (
                <button type="button" className="rb-wiz-back" onClick={() => setWizStep(wizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
              ) : null}
              <button
                type="button"
                className={`rb-wiz-next${wizStep === 3 && !editing.matchType.trim() ? " dim" : ""}`}
                onClick={wizNext}
                aria-label={wizStep === 6 ? "保存联动" : "下一步"}
              >{wizStep === 6 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
            </div>
            )}
          </div>
          </div>
        ) : null}

        {editingShortcut ? (
          <div className="rb-modal-mask" onClick={() => setEditingShortcut(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">{isExistingShortcut ? "编辑快捷动作" : "新建快捷动作"}</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4, 5, 6].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= swizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === swizStep ? " cur" : n < swizStep ? " done" : ""}`}
                      disabled={!isExistingShortcut && n > swizMax}
                      onClick={() => setSwizStep(n)}
                      aria-label={`第${n}步 ${SWIZ_STEP_NAMES[n - 1]}`}
                    >{n < swizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{SWIZ_STEP_NAMES[swizStep - 1]}</p>

              {swizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">快捷动作是角色的「手」：角色调用工具后，你的 iPhone 弹出系统通知，轻点即运行对应的快捷指令，还可以把结果回传给角色。</p>
                  {ready ? (
                    <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">尚未配置云端存储</div>
                      <p className="rb-help">前往「设置 → 数据管理 → 云端备份」填写 Supabase 项目地址与密钥。</p>
                    </>
                  )}
                </div>
              ) : null}

              {swizStep === 2 ? (
                <div className="rb-wiz-page">
                  <p className="rb-hint" style={{ display: "none" }} />
                  <label>工具名称（角色看到的动作名）
                    <input value={editingShortcut.name} maxLength={30} placeholder="例如：打开微信并截图"
                      onChange={event => {
                        const value = event.target.value;
                        const follows = !editingShortcut.shortcutName.trim() || editingShortcut.shortcutName === editingShortcut.name;
                        setEditingShortcut({ ...editingShortcut, name: value, shortcutName: follows ? value : editingShortcut.shortcutName });
                      }} />
                  </label>
                  <label>用途说明（告诉角色何时调用）
                    <textarea value={editingShortcut.description} rows={3} maxLength={300}
                      placeholder="例如：用户允许时打开微信，等待指定秒数后截图，并把图片回传"
                      onChange={event => setEditingShortcut({ ...editingShortcut, description: event.target.value })} />
                  </label>
                  <p className="rb-hint">用途说明会进入角色的工具列表，是角色判断「什么时候该用它」的唯一依据，写得越具体越好。</p>
                </div>
              ) : null}

              {swizStep === 3 ? (
                <div className="rb-wiz-page">
                  <div className="rb-seg">
                    <button type="button" className={editingShortcut.deliveryMode === "push" ? "sel" : ""}
                      onClick={() => setEditingShortcut({ ...editingShortcut, deliveryMode: "push" })}>系统通知</button>
                    <button type="button" className={editingShortcut.deliveryMode === "email" ? "sel" : ""}
                      onClick={() => setEditingShortcut({ ...editingShortcut, deliveryMode: "email" })}>邮件自动（实验）</button>
                  </div>
                  {editingShortcut.deliveryMode === "push" ? (
                    <>
                      <p className="rb-help">角色调用后，你的 iPhone 弹出系统通知，轻点通知即运行对应的快捷指令。</p>
                      <p className="rb-hint">前提：小手机已添加到 iPhone 主屏幕，并在聊天设置中开启「离线推送」。</p>
                    </>
                  ) : (
                    <>
                      <p className="rb-help">收到触发邮件时由 iOS 自动化「立即运行」，全程无需点按。实验功能：首次运行可能仍要求权限，锁屏下部分动作可能受 iOS 限制。</p>
                      <p className="rb-hint">邮件只是动作的触发通道：角色说的话仍走离线推送送达，所以离线推送要保持开启，否则 App 关着时这条动作也不会被触发。</p>
                      <p className="rb-wiz-tip">验证 iPhone「邮件」App 里能即时收信的邮箱（仅 iCloud / Exchange 支持实时推送）：</p>
                      {shortcutEmailVerifyBlock}
                      <p className="rb-hint">还要把发件人 <button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailStatus?.senderAddress || "bridge@notify.floatbubble.top", "发件人地址")}>{shortcutEmailStatus?.senderAddress || "bridge@notify.floatbubble.top"}</button> 加入邮箱白名单，防止触发邮件进垃圾箱、自动化收不到。</p>
                      <details className="rb-more">
                        <summary>邮箱怎么开通 / 白名单怎么设</summary>
                        <div className="rb-more-body">
                          <p className="rb-hint"><b>iCloud 邮箱（推荐）</b>：设置 → 顶部你的名字 → iCloud → 打开“iCloud 邮件”，按提示创建 @icloud.com 地址（创建一次永久使用）。国区 Apple ID 同样支持，只是默认没开通。</p>
                          <p className="rb-hint"><b>QQ 邮箱（Exchange 方式）</b>：先在 QQ 邮箱 App/网页「设置 → 账户」开启服务并生成<b>授权码</b>；再到 iPhone「设置 → 邮件 → 账户 → 添加账户 → Microsoft Exchange」，邮箱填 QQ 邮箱地址，密码填<b>授权码</b>（不是 QQ 密码），服务器填 ex.qq.com。用“其他(IMAP)”方式添加的邮箱最长 15 分钟才收一次信，会慢到超时。</p>
                          <p className="rb-hint"><b>白名单</b>：QQ 邮箱在「设置 → 反垃圾 → 设置邮件地址白名单」添加发件人；iCloud 把发件人存入“通讯录”，或在“垃圾邮件”文件夹里把误判的信标记为“非垃圾邮件”。</p>
                        </div>
                      </details>
                    </>
                  )}
                </div>
              ) : null}

              {swizStep === 4 ? (
                <div className="rb-wiz-page">
                  <fieldset className="rb-fieldset">
                    <legend>需要角色输出的快捷指令运行参数（文本/数字）</legend>
                    <p className="rb-hint">例如：让角色输出要发送到你真实手机备忘录的文字——参数名：memo，类型：文本，参数描述：要写入备忘录的内容。不需要参数就保持为空。</p>
                    {paramAdvanced ? (
                      <>
                        <textarea className="rb-schema-input" value={editingShortcut.parameterSchema} rows={7} maxLength={8000}
                          aria-label="参数 JSON Schema"
                          onChange={event => setEditingShortcut({ ...editingShortcut, parameterSchema: event.target.value })} />
                        <p className="rb-hint">高级模式：直接编辑 JSON Schema。
                          <button type="button" className="rb-link" onClick={() => {
                            const rows = parseShortcutParamRows(editingShortcut.parameterSchema);
                            if (rows === null) { onNotice?.("当前 JSON 结构较复杂，无法转为简易清单"); return; }
                            setParamRows(rows);
                            setParamAdvanced(false);
                          }}>返回简易模式</button>
                        </p>
                      </>
                    ) : (
                      <>
                        {paramRows.map((row, index) => (
                          <div className="rb-param-row" key={index}>
                            <input className="rb-param-key" value={row.key} maxLength={40} placeholder="参数名（英文）"
                              onChange={event => {
                                const value = event.target.value.replace(/[^a-zA-Z0-9_]/g, "");
                                const rows = paramRows.map((r, i) => i === index ? { ...r, key: value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }} />
                            <select value={row.type}
                              onChange={event => {
                                const value = (event.target.value === "number" ? "number" : "string") as ShortcutParamRow["type"];
                                const rows = paramRows.map((r, i) => i === index ? { ...r, type: value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }}>
                              <option value="string">文本</option>
                              <option value="number">数字</option>
                            </select>
                            <input className="rb-param-desc" value={row.description} maxLength={120} placeholder="参数描述"
                              onChange={event => {
                                const rows = paramRows.map((r, i) => i === index ? { ...r, description: event.target.value } : r);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }} />
                            <button type="button" className="rb-param-remove" aria-label="删除参数"
                              onClick={() => {
                                const rows = paramRows.filter((_, i) => i !== index);
                                setParamRows(rows);
                                setEditingShortcut({ ...editingShortcut, parameterSchema: buildShortcutParamSchema(rows) });
                              }}>−</button>
                          </div>
                        ))}
                        <button type="button" className="rb-btn rb-param-add" onClick={() => {
                          const rows = [...paramRows, { key: "", type: "string" as const, description: "" }];
                          setParamRows(rows);
                        }}>＋ 添加参数</button>
                        <p className="rb-hint">参数会自动生成 JSON 定义，运行时作为「快捷指令输入」传入。
                          <button type="button" className="rb-link" onClick={() => setParamAdvanced(true)}>高级：编辑 JSON</button>
                        </p>
                      </>
                    )}
                  </fieldset>
                  <label>执行结果
                    <select value={editingShortcut.resultMode}
                      onChange={event => setEditingShortcut({ ...editingShortcut, resultMode: event.target.value as BridgeShortcutAction["resultMode"] })}>
                      <option value="none">发出后立即返回，不等待结果</option>
                      <option value="text">等待快捷指令回传文本</option>
                      <option value="image">等待快捷指令上传图片（可附文字）</option>
                    </select>
                  </label>
                  {editingShortcut.resultMode !== "none" ? (
                    <label>等待回传时长
                      <select value={editingShortcut.expiresInSeconds}
                        onChange={event => setEditingShortcut({ ...editingShortcut, expiresInSeconds: Number(event.target.value) })}>
                        <option value={30}>30 秒</option>
                        <option value={60}>1 分钟</option>
                        <option value={120}>2 分钟</option>
                        <option value={300}>5 分钟</option>
                        <option value={600}>10 分钟（邮件模式推荐）</option>
                        <option value={900}>15 分钟</option>
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {swizStep === 5 ? (() => {
                const hasParams = shortcutParamKeys.length > 0;
                const wantsResult = editingShortcut.resultMode !== "none";
                const isEmailMode = editingShortcut.deliveryMode === "email";
                const resultNo = 2 + (hasParams ? 1 : 0);
                const emailNo = resultNo + (wantsResult ? 1 : 0);
                const lastNo = emailNo + (isEmailMode ? 1 : 0);
                return (
                  <div className="rb-wiz-page">
                    <p className="rb-wiz-tip">按这份清单在 iPhone「快捷指令」App 里创建（内容根据你前几步的选择生成）：</p>
                    <label>快捷指令名称（默认与工具名一致，可改）
                      <input value={editingShortcut.shortcutName} maxLength={80} placeholder="必须和“快捷指令”App 中的名称完全一致"
                        onChange={event => setEditingShortcut({ ...editingShortcut, shortcutName: event.target.value })} />
                    </label>
                    <div className="rb-substep">
                      <i>1</i>
                      <div className="rb-substep-body">
                        <p><b>新建并命名</b>：在「快捷指令」标签页新建一条（注意不是自动化），名字设为 {editingShortcut.shortcutName.trim() ? (
                          <button type="button" className="rb-copychip" onClick={() => copy(editingShortcut.shortcutName.trim(), "快捷指令名称")}>{editingShortcut.shortcutName.trim()}</button>
                        ) : <b>（先填上方名称）</b>}（必须一字不差），然后搭好要执行的动作。</p>
                      </div>
                    </div>
                    {hasParams ? (
                      <div className="rb-substep">
                        <i>2</i>
                        <div className="rb-substep-body">
                          <p><b>接收参数</b>：先添加「获取文本」（输入选「快捷指令输入」），再添加「获取字典值」：字典选「文本」，键名填 {shortcutParamKeys.map((key, index) => (
                            <Fragment key={key}>{index > 0 ? "、" : null}<button type="button" className="rb-copychip" onClick={() => copy(key, "参数名")}>{key}</button></Fragment>
                          ))}，取到的值供后续操作使用。</p>
                        </div>
                      </div>
                    ) : null}
                    {wantsResult ? (
                      <div className="rb-substep">
                        <i>{resultNo}</i>
                        <div className="rb-substep-body">
                          {editingShortcut.resultMode === "image" ? (
                            <p><b>回传图片</b>：{hasParams ? null : <>先添加「获取文本」（输入选「快捷指令输入」），</>}用「获取字典值」取上传地址：字典选「文本」，键名填 <button type="button" className="rb-copychip" onClick={() => copy("resultUrl", "键名")}>resultUrl</button>；再用「获取 URL 内容」POST 到该变量。只传图：请求体选「文件」，文件选图片（≤8MB）。图+附文字（如截屏配 OCR 屏幕文字）：先对图片用「Base64 编码」，请求体选 JSON，加文本字段 <button type="button" className="rb-copychip" onClick={() => copy("image", "键名")}>image</button>（填编码结果）和 <button type="button" className="rb-copychip" onClick={() => copy("ocr", "键名")}>ocr</button>（填附带文字），文字会和图一起交给角色。</p>
                          ) : (
                            <p><b>回传文本</b>：{hasParams ? null : <>先添加「获取文本」（输入选「快捷指令输入」），</>}用「获取字典值」取上传地址：字典选「文本」，键名填 <button type="button" className="rb-copychip" onClick={() => copy("resultUrl", "键名")}>resultUrl</button>；再用「获取 URL 内容」POST 到该变量，请求体选 JSON，加文本字段 text 填结果。</p>
                          )}
                        </div>
                      </div>
                    ) : null}
                    {isEmailMode ? (
                      <div className="rb-substep">
                        <i>{emailNo}</i>
                        <div className="rb-substep-body">
                          <p><b>建邮件自动化</b>：在「自动化」新建「电子邮件」自动化——发件人填下方地址，主题包含下方标记，选「立即运行」，动作设为运行上面这条快捷指令并把邮件正文作为输入。</p>
                          {shortcutEmailStatus?.senderAddress ? (
                            <div className="rb-kv"><span className="rb-k">发件人</span><span style={{ wordBreak: "break-all" }}><button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailStatus.senderAddress, "发件人地址")}>{shortcutEmailStatus.senderAddress}</button></span></div>
                          ) : null}
                          <div className="rb-kv"><span className="rb-k">主题标记</span><span style={{ wordBreak: "break-all" }}><button type="button" className="rb-copychip" onClick={() => copy(shortcutEmailSubjectTag(editingShortcut.id), "主题标记")}>{shortcutEmailSubjectTag(editingShortcut.id)}</button></span></div>
                        </div>
                      </div>
                    ) : null}
                    <div className="rb-substep">
                      <i>{lastNo}</i>
                      <div className="rb-substep-body">
                        <p><b>先手动跑通</b>：自己运行一次，确认快捷指令本身没问题，再进入下一步测试整条链路。</p>
                      </div>
                    </div>
                  </div>
                );
              })() : null}

              {swizStep === 6 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>{editingShortcut.name.trim() || "未命名动作"}</b>
                    <p>{`运行「${editingShortcut.shortcutName.trim() || "……"}」 · ${editingShortcut.deliveryMode === "email" ? "邮件自动触发" : "通知点击运行"} · ${editingShortcut.resultMode === "none" ? "不等待结果" : editingShortcut.resultMode === "image" ? "回传图片" : "回传文本"}`}</p>
                  </div>
                  <button type="button" className="rb-btn ghost" disabled={testingShortcut}
                    onClick={() => void testEditingShortcut()}>
                    {testingShortcut ? "正在发送…" : editingShortcut.deliveryMode === "email" ? "发送测试邮件" : "发送测试通知"}
                  </button>
                  {testResult && (
                    <p className="rb-hint" style={{ color: testResult.ok ? "var(--c-success, #16a34a)" : "var(--c-danger, #dc2626)", wordBreak: "break-word" }} role="status">
                      {testResult.text}
                    </p>
                  )}
                  <p className="rb-hint">建议先发一条测试确认链路通了再保存；保存后角色即可调用这个工具。</p>
                  {isExistingShortcut ? (
                    <button type="button" className="rb-del-link" onClick={() => {
                      persistShortcutActions(shortcutActions.filter(item => item.id !== editingShortcut.id));
                      setEditingShortcut(null);
                      onNotice?.("快捷动作已删除");
                    }}>删除这个快捷动作</button>
                  ) : null}
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {swizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setSwizStep(swizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${(swizStep === 2 && !editingShortcut.name.trim()) || (swizStep === 5 && !editingShortcut.shortcutName.trim()) ? " dim" : ""}`}
                  onClick={swizNext}
                  aria-label={swizStep === 6 ? "保存快捷动作" : "下一步"}
                >{swizStep === 6 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        {editingItem ? (
          <div className="rb-modal-mask" onClick={() => setEditingItem(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">{dataItems.some(item => item.id === editingItem.id) ? "编辑数据项" : "新建数据项"}</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= dwizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === dwizStep ? " cur" : n < dwizStep ? " done" : ""}`}
                      disabled={!dataItems.some(item => item.id === editingItem.id) && n > dwizMax}
                      onClick={() => setDwizStep(n)}
                      aria-label={`第${n}步 ${DWIZ_STEP_NAMES[n - 1]}`}
                    >{n < dwizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{DWIZ_STEP_NAMES[dwizStep - 1]}</p>

              {dwizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">主动查询是角色的「仪表盘」：你的 iPhone 定期上传状态快照（电量、步数……），角色聊天时可以随时调工具查看最新数据，回答自动带上更新时间。</p>
                  {ready ? (
                    <div className="rb-wiz-ok">✓ 云端存储已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">尚未配置云端存储</div>
                      <p className="rb-help">前往「设置 → 数据管理 → 云端备份」填写 Supabase 项目地址与密钥。</p>
                    </>
                  )}
                </div>
              ) : null}

              {dwizStep === 2 ? (
                <div className="rb-wiz-page">
                  <label>名称（角色看到的工具名）
                    <input value={editingItem.name} maxLength={20} placeholder="例如：查看健康数据"
                      onChange={event => setEditingItem({ ...editingItem, name: event.target.value })} />
                  </label>
                  <label>标识（决定上传地址，仅小写字母、数字、-、_）
                    <input value={editingItem.key} maxLength={40} placeholder="例如：health"
                      onChange={event => setEditingItem({ ...editingItem, key: event.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
                  </label>
                  <label>说明（告诉角色这是什么数据）
                    <textarea value={editingItem.description} rows={2} maxLength={200}
                      placeholder="例如：今日步数、静息心率与昨晚睡眠时长"
                      onChange={event => setEditingItem({ ...editingItem, description: event.target.value })} />
                  </label>
                </div>
              ) : null}

              {dwizStep === 3 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-tip">在 iPhone 上建一条定期上传数据的自动化：</p>
                  <div className="rb-substep">
                    <i>1</i>
                    <div className="rb-substep-body">
                      <p><b>新建自动化</b>：在「快捷指令 → 自动化」新建，触发时机按数据特点选择。</p>
                      <div className="rb-kv"><span className="rb-eg">示例</span><span>电量 → 「充电时」+「每小时」；健康数据 → 每天早晚各一次</span></div>
                    </div>
                  </div>
                  <div className="rb-substep">
                    <i>2</i>
                    <div className="rb-substep-body">
                      <p><b>获取并上传数据</b>：先用系统动作取数据（如「获取电池电量」「查找健康样本」），再用「获取 URL 内容」以 POST 发到下方地址，请求体选 JSON，内容格式自由（例：{"{\"电量\":\"85%\",\"充电中\":\"是\"}"}）。</p>
                      <div className="rb-code" onClick={() => copy(stateUrl(sanitizeBridgeDataKey(editingItem.key) || "标识"), "上传地址")}><code>{stateUrl(sanitizeBridgeDataKey(editingItem.key) || "标识")}</code><span className="rb-copy">复制</span></div>
                    </div>
                  </div>
                  <div className="rb-substep">
                    <i>3</i>
                    <div className="rb-substep-body">
                      <p><b>设置头部</b>（两项都要）：<button type="button" className="rb-copychip" onClick={() => copy("Authorization", "头部名称")}>Authorization</button> 填下方密钥；<button type="button" className="rb-copychip" onClick={() => copy("x-upsert", "头部名称")}>x-upsert</button> 填 <button type="button" className="rb-copychip" onClick={() => copy("true", "头部值")}>true</button>（快照反复覆盖同一地址，缺它第二次上传会报 409）。</p>
                      <div className="rb-code" onClick={() => copy(`Bearer ${config.key || ""}`, "密钥")}>
                        <code>{config.key ? `Bearer ${config.key.slice(0, 12)}……${config.key.slice(-6)}` : "<请先完成第一步>"}</code>
                        <span className="rb-copy">复制</span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {dwizStep === 4 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>{editingItem.name.trim() || "未命名数据项"}</b>
                    <p>{editingItem.description.trim() || "（未填写说明）"}</p>
                  </div>
                  <button type="button" className="rb-btn ghost" disabled={dataSnapshotBusy || !ready}
                    onClick={() => void checkDataSnapshot()}>
                    {dataSnapshotBusy ? "正在读取…" : "已上传过数据？读取看看"}
                  </button>
                  {dataSnapshot === "none" ? (
                    <p className="rb-hint">还没读到数据。运行一次上一步的自动化后再试；刚上传的话等几秒。</p>
                  ) : dataSnapshot ? (
                    <div className="rb-wiz-snapshot">
                      <small>{dataSnapshot.updatedAt ? `更新于 ${fmtTime(dataSnapshot.updatedAt)}` : "已读到数据"}</small>
                      <code>{dataSnapshot.text.slice(0, 400)}</code>
                    </div>
                  ) : null}
                  <p className="rb-hint">保存后角色即可通过工具查询这项数据（需在「工具箱 → 内置能力」启用「现实桥」）。</p>
                  {dataItems.some(item => item.id === editingItem.id) ? (
                    <button type="button" className="rb-del-link" onClick={() => {
                      persistDataItems(dataItems.filter(item => item.id !== editingItem.id));
                      setEditingItem(null);
                      onNotice?.("数据项已删除");
                    }}>删除这个数据项</button>
                  ) : null}
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {dwizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setDwizStep(dwizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${dwizStep === 2 && (!editingItem.name.trim() || !sanitizeBridgeDataKey(editingItem.key)) ? " dim" : ""}`}
                  onClick={dwizNext}
                  aria-label={dwizStep === 4 ? "保存数据项" : "下一步"}
                >{dwizStep === 4 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        {editingScreenChat ? (
          <div className="rb-modal-mask" onClick={() => setEditingScreenChat(null)}>
            <div className="rb-modal rb-editor" onClick={event => event.stopPropagation()}>
              <b className="rb-modal-title">配置屏幕速聊</b>

              <div className="rb-wiz-steps">
                {[1, 2, 3, 4].map(n => (
                  <Fragment key={n}>
                    {n > 1 ? <i className={`rb-wiz-line${n <= screenWizMax ? " done" : ""}`} /> : null}
                    <button
                      type="button"
                      className={`rb-wiz-dot${n === screenWizStep ? " cur" : n < screenWizStep ? " done" : ""}`}
                      disabled={n > screenWizMax}
                      onClick={() => setScreenWizStep(n)}
                      aria-label={`第${n}步 ${SCREEN_WIZ_STEP_NAMES[n - 1]}`}
                    >{n < screenWizStep ? "✓" : n}</button>
                  </Fragment>
                ))}
              </div>
              <p className="rb-wiz-label">{SCREEN_WIZ_STEP_NAMES[screenWizStep - 1]}</p>

              {screenWizStep === 1 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">屏幕速聊会把当前屏幕交给角色，TA 的回复以系统弹窗直接出现，还能在弹窗里继续聊，全程不用打开小手机。</p>
                  {personalScreenChatReady ? (
                    <div className="rb-wiz-ok">✓ 最新版个人云已连接，这一步自动完成</div>
                  ) : (
                    <>
                      <div className="rb-wiz-warn">{personalPushActive ? "个人云版本需要更新" : "尚未部署个人云"}</div>
                      <p className="rb-help">前往「设置 → 云服务部署」{personalPushActive ? "重新部署最新版个人云" : "完成个人云部署"}，屏幕速聊接口会随部署一起创建。</p>
                    </>
                  )}
                  <p className="rb-hint">截图只用于当前一次 AI 生成，不保存到 Supabase；云端仅暂存尚未同步回小手机的文字消息。</p>
                </div>
              ) : null}

              {screenWizStep === 2 ? (
                <div className="rb-wiz-page">
                  {characters.length > 0 ? (
                    <label>谁来接弹窗
                      <select
                        value={editingScreenChat.characterId}
                        onChange={event => setEditingScreenChat({ ...editingScreenChat, characterId: event.target.value })}
                      >
                        <option value="" disabled>请选择角色</option>
                        {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
                      </select>
                    </label>
                  ) : (
                    <div className="rb-wiz-warn">请先在小手机里创建一个角色</div>
                  )}
                  <p className="rb-hint">屏幕速聊始终接入这个角色原有的同一个聊天窗口。换 App、隔很久再双击也不会新开对话；打开小手机后，云端暂存的问答会按顺序进入原聊天记录。</p>
                </div>
              ) : null}

              {screenWizStep === 3 ? (
                <div className="rb-wiz-page">
                  <p className="rb-wiz-intro">推荐直接导入已经搭好的「屏幕速聊」，导入时按提示填写你的接口地址和令牌。</p>
                  <a
                    className="rb-btn rb-shortcut-import"
                    href={SCREEN_CHAT_SHORTCUT_URL}
                    target="_blank"
                    rel="noreferrer noopener"
                    aria-label="打开 iCloud 导入屏幕速聊快捷指令"
                  >一键导入屏幕速聊</a>
                  <div>
                    <p className="rb-wiz-tip">问题 1 · 接口地址</p>
                    <div className="rb-code" onClick={() => copy(screenChatUrl, "接口地址")}><code>{screenChatUrl}</code><span className="rb-copy">复制</span></div>
                  </div>
                  <div>
                    <p className="rb-wiz-tip">问题 2 · 令牌</p>
                    {bridgeToken ? (
                      <div className="rb-code" onClick={() => copy(bridgeToken, "令牌")}><code>{bridgeToken}</code><span className="rb-copy">复制</span></div>
                    ) : (
                      <p className="rb-hint">个人云连通后这里会显示你的专属令牌。</p>
                    )}
                  </div>
                  <p className="rb-hint rb-screen-chat-bind-hint">导入完成后，到系统「设置 → 辅助功能 → 触控 → 辅助触控」，把「轻点两下」设为这条快捷指令。</p>

                  <details className="rb-more rb-screen-chat-manual">
                    <summary>需要手动搭建？展开完整步骤</summary>
                    <div className="rb-more-body">
                      <div className="rb-substep">
                        <i>1</i>
                        <div className="rb-substep-body">
                          <p><b>新建快捷指令</b>：新建一条快捷指令（不是自动化），起名如「屏幕速聊」。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>2</i>
                        <div className="rb-substep-body">
                          <p><b>截屏并压缩</b>：依次添加「截屏」→「调整图像大小」（宽度 960，高度自动）→「转换图像」（JPEG）→「Base64 编码」。</p>
                          <p className="rb-hint">再加「从图像中提取文本」，输入选择调整大小后的图像，作为图像识别不可用时的兜底。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>3</i>
                        <div className="rb-substep-body">
                          <p><b>发给角色</b>：添加「获取 URL 内容」，URL 填：</p>
                          <div className="rb-code" onClick={() => copy(screenChatUrl, "接口地址")}><code>{screenChatUrl}</code><span className="rb-copy">复制</span></div>
                          <p>方法选 <b>POST</b>，请求体选 <b>JSON</b>，添加 4 个文本字段：
                            <button type="button" className="rb-copychip" onClick={() => copy("token", "字段名")}>token</button> 填下方令牌、
                            <button type="button" className="rb-copychip" onClick={() => copy("image", "字段名")}>image</button> 插入 Base64 变量、
                            <button type="button" className="rb-copychip" onClick={() => copy("imageType", "字段名")}>imageType</button> 填 <button type="button" className="rb-copychip" onClick={() => copy("image/jpeg", "字段值")}>image/jpeg</button>、
                            <button type="button" className="rb-copychip" onClick={() => copy("ocr", "字段名")}>ocr</button> 插入图像文本变量。</p>
                          {bridgeToken ? (
                            <div className="rb-code" onClick={() => copy(bridgeToken, "令牌")}><code>{bridgeToken}</code><span className="rb-copy">复制</span></div>
                          ) : (
                            <p className="rb-hint">个人云连通后这里会显示你的专属令牌。</p>
                          )}
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>4</i>
                        <div className="rb-substep-body">
                          <p><b>弹出回复</b>：从「URL 内容」获取字典值 <button type="button" className="rb-copychip" onClick={() => copy("reply", "键名")}>reply</button>，再用「显示提醒」弹出它。</p>
                          <p className="rb-hint">也可读取 <button type="button" className="rb-copychip" onClick={() => copy("error", "键名")}>error</button>，在请求失败时显示原因。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>5</i>
                        <div className="rb-substep-body">
                          <p><b>续聊循环</b>：添加「重复」（15 次），内部放「要求输入」→ 再次 POST 同一地址（<button type="button" className="rb-copychip" onClick={() => copy("token", "字段名")}>token</button> 与 <button type="button" className="rb-copychip" onClick={() => copy("text", "字段名")}>text</button>）→ 获取 reply →「显示提醒」。</p>
                          <p className="rb-hint">弹窗点「取消」即可结束本次对话。</p>
                        </div>
                      </div>
                      <div className="rb-substep">
                        <i>6</i>
                        <div className="rb-substep-body">
                          <p><b>绑定悬浮球</b>：系统「设置 → 辅助功能 → 触控 → 辅助触控」，把「轻点两下」设为这条快捷指令。</p>
                          <p className="rb-hint">首次运行请允许网络与截屏权限；每轮回复通常需要 3～8 秒。</p>
                        </div>
                      </div>
                    </div>
                  </details>
                </div>
              ) : null}

              {screenWizStep === 4 ? (
                <div className="rb-wiz-page">
                  <div className="rb-wiz-summary">
                    <b>屏幕速聊</b>
                    <p>{editingScreenChat.characterId ? `${charName(editingScreenChat.characterId)} 会接收屏幕并在原聊天窗口连续回复。` : "尚未选择角色"}</p>
                  </div>
                  <div className="rb-main-row">
                    <span className="rb-icchip">{RB_ICON_CHAT}</span>
                    <div className="rb-main-text">
                      <b>启用屏幕速聊</b>
                      <p>保存后可随时在配置卡片上暂停或恢复</p>
                    </div>
                    <button
                      type="button"
                      className={`rb-switch ${editingScreenChat.enabled ? "on" : ""}`}
                      onClick={() => setEditingScreenChat({ ...editingScreenChat, enabled: !editingScreenChat.enabled })}
                      aria-label={editingScreenChat.enabled ? "保存后停用屏幕速聊" : "保存后启用屏幕速聊"}
                    />
                  </div>
                  <p className="rb-hint">保存只更新小手机里的配置，不会重建个人云，也不会清空已有聊天或同步记录。</p>
                </div>
              ) : null}

              <div className="rb-wiz-nav">
                {screenWizStep > 1 ? (
                  <button type="button" className="rb-wiz-back" onClick={() => setScreenWizStep(screenWizStep - 1)} aria-label="上一步">{RB_ICON_CHEVRON}</button>
                ) : null}
                <button
                  type="button"
                  className={`rb-wiz-next${(screenWizStep === 1 && !personalScreenChatReady) || (screenWizStep === 2 && !editingScreenChat.characterId) ? " dim" : ""}`}
                  onClick={screenWizNext}
                  aria-label={screenWizStep === 4 ? "保存屏幕速聊" : "下一步"}
                >{screenWizStep === 4 ? RB_ICON_CHECK : RB_ICON_ARROW}</button>
              </div>
            </div>
          </div>
        ) : null}

        <nav className="rb-dock" aria-label="页面切换">
          <button type="button" className={tab === "main" ? "active" : ""} onClick={() => setTab("main")} aria-label="设置与联动">{RB_ICON_GEAR}</button>
          <button type="button" className={tab === "history" ? "active" : ""} onClick={() => setTab("history")} aria-label="接收历史">{RB_ICON_HISTORY}</button>
        </nav>
      </div>
    </div>
  );
}
