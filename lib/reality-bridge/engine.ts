"use client";

import { simpleLLMCall } from "../api-helpers";
import { loadApiConfigs, resolveAuxiliaryApiConfig, resolveUserIdentity } from "../settings-storage";
import { loadCharacters } from "../character-storage";
import { MacroEngine } from "../macro-engine";
import {
  addChatContact,
  CHAT_REQUEST_REPLY_EVENT,
  createOrGetSession,
  loadChatContacts,
  pushChatMessage,
  reindexSessionMessageOrdersByTime,
  type ChatMessage,
  upsertImportedChatMessage,
} from "../chat-storage";
import { cancelFollowUp, requestBackgroundChatReply } from "../follow-up-service";
import { saveMemoryEntry } from "../memory-storage";
import { appendCustomAppTimelineEntry } from "../custom-app-storage";
import { upsertCalendarScheduleItem } from "../calendar-storage";
import { getWeekStartIso } from "../calendar-utils";
import { sendBrowserNotification } from "../browser-notification";
import { dispatchChatMessageNotice } from "../chat-notification-events";
import { createShortcutCommand } from "../shortcut-command-client";
import { runDeviceAction } from "../device-action";
import {
  REALITY_BRIDGE_DATA_EVENT,
  type BridgeFeedEntry,
  type BridgeItem,
  type BridgeRule,
} from "./types";
import {
  appendBridgeFeed,
  appendBridgeOutbox,
  bridgeConnection,
  getBridgeRuleLastRunAt,
  loadBridgeRules,
  loadBridgeFeed,
  loadBridgeSettings,
  loadBridgeShortcutActions,
  markBridgeRuleRun,
  mergeBridgeRuleRuns,
} from "./storage";
import {
  enqueueDelayedTask,
  loadDelayedTasks,
  saveDelayedTasks,
} from "./delayed-queue";

const BRIDGE_SOURCE = { id: "reality_bridge", name: "现实桥" };

function fillTemplate(template: string, item: BridgeItem): string {
  return template
    .replace(/\{payload\}/g, item.payload)
    .replace(/\{type\}/g, item.type);
}

/** 展开 {{user}}/{{char}} 等宏：现实桥消息属于模板性质，写入前先替换 */
function expandBridgeMacros(text: string, characterId?: string): string {
  if (!text.includes("{{")) return text;
  const charName = characterId
    ? (loadCharacters().find(item => item.id === characterId)?.name ?? "")
    : "";
  const userName = resolveUserIdentity(characterId)?.name || "用户";
  try {
    return new MacroEngine(charName, userName).expand(text);
  } catch {
    return text;
  }
}

const USAGE_REMINDER_TYPES = new Set(["应用用太久", "长时间使用"]);

/** 旧的默认使用提醒规则是 raw：直接把“抖音已使用 90 分钟”写进聊天。
 * 运行时把它升级成“AI 生成角色口吻 + 作为角色消息”，不覆盖用户自定义模板/提示词。 */
function upgradeUsageReminderRule(rule: BridgeRule): BridgeRule {
  if (!USAGE_REMINDER_TYPES.has(rule.matchType)) return rule;
  if (rule.process?.mode !== "raw" || rule.process?.template?.trim()) return rule;
  const characterId = rule.actions?.chat?.characterId;
  if (!characterId) return rule;
  return {
    ...rule,
    process: {
      mode: "ai",
      prompt: "你刚注意到{{user}}的使用情况：{payload}。不要复述分钟数，不要写“你今天使用 xx 分钟了”。先用角色自己的感受或关系开口，再轻轻提醒；一到两句，像你本人在说话。不要和最近几次提醒重复。",
    },
    actions: {
      ...rule.actions,
      chat: { ...rule.actions.chat!, role: "assistant", requestReply: false },
    },
  };
}

function usageCharacterContext(characterId?: string): { charName: string; userName: string; details: string } {
  const character = characterId ? loadCharacters().find(item => item.id === characterId) : undefined;
  const charName = character?.name || "角色";
  const userName = resolveUserIdentity(characterId)?.name || "你";
  const details = character
    ? [character.persona, character.briefPersona, character.personality]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .join("\n").slice(0, 1800)
    : "";
  return { charName, userName, details };
}

async function processText(rule: BridgeRule, item: BridgeItem): Promise<string> {
  const mode = rule.process?.mode ?? "raw";
  if (mode === "template" && rule.process.template) {
    return fillTemplate(rule.process.template, item).slice(0, 4000);
  }
  if (mode === "ai" && rule.process.prompt) {
    const config = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
    if (config) {
      const prompt = fillTemplate(rule.process.prompt, item);
      const isUsage = USAGE_REMINDER_TYPES.has(rule.matchType);
      const context = isUsage ? usageCharacterContext(rule.actions.chat?.characterId) : null;
      const recent = isUsage
        ? loadBridgeFeed().filter(entry => entry.type === item.type).slice(0, 3)
            .map(entry => (entry.processed || entry.payload).slice(0, 220))
        : [];
      const systemContent = isUsage && context
        ? `你是${context.charName}，正在和${context.userName}相处。你不是数据播报器；用角色自己的口吻说话。\n${context.details}`
        : "你是「现实桥」的数据加工器。按用户指令处理数据，只输出处理结果本身，不要解释。";
      const contextBlock = isUsage
        ? `\n\n最近三次同类提醒（不要重复这些说法）：\n${recent.length ? recent.map(text => "- " + text).join("\n") : "- 无"}\n\n当前时间：${new Date().toLocaleString("zh-CN")}`
        : "";
      try {
        const result = await simpleLLMCall(config, [
          { role: "system", content: systemContent },
          { role: "user", content: prompt + "\n\n数据内容：" + item.payload + contextBlock },
        ], { temperature: 0.8 });
        const text = (result.content ?? "").trim();
        if (text) return text.slice(0, 4000);
      } catch (error) {
        console.warn("[现实桥] 温暖提醒生成失败，使用本机兜底", error);
      }
    }
    if (USAGE_REMINDER_TYPES.has(rule.matchType)) {
      const { charName } = usageCharacterContext(rule.actions.chat?.characterId);
      return `${charName}看了你一眼，没急着报数字，只轻声说：“这个是不是有点久了？先歇一会儿吧，陪我说两句话。”`;
    }
  }
  return item.payload;
}

/** 只预览加工后的文本，不执行任何动作；供规则编辑器“模拟测试”使用。 */
export async function previewBridgeRuleText(rule: BridgeRule, item: BridgeItem): Promise<string> {
  return processText(upgradeUsageReminderRule(rule), item);
}

/** 广播 bridge.data 事件给已订阅的自定义 APP（规则动作与「允许自定义APP订阅」总开关共用） */
function broadcastBridgeItemToApps(item: BridgeItem, text: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(REALITY_BRIDGE_DATA_EVENT, {
    detail: { type: item.type, payload: item.payload, processed: text, receivedAt: item.createdAt },
  }));
}

const BROADCAST_ACTION_NOTE = "广播事件";

/** 通知打开中的聊天室刷新（与分享卡片等外部写入同一事件） */
function notifyChatUpdated(sessionId: string): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId } }));
  }
}

function ensureSession(characterId: string) {
  if (!loadChatContacts().some(contact => contact.characterId === characterId)) {
    addChatContact(characterId);
  }
  return createOrGetSession(characterId);
}

async function runChatAction(
  rule: NonNullable<BridgeRule["actions"]["chat"]>,
  text: string,
): Promise<string> {
  const session = ensureSession(rule.characterId);
  // role = 聊天室里的显示身份；historyRole = 角色记忆里的身份（缺省跟随显示）
  const historyRole = rule.historyRole && rule.historyRole !== rule.role ? rule.historyRole : undefined;
  const effectiveRole = rule.historyRole || rule.role;
  pushChatMessage({
    sessionId: session.id,
    role: rule.role,
    content: expandBridgeMacros(text, session.contactId),
    mediaData: historyRole ? ({ appHistoryRole: historyRole } as ChatMessage["mediaData"]) : undefined,
  });
  notifyChatUpdated(session.id);
  // 与聊天室发消息同款：用户这边有新动静，旧的追问计划作废（回应生成后会重新安排）
  if (effectiveRole === "user") cancelFollowUp(session.id);
  // 记忆里算TA自己说的话，就没有「回话」可言；我说的/旁白事件都可以让TA回应
  if (!rule.requestReply || effectiveRole === "assistant") return "写入聊天";
  // 聊天室正开着这个会话时，交给它原生生成（输入中状态、锁定输入、分条协议全套）
  if (typeof window !== "undefined") {
    const detail = { source: "reality_bridge", sessionId: session.id, characterId: rule.characterId, handled: false, busy: false };
    window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail }));
    if (detail.handled) return detail.busy ? "写入聊天（角色正在回复中）" : "写入聊天，已由聊天室生成回应";
    // 桥自己接管后台生成：先置 handled，避免 desktop-shell 的兜底监听
    // 稍后又触发一次 requestBackgroundChatReply（双重生成）
    detail.handled = true;
  }
  // 统一后台回复链路：与追问/自定义APP同一实现
  // （分条、状态栏、拍一拍、来电、收红包、生图、横幅+弹窗、逐条弹出、安排追问）
  try {
    const result = await requestBackgroundChatReply(session.id);
    if (result.ok) return "写入聊天并生成回应";
    if (result.skipped === "already_running") return "写入聊天（角色正在回复中）";
  } catch (err) {
    console.warn("[现实桥] 角色回应生成失败", err);
  }
  return "写入聊天（回应失败）";
}

async function runActions(rule: BridgeRule, item: BridgeItem, text: string): Promise<string[]> {
  const done: string[] = [];
  const actions = rule.actions ?? {};

  if (actions.chat?.characterId) {
    done.push(await runChatAction(actions.chat, text));
  }
  if (actions.memory?.characterId) {
    const now = new Date().toISOString();
    await saveMemoryEntry({
      id: `bridge_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      characterId: actions.memory.characterId,
      sourceApp: "chat",
      type: actions.memory.type === "core" ? "core" : "long_term",
      content: expandBridgeMacros(text, actions.memory.characterId).slice(0, 1000),
      importance: 0.6,
      createdAt: now,
      updatedAt: now,
    });
    done.push("写入记忆");
  }
  if (actions.timeline?.characterId) {
    appendCustomAppTimelineEntry(BRIDGE_SOURCE, {
      characterId: actions.timeline.characterId,
      summary: expandBridgeMacros(text, actions.timeline.characterId).slice(0, 200),
      detail: item.payload.slice(0, 1000),
    });
    done.push("写入时间线");
  }
  if (actions.notify) {
    sendBrowserNotification("现实桥 · " + item.type, { body: expandBridgeMacros(text).slice(0, 120) });
    done.push("系统通知");
  }
  if (actions.calendar) {
    const now = new Date();
    const iso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const hm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    let startTime: string;
    let endTime: string;
    const duration = Number(actions.calendar.durationMinutes);
    if (Number.isFinite(duration) && duration > 0) {
      // 新版：以触发时刻为锚点，向前或向后铺 duration 分钟，跨天部分钳在今天之内
      const span = Math.min(720, Math.max(5, duration)) * 60_000;
      const start = actions.calendar.direction === "past" ? new Date(now.getTime() - span) : now;
      const end = actions.calendar.direction === "past" ? now : new Date(now.getTime() + span);
      startTime = start.getDate() === now.getDate() ? hm(start) : "00:00";
      endTime = end.getDate() === now.getDate() ? hm(end) : "23:59";
    } else {
      // 旧版规则：固定时段
      startTime = actions.calendar.startTime || "09:00";
      endTime = actions.calendar.endTime || "10:00";
    }
    upsertCalendarScheduleItem("user", "user", getWeekStartIso(now), {
      date: iso,
      startTime,
      endTime,
      location: "",
      title: expandBridgeMacros(text).slice(0, 60),
      source: "manual",
    });
    done.push("写入日历");
  }
  if (actions.card?.characterId) {
    const session = ensureSession(actions.card.characterId);
    const cardText = expandBridgeMacros(text, actions.card.characterId);
    pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: cardText.slice(0, 2000),
      mediaType: "app_card",
      mediaData: {
        appId: BRIDGE_SOURCE.id,
        appName: BRIDGE_SOURCE.name,
        appCardTitle: item.type,
        appCardBody: cardText.slice(0, 2000),
        appCardSummary: cardText.slice(0, 200),
      } as ChatMessage["mediaData"],
    });
    notifyChatUpdated(session.id);
    done.push("发送卡片");
  }
  if (actions.shortcut?.actionId) {
    const shortcutAction = loadBridgeShortcutActions()
      .find(entry => entry.id === actions.shortcut?.actionId && entry.enabled);
    if (shortcutAction) {
      try {
        const created = await createShortcutCommand(shortcutAction, {});
        done.push(created.delivered
          ? `发出快捷动作「${shortcutAction.name}」`
          : `快捷动作「${shortcutAction.name}」未能送达`);
      } catch (err) {
        done.push(`快捷动作「${shortcutAction.name}」失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
      }
    }
  }
  if (actions.deviceAction?.action) {
    // 参数先展开 {payload}/{type}：这样能配出「收到『到家』→ 打开 {payload}」
    const filledArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(actions.deviceAction.args ?? {})) {
      filledArgs[key] = typeof value === "string" ? fillTemplate(value, item) : value;
    }
    const outcome = runDeviceAction({ action: actions.deviceAction.action, ...filledArgs });
    done.push(outcome.ok ? `操作设备·${outcome.message ?? "已执行"}` : `操作设备失败：${outcome.reason ?? "未知原因"}`);
  }
  if (actions.tool?.name) {
    // 动态 import：tool-executor → perception → 本模块，静态引入会绕成循环依赖。
    const toolArgs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(actions.tool.args ?? {})) {
      toolArgs[key] = typeof value === "string" ? fillTemplate(value, item) : value;
    }
    const toolName = actions.tool.name;
    try {
      const { executeToolCalls } = await import("../tool-executor");
      const results = await executeToolCalls([{ name: toolName, args: toolArgs }], {
        appId: "chat",
        sourceEngine: "chat",
        characterId: actions.tool.characterId || actions.chat?.characterId,
      });
      const first = results[0];
      done.push(first?.success
        ? `调用「${toolName}」${first.data ? `：${first.data.slice(0, 80)}` : "完成"}`
        : `调用「${toolName}」失败：${(first?.error ?? "动作未找到").slice(0, 80)}`);
    } catch (err) {
      done.push(`调用「${toolName}」失败：${(err instanceof Error ? err.message : String(err)).slice(0, 80)}`);
    }
  }
  if (actions.outbox?.type) {
    const { config, ready } = bridgeConnection();
    if (ready) {
      await appendBridgeOutbox(config, { type: actions.outbox.type, payload: expandBridgeMacros(text).slice(0, 2000), source: "rule" });
      done.push("回传 iPhone");
    }
  }
  if (actions.broadcast) {
    broadcastBridgeItemToApps(item, text);
    done.push(BROADCAST_ACTION_NOTE);
  }
  return done;
}

/** 服务端处理过的桥事件·回端补账：写桥消息、补执行非聊天动作、记流水、回灌冷却。
 *  角色回复正文由调用方（push-outbox-client）走通用解析管线单独合并。 */
export async function applyServerBridgeEntry(meta: {
  item?: { id?: string; type?: string; payload?: string; createdAt?: string };
  /** 服务端生成并传给微信云消息的同一个因果锚点 ID。 */
  chatMessageId?: string;
  ruleId?: string;
  ruleName?: string;
  ranAt?: string;
  executed?: boolean;
  processedText?: string;
  /** 聊天气泡仍显示 processedText；可另给模型一份更完整但不打扰 UI 的历史文本。 */
  historyText?: string;
  feedNote?: string;
  shortcutNote?: string;
  capped?: boolean;
  chat?: {
    characterId?: string;
    sessionId?: string;
    role?: "user" | "assistant" | "system";
    historyRole?: "user" | "assistant" | "system";
    requestReply?: boolean;
  } | null;
}): Promise<{ sessionId?: string }> {
  const item: BridgeItem = {
    id: String(meta.item?.id ?? `srv_${Date.now().toString(36)}`),
    type: String(meta.item?.type ?? "数据"),
    payload: String(meta.item?.payload ?? ""),
    createdAt: String(meta.item?.createdAt ?? new Date().toISOString()),
  };
  const text = meta.processedText ?? item.payload;
  const actionNotes: string[] = [];
  let sessionId: string | undefined;

  if (meta.ruleId && meta.ranAt) {
    mergeBridgeRuleRuns({ [meta.ruleId]: meta.ranAt });
  }

  // 桥消息写入（与 runChatAction 的写入部分同规则；回复由外层合并）
  if (meta.chat?.characterId && meta.chat.role) {
    const session = ensureSession(meta.chat.characterId);
    sessionId = session.id;
    const historyRole = meta.chat.historyRole && meta.chat.historyRole !== meta.chat.role ? meta.chat.historyRole : undefined;
    const effectiveRole = meta.chat.historyRole || meta.chat.role;
    const sourceMs = Date.parse(item.createdAt);
    const createdAt = Number.isFinite(sourceMs) ? new Date(sourceMs).toISOString() : new Date().toISOString();
    const fallbackId = `bridge_${String(meta.ruleId || "rule")}_${item.id}`
      .replace(/[^a-zA-Z0-9_-]/g, "_")
      .slice(0, 240);
    upsertImportedChatMessage({
      id: String(meta.chatMessageId || fallbackId),
      sessionId: session.id,
      role: meta.chat.role,
      content: expandBridgeMacros(text, session.contactId),
      status: "sent",
      createdAt,
      mediaData: (historyRole || meta.historyText) ? ({
        ...(historyRole ? { appHistoryRole: historyRole } : {}),
        ...(meta.historyText ? { appHistoryText: expandBridgeMacros(meta.historyText, session.contactId) } : {}),
      } as ChatMessage["mediaData"]) : undefined,
    });
    // 服务端回端补账发生在 App 重开时，不能用“此刻”作为桥事件时间；按收件箱
    // 原始 createdAt 重排，确保桥输入位于它触发的云端微信回复之前。
    reindexSessionMessageOrdersByTime(session.id);
    notifyChatUpdated(session.id);
    if (effectiveRole === "user") cancelFollowUp(session.id);
    actionNotes.push("写入聊天（服务端触发）");
  }

  // 非聊天动作补执行：仅对服务端真正执行过的条目重放（冷却/无规则的存档条不补），
  // 规则已删则跳过
  const rule = meta.executed && meta.ruleId ? loadBridgeRules().find(r => r.id === meta.ruleId) : undefined;
  if (rule) {
    // chat/notify/shortcut 服务端已执行过，补账只重放剩余动作
    const deferredRule: BridgeRule = {
      ...rule,
      actions: { ...rule.actions, chat: undefined, notify: undefined, shortcut: undefined },
    };
    try {
      actionNotes.push(...await runActions(deferredRule, item, text));
    } catch (err) {
      console.warn("[现实桥] 服务端事件补账失败", rule.name, err);
    }
  }
  if (meta.shortcutNote) actionNotes.push(meta.shortcutNote);
  if (meta.capped) actionNotes.push("已达当日服务端回复上限，仅存档");

  // 「允许自定义APP订阅」总开关：服务端补账的条目也照常广播（规则动作已广播过则不重复）
  if (loadBridgeSettings().broadcastToApps && !actionNotes.includes(BROADCAST_ACTION_NOTE)) {
    broadcastBridgeItemToApps(item, text);
    actionNotes.push(BROADCAST_ACTION_NOTE);
  }

  appendBridgeFeed({
    id: item.id,
    type: item.type,
    payload: item.payload.slice(0, 2000),
    processed: text !== item.payload ? text.slice(0, 2000) : undefined,
    rules: rule ? [rule.name] : meta.ruleName ? [meta.ruleName] : [],
    actions: meta.feedNote ? [meta.feedNote, ...actionNotes] : actionNotes,
    receivedAt: new Date().toISOString(),
  });
  return { sessionId };
}

/**
 * 规则的关键词过滤：空 = 不限；否则要求信号正文里出现其中之一。
 *
 * 大小写不敏感；分隔符接受 | , ，、 三种写法，用哪种用户顺眼就用哪种。
 * 分隔后全是空串（用户只敲了几个逗号）时视为不限——否则规则会静默失效，
 * 而用户看到的是「我明明填了过滤却一条都不触发」，极难排查。
 */
function matchesPayloadFilter(filter: string | undefined, payload: string): boolean {
  const raw = (filter ?? "").trim();
  if (!raw) return true;
  const terms = raw.split(/[|,，、]/).map(term => term.trim()).filter(Boolean);
  if (terms.length === 0) return true;
  const haystack = String(payload ?? "").toLowerCase();
  return terms.some(term => haystack.includes(term.toLowerCase()));
}

/** 处理一条收件箱数据：匹配规则 → 加工 → 执行动作 → 记录流水。 */
export async function processBridgeItem(item: BridgeItem): Promise<BridgeFeedEntry> {
  // 定时规则不参与信号匹配：它们由 runDueScheduledRules() 直接触发，
  // 若混进来，任何一条信号都会把它们捎带着跑一遍。
  const rules = loadBridgeRules().filter(rule => {
    if (!rule.enabled || rule.schedule) return false;
    if (rule.matchType !== "*" && rule.matchType !== item.type) return false;
    return matchesPayloadFilter(rule.payloadFilter, item.payload);
  });
  const entry: BridgeFeedEntry = {
    id: item.id,
    type: item.type,
    payload: item.payload.slice(0, 2000),
    rules: rules.map(rule => rule.name),
    actions: [],
    receivedAt: new Date().toISOString(),
  };
  for (const rawRule of rules) {
    const rule = upgradeUsageReminderRule(rawRule);
    // 触发间隔：间隔内再次收到同信号，只存档不执行（避免反复打开某 APP 时刷屏）
    const cooldownMs = Math.max(0, Number(rule.cooldownMinutes) || 0) * 60_000;
    if (cooldownMs > 0 && Date.now() - getBridgeRuleLastRunAt(rule.id) < cooldownMs) {
      entry.actions.push(`「${rule.name}」还在触发间隔内，这次只存档`);
      continue;
    }
    try {
      markBridgeRuleRun(rule.id);
      const text = await processText(rule, item);
      if (text !== item.payload) entry.processed = text.slice(0, 2000);
      const delay = Math.max(0, Number(rule.delayMinutes) || 0);
      if (delay > 0) {
        // 延迟执行：加工结果先存起来，到点直接用它，不再加工一次
        // （否则「AI 先处理」会在延迟前后各跑一遍模型，结果还可能不一样）。
        const task = enqueueDelayedTask({
          ruleId: rule.id,
          ruleName: rule.name,
          item,
          text,
          delayMinutes: delay,
        });
        if (task) {
          entry.actions.push(`${delay} 分钟后执行（已排队）`);
          continue;
        }
        entry.actions.push("延迟排队失败，已改为立刻执行");
      }
      entry.actions.push(...await runActions(rule, item, text));
    } catch (err) {
      entry.error = err instanceof Error ? err.message : String(err);
      console.warn("[现实桥] 规则执行失败", rule.name, err);
    }
  }
  // 「允许自定义APP订阅」总开关：不管有没有命中规则，每条数据都广播一次
  // （规则动作已广播过则不重复；加工文本取最后一次加工结果）
  if (loadBridgeSettings().broadcastToApps && !entry.actions.includes(BROADCAST_ACTION_NOTE)) {
    broadcastBridgeItemToApps(item, entry.processed ?? item.payload);
    entry.actions.push(BROADCAST_ACTION_NOTE);
  }
  if (rules.length === 0 && entry.actions.length === 0) entry.actions.push("仅存档（无匹配规则）");
  appendBridgeFeed(entry);
  return entry;
}

/**
 * 跑一遍到点的延迟任务。调度器每轮调用一次。
 *
 * 规则在排队后被删掉或停用时不再执行，但会记一条流水说明——
 * 静默丢掉会让用户以为「延迟功能坏了」，说清原因他才好排查。
 *
 * @returns 本次真正执行的任务数
 */
export async function runDueDelayedTasks(): Promise<number> {
  const tasks = loadDelayedTasks();
  if (tasks.length === 0) return 0;
  const now = Date.now();
  const due = tasks.filter(task => task.dueAt <= now);
  if (due.length === 0) return 0;
  // 先摘出来再执行：执行可能很慢（触发 LLM），期间不能让它们被重复判定
  saveDelayedTasks(tasks.filter(task => task.dueAt > now));

  let fired = 0;
  for (const task of due) {
    const rule = loadBridgeRules().find(item => item.id === task.ruleId);
    if (!rule || !rule.enabled) {
      appendBridgeFeed({
        id: task.id,
        type: task.item.type,
        payload: task.item.payload.slice(0, 2000),
        rules: [task.ruleName],
        actions: [rule ? "规则已停用，延迟任务取消" : "规则已删除，延迟任务取消"],
        receivedAt: new Date().toISOString(),
      });
      continue;
    }
    try {
      const actions = await runActions(rule, task.item, task.text);
      appendBridgeFeed({
        id: task.id,
        type: task.item.type,
        payload: task.item.payload.slice(0, 2000),
        processed: task.text !== task.item.payload ? task.text.slice(0, 2000) : undefined,
        rules: [rule.name],
        actions: actions.length > 0 ? actions : ["延迟执行"],
        receivedAt: new Date().toISOString(),
      });
      fired += 1;
    } catch (err) {
      appendBridgeFeed({
        id: task.id,
        type: task.item.type,
        payload: task.item.payload.slice(0, 2000),
        rules: [rule.name],
        actions: [],
        error: err instanceof Error ? err.message : String(err),
        receivedAt: new Date().toISOString(),
      });
      console.warn("[现实桥] 延迟任务执行失败", rule.name, err);
    }
  }
  return fired;
}

// ── 定时触发 ──

/**
 * 这条定时规则现在该不该跑。
 *
 * daily / weekly 的判定用「今天（本周）的那个时刻」当基准：
 * 过了点、且上次跑的时间早于这个基准，才算该跑。这样一天只会命中一次，
 * 而不是每轮轮询都触发一遍。App 关了几天再打开，最多补跑一次——
 * 补三次「早安」比漏掉更糟。
 */
function isScheduleDue(
  rule: BridgeRule,
  now: Date,
  lastRunAt: number,
): boolean {
  const schedule = rule.schedule;
  if (!schedule) return false;

  if (schedule.kind === "interval") {
    const minutes = Math.max(1, Math.min(10080, Number(schedule.minutes) || 0));
    return now.getTime() - lastRunAt >= minutes * 60_000;
  }

  const matched = /^(\d{1,2}):(\d{2})$/.exec(schedule.time || "");
  if (!matched) return false;
  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (hour > 23 || minute > 59) return false;

  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  if (schedule.kind === "weekly") {
    const weekday = Math.max(0, Math.min(6, Number(schedule.weekday) || 0));
    // 回退到本周对应的那一天（今天就是那天时 diff=0）
    target.setDate(target.getDate() - ((now.getDay() - weekday + 7) % 7));
  }
  if (now.getTime() < target.getTime()) return false;

  // 建好规则时今天这个点已经过了：不补触发，否则「下午建一条早八点的规则」
  // 会立刻蹦出来执行一次，看着像 bug。
  const createdAtMs = Date.parse(rule.createdAt) || 0;
  if (lastRunAt <= 0 && createdAtMs > target.getTime()) return false;

  return lastRunAt < target.getTime();
}

/**
 * 跑一遍所有到点的定时规则。调度器每轮轮询调一次。
 *
 * @returns 本次真正触发的规则数（调度器据此决定要不要刷新界面）
 */
export async function runDueScheduledRules(): Promise<number> {
  const rules = loadBridgeRules().filter(rule => rule.enabled && rule.schedule);
  if (rules.length === 0) return 0;

  let fired = 0;
  for (const rule of rules) {
    const now = new Date();
    if (!isScheduleDue(rule, now, getBridgeRuleLastRunAt(rule.id))) continue;

    // 造一个「凭空来的」信号：定时规则的动作里 {payload} 没有真实数据可填，
    // 用规则名当 payload，至少 WriteChat 写出来的内容是可读的。
    const item: BridgeItem = {
      id: `schedule_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      type: rule.name || "定时联动",
      payload: rule.name || "定时触发",
      createdAt: now.toISOString(),
    };

    // 先记运行时间：动作可能触发 LLM 生成（几十秒），期间不能让它被重复判定。
    markBridgeRuleRun(rule.id);
    try {
      const text = await processText(rule, item);
      const actions = await runActions(rule, item, text);
      appendBridgeFeed({
        id: item.id,
        type: item.type,
        payload: item.payload,
        processed: text !== item.payload ? text.slice(0, 2000) : undefined,
        rules: [rule.name],
        actions: actions.length > 0 ? actions : ["定时触发"],
        receivedAt: new Date().toISOString(),
      });
      fired += 1;
    } catch (err) {
      appendBridgeFeed({
        id: item.id,
        type: item.type,
        payload: item.payload,
        rules: [rule.name],
        actions: [],
        error: err instanceof Error ? err.message : String(err),
        receivedAt: new Date().toISOString(),
      });
      console.warn("[现实桥] 定时联动执行失败", rule.name, err);
    }
  }
  return fired;
}

/**
 * 试跑一条规则：立刻把它的「加工 → 动作」链路真的跑一遍，让用户在保存前
 * 就能看见会发生什么。
 *
 * 为什么不能直接复用 processBridgeItem：
 *   · 它按信号名从已保存的规则里挑，而向导里这条规则**还没保存**；
 *   · 它把定时规则整个排除在外（那些由 runDueScheduledRules 触发），
 *     于是「每天 8 点说早安」这种最常配的规则反而最没法验证。
 * 所以这里直接吃一条明确的规则对象 + 一份示例数据。
 *
 * 副作用是真的：动作照常执行（该写聊天就写、该弹通知就弹）——这正是「测试」
 * 的意义，用户要看到的就是真实效果。但**不写接收记录、不占用触发间隔**，
 * 免得测试数据把历史弄脏、或把冷却时间白白占掉。
 */
/** 试跑结果：除了「跑出了什么」，更要回答「这条规则到底会不会被触发」。 */
export type RuleTestOutcome = {
  /** 匹配这一关过了没有。false 时 processed / actions 都是空的。 */
  matched: boolean;
  /** 链路里发生过、但用户看不见的环节（过滤、间隔、延迟）的说明。 */
  notes: string[];
  processed: string;
  actions: string[];
  error?: string;
};

export async function testRunRule(
  rule: BridgeRule,
  sample: { type: string; payload: string },
): Promise<RuleTestOutcome> {
  const item: BridgeItem = {
    id: `test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: sample.type,
    payload: sample.payload,
    createdAt: new Date().toISOString(),
  };
  const notes: string[] = [];

  // ① 匹配：**这一步原来是漏掉的**，也正是「试跑像空跑」的原因。
  //    老实现无条件执行加工与动作，于是信号名填错、过滤词写偏，试跑照样跑得通，
  //    用户以为配好了；等真信号来了却一条都不触发——最坑的那种「配了没用」。
  //    试跑必须把这一关也走一遍，否则它验证的只是「动作能不能执行」，
  //    而不是「这条规则会不会被触发」，后者才是用户真正担心的。
  if (!rule.schedule) {
    const wanted = rule.matchType.trim();
    if (wanted && wanted !== "*" && wanted !== item.type) {
      return {
        matched: false,
        notes: [`信号名对不上：规则等的是「${wanted}」，你试的是「${item.type}」。真的收到「${wanted}」时才会触发。`],
        processed: "",
        actions: [],
      };
    }
    if (!matchesPayloadFilter(rule.payloadFilter, item.payload)) {
      return {
        matched: false,
        notes: [`正文过滤没通过：规则要求内容里含「${rule.payloadFilter}」，示例内容里没有。`],
        processed: "",
        actions: [],
      };
    }
  } else {
    notes.push("这是定时规则，不看信号名，到点自己跑。");
  }

  // ② 触发间隔：真实链路里间隔内的同信号只存档、不执行。
  //    但试跑**刻意不拦**——否则用户刚触发过一次就再也试不了，而他想看的只是
  //    「会执行什么」。这里只说一句，让他知道真实情况下可能被拦。
  const cooldown = Math.max(0, Number(rule.cooldownMinutes) || 0);
  if (cooldown > 0) {
    notes.push(`真实触发时，${cooldown} 分钟内重复的同一信号只会存档、不再执行；试跑不受这条限制。`);
  }

  // ③ 延迟执行：链路里会先排队、到点再跑。试跑不能真的等，所以立刻执行，
  //    同时把「本该延后多久」如实说出来——不然用户会以为延迟没生效。
  const delay = Math.max(0, Number(rule.delayMinutes) || 0);
  if (delay > 0) {
    notes.push(`真实触发时会先排队 ${delay} 分钟再执行；试跑是立刻跑的。`);
  }

  try {
    const text = await processText(rule, item);
    const actions = await runActions(rule, item, text);
    return { matched: true, notes, processed: text, actions };
  } catch (err) {
    return {
      matched: true,
      notes,
      processed: "",
      actions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
