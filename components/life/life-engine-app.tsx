"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { sendShellNotification } from "@/lib/shell-notify";
import { flushSync } from "react-dom";
import {
  ArrowLeft, CalendarDays, Coffee, Heart, MapPin, MessagesSquare, Eye,
  ChevronDown, Pause, Play, Plus, RefreshCw, Send, Settings2, Sparkles, Users, X, Pencil, Trash2, Upload, Wallpaper, Search,
} from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadCharacters } from "@/lib/character-storage";
import { hydrateKvDb } from "@/lib/kv-db";
import { addChatContact, createOrGetSession, hydrateChatStorage, loadChatContacts, loadChatMessages, loadChatSessions, resolveSessionCharacterId, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { generateOfflineChatCompletion } from "@/lib/chat-engine";
import { mergeImportedLifeLocations, parseImportedLifeLocations } from "@/lib/life/life-location-import";
import {
  createEmptyVirtualLifeState,
  DEFAULT_LIFE_ENGINE_SETTINGS,
  type LifeActorState,
  type LifeEngineSettings,
  type LifeLocation,
  type LifeOwnerType,
  type LifeSceneMessage,
  type LifeSceneImage,
  type LifeTimelineEntry,
  type LifeSceneParticipant,
  type LifeSceneState,
  type LifeScheduleSlot,
  type VirtualLifeState,
} from "@/lib/life/life-types";
import { applyCharacterLifeScheduleChange, confirmLifeInvitation, generateWeeklyLifePlan, getActorClock, getCurrentActorSchedule, insertManualLifeScheduleSlot, moveCharacterBySchedule, overlayScheduleSlotsOverFreeTime, syncScheduleLocationsToLibrary, makeLifeInvitation, placeAppointmentInActorSchedule, resolveActorLifeNow, settleActorTimelineToNow, synchronizeCharacterHomeSchedule, upsertActorState, upsertLifeScene } from "@/lib/life/life-runtime";
import { appendLifeTimelineEntry, loadVirtualLifeState, saveVirtualLifeState } from "@/lib/life/life-storage";
import { buildLifeScenePromptContext } from "@/lib/life/life-scene-prompt";
import { describeLifeOutputIssues, parseLifeOutput, validateLifeOutput, type LifeOutputIssue } from "@/lib/life/life-output";
import { buildLifeSceneResponderQueue, evaluateEncounterAwareness, findLifeSceneForLocation, mergeLifeSceneParticipants } from "@/lib/life/life-engine";
import { evaluateLifeAutonomyWindow, chooseLifeAutonomyCharacter, notifyLifeSceneMessage, LIFE_AUTONOMY_TICK_MS } from "@/lib/life/life-autonomy";
import { armLifeSceneProactiveBailout, cancelLifeSceneProactiveBailouts } from "@/lib/push-bailout-client";
import { setLifeSceneForegroundLease } from "@/lib/life/life-scheduler-coordinator";
import { clearActiveLifeSceneTurn, recoverPendingLifeSceneTurns, savePendingLifeSceneTurns, setActiveLifeSceneTurn, type PendingLifeSceneTurn } from "@/lib/life/life-scene-turn-queue";

import { beginTurn } from "@/lib/turn-coordinator";
import { loadBindingConfig, loadImageGenerationSettings, loadWorldBooks, resolveBinding, resolveUserIdentity, USER_IDENTITIES_UPDATED_EVENT } from "@/lib/settings-storage";
import type { BindingConfig, WorldBookConfig } from "@/lib/settings-types";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import "./life-rose-garden.css";
import { loadMediaObjectUrl, deleteMediaRef } from "@/lib/media-cache-storage";
import { downloadFile } from "@/lib/download-utils";
import { LifeObservation } from "@/components/life/life-observation";
import { LifeDiagnosticsPanel } from "@/components/life/life-diagnostics-panel";
import { createLifeTraceId, recordLifeDiagnostic } from "@/lib/life/life-diagnostics";
import { parseGuidedScheduleResponse } from "@/lib/life/life-guided-schedule";
import { acknowledgePendingLifeSceneReply, claimPendingLifeSceneReply, failPendingLifeSceneReply, peekPendingLifeSceneReply, renewPendingLifeSceneReply, retryPendingLifeSceneReply } from "@/lib/life/life-notification-queue";

type Tab = "home" | "scene" | "daily" | "people" | "plans" | "invitations" | "experiences" | "locations" | "observe" | "settings";
type ActorChoice = { ownerType: LifeOwnerType; ownerId: string; name: string; avatar?: string | null; persona?: string };
type QuickPlanDraft = { id: string; ownerType: LifeOwnerType; ownerId: string; startAt: string; endAt: string; title: string; locationName: string; saveLocationToLibrary?: boolean; operation?: "add" | "move" | "update" | "cancel"; existingScheduleId?: string; reason?: string; guided?: boolean };
type ManualLocationMode = "stay-30" | "stay-60" | "stay-120" | "pin" | "follow" | "manual";
const PLAYER_ID = "player";
const LIFE_PROACTIVE_MESSAGES_ENABLED = true; // 用户明确要求恢复主动消息；日程与场景保持原逻辑。
const DAY_MS = 24 * 60 * 60 * 1000;
const INITIAL_LOCATIONS: LifeLocation[] = [
  { id: "home", name: "家", description: "熟悉而放松的私人空间。日常起居、休息、吃饭，也可以在这里安静地陪伴彼此。", atmosphere: "温暖、私密、放松；随着时间和在场角色的状态自然变化。", layout: "入户门通向客厅；客厅有沙发和茶几，窗边有一处可以坐下的位置；厨房与卧室分别位于内侧。", props: ["沙发", "茶几", "抱枕", "窗帘", "水杯"], visibility: "private" },
  { id: "cafe", name: "街角咖啡店", description: "临街的咖啡店，适合偶遇、聊天、看书或短暂停留。", atmosphere: "咖啡香、轻柔的背景音乐、偶尔响起的杯碟声；忙碌程度随时段变化。", layout: "入口旁是点单柜台，靠窗有双人座，店内侧有几张小桌，后方通向洗手间。", props: ["菜单", "咖啡杯", "纸巾", "窗边座位", "手机"], visibility: "public" },
  { id: "park", name: "公园", description: "有步道、树荫和长椅的公共绿地，适合散步、运动或发呆。", atmosphere: "风声、树叶和远处的人声；天气、时段与在场者的活动会影响氛围。", layout: "入口连接环形步道；步道旁有长椅和树荫，中央有一片开阔草地。", props: ["长椅", "树荫", "步道", "草地", "饮料瓶"], visibility: "public" },
  { id: "library", name: "图书馆", description: "安静的阅读与学习空间，适合专注，也适合偶尔交换低声的几句话。", atmosphere: "安静、克制，只有翻页声、键盘声和轻微脚步声。", layout: "入口有借阅台，中央是书架，靠窗有单人桌，内侧有小组讨论区。", props: ["书籍", "书签", "台灯", "笔记本", "耳机"], visibility: "public" },
  { id: "school", name: "学校", description: "教室、图书馆与校园公共区域组成的学习空间。", atmosphere: "课间热闹、上课时安静，随时间段变化。", layout: "教学楼走廊连接教室与楼梯，校园道路通向图书馆和食堂。", props: ["课本", "笔记本", "书包", "校园卡"], visibility: "public" },
  { id: "work", name: "工作地点", description: "用于角色上班、处理事务或进行日常工作的地点。", atmosphere: "专注、规律，可能伴随交谈、键盘声或短暂休息。", layout: "入口连接公共区域，内部有工作桌、座位与休息区。", props: ["电脑", "文件", "水杯", "便签"], visibility: "public" },
  { id: "transit", name: "通勤途中", description: "连接不同地点的路程；角色可能步行、乘车或短暂停留。", atmosphere: "流动、短暂，周围声音和人流随路线变化。", layout: "以道路、站台或车厢为主，具体空间随出行方式变化。", props: ["手机", "耳机", "交通卡", "背包"], visibility: "public" },
  { id: "canteen", name: "食堂 / 附近餐馆", description: "用餐、休息和短暂交流的地方。", atmosphere: "餐食香气、人声与餐具声，饭点会更热闹。", layout: "入口附近有取餐或点单处，座位分布在用餐区。", props: ["餐盘", "筷子", "纸巾", "饮料"], visibility: "public" },
  { id: "studio", name: "音乐 / 创作空间", description: "适合练习乐器、写作、绘画或其他个人创作。", atmosphere: "专注、私密，可能有轻微音乐声或创作时的杂物声。", layout: "主要工作台靠近光源，乐器或材料收纳在一侧，留出活动空间。", props: ["耳机", "笔记本", "乐器 / 创作工具", "水杯"], visibility: "public" },
];
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
function createLifeChatSession(characterId: string, characterName: string): ChatSession {
  // Always bind life operations to a persisted direct-chat session. Resolve the
  // ChatContact.id separately from Character.id so downstream push jobs can map it.
  let contact = loadChatContacts().find(item => item.characterId === characterId);
  if (!contact) {
    addChatContact(characterId);
    contact = loadChatContacts().find(item => item.characterId === characterId);
  }
  const session = createOrGetSession(contact?.id || characterId);
  return session.alias === characterName ? session : { ...session, alias: characterName };
}

export type LifeScheduleGenerationResult = { ok: boolean; skipped?: boolean; characterName: string; message: string };

/** Prevents a manual batch and the background auto-renewal from generating the same state simultaneously. */
let scheduleGenerationInFlight = false;

/**
 * 角色七日 AI 日程生成（无 React 依赖）。
 *
 * 这里复用生活现场原有的角色卡 / 世界书 / 短期共同记忆 / 近期生活记录提示词组装，
 * 生成结果先完整校验、再原子写回；失败或并发冲突时不写入任何日程。
 * 生活页的手动生成与生活调度 tick 的自动续排共用这一个入口。
 */
export async function regenerateCharacterWeeklyScheduleWithAI(
  character: Character,
  options: { worldBooks?: WorldBookConfig[]; bindingConfig?: BindingConfig; onProgress?: (message: string) => void } = {},
): Promise<LifeScheduleGenerationResult> {
  const notify = options.onProgress ?? (() => undefined);
  if (scheduleGenerationInFlight) {
    return { ok: false, skipped: true, characterName: character.name, message: "已有角色的日程正在生成，本次跳过。" };
  }
  scheduleGenerationInFlight = true;
  notify("正在让 " + character.name + " 根据角色卡、短期共同记忆与生活记录规划未来七天……");
  try {
    let current = loadVirtualLifeState();
    const sharesPlayerHome = current.locations.some(location => location.id === "home" && (location.residents ?? []).includes(character.id));
    if (!current.locations.some(location => location.id === "home-" + character.id) && !sharesPlayerHome) {
      const personalHome: LifeLocation = {
        id: "home-" + character.id,
        name: character.name + "的家",
        description: "", atmosphere: "", layout: "", props: [], visibility: "private",
      };
      current = { ...current, locations: [...current.locations, personalHome] };
    }
    const realNow = resolveActorLifeNow(getActorClock(current, "character", character.id));
    // 从角色自己的“今天”开始向后规划七天，而不是再生成本周已过去的时间。
    const start = new Date(realNow.getTime()); start.setHours(0, 0, 0, 0);
    const realNowMs = realNow.getTime();
    const end = new Date(start.getTime()); end.setDate(end.getDate() + 7);
    const locations = current.locations.filter(location => {
      // The home-<characterId> ID is canonical even if older data has an empty residents list.
      if (!location.id.startsWith("home-")) return true;
      const ownerId = location.id.slice("home-".length);
      return !current.locations.some(shared => shared.id !== location.id
        && (shared.id === "home" || shared.id.startsWith("home-"))
        && (shared.id === "home" || (shared.residents ?? []).length > 1)
        && (shared.residents ?? []).includes(ownerId));
    }).slice(0, 36).map(p => "- " + p.name + "（locationId=" + p.id + "）" + ((p.aliases?.length ?? 0) ? "；别名：" + p.aliases!.join("、") : "") + (p.description ? "；环境：" + p.description.slice(0, 140) : "") + (p.atmosphere ? "；氛围：" + p.atmosphere.slice(0, 70) : "") + (p.layout ? "；布局：" + p.layout.slice(0, 90) : "") + (p.props?.length ? "；道具：" + p.props.slice(0, 5).join("、") : "") + (p.characterHabits?.[character.id] ? "；角色习惯：" + p.characterHabits[character.id] : "")).join("\n");
    // A character's residence is identity-bound. The player's home is shared only
    // when the location explicitly lists this character as a resident.
    const sharedResidence = current.locations.find(location =>
      (location.id === "home" || location.id.startsWith("home-"))
      && (location.residents ?? []).includes(character.id)
      && (location.id === "home" || (location.residents ?? []).length > 1));
    const livesWithPlayer = Boolean(sharedResidence);
    const characterHome = sharedResidence
      ?? current.locations.find(location => location.id === "home-" + character.id)
      ?? null;
    const memories = current.memories
      .filter(m => m.participants.includes(character.id) && m.participants.includes(PLAYER_ID))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 12)
      .reverse()
      .map(m => "- " + m.fact).join("\n") || "暂无共同记忆";
    const events = current.timeline
      .filter(t => t.actorId === character.id || t.actorName === character.name || (t.actorId === PLAYER_ID && t.category === "social"))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, 18)
      .reverse()
      .map(t => "- " + t.occurredAt + "｜" + t.title + (t.details ? "：" + t.details : "")).join("\n") || "暂无近期个人生活记录";
    const worldBooks = options.worldBooks ?? loadWorldBooks();
    const bindingConfig = options.bindingConfig ?? loadBindingConfig();
    const characterWorldBook = (() => {
      const chatBinding = resolveBinding(bindingConfig, character.id, "chat");
      const dwellingBinding = resolveBinding(bindingConfig, character.id, "dwelling");
      const ids = new Set([...(chatBinding.worldBookIds ?? []), ...(dwellingBinding.worldBookIds ?? [])]);
      return worldBooks.filter(book => ids.has(book.id)).flatMap(book =>
        book.entries.filter(entry => !entry.disable).map(entry => [entry.comment, entry.key, entry.content].filter(Boolean).join("："))
      ).slice(0, 30).join("\n").slice(0, 8000);
    })();
    const protectedSlots = current.schedules.filter(slot => {
      if (slot.ownerType !== "character" || slot.ownerId !== character.id || slot.startAt >= end.toISOString() || slot.endAt <= start.toISOString()) return false;
      // Free-time is always replaceable whitespace, even when a manual edit created it.
      if (slot.kind === "free-time") return false;
      // Preserve hand-edited, character-tool, confirmed and currently-running blocks.
      if (slot.source !== "weekly-generation") return true;
      return new Date(slot.startAt).getTime() <= realNowMs && new Date(slot.endAt).getTime() > realNowMs;
    });
    const fixed = protectedSlots.map(slot => "- " + slot.startAt + "—" + slot.endAt + "：" + slot.title + "（必须保留且不可冲突）").join("\n") || "无固定安排";
    const session = createLifeChatSession(character.id, character.name);
    const prompt: ChatMessage = {
      id: id("life-schedule-ai"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
      content: [
        "角色：" + character.name,
        "标签：" + (character.tags ?? []).join("、"),
        "住所事实：角色住所「" + (characterHome?.name ?? character.name + "的家") + "」（locationId=" + (characterHome?.id ?? "home-" + character.id) + "）；与用户同居：" + (livesWithPlayer ? "是，共同住所为「" + sharedResidence!.name + "」（locationId=" + sharedResidence!.id + "）" : "否") + "。",

        "世界书中与该角色相关的背景：\n" + (characterWorldBook || "暂无相关世界书条目"),
        "近期共同记忆：\n" + memories, "近期个人记录：\n" + events, "允许地点：\n" + locations, "固定安排：\n" + fixed,
        "规划日期范围：从 " + start.toLocaleDateString("sv-SE") + " 起连续七天；dayOffset 0 为第一天，6 为第七天。",
      ].join("\n\n")
    };
    const scheduleHistory = loadChatMessages(session.id).filter(message => message.status !== "failed" && !message.isRetracted);
    const result = await generateOfflineChatCompletion(session, [...scheduleHistory, prompt], { appId: "life", appTags: ["life", "schedule"], includeDirectChatEntries: false });
    const raw = result.content.trim();
    const first = raw.indexOf("["); const last = raw.lastIndexOf("]");
    if (first < 0 || last <= first) throw new Error("模型没有返回有效 JSON 数组。");
    const decoded: unknown = JSON.parse(raw.slice(first, last + 1));
    if (!Array.isArray(decoded)) throw new Error("日程结果不是数组。");
    const clean = (value: string) => value.toLocaleLowerCase().replace(/[\s\u3000·•\/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "");
    const kinds = new Set(["habit", "work", "study", "meal", "commute", "free-time", "appointment", "special"]);
    // Never fall back to the player's home for a character who does not live there.
    const home = sharedResidence
      ?? current.locations.find(p => p.id === "home-" + character.id)
      ?? current.locations.find(p => p.id === "home" && (p.residents ?? []).includes(character.id))
      ?? current.locations.find(p => p.id.startsWith("home-") && (p.residents ?? []).includes(character.id))
      ?? null;
    const normalizeLocation = (value: string) => clean(value.replace(/^(回到|回|在|去|前往)/, ""));
    const aiSlots: LifeScheduleSlot[] = [];
    const days = new Set<number>();
    for (const item of decoded as Array<Record<string, unknown>>) {
      const d = Number(item.dayOffset), title = String(item.title ?? "").trim().slice(0, 100);
      const sm = /^(\d{1,2}):(\d{2})$/.exec(String(item.start ?? "")), em = /^(\d{1,2}):(\d{2})$/.exec(String(item.end ?? ""));
      if (!Number.isInteger(d) || d < 0 || d > 6 || !title || !sm || !em) continue;
      const sh=Number(sm[1]), si=Number(sm[2]), eh=Number(em[1]), ei=Number(em[2]);
      if (sh>23 || eh>23 || si>59 || ei>59) continue;
      const a=new Date(start.getTime()); a.setDate(a.getDate()+d); a.setHours(sh,si,0,0);
      const b=new Date(start.getTime()); b.setDate(b.getDate()+d); b.setHours(eh,ei,0,0);
      if (b<=a || a<start || b>end || (d === 0 && a.getTime() < realNowMs)) continue;
      const rawPlace = String(item.location ?? "").trim();
      const placeKey = normalizeLocation(rawPlace);
      const homeIntent = !placeKey || /^(家|家里|住所|自己的家|回家|在家|居家|宿舍|寝室)$/.test(placeKey);
      // Match exact names/aliases only. Substring matching made “家” collide with
      // “用户家/某角色的家” and silently assigned unrelated residences.
      const exactPlace = current.locations.find(p =>
        [p.name, ...(p.aliases ?? [])].some(name => normalizeLocation(name) === placeKey));
      const place = homeIntent ? home : exactPlace ?? null;
      days.add(d);
      aiSlots.push({id:id("ai-slot"),ownerType:"character",ownerId:character.id,startAt:a.toISOString(),endAt:b.toISOString(),title,kind:kinds.has(String(item.kind))?String(item.kind) as LifeScheduleSlot["kind"]:"special",source:"weekly-generation",plannedLocationId:place?.id ?? null,plannedLocationName:place?.name ?? (homeIntent ? character.name + "的家" : rawPlace || "地点待定"),updatedAt:new Date().toISOString()});
    }
    if (aiSlots.length < 20 || days.size < 5) throw new Error("有效日程数量不足，无法覆盖整周；原日程未更改。");
    const overlaps=(a:LifeScheduleSlot,b:LifeScheduleSlot)=>new Date(a.startAt).getTime()<new Date(b.endAt).getTime()&&new Date(a.endAt).getTime()>new Date(b.startAt).getTime();
    const accepted:LifeScheduleSlot[]=[];
    for (const slot of aiSlots.sort((a,b)=>a.startAt.localeCompare(b.startAt))) if (!protectedSlots.some(p=>overlaps(p,slot))&&!accepted.some(p=>overlaps(p,slot))) accepted.push(slot);
    const generated:LifeScheduleSlot[]=[...protectedSlots.filter(slot => slot.source === "weekly-generation"), ...accepted];
    for (let d=0;d<7;d++) {
      const dayStart=new Date(start.getTime()); dayStart.setDate(dayStart.getDate()+d); dayStart.setHours(0,0,0,0);
      const dayEnd=new Date(dayStart.getTime()); dayEnd.setDate(dayEnd.getDate()+1);
      const daySlots=[...protectedSlots,...accepted].filter(p=>new Date(p.startAt)<dayEnd&&new Date(p.endAt)>dayStart).sort((a,b)=>a.startAt.localeCompare(b.startAt));
      // Today begins at the character's current real time, not midnight. Never fill
      // elapsed hours with retroactive "free time" after an AI regeneration.
      let cursor=Math.max(dayStart.getTime(), d===0 ? realNowMs : dayStart.getTime());
      const free=(a:number,b:number)=>{if(b-a<300000)return;generated.push({id:id("ai-free"),ownerType:"character",ownerId:character.id,startAt:new Date(a).toISOString(),endAt:new Date(b).toISOString(),title:"自由活动 / 休息（可按当天情况调整）",kind:"free-time",source:"weekly-generation",plannedLocationId:home?.id??null,plannedLocationName:home?.name??"家",updatedAt:new Date().toISOString()});};
      for(const slot of daySlots){const a=Math.max(cursor,dayStart.getTime(),new Date(slot.startAt).getTime()),b=Math.min(dayEnd.getTime(),new Date(slot.endAt).getTime());if(a>cursor)free(cursor,a);cursor=Math.max(cursor,b);if(cursor>=dayEnd.getTime())break;}
      if(cursor<dayEnd.getTime())free(cursor,dayEnd.getTime());
    }
    const latest=loadVirtualLifeState();
    const retained=latest.schedules.filter(slot=>!(slot.ownerType==="character"&&slot.ownerId===character.id&&slot.source==="weekly-generation"&&slot.startAt<end.toISOString()&&slot.endAt>start.toISOString()));
    const lateConflict = generated.find(candidate => candidate.kind !== "free-time" && retained.some(existing =>
      existing.ownerType === candidate.ownerType
      && existing.ownerId === candidate.ownerId
      && existing.kind !== "free-time"
      && new Date(existing.startAt) < new Date(candidate.endAt)
      && new Date(existing.endAt) > new Date(candidate.startAt)
    ));
    if (lateConflict) {
      const message = "生成期间该角色的手动日程或已确认安排发生了变化，已保留最新日程；请重新生成，避免覆盖新安排。";
      notify(message);
      recordLifeDiagnostic({ source: "AI 七日日程", event: "并发日程冲突", status: "warning", detail: "生成期间出现新安排：" + lateConflict.title, meta: { characterId: character.id } });
      return { ok: false, characterName: character.name, message };
    }
    saveVirtualLifeState(overlayScheduleSlotsOverFreeTime({ ...latest, schedules: retained }, generated));
    const message = "已根据"+character.name+"的角色卡、短期共同记忆和生活记录重生成 AI 日程；手动及已确认安排已保留。";
    notify(message);
    return { ok: true, characterName: character.name, message };
  } catch(error) {
    const message = "AI 日程生成失败："+(error instanceof Error?error.message:String(error))+"。原日程未被修改。";
    notify(message);
    return { ok: false, characterName: character.name, message };
  } finally { scheduleGenerationInFlight = false; }
}

const fmt = (value: Date | string) => new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(typeof value === "string" ? new Date(value) : value);
const fmtClock = (value: Date | string) => new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const toLocalDateTimeInput = (value: string) => { const d = new Date(value); if (!Number.isFinite(d.getTime())) return ""; const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); };
const fromLocalDateTimeInput = (value: string) => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : ""; };
const mondayStart = (date: Date) => { const d = new Date(date); d.setHours(0,0,0,0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };

function rebuildSceneDialogueTimeline(state: VirtualLifeState, sceneId: string, _batchSizeValue: number): VirtualLifeState {
  // The life timeline mirrors each original utterance; summarization belongs to scene.currentDescription,
  // never to a synthetic "N messages" record that obscures the live chat.
  const messages = state.sceneMessages
    .filter(message => message.sceneId === sceneId && message.role !== "system" && Boolean(message.dialogue?.trim()))
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const previous = state.timeline.filter(entry => entry.category === "dialogue" && entry.sceneId === sceneId);
  let next: VirtualLifeState = { ...state, timeline: state.timeline.filter(entry => !(entry.category === "dialogue" && entry.sceneId === sceneId)) };
  for (const message of messages) {
    const oldEntry = previous.find(entry => entry.sourceId === message.id);
    next = appendLifeTimelineEntry(next, {
      id: oldEntry?.id,
      category: "dialogue",
      occurredAt: message.createdAt,
      recordedAt: oldEntry?.recordedAt ?? message.createdAt,
      title: (message.speakerName || message.speakerId) + "说",
      details: message.dialogue.trim(),
      actorId: message.speakerId,
      actorName: message.speakerName,
      locationName: next.scenes.find(scene => scene.id === sceneId)?.locationName,
      sceneId,
      sourceId: message.id,
    });
  }
  return next;
}

function isLastCharacterTurnActionOnly(state: VirtualLifeState, sceneId: string, characterId: string): boolean {
  const messages = state.sceneMessages.filter(message => message.sceneId === sceneId && message.role === "character" && message.speakerId === characterId);
  const lastAt = messages[messages.length - 1]?.createdAt;
  if (!lastAt) return false;
  const lastTurn = messages.filter(message => message.createdAt === lastAt);
  return lastTurn.some(message => Boolean(message.action?.trim())) && !lastTurn.some(message => Boolean(message.dialogue?.trim()));
}

function preserveLifeDialogueSegments(values: string[]): string[] {
  // JSON dialogues[] already defines the intended bubble boundaries. Never split a
  // complete message again by punctuation, sentence length, or commas.
  return values.map(value => value.replace(/\r/g, "").trim()).filter(Boolean);
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (value: boolean) => void; label: string; hint?: string }) {
  return <div className="flex items-center justify-between gap-4 rounded-2xl border border-black/5 bg-white/70 px-4 py-3">
    <span className="min-w-0"><span className="block text-sm font-medium text-stone-800">{label}</span>{hint && <span className="mt-0.5 block text-xs leading-relaxed text-stone-500">{hint}</span>}</span>
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition focus:outline-none focus:ring-2 focus:ring-[#b88768]/40 ${checked ? "bg-[#b88768]" : "bg-stone-300"}`}><span aria-hidden className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? "left-[22px]" : "left-0.5"}`} /></button>
  </div>;
}

async function compressLifeBackground(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("请选择图片文件。");
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = sourceUrl;
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("图片读取失败，请换一张图片再试。"));
    });
    const maxSide = 1800;
    const ratio = Math.min(1, maxSide / Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth || image.width) * ratio));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || image.height) * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备无法处理这张图片。");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

function SectionTitle({ title, eyebrow, note }: { title: string; eyebrow?: string; note?: string }) {
  return <div className="mb-4">{eyebrow && <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#b88768]">{eyebrow}</p>}<h2 className="text-xl font-semibold tracking-tight text-stone-800">{title}</h2>{note && <p className="mt-1 text-xs leading-relaxed text-stone-500">{note}</p>}</div>;
}

export function LifeEngineApp({ onClose, initialCharacterId }: { onClose?: () => void; initialCharacterId?: string } = {}) {
  const closeApp = () => {
    if (onClose) { onClose(); return; }
    if (typeof window !== "undefined" && window.history.length > 1) window.history.back();
    else if (typeof window !== "undefined") window.location.assign("/");
  };
  const [state, setState] = useState<VirtualLifeState>(() => createEmptyVirtualLifeState());
  const stateRef = useRef(state);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [playerIdentity, setPlayerIdentity] = useState(() => resolveUserIdentity());
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("home");
  const [sceneView, setSceneView] = useState(false);
  const [locationDossierOpen, setLocationDossierOpen] = useState(false);
  const [sceneLocationSearch, setSceneLocationSearch] = useState("");
  const [libraryLocationSearch, setLibraryLocationSearch] = useState("");
  const [sceneLocationSearchOpen, setSceneLocationSearchOpen] = useState(false);
  const [libraryLocationSearchOpen, setLibraryLocationSearchOpen] = useState(false);
  const [sceneLocationFolderFilter, setSceneLocationFolderFilter] = useState("all");
  const [libraryLocationFolderFilter, setLibraryLocationFolderFilter] = useState("all");
  const [collapsedLocationFolders, setCollapsedLocationFolders] = useState<Record<string, boolean>>({});
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderDeleteConfirmId, setFolderDeleteConfirmId] = useState<string | null>(null);
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>([]);
  const [locationSelectionMode, setLocationSelectionMode] = useState(false);
  const [batchFolderId, setBatchFolderId] = useState("unfiled");
  const [locationStatsTick, setLocationStatsTick] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setLocationStatsTick(value => value + 1), 30_000); return () => window.clearInterval(timer); }, []);
  const [worldBooks, setWorldBooks] = useState<WorldBookConfig[]>([]);
  const [locationImportCharacterId, setLocationImportCharacterId] = useState("");
  const [locationImportWorldBookIds, setLocationImportWorldBookIds] = useState<string[]>([]);
  const [locationImportBusy, setLocationImportBusy] = useState(false);
  const [bindingConfig, setBindingConfig] = useState<BindingConfig>(() => loadBindingConfig());
  const [dailySubtab, setDailySubtab] = useState<"people" | "plans" | "observe">("people");
  const [experienceActorFilter, setExperienceActorFilter] = useState("all");
  const [experienceCategoryFilter, setExperienceCategoryFilter] = useState("all");
  const [experienceDateFilter, setExperienceDateFilter] = useState("");
  const [experienceGroupBy, setExperienceGroupBy] = useState<"date" | "character">("date");
  const [timelineImageBusyId, setTimelineImageBusyId] = useState("");
  const [timelineImageUrls, setTimelineImageUrls] = useState<Record<string, string>>({});
  const timelineImageObjectUrlsRef = useRef<Record<string, string>>({});
  const [selectedActorKey, setSelectedActorKey] = useState("player:player");
  const initialFocusAppliedRef = useRef<string | null>(null);
  const initialSceneLinkHandledRef = useRef(false);
  const [selectedCharacterIds, setSelectedCharacterIds] = useState<string[]>([]);
  const [selectedSpeakerId, setSelectedSpeakerId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("cafe");
  const [stayDurationMinutes, setStayDurationMinutes] = useState(120);
  const [newLocationName, setNewLocationName] = useState("");
  const [locationNameDraft, setLocationNameDraft] = useState("");
  const [locationSaveFeedback, setLocationSaveFeedback] = useState(false);
  const [locationDescriptionDraft, setLocationDescriptionDraft] = useState("");
  const [locationAtmosphereDraft, setLocationAtmosphereDraft] = useState("");
  const [locationLayoutDraft, setLocationLayoutDraft] = useState("");
  const [locationPropsDraft, setLocationPropsDraft] = useState("");
  const [backgroundUploadBusy, setBackgroundUploadBusy] = useState<"global" | "location" | null>(null);
  const [locationHabitDrafts, setLocationHabitDrafts] = useState<Record<string, string>>({});

  const [quickPlanText, setQuickPlanText] = useState("");
  const [quickPlanDrafts, setQuickPlanDrafts] = useState<QuickPlanDraft[]>([]);
  const [scheduleGuidanceText, setScheduleGuidanceText] = useState("");
  const [guidedScheduleBusy, setGuidedScheduleBusy] = useState(false);
  const [scheduleGuidanceActorKeys, setScheduleGuidanceActorKeys] = useState<string[]>(["player:player"]);
  const [playerActivity, setPlayerActivity] = useState("");
  const [sceneInput, setSceneInput] = useState("");
  const sceneChatScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingNotificationSceneReplyRef = useRef<NonNullable<ReturnType<typeof peekPendingLifeSceneReply>> | null>(null);
  const [sceneActionInput, setSceneActionInput] = useState("");
  const [messageActionTarget, setMessageActionTarget] = useState<LifeSceneMessage | null>(null);
  const [messageActionMode, setMessageActionMode] = useState<"menu" | "edit" | "delete-confirm">("menu");
  const [messageEditDraft, setMessageEditDraft] = useState("");
  const [messageEditActionDraft, setMessageEditActionDraft] = useState("");
  const longPressTimerRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [scheduleRegenerationOwnerId, setScheduleRegenerationOwnerId] = useState<string | null>(null);
  const [batchScheduleGenerating, setBatchScheduleGenerating] = useState(false);
  const [editingRoleScheduleId, setEditingRoleScheduleId] = useState<string | null>(null);
  const [saveCustomScheduleLocations, setSaveCustomScheduleLocations] = useState<Record<string, boolean>>({});
  const busyRef = useRef(false);
  const pendingSceneTurnsRef = useRef<PendingLifeSceneTurn[]>([]);
  const sceneTurnQueueRestoredRef = useRef(false);
  const sceneTurnDrainScheduledRef = useRef(false);
  const [pendingSceneQueueVersion, setPendingSceneQueueVersion] = useState(0);
  busyRef.current = busy;
  const [notice, setNotice] = useState("");
  const [, refreshNotificationReplyQueue] = useState(0);
  // 生活现场主动通知横幅（规格：头像 + 标签 + 地点 + 内容 + 回复行动/回复对话双入口）
  const [sceneToast, setSceneToast] = useState<{ kind: "action" | "dialogue"; characterId: string; characterName: string; avatar: string; location: string; body: string; sceneId: string; isTest?: boolean } | null>(null);
  const [toastReplyMode, setToastReplyMode] = useState<"hidden" | "action" | "dialogue">("hidden");
  const [toastReplyDraft, setToastReplyDraft] = useState("");
  const proactiveAttemptAtRef = useRef<Record<string, number>>({});
  const proactiveNextAtRef = useRef<Record<string, number>>({});
  const proactiveBusyRef = useRef(false);
  const proactiveLastSpeakerRef = useRef<Record<string, string>>({});
  const [inviteCharacterId, setInviteCharacterId] = useState("");
  const [inviteLocationId, setInviteLocationId] = useState("cafe");
  const [inviteActivity, setInviteActivity] = useState("一起喝杯咖啡");
  const [inviteReason, setInviteReason] = useState("");
  const [inviteAt, setInviteAt] = useState("");
  const [inviteAtEdited, setInviteAtEdited] = useState(false);
  const [editingInvitationId, setEditingInvitationId] = useState<string | null>(null);
  const [editInvitationDraft, setEditInvitationDraft] = useState({ activity: "", reason: "", proposedAt: "", locationId: "", durationMinutes: "60" });
  const inviteDefaultInitializedRef = useRef(false);
  const [sceneImageBusy, setSceneImageBusy] = useState(false);
  const [imageObjectUrls, setImageObjectUrls] = useState<Record<string,string>>({});
  const [imageViewerIndex, setImageViewerIndex] = useState(0);
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [imageParticipantIds, setImageParticipantIds] = useState<string[]>([]);
  const autoImageSceneRef = useRef<string | null>(null);
  const resolveLifeCharacterId = (rawId: string) => {
    if (characters.some(character => character.id === rawId)) return rawId;
    return loadChatContacts().find(contact => contact.id === rawId)?.characterId ?? "";
  };


  const openDaily = (subtab: "people" | "plans") => { setDailySubtab(subtab); setTab("daily"); };
  useEffect(() => {
    const refreshWorldBooks = () => setWorldBooks(loadWorldBooks());
    const refreshBindings = () => setBindingConfig(loadBindingConfig());
    refreshWorldBooks(); refreshBindings();
    window.addEventListener("settings-worldbooks-updated", refreshWorldBooks);
    window.addEventListener("settings-bindings-updated", refreshBindings);
    return () => { window.removeEventListener("settings-worldbooks-updated", refreshWorldBooks); window.removeEventListener("settings-bindings-updated", refreshBindings); };
  }, []);

  useEffect(() => {
    let alive = true;
    void hydrateKvDb().then(() => hydrateChatStorage()).catch(() => undefined).finally(() => {
      if (!alive) return;
      const loaded = loadVirtualLifeState();
      const legacyBubbleStyle = (loaded.bubbleStyleVersion ?? 0) < 1;
      const loadedBubblePadding = loaded.settings?.bubblePadding;
      let normalized: VirtualLifeState = {
        ...loaded,
        bubbleStyleVersion: 1,
        settings: {
          ...DEFAULT_LIFE_ENGINE_SETTINGS,
          ...loaded.settings,
          dialogueFontSize: loaded.settings?.dialogueFontSize === 15 ? 13 : loaded.settings?.dialogueFontSize ?? 13,
          bubblePadding: legacyBubbleStyle && (loadedBubblePadding === 3 || loadedBubblePadding === 4)
            ? DEFAULT_LIFE_ENGINE_SETTINGS.bubblePadding
            : loadedBubblePadding ?? DEFAULT_LIFE_ENGINE_SETTINGS.bubblePadding,
          sceneRecordBatchSize: Math.max(1, Math.min(100, Number(loaded.settings?.sceneRecordBatchSize) || 10)),
        },
        locations: [...INITIAL_LOCATIONS.filter(location => !loaded.locations.some(saved => saved.id === location.id)), ...loaded.locations.map(saved => { const defaults = INITIAL_LOCATIONS.find(location => location.id === saved.id); return defaults ? { ...defaults, ...saved, description: saved.description || defaults.description, atmosphere: saved.atmosphere || defaults.atmosphere, layout: saved.layout || defaults.layout, props: saved.props?.length ? saved.props : defaults.props } : saved; })],
      };
      if (legacyBubbleStyle) saveVirtualLifeState(normalized);
      // Run legacy action/dialogue parsing exactly once. Re-parsing already-normalized
      // dialogue on every app entry can reinterpret ordinary prose differently as the
      // parser evolves, making the same history appear to change between visits.
      if ((normalized.sceneMessageFormatVersion ?? 0) < 1) {
        const migratedMessages = normalized.sceneMessages.map(message => {
          if (message.role === "system" || !message.dialogue.trim() || message.action?.trim()) return message;
          const separated = parseLifeOutput(message.dialogue);
          if (!separated.action) return message;
          return { ...message, action: separated.action, dialogue: separated.dialogue };
        });
        normalized = { ...normalized, sceneMessages: migratedMessages, sceneMessageFormatVersion: 1 };
        saveVirtualLifeState(normalized);
      }
      // Backfill chat timeline cards for images already stored in the scene gallery.
      // Image bytes remain in the media store; the chat only keeps a stable image ID.
      const knownSceneImageIds = new Set(normalized.sceneMessages.map(message => message.imageId).filter((value): value is string => Boolean(value)));
      const legacySceneImageMessages = normalized.scenes.flatMap(scene => (scene.images ?? [])
        .filter(image => !knownSceneImageIds.has(image.id))
        .map(image => ({
          id: "scene-image-message-" + image.id,
          sceneId: scene.id,
          speakerType: "player" as const,
          speakerId: PLAYER_ID,
          speakerName: normalized.settings.playerDisplayName || "我",
          role: "system" as const,
          action: "场景图片",
          dialogue: "",
          imageId: image.id,
          createdAt: image.createdAt,
        })));
      if (legacySceneImageMessages.length) {
        normalized = {
          ...normalized,
          sceneMessages: [...normalized.sceneMessages, ...legacySceneImageMessages]
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        };
        saveVirtualLifeState(normalized);
      }
      // One-time migration: rebuild only auto-generated character schedule slots in the current/next two weeks.
      // This version incorporates bound world books, saved location habits, and canonical place matching.
      // User-authored and completed historical entries remain untouched.
      if ((normalized.scheduleProfileVersion ?? 0) < 3) {
        const realNow = Date.now();
        const rebuildUntil = realNow + 14 * DAY_MS;
        normalized = {
          ...normalized,
          scheduleProfileVersion: 3,
          schedules: normalized.schedules.filter(slot => !(
            slot.ownerType === "character" &&
            slot.source === "weekly-generation" &&
            new Date(slot.startAt).getTime() < rebuildUntil &&
            new Date(slot.endAt).getTime() > realNow
          )),
        };
        saveVirtualLifeState(normalized);
      }
      // One-time migration: remove only auto-generated future-week slots that caused
      // the schedule screen to look like a 14-day plan. Keep manual plans and history.
      if ((normalized.scheduleProfileVersion ?? 0) < 4) {
        const schedules = normalized.schedules.filter(slot => {
          if (slot.source !== "weekly-generation") return true;
          const startAt = new Date(slot.startAt).getTime();
          const endAt = new Date(slot.endAt).getTime();
          const actorNow = resolveActorLifeNow(getActorClock(normalized, slot.ownerType, slot.ownerId));
          const weekStart = mondayStart(actorNow);
          const weekEnd = new Date(weekStart);
          weekEnd.setDate(weekEnd.getDate() + 7);
          return !(Number.isFinite(startAt) && Number.isFinite(endAt) && endAt > actorNow.getTime() && startAt >= weekEnd.getTime());
        });
        normalized = { ...normalized, scheduleProfileVersion: 4, schedules };
        saveVirtualLifeState(normalized);
      }
      const restoredPlayer = normalized.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
      const previousPlayerRoom = normalized.scenes
        .filter(scene => (scene.status === "active" || scene.status === "paused")
          && scene.participants.some(participant => participant.ownerType === "player" && participant.ownerId === PLAYER_ID))
        .slice()
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      // The player's persisted actual location is authoritative. A schedule is only
      // a plan and must never select or rename a chat room during app restoration.
      const playerLocation = normalized.locations.find(location => location.id === restoredPlayer?.actualLocationId)
        ?? normalized.locations.find(location => location.id === previousPlayerRoom?.locationId)
        ?? normalized.locations.find(location => location.id === "home")
        ?? normalized.locations[0];
      if (playerLocation && normalized.settings.enabled) {
        const now = new Date().toISOString();
        const existingPlayerRoom = findLifeSceneForLocation(normalized.scenes, playerLocation.id, playerLocation.name);
        const playerParticipant: LifeSceneParticipant = {
          ownerType: "player",
          ownerId: PLAYER_ID,
          activity: restoredPlayer?.activity || "正在度过今天",
          awarenessByActorId: {},
        };
        const playerRoom: LifeSceneState = existingPlayerRoom
          ? {
              ...existingPlayerRoom,
              locationId: playerLocation.id,
              locationName: playerLocation.name,
              eventId: undefined,
              status: "active",
              updatedAt: now,
              participants: mergeLifeSceneParticipants(existingPlayerRoom.participants, [playerParticipant]),
            }
          : {
              id: id("scene"),
              locationId: playerLocation.id,
              locationName: playerLocation.name,
              startedAt: now,
              updatedAt: now,
              status: "active",
              participants: [playerParticipant],
              lastSettledEventIds: [],
            };
        normalized = upsertLifeScene(normalized, playerRoom);
        if (restoredPlayer?.actualLocationId !== playerLocation.id || restoredPlayer.actualLocationName !== playerLocation.name) {
          normalized = upsertActorState(normalized, {
            ownerType: "player",
            ownerId: PLAYER_ID,
            activity: restoredPlayer?.activity || "正在度过今天",
            actualLocationId: playerLocation.id,
            actualLocationName: playerLocation.name,
            actualLocationUntil: restoredPlayer?.actualLocationUntil ?? null,
            // Preserve the persisted source; legacy records without one keep their
            // previous 2-hour manual grace period instead of being moved on load.
            locationSource: restoredPlayer?.locationSource ?? (restoredPlayer?.actualLocationUntil ? "stay" : "manual"),
            manualSetAt: restoredPlayer?.manualSetAt ?? (restoredPlayer?.actualLocationUntil ? undefined : now),
            updatedAt: now,
          });
        }
        saveVirtualLifeState(normalized);
      }
      const savedLocationId = (() => { try { return window.localStorage.getItem("life:last-viewed-location") || ""; } catch { return ""; } })();
      const restoredLocationId = savedLocationId && normalized.locations.some(location => location.id === savedLocationId)
        ? savedLocationId
        : playerLocation?.id || normalized.locations[0]?.id || "home";
      setSelectedLocationId(restoredLocationId);
      stateRef.current = normalized;
      setState(normalized);
      setCharacters(loadCharacters());
      setPlayerIdentity(resolveUserIdentity());
      setReady(true);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!ready || !selectedLocationId || !state.locations.some(location => location.id === selectedLocationId)) return;
    try { window.localStorage.setItem("life:last-viewed-location", selectedLocationId); } catch { /* storage may be unavailable */ }
  }, [ready, selectedLocationId, state.locations]);

  const commit = useCallback((next: VirtualLifeState) => {
    stateRef.current = next;
    setState(next);
    saveVirtualLifeState(next);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncExternalLifeChanges = () => {
      // Chat, diary, moments and tool execution write timeline entries outside this component.
      // Reload without saving so the next UI action does not overwrite those entries.
      const latest = loadVirtualLifeState();
      stateRef.current = latest;
      setState(latest);
    };
    window.addEventListener("virtual-life-state-updated", syncExternalLifeChanges);
    return () => window.removeEventListener("virtual-life-state-updated", syncExternalLifeChanges);
  }, []);

  useEffect(() => {
    if (!ready || inviteDefaultInitializedRef.current || inviteAtEdited) return;
    const realNow = resolveActorLifeNow(getActorClock(state, "player", PLAYER_ID));
    const rounded = new Date(realNow.getTime() + 60 * 60_000);
    rounded.setMinutes(0, 0, 0);
    setInviteAt(new Date(rounded.getTime() - rounded.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
    inviteDefaultInitializedRef.current = true;
  }, [ready, inviteAtEdited]);

  const settings = state.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;

  useEffect(() => {
    const key = "life-scene-pending-banner-v1";
    const presentBanner = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const detail = value as { sceneId?: string; characterId?: string; characterName?: string; avatar?: string; locationName?: string; action?: string; dialogue?: string; createdAt?: string };
      const createdAtMs = Date.parse(detail.createdAt || "");
      if (!detail.sceneId || !detail.characterId || !Number.isFinite(createdAtMs) || Date.now() - createdAtMs > 120_000) return;
      if (settings.enableLifeMessageNotifications === false) return;
      const character = characters.find(item => item.id === detail.characterId);
      const body = [detail.action?.trim(), detail.dialogue?.trim()].filter(Boolean).join(" ");
      if (!body) return;
      setToastReplyMode("hidden");
      setToastReplyDraft("");
      setSceneToast({
        kind: detail.action?.trim() ? "action" : "dialogue",
        characterId: detail.characterId,
        characterName: detail.characterName || character?.name || "角色",
        avatar: detail.avatar || character?.avatar || "",
        location: detail.locationName || "生活现场",
        body,
        sceneId: detail.sceneId,
      });
      window.setTimeout(() => setSceneToast(current =>
        current && !current.isTest && current.sceneId === detail.sceneId && current.body === body ? null : current
      ), 6500);
    };
    const onOfflineLifeSceneMessage = (event: Event) => {
      try { localStorage.removeItem(key); } catch { /* ignore storage restrictions */ }
      presentBanner((event as CustomEvent).detail);
    };
    window.addEventListener("life-scene-proactive-message", onOfflineLifeSceneMessage);
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        localStorage.removeItem(key);
        presentBanner(JSON.parse(raw));
      }
    } catch { /* the persisted banner handoff is best-effort */ }
    return () => window.removeEventListener("life-scene-proactive-message", onOfflineLifeSceneMessage);
  }, [characters, settings.enableLifeMessageNotifications]);
  const activeMaxConsecutiveActionOnly = settings.maxConsecutiveActionOnly ?? 1;
  // 生活提示词全部来自预设条目（tags: life + 回合类型），APP 只声明本轮用哪组标签。
  const lifeAppTags = useCallback((mode: "scene" | "autonomy" | "schedule" | "invite") => {
    const tags = ["life"];
    if (mode === "scene" || mode === "autonomy") {
      tags.push("turn", mode);
      if (settings.enableCharacterAutonomy) tags.push("tools");
    } else {
      tags.push(mode);
    }
    return tags;
  }, [settings.enableCharacterAutonomy]);

  const generateValidatedLifeTurn = useCallback(async (input: {
    session: ChatSession;
    promptMessage: ChatMessage;
    signal?: AbortSignal;
    previousActionOnly: boolean;
    allowEmpty: boolean;
    appTags: string[];
  }): Promise<{ parsed: ReturnType<typeof parseLifeOutput>; issues: LifeOutputIssue[]; raw: string }> => {
    const requestOptions = {
      appId: "life",
      appTags: input.appTags,
      includeDirectChatEntries: false,
      signal: input.signal,
    };
    let raw = "";
    let parsed = parseLifeOutput("");
    let issues: LifeOutputIssue[] = [];
    let repaired = false;
    try {
      const onlineHistory = loadChatMessages(input.session.id).filter(message => message.status !== "failed" && !message.isRetracted);
      const requestHistory = [...onlineHistory, input.promptMessage];
      let result = await generateOfflineChatCompletion(input.session, requestHistory, requestOptions);
      raw = result.content;
      parsed = parseLifeOutput(raw);
      issues = validateLifeOutput(parsed, {
        previousActionOnly: input.previousActionOnly,
        maxConsecutiveActionOnly: activeMaxConsecutiveActionOnly,
        allowEmpty: input.allowEmpty,
      });
      if (issues.length > 0 && settings.enableLifeFormatRepair !== false && !input.signal?.aborted) {
        repaired = true;
        const repairPrompt: ChatMessage = {
          ...input.promptMessage,
          id: id("life-format-repair"),
          content: [
            input.promptMessage.content,
            "【格式修复】你上一轮输出不符合生活现场 JSON 协议。",
            "问题：" + describeLifeOutputIssues(issues),
            "上一轮原始输出：",
            raw.slice(0, 4000),
            "请只输出一个合法 JSON 对象，保持同一角色、同一场景、同一回合；这是格式修复，不是新回合。",
            "不要解释，不要输出 JSON 以外的文字；工具字段格式不合格时填 null，系统不会执行。",
          ].join("\n\n"),
        };
        result = await generateOfflineChatCompletion(input.session, [...onlineHistory, repairPrompt], requestOptions);
        raw = result.content;
        parsed = parseLifeOutput(raw);
        issues = validateLifeOutput(parsed, {
          previousActionOnly: input.previousActionOnly,
          maxConsecutiveActionOnly: activeMaxConsecutiveActionOnly,
          allowEmpty: input.allowEmpty,
        });
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      console.warn("[LifeScene] generation failed:", error);
      recordLifeDiagnostic({ source: "生活现场 AI", event: "角色回合生成失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { appTags: input.appTags } });
      throw error;
    }
    recordLifeDiagnostic({ source: "生活现场 AI", event: issues.length ? "输出格式仍有问题" : "角色回合生成完成", status: issues.length ? "warning" : "ok", detail: issues.length ? describeLifeOutputIssues(issues) : "模型输出已通过生活现场格式校验。", meta: { appTags: input.appTags, action: Boolean(parsed.action), dialogueCount: parsed.dialogues.length, repaired } });
    return { parsed, issues, raw };
  }, [activeMaxConsecutiveActionOnly, settings.enableLifeFormatRepair]);
  const sceneImagePrompt = settings.sceneImagePrompt;
  const playerName = settings.playerDisplayName || "我";
  useEffect(() => {
    const syncIdentity = () => setPlayerIdentity(resolveUserIdentity(selectedSpeakerId || undefined));
    syncIdentity();
    window.addEventListener(USER_IDENTITIES_UPDATED_EVENT, syncIdentity);
    return () => window.removeEventListener(USER_IDENTITIES_UPDATED_EVENT, syncIdentity);
  }, [selectedSpeakerId]);
  const getCharacterWorldBookContext = (characterId: string) => {
    const chatBinding = resolveBinding(bindingConfig, characterId, "chat");
    const dwellingBinding = resolveBinding(bindingConfig, characterId, "dwelling");
    const ids = new Set([...(chatBinding.worldBookIds ?? []), ...(dwellingBinding.worldBookIds ?? [])]);
    return worldBooks.filter(book => ids.has(book.id)).flatMap(book =>
      book.entries.filter(entry => !entry.disable).map(entry => [entry.comment, entry.key, entry.content].filter(Boolean).join("："))
    ).slice(0, 30).join("\n").slice(0, 8000);
  };
  const actors = useMemo<ActorChoice[]>(() => [
    { ownerType: "player", ownerId: PLAYER_ID, name: playerName, avatar: playerIdentity?.avatarUrl },
    ...characters.map(char => ({ ownerType: "character" as const, ownerId: char.id, name: char.name, avatar: char.avatar, persona: [char.persona, char.personality, ...(char.tags ?? []), getCharacterWorldBookContext(char.id), ...state.locations.map(location => location.characterHabits?.[char.id] ? `${location.name}地点习惯：${location.characterHabits[char.id]}` : "")].filter(Boolean).join("\n") })),
  ], [characters, playerName, playerIdentity?.avatarUrl, worldBooks, bindingConfig, state.locations]);
  const selectedActor = actors.find(actor => `${actor.ownerType}:${actor.ownerId}` === selectedActorKey) ?? actors[0];
  useEffect(() => {
    if (!initialCharacterId || initialFocusAppliedRef.current === initialCharacterId) return;
    if (!characters.some(character => character.id === initialCharacterId)) return;
    initialFocusAppliedRef.current = initialCharacterId;
    setSelectedActorKey("character:" + initialCharacterId);
    setTab("plans");
  }, [initialCharacterId, characters]);
  const activeScene = useMemo(() => findLifeSceneForLocation(state.scenes, selectedLocationId), [state.scenes, selectedLocationId]);
  const sceneMessages = useMemo(() => activeScene ? state.sceneMessages.filter(message => message.sceneId === activeScene.id) : [], [state.sceneMessages, activeScene]);
  const focusScene = useCallback((sceneId: string) => {
    const latest = stateRef.current;
    const target = latest.scenes.find(scene => scene.id === sceneId);
    if (!target) return false;
    const now = new Date().toISOString();
    const next = {
      ...latest,
      scenes: latest.scenes.map(scene => scene.id === sceneId
        ? { ...scene, status: "active" as const, updatedAt: now }
        : scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: now } : scene),
    };
    commit(next);
    setSelectedLocationId(target.locationId);
    setTab("home");
    setSceneView(true);
    return true;
  }, [commit]);

  useEffect(() => {
    if (!ready || initialSceneLinkHandledRef.current || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const sceneId = url.searchParams.get("sceneId");
    if (!sceneId) {
      initialSceneLinkHandledRef.current = true;
      return;
    }
    initialSceneLinkHandledRef.current = true;
    focusScene(sceneId);
    url.searchParams.delete("sceneId");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, [ready, focusScene]);

  // 每轮动作在生成阶段就保存为一条消息；这里不再合并多条动作记录。
  // 对白消息仍逐条显示，编辑/删除/重新生成均对应真实消息。
  const displaySceneMessages = sceneMessages;
  const selectedLocation = state.locations.find(location => location.id === selectedLocationId) ?? state.locations[0];
  useEffect(() => {
    if (!locationImportCharacterId && characters[0]) setLocationImportCharacterId(characters[0].id);
  }, [characters, locationImportCharacterId]);
  useEffect(() => {
    if (!locationImportCharacterId) return;
    const chat = resolveBinding(bindingConfig, locationImportCharacterId, "chat");
    const dwelling = resolveBinding(bindingConfig, locationImportCharacterId, "dwelling");
    setLocationImportWorldBookIds([...new Set([...(chat.worldBookIds ?? []), ...(dwelling.worldBookIds ?? [])])]);
  }, [locationImportCharacterId, bindingConfig]);
  const sceneBackgroundLocation = state.locations.find(location => location.id === activeScene?.locationId) ?? selectedLocation;
  const selectedLocationVisitStats = useMemo(() => {
    if (!selectedLocation) return { visits: 0, minutes: 0, activeMinutes: 0 };
    const realNow = resolveActorLifeNow(getActorClock(state, "player", PLAYER_ID));
    const locationEntries = state.timeline
      .filter(entry => entry.category === "location" && entry.actorId === PLAYER_ID && !!entry.locationName)
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const visits = locationEntries.filter(entry => entry.title.startsWith("你来到了"));
    let minutes = 0;
    let activeMinutes = 0;
    let count = 0;
    visits.forEach(entry => {
      if (entry.locationName !== selectedLocation.name) return;
      count += 1;
      const nextLocationEntry = locationEntries.find(next => next.occurredAt > entry.occurredAt);
      const isStillHere = state.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID)?.actualLocationId === selectedLocation.id && !nextLocationEntry;
      const endAt = nextLocationEntry ? new Date(nextLocationEntry.occurredAt) : isStillHere ? realNow : new Date(entry.occurredAt);
      const duration = Math.max(0, Math.floor((endAt.getTime() - new Date(entry.occurredAt).getTime()) / 60_000));
      minutes += duration;
      if (isStillHere) activeMinutes = duration;
    });
    return { visits: count, minutes, activeMinutes };
  }, [state.timeline, state.actorStates, selectedLocation, locationStatsTick]);
  // Keep the chat pinned to the latest message only when the reader was already at the bottom.
  const sceneChatAtBottomRef = useRef(true);
  const immersiveScene = !!activeScene && ((tab === "home" && sceneView) || tab === "scene");

  useEffect(() => {
    if (!immersiveScene) return;
    // Entering a different scene/view starts at its newest message; scrolling up afterwards is respected.
    sceneChatAtBottomRef.current = true;
    const scroller = sceneChatScrollRef.current;
    if (!scroller) return;
    requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "auto" }));
  }, [immersiveScene, activeScene?.id]);
  useEffect(() => {
    if (!immersiveScene || !sceneChatAtBottomRef.current) return;
    const scroller = sceneChatScrollRef.current;
    if (!scroller) return;
    requestAnimationFrame(() => scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" }));
  }, [immersiveScene, activeScene?.id, sceneMessages.length, busy]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    const syncViewport = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--life-viewport-height", `${Math.max(240, Math.round(height))}px`);
    };
    syncViewport();
    viewport?.addEventListener("resize", syncViewport);
    viewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);
    return () => {
      viewport?.removeEventListener("resize", syncViewport);
      viewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
    };
  }, [immersiveScene]);

  useEffect(() => {
    setLocationNameDraft(selectedLocation?.name ?? "");
    setLocationSaveFeedback(false);
    const legacyDescription = selectedLocation?.description ?? "";
    const legacyField = (name: string) => legacyDescription.match(new RegExp("(?:^|\\n)【" + name + "】\\s*\\n([\\s\\S]*?)(?=\\n\\n【|$)"))?.[1]?.trim() ?? "";
    const cleanDescription = legacyDescription.replace(/\n\n?【(?:氛围|空间布局|可用道具)】[\\s\\S]*$/,"").trim();
    setLocationDescriptionDraft(cleanDescription || legacyField("环境描写"));
    setLocationAtmosphereDraft(selectedLocation?.atmosphere || legacyField("氛围"));
    setLocationLayoutDraft(selectedLocation?.layout || legacyField("空间布局"));
    setLocationPropsDraft(selectedLocation?.props?.length ? selectedLocation.props.join("、") : legacyField("可用道具"));
    setLocationHabitDrafts(selectedLocation?.characterHabits ?? {});
  }, [selectedLocation?.id]);

  useEffect(() => {
    if (!activeScene || !selectedSpeakerId) return;
    if (!activeScene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === selectedSpeakerId)) setSelectedSpeakerId("");
  }, [activeScene?.id, activeScene?.participants, selectedSpeakerId]);



  useEffect(() => {
    if (!ready) return;
    let next = state;
    const owners = [
      { ownerType: "player" as const, ownerId: PLAYER_ID, name: playerName, profile: "" },
      ...characters.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality, ...(character.tags ?? []), getCharacterWorldBookContext(character.id), ...state.locations.map(location => location.characterHabits?.[character.id] ? `${location.name}地点习惯：${location.characterHabits[character.id]}` : "")].filter(Boolean).join(" ") })),
    ];
    for (const owner of owners) {
      const actorNow = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
      const thisMonday = mondayStart(actorNow);
      if (settings.autoGenerateWeeklyPlans) {
        next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, thisMonday, { id: "home", name: "家" }, [owner.profile].filter(Boolean).join(" "), settings.generateSpecialEvents);
        // Pre-build the following calendar week when the current week is within
        // two days of Sunday. It stays outside the current-week UI until rollover.
        const daysUntilWeekEnd = 6 - ((actorNow.getDay() + 6) % 7);
        if (daysUntilWeekEnd <= 2) {
          const nextMonday = new Date(thisMonday);
          nextMonday.setDate(nextMonday.getDate() + 7);
          next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, nextMonday, { id: "home", name: "家" }, [owner.profile].filter(Boolean).join(" "), settings.generateSpecialEvents);
        }
      }
    }
    if (next !== state) commit(next);
  }, [ready, settings.autoGenerateWeeklyPlans, settings.generateSpecialEvents, characters, playerName, state, worldBooks, bindingConfig, commit]);

  useEffect(() => {
    if (!ready) return;
    const settleAll = () => {
      let next = stateRef.current;
      const liveSettings = next.settings ?? DEFAULT_LIFE_ENGINE_SETTINGS;
      const roster = loadCharacters();
      const owners = [
        { ownerType: "player" as const, ownerId: PLAYER_ID, name: liveSettings.playerDisplayName || "我", profile: "" },
        ...roster.map(character => ({ ownerType: "character" as const, ownerId: character.id, name: character.name, profile: [character.persona, character.personality, ...(character.tags ?? []), getCharacterWorldBookContext(character.id), ...stateRef.current.locations.map(location => location.characterHabits?.[character.id] ? `${location.name}地点习惯：${location.characterHabits[character.id]}` : "")].filter(Boolean).join(" ") })),
      ];
      for (const owner of owners) {
        const realNow = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
        // Always inspect the current calendar week first. A future manual slot
        // must not prevent missing baseline days from being generated.
        const week = mondayStart(realNow);
        const targetEnd = new Date(week);
        // Keep the current week complete, then pre-generate the following week
        // when no more than two days remain before Sunday. The UI continues to show its
        // selected seven-day window; this is background coverage, not a 14-day view.
        if (liveSettings.autoGenerateWeeklyPlans) {
          next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, week, { id: "home", name: "家" }, [owner.profile].filter(Boolean).join(" "), liveSettings.generateSpecialEvents);
          const daysUntilWeekEnd = 6 - ((realNow.getDay() + 6) % 7);
          if (daysUntilWeekEnd <= 2) {
            const nextWeek = new Date(targetEnd);
            nextWeek.setDate(nextWeek.getDate() + 7);
            next = generateWeeklyLifePlan(next, owner.ownerType, owner.ownerId, owner.name, nextWeek, { id: "home", name: "家" }, [owner.profile].filter(Boolean).join(" "), liveSettings.generateSpecialEvents);
          }
        }
        const beforeSettle = next;
        const beforeActor = beforeSettle.actorStates.find(item => item.ownerType === owner.ownerType && item.ownerId === owner.ownerId);
        const beforeEventIds = new Set(beforeSettle.events.map(event => event.id));
        next = settleActorTimelineToNow(next, owner.ownerType, owner.ownerId);
        {
          const nowForOwner = resolveActorLifeNow(getActorClock(next, owner.ownerType, owner.ownerId));
          const recentCutoff = nowForOwner.getTime() - 24 * 60 * 60 * 1000;
          for (const event of next.events) {
            if (beforeEventIds.has(event.id) || event.kind !== "activity" || event.status !== "completed" || !event.settlementKey?.startsWith("schedule:")) continue;
            const ended = new Date(event.endsAt ?? event.createdAt).getTime();
            if (!Number.isFinite(ended) || ended < recentCutoff) continue;
            const startLabel = event.startsAt ? new Date(event.startsAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "开始时间未记录";
            const endLabel = event.endsAt ? new Date(event.endsAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "结束时间未记录";
            next = appendLifeTimelineEntry(next, { category: "schedule", occurredAt: event.endsAt ?? event.createdAt, title: owner.name + "结束了日程：" + event.title + "（结束：" + endLabel + "）", details: "计划时间：" + startLabel + "—" + endLabel + (event.locationName ? "；地点：" + event.locationName : ""), actorId: owner.ownerId, actorName: owner.name, locationName: event.locationName ?? undefined, sourceId: event.id });
          }
          const afterActor = next.actorStates.find(item => item.ownerType === owner.ownerType && item.ownerId === owner.ownerId);
          if (beforeActor && afterActor && (beforeActor.activity !== afterActor.activity || beforeActor.actualLocationId !== afterActor.actualLocationId)) {
            const changedAt = nowForOwner.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
            next = appendLifeTimelineEntry(next, { category: "schedule", occurredAt: nowForOwner.toISOString(), title: owner.name + "现在" + afterActor.activity + "（" + changedAt + "）", details: afterActor.actualLocationName ? "当前地点：" + afterActor.actualLocationName : undefined, actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName ?? undefined });
          }
          if (beforeActor && afterActor && beforeActor.actualLocationId !== afterActor.actualLocationId && afterActor.actualLocationName) {
            next = appendLifeTimelineEntry(next, {
              category: "location",
              title: owner.name + "来到了" + afterActor.actualLocationName,
              details: beforeActor.actualLocationName ? "从" + beforeActor.actualLocationName + "前往" + afterActor.actualLocationName : "实际地点发生变化",
              actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName,
            });
            if (owner.ownerType === "character") {
              const player = next.actorStates.find(item => item.ownerType === "player" && item.ownerId === PLAYER_ID);
              if (player?.actualLocationId) {
                const sharedRoom = findLifeSceneForLocation(next.scenes, player.actualLocationId, player.actualLocationName ?? undefined);
                const sharedScene = sharedRoom && (sharedRoom.status === "active" || sharedRoom.status === "paused") ? sharedRoom : undefined;
                if (beforeActor.actualLocationId === player.actualLocationId && afterActor.actualLocationId !== player.actualLocationId) {
                  next = appendLifeTimelineEntry(next, {
                    category: "scene", title: owner.name + "离开了你所在的场景",
                    details: "TA 前往了" + afterActor.actualLocationName,
                    actorId: owner.ownerId, actorName: owner.name, locationName: beforeActor.actualLocationName ?? undefined,
                    sceneId: sharedScene?.id,
                  });
                  if (sharedScene) {
                    next = upsertLifeScene(next, {
                      ...sharedScene,
                      participants: sharedScene.participants.filter(participant => !(participant.ownerType === "character" && participant.ownerId === owner.ownerId)),
                      updatedAt: new Date().toISOString(),
                    });
                  }
                } else if (beforeActor.actualLocationId !== player.actualLocationId && afterActor.actualLocationId === player.actualLocationId) {
                  next = appendLifeTimelineEntry(next, {
                    category: "scene", title: owner.name + "进入了你所在的场景",
                    details: "TA 现在也在" + afterActor.actualLocationName,
                    actorId: owner.ownerId, actorName: owner.name, locationName: afterActor.actualLocationName,
                    sceneId: sharedScene?.id,
                  });
                  if (sharedScene && !sharedScene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === owner.ownerId)) {
                    next = upsertLifeScene(next, {
                      ...sharedScene,
                      participants: [
                        ...sharedScene.participants.map(participant => participant.ownerType === "player"
                          ? { ...participant, awarenessByActorId: { ...participant.awarenessByActorId, [owner.ownerId]: "aware" as const } }
                          : participant),
                        { ownerType: "character", ownerId: owner.ownerId, activity: afterActor.activity, awarenessByActorId: { [PLAYER_ID]: "aware" } },
                      ],
                      updatedAt: new Date().toISOString(),
                    });
                  }
                }
              }
            }
          }
        }
      }
      // Update only the room belonging to the player's actual location. Never
      // repurpose the newest active/paused room: its ID owns an independent history.
      const currentPlayer = next.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
      const currentPlayerLocation = next.locations.find(location => location.id === currentPlayer?.actualLocationId);
      if (currentPlayerLocation && currentPlayer?.actualLocationId) {
        const playerRoom = findLifeSceneForLocation(next.scenes, currentPlayerLocation.id, currentPlayerLocation.name);
        const currentParticipant = playerRoom?.participants.find(participant => participant.ownerType === "player" && participant.ownerId === PLAYER_ID);
        const activity = currentPlayer.activity || currentParticipant?.activity || "正在度过今天";
        const roomNeedsUpdate = !playerRoom
          || playerRoom.status !== "active"
          || playerRoom.locationName !== currentPlayerLocation.name
          || Boolean(playerRoom.eventId)
          || !currentParticipant
          || currentParticipant.activity !== activity;
        if (roomNeedsUpdate) {
          const now = new Date().toISOString();
          const nextPlayerRoom: LifeSceneState = playerRoom
            ? {
                ...playerRoom,
                locationId: currentPlayerLocation.id,
                locationName: currentPlayerLocation.name,
                eventId: undefined,
                status: "active",
                updatedAt: now,
                participants: mergeLifeSceneParticipants(playerRoom.participants, [{
                  ownerType: "player",
                  ownerId: PLAYER_ID,
                  activity,
                  awarenessByActorId: currentParticipant?.awarenessByActorId ?? {},
                }]),
              }
            : {
                id: id("scene"),
                locationId: currentPlayerLocation.id,
                locationName: currentPlayerLocation.name,
                startedAt: now,
                updatedAt: now,
                status: "active",
                participants: [{
                  ownerType: "player",
                  ownerId: PLAYER_ID,
                  activity,
                  awarenessByActorId: {},
                }],
                lastSettledEventIds: [],
              };
          next = upsertLifeScene(next, nextPlayerRoom);
        }
      }
      if (next !== stateRef.current) commit(next);
    };
    settleAll();
    const timer = window.setInterval(settleAll, 30_000);
    window.addEventListener("focus", settleAll);
    window.addEventListener("life-force-sync", settleAll);
    const onVisibility = () => { if (document.visibilityState === "visible") settleAll(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", settleAll);
      window.removeEventListener("life-force-sync", settleAll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ready, commit, worldBooks, bindingConfig]);

  const syncAllCharactersToSchedules = useCallback(() => {
    let next = stateRef.current;
    const moved: string[] = [];
    for (const character of loadCharacters()) {
      const now = resolveActorLifeNow(getActorClock(next, "character", character.id));
      const slot = getCurrentActorSchedule(next, "character", character.id, now);
      const before = next.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id);
      // 角色不再保留手动地点或临时停留覆盖：统一按当前日程同步。没有当前日程时
      // 回落到角色住处（home-<id> 或 residents 含该角色的地点）。
      const residence = next.locations.find(location => location.id === "home-" + character.id)
        ?? next.locations.find(location => location.residents?.includes(character.id));
      const slotLocation = slot?.plannedLocationId
        ? {
            id: slot.plannedLocationId,
            name: slot.plannedLocationName
              ?? next.locations.find(location => location.id === slot.plannedLocationId)?.name
              ?? null,
          }
        : undefined;
      const targetLocationId = slotLocation?.id ?? residence?.id ?? null;
      const targetLocationName = slotLocation?.name ?? residence?.name ?? before?.actualLocationName ?? null;
      const targetActivity = slot?.title ?? before?.activity ?? "自由活动";
      if (!targetLocationId) continue;
      const targetSlotId = slot?.id ?? null;
      const alreadySynced = before?.actualLocationId === targetLocationId
        && (before?.actualLocationName ?? null) === (targetLocationName ?? null)
        && before?.activity === targetActivity
        && !before?.actualLocationUntil
        && before?.locationSource === "schedule"
        && !before?.manualSetAt
        && !before?.manualPinned
        && (before?.scheduleSlotId ?? null) === targetSlotId;
      if (alreadySynced) continue;
      next = upsertActorState(next, {
        ownerType: "character",
        ownerId: character.id,
        activity: targetActivity,
        scheduleSlotId: targetSlotId,
        actualLocationId: targetLocationId,
        actualLocationName: targetLocationName,
        actualLocationUntil: null,
        locationSource: "schedule",
        manualSetAt: undefined,
        manualPinned: undefined,
        updatedAt: new Date().toISOString(),
      });
      next = appendLifeTimelineEntry(next, {
        category: "location",
        title: character.name + "按日程来到" + (targetLocationName || "新的地点"),
        details: "计划时段：" + (slot ? new Date(slot.startAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + "—" + new Date(slot.endAt).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "无") + "；" + targetActivity,
        actorId: character.id,
        actorName: character.name,
        locationName: targetLocationName ?? undefined,
      });
      moved.push(character.name);
    }
    const player = next.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
    const playerLocationId = player?.actualLocationId;
    const active = playerLocationId
      ? findLifeSceneForLocation(next.scenes, playerLocationId, player?.actualLocationName ?? undefined)
      : undefined;
    if (active && playerLocationId && (active.status === "active" || active.status === "paused")) {
      const here = next.actorStates.filter(actor => actor.ownerType === "character" && actor.actualLocationId === playerLocationId);
      const participants = [
        ...active.participants.filter(participant => participant.ownerType === "player"),
        ...here.map(actor => ({
          ownerType: "character" as const,
          ownerId: actor.ownerId,
          activity: actor.activity,
          awarenessByActorId: { [PLAYER_ID]: "aware" as const },
        })),
      ];
      next = upsertLifeScene(next, { ...active, participants, updatedAt: new Date().toISOString() });
    }
    commit(next);
    setNotice(moved.length ? "已按当前日程同步 " + moved.length + " 位角色的位置与场景。" : "所有角色的实际位置已与当前日程一致。");
  }, [commit]);

  const armProactiveNow = useCallback(async () => {
    if (!settings.enabled || !settings.enableCharacterAutonomy || settings.enableProactiveSceneMessages === false) {
      setNotice("请先启用生活系统、角色自主行动和主动消息，再挂起后台主动任务。");
      return;
    }
    const player = stateRef.current.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
    const scene = player?.actualLocationId
      ? findLifeSceneForLocation(stateRef.current.scenes, player.actualLocationId, player.actualLocationName ?? undefined)
      : undefined;
    if (!scene || (scene.status !== "active" && scene.status !== "paused")) { setNotice("请先进入地点。"); return; }
    const candidateId = scene.participants.find(participant => participant.ownerType === "character")?.ownerId;
    const character = characters.find(item => item.id === candidateId) ?? characters[0];
    if (!character) { setNotice("暂无可用角色。"); return; }
    const session = createLifeChatSession(character.id, character.name);
    const result = await armLifeSceneProactiveBailout({
      sessionId: session.id,
      sceneId: scene.id,
      characterId: character.id,
      characterName: character.name,
      prompt: [
        "当前地点：" + scene.locationName,
        "角色：" + character.name,
        
      ].filter(Boolean).join("\n\n"),
      appId: "life",
      appTags: lifeAppTags("autonomy"),
      executeAtMs: Date.now() + 60_000,
      repeat: { intervalMs: 20 * 60_000, remaining: 3 },
      source: "manual",
    });
    recordLifeDiagnostic({ source: "主动调度", event: result.ok ? "手动主动任务已挂载" : "手动主动任务挂载失败", status: result.ok ? "ok" : "error", detail: result.ok ? "手动主动消息预约已提交。" : result.reason, meta: { sceneId: scene.id, characterId: character.id, sessionId: session.id } });
    setNotice(result.ok
      ? "已挂起一条主动消息；1 分钟后由服务端生成。可在「主动消息排期」查看。"
      : "挂起失败：" + result.reason);
  }, [characters, lifeAppTags, settings.enabled, settings.enableCharacterAutonomy, settings.enableProactiveSceneMessages]);

  const patchSettings = (patch: Partial<LifeEngineSettings>) => commit({ ...stateRef.current, settings: { ...stateRef.current.settings, ...patch } });
  const actorNow = (actor: ActorChoice) => resolveActorLifeNow(getActorClock(state, actor.ownerType, actor.ownerId));
  const actorState = (actor: ActorChoice) => state.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
  const actorSchedule = (actor: ActorChoice) => getCurrentActorSchedule(state, actor.ownerType, actor.ownerId, actorNow(actor));
  const regenerateActorScheduleWithAI = async (actor: ActorChoice): Promise<boolean> => {
    if (actor.ownerType !== "character" || scheduleRegenerationOwnerId) return false;
    const character = characters.find(item => item.id === actor.ownerId);
    if (!character) { setNotice("找不到角色档案，无法生成日程。"); return false; }
    setScheduleRegenerationOwnerId(actor.ownerId);
    try {
      const result = await regenerateCharacterWeeklyScheduleWithAI(character, {
        worldBooks,
        bindingConfig,
        onProgress: setNotice,
      });
      const latest = loadVirtualLifeState();
      stateRef.current = latest;
      setState(latest);
      setNotice(result.message);
      return result.ok;
    } finally { setScheduleRegenerationOwnerId(null); }
  };

  const regenerateAllCharacterSchedulesWithAI = async () => {
    if (batchScheduleGenerating || scheduleRegenerationOwnerId) return;
    const targets = actors.filter(actor => actor.ownerType === "character");
    if (!targets.length) { setNotice("目前没有可生成日程的角色。"); return; }
    setBatchScheduleGenerating(true);
    let successes = 0;
    const failed: string[] = [];
    try {
      // Avoid concurrent writes to the same life-state snapshot by generating sequentially.
      for (const actor of targets) {
        const ok = await regenerateActorScheduleWithAI(actor);
        if (ok) successes += 1;
        else failed.push(actor.name);
      }
      setNotice("AI 日程生成完成：成功 " + successes + "/" + targets.length + " 个角色。" +
        (failed.length ? " 未完成：" + failed.join("、") + "；请查看对应失败提示后重试。" : " 现在可以按需微调每个人的安排。"));
    } finally {
      setBatchScheduleGenerating(false);
    }
  };

  const generateGuidedScheduleDrafts = async () => {
    const traceId = createLifeTraceId("guided-schedule");
    const targets = actors.filter(actor => scheduleGuidanceActorKeys.includes(actor.ownerType + ":" + actor.ownerId));
    const instruction = scheduleGuidanceText.trim();
    if (!instruction) { setNotice("先写下你希望调整的日程要求。"); return; }
    if (!targets.length) { setNotice("至少选择一个安排对象。"); return; }
    if (guidedScheduleBusy || scheduleRegenerationOwnerId || batchScheduleGenerating) return;
    const modelCharacter = characters.find(item => targets.some(actor => actor.ownerType === "character" && actor.ownerId === item.id)) ?? characters[0];
    if (!modelCharacter) { setNotice("AI 日程指导需要至少一个已配置角色的聊天模型通道。"); return; }
    setGuidedScheduleBusy(true);
    recordLifeDiagnostic({
      source: "AI 日程指导", event: "开始生成", status: "info", traceId,
      detail: "已开始为选中对象生成七日日程候选；本次只生成预览，不直接修改现有日程。",
      meta: { traceId, actors: targets.map(actor => ({ ownerType: actor.ownerType, ownerId: actor.ownerId, name: actor.name })) },
    });
    try {
      const current = stateRef.current;
      const contexts = targets.map(actor => {
        const now = actorNow(actor), dayStart = new Date(now);
        dayStart.setHours(0,0,0,0);
        const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate()+7);
        const existing = current.schedules.filter(slot => slot.ownerType===actor.ownerType && slot.ownerId===actor.ownerId && new Date(slot.endAt)>now && new Date(slot.startAt)<dayEnd).sort((a,b)=>a.startAt.localeCompare(b.startAt));
        return { actor, now, dayStart, dayEnd, existing };
      });
      const scheduleText = contexts.map(context =>
        "【对象ID：" + context.actor.ownerId + "｜名称：" + context.actor.name + "｜类型：" + (context.actor.ownerType === "player" ? "player" : "character") + "｜当前现实时间：" + context.now.toISOString() + "】\n"
        + (context.existing.map(slot=>"- ID="+slot.id+"｜"+slot.startAt+" 至 "+slot.endAt+"｜"+slot.title+"｜"+(slot.plannedLocationName||"地点未定")+"｜source="+slot.source+"｜kind="+slot.kind).join("\n") || "暂无已安排日程")
      ).join("\n\n");
      const locations = current.locations.map(location=>"- "+location.name).join("\n");
      const session = createLifeChatSession(modelCharacter.id,modelCharacter.name);
      const prompt: ChatMessage = { id:id("life-guided-schedule"),sessionId:session.id,role:"user",status:"sent",createdAt:new Date().toISOString(),content:[
        "你是生活日程规划助手。用户选择的安排对象只有以下这些；可同时为多名对象安排，但绝不能安排未选中的对象。",
         "选中对象及其现有七日日程（必须依据 ID 决定保留或调整）：\n"+scheduleText,
        "用户指导：\n"+instruction,
        "可用地点：\n"+locations,
        "所有对象统一使用现实时间；dayOffset 0 为今天，6 为第七天。",
         "只输出 JSON，结构必须严格为：{\"schedules\":[{\"actorId\":\"必须原样填写上方对象ID\",\"actorType\":\"player 或 character\",\"actorName\":\"必须原样填写上方对象名称\",\"operation\":\"keep|move|update|add|cancel\",\"existingScheduleId\":\"旧日程ID或空字符串\",\"dayOffset\":0,\"start\":\"15:00\",\"end\":\"16:00\",\"title\":\"活动\",\"location\":\"地点或空字符串\",\"reason\":\"调整原因\"}]}。",
        "actorId 是唯一身份主键，必须逐字复制；actorType 必须与该 ID 对应的对象类型一致；actorName 是用于交叉校验的显示名称，不得替代 actorId。禁止输出未选中对象、禁止猜测 ID 或名称。",
         "请重新规划而不是只新增：每个旧日程可返回 keep（保留）、move/update（移动或修改，必须填写对应 existingScheduleId）或 cancel（取消，必须填写 ID）；新安排用 add。必须覆盖用户指导所涉及的时间范围。已开始/过去的日程、source=event 的已确认邀约或固定事件必须 keep，不得移动或取消；普通未来 weekly-generation/manual/character-tool 日程可按需要移动或更新。调整后同一对象所有时段不得重叠。每项给出简短 reason；取消操作不需要时间字段。不得遗漏仍需保留的固定日程。不要输出 Markdown 或 JSON 以外的文字。"
      ].join("\n\n")};
      const scheduleHistory=loadChatMessages(session.id).filter(message=>message.status!=="failed"&&!message.isRetracted);
      const result=await generateOfflineChatCompletion(session,[...scheduleHistory,prompt],{appId:"life",appTags:lifeAppTags("schedule"),includeDirectChatEntries:false});
      recordLifeDiagnostic({
        source: "AI 日程指导", event: "模型响应完成", status: "info", traceId,
        detail: "模型已返回结果，开始校验 actorId、actorType、actorName 和时间区间。",
        meta: { traceId, sessionId: session.id, modelCharacterId: modelCharacter.id, responseLength: result.content.length },
      });
      const parsed = parseGuidedScheduleResponse(result.content.trim(), contexts.map(context => ({
        ownerType: context.actor.ownerType,
        ownerId: context.actor.ownerId,
        name: context.actor.name,
        now: context.now,
        dayStart: context.dayStart,
        dayEnd: context.dayEnd,
        existing: context.existing,
      })));
      const drafts: QuickPlanDraft[] = parsed.drafts.map(draft => ({ ...draft, id: id("guided-plan"), guided: true }));
      recordLifeDiagnostic({
        source: "AI 日程指导", event: drafts.length ? "结果校验完成" : "结果校验未通过",
        status: drafts.length ? (parsed.rejected.length || parsed.conflicts.length ? "warning" : "ok") : "error",
        traceId,
        detail: "有效安排 " + drafts.length + " 条；时间冲突 " + parsed.conflicts.length + " 条；身份或格式拒绝 " + parsed.rejected.length + " 条。",
        meta: { traceId, accepted: drafts.length, conflicts: parsed.conflicts, rejected: parsed.rejected },
      });
      if (!drafts.length) {
        if (!parsed.conflicts.length && !parsed.rejected.length) {
          setNotice("AI 检查后认为现有日程已经符合这次要求，无需移动或新增；原日程保持不变。");
          recordLifeDiagnostic({ source: "AI 日程指导", event: "无需调整", status: "ok", traceId, detail: "模型判断当前目标时间窗内无需修改安排。", meta: { traceId } });
          return;
        }
        const reasons = [...parsed.conflicts, ...parsed.rejected].slice(0, 4).join("；");
        throw new Error(reasons || "没有识别到明确有效的时间安排。");
      }
      setQuickPlanDrafts(drafts);
      const count = new Set(drafts.map(draft => draft.ownerId)).size;
      setNotice("AI 为 " + count + " 位对象生成了 " + drafts.length + " 项待确认日程调整。" +
        (parsed.conflicts.length ? "另有 " + parsed.conflicts.length + " 条时间冲突。" : "") +
        (parsed.rejected.length ? "另有 " + parsed.rejected.length + " 条因身份或格式不匹配被拒绝。" : "") +
        "现有日程尚未修改，请检查新增、移动、修改和取消预览后再一次性确认。");
      recordLifeDiagnostic({
        source: "AI 日程指导", event: "候选日程已交付预览", status: "ok", traceId,
        detail: "候选安排已显示在待确认预览中；只有用户确认后才会写入正式日程。",
        meta: { traceId, actorIds: [...new Set(drafts.map(draft => draft.ownerId))], draftCount: drafts.length },
      });
    }catch(error){
      const detail = error instanceof Error ? error.message : String(error);
      setNotice("AI 日程指导失败："+detail+"。现有日程未修改。");
      recordLifeDiagnostic({
        source: "AI 日程指导", event: "生成或校验失败", status: "error", traceId,
        detail, meta: { traceId, selectedActorIds: targets.map(actor => actor.ownerId) },
      });
    } finally { setGuidedScheduleBusy(false); }
  };

  const confirmQuickPlanDrafts = () => {
    if (!quickPlanDrafts.length) return;
    const isGuidedReplan = quickPlanDrafts.some(draft => draft.guided || draft.operation === "move" || draft.operation === "update" || draft.operation === "cancel");
    if (!isGuidedReplan) {
      let next = stateRef.current;
      let saved = 0;
      const invalid: string[] = [];
      for (const draft of quickPlanDrafts) {
        const start = new Date(draft.startAt), end = new Date(draft.endAt);
        const owner = actors.find(actor => actor.ownerType === draft.ownerType && actor.ownerId === draft.ownerId);
        if (!owner || !draft.title.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) { invalid.push(draft.title || "未命名安排"); continue; }
        let location = draft.locationName.trim() ? next.locations.find(item => item.name.trim().toLocaleLowerCase() === draft.locationName.trim().toLocaleLowerCase()) : undefined;
        if (draft.locationName.trim() && !location && draft.saveLocationToLibrary) {
          location = { id: id("location"), name: draft.locationName.trim(), description: "从快速日程表单添加的地点", visibility: "public" };
          next = { ...next, locations: [...next.locations, location] };
        }
        const actual = next.actorStates.find(item => item.ownerType === draft.ownerType && item.ownerId === draft.ownerId);
        const slot: LifeScheduleSlot = { id: id("quick-plan"), ownerType: draft.ownerType, ownerId: draft.ownerId, startAt: start.toISOString(), endAt: end.toISOString(), title: draft.title.trim(), plannedLocationId: location?.id ?? actual?.actualLocationId ?? undefined, plannedLocationName: location?.name ?? (draft.locationName.trim() || actual?.actualLocationName || undefined), kind: /自由活动|自由时间|空闲|待安排/.test(draft.title.trim()) ? "free-time" : "special", source: "manual", updatedAt: new Date().toISOString() };
        const inserted = insertManualLifeScheduleSlot(next, slot);
        if (inserted.conflict) { invalid.push(draft.title.trim() + "（与「" + inserted.conflict.title + "」时间冲突）"); continue; }
        if (inserted.error) { invalid.push(draft.title.trim() + "（" + inserted.error + "）"); continue; }
        next = inserted.state;
        next = appendLifeTimelineEntry(next, { category: "schedule", title: owner.name + "新增日程：" + draft.title.trim(), details: fmt(start) + "–" + fmt(end) + (location ? " · " + location.name : ""), actorId: draft.ownerId, actorName: owner.name, locationName: location?.name });
        saved += 1;
      }
      if (saved) { commit(next); setQuickPlanDrafts([]); setQuickPlanText(""); setNotice("已保存 " + saved + " 条手动日程。"); }
      if (invalid.length) setNotice("有 " + invalid.length + " 条未保存：" + invalid.slice(0,3).join("；") + (invalid.length > 3 ? "；其余原因已省略。" : ""));
      return;
    }
    const base = stateRef.current;
    const now = new Date().toISOString();
    const removeIds = new Set<string>();
    const candidates: LifeScheduleSlot[] = [];
    const timelineItems: Array<{ draft: QuickPlanDraft; action: "新增" | "调整" | "取消"; slot?: LifeScheduleSlot }> = [];
    const invalid: string[] = [];
    const seenExistingIds = new Set<string>();
    let next = base;
    for (const draft of quickPlanDrafts) {
      const operation = draft.operation ?? "add";
      const owner = actors.find(actor => actor.ownerType === draft.ownerType && actor.ownerId === draft.ownerId);
      if (!owner) { invalid.push(draft.title || "未知安排对象"); continue; }
      const existing = operation === "add" ? undefined : base.schedules.find(slot => slot.id === draft.existingScheduleId && slot.ownerType === draft.ownerType && slot.ownerId === draft.ownerId);
      if (operation !== "add") {
        if (!existing || !draft.existingScheduleId || seenExistingIds.has(draft.existingScheduleId)) { invalid.push((draft.title || "日程") + "（旧日程 ID 不存在或重复）"); continue; }
        seenExistingIds.add(draft.existingScheduleId);
        const realNow = actorNow(owner);
        if (existing.source === "event" || (existing.source === "manual" && existing.kind !== "free-time") || existing.kind === "appointment"
          || new Date(existing.startAt) <= realNow || new Date(existing.endAt) <= realNow) {
          invalid.push(existing.title + "（已开始、已结束、用户手动安排或属于固定/已确认事件，不允许 AI 调整）");
          continue;
        }
        removeIds.add(existing.id);
        if (operation === "cancel") {
          // Persist the released interval as character-authored free time. If we
          // simply remove a generated slot, weekly generation would fill it again.
          candidates.push({
            id: id("guided-free-time"), ownerType: existing.ownerType, ownerId: existing.ownerId,
            startAt: existing.startAt, endAt: existing.endAt, title: "自由活动",
            kind: "free-time", source: "character-tool", updatedAt: now,
          });
          timelineItems.push({ draft, action: "取消" });
          continue;
        }
      }
      const start = new Date(draft.startAt), end = new Date(draft.endAt);
      if (!draft.title.trim() || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || start <= actorNow(owner)) { invalid.push(draft.title || "未命名安排"); continue; }
      let location = draft.locationName.trim() ? next.locations.find(item => item.name.trim().toLocaleLowerCase() === draft.locationName.trim().toLocaleLowerCase()) : undefined;
      if (draft.locationName.trim() && !location && draft.saveLocationToLibrary) {
        location = { id: id("location"), name: draft.locationName.trim(), description: "从 AI 日程指导预览添加的地点", visibility: "public" };
        next = { ...next, locations: [...next.locations, location] };
      }
      const actual = next.actorStates.find(item => item.ownerType === draft.ownerType && item.ownerId === draft.ownerId);
      const slot: LifeScheduleSlot = existing
        ? { ...existing, startAt: start.toISOString(), endAt: end.toISOString(), title: draft.title.trim(), plannedLocationId: location?.id ?? (draft.locationName.trim() ? undefined : existing.plannedLocationId ?? actual?.actualLocationId ?? undefined), plannedLocationName: location?.name ?? (draft.locationName.trim() || existing.plannedLocationName || actual?.actualLocationName || undefined), plannedLocationDeleted: draft.locationName.trim() ? false : existing.plannedLocationDeleted, updatedAt: now }
        : { id: id("guided-plan"), ownerType: draft.ownerType, ownerId: draft.ownerId, startAt: start.toISOString(), endAt: end.toISOString(), title: draft.title.trim(), plannedLocationId: location?.id ?? actual?.actualLocationId ?? undefined, plannedLocationName: location?.name ?? (draft.locationName.trim() || actual?.actualLocationName || undefined), kind: /自由活动|自由时间|空闲|待安排/.test(draft.title.trim()) ? "free-time" : "special", source: "manual", updatedAt: now };
      candidates.push(slot);
      timelineItems.push({ draft, action: existing ? "调整" : "新增", slot });
    }
    if (invalid.length) { setNotice("本次日程调整未保存（原日程保持不变）：" + invalid.slice(0,4).join("；")); recordLifeDiagnostic({ source: "AI 日程指导", event: "确认前校验失败", status: "error", detail: invalid.join("；"), meta: { draftCount: quickPlanDrafts.length } }); return; }
    const baseWithoutRemoved = { ...base, schedules: base.schedules.filter(slot => !removeIds.has(slot.id)) };
    const inProgressConflict = candidates.find(candidate => baseWithoutRemoved.schedules.some(existing => {
      if (existing.ownerType !== candidate.ownerType || existing.ownerId !== candidate.ownerId) return false;
      const existingStart = new Date(existing.startAt).getTime();
      const existingEnd = new Date(existing.endAt).getTime();
      const candidateStart = new Date(candidate.startAt).getTime();
      const candidateEnd = new Date(candidate.endAt).getTime();
      return existingStart <= Date.now() && existingEnd > Date.now()
        && existingStart < candidateEnd && existingEnd > candidateStart;
    }));
    if (inProgressConflict) {
      setNotice("本次日程调整未保存：不能修改已经开始的当前活动。");
      recordLifeDiagnostic({ source: "AI 日程指导", event: "当前活动保护", status: "error", detail: inProgressConflict.title, meta: { draftCount: quickPlanDrafts.length } });
      return;
    }
    const combined = overlayScheduleSlotsOverFreeTime(baseWithoutRemoved, candidates).schedules;
    for (let i = 0; i < combined.length; i += 1) for (let j = i + 1; j < combined.length; j += 1) {
      const a = combined[i], b = combined[j];
      if (a.ownerType === b.ownerType && a.ownerId === b.ownerId && new Date(a.startAt) < new Date(b.endAt) && new Date(a.endAt) > new Date(b.startAt)) invalid.push(a.title + " 与 " + b.title + " 时间重叠");
    }
    if (invalid.length) { setNotice("本次日程调整未保存（原日程保持不变）：" + invalid.slice(0,4).join("；")); recordLifeDiagnostic({ source: "AI 日程指导", event: "原子提交冲突", status: "error", detail: invalid.join("；"), meta: { draftCount: quickPlanDrafts.length } }); return; }
    next = { ...next, schedules: combined.sort((a,b) => a.startAt.localeCompare(b.startAt)) };
    for (const item of timelineItems) {
      const owner = actors.find(actor => actor.ownerType === item.draft.ownerType && actor.ownerId === item.draft.ownerId);
      next = appendLifeTimelineEntry(next, { category: "schedule", title: (owner?.name ?? "角色") + (item.action === "新增" ? "新增日程：" : item.action === "调整" ? "调整日程：" : "取消日程：") + (item.slot?.title ?? item.draft.title), details: item.slot ? fmt(item.slot.startAt) + "–" + fmt(item.slot.endAt) + (item.slot.plannedLocationName ? " · " + item.slot.plannedLocationName : "") + (item.draft.reason ? " · " + item.draft.reason : "") : (item.draft.reason || "AI 重新规划"), actorId: item.draft.ownerId, actorName: owner?.name, locationName: item.slot?.plannedLocationName ?? undefined });
    }
    commit(next); setQuickPlanDrafts([]); setQuickPlanText("");
    setNotice("已原子保存 " + timelineItems.length + " 项日程调整；固定、已确认和已开始事件未被修改。");
    recordLifeDiagnostic({ source: "AI 日程指导", event: "日程调整原子提交成功", status: "ok", detail: "新增、移动、修改、取消操作已一次性提交。", meta: { operations: timelineItems.map(item => ({ operation: item.action, scheduleId: item.slot?.id ?? item.draft.existingScheduleId })) } });
  };

  const ensurePlans = () => {
    let next = state;
    const playerRealNow = resolveActorLifeNow(getActorClock(next, "player", PLAYER_ID));
    next = generateWeeklyLifePlan(next, "player", PLAYER_ID, playerName, mondayStart(playerRealNow), { id: "home", name: "家" });
    for (const character of characters) {
      const characterRealNow = resolveActorLifeNow(getActorClock(next, "character", character.id));
      next = generateWeeklyLifePlan(next, "character", character.id, character.name, mondayStart(characterRealNow), { id: "home-" + character.id, name: character.name + "的家" }, [character.persona, character.personality, ...(character.tags ?? [])].filter(Boolean).join(" "), settings.generateSpecialEvents);
    }
    if (next === state) setNotice("本周计划已经存在，没有重新生成或覆盖你的修改。");
    else { commit(next); setNotice("已按现实时间生成可编辑的七日日程。"); }
  };

  /** 手动改地点入口：stay-* 限时停留，pin 一直停留，follow 立即跟随日程。 */
  const applyActorLocationMode = (actor: ActorChoice, locationId: string, mode: ManualLocationMode = "manual") => {
    // Read and update the latest persisted-in-memory snapshot so a rapid location
    // change cannot overwrite another life action committed since this render.
    const currentState = stateRef.current;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const current = currentState.actorStates.find(item => item.ownerType === actor.ownerType && item.ownerId === actor.ownerId);
    if (actor.ownerType === "character") {
      // 角色不再写 manual 覆盖：停留 / 固定停留 / 跟随都改写日程，让计划地点与实际地点一致。
      if (mode === "follow") {
        const result = moveCharacterBySchedule(currentState, { characterId: actor.ownerId, locationId, locationName: "", mode: "follow", now: nowDate });
        if (result.error) { setNotice(result.error); return; }
        const restored = result.state.actorStates.find(item => item.ownerType === "character" && item.ownerId === actor.ownerId);
        const restoredName = restored?.actualLocationName ?? "";
        const next = appendLifeTimelineEntry(result.state, { category: "location", title: "恢复跟随日程：" + restoredName, details: "结束手动停留，重新按行程行动。", actorId: actor.ownerId, actorName: actor.name, locationName: restoredName });
        commit(next);
        if (typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
        setNotice("已恢复跟随日程。");
        return;
      }
      const location = currentState.locations.find(item => item.id === locationId);
      if (!location) return;
      const stayMinutes = mode === "stay-30" ? 30 : mode === "stay-60" ? 60 : mode === "stay-120" ? 120 : 0;
      const pinned = mode === "pin";
      const timedStay = stayMinutes > 0;
      const result = moveCharacterBySchedule(currentState, {
        characterId: actor.ownerId,
        locationId: location.id,
        locationName: location.name,
        // 「手动地点」在角色身上等价于 2 小时停留：位置只通过日程表达。
        mode: mode === "manual" ? "stay-120" : mode,
        now: nowDate,
      });
      if (result.error) { setNotice(result.error); return; }
      let next = appendLifeTimelineEntry(result.state, {
        category: "location",
        title: actor.name + "来到了" + location.name,
        details: (current?.actualLocationName ? "从" + current.actualLocationName + "前往" + location.name : "首次记录实际地点") + " · " + (pinned ? "一直停留，直到手动改回" : timedStay ? "停留 " + stayMinutes + " 分钟后恢复日程" : "手动改地点"),
        actorId: actor.ownerId, actorName: actor.name, locationName: location.name,
      });
      const player = next.actorStates.find(item => item.ownerType === "player" && item.ownerId === PLAYER_ID);
      const sharedRoom = player?.actualLocationId
        ? findLifeSceneForLocation(next.scenes, player.actualLocationId, player.actualLocationName ?? undefined)
        : undefined;
      const scene = sharedRoom && (sharedRoom.status === "active" || sharedRoom.status === "paused") ? sharedRoom : undefined;
      if (scene && current?.actualLocationId === player?.actualLocationId && location.id !== player?.actualLocationId
        && scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === actor.ownerId)) {
        next = appendLifeTimelineEntry(next, { category: "scene", title: actor.name + "离开了你所在的场景", details: "TA 前往了" + location.name, actorId: actor.ownerId, actorName: actor.name, locationName: scene.locationName, sceneId: scene.id });
        next = upsertLifeScene(next, { ...scene, participants: scene.participants.filter(participant => !(participant.ownerType === "character" && participant.ownerId === actor.ownerId)), updatedAt: new Date().toISOString() });
      } else if (scene && location.id === player?.actualLocationId
        && !scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === actor.ownerId)) {
        next = appendLifeTimelineEntry(next, { category: "scene", title: actor.name + "进入了你所在的场景", details: "TA 现在也在" + location.name, actorId: actor.ownerId, actorName: actor.name, locationName: location.name, sceneId: scene.id });
        next = upsertLifeScene(next, { ...scene, participants: [
          ...scene.participants.map(participant => participant.ownerType === "player" ? { ...participant, awarenessByActorId: { ...participant.awarenessByActorId, [actor.ownerId]: "aware" as const } } : participant),
          { ownerType: "character", ownerId: actor.ownerId, activity: current?.activity || "正在这里活动", awarenessByActorId: { [PLAYER_ID]: "aware" } },
        ], updatedAt: new Date().toISOString() });
      }
      commit(next);
      setNotice(`${actor.name}的实际地点已更新为「${location.name}」。这与日程中的计划地点分开保存。`);
      return;
    }
    if (mode === "follow") {
      const slot = getCurrentActorSchedule(currentState, actor.ownerType, actor.ownerId, nowDate);
      const fallback = currentState.locations.find(item => item.id === "home") ?? currentState.locations.find(item => item.residents?.includes(actor.ownerId));
      const location = currentState.locations.find(item => item.id === slot?.plannedLocationId)
        ?? fallback
        ?? (current?.actualLocationId ? currentState.locations.find(item => item.id === current.actualLocationId) : undefined);
      if (!location) { setNotice("找不到可恢复的日程地点。"); return; }
      let next = upsertActorState(currentState, {
        ownerType: actor.ownerType, ownerId: actor.ownerId,
        activity: slot?.title || current?.activity || "自由活动",
        scheduleSlotId: slot?.id ?? null,
        actualLocationId: location.id, actualLocationName: location.name,
        actualLocationUntil: null, locationSource: "schedule", manualSetAt: undefined, manualPinned: undefined,
        updatedAt: now,
      });
      next = appendLifeTimelineEntry(next, { category: "location", title: "恢复跟随日程：" + location.name, details: "结束手动停留，重新按行程行动。", actorId: actor.ownerId, actorName: actor.name, locationName: location.name });
      commit(next);
      if (typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
      setNotice("已恢复跟随日程。");
      return;
    }
    const location = currentState.locations.find(item => item.id === locationId);
    if (!location) return;
    const stayMinutes = mode === "stay-30" ? 30 : mode === "stay-60" ? 60 : mode === "stay-120" ? 120 : 0;
    const pinned = mode === "pin";
    const timedStay = stayMinutes > 0;
    const until = timedStay ? new Date(nowDate.getTime() + stayMinutes * 60_000).toISOString() : null;
    let next = upsertActorState(currentState, {
      ownerType: actor.ownerType, ownerId: actor.ownerId,
      activity: current?.activity || "正在这里活动",
      actualLocationId: location.id, actualLocationName: location.name,
      actualLocationUntil: until,
      locationSource: pinned ? "manual" : timedStay ? "stay" : "manual",
      manualSetAt: pinned || !timedStay ? now : undefined,
      manualPinned: pinned ? true : undefined,
      updatedAt: now,
    });
    next = appendLifeTimelineEntry(next, {
      category: "location",
      title: actor.name + "来到了" + location.name,
      details: (current?.actualLocationName ? "从" + current.actualLocationName + "前往" + location.name : "首次记录实际地点") + " · " + (pinned ? "一直停留，直到手动改回" : timedStay ? "停留 " + stayMinutes + " 分钟后恢复日程" : "手动改地点"),
      actorId: actor.ownerId, actorName: actor.name, locationName: location.name,
    });
    commit(next);
    setNotice(`${actor.name}的实际地点已更新为「${location.name}」。这与日程中的计划地点分开保存。`);
  };

  /** 兼容原有手动入口：不带停留方式时按 2 小时手动地点处理。 */
  const updateActorLocation = (actor: ActorChoice, locationId: string) => {
    applyActorLocationMode(actor, locationId, "manual");
  };

  const transitionSceneAction = (action: () => void) => {
    if (typeof document === "undefined" || (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false)) {
      action();
      return;
    }
    const viewTransitionDocument = document as Document & {
      startViewTransition?: (callback: () => void) => { finished?: Promise<void> };
    };
    if (typeof viewTransitionDocument.startViewTransition !== "function") {
      action();
      return;
    }
    let actionStarted = false;
    const runOnce = () => {
      if (actionStarted) return;
      actionStarted = true;
      flushSync(action);
    };
    try {
      viewTransitionDocument.startViewTransition(runOnce);
    } catch {
      if (!actionStarted) action();
    }
  };

  /**
   * 地点卡片与「前往地点」按钮共用的唯一入口：前往目标地点并进入现场。
   * 勾选的角色会与你同行，但同行不再写“手动覆盖实际地点”，而是改写 TA 的日程：
   * 插入一条 companion-follow-* 的安排（计划地点 = 目的地），让计划地点
   * 与实际地点一致；有约会或固定事件的角色留在原地。
   * 每个地点保持唯一且稳定的聊天室身份，原地点的聊天记录留在原地；
   * 目的地原有在场角色与本次同行角色合并。
   */
  const performTransferSceneWithCompanions = (targetLocationId = selectedLocationId) => {
    const destination = stateRef.current.locations.find(location => location.id === targetLocationId);
    if (!settings.enabled) { setNotice("请先启用生活系统。"); return; }
    if (!destination) return;
    const nowDate = new Date();
    const now = nowDate.toISOString();
    const requestedEndMs = nowDate.getTime() + stayDurationMinutes * 60_000;
    const companions = characters.filter(char => selectedCharacterIds.includes(char.id));
    const oldLocationName = playerPresence?.actualLocationName;
    const notTravelling: string[] = [];
    let next = stateRef.current;
    for (const character of companions) {
      const activeSlot = getCurrentActorSchedule(next, "character", character.id, nowDate);
      // 约会/固定事件是角色的既有承诺，同行不能覆盖它。
      if (activeSlot?.kind === "appointment" || activeSlot?.source === "event") {
        notTravelling.push(character.name + "有约会，未同行。");
        continue;
      }
      const activeEndMs = activeSlot ? new Date(activeSlot.endAt).getTime() : Number.NaN;
      const endMs = Math.min(requestedEndMs, Number.isFinite(activeEndMs) ? activeEndMs : requestedEndMs);
      const companionSlot: LifeScheduleSlot = {
        id: id("companion-follow"),
        ownerType: "character",
        ownerId: character.id,
        startAt: now,
        endAt: new Date(endMs).toISOString(),
        title: "与我同行：" + destination.name,
        plannedLocationId: destination.id,
        plannedLocationName: destination.name,
        kind: "special",
        source: "manual",
        updatedAt: now,
      };
      // 上一次“与我同行”是系统自己写的安排：再次同行时先把它收束到此刻，
      // 否则会被当成外来冲突而永远无法连续出行。真正的约会/手动日程仍会跳过。
      const insertBase = activeSlot?.id.startsWith("companion-follow-")
        ? {
            ...next,
            schedules: next.schedules.flatMap(slot => {
              if (slot.id !== activeSlot.id) return [slot];
              return new Date(slot.startAt).getTime() < nowDate.getTime() ? [{ ...slot, endAt: now, updatedAt: now }] : [];
            }),
          }
        : next;
      const inserted = insertManualLifeScheduleSlot(insertBase, companionSlot);
      if (inserted.conflict) { notTravelling.push(character.name + "的日程与「" + inserted.conflict.title + "」冲突，未同行。"); continue; }
      if (inserted.error) { notTravelling.push(character.name + "的日程无法调整（" + inserted.error + "），未同行。"); continue; }
      // 日程即计划地点：合并写入实际地点，保留 scheduleSlotId；不再留下手动覆盖标记。
      next = upsertActorState(inserted.state, {
        ownerType: "character",
        ownerId: character.id,
        activity: companionSlot.title,
        actualLocationId: destination.id,
        actualLocationName: destination.name,
        actualLocationUntil: companionSlot.endAt,
        locationSource: "schedule",
        manualSetAt: undefined,
        manualPinned: undefined,
        updatedAt: now,
      });
    }
    // Important: persist companion schedules before the arrival flow reads the latest state.
    if (next !== stateRef.current) commit(next);
    performEnterLocationSolo(targetLocationId);
    // solo 流程内部已 commit；这里只补一条展示用的时间线（离开/到达），不写角色记忆。
    const latest = stateRef.current;
    if (oldLocationName && oldLocationName !== destination.name) {
      const logged = appendLifeTimelineEntry(latest, { category: "location", title: playerName + (companions.length ? "带着" + companions.map(char => char.name).join("、") : "") + "从" + oldLocationName + "前往" + destination.name, details: "离开" + oldLocationName + "；到达" + destination.name, actorId: PLAYER_ID, actorName: playerName, locationName: destination.name });
      commit(logged);
    }
    if (notTravelling.length) setNotice("已进入" + destination.name + "。" + notTravelling.join(""));
  };
  const transferSceneWithCompanions = (targetLocationId = selectedLocationId) => transitionSceneAction(() => performTransferSceneWithCompanions(targetLocationId));

  /** Arrival uses actual-location state only; planned locations never create encounters. */
  const performEnterLocationSolo = (targetLocationId = selectedLocationId) => {
    const destination = stateRef.current.locations.find(location => location.id === targetLocationId);
    if (!settings.enabled) { setNotice("请先启用生活系统。"); return; }
    if (!destination) return;
    const now = new Date().toISOString();
    // Use the latest committed state: a companion-transfer commit may not have rendered yet.
    const arrivalState = stateRef.current;
    // 进入现场以“实际地点”为准：所有 actualLocationId 指向该地点的角色都应在场。
    // 是否容易注意到（awareness）仍由性格/环境决定，但“偶遇开关”和上一次点击的
    // 异步 state 不再决定谁被排除，避免外面显示 N 人、点进去只剩 1 人。
    const actualCharacters = characters.filter(char =>
      arrivalState.actorStates.some(actor => actor.ownerType === "character" && actor.ownerId === char.id && actor.actualLocationId === destination.id)
    );
    const participants: LifeSceneParticipant[] = [{
      ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "刚来到这里", awarenessByActorId: {},
    }];
    for (const char of actualCharacters) {
      const actor = arrivalState.actorStates.find(item => item.ownerType === "character" && item.ownerId === char.id);
      if (!actor) continue;
      const perception = {
        distance: "medium" as const,
        lineOfSight: destination.visibility === "public",
        audible: true,
        attention: /专注|工作|学习|读书|写作|打电话/.test(actor.activity) ? "focused" as const : /发呆|等待|休息/.test(actor.activity) ? "distracted" as const : "normal" as const,
        activity: /等待|休息|发呆/.test(actor.activity) ? "waiting" as const : /工作|学习|读书|写作/.test(actor.activity) ? "busy" as const : "casual" as const,
        noticing: /外向|敏锐|警觉|好奇|观察力/.test(char.personality || "") ? 0.68 : 0.38,
        environmentNoise: /咖啡|车站|商场/.test(destination.name) ? 0.62 : 0.25,
      };
      const seed = [...char.id].reduce((sum, value) => sum + value.charCodeAt(0), 0);
      const awareness = evaluateEncounterAwareness(perception, seed);
      participants.push({ ownerType: "character", ownerId: char.id, activity: actor.activity, awarenessByActorId: { player: awareness } });
      participants[0].awarenessByActorId[char.id] = destination.visibility === "public" ? "aware" : "suspects";
    }
    const existingScene = findLifeSceneForLocation(stateRef.current.scenes, destination.id);
    // Startup may create a placeholder active scene before the user actually enters it. Record the first real entry if this scene has no entry card/timeline record yet.
    const hasRecordedEntry = !!existingScene && (
      stateRef.current.sceneMessages.some(message => message.sceneId === existingScene.id && message.role === "system" && /你来到了|你回到了/.test(message.action || message.dialogue || "")) ||
      stateRef.current.timeline.some(entry => entry.sceneId === existingScene.id && entry.category === "location" && entry.title.startsWith("你来到了"))
    );
    const shouldRecordSceneEntry = !existingScene || existingScene.status !== "active" || !hasRecordedEntry;
    const isFirstSceneEntry = !existingScene || !hasRecordedEntry;
    let next: VirtualLifeState = { ...stateRef.current, scenes: stateRef.current.scenes.map(scene => (scene.status === "active" || scene.status === "paused") ? { ...scene, status: "paused" as const, updatedAt: now } : scene) };
    // A location has one durable room. Re-entering it must retain the people
    // already in that room, then add characters who are physically arriving now.
    // Do not carry participants from the room we are leaving.
    const retainedDestinationParticipants = (existingScene?.participants ?? []).filter(participant => {
      if (participant.ownerType !== "character") return false;
      const actor = stateRef.current.actorStates.find(item => item.ownerType === "character" && item.ownerId === participant.ownerId);
      // Preserve legacy participants with no actor snapshot; otherwise only retain
      // people whose actual location still points at this destination.
      return !actor || actor.actualLocationId === destination.id;
    });
    const destinationParticipants = mergeLifeSceneParticipants(
      retainedDestinationParticipants,
      [{ ...participants[0], activity: playerActivity || "正在这里活动" }, ...participants.slice(1)],
    );
    const scene: LifeSceneState = existingScene
      ? { ...existingScene, locationId: destination.id, locationName: destination.name, eventId: undefined, updatedAt: now, status: "active", participants: destinationParticipants }
      : { id: id("scene"), locationId: destination.id, locationName: destination.name, startedAt: now, updatedAt: now, status: "active", participants: destinationParticipants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, scene);
    next = upsertActorState(next, { ownerType: "player", ownerId: PLAYER_ID, activity: playerActivity || "正在这里活动", actualLocationId: destination.id, actualLocationName: destination.name, actualLocationUntil: new Date(resolveActorLifeNow(getActorClock(stateRef.current, "player", PLAYER_ID)).getTime() + stayDurationMinutes * 60_000).toISOString(), locationSource: "stay", manualSetAt: undefined, updatedAt: now });
    if (shouldRecordSceneEntry) {
      const entryText = isFirstSceneEntry
        ? "你来到了" + destination.name + "。场景从这里开始。"
        : "你回到了" + destination.name + "。先前的场景与互动仍在继续。";
      next = appendLifeTimelineEntry(next, { category: "scene", title: isFirstSceneEntry ? "你进入了" + destination.name : "你回到了" + destination.name, details: entryText, actorId: PLAYER_ID, actorName: "场景旁白", locationName: destination.name, sceneId: scene.id });
      const entryNarration: LifeSceneMessage = { id: id("turn"), sceneId: scene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: "场景旁白", role: "system", action: entryText, dialogue: "", createdAt: now };
      next = { ...next, sceneMessages: [...next.sceneMessages, entryNarration] };
      next = appendLifeTimelineEntry(next, { category: "location", title: "你来到了" + destination.name, details: [playerActivity || "开始探索这个地点", `预计停留 ${stayDurationMinutes} 分钟；到期后自动恢复当前日程地点。`].join(" · "), actorId: PLAYER_ID, actorName: playerName, locationName: destination.name, sceneId: scene.id });
      if (isFirstSceneEntry && actualCharacters.length) next = appendLifeTimelineEntry(next, { category: "scene", title: "在" + destination.name + "遇见了" + actualCharacters.map(char=>char.name).join("、"), actorName: playerName, locationName: destination.name, sceneId: scene.id });
    }
    commit(next);
    if (!actualCharacters.length) {
      setNotice(settings.enableCoincidences ? "你来到了" + destination.name + "。再次打开当前场景不会重复添加记录；点击「暂时离开」后返回才会添加返回旁白。" : "你来到了" + destination.name + "。偶遇功能当前关闭，你可以独自探索这个地点。");
    } else {
      const noticed = participants.filter(p => p.ownerType === "character" && p.awarenessByActorId.player === "aware").length;
      setNotice(noticed ? "你来到了" + destination.name + "，有角色注意到了你。" : "你来到了" + destination.name + "；有人在场，但暂时没人明确注意到你。");
    }
    setSelectedLocationId(destination.id);
    setSelectedCharacterIds(destinationParticipants.filter(participant => participant.ownerType === "character").map(participant => participant.ownerId));
    setTab("home");
    setSceneView(true);
  };

  const autoImageFingerprint = activeScene
    ? [activeScene.id, activeScene.locationId, ...activeScene.participants.map(participant => participant.ownerType + ":" + participant.ownerId + ":" + participant.activity)].join("|")
    : "";
  useEffect(() => {
    const maybeGenerate = () => {
      if (!ready || !activeScene || !settings.autoGenerateSceneImages || !autoImageFingerprint || activeScene.lastAutoImageFingerprint === autoImageFingerprint || autoImageSceneRef.current === autoImageFingerprint) return;
      if (!loadImageGenerationSettings().enabled) {
        setNotice("已开启自动生图，请配置生图服务。");
        return;
      }
      autoImageSceneRef.current = autoImageFingerprint;
      void generateSceneImages({count:settings.sceneImageCount,autoFingerprint:autoImageFingerprint});
    };
    maybeGenerate();
    window.addEventListener("settings-image-generation-updated", maybeGenerate);
    return () => window.removeEventListener("settings-image-generation-updated", maybeGenerate);
  }, [ready, autoImageFingerprint, settings.autoGenerateSceneImages, settings.sceneImageCount]);

  const [sceneDescriptionBusy, setSceneDescriptionBusy] = useState(false);
  const summarizeCurrentScene = async () => {
    if (!activeScene || sceneDescriptionBusy) return;
    const scene = activeScene;
    const current = stateRef.current;
    const messages = current.sceneMessages
      .filter(message => message.sceneId === scene.id && message.role !== "system")
      .slice(-80)
      .map(message => [message.createdAt, message.speakerName, message.action ? "行动：" + message.action : "", message.dialogue ? "对白：" + message.dialogue : ""].filter(Boolean).join(" · "));
    if (!messages.length) { setNotice("当前现场还没有可供整理的原始对话。"); return; }
    const character = characters.find(item => scene.participants.some(p => p.ownerType === "character" && p.ownerId === item.id));
    if (!character) { setNotice("请先让至少一位角色进入现场，再生成现场描述。"); return; }
    const contact = loadChatContacts().find(item => item.characterId === character.id || item.id === character.id);
    const session = contact ? createOrGetSession(contact.id) : createLifeChatSession(character.id, character.name);
    setSceneDescriptionBusy(true);
    setNotice("AI 正在根据现场原始记录整理当前现场描述……");
    try {
      const location = current.locations.find(item => item.id === scene.locationId);
      const prompt: ChatMessage = {
        id: id("life-scene-description"),
        sessionId: session.id,
        role: "user",
        status: "sent",
        createdAt: new Date().toISOString(),
        content: [
          "你是生活现场连续性整理器。请根据下面的真实场景资料，更新一段用于后续图像生成的【当前现场描述】。",
          "只输出描述正文，中文，约 100—220 字。说明当前人物位置、姿态、正在进行的事情、已经出现且仍在场的物品、光线与氛围。保持能确认的事实，不确定的内容不要编造。",
          "地点固定环境（不可改写成临时变化）：", location?.description || "",
          "固定布局：", location?.layout || "",
          "固定氛围：", location?.atmosphere || "",
          "上一次现场描述（若有，保留仍然成立的细节并按新事实更新）：", scene.currentDescription || "尚无",
          "当前在场者：", scene.participants.map(p => {
            const actor = p.ownerType === "player" ? null : characters.find(item => item.id === p.ownerId);
            return (actor?.name || (p.ownerType === "player" ? playerName : p.ownerId)) + "；活动：" + (p.activity || "未知");
          }).join("\n"),
          "本场景原始记录（按时间顺序；它们是事实来源，不得把总结当作新事件）：",
          messages.join("\n"),
          "禁止：不要替玩家添加没有发生的动作或台词；不要把已经离开的人写成仍在场；不要把地点固定描述覆盖掉；不要输出标题、分析、列表或总结标签。"
        ].join("\n\n")
      };
      const result = await generateOfflineChatCompletion(session, [prompt], { appId: "life", appTags: lifeAppTags("scene"), includeDirectChatEntries: false });
      const description = result.content.trim().replace(/^["“”]+|["“”]+$/g, "").slice(0, 5000);
      if (!description) throw new Error("模型没有返回现场描述。");
      const latest = stateRef.current;
      const latestScene = latest.scenes.find(item => item.id === scene.id);
      if (!latestScene) throw new Error("生成期间当前场景已不存在，未覆盖其他场景。");
      commit({ ...latest, scenes: latest.scenes.map(item => item.id === scene.id ? { ...item, currentDescription: description, updatedAt: new Date().toISOString() } : item) });
      setNotice("已更新现场描述。");
    } catch (error) {
      setNotice("整理现场描述失败：" + (error instanceof Error ? error.message : "未知错误"));
    } finally {
      setSceneDescriptionBusy(false);
    }
  };

  const sceneImageRecords = activeScene?.images ?? [];
  const sceneViewerImages = [...sceneImageRecords].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  useEffect(() => {
    let alive = true;
    const urls: Record<string,string> = {};
    void Promise.all(sceneImageRecords.map(async image => {
      const url = await loadMediaObjectUrl(image.mediaRef);
      if (url) urls[image.id] = url;
    })).then(() => {
      if (!alive) { Object.values(urls).forEach(url=>URL.revokeObjectURL(url)); return; }
      setImageObjectUrls(previous => {
        Object.values(previous).forEach(url=>URL.revokeObjectURL(url));
        return urls;
      });
    });
    return () => { alive = false; };
  }, [activeScene?.id, sceneImageRecords.map(image=>image.id+":"+image.status).join("|")]);

  useEffect(() => {
    if (!imageViewerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImageViewerOpen(false);
      else if (event.key === "ArrowLeft") setImageViewerIndex(index => Math.max(0, index - 1));
      else if (event.key === "ArrowRight") setImageViewerIndex(index => Math.min(sceneViewerImages.length - 1, index + 1));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [imageViewerOpen, sceneViewerImages.length]);

  useEffect(() => {
    setImageViewerOpen(false);
    setImageViewerIndex(0);
  }, [activeScene?.id]);

  const buildSceneImagePrompt = (participantIds: string[], customPrompt: string) => {
    const imageSettings = loadImageGenerationSettings();
    const parts = [
      "为虚拟生活场景生成一张单帧画面，不是拼贴、漫画分格或文字海报。",
      "当前场景："+(activeScene?.locationName || selectedLocation?.name || "日常场景"),
      "场景状态："+(activeScene?.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);return (actor?.name||p.ownerId)+"正在"+p.activity;}).join("；") || playerActivity),
      activeScene?.currentDescription?.trim() ? "当前现场描述（独立于地点固定描写，依据本场景真实记录保持连续性）："+activeScene.currentDescription.trim() : "",
      participantIds.includes(PLAYER_ID) && imageSettings.characterReferences?.["__user__"]?.featurePrompt?.trim() ? "玩家固定外观："+imageSettings.characterReferences["__user__"].featurePrompt.trim() : "",
      participantIds.includes(PLAYER_ID) && imageSettings.characterReferences?.["__user__"]?.assetId ? "用户本人使用人物身份参考图保持身份；不要把用户与角色混为一人，也不要复制参考图的服装或站位。" : "",
      ...participantIds.map(pid=>{
        const char=characters.find(item=>item.id===pid);
        if(!char)return "";
        const ref=imageSettings.characterReferences?.[char.id];
        return char.name+"的角色身份与稳定外观（服装、姿态和站位随当前场景变化）："+[char.persona,ref?.featurePrompt].filter(Boolean).join("；");
      }),
      settings.sceneImageStyle,
      customPrompt.trim(),
    ];
    return parts.filter(Boolean).join("\n");
  };

  const generateSceneImages = async (options?: { prompt?: string; participantIds?: string[]; count?: number; autoFingerprint?: string }) => {
    if (!activeScene || sceneImageBusy) return;
    const imageSettings = loadImageGenerationSettings();
    if (!imageSettings.enabled) { setNotice("请先到「设置 → 生图设置」启用并配置生图 API。"); return; }
    const participantIds = options?.participantIds ?? (imageParticipantIds.length
      ? imageParticipantIds
      : [
          ...(activeScene.participants.some(participant => participant.ownerType === "player" && participant.ownerId === PLAYER_ID)
            ? [PLAYER_ID] : []),
          ...activeScene.participants.filter(participant => participant.ownerType === "character").map(participant => participant.ownerId),
        ]);
    const prompt = buildSceneImagePrompt(participantIds, options?.prompt ?? sceneImagePrompt);
    const count = Math.max(1,Math.min(4,options?.count ?? settings.sceneImageCount));
    setSceneImageBusy(true);
    setNotice("正在生成场景图…");
    const generated: LifeSceneImage[] = [];
    try {
      const referenceCharacterId = participantIds.find(pid => pid !== PLAYER_ID && characters.some(character => character.id === pid));
      const characterIds = participantIds.filter(pid => pid !== PLAYER_ID && characters.some(character => character.id === pid));
      const explicitParticipants = participantIds.map(pid => pid === PLAYER_ID ? "__user__" : pid);
      for(let index=0;index<count;index++){
        const result = await generateImageFromConfiguredApi({
          description: prompt+(count>1?"\n画面方案："+(index+1)+"，请在同一场景和角色外观基础上尝试不同自然构图。":""),
          characterId: referenceCharacterId || characterIds[0],
          characterIds,
          participantIds: explicitParticipants,
          appId: "life",
        });
        if(!result) throw new Error("生图服务未返回图片，请检查 API 配置和启用状态。");
        generated.push({id:id("scene-image"),sceneId:activeScene.id,mediaRef:result.mediaRef,prompt:result.prompt,participantIds:[...participantIds],createdAt:new Date().toISOString(),status:"active",alt:activeScene.locationName+"场景图"});
      }
      const latest=stateRef.current;
      const scene=latest.scenes.find(item=>item.id===activeScene.id);
      if(scene){
        const updated={...scene,images:[...(scene.images??[]).map(image=>({...image,status:"archived" as const})),...generated],lastAutoImageFingerprint:options?.autoFingerprint ?? scene.lastAutoImageFingerprint,updatedAt:new Date().toISOString()};
        const imageMessages: LifeSceneMessage[] = generated.map(image => ({
          id: "scene-image-message-" + image.id,
          sceneId: image.sceneId,
          speakerType: "player" as const,
          speakerId: PLAYER_ID,
          speakerName: playerName,
          role: "system" as const,
          action: "场景图片",
          dialogue: "",
          imageId: image.id,
          createdAt: image.createdAt,
        }));
        commit({
          ...latest,
          scenes: latest.scenes.map(item=>item.id===scene.id?updated:item),
          sceneMessages: [...latest.sceneMessages, ...imageMessages],
        });
        const orderedImages = [...(scene.images ?? []), ...generated].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        setImageViewerIndex(Math.max(0, orderedImages.findIndex(image => image.id === generated[0]?.id)));
        setNotice("场景图已生成。");
      }
    } catch(error) {
      await Promise.all(generated.map(image=>deleteMediaRef(image.mediaRef)));
      setNotice("场景图生成失败："+(error instanceof Error?error.message:"未知错误")+"；本轮未完成的图片已清理，旧图库未受影响。");
    } finally { setSceneImageBusy(false); }
  };

  const setSceneImageAsBackground = async (imageId: string) => {
    if (!activeScene || backgroundUploadBusy) return;
    const image = (activeScene.images ?? []).find(item => item.id === imageId && item.status === "active");
    if (!image) return;
    setBackgroundUploadBusy("location");
    try {
      const objectUrl = await loadMediaObjectUrl(image.mediaRef);
      if (!objectUrl) throw new Error("无法读取这张场景图的媒体缓存。");
      const response = await fetch(objectUrl);
      if (!response.ok) throw new Error("读取场景图失败。");
      const blob = await response.blob();
      const file = new File([blob], "life-scene-background.jpg", { type: blob.type || "image/jpeg" });
      const backgroundImage = await compressLifeBackground(file);
      const latest = stateRef.current;
      const locationId = activeScene.locationId;
      const location = latest.locations.find(item => item.id === locationId);
      if (!location) throw new Error("当前场景对应的地点已不存在。");
      commit({ ...latest, locations: latest.locations.map(item => item.id === locationId ? { ...item, backgroundImage } : item) });
      setNotice("已将这张场景图设为「" + location.name + "」的聊天室背景；地点固定描写和场景记录不会改变。");
    } catch (error) {
      setNotice("设置聊天室背景失败：" + (error instanceof Error ? error.message : "未知错误"));
    } finally {
      setBackgroundUploadBusy(null);
    }
  };

  const downloadSceneImage = async (image: LifeSceneImage) => {
    const sourceUrl = imageObjectUrls[image.id];
    if (!sourceUrl) {
      setNotice("图片仍在加载，请稍后再试。");
      return;
    }
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error("读取原图失败。");
      const blob = await response.blob();
      const mimeExtension = blob.type.split("/")[1]?.toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
      await downloadFile(blob, "life-scene-" + image.id + "." + mimeExtension);
    } catch (error) {
      setNotice("下载场景原图失败：" + (error instanceof Error ? error.message : "未知错误"));
    }
  };

  const setSceneImageStatus = (imageId:string,status:"active"|"archived") => {
    if(!activeScene)return;
    const next={...stateRef.current,scenes:stateRef.current.scenes.map(scene=>scene.id!==activeScene.id?scene:{...scene,images:(scene.images??[]).map(image=>image.id===imageId?{...image,status}:image),updatedAt:new Date().toISOString()})};
    commit(next);
  };
  const removeSceneImage = async (imageId:string) => {
    if(!activeScene)return;
    const image=(activeScene.images??[]).find(item=>item.id===imageId);
    if(!image)return;
    const latest={
      ...stateRef.current,
      scenes:stateRef.current.scenes.map(scene=>scene.id!==activeScene.id?scene:{...scene,images:(scene.images??[]).filter(item=>item.id!==imageId),updatedAt:new Date().toISOString()}),
      sceneMessages: stateRef.current.sceneMessages.filter(message => message.imageId !== imageId),
    };
    commit(latest);
    setImageViewerOpen(false);
    const url=imageObjectUrls[imageId]; if(url) URL.revokeObjectURL(url);
    setImageObjectUrls(previous=>{const copy={...previous};delete copy[imageId];return copy;});
    await deleteMediaRef(image.mediaRef);
    setNotice("图片已删除。");
  };

  const openMessageActions = (message: LifeSceneMessage) => {
    if (message.imageId) return;
    setMessageActionTarget(message);
    setMessageEditDraft(message.dialogue);
    setMessageEditActionDraft(message.action || "");
    setMessageActionMode("menu");
  };

  const clearMessageLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const saveMessageEdit = () => {
    if (!messageActionTarget) return;
    const message = messageActionTarget;
    const dialogue = messageEditDraft.trim();
    const action = messageEditActionDraft.trim();
    const latest = stateRef.current;
    const sceneMessages = latest.sceneMessages.map(item => item.id === message.id ? { ...item, dialogue, action: action || undefined } : item);
    let timeline = latest.timeline
      .filter(entry => !(entry.sourceId === message.id && ((entry.category === "dialogue" && !dialogue) || (entry.category === "action" && !action))))
      .map(entry => {
        if (entry.sourceId !== message.id) return entry;
        if (entry.category === "dialogue") return { ...entry, title: (message.speakerName || playerName) + "说", details: dialogue };
        if (entry.category === "action") return { ...entry, title: (message.speakerName || playerName) + "的行动", details: action };
        return entry;
      });
    let next: VirtualLifeState = { ...latest, sceneMessages, timeline };
    const locationName = latest.scenes.find(scene => scene.id === message.sceneId)?.locationName;
    if (dialogue && !timeline.some(entry => entry.sourceId === message.id && entry.category === "dialogue")) {
      next = appendLifeTimelineEntry(next, { category: "dialogue", title: (message.speakerName || playerName) + "说", details: dialogue, actorId: message.speakerId, actorName: message.speakerName || playerName, locationName, sceneId: message.sceneId, sourceId: message.id });
      timeline = next.timeline;
    }
    if (action && !timeline.some(entry => entry.sourceId === message.id && entry.category === "action")) {
      next = appendLifeTimelineEntry(next, { category: "action", title: (message.speakerName || playerName) + "的行动", details: action, actorId: message.speakerId, actorName: message.speakerName || playerName, locationName, sceneId: message.sceneId, sourceId: message.id });
    }
    next = rebuildSceneDialogueTimeline(next, message.sceneId, latest.settings.sceneRecordBatchSize ?? 10);
    commit(next);
    setMessageActionTarget(null);
    setNotice("已保存。");
  };

  const deleteSceneMessage = () => {
    if (!messageActionTarget) return;
    const message = messageActionTarget;
    const latest = stateRef.current;
    const next: VirtualLifeState = {
      ...latest,
      sceneMessages: latest.sceneMessages.filter(item => item.id !== message.id),
      timeline: latest.timeline.filter(entry => entry.sourceId !== message.id),
    };
    commit(rebuildSceneDialogueTimeline(next, message.sceneId, latest.settings.sceneRecordBatchSize ?? 10));
    setMessageActionTarget(null);
    setNotice("已删除。");
  };

  const regenerateSceneMessage = async (message: LifeSceneMessage) => {
    const latestAtStart = stateRef.current;
    let targetMessage = message;
    if (message.role === "player") {
      targetMessage = latestAtStart.sceneMessages.find(item =>
        item.sceneId === message.sceneId && item.role === "character" && item.replyToMessageId === message.id
      ) ?? (() => {
        const playerIndex = latestAtStart.sceneMessages.findIndex(item => item.id === message.id);
        return latestAtStart.sceneMessages.slice(playerIndex + 1).find(item =>
          item.sceneId === message.sceneId && item.role === "character"
          && !latestAtStart.sceneMessages.slice(playerIndex + 1, latestAtStart.sceneMessages.indexOf(item)).some(previous => previous.sceneId === message.sceneId && previous.role === "player")
        );
      })() as LifeSceneMessage;
      if (!targetMessage) {
        setNotice("这条玩家输入后面还没有角色回复，先发送一次互动再重新生成。");
        return;
      }
    } else if (message.role !== "character") {
      setNotice("系统记录可以编辑或删除；重新生成需要选中玩家输入或角色回复。");
      return;
    }
    const character = characters.find(item => item.id === targetMessage.speakerId);
    const contact = loadChatContacts().find(item => item.characterId === targetMessage.speakerId);
    const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup) ?? createLifeChatSession(targetMessage.speakerId, character?.name ?? "角色");
    const scene = stateRef.current.scenes.find(item => item.id === targetMessage.sceneId);
    if (!character || !scene) {
      setNotice("找不到角色档案或原场景，暂时无法重新生成。");
      return;
    }
    const sceneIndex = stateRef.current.sceneMessages.findIndex(item => item.id === targetMessage.id);
    const previousPlayer = message.role === "player"
      ? message
      : (targetMessage.replyToMessageId
        ? stateRef.current.sceneMessages.find(item => item.id === targetMessage.replyToMessageId && item.role === "player")
        : undefined)
        ?? stateRef.current.sceneMessages.slice(0, sceneIndex).reverse().find(item => item.sceneId === targetMessage.sceneId && item.role === "player");
    if (!previousPlayer) {
      setNotice("找不到这条回复对应的玩家输入，无法重新生成。");
      return;
    }
    if (busyRef.current) {
      setNotice("当前有其他回合正在处理，请稍后再试。");
      return;
    }
    const lifeTurn = beginTurn({ kind: "life_scene", characterId: character.id, sessionId: session.id });
    if (!lifeTurn) {
      setNotice("角色当前正在处理其他回合，请稍后再试。");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setMessageActionTarget(null);
    try {
      const sceneContext = buildLifeScenePromptContext(stateRef.current, scene, character.id, previousPlayer.id);
      const prompt: ChatMessage = {
        id: id("life-regenerate"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "【仅本轮使用生活场景模式规则，不要写入线上聊天历史】",
          settings.keepDialogueConcise ? "保持简短：一句对白，必要时附一个动作。" : "允许适度展开，但保持实时互动感。",
          
          sceneContext,
          "玩家行动：" + (previousPlayer.action || "无"),
          "玩家对白：" + (previousPlayer.dialogue || "无"),
          "请重新生成这一轮的生活现场回应。",
        ].filter(Boolean).join("\n"),
      };
      const { parsed, issues } = await generateValidatedLifeTurn({
        session,
        promptMessage: prompt,
        signal: lifeTurn.signal,
        previousActionOnly: false,
        allowEmpty: false,
        appTags: lifeAppTags("scene"),
      });
      if (issues.length > 0) throw new Error("输出格式异常：" + describeLifeOutputIssues(issues));
      if (!parsed.action?.trim() && !parsed.dialogue.trim()) throw new Error("模型返回了空回应，请检查当前角色绑定的模型或输出格式设置后重试。");
      const latest = stateRef.current;
      // A single turn may be stored as one action card plus several dialogue bubbles.
      // Replace the entire original turn, otherwise regeneration leaves stale sibling bubbles behind.
      const turnMessages = latest.sceneMessages.filter(item =>
        item.sceneId === targetMessage.sceneId && item.role === "character"
        && item.speakerId === targetMessage.speakerId && item.createdAt === targetMessage.createdAt
      );
      const turnIds = new Set(turnMessages.map(item => item.id));
      turnIds.add(targetMessage.id);
      const replyAt = new Date().toISOString();
      const actionText = (parsed.action ?? "").trim();
      const dialogueSegments = preserveLifeDialogueSegments(parsed.dialogues);
      const replacementMessages: LifeSceneMessage[] = [
        ...(actionText ? [{ ...targetMessage, action: actionText, dialogue: "", createdAt: replyAt }] : []),
        ...dialogueSegments.map((dialogue, index) => ({
          ...targetMessage,
          id: !actionText && index === 0 ? targetMessage.id : id("turn-dialogue-regenerated"),
          action: undefined,
          dialogue,
          createdAt: replyAt,
        })),
      ];
      const firstTurnIndex = latest.sceneMessages.findIndex(item => turnIds.has(item.id));
      const sceneMessages = [
        ...latest.sceneMessages.slice(0, firstTurnIndex).filter(item => !turnIds.has(item.id)),
        ...replacementMessages,
        ...latest.sceneMessages.slice(firstTurnIndex).filter(item => !turnIds.has(item.id)),
      ];
      let next: VirtualLifeState = {
        ...latest,
        sceneMessages,
        timeline: latest.timeline.filter(entry => !(turnIds.has(entry.sourceId || "") && (entry.category === "action" || entry.category === "dialogue"))),
      };
      if (actionText) {
        const actionMessage = replacementMessages.find(item => item.action?.trim());
        next = appendLifeTimelineEntry(next, { category: "action", title: character.name + "的行动", details: actionText, actorId: character.id, actorName: character.name, locationName: scene.locationName, sceneId: scene.id, sourceId: actionMessage?.id || targetMessage.id });
      }
      next = rebuildSceneDialogueTimeline(next, scene.id, latest.settings.sceneRecordBatchSize ?? 10);
      commit(next);
      setNotice("已重新生成。");
    } catch (error) {
      setNotice(error instanceof Error ? "重新生成失败：" + error.message : "重新生成失败，请检查模型配置。");
    } finally {
      lifeTurn.end();
      busyRef.current = false;
      setBusy(false);
    }
  };

  const handleMessageAction = (action: "edit" | "delete" | "regenerate") => {
    if (!messageActionTarget) return;
    if (action === "edit") {
      setMessageEditDraft(messageActionTarget.dialogue);
      setMessageEditActionDraft(messageActionTarget.action || "");
      setMessageActionMode("edit");
    } else if (action === "delete") {
      setMessageActionMode("delete-confirm");
    } else {
      void regenerateSceneMessage(messageActionTarget);
    }
  };

  const pushSceneMessage = (message: LifeSceneMessage) => {
    if (!message.channel) message.channel = "life_scene";
    const latest = stateRef.current;
    const currentScene = latest.scenes.find(scene => scene.id === message.sceneId);
    const updatedScene = currentScene ? { ...currentScene, updatedAt: new Date().toISOString() } : null;
    let next = { ...latest, sceneMessages: [...latest.sceneMessages, message] };
    if (updatedScene) next = upsertLifeScene(next, updatedScene);
    const actorName = message.speakerName || (message.role === "player" ? playerName : "生活记录");
    if (message.role === "system") {
      const sceneRecordText = message.action || message.dialogue;
      next = appendLifeTimelineEntry(next, { category: "scene", title: sceneRecordText.slice(0, 100), details: sceneRecordText, actorName, locationName: currentScene?.locationName, sceneId: message.sceneId, sourceId: message.id });
    } else {
      if (message.action) {
        next = appendLifeTimelineEntry(next, { category: "action", title: actorName + (message.role === "player" ? "进行了行动" : "的行动"), details: message.action, actorId: message.speakerId, actorName, locationName: currentScene?.locationName, sceneId: message.sceneId, sourceId: message.id });
      }
      if (message.dialogue.trim()) {
        next = rebuildSceneDialogueTimeline(next, message.sceneId, latest.settings.sceneRecordBatchSize ?? 10);
      }
    }
    commit(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-scene-message-added"));
  };

  const pushSceneMessages = (messages: LifeSceneMessage[], baseState: VirtualLifeState = stateRef.current) => {
    if (!messages.length) return;
    const latest = baseState;
    const normalized = messages.map(message => ({ ...message, channel: message.channel || "life_scene" }));
    const touchedSceneIds = [...new Set(normalized.map(message => message.sceneId))];
    let next: VirtualLifeState = { ...latest, sceneMessages: [...latest.sceneMessages, ...normalized] };
    for (const sceneId of touchedSceneIds) {
      const scene = next.scenes.find(item => item.id === sceneId);
      if (scene) next = upsertLifeScene(next, { ...scene, updatedAt: new Date().toISOString() });
    }
    const dialogueSceneIds = new Set<string>();
    for (const message of normalized) {
      const scene = latest.scenes.find(item => item.id === message.sceneId);
      const actorName = message.speakerName || (message.role === "player" ? playerName : "生活记录");
      if (message.role === "system") {
        const text = message.action || message.dialogue;
        next = appendLifeTimelineEntry(next, { category: "scene", title: text.slice(0, 100), details: text, actorName, locationName: scene?.locationName, sceneId: message.sceneId, sourceId: message.id });
      } else {
        if (message.action) next = appendLifeTimelineEntry(next, { category: "action", title: actorName + (message.role === "player" ? "进行了行动" : "的行动"), details: message.action, actorId: message.speakerId, actorName, locationName: scene?.locationName, sceneId: message.sceneId, sourceId: message.id });
        if (message.dialogue.trim()) dialogueSceneIds.add(message.sceneId);
      }
    }
    for (const sceneId of dialogueSceneIds) next = rebuildSceneDialogueTimeline(next, sceneId, latest.settings.sceneRecordBatchSize ?? 10);
    commit(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-scene-message-added"));
  };
  // Life-scene autonomy runs only while the app is open and the scene is visible.
  useEffect(() => {
    if (!LIFE_PROACTIVE_MESSAGES_ENABLED || !ready || !settings.enabled || !settings.enableCharacterAutonomy || settings.enableProactiveSceneMessages === false || !activeScene || activeScene.status !== "active" || !immersiveScene) return;
    let disposed = false;
    const refreshForegroundLease = () => setLifeSceneForegroundLease(activeScene.id, document.visibilityState === "visible");
    refreshForegroundLease();
    const leaseTimer = window.setInterval(refreshForegroundLease, 30_000);
    document.addEventListener("visibilitychange", refreshForegroundLease);
    const minIntervalMinutes = Math.max(2, Math.min(60, settings.proactiveSceneIntervalMinutes ?? 2));
    const maxIntervalMinutes = Math.max(minIntervalMinutes, Math.min(60, settings.proactiveSceneIntervalMaxMinutes ?? 4));
    const getRandomIntervalMs = () => (minIntervalMinutes + Math.floor(Math.random() * (maxIntervalMinutes - minIntervalMinutes + 1))) * 60_000;
    const candidateIds = [...new Set(activeScene.participants
      .filter(participant => participant.ownerType === "character" && participant.ownerId && participant.activity !== "离开")
      .map(participant => participant.ownerId))];
    const buildPrompt = (character: Character): string => {
      const sceneContext = buildLifeScenePromptContext(stateRef.current, activeScene, character.id);
      return [
        settings.keepDialogueConcise ? "保持自然简短：一句对白，必要时附一个动作。" : "可以适度展开，但不要写成长篇故事。",
        
        sceneContext,
      ].filter(Boolean).join("\n\n");
    };
    const pickCandidate = () => {
      const lastSceneSpeaker = [...stateRef.current.sceneMessages].reverse().find(message => message.sceneId === activeScene.id && message.role === "character")?.speakerId;
      const speakerId = chooseLifeAutonomyCharacter(
        candidateIds,
        proactiveLastSpeakerRef.current[activeScene.id] || lastSceneSpeaker,
        stateRef.current.sceneMessages,
        activeScene.id,
      );
      const character = characters.find(item => item.id === speakerId);
      if (!character) return null;
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup);
      return { character, session: session ?? createLifeChatSession(character.id, character.name) };
    };
    const tick = async () => {
      if (disposed || document.visibilityState !== "visible" || busyRef.current || proactiveBusyRef.current) return;
      const now = Date.now();
      const previousAttempt = proactiveAttemptAtRef.current[activeScene.id];
      if (previousAttempt == null) {
        proactiveAttemptAtRef.current[activeScene.id] = now;
        const firstDelay = getRandomIntervalMs();
        proactiveNextAtRef.current[activeScene.id] = now + firstDelay;
        // Arm one server-side turn while the WebView is alive. If the app is killed,
        // push-generate can still generate and notify at the scheduled time.
        const candidate = pickCandidate();
        if (candidate) {
          const { character, session } = candidate;
          void armLifeSceneProactiveBailout({
            sessionId: session.id,
            sceneId: activeScene.id,
            characterId: character.id,
            characterName: character.name,
            prompt: buildPrompt(character),
            appId: "life",
            appTags: lifeAppTags("autonomy"),
            executeAtMs: now + firstDelay,
            source: "foreground",
          }).then(result => {
            recordLifeDiagnostic({
              source: "主动调度",
              event: result.ok ? "前台首次兜底任务已挂载" : "前台首次兜底任务挂载失败",
              status: result.ok ? "ok" : "error",
              detail: result.ok ? character.name + " 的前台兜底已提交。" : character.name + "：" + (result.reason || "未知原因"),
              meta: { sceneId: activeScene.id, characterId: character.id, sessionId: session.id, executeAt: new Date(now + firstDelay).toISOString() },
            });
            if (!result.ok) console.warn("[LifeAutonomy] 首次服务端预约未挂上：", result.reason);
          });
        }
        return;
      }
      const nextAllowedAt = proactiveNextAtRef.current[activeScene.id];
      if (nextAllowedAt != null && now < nextAllowedAt) return;
      const decision = evaluateLifeAutonomyWindow({
        scene: activeScene, playerId: PLAYER_ID, messages: stateRef.current.sceneMessages, now,
        lastAttemptAt: previousAttempt, intervalMinutes: settings.proactiveSceneIntervalMinutes ?? 5,
        silenceMinutes: settings.proactiveSceneSilenceMinutes ?? 10,
        busy: busyRef.current, visible: document.visibilityState === "visible",
        enabled: settings.enableProactiveSceneMessages !== false && settings.enableCharacterAutonomy,
      });
      if (!decision.eligible) return;
      const candidate = pickCandidate();
      if (!candidate) return;
      const { character, session } = candidate;
      const lifeTurn = beginTurn({ kind: "life_scene", characterId: character.id, sessionId: session.id });
      if (!lifeTurn) return;
      // Replace only the old foreground one-shot fallbacks before starting a local turn.
      // The independent 20-minute schedule chain stays armed and defers against the foreground lease.
      await cancelLifeSceneProactiveBailouts(activeScene.id, candidateIds);
      proactiveAttemptAtRef.current[activeScene.id] = now;
      proactiveNextAtRef.current[activeScene.id] = now + getRandomIntervalMs();
      proactiveLastSpeakerRef.current[activeScene.id] = character.id;
      proactiveBusyRef.current = true;
      setBusy(true);
      try {
        const proactivePrompt: ChatMessage = {
          id: id("life-autonomy"), sessionId: session.id, role: "user", status: "sent",
          createdAt: new Date().toISOString(), content: buildPrompt(character),
        };
        const previousActionOnly = isLastCharacterTurnActionOnly(stateRef.current, activeScene.id, character.id);
        const { parsed, issues } = await generateValidatedLifeTurn({
          session,
          promptMessage: proactivePrompt,
          signal: lifeTurn.signal,
          previousActionOnly,
          allowEmpty: true,
          appTags: lifeAppTags("autonomy"),
        });
        if (disposed || issues.length > 0) return;
        if (!parsed.action?.trim() && !parsed.dialogue.trim()) return;
        const responseAt = new Date().toISOString();
        const actionText = (parsed.action ?? "").trim();
        const dialogueSegments = preserveLifeDialogueSegments(parsed.dialogues);
        const mergedDialogue = dialogueSegments.join("\n");
        const responseMessages: LifeSceneMessage[] = [
          ...(actionText ? [{ id: id("life-proactive-action"), sceneId: activeScene.id, speakerType: "character" as const, speakerId: character.id, speakerName: character.name, role: "character" as const, action: actionText, dialogue: "", createdAt: responseAt, channel: "life_autonomy" as const }] : []),
          ...dialogueSegments.map(dialogue => ({ id: id("life-proactive-dialogue"), sceneId: activeScene.id, speakerType: "character" as const, speakerId: character.id, speakerName: character.name, role: "character" as const, dialogue, createdAt: responseAt, channel: "life_autonomy" as const })),
        ];
        responseMessages.forEach(pushSceneMessage);
        const body = responseMessages.map(message => [message.action, message.dialogue].filter(Boolean).join(" ")).filter(Boolean).join(" ");
        if (settings.enableLifeMessageNotifications !== false) {
          const toastKind: "action" | "dialogue" = actionText ? "action" : "dialogue";
          setSceneToast({ kind: toastKind, characterId: character.id, characterName: character.name, avatar: character.avatar ?? "", location: activeScene.locationName, body: actionText || mergedDialogue, sceneId: activeScene.id });
          notifyLifeSceneMessage("生活现场 · 主动" + (toastKind === "action" ? "行动" : "对话"), "地点：" + activeScene.locationName + " · " + body, () => setTab("scene"));
          window.setTimeout(() => setSceneToast(current => current?.body === body ? null : current), 6500);
        }
      } catch (error) {
        recordLifeDiagnostic({ source: "生活现场 AI", event: "前台主动回合失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { sceneId: activeScene.id } });
        console.warn("[LifeAutonomy] proactive scene turn failed:", error);
      } finally {
        lifeTurn.end();
        // Keep exactly one fresh server-side fallback armed for the next interval while
        // the app is alive. The server can execute this snapshot if Android kills the WebView;
        // when the app returns, it rebuilds a new snapshot from current scene state.
        const latestState = stateRef.current;
        const stillActiveScene = latestState.scenes.find(item => item.id === activeScene.id && item.status === "active");
        if (!disposed && stillActiveScene && latestState.settings.enabled
          && latestState.settings.enableCharacterAutonomy
          && latestState.settings.enableProactiveSceneMessages !== false) {
          const nextCandidate = pickCandidate();
          if (nextCandidate) {
            const scheduledAt = proactiveNextAtRef.current[activeScene.id] ?? (Date.now() + getRandomIntervalMs());
            const fallbackAt = Math.max(Date.now() + 30_000, scheduledAt);
            void armLifeSceneProactiveBailout({
              sessionId: nextCandidate.session.id,
              sceneId: activeScene.id,
              characterId: nextCandidate.character.id,
              characterName: nextCandidate.character.name,
              prompt: buildPrompt(nextCandidate.character),
              appId: "life",
              appTags: lifeAppTags("autonomy"),
              executeAtMs: fallbackAt,
              source: "foreground",
            }).then(result => recordLifeDiagnostic({
              source: "主动调度",
              event: result.ok ? "前台后续兜底任务已挂载" : "前台后续兜底任务挂载失败",
              status: result.ok ? "ok" : "error",
              detail: result.ok ? nextCandidate.character.name + " 的下一轮兜底已提交。" : nextCandidate.character.name + "：" + (result.reason || "未知原因"),
              meta: { sceneId: activeScene.id, characterId: nextCandidate.character.id, sessionId: nextCandidate.session.id, executeAt: new Date(fallbackAt).toISOString() },
            }));
          }
        }
        proactiveBusyRef.current = false;
        if (!disposed) {
          setBusy(false);
        }
      }
    };
    const onVisibilityChange = () => {
      // Local AI turns run only while visible; the server-side schedule chain remains the offline fallback.
      if (document.visibilityState === "visible") void tick();
    };
    // Clear any locally scheduled online-chat follow-up for characters currently in this scene.
    // 进入生活现场只暂停线上主动消息的触发，不删除已经排好的追问。
    // 之前这里直接 cancelFollowUp，导致用户切到后台后线上主动消息也永远不再来。
    const timer = window.setInterval(() => void tick(), LIFE_AUTONOMY_TICK_MS);
    // 首次进入生活现场就挂一条服务端预约，不能等第一个 5 分钟 tick：
    // 用户通常不会在生活页停留那么久，旧逻辑会导致 push_jobs 永远没有 life-scene 任务。
    void tick();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.clearInterval(leaseTimer);
      setLifeSceneForegroundLease(activeScene.id, false);
      document.removeEventListener("visibilitychange", refreshForegroundLease);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Restore online idle reconnect when the character is no longer co-present.
      // Cleanup also runs for settings changes, so check persisted scene state first.
      // Reconcile only the characters from the scene this effect owned. If they
      // left, their online reconnect is re-armed; if still co-present, it stays
      // suppressed. The bailout layer independently rechecks presence before POST.
    };
  }, [ready, settings.enabled, settings.enableCharacterAutonomy, settings.enableProactiveSceneMessages, settings.proactiveSceneIntervalMinutes, settings.proactiveSceneIntervalMaxMinutes, settings.keepDialogueConcise, activeScene?.id, activeScene?.status, activeScene?.locationId, activeScene?.participants.map(participant => participant.ownerType + ":" + participant.ownerId + ":" + participant.activity).join("|"), immersiveScene, characters, lifeAppTags, activeMaxConsecutiveActionOnly, settings.enableLifeFormatRepair, playerName]);
  const sendSceneTurn = async (event?: FormEvent, forceReaction = false, notificationReplyId?: string, responseQueue?: string[], queuedTurn?: PendingLifeSceneTurn): Promise<"completed" | "deferred" | "failed"> => {
    event?.preventDefault();
    // Notification / forced reactions must use the already-persisted scene history, never an unsent composer draft.
    const userText = forceReaction ? "" : queuedTurn?.userText ?? sceneInput.trim();
    const userAction = forceReaction ? "" : queuedTurn?.userAction ?? sceneActionInput.trim();
    const turnScene = queuedTurn
      ? stateRef.current.scenes.find(scene => scene.id === queuedTurn.sceneId)
      : activeScene;
    const discardQueuedTurn = () => {
      if (!queuedTurn) return;
      pendingSceneTurnsRef.current = pendingSceneTurnsRef.current.filter(turn => turn.messageId !== queuedTurn.messageId);
      savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
      clearActiveLifeSceneTurn(queuedTurn.messageId);
      setPendingSceneQueueVersion(value => value + 1);
    };
    if (!turnScene || (!userText && !userAction && !forceReaction)) {
      if (!responseQueue?.length) discardQueuedTurn();
      return "failed";
    }
    const notificationResponsePrefix = notificationReplyId ? "notification-reply-response-" + notificationReplyId : "";
    if (notificationResponsePrefix && stateRef.current.sceneMessages.some(message =>
      message.id === notificationResponsePrefix + "-action" || message.id.startsWith(notificationResponsePrefix + "-dialogue-")
    )) return "completed";
    const userTurn = [userAction ? `行动：${userAction}` : "", userText ? `说话：${userText}` : ""].filter(Boolean).join("\n") || "玩家手动请求角色对最近行为作出反馈";
    const selectedSpeakerIsPresent = Boolean(selectedSpeakerId) && turnScene.participants.some(participant => participant.ownerType === "character" && resolveLifeCharacterId(participant.ownerId) === resolveLifeCharacterId(selectedSpeakerId));
    const now = queuedTurn?.createdAt ?? new Date().toISOString();
    const turnMessageId = queuedTurn?.messageId ?? id("turn");
    const pendingTurn: PendingLifeSceneTurn | null = queuedTurn ?? ((userText || userAction) ? {
      sceneId: turnScene.id, userText, userAction, createdAt: now, messageId: turnMessageId,
    } : null);
    const discardPendingTurn = () => {
      if (!pendingTurn) return;
      pendingSceneTurnsRef.current = pendingSceneTurnsRef.current.filter(turn => turn.messageId !== pendingTurn.messageId);
      savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
      clearActiveLifeSceneTurn(pendingTurn.messageId);
      setPendingSceneQueueVersion(value => value + 1);
    };
    const turnMessageStartIndex = stateRef.current.sceneMessages.length;
    // Persist player input before attempting to resolve a responder. A missing role,
    // disabled random response, or occupied generation slot must never eat the user's turn.
    if ((userText || userAction) && !queuedTurn) {
      setSceneInput("");
      setSceneActionInput("");
      pushSceneMessage({ id: turnMessageId, sceneId: turnScene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: playerName, role: "player", action: userAction || undefined, dialogue: userText, createdAt: now });
    }
    // While a reply is being generated, accept and durably append further player turns.
    // They are answered sequentially after the current root turn completes.
    if (busyRef.current && !responseQueue?.length) {
      if (userText || userAction) {
        if (pendingTurn && !pendingSceneTurnsRef.current.some(turn => turn.messageId === pendingTurn.messageId)) {
          pendingSceneTurnsRef.current.push(pendingTurn);
        }
        savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
        setPendingSceneQueueVersion(value => value + 1);
        setNotice("已发送，等待回复。");
        return "deferred";
      }
      return forceReaction ? "deferred" : "failed";
    }
    if (!responseQueue?.length && pendingTurn) setActiveLifeSceneTurn(pendingTurn);
    const presentCharacters = turnScene.participants
      .filter(participant => participant.ownerType === "character" && participant.activity !== "离开")
      .map(participant => resolveLifeCharacterId(participant.ownerId))
      .filter((value, index, all) => Boolean(value) && all.indexOf(value) === index && characters.some(character => character.id === value));
    const stableSeed = [...(turnScene.id + userTurn + now)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
    const mentionedCharacters = presentCharacters.filter(characterId => {
      const name = characters.find(character => character.id === characterId)?.name?.trim();
      return Boolean(name && name.length > 0 && userTurn.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
    });
    const awarenessResponder = mentionedCharacters.find((characterId, index) => {
      const character = characters.find(item => item.id === characterId);
      if (!character) return false;
      const presence = stateRef.current.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
      const schedule = getCurrentActorSchedule(stateRef.current, "character", characterId, resolveActorLifeNow(getActorClock(stateRef.current, "character", characterId)));
      if (/睡眠|睡觉|入睡|午休/.test((presence?.activity || "") + " " + (schedule?.title || ""))) return false;
      const chance = /警觉|敏感|好奇|关注|保护欲/.test(character.personality || "") ? 85 : 65;
      const roll = (stableSeed + index * 37 + characterId.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0)) % 100;
      return roll < chance;
    });
    if (settings.randomSceneResponses === false && !responseQueue?.length && !notificationReplyId && !selectedSpeakerIsPresent && !awarenessResponder) {
      setNotice("已保存。选择角色后可请求回应。");
      discardPendingTurn();
      return "completed";
    }
    const plannedResponders: string[] = responseQueue?.length
      ? [...new Set(responseQueue.map(resolveLifeCharacterId).filter(Boolean))]
      : notificationReplyId
        ? [resolveLifeCharacterId(selectedSpeakerId || presentCharacters[0] || "")].filter(Boolean)
        : buildLifeSceneResponderQueue({
            presentCharacterIds: presentCharacters,
            randomEnabled: settings.randomSceneResponses !== false,
            randomSeed: stableSeed,
            selectedCharacterId: selectedSpeakerId ? resolveLifeCharacterId(selectedSpeakerId) : undefined,
            awarenessCharacterId: awarenessResponder || undefined,
          });
    const rawTargetId = plannedResponders[0] || selectedSpeakerId || presentCharacters[0] || "";
    const targetId = resolveLifeCharacterId(rawTargetId);
    const target = characters.find(char => char.id === targetId);
    if (!target) {
      if (forceReaction) recordLifeDiagnostic({ source: "通知回复", event: "现场回应无法启动", status: "error", detail: "找不到通知回复对应的角色卡。", meta: { sceneId: turnScene.id, targetId } });
      setNotice("已保存，暂无可回应角色。");
      if (!responseQueue?.length) discardPendingTurn();
      return userText || userAction ? "completed" : "failed";
    }
    // Any character that actually reaches the response queue has now noticed the player,
    // including the second/third responder invoked recursively.
    {
      const latest = stateRef.current;
      const scene = latest.scenes.find(item => item.id === turnScene.id);
      if (scene) {
        const updatedScene = { ...scene, participants: scene.participants.map(participant =>
          participant.ownerType === "character" && resolveLifeCharacterId(participant.ownerId) === target.id
            ? { ...participant, awarenessByActorId: { ...participant.awarenessByActorId, [PLAYER_ID]: "aware" as const } }
            : participant
        ), updatedAt: new Date().toISOString() };
        commit({ ...latest, scenes: latest.scenes.map(item => item.id === scene.id ? updatedScene : item) });
      }
    }
    const targetClock = getActorClock(stateRef.current, "character", target.id);
    const targetNow = resolveActorLifeNow(targetClock);
    const targetSchedule = getCurrentActorSchedule(stateRef.current, "character", target.id, targetNow);
    const targetPresence = stateRef.current.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === target.id);
    const isSleeping = /睡眠|睡觉|入睡|午休/.test((targetPresence?.activity || "") + " " + (targetSchedule?.title || ""));
    const urgentMessage = /救命|紧急|出事了|危险|受伤|快来|急救/.test(userTurn);
    const easySleeper = /浅眠|警觉|敏感|担心|保护欲|容易醒/.test(target.personality || "");
    const wakeSeed = [...(target.id + userText)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const wokeFromSleep = isSleeping && (Boolean(notificationReplyId) || (forceReaction && !responseQueue?.length) || urgentMessage || wakeSeed % 100 < (easySleeper ? 60 : 15));
    if (isSleeping && settings.allowCharactersToStaySilent && !wokeFromSleep && !notificationReplyId) {
      setNotice(target.name + "正在睡觉，没有被这条消息叫醒。消息留在当前场景里；TA醒来后才可能回应。");
      const remaining = responseQueue?.length ? responseQueue.slice(1) : plannedResponders.slice(1);
      if (remaining.length) {
        const nextResult = await sendSceneTurn(undefined, true, undefined, remaining, pendingTurn ?? undefined);
        if (!responseQueue?.length) {
          busyRef.current = false;
          setBusy(false);
          discardPendingTurn();
        }
        return nextResult === "failed" ? "failed" : "completed";
      }
      if (!responseQueue?.length) discardPendingTurn();
      return "failed";
    }
    const contacts = loadChatContacts();
    const sessions = loadChatSessions();
    const contact = contacts.find(item => item.characterId === target.id);
    const session = sessions.find(item => item.contactId === contact?.id && !item.isGroup) ?? createLifeChatSession(target.id, target.name);
    const lifeTurn = beginTurn({ kind: "life_scene", characterId: target.id, sessionId: session.id });
    if (!lifeTurn) {
      if (forceReaction) {
        recordLifeDiagnostic({ source: "通知回复", event: "现场回应被其他回合占用", status: "warning", detail: target.name + " 的回应未启动，因为当前已有其他角色回合正在执行。", meta: { sceneId: turnScene.id, characterId: target.id, sessionId: session.id } });
        return "deferred";
      }
      if (userText || userAction) {
        const retry = pendingTurn;
        if (retry && !pendingSceneTurnsRef.current.some(turn => turn.messageId === retry.messageId)) {
          pendingSceneTurnsRef.current.unshift(retry);
        }
        savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
        if (pendingTurn) clearActiveLifeSceneTurn(pendingTurn.messageId);
        setNotice("已保存，稍后回应。");
        window.setTimeout(() => {
          if (!busyRef.current && retry) void sendSceneTurn(undefined, false, undefined, undefined, retry);
        }, 2500);
        return "deferred";
      }
      return "failed";
    }
    busyRef.current = true;
    setBusy(true);
    if (forceReaction) setNotice(target.name + "正在回应最近的互动……");
    try {
      const sceneContext = buildLifeScenePromptContext(stateRef.current, turnScene, target.id, pendingTurn?.messageId);
      // 生活现场与普通私聊共用同一套短期记忆组装器，避免跨 APP 记忆断层。
      const settingsInstructions = [
        settings.keepDialogueConcise ? "保持简短：一句对白，必要时附一个动作。" : "允许适度展开，但仍保持实时互动感。",
        forceReaction
          ? "本轮由玩家手动强制触发反馈。必须结合最近已经发生的动作或对白，输出可见且符合角色性格的反应；不能空白，也不要只泛泛问候。"
          : settings.allowCharactersToStaySilent
            ? "如果角色不想说话，可以整轮不输出；但没有对白时不要只发 action。"
            : "本轮需要对玩家的输入作出回应。",
        wokeFromSleep ? "角色原本正在睡觉，本轮是被消息或紧急情况吵醒；要表现困倦、反应迟缓或不想立刻长谈，不要突然精神饱满。" : "",
        settings.enableAmbientDetails ? "可以用一两笔简短环境细节营造现场感，不要扩写成长篇旁白。" : "不需要环境氛围描写，直接进行实时互动。",
      ].filter(Boolean).join("\n");
      const promptMessage: ChatMessage = {
        id: id("life-user"), sessionId: session.id, role: "user", status: "sent", createdAt: now,
        content: `[仅本轮使用生活场景模式规则，不要写入线上聊天历史]\n${settingsInstructions}\n\n${sceneContext}\n\n玩家本轮行动：${userAction || (forceReaction ? "（请结合最近的用户行为作出反馈）" : "（没有额外动作）")}\n玩家本轮对白：${userText || (forceReaction ? "（请回应最近的对话或动作，不要要求用户重复输入）" : "（没有说话）")}`,
      };
      const previousActionOnly = isLastCharacterTurnActionOnly(stateRef.current, turnScene.id, target.id);
      const { parsed, issues } = await generateValidatedLifeTurn({
        session,
        promptMessage,
        signal: lifeTurn.signal,
        previousActionOnly,
        allowEmpty: settings.allowCharactersToStaySilent === true && !forceReaction,
        appTags: lifeAppTags("scene"),
      });
      if (issues.length > 0) {
        setNotice("输出格式异常：" + describeLifeOutputIssues(issues) + "。可重新生成。");
        return "failed";
      }
      if (!parsed.action?.trim() && !parsed.dialogue.trim()) {
        setNotice(target.name + "这一轮没有开口，也没有做动作。");
        return "failed";
      }
      if (forceReaction && !parsed.dialogue.trim() && !parsed.action?.trim()) {
        throw new Error("模型返回了空回应，请检查当前角色绑定的模型或输出格式设置后重试。");
      }
      let structuredNext = stateRef.current;
      if (settings.enableCharacterAutonomy && settings.enableScheduleChangeTool && parsed.planChange?.title) {
        const startText = String(parsed.planChange.startAt ?? "");
        const endText = String(parsed.planChange.endAt ?? "");
        const changed = applyCharacterLifeScheduleChange(structuredNext, target.id, {
          startAt: startText,
          endAt: endText,
          title: parsed.planChange.title,
          locationId: parsed.planChange.locationId,
        });
        if (changed.error) {
          setNotice(target.name + "想调整日程，但" + changed.error);
        } else {
          const startAt = new Date(startText);
          const endAt = new Date(endText);
          const location = changed.state.locations.find(item => item.id === parsed.planChange?.locationId);
          structuredNext = appendLifeTimelineEntry(changed.state, {
            category: "schedule",
            title: target.name + "调整了日程：" + parsed.planChange.title,
            details: "计划时间：" + new Date(startText).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) + "—" + new Date(endText).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
            actorId: target.id,
            actorName: target.name,
            locationName: location?.name,
            occurredAt: resolveActorLifeNow(getActorClock(changed.state, "character", target.id)).toISOString(),
          });
          setNotice(target.name + "调整了今天 " + startAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 至 " + endAt.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit"}) + " 的日程，其他时段保持不变。");
        }
      }
      if (settings.enableCharacterAutonomy && parsed.invitation && settings.enableInvitations) {
        const proposedDate = new Date(parsed.invitation.time);
        const playerNow = resolveActorLifeNow(getActorClock(structuredNext, "player", PLAYER_ID));
        const characterNow = resolveActorLifeNow(getActorClock(structuredNext, "character", target.id));
        if (Number.isFinite(proposedDate.getTime()) && proposedDate > playerNow && proposedDate > characterNow) {
          const location = structuredNext.locations.find(item=>item.id===parsed.invitation?.locationId) ?? structuredNext.locations.find(item=>item.id==="cafe");
          structuredNext = makeLifeInvitation(structuredNext, {
            proposedBy: "character",
            characterId: target.id, playerId: PLAYER_ID, proposedAt: proposedDate.toISOString(),
            locationId: location?.id, locationName: location?.name, activity: parsed.invitation.activity, reason: parsed.invitation.reason || undefined,
            kind: "appointment", durationMinutes: parsed.invitation.durationMinutes,
          });
          setNotice(target.name+"主动提出邀约。请在「邀约活动」中确认、拒绝或调整；未确认前不会更改日程。");
        } else {
          setNotice(target.name+"提出的邀约时间无效或已经过去，因此没有写入日程。");
        }
      }
      if (settings.enableCharacterAutonomy && settings.enableFollowRequestTool && parsed.followRequest) {
        const playerNow = resolveActorLifeNow(getActorClock(structuredNext, "player", PLAYER_ID));
        const characterNow = resolveActorLifeNow(getActorClock(structuredNext, "character", target.id));
        const playerPresence = structuredNext.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === PLAYER_ID);
        structuredNext = makeLifeInvitation(structuredNext, {
          proposedBy: "character",
          characterId: target.id, playerId: PLAYER_ID,
          proposedAt: new Date(Math.max(playerNow.getTime(), characterNow.getTime()) + 60_000).toISOString(),
          locationId: playerPresence?.actualLocationId ?? undefined,
          locationName: playerPresence?.actualLocationName ?? undefined,
          activity: "申请陪伴并跟随你的行程" + (parsed.followRequest.reason ? "（" + parsed.followRequest.reason + "）" : ""),
          kind: "follow-request", durationMinutes: parsed.followRequest.durationMinutes,
        });
        setNotice(target.name + "提出了陪伴申请；你可以在「邀约活动」中确认或拒绝。");
      }
      const hasStructuredChanges = structuredNext !== stateRef.current;
      const replyAt = new Date().toISOString();
      // 动作一轮只出**一张**卡片（整段动作合并在内）；对白保持独立气泡按段显示。
      const actionText = (parsed.action ?? "").trim();
      const dialogueSegments = preserveLifeDialogueSegments(parsed.dialogues);
      const replyMessages: LifeSceneMessage[] = [
        ...(actionText ? [{ id: notificationResponsePrefix ? notificationResponsePrefix + "-action" : id("turn-action"), sceneId: turnScene.id, speakerType: "character" as const, speakerId: target.id, speakerName: target.name, role: "character" as const, action: actionText, dialogue: "", createdAt: replyAt, ...(pendingTurn ? { replyToMessageId: pendingTurn.messageId } : {}) }] : []),
        ...dialogueSegments.map((dialogue, index) => ({ id: notificationResponsePrefix ? notificationResponsePrefix + "-dialogue-" + index : id("turn-dialogue"), sceneId: turnScene.id, speakerType: "character" as const, speakerId: target.id, speakerName: target.name, role: "character" as const, dialogue, createdAt: replyAt, ...(pendingTurn ? { replyToMessageId: pendingTurn.messageId } : {}) })),
      ];
      if (!replyMessages.length) replyMessages.push({ id: id("turn"), sceneId: turnScene.id, speakerType: "character", speakerId: target.id, speakerName: target.name, role: "character", dialogue: "", createdAt: replyAt, ...(pendingTurn ? { replyToMessageId: pendingTurn.messageId } : {}) });
      pushSceneMessages(replyMessages, structuredNext);
      if (hasStructuredChanges && typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
      if (forceReaction) {
        recordLifeDiagnostic({ source: "通知回复", event: "生活现场已生成角色回应", status: "ok", detail: target.name + " 已完成通知回复后的现场回应。", meta: { sceneId: turnScene.id, characterId: target.id, action: Boolean(actionText), dialogueCount: dialogueSegments.length } });
        setNotice(target.name + "已回应最近的互动。");
      }
      const remainingResponders = responseQueue?.length ? responseQueue.slice(1) : plannedResponders.slice(1);
      if (remainingResponders.length) {
        recordLifeDiagnostic({ source: "生活现场", event: "追加角色回应队列", status: "info", detail: "按角色 ID 去重后依次处理其他回应角色。", meta: { sceneId: turnScene.id, completedCharacterId: target.id, queuedCharacterIds: remainingResponders } });
        const nextResult = await sendSceneTurn(undefined, true, undefined, remainingResponders, pendingTurn ?? undefined);
        if (nextResult === "failed") recordLifeDiagnostic({ source: "生活现场", event: "追加角色回应未全部完成", status: "warning", detail: "至少一名后续角色未能完成回应，已完成的回应会保留。", meta: { sceneId: turnScene.id, completedCharacterId: target.id, remainingResponders } });
      }
      // Persist one shared event for the whole player turn, after all queued responders
      // have finished. This keeps the random, specified and awareness responders in
      // one co-experience with every actual participant instead of saving only the first.
      if (!responseQueue?.length && settings.saveConfirmedEventsToMemory && (userText.trim() || userAction.trim())) {
        const latest = stateRef.current;
        const responses = latest.sceneMessages
          .slice(turnMessageStartIndex)
          .filter(message => message.sceneId === turnScene.id && message.speakerType === "character")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const responders = [...new Set(responses.map(message => resolveLifeCharacterId(message.speakerId)).filter(Boolean))];
        if (responders.length) {
          const responseDetails = responders.map(characterId => {
            const actor = characters.find(character => character.id === characterId);
            const messages = responses.filter(message => resolveLifeCharacterId(message.speakerId) === characterId);
            const actions = messages.map(message => message.action?.trim()).filter(Boolean);
            const dialogue = messages.map(message => message.dialogue?.trim()).filter(Boolean);
            return { characterId, name: actor?.name || messages[0]?.speakerName || "角色", actions, dialogue };
          });
          const eventId = id("event"), eventNow = new Date().toISOString();
          const participantIds = ["player", ...responders];
          const responseText = responseDetails.map(item => `${item.name}${item.actions.length ? "行动：“" + item.actions.join("；").slice(0, 240) + "”" : ""}${item.dialogue.length ? "说：“" + item.dialogue.join("” / “").slice(0, 300) + "”" : ""}`).join("；");
          const event = { id: eventId, kind: "activity" as const, status: "completed" as const, locationId: turnScene.locationId, locationName: turnScene.locationName, participantIds, title: userAction.trim() && !userText.trim() ? "生活场景行动" : "生活场景互动", details: `${playerName}行动：${userAction || "无"}\n{{user}}对白：${userText || "无"}\n${responseText}`, createdAt: eventNow, updatedAt: eventNow, completedAt: eventNow };
          const fact = `在${turnScene.locationName}，{{user}}${userAction.trim() ? "行动：“" + userAction.trim().slice(0, 120) + "”" : ""}${userText.trim() ? "说：“" + userText.trim().slice(0, 120) + "”" : ""}；${responseText}。`;
          commit({ ...latest, events: [event, ...latest.events], memories: [{ id: id("memory"), eventId, occurredAt: eventNow, participants: participantIds, fact }, ...latest.memories].slice(0, 500) });
        }
      }
      return "completed";
    } catch (error) {
      if (forceReaction) recordLifeDiagnostic({ source: "通知回复", event: "现场回应生成失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { sceneId: turnScene.id, characterId: target.id } });
      setNotice(error instanceof Error ? `角色生成失败：${error.message}` : "角色生成失败，请检查聊天模型配置。");
      return "failed";
    } finally {
      lifeTurn.end();
      // Keep the composer locked until the root turn has finished every queued responder
      // and persisted the single grouped shared-event record.
      if (!responseQueue?.length) {
        if (pendingTurn) {
          pendingSceneTurnsRef.current = pendingSceneTurnsRef.current.filter(turn => turn.messageId !== pendingTurn.messageId);
          savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
          clearActiveLifeSceneTurn(pendingTurn.messageId);
          setPendingSceneQueueVersion(value => value + 1);
        }
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const sendSceneTurnRef = useRef(sendSceneTurn);
  sendSceneTurnRef.current = sendSceneTurn;

  useEffect(() => {
    if (!ready || sceneTurnQueueRestoredRef.current) return;
    sceneTurnQueueRestoredRef.current = true;
    pendingSceneTurnsRef.current = recoverPendingLifeSceneTurns();
    setPendingSceneQueueVersion(value => value + 1);
  }, [ready]);

  useEffect(() => {
    if (!ready || busy || !sceneTurnQueueRestoredRef.current || sceneTurnDrainScheduledRef.current) return;
    while (pendingSceneTurnsRef.current.length) {
      const next = pendingSceneTurnsRef.current[0];
      const scene = stateRef.current.scenes.find(item => item.id === next.sceneId);
      const hasPlayerMessage = stateRef.current.sceneMessages.some(message => message.id === next.messageId);
      const hasResponse = stateRef.current.sceneMessages.some(message => message.replyToMessageId === next.messageId);
      if (!scene || !hasPlayerMessage || hasResponse) {
        pendingSceneTurnsRef.current.shift();
        savePendingLifeSceneTurns(pendingSceneTurnsRef.current);
        setPendingSceneQueueVersion(value => value + 1);
        continue;
      }
      sceneTurnDrainScheduledRef.current = true;
      setActiveLifeSceneTurn(next);
      window.setTimeout(() => {
        sceneTurnDrainScheduledRef.current = false;
        void sendSceneTurnRef.current?.(undefined, false, undefined, undefined, next);
      }, 0);
      return;
    }
  }, [ready, busy, pendingSceneQueueVersion]);

  useEffect(() => {
    if (!ready) return;
    const resumePendingReply = () => {
      const pending = peekPendingLifeSceneReply();
      if (!pending) return;
      pendingNotificationSceneReplyRef.current = pending;
      focusScene(pending.sceneId);
      setSelectedSpeakerId(pending.characterId);
    };
    const onNotificationReply = () => resumePendingReply();
    window.addEventListener("life-scene-notification-reply", onNotificationReply);
    resumePendingReply();
    return () => window.removeEventListener("life-scene-notification-reply", onNotificationReply);
  }, [ready, focusScene]);

  useEffect(() => {
    const onQueueUpdated = () => refreshNotificationReplyQueue(value => value + 1);
    window.addEventListener("life-scene-notification-queue-updated", onQueueUpdated);
    return () => window.removeEventListener("life-scene-notification-queue-updated", onQueueUpdated);
  }, []);
  useEffect(() => {
    if (!ready || busy) return;
    const pending = pendingNotificationSceneReplyRef.current ?? peekPendingLifeSceneReply();
    if (!pending) return;
    pendingNotificationSceneReplyRef.current = pending;
    const scene = stateRef.current.scenes.find(item => item.id === pending.sceneId);
    const participantStillPresent = scene?.participants.some(participant => participant.ownerType === "character" && participant.ownerId === pending.characterId && participant.activity !== "离开");
    if (!scene || scene.status !== "active" || !participantStillPresent) {
      const reason = !scene || scene.status !== "active" ? "通知回复对应的生活现场已不存在或已结束。" : "通知回复对应的角色已不在该现场。";
      failPendingLifeSceneReply(pending.replyId, reason);
      pendingNotificationSceneReplyRef.current = null;
      recordLifeDiagnostic({ source: "通知回复", event: "回复任务已终止", status: "warning", detail: reason, meta: { replyId: pending.replyId, sceneId: pending.sceneId, characterId: pending.characterId } });
      refreshNotificationReplyQueue(value => value + 1);
      return;
    }
    if (selectedLocationId !== scene.locationId) { setSelectedLocationId(scene.locationId); return; }
    if (selectedSpeakerId !== pending.characterId) { setSelectedSpeakerId(pending.characterId); return; }
    if (!immersiveScene) { setTab("home"); setSceneView(true); return; }
    if (activeScene?.id !== pending.sceneId) return;
    if (pending.status === "processing") {
      const processingExpiry = (pending.processingAt || Date.now()) + 90_500;
      const timer = window.setTimeout(() => { refreshNotificationReplyQueue(value => value + 1); }, Math.max(1_000, processingExpiry - Date.now()));
      return () => window.clearTimeout(timer);
    }
    const retryAt = pending.nextAttemptAt || 0;
    if (retryAt > Date.now()) {
      const timer = window.setTimeout(() => { pendingNotificationSceneReplyRef.current = pending; refreshNotificationReplyQueue(value => value + 1); }, Math.min(retryAt - Date.now(), 60_000));
      return () => window.clearTimeout(timer);
    }
    const claimed = claimPendingLifeSceneReply(pending.replyId);
    if (!claimed) return;
    pendingNotificationSceneReplyRef.current = null;
    recordLifeDiagnostic({ source: "通知回复", event: "待处理回复已交给生活现场 AI", status: "info", detail: "已取得该回复的处理租约，开始生成角色回应。", meta: { replyId: pending.replyId, sceneId: pending.sceneId, characterId: pending.characterId, replyMode: pending.replyMode, attempt: claimed.attempts } });
    const leaseHeartbeat = window.setInterval(() => {
      try { renewPendingLifeSceneReply(pending.replyId); }
      catch (error) { recordLifeDiagnostic({ source: "通知回复", event: "回复处理租约续期失败", status: "warning", detail: error instanceof Error ? error.message : String(error), meta: { replyId: pending.replyId, sceneId: pending.sceneId } }); }
    }, 30_000);
    void (async () => {
      try {
        const outcome = await sendSceneTurn(undefined, true, pending.replyId);
        if (outcome === "completed") {
          acknowledgePendingLifeSceneReply(pending.replyId);
          recordLifeDiagnostic({ source: "通知回复", event: "回复队列已确认完成", status: "ok", detail: "角色回应已成功写入生活现场，队列任务已确认。", meta: { replyId: pending.replyId, sceneId: pending.sceneId, attempt: claimed.attempts } });
        } else {
          const reason = outcome === "deferred" ? "当前有其他回合占用，等待空闲后重试。" : "本次角色回应未成功完成，保留任务并按退避策略重试。";
          retryPendingLifeSceneReply(pending.replyId, reason, Date.now(), outcome !== "deferred");
          refreshNotificationReplyQueue(value => value + 1);
          recordLifeDiagnostic({ source: "通知回复", event: outcome === "deferred" ? "回复处理延期" : "回复处理失败待重试", status: outcome === "deferred" ? "warning" : "error", detail: reason, meta: { replyId: pending.replyId, sceneId: pending.sceneId, attempt: claimed.attempts } });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try { retryPendingLifeSceneReply(pending.replyId, detail); } catch { /* keep the processing lease; recovery will retry after it expires */ }
        recordLifeDiagnostic({ source: "通知回复", event: "回复处理出现未捕获异常", status: "error", detail, meta: { replyId: pending.replyId, sceneId: pending.sceneId, attempt: claimed.attempts } });
        refreshNotificationReplyQueue(value => value + 1);
      } finally { window.clearInterval(leaseHeartbeat); }
    })();
  }, [activeScene?.id, immersiveScene, selectedLocationId, selectedSpeakerId, busy, ready, sendSceneTurn, refreshNotificationReplyQueue]);

  const importWorldbookLocations = async () => {
    if (locationImportBusy) return;
    const character = characters.find(item => item.id === locationImportCharacterId);
    if (!character) { setNotice("请先选择要提取地点的角色卡。"); return; }
    const importedAt = new Date().toISOString();
    const sourceMap = new Map<string, import("@/lib/life/life-types").LifeLocationSourceRef>();
    const sourceBlocks: string[] = [];
    const cardKey = "character-card:" + character.id;
    sourceMap.set(cardKey, { sourceKey: cardKey, kind: "character-card", characterId: character.id, characterName: character.name, importedAt });
    sourceBlocks.push(["SOURCE_KEY: " + cardKey, "SOURCE_TYPE: character-card", "CHARACTER: " + character.name, "CONTENT:", [character.persona, character.personality, ...(character.tags ?? [])].filter(Boolean).join("\n")].join("\n"));
    let enabledEntries = 0, disabledEntries = 0, truncatedEntries = 0, usedChars = sourceBlocks[0].length;
    for (const book of worldBooks.filter(item => locationImportWorldBookIds.includes(item.id))) {
      for (const entry of book.entries ?? []) {
        if (entry.disable) { disabledEntries++; continue; }
        if (!entry.content?.trim() && !entry.comment?.trim() && !entry.key?.trim()) continue;
        if (enabledEntries >= 80 || usedChars >= 36000) { truncatedEntries++; continue; }
        const sourceKey = "worldbook:" + book.id + ":" + entry.uid;
        sourceMap.set(sourceKey, { sourceKey, kind: "worldbook", characterId: character.id, characterName: character.name, worldBookId: book.id, worldBookName: book.name, entryUid: entry.uid, entryComment: [entry.comment, entry.key].filter(Boolean).join(" / ").slice(0, 240), importedAt });
        const block = ["SOURCE_KEY: " + sourceKey, "SOURCE_TYPE: worldbook", "WORLD_BOOK: " + book.name, "ENTRY_COMMENT: " + (entry.comment || ""), "ENTRY_KEYWORDS: " + (entry.key || ""), "CONTENT:", (entry.content || "").slice(0, 5000)].join("\n");
        sourceBlocks.push(block); usedChars += block.length; enabledEntries++;
      }
    }
    if (!enabledEntries && !character.persona?.trim() && !character.personality?.trim() && !(character.tags ?? []).length) { setNotice("所选角色卡和世界书没有可读取的设定内容。"); return; }
    setLocationImportBusy(true);
    setNotice("正在分析「" + character.name + "」的角色卡与 " + enabledEntries + " 条世界书条目，识别地点、别名和空间设定……");
    try {
      const session = createLifeChatSession(character.id, character.name);
      const prompt: ChatMessage = {
        id: id("life-location-import"), sessionId: session.id, role: "user", status: "sent", createdAt: importedAt,
        content: [
          "你是生活系统的世界观地点整理器。请从给定角色卡和世界书原文中提取明确存在的具体地点，输出严格 JSON 数组，不要 Markdown 或解释。",
          "每个地点对象字段：name（规范名称）、aliases（原文别称）、description（空间环境事实）、atmosphere（氛围）、layout（空间布局）、props（原文提及或可合理补全的道具数组）、relation（own-home/shared-home/workplace/frequent/mentioned/unknown）、sourceKeys（支撑该地点的 SOURCE_KEY 数组）。",
          "只提取有明确专名或可稳定识别的具体地点，不要把普通名词直接扩成大量新地点。多个条目指向同一地点时合并；名字相似但不是同一地点时分开。不要因为角色去过某人的家，就认定那是角色自己的家。own-home 只在原文明确说是该角色自己的住所时使用；shared-home 只在原文明确说明该角色与玩家/用户同住时使用；若是与其他角色同住，不得误标为玩家家；工作单位标 workplace；常去地点标 frequent；仅被提及标 mentioned。",
          "地点描述、布局和道具优先引用原文。原文未说明的细节可以谨慎补全，但不得把推测写成设定事实；不要编造楼层、房间数量、经营者等关键设定。信息不足时字段留空。",
          "sourceKeys 必须逐字使用输入中真实存在的 SOURCE_KEY；每个地点至少关联一个来源。没有地点就返回 []。",
          "输入资料：\n\n" + sourceBlocks.join("\n\n").slice(0, 42000),
        ].join("\n\n"),
      };
      const history = loadChatMessages(session.id).filter(message => message.status !== "failed" && !message.isRetracted).slice(-8);
      const result = await generateOfflineChatCompletion(session, [...history, prompt], { appId: "life", appTags: lifeAppTags("schedule"), includeDirectChatEntries: false });
      const raw = result.content.trim(), first = raw.indexOf("["), last = raw.lastIndexOf("]");
      if (first < 0 || last <= first) throw new Error("模型没有返回有效地点 JSON。");
      const candidates = parseImportedLifeLocations(JSON.parse(raw.slice(first, last + 1)), sourceMap);
      if (!candidates.length) { setNotice("没有识别到带有可靠来源的具体地点。请检查所选资料；跳过禁用条目 " + disabledEntries + " 条" + (truncatedEntries ? "，另有 " + truncatedEntries + " 条超出读取上限" : "") + "。"); return; }
      const current = stateRef.current, merged = mergeImportedLifeLocations(current.locations, candidates);
      commit(syncScheduleLocationsToLibrary({ ...current, locations: merged.locations }));
      setNotice("地点导入完成：新增 " + merged.added + " 个，合并更新 " + merged.updated + " 个，补充来源 " + merged.sourcesAdded + " 条。启用条目 " + enabledEntries + " 条，跳过禁用条目 " + disabledEntries + " 条" + (truncatedEntries ? "；超出上限 " + truncatedEntries + " 条" : "") + "。");
    } catch (error) {
      setNotice("地点导入失败：" + (error instanceof Error ? error.message : "请检查模型配置后重试。"));
    } finally { setLocationImportBusy(false); }
  };

  const completeSelectedLocationProfile = async () => {
    if (!selectedLocation || locationImportBusy) return;
    const character = characters.find(item => item.id === locationImportCharacterId) ?? characters[0];
    if (!character) { setNotice("请先创建或导入一个角色卡，才能调用生活系统模型补全地点档案。"); return; }
    setLocationImportBusy(true); setNotice("正在补全「" + selectedLocation.name + "」的地点档案……");
    const locationSourceContext = (selectedLocation.sourceRefs ?? []).flatMap(source => {
      if (source.kind !== "worldbook" || !source.worldBookId || !source.entryUid) return [];
      const book = worldBooks.find(item => item.id === source.worldBookId);
      const entry = book?.entries.find(item => item.uid === source.entryUid);
      return entry ? [("世界书：" + (book?.name ?? source.worldBookName ?? "") + "；条目：" + (entry.comment || entry.key || "") + "\\n" + entry.content).slice(0, 6000)] : [];
    }).join("\\n\\n").slice(0, 16000);
    try {
      const session = createLifeChatSession(character.id, character.name);
      const prompt: ChatMessage = {
        id: id("life-location-profile"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "请为生活系统地点档案补全以下地点，严格只输出 JSON 对象，字段为 description、atmosphere、layout、props、aliases。",
          "地点名称：" + selectedLocation.name,
          "已有设定：" + [selectedLocation.description, selectedLocation.atmosphere, selectedLocation.layout, ...(selectedLocation.props ?? [])].filter(Boolean).join("\n"),
          "角色卡背景：" + [character.persona, character.personality, ...(character.tags ?? [])].filter(Boolean).join("\n").slice(0, 5000),
          "关联来源摘要：" + (selectedLocation.sourceRefs ?? []).map(source => [source.worldBookName, source.entryComment].filter(Boolean).join(" / ")).join("\n"),
          "原始世界书内容：" + (locationSourceContext || "无可读取的原始条目内容"),
          "要求：已有设定必须保留；不得凭空改变地点所属角色、世界观、用途或地理关系。若资料不足，只补充低承诺、通用且可被用户修改的环境氛围和空间结构，不要编造专属剧情事实。props 和 aliases 返回字符串数组。",
        ].join("\n\n"),
      };
      const history = loadChatMessages(session.id).filter(message => message.status !== "failed" && !message.isRetracted).slice(-6);
      const result = await generateOfflineChatCompletion(session, [...history, prompt], { appId: "life", appTags: lifeAppTags("schedule"), includeDirectChatEntries: false });
      const raw = result.content.trim(), first = raw.indexOf("{"), last = raw.lastIndexOf("}");
      if (first < 0 || last <= first) throw new Error("模型没有返回有效地点档案。");
      const parsed = JSON.parse(raw.slice(first, last + 1)) as Record<string, unknown>, current = stateRef.current;
      const locations = current.locations.map(location => {
        if (location.id !== selectedLocation.id) return location;
        const origins = location.fieldOrigins ?? {};
        const textValue = (value: unknown) => typeof value === "string" ? value.trim() : "";
        const arrayValue = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map(item => item.trim()).filter(Boolean).slice(0, 24) : [];
        const patch: Partial<LifeLocation> = {};
        for (const field of ["description", "atmosphere", "layout"] as const) {
          const generated = textValue(parsed[field]).slice(0, 1600);
          if (generated && (!location[field]?.trim() || origins[field] === "ai")) patch[field] = generated;
        }
        const props = arrayValue(parsed.props), aliases = arrayValue(parsed.aliases);
        if (props.length && (!location.props?.length || origins.props === "ai")) patch.props = props;
        if (aliases.length && (!location.aliases?.length || origins.aliases === "ai")) patch.aliases = aliases;
        return { ...location, ...patch, fieldOrigins: { ...origins,
          ...(patch.description ? { description: "ai" as const } : {}),
          ...(patch.atmosphere ? { atmosphere: "ai" as const } : {}),
          ...(patch.layout ? { layout: "ai" as const } : {}),
          ...(patch.props ? { props: "ai" as const } : {}),
          ...(patch.aliases ? { aliases: "ai" as const } : {}),
        } };
      });
      commit({ ...current, locations });
      setNotice("已补全地点档案。AI 生成字段会标记为可刷新；你手动修改并保存后将优先保留。");
    } catch (error) {
      setNotice("地点档案补全失败：" + (error instanceof Error ? error.message : "请稍后重试。"));
    } finally { setLocationImportBusy(false); }
  };

  const addLocation = () => {
    const name = newLocationName.trim();
    if (!name) return;
    const location: LifeLocation = { id: id("place"), name, description: "", atmosphere: "", layout: "", props: [], visibility: "public" };
    let next = { ...stateRef.current, locations: [...stateRef.current.locations, location] };
    next = appendLifeTimelineEntry(next, { category: "location", title: "创建了新地点：" + location.name, actorName: playerName, locationName: location.name });
    commit(next);
    setSelectedLocationId(location.id);
    setNewLocationName("");
  };

  const saveCharacterLocationHabit = (characterId: string) => {
    if (!selectedLocation) return;
    const habit = (locationHabitDrafts[characterId] ?? "").trim();
    const current = stateRef.current;
    const next = { ...current, locations: current.locations.map(location => {
      if (location.id !== selectedLocation.id) return location;
      const characterHabits = { ...(location.characterHabits ?? {}) };
      if (habit) characterHabits[characterId] = habit;
      else delete characterHabits[characterId];
      return { ...location, characterHabits };
    }) };
    commit(next);
    setNotice(habit ? `已保存角色在「${selectedLocation.name}」的地点习惯。` : "已清除该角色在此地点的自定义习惯。");
  };
  const updateSelectedLocationBackground = (patch: Partial<LifeLocation>) => {
    if (!selectedLocation) return;
    commit({
      ...stateRef.current,
      locations: stateRef.current.locations.map(location => location.id === selectedLocation.id ? { ...location, ...patch } : location),
    });
  };
  const handleLifeBackgroundUpload = async (file: File | undefined, scope: "global" | "location") => {
    if (!file) return;
    setBackgroundUploadBusy(scope);
    try {
      const backgroundImage = await compressLifeBackground(file);
      if (scope === "global") {
        patchSettings({ globalBackgroundImage: backgroundImage });
        setNotice("生活系统全局背景已保存；没有单独背景的地点聊天室会自动使用它。");
      } else {
        updateSelectedLocationBackground({ backgroundImage });
        setNotice("「" + (selectedLocation?.name ?? "当前地点") + "」的聊天室背景已保存。");
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "背景图片处理失败，请重试。");
    } finally {
      setBackgroundUploadBusy(null);
    }
  };

  const saveLocationDetails = () => {
    if (!selectedLocation) return;
    const previousName = selectedLocation.name.trim();
    const nextName = locationNameDraft.trim() || previousName;
    const renamed = nextName !== previousName;
    const now = new Date().toISOString();
    let next = {
      ...stateRef.current,
      locations: stateRef.current.locations.map(location => location.id !== selectedLocation.id ? location : {
        ...location,
        name: nextName,
        aliases: renamed ? [...new Set([...(location.aliases ?? []), previousName].filter(Boolean))] : location.aliases,
        description: locationDescriptionDraft.trim(),
        atmosphere: locationAtmosphereDraft.trim(),
        layout: locationLayoutDraft.trim(),
        props: locationPropsDraft.split(/[、,，;；\n]/).map(value => value.trim()).filter(Boolean),
        fieldOrigins: { ...(location.fieldOrigins ?? {}), description: "user" as const, atmosphere: "user" as const, layout: "user" as const, props: "user" as const },
      }),
    };
    if (renamed) next = {
      ...next,
      actorStates: next.actorStates.map(actor => actor.actualLocationId === selectedLocation.id ? { ...actor, actualLocationName: nextName, updatedAt: now } : actor),
      schedules: next.schedules.map(slot => slot.plannedLocationId === selectedLocation.id ? { ...slot, plannedLocationName: nextName, updatedAt: now } : slot),
      scenes: next.scenes.map(scene => scene.locationId === selectedLocation.id ? { ...scene, locationName: nextName, updatedAt: now } : scene),
    };
    commit(next);
    setLocationNameDraft(nextName);
    setLocationSaveFeedback(true);
    window.setTimeout(() => setLocationSaveFeedback(false), 2400);
    setNotice(`已保存「${nextName}」的地点名称、环境、空间布局与道具。${renamed ? " 当前地点状态、场景和日程地点名也已同步；历史生活记录保留当时的名称。" : " 后续场景互动会读取这些设定。"}`);
  };

  const addInvitation = async (event: FormEvent) => {
    event.preventDefault();
    if (!inviteCharacterId || !inviteAt || !inviteActivity.trim() || busy) return;
    const character = characters.find(item => item.id === inviteCharacterId);
    const location = stateRef.current.locations.find(item => item.id === inviteLocationId);
    if (!character) return;
    const proposedAt = new Date(inviteAt);
    const base = stateRef.current;
    const playerNow = resolveActorLifeNow(getActorClock(base, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(base, "character", character.id));
    if (!Number.isFinite(proposedAt.getTime()) || proposedAt <= playerNow || proposedAt <= characterNow) {
      setNotice("邀约时间必须晚于你和角色各自的当前时间。");
      return;
    }
    const contacts = loadChatContacts();
    const sessions = loadChatSessions();
    const contact = contacts.find(item => item.characterId === character.id);
    const session = sessions.find(item => item.contactId === contact?.id && !item.isGroup) ?? createLifeChatSession(character.id, character.name);
    let next = makeLifeInvitation(base, {
      proposedBy: "player",
      characterId: character.id, playerId: PLAYER_ID, proposedAt: proposedAt.toISOString(),
      locationId: location?.id, locationName: location?.name, activity: inviteActivity.trim(), reason: inviteReason.trim() || undefined,
      kind: "appointment", durationMinutes: 60,
    });
    const invitation = next.invitations[0];
    next = appendLifeTimelineEntry(next, { category: "schedule", title: "你向" + character.name + "发起邀约", details: inviteActivity.trim() + " · " + proposedAt.toLocaleString("zh-CN") + (location?.name ? " · " + location.name : ""), actorId: PLAYER_ID, actorName: playerName, locationName: location?.name, sourceId: invitation.id });
    commit(next);
    setBusy(true);
    setNotice(`已向${character.name}发出邀约，正在根据 TA 的人设和当前日程等待回应……`);
    try {
      const previous = loadChatMessages(session.id, 12).filter(message => message.status !== "failed" && !message.isRetracted);
      const roleAgenda = base.schedules
        .filter(slot => slot.ownerType === "character" && slot.ownerId === character.id && new Date(slot.endAt).getTime() >= characterNow.getTime() - 60 * 60_000)
        .sort((a, b) => a.startAt.localeCompare(b.startAt))
        .slice(0, 12);
      const existingInvitations = base.invitations
        .filter(item => item.characterId === character.id)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 8);
      const relationshipMemories = base.memories
        .filter(memory => memory.participants.includes(character.id) && memory.participants.includes(PLAYER_ID))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, 8)
        .reverse();
      const recentLifeEvents = base.timeline
        .filter(entry => entry.actorId === character.id || entry.actorId === PLAYER_ID)
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, 8)
        .reverse();
      const prompt: ChatMessage = {
        id: id("life-invitation-response"), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "【生活 APP 邀约确认】",
          `玩家向你发出邀约：${inviteActivity.trim()}`,
          `时间：${proposedAt.toLocaleString("zh-CN")}`,
          `地点：${location?.name ?? "地点待定"}`,
          `邀约理由：${inviteReason.trim() || "未填写"}`,
          `你当前的现实时间：${characterNow.toLocaleString("zh-CN")}`,
          "【你自己的当前与近期日程】",
          ...(roleAgenda.length ? roleAgenda.map(slot => `- ${new Date(slot.startAt).toLocaleString("zh-CN")}–${new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}：${slot.title}；地点：${slot.plannedLocationName || "未确定"}；来源：${slot.source}${slot.source === "manual" ? "（优先尊重玩家手动安排）" : ""}`) : ["- 暂无已有日程记录，不要凭空补充固定承诺。"]),
          "【你和玩家已经形成的共同记忆】",
          ...(relationshipMemories.length ? relationshipMemories.map(memory => `- ${memory.fact}`) : ["- 没有可用的共同记忆，勿假定亲密程度或承诺。"]),
          "【近期邀约与承诺】",
          ...(existingInvitations.length ? existingInvitations.map(item => `- ${item.status}；${item.proposedBy === "player" ? "玩家发起" : "角色发起"}；${item.activity}；${new Date(item.proposedAt).toLocaleString("zh-CN")}；地点：${item.locationName || "未确定"}；理由：${item.reason || "无"}；回应：${item.responseReason || "无"}`) : ["- 没有既有邀约。"]),
          "【近期生活记录】",
          ...recentLifeEvents.map(entry => `- ${new Date(entry.occurredAt).toLocaleString("zh-CN")}；${entry.actorName || "参与者"}；${entry.title}${entry.details ? "；" + entry.details : ""}`),
          "请据此决定是否接受这次邀约。",
        ].join("\n"),
      };
      const inviteHistory = loadChatMessages(session.id).filter(message => message.status !== "failed" && !message.isRetracted);
      const result = await generateOfflineChatCompletion(session, [...inviteHistory, prompt], { appId: "life", appTags: lifeAppTags("invite"), includeDirectChatEntries: false });
      const tag = result.content.match(/<life_invitation_response\b([^>]*)\/?\s*>/i);
      const attribute = (source: string, name: string) => source.match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"))?.[1]?.trim() ?? "";
      const decision = attribute(tag?.[1] ?? "", "decision").toLowerCase();
      const reason = attribute(tag?.[1] ?? "", "reason").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").slice(0, 240);
      const current = stateRef.current;
      if (decision === "accept") {
        const resolution = resolveInvitationConfirmation(current, invitation.id);
        if (resolution.ok) {
          const confirmedState = { ...resolution.state, invitations: resolution.state.invitations.map(item => item.id === invitation.id ? { ...item, responseReason: reason || "角色接受了邀约。" } : item) };
          const logged = appendLifeTimelineEntry(confirmedState, { category: "schedule", title: character.name + "接受了你的邀约", details: invitation.activity + (reason ? " · " + reason : ""), actorId: character.id, actorName: character.name, locationName: invitation.locationName, sourceId: invitation.id });
          commit(logged);
          setNotice(`${character.name}答应了这次邀约。${reason ? " TA 的回应：" + reason : ""}`);
        } else {
          commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: resolution.notice, updatedAt: new Date().toISOString() } : item) });
          setNotice(`${character.name}愿意赴约，但排期未能成立：${resolution.notice}`);
        }
      } else {
        const declineReason = reason || (decision === "decline" ? "角色决定这次不赴约。" : "角色没有明确答应这次邀约，因此没有替 TA 自动确认。");
        let declinedState = { ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: declineReason, updatedAt: new Date().toISOString() } : item) };
        declinedState = appendLifeTimelineEntry(declinedState, { category: "schedule", title: character.name + "拒绝了你的邀约", details: invitation.activity + " · " + declineReason, actorId: character.id, actorName: character.name, locationName: invitation.locationName, sourceId: invitation.id });
        commit(declinedState);
        setNotice(`${character.name}没有接受这次邀约。${declineReason}`);
      }
    } catch (error) {
      const current = stateRef.current;
      commit({ ...current, invitations: current.invitations.map(item => item.id === invitation.id ? { ...item, status: "declined" as const, responseReason: "暂时无法取得角色回应，请稍后重新发起邀约。", updatedAt: new Date().toISOString() } : item) });
      setNotice(error instanceof Error ? `邀约已发出，但角色回应失败：${error.message}` : "邀约已发出，但角色回应失败。");
    } finally {
      setBusy(false);
    }
  };

  const resolveInvitationConfirmation = (base: VirtualLifeState, inviteId: string): { ok: boolean; state: VirtualLifeState; notice: string } => {
    const invite = base.invitations.find(item => item.id === inviteId && item.status === "proposed");
    if (!invite) return { ok: false, state: base, notice: "找不到仍待确认的邀约。" };
    const startsAt = new Date(invite.proposedAt);
    const durationMinutes = Math.max(15, Math.min(invite.durationMinutes ?? 60, 24 * 60));
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    const playerNow = resolveActorLifeNow(getActorClock(base, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(base, "character", invite.characterId));
    if (!Number.isFinite(startsAt.getTime()) || startsAt <= playerNow || startsAt <= characterNow) {
      return { ok: false, state: base, notice: "这个时间对你或角色来说已经过去了。请修改时间；不会为了赴约自动跳过时间。" };
    }
    const relevantOwners = invite.kind === "follow-request" ? new Set([invite.characterId]) : new Set([PLAYER_ID, invite.characterId]);
    const conflict = base.schedules.find(slot => relevantOwners.has(slot.ownerId) && ((slot.ownerType === "player" && invite.kind !== "follow-request" && slot.ownerId === PLAYER_ID) || (slot.ownerType === "character" && slot.ownerId === invite.characterId)) && (slot.kind === "appointment" || slot.source === "event") && new Date(slot.startAt) < endsAt && new Date(slot.endAt) > startsAt);
    if (conflict) return { ok: false, state: base, notice: "这个时段已经有另一项已确认的约定。请先调整时间，避免两件事情同时发生。" };
    let next = confirmLifeInvitation(base, inviteId);
    const confirmed = next.invitations.find(item => item.id === inviteId);
    if (!confirmed?.eventId) return { ok: false, state: next, notice: "邀约状态更新失败，没有建立日程。" };
    const makeSlot = (ownerType: LifeOwnerType, ownerId: string): LifeScheduleSlot => ({
      id: "invite-slot-" + confirmed.eventId + "-" + ownerType + "-" + ownerId,
      ownerType, ownerId, startAt: startsAt.toISOString(), endAt: endsAt.toISOString(),
      title: confirmed.kind === "follow-request" ? "陪伴玩家并跟随其行程" : confirmed.activity,
      kind: "appointment", source: "event",
      plannedLocationId: confirmed.kind === "follow-request" ? null : confirmed.locationId,
      plannedLocationName: confirmed.kind === "follow-request" ? "跟随玩家的实际地点" : confirmed.locationName,
      updatedAt: new Date().toISOString(),
    });
    if (confirmed.kind === "follow-request") {
      next = placeAppointmentInActorSchedule(next, makeSlot("character", confirmed.characterId));
    } else {
      next = placeAppointmentInActorSchedule(next, makeSlot("player", PLAYER_ID));
      next = placeAppointmentInActorSchedule(next, makeSlot("character", confirmed.characterId));
    }
    return { ok: true, state: next, notice: confirmed.kind === "follow-request"
      ? "陪伴申请已接受。约定时间开始后，TA会跟随你的实际地点；你仍可随时取消。"
      : "邀约已确认，双方的冲突时段已保留前后部分并插入约定；到达约定时间后，活动会自动开始。" };
  };

  const confirmInvitation = (inviteId: string) => {
    const base = stateRef.current;
    const result = resolveInvitationConfirmation(base, inviteId);
    if (!result.ok) { setNotice(result.notice); return; }
    const invite = base.invitations.find(item => item.id === inviteId);
    const character = invite ? characters.find(item => item.id === invite.characterId) : undefined;
    const logged = invite ? appendLifeTimelineEntry(result.state, {
      category: "schedule",
      title: invite.kind === "follow-request" ? (character?.name ?? "角色") + "的陪伴申请已被接受" : (character?.name ?? "角色") + "的邀约已确认",
      details: invite.activity + " · " + new Date(invite.proposedAt).toLocaleString("zh-CN"),
      actorId: invite.characterId, actorName: character?.name ?? "角色", locationName: invite.locationName, sourceId: invite.id,
    }) : result.state;
    commit(logged);
    setNotice(result.notice);
  };

  const beginEditInvitation = (inviteId: string) => {
    const invite = stateRef.current.invitations.find(item => item.id === inviteId);
    if (!invite || !["proposed", "confirmed"].includes(invite.status)) return;
    const localDate = new Date(invite.proposedAt);
    const localValue = Number.isFinite(localDate.getTime())
      ? new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      : "";
    setEditingInvitationId(invite.id);
    setEditInvitationDraft({
      activity: invite.activity,
      reason: invite.reason ?? "",
      proposedAt: localValue,
      locationId: invite.locationId ?? stateRef.current.locations.find(location => location.name === invite.locationName)?.id ?? stateRef.current.locations[0]?.id ?? "",
      durationMinutes: String(invite.durationMinutes ?? 60),
    });
  };

  const saveInvitationEdit = (inviteId: string) => {
    const current = stateRef.current;
    const invite = current.invitations.find(item => item.id === inviteId);
    if (!invite || !["proposed", "confirmed"].includes(invite.status)) return;
    const activity = editInvitationDraft.activity.trim();
    const start = new Date(editInvitationDraft.proposedAt);
    const duration = Math.max(15, Math.min(1440, Number(editInvitationDraft.durationMinutes) || 60));
    const end = new Date(start.getTime() + duration * 60_000);
    const location = current.locations.find(item => item.id === editInvitationDraft.locationId);
    if (!activity || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
      setNotice("请填写有效的活动内容和时间。原邀约没有改变。");
      return;
    }
    const playerNow = resolveActorLifeNow(getActorClock(current, "player", PLAYER_ID));
    const characterNow = resolveActorLifeNow(getActorClock(current, "character", invite.characterId));
    if (start <= playerNow || start <= characterNow) {
      setNotice("新时间必须晚于当前现实时间。原邀约没有改变。");
      return;
    }
    const linkedEvent = invite.status === "confirmed"
      ? current.events.find(event => event.id === invite.eventId && event.kind === "invitation")
      : undefined;
    if (invite.status === "confirmed" && !linkedEvent) {
      setNotice("找不到这条已确认邀约对应的日程事件，未修改任何内容。");
      return;
    }
    const linkedPrefix = linkedEvent ? "invite-slot-" + linkedEvent.id + "-" : "";
    const linkedSlots = linkedPrefix ? current.schedules.filter(slot => slot.id.startsWith(linkedPrefix)) : [];
    const linkedIds = new Set(linkedSlots.map(slot => slot.id));
    const ownerIds = invite.kind === "follow-request" ? [invite.characterId] : [PLAYER_ID, invite.characterId];
    for (const ownerId of ownerIds) {
      const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
      const conflict = current.schedules.find(slot =>
        slot.ownerId === ownerId && slot.ownerType === ownerType && !linkedIds.has(slot.id)
        && new Date(slot.startAt).getTime() < end.getTime()
        && new Date(slot.endAt).getTime() > start.getTime()
        && (slot.kind === "appointment" || slot.source === "manual" || slot.source === "event" || slot.source === "character-tool")
      );
      if (conflict) {
        setNotice("新时间与「" + conflict.title + "」冲突。原邀约和双方日程均未改变。");
        return;
      }
    }
    const now = new Date().toISOString();
    const updatedInvitation = {
      ...invite,
      activity,
      reason: editInvitationDraft.reason.trim() || undefined,
      proposedAt: start.toISOString(),
      durationMinutes: duration,
      locationId: invite.kind === "follow-request" ? undefined : location?.id,
      locationName: invite.kind === "follow-request" ? undefined : location?.name,
      updatedAt: now,
      ...(invite.status === "confirmed" ? { responseReason: (invite.responseReason ? invite.responseReason + " · " : "") + "邀约内容已由用户调整。" } : {}),
    };
    let next: VirtualLifeState = {
      ...current,
      invitations: current.invitations.map(item => item.id === invite.id ? updatedInvitation : item),
    };
    if (linkedEvent) {
      next = {
        ...next,
        events: next.events.map(event => event.id === linkedEvent.id ? {
          ...event, startsAt: start.toISOString(), endsAt: end.toISOString(), title: activity,
          locationId: invite.kind === "follow-request" ? undefined : location?.id,
          locationName: invite.kind === "follow-request" ? undefined : location?.name,
          updatedAt: now,
        } : event),
        schedules: next.schedules.filter(slot => !linkedIds.has(slot.id)),
      };
      for (const ownerId of ownerIds) {
        const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
        const slot: LifeScheduleSlot = {
          id: "invite-slot-" + linkedEvent.id + "-" + ownerType + "-" + ownerId,
          ownerType, ownerId, startAt: start.toISOString(), endAt: end.toISOString(),
          title: invite.kind === "follow-request" ? "陪伴玩家并跟随其行程" : activity,
          kind: "appointment", source: "event",
          plannedLocationId: invite.kind === "follow-request" ? null : location?.id ?? null,
          plannedLocationName: invite.kind === "follow-request" ? "跟随玩家的实际地点" : location?.name ?? null,
          updatedAt: now,
        };
        next = placeAppointmentInActorSchedule(next, slot);
      }
    }
    next = appendLifeTimelineEntry(next, {
      category: "schedule", title: "重新安排邀约：" + activity,
      details: start.toLocaleString("zh-CN") + " · " + (location?.name ?? (invite.kind === "follow-request" ? "跟随玩家" : "地点待定")),
      actorId: invite.characterId, actorName: characters.find(character => character.id === invite.characterId)?.name,
      locationName: location?.name, sourceId: invite.id,
    });
    commit(next);
    setEditingInvitationId(null);
    setNotice(invite.status === "confirmed" ? "邀约已调整，双方日程已同步。请记得把变更告知角色；当前系统不会自动发起第二轮角色同意流程。" : "邀约内容已更新。");
  };

  const cancelInvitation = (inviteId: string) => {
    const current = stateRef.current;
    const invite = current.invitations.find(item => item.id === inviteId && ["proposed", "confirmed"].includes(item.status));
    if (!invite) return;
    const event = invite.status === "confirmed" ? current.events.find(item => item.id === invite.eventId && item.kind === "invitation") : undefined;
    const prefix = event ? "invite-slot-" + event.id + "-" : "";
    const linkedSlots = prefix ? current.schedules.filter(slot => slot.id.startsWith(prefix)) : [];
    const linkedIds = new Set(linkedSlots.map(slot => slot.id));
    const now = new Date().toISOString();
    let next: VirtualLifeState = {
      ...current,
      invitations: current.invitations.map(item => item.id === inviteId ? { ...item, status: "cancelled" as const, updatedAt: now, responseReason: (item.responseReason ? item.responseReason + " · " : "") + "邀约已取消。" } : item),
      events: event ? current.events.map(item => item.id === event.id ? { ...item, status: "cancelled" as const, cancelledAt: now, updatedAt: now } : item) : current.events,
      schedules: current.schedules.filter(slot => !linkedIds.has(slot.id)),
    };
    if (event) {
      const startMs = new Date(event.startsAt ?? invite.proposedAt).getTime();
      const endMs = new Date(event.endsAt ?? (startMs + (invite.durationMinutes ?? 60) * 60_000)).getTime();
      for (const slot of linkedSlots) {
        const occupied = next.schedules.some(other => other.ownerType === slot.ownerType && other.ownerId === slot.ownerId && new Date(other.startAt).getTime() < endMs && new Date(other.endAt).getTime() > startMs);
        if (!occupied && Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
          next.schedules = [...next.schedules, {
            id: id("cancelled-invite-free-time"), ownerType: slot.ownerType, ownerId: slot.ownerId,
            startAt: new Date(startMs).toISOString(), endAt: new Date(endMs).toISOString(),
            title: "自由活动", kind: "free-time", source: "weekly-generation",
            plannedLocationId: slot.plannedLocationId, plannedLocationName: slot.plannedLocationName, updatedAt: now,
          }];
        }
      }
    }
    next = appendLifeTimelineEntry(next, { category: "schedule", title: "取消邀约：" + invite.activity, details: "已取消，不再占用双方的约定时段。", actorId: invite.characterId, locationName: invite.locationName, sourceId: invite.id });
    commit(next);
    setEditingInvitationId(null);
    setNotice("邀约已取消；相关日程已解除占用。");
  };

  const reuseInvitation = (inviteId: string) => {
    const invite = stateRef.current.invitations.find(item => item.id === inviteId);
    if (!invite) return;
    setInviteCharacterId(invite.characterId);
    setInviteActivity(invite.activity);
    setInviteReason(invite.reason ?? "");
    setInviteLocationId(invite.locationId ?? stateRef.current.locations.find(location => location.name === invite.locationName)?.id ?? "cafe");
    const d = new Date(invite.proposedAt);
    if (Number.isFinite(d.getTime())) {
      setInviteAt(new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
      setInviteAtEdited(true);
    }
    setEditingInvitationId(null);
    setNotice("已将这条邀约复制到创建表单。修改时间后即可重新发起。");
  };

  const declineInvitation = (inviteId: string) => {
    const base = stateRef.current;
    const invite = base.invitations.find(item => item.id === inviteId && item.status === "proposed");
    if (!invite) return;
    const character = characters.find(item => item.id === invite.characterId);
    const updated = {
      ...base,
      invitations: base.invitations.map(item => item.id === inviteId
        ? { ...item, status: "declined" as const, responseReason: "你暂时没有接受这项安排。", updatedAt: new Date().toISOString() }
        : item),
    };
    const logged = appendLifeTimelineEntry(updated, {
      category: "schedule",
      title: invite.kind === "follow-request" ? "你拒绝了" + (character?.name ?? "角色") + "的陪伴申请" : "你拒绝了" + (character?.name ?? "角色") + "的邀约",
      details: invite.activity, actorId: PLAYER_ID, actorName: playerName, locationName: invite.locationName, sourceId: invite.id,
    });
    commit(logged);
    setNotice("已记录你的决定，双方日程没有被更改。");
  };

  const updateManualPlan = (slot: LifeScheduleSlot, patch: Partial<Pick<LifeScheduleSlot, "title" | "startAt" | "endAt" | "plannedLocationName">>) => {
    const now = new Date().toISOString();
    const current = stateRef.current;
    const changedLocation = patch.plannedLocationName !== undefined;
    const normalizedLocationName = changedLocation ? patch.plannedLocationName?.trim() ?? "" : slot.plannedLocationName ?? "";
    const matchedLocation = changedLocation
      ? current.locations.find(location => location.name.trim() === normalizedLocationName)
      : undefined;
    const updated: LifeScheduleSlot = {
      ...slot,
      ...patch,
      plannedLocationName: changedLocation ? normalizedLocationName || null : slot.plannedLocationName,
      plannedLocationId: changedLocation ? matchedLocation?.id ?? null : slot.plannedLocationId,
      plannedLocationDeleted: changedLocation ? false : slot.plannedLocationDeleted,
      kind: patch.title === undefined ? slot.kind : /自由活动|自由时间|空闲|待安排/.test(patch.title.trim()) ? "free-time" : slot.kind === "free-time" ? "special" : slot.kind,
      source: slot.source === "event" ? "event" : "manual",
      updatedAt: now,
    };

    // Confirmed appointments are one shared event represented by multiple
    // participant slots. Editing only one slot would desynchronize the event,
    // the other participant, and the eventual scene/memory.
    const linkedEvent = slot.kind === "appointment" && slot.source === "event"
      ? current.events.find(event =>
          event.kind === "invitation"
          && slot.id.startsWith("invite-slot-" + event.id + "-")
        )
      : undefined;
    if (slot.kind === "appointment" && slot.source === "event" && !linkedEvent) {
      setNotice("找不到这条日程关联的邀约，未修改任何内容。");
      return;
    }
    if (linkedEvent) {
      const startMs = new Date(updated.startAt).getTime();
      const endMs = new Date(updated.endAt).getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
        setNotice("日程时间无效，结束时间必须晚于开始时间。已保留原日程。");
        return;
      }
      const eventSlotPrefix = "invite-slot-" + linkedEvent.id + "-";
      const linkedSlots = current.schedules.filter(item => item.id.startsWith(eventSlotPrefix));
      const linkedSlotIds = new Set(linkedSlots.map(item => item.id));
      const keepFollowLocation = linkedEvent.details === "follow-player";
      const expectedOwnerIds = linkedEvent.participantIds.filter(ownerId => !keepFollowLocation || ownerId !== PLAYER_ID);
      // Repair a missing participant slot while editing an existing appointment;
      // the shared event must never become a one-sided calendar entry.
      const participantSlots: LifeScheduleSlot[] = expectedOwnerIds.map(ownerId => {
        const ownerType: LifeOwnerType = ownerId === PLAYER_ID ? "player" : "character";
        const existing = linkedSlots.find(item => item.ownerId === ownerId && item.ownerType === ownerType);
        return existing ?? {
          id: eventSlotPrefix + ownerType + "-" + ownerId,
          ownerType,
          ownerId,
          startAt: linkedEvent.startsAt ?? slot.startAt,
          endAt: linkedEvent.endsAt ?? slot.endAt,
          title: keepFollowLocation ? "陪伴玩家并跟随其行程" : linkedEvent.title,
          kind: "appointment",
          source: "event",
          plannedLocationId: keepFollowLocation ? null : linkedEvent.locationId ?? null,
          plannedLocationName: keepFollowLocation ? "跟随玩家的实际地点" : linkedEvent.locationName ?? null,
          updatedAt: now,
        };
      });
      for (const participantSlot of participantSlots) {
        const conflict = current.schedules.find(other =>
          other.ownerType === participantSlot.ownerType
          && other.ownerId === participantSlot.ownerId
          && !linkedSlotIds.has(other.id)
          && new Date(other.startAt).getTime() < endMs
          && new Date(other.endAt).getTime() > startMs
          && (other.kind === "appointment" || other.source === "manual" || other.source === "event" || other.source === "character-tool")
        );
        if (conflict) {
          setNotice("这段时间与「" + conflict.title + "」冲突。已保留原约会和双方日程。");
          return;
        }
      }
      const nextEvent = {
        ...linkedEvent,
        startsAt: updated.startAt,
        endsAt: updated.endAt,
        title: updated.title,
        ...(changedLocation && !keepFollowLocation
          ? { locationId: matchedLocation?.id, locationName: normalizedLocationName || undefined }
          : {}),
        updatedAt: now,
      };
      let next: VirtualLifeState = {
        ...current,
        events: current.events.map(event => event.id === linkedEvent.id ? nextEvent : event),
        invitations: current.invitations.map(invitation => invitation.eventId === linkedEvent.id
          ? {
              ...invitation,
              proposedAt: updated.startAt,
              durationMinutes: Math.max(15, Math.min((endMs - startMs) / 60_000, 24 * 60)),
              activity: updated.title,
              ...(changedLocation && !keepFollowLocation
                ? { locationId: matchedLocation?.id, locationName: normalizedLocationName || undefined }
                : {}),
              updatedAt: now,
            }
          : invitation),
        schedules: current.schedules.filter(item => !linkedSlotIds.has(item.id)),
      };
      const slotsToUpdate: LifeScheduleSlot[] = participantSlots;
      for (const original of slotsToUpdate) {
        const nextSlot: LifeScheduleSlot = {
          ...original,
          title: updated.title,
          startAt: updated.startAt,
          endAt: updated.endAt,
          plannedLocationId: keepFollowLocation ? null : updated.plannedLocationId,
          plannedLocationName: keepFollowLocation ? "跟随玩家的实际地点" : updated.plannedLocationName,
          kind: "appointment",
          source: "event",
          updatedAt: now,
        };
        next = placeAppointmentInActorSchedule(next, nextSlot);
      }
      commit(next);
      return;
    }

    // Editing a plan must not leave a hole behind when its start/end moves.
    // Temporarily restore the old interval as free time, then let the insertion
    // helper split that filler wherever the edited plan overlaps it.
    const restoredOldInterval: LifeScheduleSlot = {
      ...slot,
      id: id("edited-plan-free-time"),
      title: "自由活动",
      kind: "free-time",
      source: "weekly-generation",
      updatedAt: now,
    };
    const withoutEditedSlot = {
      ...current,
      schedules: [
        ...current.schedules.filter(item => item.id !== slot.id),
        restoredOldInterval,
      ],
    };
    const inserted = insertManualLifeScheduleSlot(withoutEditedSlot, updated);
    if (inserted.conflict) {
      setNotice("这段时间与「" + inserted.conflict.title + "」冲突。已保留原日程，请调整时间后再试。");
      return;
    }
    if (inserted.error) {
      setNotice(inserted.error + " 已保留原日程。");
      return;
    }
    // 编辑改成新地点名时，把地点同步进地点库——否则场景/地点档案/AI 提示词都找不到它，
    // 表现为「行程地点改了却不生效」。这正是 syncScheduleLocationsToLibrary 的设计用途。
    commit(syncScheduleLocationsToLibrary(inserted.state));
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
  };

  const recordManualPlanEdit = (slot: LifeScheduleSlot) => {
    const current = stateRef.current.schedules.find(item => item.id === slot.id);
    if (!current) return;
    const fmtDateTime = (value: string) => new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    const next = appendLifeTimelineEntry(stateRef.current, { category: "schedule", title: "修改了日程：" + current.title, details: "计划时间：" + fmtDateTime(current.startAt) + "—" + fmtDateTime(current.endAt) + " · " + (current.plannedLocationName || "地点待定"), actorId: current.ownerId, actorName: actors.find(actor => actor.ownerId === current.ownerId && actor.ownerType === current.ownerType)?.name, locationName: current.plannedLocationName ?? undefined, sourceId: current.id });
    commit(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
  };

  const addManualPlan = (actor: ActorChoice) => {
    const now = actorNow(actor);
    const start = new Date(now); start.setMinutes(0, 0, 0); start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60_000);
    const current = actorState(actor);
    const locationName = current?.actualLocationName || state.locations.find(item => item.id === current?.actualLocationId)?.name || "家";
    const slot: LifeScheduleSlot = { id: id("manual-plan"), ownerType: actor.ownerType, ownerId: actor.ownerId, startAt: start.toISOString(), endAt: end.toISOString(), title: "新的日程", plannedLocationName: locationName, kind: "special", source: "manual", updatedAt: new Date().toISOString() };
    const inserted = insertManualLifeScheduleSlot(stateRef.current, slot);
    if (inserted.conflict) {
      setNotice("无法添加日程：与「" + inserted.conflict.title + "」时间冲突。请调整时间后再试。");
      return;
    }
    if (inserted.error) { setNotice(inserted.error); return; }
    commit(inserted.state);
    setNotice("已添加日程；系统自动为这段安排腾出了时间，并保留前后未受影响的行程。");
  };

  const deleteManualPlan = (slot: LifeScheduleSlot) => {
    if (slot.source !== "manual" && slot.source !== "character-tool") { setNotice("系统生成的计划可以编辑；目前只允许删除手动添加或角色主动调整的日程。"); return; }
    const current = stateRef.current;
    const now = new Date().toISOString();
    const restoredFreeTime: LifeScheduleSlot = {
      ...slot,
      id: id("restored-free-time"),
      title: "自由活动",
      kind: "free-time",
      source: "weekly-generation",
      updatedAt: now,
    };
    let next: VirtualLifeState = {
      ...current,
      schedules: [...current.schedules.filter(item => item.id !== slot.id), restoredFreeTime]
        .sort((a, b) => a.startAt.localeCompare(b.startAt)),
    };
    const owner = actors.find(item => item.ownerType === slot.ownerType && item.ownerId === slot.ownerId);
    next = appendLifeTimelineEntry(next, {
      category: "schedule",
      title: "删除日程：" + slot.title,
      details: fmt(new Date(slot.startAt)) + "–" + fmt(new Date(slot.endAt)) + " · 该时段已恢复为自由活动",
      actorId: slot.ownerId,
      actorName: owner?.name,
      locationName: slot.plannedLocationName ?? undefined,
      sourceId: slot.id,
    });
    commit(next);
    setNotice("已删除这条日程，该时段已恢复为自由活动，整日日程不会留下空洞。");
  };

  const goToCharacter = (character: Character) => {
    const current = stateRef.current;
    const presence = current.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
    const schedule = getCurrentActorSchedule(current, "character", character.id, resolveActorLifeNow(getActorClock(current, "character", character.id)));
    const placeName = presence?.actualLocationName || schedule?.plannedLocationName;
    if (!placeName) {
      setNotice(`还不知道${character.name}此刻在哪里；可以先查看 TA 的日程，或通过聊天向 TA 问问。`);
      openDaily("plans");
      return;
    }
    let next = current;
    let location = next.locations.find(item => item.id === presence?.actualLocationId && item.name === placeName)
      || next.locations.find(item => item.name.trim().toLocaleLowerCase() === placeName.trim().toLocaleLowerCase());
    if (!location) {
      location = { id: id("location"), name: placeName, description: "从角色当前动态定位到的地点", visibility: "public" };
      next = { ...next, locations: [...next.locations, location] };
    }
    const now = new Date().toISOString();
    next = upsertActorState(next, { ownerType: "player", ownerId: PLAYER_ID, activity: "正在去找" + character.name, actualLocationId: location.id, actualLocationName: location.name, actualLocationUntil: null, locationSource: "manual", manualSetAt: now, updatedAt: now });
    const existingRoom = findLifeSceneForLocation(next.scenes, location.id, location.name);
    const participants = [
      ...(existingRoom?.participants ?? []).filter(item =>
        !(item.ownerType === "player" && item.ownerId === PLAYER_ID)
        && !(item.ownerType === "character" && item.ownerId === character.id)),
      { ownerType: "player" as const, ownerId: PLAYER_ID, activity: "正在去找" + character.name, awarenessByActorId: { [character.id]: "aware" as const } },
      { ownerType: "character" as const, ownerId: character.id, activity: presence?.activity || schedule?.title || "在这里活动", awarenessByActorId: { [PLAYER_ID]: "aware" as const } },
    ];
    const destinationRoom: LifeSceneState = existingRoom
      ? { ...existingRoom, locationId: location.id, locationName: location.name, eventId: undefined, status: "active", updatedAt: now, participants }
      : { id: id("scene"), locationId: location.id, locationName: location.name, startedAt: now, updatedAt: now, status: "active", participants, lastSettledEventIds: [] };
    next = upsertLifeScene(next, destinationRoom);
    next = appendLifeTimelineEntry(next, { category: "location", title: "你去找" + character.name, details: "前往" + location.name + (presence?.actualLocationName ? "（角色记录的当前位置）" : "（根据角色日程推测）"), actorId: PLAYER_ID, actorName: playerName, locationName: location.name });
    commit(next);
    setSelectedLocationId(location.id);
    setSelectedCharacterIds(ids => ids.includes(character.id) ? ids : [...ids, character.id]);
    setNotice(`已前往「${location.name}」，并将${character.name}加入当前互动场景。若地点来自日程推测，实际位置仍需角色或场景确认。`);
    setTab("home");
  };

  const themePresets = {
    "warm-paper": { label: "暖米棕纸感", gradient: "from-[#fbf4e9] via-[#f7efe4] to-[#ead9c6] text-stone-800", accent: "#b88768", palette: {"--life-surface-rgb":"250 244 235","--life-strong-rgb":"255 251 245","--life-soft-rgb":"239 225 210","--life-border-rgb":"217 194 174","--life-text":"#514237","--life-muted":"#79695c","--life-faint":"#9a8879","--life-overlay":"rgba(255,252,246,.985)"} },
    "sage": { label: "鼠尾草绿", gradient: "from-[#eaf0e8] via-[#f3f4eb] to-[#dce8dc] text-stone-800", accent: "#65876b", palette: {"--life-surface-rgb":"239 244 235","--life-strong-rgb":"248 250 245","--life-soft-rgb":"222 233 218","--life-border-rgb":"166 190 161","--life-text":"#354438","--life-muted":"#596c5b","--life-faint":"#718473","--life-overlay":"rgba(245,249,241,.98)"} },
    "rose": { label: "柔和玫瑰", gradient: "from-[#fff0f1] via-[#fff8f6] to-[#f7e3e5] text-stone-800", accent: "#c66b82", palette: {"--life-surface-rgb":"255 242 243","--life-strong-rgb":"255 249 248","--life-soft-rgb":"250 224 228","--life-border-rgb":"231 183 191","--life-text":"#65464b","--life-muted":"#89676c","--life-faint":"#a17d82","--life-overlay":"rgba(255,247,247,.985)"} },
    "night-sky": { label: "夜空深色", gradient: "from-slate-950 via-slate-900 to-indigo-950 text-slate-100", accent: "#a5b4fc", palette: {"--life-surface-rgb":"30 41 59","--life-strong-rgb":"15 23 42","--life-soft-rgb":"51 65 85","--life-border-rgb":"100 116 139","--life-text":"#f1f5f9","--life-muted":"#cbd5e1","--life-faint":"#94a3b8","--life-overlay":"rgba(15,23,42,.98)"} },
    "lavender": { label: "薰衣草梦境", gradient: "from-[#f4efff] via-[#f8f5ff] to-[#e6dcfa] text-stone-800", accent: "#8b72c7", palette: {"--life-surface-rgb":"247 243 255","--life-strong-rgb":"253 250 255","--life-soft-rgb":"232 222 250","--life-border-rgb":"199 183 231","--life-text":"#463b5e","--life-muted":"#6e6187","--life-faint":"#9183a8","--life-overlay":"rgba(251,248,255,.985)"} },
    "ocean": { label: "海盐蓝调", gradient: "from-[#e8f4fa] via-[#f2f9fc] to-[#d4eaf4] text-slate-800", accent: "#4386a8", palette: {"--life-surface-rgb":"239 248 252","--life-strong-rgb":"250 253 255","--life-soft-rgb":"215 237 247","--life-border-rgb":"164 204 222","--life-text":"#304b5a","--life-muted":"#557282","--life-faint":"#7893a0","--life-overlay":"rgba(247,252,255,.985)"} },
    "matcha": { label: "抹茶奶霜", gradient: "from-[#edf3df] via-[#f7f8eb] to-[#dce8c4] text-stone-800", accent: "#788d43", palette: {"--life-surface-rgb":"245 248 231","--life-strong-rgb":"253 253 244","--life-soft-rgb":"226 235 200","--life-border-rgb":"188 204 151","--life-text":"#465137","--life-muted":"#68764f","--life-faint":"#87966e","--life-overlay":"rgba(251,252,242,.985)"} },
    "peach": { label: "蜜桃奶油", gradient: "from-[#fff0e7] via-[#fff8f1] to-[#f8daca] text-stone-800", accent: "#d17d5b", palette: {"--life-surface-rgb":"255 245 236","--life-strong-rgb":"255 251 245","--life-soft-rgb":"250 224 207","--life-border-rgb":"235 190 163","--life-text":"#604638","--life-muted":"#896653","--life-faint":"#a78572","--life-overlay":"rgba(255,250,244,.985)"} },
    "midnight": { label: "午夜极光", gradient: "from-[#101b2b] via-[#142638] to-[#173b43] text-slate-100", accent: "#6ee7c0", palette: {"--life-surface-rgb":"24 43 55","--life-strong-rgb":"13 30 43","--life-soft-rgb":"39 69 78","--life-border-rgb":"69 112 119","--life-text":"#e5f5f1","--life-muted":"#b3d4ce","--life-faint":"#8eb8b2","--life-overlay":"rgba(13,30,43,.985)"} },
  } as const;
  const activeTheme = themePresets[settings.sceneTheme as keyof typeof themePresets] ?? themePresets["warm-paper"];
  const themeClass = activeTheme.gradient;
  const lifePalette = activeTheme.palette;
  const themeAccentColor = activeTheme.accent;
  const effectiveAccentColor = settings.accentColorMode === "custom" ? settings.accentColor : themeAccentColor;
  const cssVars = { ...lifePalette, "--life-accent": effectiveAccentColor, "--life-opacity": settings.panelOpacity / 100, "--life-font": `${settings.dialogueFontSize}px`, "--life-narration-font": `${settings.narrationFontSize}px` } as unknown as CSSProperties;
  const playerActor = actors[0];
  const playerNow = actorNow(playerActor);
  const playerDayStart = new Date(playerNow); playerDayStart.setHours(0,0,0,0);
  const playerDayEnd = new Date(playerDayStart); playerDayEnd.setDate(playerDayEnd.getDate() + 1);
  const playerTodaySlots = state.schedules.filter(slot => slot.ownerType === "player" && slot.ownerId === PLAYER_ID && new Date(slot.startAt).getTime() < playerDayEnd.getTime() && new Date(slot.endAt).getTime() > playerDayStart.getTime()).sort((a,b)=>a.startAt.localeCompare(b.startAt));
  const playerPastSlots = playerTodaySlots.filter(slot => new Date(slot.endAt).getTime() <= playerNow.getTime());
  const playerCurrentSlot = playerTodaySlots.find(slot => new Date(slot.startAt).getTime() <= playerNow.getTime() && new Date(slot.endAt).getTime() > playerNow.getTime());
  const playerFutureSlots = playerTodaySlots.filter(slot => new Date(slot.startAt).getTime() > playerNow.getTime());
  const playerPresence = actorState(playerActor);
  const nearbyCharacters = characters.map(character => ({ character, presence: state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id) })).filter(item => !!playerPresence?.actualLocationId && item.presence?.actualLocationId === playerPresence.actualLocationId);
  const playerLocationId = playerPresence?.actualLocationId || playerCurrentSlot?.plannedLocationId || activeScene?.locationId || "home";
  // Reuse the hidden-home rule in all destination pickers, not only the location cards.
  const visibleLocations = state.locations.filter(location => {
    if (!location.id.startsWith("home-")) return true;
    const ownerId = location.id.slice("home-".length);
    return !state.locations.some(shared => shared.id !== location.id
      && (shared.id === "home" || shared.id.startsWith("home-"))
      && (shared.id === "home" || (shared.residents ?? []).length > 1)
      && (shared.residents ?? []).includes(ownerId));
  });
  const locationCards = visibleLocations.map(location => {
    const people = characters.map(character => {
      const presence = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === character.id);
      const currentSlot = getCurrentActorSchedule(state, "character", character.id, resolveActorLifeNow(getActorClock(state, "character", character.id)));
      const isActuallyHere = presence?.actualLocationId === location.id;
      const isExpectedHere = !presence?.actualLocationId && currentSlot?.plannedLocationId === location.id;
      return { character, activity: presence?.activity || currentSlot?.title || "正在自己的生活里", isActuallyHere, isExpectedHere };
    }).filter(person => person.isActuallyHere || person.isExpectedHere);
    const dynamicActivity = people.filter(person => person.isActuallyHere).map(person => person.activity).filter(Boolean);
    const inferredAtmosphere = dynamicActivity.length
      ? `现场有${dynamicActivity.join("、")}的生活动静。`
      : people.some(person => person.isExpectedHere) ? "日程显示有人可能会来这里，但实际在场尚未确认。" : "暂时没有记录到角色在场，环境保持安静。";
    const atmosphere = [location.atmosphere?.trim(), inferredAtmosphere].filter(Boolean).join(" ");
    return { location, people, atmosphere, isCurrent: location.id === playerLocationId };
  }).sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || b.people.filter(person => person.isActuallyHere).length - a.people.filter(person => person.isActuallyHere).length || a.location.name.localeCompare(b.location.name, "zh-CN"));
  const locationFolders = state.locationFolders ?? [];
  const locationMatchesFilters = (location: LifeLocation, search: string, folderFilter: string) => {
    const query = search.trim().toLocaleLowerCase();
    const text = [location.name, ...(location.aliases ?? []), location.description, location.atmosphere, location.layout, ...(location.props ?? [])].filter(Boolean).join(" ").toLocaleLowerCase();
    return (!query || text.includes(query))
      && (folderFilter === "all" || (location.folderId || "unfiled") === folderFilter);
  };
  const filteredLocationCards = locationCards.filter(item => locationMatchesFilters(item.location, sceneLocationSearch, sceneLocationFolderFilter));
  const filteredLibraryLocations = visibleLocations.filter(location => locationMatchesFilters(location, libraryLocationSearch, libraryLocationFolderFilter));
  const libraryLocationGroups = new Map<string, typeof filteredLibraryLocations>();
  for (const location of filteredLibraryLocations) {
    const key = location.folderId || "unfiled";
    libraryLocationGroups.set(key, [...(libraryLocationGroups.get(key) ?? []), location]);
  }
  const locationCardGroups = new Map<string, typeof filteredLocationCards>();
  for (const item of filteredLocationCards) {
    const key = item.location.folderId || "unfiled";
    locationCardGroups.set(key, [...(locationCardGroups.get(key) ?? []), item]);
  }
  const locationFolderName = (folderId?: string) => folderId ? locationFolders.find(folder => folder.id === folderId)?.name || "未整理" : "未整理";
  const createLocationFolder = () => {
    setEditingFolderId(null);
    setFolderNameDraft("");
    setFolderDialogOpen(true);
  };
  const saveLocationFolder = () => {
    const cleanName = folderNameDraft.trim();
    if (!cleanName) { setNotice("请输入文件夹名称。"); return; }
    const current = stateRef.current;
    const folders = current.locationFolders ?? [];
    if (folders.some(folder => folder.id !== editingFolderId && folder.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase())) {
      setNotice("已经有同名文件夹了。");
      return;
    }
    const nextFolders = editingFolderId
      ? folders.map(folder => folder.id === editingFolderId ? { ...folder, name: cleanName } : folder)
      : [...folders, { id: id("location-folder"), name: cleanName }];
    commit({ ...current, locationFolders: nextFolders });
    setFolderDialogOpen(false);
    setEditingFolderId(null);
    setFolderNameDraft("");
    setNotice(editingFolderId ? "文件夹已重命名。" : "文件夹已创建。");
  };
  const deleteLocationFolder = (folderId: string) => {
    const current = stateRef.current;
    if (!(current.locationFolders ?? []).some(item => item.id === folderId)) return;
    commit({
      ...current,
      locationFolders: (current.locationFolders ?? []).filter(item => item.id !== folderId),
      locations: current.locations.map(location => location.folderId === folderId ? { ...location, folderId: undefined } : location),
    });
    setFolderDeleteConfirmId(null);
  };
  const moveSelectedLocations = () => {
    if (!selectedLocationIds.length) return;
    const folderId = batchFolderId === "unfiled" ? undefined : batchFolderId;
    const current = stateRef.current;
    commit({ ...current, locations: current.locations.map(location => selectedLocationIds.includes(location.id) ? { ...location, folderId } : location) });
    setSelectedLocationIds([]);
    setNotice("已整理 " + selectedLocationIds.length + " 个地点。");
  };
  const lifeTimeline = (state.timeline ?? []).filter(entry => {
    if (entry.category === "location" || entry.category === "scene") return settings.recordLocationChanges;
    if (entry.category === "action") return settings.recordCharacterActions;
    if (entry.category === "dialogue") return settings.recordSceneMessages;
    if (entry.category === "schedule") return settings.recordScheduleChanges;
    if (entry.category === "tool") return settings.recordToolCalls;
    if (entry.category === "social") return settings.recordSocialActivity;
    if (entry.category === "diary") return settings.recordDiaryActivity;
    if (entry.category === "chat") return settings.recordChatActivity;
    return true;
  }).slice().sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt));
  const timelineImageRefsKey = lifeTimeline.filter(entry => entry.imageMediaRef).map(entry => entry.id + ":" + entry.imageMediaRef).join("|");
  useEffect(() => {
    let alive = true;
    const urls: Record<string, string> = {};
    void Promise.all(lifeTimeline.filter(entry => entry.imageMediaRef).map(async entry => {
      const url = await loadMediaObjectUrl(entry.imageMediaRef!);
      if (url) urls[entry.id] = url;
    })).then(() => {
      if (!alive) { Object.values(urls).forEach(url => URL.revokeObjectURL(url)); return; }
      Object.values(timelineImageObjectUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
      timelineImageObjectUrlsRef.current = urls;
      setTimelineImageUrls(urls);
    });
    return () => { alive = false; };
  }, [timelineImageRefsKey]);
  useEffect(() => () => {
    Object.values(timelineImageObjectUrlsRef.current).forEach(url => URL.revokeObjectURL(url));
    timelineImageObjectUrlsRef.current = {};
  }, []);
  const generateTimelineImage = async (entry: LifeTimelineEntry) => {
    if (timelineImageBusyId) return;
    const imageSettings = loadImageGenerationSettings();
    if (!imageSettings.enabled) { setNotice("请先到「小手机设置 → 生图设置」启用并配置生图服务。"); return; }
    setTimelineImageBusyId(entry.id);
    setNotice("正在为这条生活记录生成图片……");
    try {
      const characterId = entry.actorId && entry.actorId !== PLAYER_ID && characters.some(character => character.id === entry.actorId) ? entry.actorId : undefined;
      const result = await generateImageFromConfiguredApi({
        description: [
          "为一条虚拟生活记录生成一张自然、温暖、有生活感的单帧场景插画或写实画面。",
          "不要拼贴、不要漫画分格、不要在图片中添加文字或水印。",
          "事件：" + entry.title,
          entry.details ? "事件细节：" + entry.details : "",
          entry.locationName ? "地点：" + entry.locationName : "",
          entry.actorName ? "主要人物：" + entry.actorName : "",
          "尽量表现记录中真实发生的瞬间，不要凭空添加无关人物或戏剧化情节。"
        ].filter(Boolean).join("\n"),
        characterId,
        participantIds: entry.actorId === PLAYER_ID ? ["__user__"] : (characterId ? [characterId] : []),
        appId: "life",
      });
      if (!result) throw new Error("生图服务未返回图片，请检查 API 配置。");
      const latest = stateRef.current;
      const currentEntry = latest.timeline.find(item => item.id === entry.id);
      if (!currentEntry) {
        await deleteMediaRef(result.mediaRef);
        throw new Error("这条生活记录已不存在，图片没有保存。");
      }
      commit({ ...latest, timeline: latest.timeline.map(item => item.id === entry.id ? { ...item, imageMediaRef: result.mediaRef } : item) });
      if (currentEntry.imageMediaRef && currentEntry.imageMediaRef !== result.mediaRef) {
        await deleteMediaRef(currentEntry.imageMediaRef).catch(() => undefined);
      }
      setNotice("生活记录图片已生成并保存。");
    } catch (error) {
      setNotice("生活记录生图失败：" + (error instanceof Error ? error.message : "未知错误"));
    } finally {
      setTimelineImageBusyId("");
    }
  };
  const recentLifeTimeline = lifeTimeline.slice(0, 5);
  const olderLifeTimeline = lifeTimeline.slice(5);
  const localDateKey = (value: string) => {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const experienceTimeline = lifeTimeline.filter(entry =>
    (experienceActorFilter === "all" || entry.actorId === experienceActorFilter)
    && (experienceCategoryFilter === "all" || entry.category === experienceCategoryFilter)
    && (!experienceDateFilter || localDateKey(entry.occurredAt) === experienceDateFilter)
  );
  const experienceGroups = new Map<string, typeof experienceTimeline>();
  for (const entry of experienceTimeline) {
    const groupKey = experienceGroupBy === "date" ? localDateKey(entry.occurredAt) || "日期未知" : entry.actorName || "未标记角色";
    const group = experienceGroups.get(groupKey) ?? [];
    group.push(entry);
    experienceGroups.set(groupKey, group);
  }
  const sortedExperienceGroups = [...experienceGroups.entries()].sort(([aKey, aItems], [bKey, bItems]) =>
    experienceGroupBy === "date"
      ? (bItems[0]?.occurredAt ?? "").localeCompare(aItems[0]?.occurredAt ?? "")
      : aKey.localeCompare(bKey, "zh-CN")
  );
  const pendingCharacterInvitations = state.invitations.filter(invite => invite.status === "proposed" && invite.proposedBy !== "player");

  const syncLifeSettle = (next: VirtualLifeState) => {
    commit(next);
    if (typeof window !== "undefined") window.dispatchEvent(new Event("life-force-sync"));
  };

  const findScheduleConflict = (slot: LifeScheduleSlot, all: LifeScheduleSlot[]): LifeScheduleSlot | undefined => {
    const start = Date.parse(slot.startAt);
    const end = Date.parse(slot.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Date.now()) return undefined;
    return all.find(other => other.id !== slot.id
      && other.ownerType === slot.ownerType && other.ownerId === slot.ownerId
      && Number.isFinite(Date.parse(other.startAt)) && Number.isFinite(Date.parse(other.endAt))
      && Date.parse(other.endAt) > Date.now()
      && start < Date.parse(other.endAt) && end > Date.parse(other.startAt));
  };

  const resolveScheduleConflict = (slot: LifeScheduleSlot, all: LifeScheduleSlot[]) => {
    const other = findScheduleConflict(slot, all);
    if (!other) return;
    const [earlier, later] = Date.parse(slot.startAt) <= Date.parse(other.startAt) ? [slot, other] : [other, slot];
    if (later.source === "event" || later.kind === "appointment") {
      setNotice("约会日程需在邀约页调整时间。");
      return;
    }
    const start = Date.parse(earlier.endAt);
    const laterStart = Date.parse(later.startAt);
    const laterEnd = Date.parse(later.endAt);
    if (!Number.isFinite(start) || !Number.isFinite(laterStart) || !Number.isFinite(laterEnd) || laterEnd <= laterStart) return;
    const duration = laterEnd - laterStart;
    const nowIso = new Date().toISOString();
    const current = stateRef.current;
    syncLifeSettle({
      ...current,
      schedules: current.schedules.map(item => item.id === later.id
        ? { ...item, startAt: new Date(start).toISOString(), endAt: new Date(start + duration).toISOString(), source: item.source === "event" ? "event" : "manual", updatedAt: nowIso }
        : item),
    });
    setNotice("已把「" + later.title + "」顺延到 " + fmtClock(new Date(start)) + "。");
  };



  if (!ready) return <main className="flex min-h-screen items-center justify-center bg-[#f7efe4] text-stone-500">正在打开生活档案…</main>;

  return <main style={{
    ...cssVars,
    ...(immersiveScene ? { height: "var(--life-viewport-height, 100dvh)" } : {}),
    "--life-global-bg": settings.globalBackgroundImage ? `url("${settings.globalBackgroundImage}")` : "none",
    "--life-global-bg-blur": `${Math.max(0, Math.min(18, settings.globalBackgroundBlur ?? 0))}px`,
    "--life-global-bg-brightness": String(Math.max(0.45, Math.min(1.4, (settings.globalBackgroundBrightness ?? 100) / 100))),
    "--life-global-bg-overlay": settings.globalBackgroundImage ? String(Math.max(0, Math.min(85, settings.globalBackgroundOverlay ?? 18)) / 100) : "0",
    "--life-scene-bg": sceneBackgroundLocation?.backgroundImage ? `url("${sceneBackgroundLocation.backgroundImage}")` : "var(--life-global-bg, none)",
    "--life-scene-bg-blur": `${Math.max(0, Math.min(18, sceneBackgroundLocation?.backgroundImage ? sceneBackgroundLocation.backgroundBlur ?? 0 : settings.globalBackgroundBlur ?? 0))}px`,
    "--life-scene-bg-brightness": String(Math.max(0.45, Math.min(1.4, ((sceneBackgroundLocation?.backgroundImage ? sceneBackgroundLocation.backgroundBrightness : settings.globalBackgroundBrightness) ?? 100) / 100))),
    "--life-scene-bg-overlay": (sceneBackgroundLocation?.backgroundImage || settings.globalBackgroundImage) ? String(Math.max(0, Math.min(85, (sceneBackgroundLocation?.backgroundImage ? sceneBackgroundLocation.backgroundOverlay : settings.globalBackgroundOverlay) ?? 18)) / 100) : "0",
    backgroundImage: settings.globalBackgroundImage ? "none" : undefined,
    backgroundColor: settings.globalBackgroundImage ? "transparent" : undefined,
  } as CSSProperties} className={`life-rose-garden ${immersiveScene ? "flex flex-col overflow-hidden overscroll-none" : "min-h-screen min-h-[100dvh] overflow-y-auto overscroll-y-contain touch-pan-y"} bg-gradient-to-br ${themeClass} ${settings.compactLayout ? "px-1.5 py-1.5 sm:px-3 sm:py-3" : "px-2 py-2 sm:px-4 sm:py-4"}`}>
    <style>{`
      .life-rose-garden { position: relative; isolation: isolate; width: 100%; max-width: 100vw; min-width: 0; box-sizing: border-box; overflow-x: hidden; }
      .life-rose-garden > *, .life-rose-garden section, .life-rose-garden article, .life-rose-garden .grid { min-width: 0; max-width: 100%; box-sizing: border-box; }
      .life-rose-garden input, .life-rose-garden textarea, .life-rose-garden select, .life-rose-garden button { max-width: 100%; box-sizing: border-box; }
      .life-rose-garden::before {
        content: ""; position: fixed; inset: -18px; z-index: -1; pointer-events: none;
        background-image: linear-gradient(rgba(255,250,245,var(--life-global-bg-overlay,.18)), rgba(255,250,245,var(--life-global-bg-overlay,.18))), var(--life-global-bg, none);
        background-position: center; background-size: cover; background-repeat: no-repeat;
        filter: blur(var(--life-global-bg-blur,0px)) brightness(var(--life-global-bg-brightness,1));
      }
      .life-scene-panel { position: relative; isolation: isolate; background-color: transparent !important; }
      .life-scene-panel::before {
        content: ""; position: absolute; inset: -8px; z-index: 0; pointer-events: none;
        background-image: linear-gradient(rgba(255,250,245,var(--life-scene-bg-overlay,.18)), rgba(255,250,245,var(--life-scene-bg-overlay,.18))), var(--life-scene-bg, none);
        background-position: center; background-size: cover; background-repeat: no-repeat;
        filter: blur(var(--life-scene-bg-blur,0px)) brightness(var(--life-scene-bg-brightness,1));
      }
      .life-scene-panel > * { position: relative; z-index: 1; }
      /* Tie the spatial transition to the real scene-state update; no artificial waiting screen. */
      @keyframes life-view-leave {
        from { opacity: 1; transform: scale(1); }
        to { opacity: 0; transform: scale(.982); }
      }
      @keyframes life-view-arrive {
        from { opacity: 0; transform: scale(1.018); }
        to { opacity: 1; transform: scale(1); }
      }
      ::view-transition-old(root) {
        animation: life-view-leave 220ms cubic-bezier(.4, 0, 1, 1) both;
      }
      ::view-transition-new(root) {
        animation: life-view-arrive 380ms cubic-bezier(.16, 1, .3, 1) both;
      }
      /* Scene transitions: spatial, responsive, and respectful of reduced-motion preferences. */
      @keyframes life-scene-enter {
        0% { opacity: 0; transform: translate3d(0, 14px, 0) scale(.985); filter: blur(3px); }
        65% { opacity: 1; transform: translate3d(0, -2px, 0) scale(1.003); filter: blur(0); }
        100% { opacity: 1; transform: translate3d(0, 0, 0) scale(1); filter: blur(0); }
      }
      @keyframes life-place-card-enter {
        from { opacity: 0; transform: translate3d(0, 12px, 0) scale(.99); }
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }
      .life-scene-panel { animation: life-scene-enter 420ms cubic-bezier(.2, .8, .2, 1) both; transform-origin: 50% 80%; }
      .life-place-list { animation: life-scene-enter 300ms cubic-bezier(.2, .8, .2, 1) both; }
      .life-place-card { animation: life-place-card-enter 360ms cubic-bezier(.2, .8, .2, 1) both; will-change: opacity, transform; }
      .life-place-card:active { transform: scale(.992); }
      @media (prefers-reduced-motion: reduce) {
        .life-scene-panel, .life-place-list, .life-place-card { animation: none !important; will-change: auto; }
        ::view-transition-old(root), ::view-transition-new(root) { animation: none !important; }
      }
      .life-scene-display-options[open] {
        position: fixed !important;
        inset: max(8px, env(safe-area-inset-top, 0px)) 8px max(8px, env(safe-area-inset-bottom, 0px)) !important;
        z-index: 2147483000 !important;
        display: flex;
        flex-direction: column;
        min-width: 0;
        max-height: none !important;
        overflow: hidden;
        padding: 12px;
        border-radius: 20px;
        border: 1px solid rgba(168, 137, 106, .35);
        background: var(--life-overlay);
        box-shadow: 0 24px 80px rgba(42, 34, 25, .28);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        pointer-events: auto;
      }
      .life-scene-display-options[open] > summary { flex: 0 0 auto; padding: 10px 8px; line-height: 1.5; overflow-wrap: anywhere; }
      .life-scene-display-options-body { min-width: 0; }
      .life-scene-display-options[open] .life-scene-display-options-body {
        flex: 1 1 auto; min-height: 0; max-height: none !important; overflow: auto;
        padding: 10px 4px 16px; overscroll-behavior: contain; -webkit-overflow-scrolling: touch;
      }
      .life-scene-display-options-body label { min-width: 0; overflow-wrap: anywhere; line-height: 1.5; }
      .life-scene-display-options-body input, .life-scene-display-options-body select, .life-scene-display-options-body textarea { box-sizing: border-box; max-width: 100%; min-width: 0; }
      .life-scene-display-options-body .grid { min-width: 0; }
      /* 原先这一组数值项写死 grid-cols-2：手机上每列仅约 160px，
         「气泡内边距（px）」这类标签被迫折行、输入框顶破格子、与相邻卡片重叠。
         窄屏改单列，并把每项压成「左标签 + 右窄输入框」一行，纵向高度也随之减半。 */
      @media (max-width: 559px) {
        .life-scene-display-options-body .grid-cols-2 { grid-template-columns: minmax(0, 1fr) !important; }
      }
      .life-scene-display-options-body .grid-cols-2 > label {
        display: flex; align-items: center; justify-content: space-between; gap: 8px;
        padding: 6px 8px !important;
      }
      .life-scene-display-options-body .grid-cols-2 > label > input,
      .life-scene-display-options-body .grid-cols-2 > label > select {
        flex: 0 0 auto; width: 74px; margin-top: 0 !important; padding: 4px 6px !important;
        text-align: center; font-variant-numeric: tabular-nums;
      }
      /* 字体这类长文本仍占整行，否则会把自己挤成一条缝 */
      .life-scene-display-options-body .grid-cols-2 > label.col-span-2 { flex-wrap: wrap; }
      .life-scene-display-options-body .grid-cols-2 > label.col-span-2 > input { flex: 1 1 100%; width: 100%; text-align: left; }
      @media (min-width: 560px) {
        .life-scene-display-options[open] { left: max(24px, calc((100vw - 720px) / 2)) !important; right: max(24px, calc((100vw - 720px) / 2)) !important; }
      }
    `}</style>
    <style>{`
      .life-rose-garden [class~="bg-white"],
.life-rose-garden [class~="bg-white/95"],
.life-rose-garden [class~="bg-white/90"],
.life-rose-garden [class~="bg-white/85"],
.life-rose-garden [class~="bg-white/80"],
.life-rose-garden [class~="bg-white/75"],
.life-rose-garden [class~="bg-white/70"],
.life-rose-garden [class~="bg-white/65"],
.life-rose-garden [class~="bg-white/60"],
.life-rose-garden [class~="bg-white/55"],
.life-rose-garden [class~="bg-white/50"],
.life-rose-garden [class~="bg-white/45"],
.life-rose-garden [class~="bg-white/40"],
.life-rose-garden [class~="bg-white/35"] { background-color: rgb(var(--life-strong-rgb) / .78) !important; }
      .life-rose-garden [class~="bg-[#efe1d2]"],
.life-rose-garden [class~="bg-[#f3e8dc]"],
.life-rose-garden [class~="bg-[#f0e3d5]"],
.life-rose-garden [class~="bg-[#e9d4c0]"],
.life-rose-garden [class~="bg-[#f5e9dd]/70"],
.life-rose-garden [class~="bg-stone-50/80"],
.life-rose-garden [class~="bg-stone-50/90"],
.life-rose-garden [class~="bg-stone-100"] { background-color: rgb(var(--life-soft-rgb) / .86) !important; }
      .life-rose-garden [class~="bg-[#fbf7f0]/90"],
.life-rose-garden [class~="bg-[#fbf7f0]"],
.life-rose-garden [class~="bg-[#fffaf5]"],
.life-rose-garden [class~="bg-[#fffaf3]/95"],
.life-rose-garden [class~="bg-[#fffdf9]"],
.life-rose-garden [class~="bg-[#fbf5ee]"],
.life-rose-garden [class~="bg-[#faf5ef]"],
.life-rose-garden [class~="bg-[#f8f4ee]"],
.life-rose-garden [class~="bg-[#f7efe4]"],
.life-rose-garden [class~="bg-[#f5ede4]"],
.life-rose-garden [class~="bg-[#f8f2eb]/85"] { background-color: rgb(var(--life-surface-rgb) / .94) !important; }
      .life-rose-garden [class~="border-white/80"],
.life-rose-garden [class~="border-white/70"],
.life-rose-garden [class~="border-stone-200"],
.life-rose-garden [class~="border-stone-200/80"],
.life-rose-garden [class~="border-stone-200/70"],
.life-rose-garden [class~="border-stone-200/60"],
.life-rose-garden [class~="border-stone-200/50"],
.life-rose-garden [class~="border-stone-300"],
.life-rose-garden [class~="border-[#d9c2ae]"],
.life-rose-garden [class~="border-[#d8c1ad]/60"] { border-color: rgb(var(--life-border-rgb) / .76) !important; }
      .life-rose-garden [class~="text-stone-800"], .life-rose-garden [class~="text-stone-700"], .life-rose-garden [class~="text-stone-600"] { color: var(--life-text) !important; }
      .life-rose-garden [class~="text-stone-500"] { color: var(--life-muted) !important; }
      .life-rose-garden [class~="text-stone-400"] { color: var(--life-faint) !important; }
      .life-rose-garden [class~="bg-[#b88768]"] { background-color: var(--life-accent) !important; }
      .life-rose-garden [class~="text-[#a4775d]"] { color: var(--life-accent) !important; }
      .life-rose-garden nav[aria-label="生活导航"] { background-color: rgb(var(--life-surface-rgb) / .96) !important; border-color: rgb(var(--life-border-rgb) / .76) !important; }
      .life-rose-garden nav[aria-label="生活导航"] button[aria-current="page"] { background-color: rgb(var(--life-strong-rgb) / .98) !important; color: var(--life-accent) !important; }
      .life-rose-garden input:not([type="checkbox"]):not([type="radio"]):not([type="color"]), .life-rose-garden select, .life-rose-garden textarea { color: var(--life-text); border-color: rgb(var(--life-border-rgb) / .85); }
      /* Theme every text utility, not just the three shades used by the original palette. */
      .life-rose-garden [class~="text-stone-900"],
      .life-rose-garden [class~="text-stone-800"],
      .life-rose-garden [class~="text-stone-700"],
      .life-rose-garden [class~="text-stone-600"],
      .life-rose-garden [class~="text-gray-900"],
      .life-rose-garden [class~="text-gray-800"],
      .life-rose-garden [class~="text-gray-700"],
      .life-rose-garden [class~="text-gray-600"] { color: var(--life-text) !important; }
      .life-rose-garden [class~="text-stone-500"],
      .life-rose-garden [class~="text-stone-400"],
      .life-rose-garden [class~="text-stone-300"],
      .life-rose-garden [class~="text-gray-500"],
      .life-rose-garden [class~="text-gray-400"],
      .life-rose-garden [class~="text-gray-300"] { color: var(--life-muted) !important; }
      /* Native controls and switches follow the selected scene palette. */
      .life-rose-garden input:not([type="color"]):not([type="checkbox"]):not([type="radio"]),
      .life-rose-garden select,
      .life-rose-garden textarea {
        background-color: rgb(var(--life-surface-rgb) / .96);
        color: var(--life-text) !important;
        caret-color: var(--life-accent);
      }
      .life-rose-garden input[type="checkbox"],
      .life-rose-garden input[type="radio"] { accent-color: var(--life-accent); }
      .life-rose-garden input[type="range"] { accent-color: var(--life-accent); }
      .life-rose-garden [role="switch"] {
        border-color: rgb(var(--life-border-rgb) / .9) !important;
        background-color: rgb(var(--life-soft-rgb) / .95);
      }
      .life-rose-garden [role="switch"][aria-checked="true"] { background-color: var(--life-accent) !important; }
      .life-rose-garden [role="switch"] > span { background-color: #fff !important; }
      .life-rose-garden button:focus-visible,
      .life-rose-garden input:focus-visible,
      .life-rose-garden select:focus-visible,
      .life-rose-garden textarea:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--life-accent) 70%, transparent);
        outline-offset: 2px;
      }
      .life-rose-garden .life-scene-display-options[open] { background: var(--life-overlay) !important; border-color: rgb(var(--life-border-rgb) / .8); }
      .life-rose-garden [class~="bg-[#fffaf3]/95"], .life-rose-garden [class~="bg-[#fffaf5]"] { background-color: var(--life-overlay) !important; }
    `}</style>
    {settings.customSceneCss?.trim() && <style>{settings.customSceneCss.replace(/<\/style/gi, "<\\/style")}</style>}
    <div className={`mx-auto w-full max-w-none ${immersiveScene ? "flex min-h-0 flex-1 flex-col" : ""}`}>
      <header className={`${immersiveScene ? "hidden" : "mb-2 flex flex-wrap items-center justify-between gap-2"}`}>
        <div className="flex items-center gap-3"><div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/75 text-[var(--life-accent)] shadow-sm"><Heart size={22}/></div><div><h1 className="text-2xl font-semibold tracking-tight">生活世界</h1><p className="mt-0.5 text-xs opacity-65">角色有自己的生活，你也可以随时加入</p></div></div>
        <div className="flex flex-wrap items-center gap-2"><button onClick={()=>tab==="home"?closeApp():setTab("home")} aria-label="返回生活现场" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><ArrowLeft size={15}/><span>返回</span></button><button onClick={closeApp} aria-label="退出生活 APP" className="inline-flex items-center gap-1 rounded-full border border-white/80 bg-white/70 px-3 py-2 text-sm"><X size={15}/><span>退出</span></button><span className="rounded-full border border-white/70 bg-white/60 px-3 py-1.5 text-xs">{actors.length} 位生活参与者</span></div>
      </header>
      {!settings.enabled && !immersiveScene && <div role="alert" className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-300/70 bg-amber-50/90 px-4 py-3 text-sm text-amber-900">
        <span>生活引擎当前为关闭状态：不会自动生成日程，也无法进入生活现场。重置后默认关闭，需要时请重新开启。</span>
        <button type="button" onClick={() => setTab("settings")} className="shrink-0 rounded-xl border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-900">去设置开启</button>
      </div>}
      {sceneToast && <div role="status" aria-live="polite" className="fixed left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-[300] w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-[var(--life-accent)]/30 bg-[#fffaf3]/97 px-4 py-3 shadow-xl backdrop-blur-md">
        <div className="flex items-start gap-2.5">
          {sceneToast.avatar ? <img src={sceneToast.avatar} alt="" className="h-9 w-9 shrink-0 rounded-full object-cover" /> : <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#efe1d2] text-xs text-stone-700">{sceneToast.characterName.slice(0, 1)}</span>}
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold tracking-wide text-[var(--life-accent)]">◆ 生活现场 · 主动{sceneToast.kind === "action" ? "行动" : "对话"}</p>
            <p className="mt-1 text-sm leading-relaxed text-stone-800"><span className="font-medium">{sceneToast.characterName}</span> {sceneToast.body}</p>
            <p className="mt-1 text-[10px] text-stone-500">地点：{sceneToast.location}</p>
          </div>
          <button type="button" onClick={() => { setSceneToast(null); setToastReplyMode("hidden"); }} aria-label="关闭主动消息提示" className="shrink-0 text-stone-400">×</button>
        </div>
        {sceneToast.isTest ? null : toastReplyMode !== "hidden" ? <div className="mt-2.5 flex items-center gap-1.5"><input value={toastReplyDraft} onChange={e => setToastReplyDraft(e.target.value)} autoFocus placeholder={toastReplyMode === "action" ? "写下你的行动…" : "想对 TA 说的话…"} className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs outline-none" /><button type="button" onClick={() => { const text = toastReplyDraft.trim(); if (!text || !sceneToast) return; const scene = stateRef.current.scenes.find(item => item.id === sceneToast.sceneId); if (!scene) { setNotice("原场景已结束，这条回复没有可写入的现场。"); return; } const reply: LifeSceneMessage = { id: id("turn"), sceneId: scene.id, speakerType: "player", speakerId: PLAYER_ID, speakerName: playerName, role: "player", action: toastReplyMode === "action" ? text : "", dialogue: toastReplyMode === "dialogue" ? text : "", createdAt: new Date().toISOString() }; const next = { ...stateRef.current, sceneMessages: [...stateRef.current.sceneMessages, reply] }; commit(next); setToastReplyDraft(""); setToastReplyMode("hidden"); setSceneToast(null); setTab("scene"); setNotice(toastReplyMode === "action" ? "已作为你的行动写入生活现场。" : "已作为你的对白写入生活现场。"); }} className="shrink-0 rounded-lg bg-[var(--life-accent)] px-3 py-1.5 text-xs text-white">写入现场</button></div> : <div className="mt-2.5 flex items-center gap-2"><button type="button" onClick={() => { setToastReplyMode("action"); setToastReplyDraft(""); }} className="flex-1 rounded-lg border border-[var(--life-accent)]/40 bg-white px-2 py-1.5 text-[11px] text-[var(--life-accent)]">回复行动</button><button type="button" onClick={() => { setToastReplyMode("dialogue"); setToastReplyDraft(""); }} className="flex-1 rounded-lg border border-[var(--life-accent)]/40 bg-white px-2 py-1.5 text-[11px] text-[var(--life-accent)]">回复对话</button></div>}
      </div>}
      {notice && !immersiveScene && <div role="status" className="mb-4 flex items-start justify-between gap-3 rounded-2xl border border-[var(--life-accent)]/20 bg-white/75 px-4 py-3 text-sm text-stone-700"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="关闭提示">×</button></div>}
      {notice && immersiveScene && <div role="status" aria-live="polite" className="fixed left-1/2 top-[max(4.5rem,calc(env(safe-area-inset-top)+4rem))] z-[130] w-[min(92vw,26rem)] -translate-x-1/2 rounded-2xl border border-[var(--life-accent)]/30 bg-[#fffaf3]/95 px-4 py-3 shadow-xl backdrop-blur-md"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold text-[var(--life-accent)]">提示</p><p className="mt-1 text-sm leading-relaxed text-stone-700">{notice}</p></div><button type="button" onClick={() => setNotice("")} aria-label="关闭提示" className="shrink-0 text-stone-400">×</button></div></div>}
      <nav aria-label="生活导航" className={`${immersiveScene ? "hidden" : "sticky top-0 z-20 mb-2 flex max-w-full gap-1 overflow-x-auto overscroll-x-contain rounded-xl border border-white/80 bg-[#fbf7f0]/90 p-1 shadow-sm backdrop-blur-md [scrollbar-width:none]"}`}>
        {([{id:"home",label:"生活现场",icon:MessagesSquare},{id:"daily",label:"角色日程",icon:CalendarDays},{id:"invitations",label:"邀约活动",icon:Coffee},{id:"experiences",label:"共同经历",icon:Heart},{id:"locations",label:"地点库",icon:MapPin},{id:"settings",label:"设置",icon:Settings2}] as const).filter(item => item.id !== "invitations" || settings.enableInvitations || settings.enableFollowRequestTool || pendingCharacterInvitations.length > 0).map(item => { const Icon=item.icon; const active=item.id===tab||(item.id==="daily"&&(tab==="daily"||tab==="people"||tab==="plans")); return <button key={item.id} onClick={() => { if(item.id==="daily"){setTab("daily");setSceneView(false);return;} setTab(item.id); if(item.id==="home" || item.id==="locations") setSceneView(false); if(item.id==="locations") setLocationDossierOpen(false); }} aria-current={active?"page":undefined} className={`flex shrink-0 flex-row items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-xs transition sm:px-3 sm:text-sm ${active?"bg-white text-[var(--life-accent)] shadow-sm":"opacity-70 hover:opacity-100"}`}><span className="relative inline-flex"><Icon size={16}/>{item.id==="invitations"&&pendingCharacterInvitations.length>0&&<span className="absolute -right-2 -top-2 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[9px] text-white">{pendingCharacterInvitations.length}</span>}</span><span className="truncate">{item.label}</span></button>; })}
      </nav>

      {(tab === "home" || tab === "scene") && <div className={immersiveScene ? "flex min-h-0 flex-1 flex-col" : "space-y-4"}>
        {sceneLocationSearchOpen && <div role="dialog" aria-modal="true" aria-label="搜索生活现场地点" className="fixed inset-0 z-[150] flex items-end justify-center bg-black/35 p-2 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setSceneLocationSearchOpen(false)}><section className="max-h-[88dvh] w-full max-w-xl overflow-hidden rounded-3xl border border-white/80 bg-[var(--life-overlay)] shadow-2xl" onClick={event => event.stopPropagation()}><header className="flex items-center justify-between border-b border-stone-200/70 px-4 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--life-accent)]">Find a place</p><h2 className="text-lg font-semibold">前往地点</h2></div><button type="button" onClick={() => setSceneLocationSearchOpen(false)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full bg-white/75"><X size={18}/></button></header><div className="space-y-2 p-3"><input autoFocus value={sceneLocationSearch} onChange={event => setSceneLocationSearch(event.target.value)} placeholder="搜索地点名称、别名或描写" className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/><div className="grid grid-cols-1 gap-2"><select value={sceneLocationFolderFilter} onChange={event => setSceneLocationFolderFilter(event.target.value)} className="min-w-0 rounded-xl border border-stone-200 bg-white px-2 py-2 text-xs"><option value="all">全部文件夹</option><option value="unfiled">未整理</option>{locationFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div></div><div className="max-h-[58dvh] space-y-1 overflow-y-auto px-3 pb-3">{filteredLocationCards.map(({location,isCurrent}) => <button type="button" key={location.id} onClick={() => { setSelectedLocationId(location.id); setSceneLocationSearchOpen(false); transferSceneWithCompanions(location.id); }} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-stone-200/70 bg-white/75 p-3 text-left"><span className="min-w-0"><span className="block font-medium text-stone-800">{location.name}</span><span className="mt-1 block truncate text-xs text-stone-500">{location.description || "暂无地点描写"}</span></span><span className="shrink-0 text-xs text-[var(--life-accent)]">{isCurrent ? "进入现场" : "前往"} ›</span></button>)}{!filteredLocationCards.length && <p className="p-6 text-center text-sm text-stone-500">没有找到地点</p>}</div></section></div>}
      {tab === "scene" && !immersiveScene && <details open className="rounded-2xl border border-white/80 bg-white/55 shadow-sm"><summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-stone-600">生活状态与时间线 · {playerNow.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})} · 展开查看</summary><section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle title={playerNow.toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})+" · 我的时间线"} />
            <button onClick={()=>openDaily("plans")} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">查看完整七日日程</button>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">现在</p><p className="mt-1 text-base font-semibold sm:text-lg">{playerNow.toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</p><p className="mt-1 truncate text-[10px] text-stone-600 sm:text-xs">{playerPresence?.activity ?? playerCurrentSlot?.title ?? "时间线待补全"}</p></div>
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">实际地点</p><p className="mt-1 truncate text-sm font-semibold sm:text-base">{playerPresence?.actualLocationName ?? "尚未记录"}</p><p className="mt-1 truncate text-[10px] text-stone-500 sm:text-xs">计划：{settings.showLocationHints ? playerCurrentSlot?.plannedLocationName ?? "暂无提示" : "地点线索已隐藏"}</p></div>
            <div className="min-w-0 rounded-2xl bg-white/75 p-2 sm:p-3"><p className="text-[10px] text-stone-500 sm:text-[11px]">当前场景</p><p className="mt-1 truncate text-sm font-semibold sm:text-base">{activeScene?.locationName ?? "尚未进入场景"}</p><p className="mt-1 truncate text-[10px] text-stone-500 sm:text-xs">{activeScene ? (activeScene.status==="active"?"正在进行":"已暂停，可继续") : "可以从下方选择地点进入"}</p></div>
          </div>

          {pendingCharacterInvitations.length > 0 && <section className="mt-3 rounded-2xl border border-rose-200/80 bg-rose-50/75 p-3 sm:p-4"><div className="flex items-center justify-between gap-3"><div className="min-w-0"><p className="text-sm font-semibold text-stone-800">有 {pendingCharacterInvitations.length} 项等你回应</p><p className="mt-1 text-xs text-stone-600">角色主动发来的邀约或陪伴申请，不会自动修改日程。</p></div><button onClick={() => setTab("invitations")} className="shrink-0 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">查看并决定</button></div></section>}
          {settings.showTimeline && <div className="mt-4">
            {playerPastSlots.length>0 && <details className="mb-3 rounded-2xl border border-stone-200/70 bg-white/55 p-3"><summary className="cursor-pointer text-sm font-medium text-stone-600">展开已度过的时段（{playerPastSlots.length}）</summary><div className="mt-3 space-y-2">{playerPastSlots.map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-stone-50/80 p-2.5 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}</div></details>}
            <div className="space-y-2">
              {playerCurrentSlot && <div className="flex gap-3 rounded-2xl border border-[var(--life-accent)]/40 bg-white p-3 shadow-sm"><span className="w-24 shrink-0 text-xs font-semibold text-[var(--life-accent)]">{new Date(playerCurrentSlot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(playerCurrentSlot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="font-medium">{playerCurrentSlot.title}</p><p className="mt-1 text-xs text-stone-500">实际状态：{playerPresence?.activity??playerCurrentSlot.title} · {playerPresence?.actualLocationName??playerCurrentSlot.plannedLocationName??"地点未记录"}</p></div><span className="self-start rounded-full bg-[var(--life-accent)]/10 px-2 py-1 text-[10px] text-[var(--life-accent)]">正在进行</span></div>}
              {playerFutureSlots.slice(0,5).map(slot=><div key={slot.id} className="flex gap-3 rounded-xl bg-white/60 p-3 text-xs"><span className="w-24 shrink-0 text-stone-400">{new Date(slot.startAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}–{new Date(slot.endAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><span className="min-w-0 flex-1 font-medium">{slot.title}</span><span className="text-stone-400">{slot.plannedLocationName??"地点未定"}</span></div>)}
              {!playerCurrentSlot && playerTodaySlots.length===0 && <div className="rounded-xl bg-white/65 p-3 text-sm text-stone-500">今天的时间线还没生成。你可以开启自动日程，或到七日日程页补全。</div>}
            </div>
          </div>}
          <div className="mt-3 rounded-xl border border-stone-200/70 bg-white/55 p-3"><p className="text-sm font-medium">此刻和你在同一地点</p><p className="mt-1 text-xs leading-5 text-stone-600">{nearbyCharacters.length ? `当前地点记录到 ${nearbyCharacters.length} 位角色在场。进入生活现场后，再发现谁注意到了你。` : "暂时没有角色在场"}</p></div>
        </section></details>}
      {tab === "home" && !sceneView && <section className="life-place-list space-y-4">
        <div className="flex items-end justify-between gap-3 px-1">
          <div><p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[var(--life-accent)]">Places & people</p><h2 className="mt-1 text-2xl font-semibold tracking-tight text-stone-800">此刻</h2></div>
          <div className="flex items-center gap-2"><button type="button" onClick={() => setSceneLocationSearchOpen(true)} aria-label="搜索和筛选地点" title="搜索和筛选地点" className="grid h-10 w-10 place-items-center rounded-xl border border-white/80 bg-white/75 text-stone-600"><Search size={17}/></button><button onClick={() => openDaily("plans")} className="shrink-0 rounded-xl border border-white/80 bg-white/75 px-3 py-2 text-xs text-stone-600">我的日程</button></div>
        </div>
        {filteredLocationCards.length === 0 && <p className="rounded-2xl border border-dashed border-stone-300 bg-white/50 p-6 text-center text-sm text-stone-500">没有找到符合条件的地点，试试清除筛选。</p>}
        {Array.from(locationCardGroups.entries()).map(([folderId, items]) => <section key={folderId} className="space-y-3">
          <button type="button" onClick={() => setCollapsedLocationFolders(current => ({ ...current, [folderId]: !current[folderId] }))} className="flex w-full items-center justify-between rounded-xl bg-white/55 px-3 py-2 text-left text-xs font-semibold text-stone-600">
            <span>{locationFolderName(folderId === "unfiled" ? undefined : folderId)} · {items.length} 个地点</span><span>{collapsedLocationFolders[folderId] ? "展开 +" : "收起 −"}</span>
          </button>
          {!collapsedLocationFolders[folderId] && <div className="space-y-3">{items.map(({location, people, atmosphere, isCurrent}, index) => <article key={location.id} style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }} className={`life-place-card overflow-hidden rounded-3xl border shadow-sm transition ${isCurrent ? "border-[var(--life-accent)]/45 bg-white/90 ring-1 ring-[var(--life-accent)]/10" : "border-white/80 bg-white/65"}`}>
          <div role="button" tabIndex={0} onClick={() => { setSelectedLocationId(location.id); transferSceneWithCompanions(location.id); }} onKeyDown={event => { if(event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedLocationId(location.id); transferSceneWithCompanions(location.id); } }} className="cursor-pointer p-4 outline-none focus-visible:ring-2 focus-visible:ring-[var(--life-accent)] sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h3 className="text-lg font-semibold text-stone-800">{location.name}</h3>{isCurrent && <span className="rounded-full bg-[var(--life-accent)]/10 px-2 py-1 text-[10px] font-medium text-[var(--life-accent)]">你在这里</span>}{location.visibility === "private" && <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">私人空间</span>}</div><p className="mt-1 text-sm leading-relaxed text-stone-600">{location.description || "这个地点还没有添加描写。"}</p></div>
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#f3e8dc] text-[var(--life-accent)]"><MapPin size={19}/></span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {people.filter(person => person.isActuallyHere).length > 0 && <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d7c2af] bg-[#efe1d2] px-2.5 py-1.5 text-xs text-stone-700"><Users size={12}/>{people.filter(person => person.isActuallyHere).length} 位角色在场</span>}
              {people.filter(person => person.isExpectedHere && !person.isActuallyHere).length > 0 && <span className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white/80 px-2.5 py-1.5 text-xs text-stone-600"><CalendarDays size={12}/>{people.filter(person => person.isExpectedHere && !person.isActuallyHere).length} 位可能来访</span>}
              {people.length === 0 && <span className="rounded-full bg-white/70 px-2.5 py-1.5 text-xs text-stone-500">暂无角色行程线索</span>}
            </div>
            
            <div className="mt-3 rounded-2xl bg-[#f8f2eb]/85 p-3"><p className="text-sm leading-relaxed text-stone-700">{atmosphere}</p></div>
            {(location.layout || location.props?.length) && <p className="mt-3 line-clamp-2 text-xs leading-relaxed text-stone-500">{location.layout ? `空间：${location.layout} ` : ""}{location.props?.length ? `· 可用道具：${location.props.slice(0,5).join("、")}` : ""}</p>}
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-stone-200/50 bg-white/45 px-4 py-3 sm:px-5"><span className="text-[11px] text-stone-400">{isCurrent ? "你的当前位置" : people.some(person => person.isActuallyHere) ? "角色正在这里生活" : "可以前往探索"}</span><button type="button" onClick={() => { setSelectedLocationId(location.id); transferSceneWithCompanions(location.id); }} className="inline-flex min-h-12 min-w-[92px] touch-manipulation shrink-0 items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-3 text-sm font-semibold text-white shadow-sm"><MapPin size={14}/>{isCurrent ? "进入现场" : "前往"}</button></div>
        </article>)}</div>}
        </section>)}
        <button type="button" onClick={() => { setSelectedLocationId(playerLocationId); setSceneView(false); setTab("locations"); }} className="w-full rounded-2xl border border-dashed border-stone-300 bg-white/40 px-4 py-3 text-sm text-stone-600">管理地点库 · 添加地点、布局、道具与角色习惯</button>
      </section>}
      {((tab === "home" && sceneView) || tab === "scene") && <section className={`life-scene-panel flex min-w-0 flex-col rounded-2xl border border-white/70 bg-white/35 p-1.5 shadow-sm sm:p-2 ${immersiveScene ? "h-full max-h-full min-h-0 flex-1 overflow-hidden rounded-none border-0 bg-transparent" : ""}`}>
        <div className="mb-1 flex shrink-0 items-center justify-between gap-2 border-b border-stone-200/60 px-1.5 py-1.5 sm:px-2 sm:py-2"><div className="min-w-0 flex-1"><p className="truncate text-base font-semibold text-stone-800">{activeScene ? activeScene.locationName : "还没有正在进行的场景"}</p><p className="truncate text-[11px] text-stone-500">{activeScene ? `${activeScene.participants.length} 位在场 · ${state.locations.find(location => location.id === activeScene.locationId)?.atmosphere || "生活现场"}` : "先从地点列表选择一个地点。"}</p></div><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); transitionSceneAction(() => { setSceneView(false); setTab("home"); setLocationDossierOpen(false); }); }} className="relative z-[100] isolate pointer-events-auto inline-flex min-h-11 min-w-[112px] touch-manipulation select-none cursor-pointer items-center justify-center gap-1 rounded-xl border border-stone-300 bg-white px-2 py-2 text-xs font-semibold text-stone-700 shadow-sm active:scale-[0.98]"><ArrowLeft size={16} className="pointer-events-none" aria-hidden/><span>返回地点列表</span></button>{activeScene && <button type="button" onClick={(event)=>{event.preventDefault();event.stopPropagation();transitionSceneAction(() => {const now=new Date().toISOString();const wasPaused=activeScene.status==="paused";const returnNarrationId=wasPaused?id("turn"):undefined;let next={...stateRef.current,scenes:stateRef.current.scenes.map(scene=>scene.id===activeScene.id?{...scene,status:(wasPaused?"active":"paused") as "active"|"paused",updatedAt:now}:{...scene,status:scene.status==="active"?"paused" as const:scene.status})};next=appendLifeTimelineEntry(next,{category:"scene",title:(wasPaused?"你回到了":"你暂时离开了")+activeScene.locationName,details:wasPaused?"继续之前的场景，保留原有互动记录。":"场景已暂停；再次点击继续时才在现场添加返回旁白。",actorName:playerName,locationName:activeScene.locationName,sceneId:activeScene.id,sourceId:returnNarrationId});if(wasPaused){const narration:LifeSceneMessage={id:returnNarrationId??id("turn"),sceneId:activeScene.id,speakerType:"player",speakerId:PLAYER_ID,speakerName:"场景旁白",role:"system",action:"你回到了"+activeScene.locationName+"。先前的场景与互动仍在继续。",dialogue:"",createdAt:now};next={...next,sceneMessages:[...next.sceneMessages,narration]};}commit(next);setNotice(wasPaused?"已回到原场景；返回记录以旁白形式加入聊天。":"你暂时离开了场景；再次点继续时才会添加返回旁白。")})}} className="relative z-[100] isolate pointer-events-auto inline-flex min-h-11 min-w-[104px] touch-manipulation select-none items-center justify-center gap-1 rounded-xl border border-stone-300 bg-white px-2 py-2 text-xs font-semibold shadow-sm active:scale-[0.98]">{activeScene.status==="active"?<><Pause size={14} className="pointer-events-none" aria-hidden/><span>暂时离开</span></>:<><Play size={14} className="pointer-events-none" aria-hidden/><span>回到场景</span></>}</button>}</div></div>
        <details open={!activeScene} className="mb-1 shrink-0 rounded-xl border border-stone-200/70 bg-white/65"><summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-stone-600">场景设置 · {activeScene ? activeScene.locationName : "选择地点并开始互动"}</summary><div className="max-h-[45dvh] overflow-y-auto overscroll-contain touch-pan-y px-3 pb-3 sm:px-4" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            {activeScene && <div className="mt-3"><label className="block text-sm font-medium text-stone-700">当前现场描述（用于后续生图）<textarea value={activeScene.currentDescription ?? ""} onChange={event=>{const description=event.target.value;const latest=stateRef.current;const scene=latest.scenes.find(item=>item.id===activeScene.id);if(!scene)return;const next={...latest,scenes:latest.scenes.map(item=>item.id===scene.id?{...item,currentDescription:description,updatedAt:new Date().toISOString()}:item)};commit(next);}} rows={3} placeholder="AI 根据原始行动与对白整理当前现场；也可以在这里手动修正。" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm font-normal"/></label><button type="button" disabled={sceneDescriptionBusy || busy} onClick={()=>void summarizeCurrentScene()} className="mt-2 w-full rounded-xl border border-[var(--life-accent)]/40 bg-white px-3 py-2 text-xs font-medium text-[var(--life-accent)] disabled:opacity-50">{sceneDescriptionBusy ? "正在整理现场描述…" : "根据原始记录更新现场描述"}</button></div>}
           <label className="block text-sm font-medium">当前地点
              <select value={selectedLocationId} onChange={e=>setSelectedLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">{visibleLocations.map(loc=><option key={loc.id} value={loc.id}>{loc.name} · {loc.visibility==="public"?"公共":"私人"}</option>)}</select>
            </label>
            <div className="flex items-end gap-2"><button type="button" onClick={() => transferSceneWithCompanions()} disabled={!settings.enabled} title="前往上方选择的当前地点并进入现场；已勾选的角色会与你同行（系统会改写 TA 的日程，约会中的角色留在原地）" className="w-full rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm font-medium text-white disabled:opacity-40">前往地点并进入现场</button></div>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <label className="block text-xs font-medium text-stone-600">预计停留时间
              <select value={stayDurationMinutes} onChange={event=>setStayDurationMinutes(Number(event.target.value))} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm text-stone-700">
                <option value={30}>半小时</option><option value={60}>1 小时</option><option value={120}>2 小时</option><option value={240}>4 小时</option><option value={480}>8 小时</option>
              </select>
            </label>
            {playerPresence?.actualLocationUntil && <button type="button" onClick={()=>{
              const now=new Date().toISOString();
              const current=getCurrentActorSchedule(stateRef.current,"player",PLAYER_ID,resolveActorLifeNow(getActorClock(stateRef.current,"player",PLAYER_ID)));
              const location=stateRef.current.locations.find(item=>item.id===current?.plannedLocationId) ?? stateRef.current.locations.find(item=>item.id==="home") ?? stateRef.current.locations[0];
              if(!location){setNotice("找不到原计划地点，请先检查日程。");return;}
              let next=upsertActorState(stateRef.current,{ownerType:"player",ownerId:PLAYER_ID,activity:current?.title||playerPresence.activity,scheduleSlotId:current?.id??playerPresence.scheduleSlotId,actualLocationId:location.id,actualLocationName:location.name,actualLocationUntil:null,locationSource:"schedule",manualSetAt:undefined,updatedAt:now});
              const scene=next.scenes.find(item=>item.status==="active");
              if(scene) next=upsertLifeScene(next,{...scene,locationId:location.id,locationName:location.name,updatedAt:now});
              next=appendLifeTimelineEntry(next,{category:"schedule",title:"已恢复原计划",details:"结束临时停留，回到当前日程地点「"+location.name+"」。",actorId:PLAYER_ID,actorName:playerName,locationName:location.name,sceneId:scene?.id});
              commit(next);setSelectedLocationId(location.id);setNotice("已提前结束临时停留，恢复当前日程地点。");
            }} className="rounded-xl border border-[#d9c2ae] bg-[#fbf5ee] px-3 py-2.5 text-xs text-stone-700">恢复原计划</button>}
          </div>
          {playerPresence?.actualLocationUntil && <p className="mt-2 text-[11px] text-stone-500">临时停留预计于 {new Date(playerPresence.actualLocationUntil).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})} 结束；届时会自动恢复当前行程地点。你也可以提前恢复原计划。</p>}
          <div className="mt-2 flex gap-2"><input value={newLocationName} onChange={e=>setNewLocationName(e.target.value)} placeholder="添加一个新地点…" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/><button type="button" onClick={addLocation} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">添加地点</button></div>
          <label className="mt-3 block text-sm font-medium text-stone-700">你现在的行动（可选）<input value={playerActivity} onChange={e=>setPlayerActivity(e.target.value)} placeholder="例如：坐在窗边看书、慢慢散步……" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
          <div className="mt-3"><p className="mb-2 text-xs font-medium text-stone-600">选择同行的角色（点地点卡片或上方按钮时一起前往）</p><div className="flex flex-wrap gap-2">{characters.map(char=><label key={char.id} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={selectedCharacterIds.includes(char.id)} onChange={e=>setSelectedCharacterIds(old=>e.target.checked?[...new Set([...old,char.id])]:old.filter(id=>id!==char.id))}/>{char.name}</label>)}</div></div>
          {!characters.length&&<p className="mt-2 text-xs text-stone-500">还没有角色档案；先在小手机里创建角色，之后就能在这里互动。</p>}
          {selectedLocation && <div className="mt-4 border-t border-stone-200/70 pt-4">
            <div className="mb-3"><p className="text-sm font-semibold text-stone-700">地点环境与细节</p></div>
              <div className="mb-4 grid gap-3"><label className="block text-sm font-medium text-stone-700">环境描写<textarea value={locationDescriptionDraft} onChange={event => setLocationDescriptionDraft(event.target.value)} rows={4} placeholder="空间类型、大小、光线、声音、气味及环境中的固定事实" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">氛围<textarea value={locationAtmosphereDraft} onChange={event => setLocationAtmosphereDraft(event.target.value)} rows={3} placeholder="时段、天气、人声、气息与整体情绪" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">空间布局<textarea value={locationLayoutDraft} onChange={event => setLocationLayoutDraft(event.target.value)} rows={3} placeholder="门窗、家具、通道、座位及区域之间的位置关系" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">可用道具<textarea value={locationPropsDraft} onChange={event => setLocationPropsDraft(event.target.value)} rows={2} placeholder="填写可见、可使用或可互动的物品，用顿号分隔" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              </div>
            <button type="button" onClick={saveLocationDetails} className="w-full rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">保存地点布置</button>
          </div>}
        </div></details>
        {activeScene && <>
          <div className={`mb-1 flex shrink-0 items-center gap-1.5 overflow-x-auto pb-0.5 ${settings.compactLayout ? "max-h-8" : "max-h-10"}`}>{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerId===p.ownerId&&a.ownerType===p.ownerType);const awareness=p.awarenessByActorId.player;const status=awareness==="unaware"?"还没注意到你":awareness==="suspects"?"似乎察觉到你":awareness==="aware"?"注意到你":p.activity;return <button key={p.ownerType+":"+p.ownerId} onClick={()=>{if(p.ownerType==="character")setSelectedSpeakerId(current=>current===p.ownerId?"":p.ownerId)}} className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] ${selectedSpeakerId===p.ownerId?"border-[var(--life-accent)] bg-white shadow-sm":"border-white/70 bg-white/55"}`}><span className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-full bg-[#efe1d2] text-[10px] text-stone-700">{actor?.avatar?<img src={actor.avatar} alt="" className="h-full w-full object-cover"/>:(actor?.name??p.ownerId).slice(0,1)}</span><span className="text-left"><span className="block font-medium">{actor?.name??p.ownerId}</span><span className="block max-w-28 truncate text-[9px] opacity-60">{status}</span></span></button>})}</div>
          <div ref={sceneChatScrollRef} onScroll={event => { const el = event.currentTarget; sceneChatAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 56; }} className={`life-scene-chat mb-1 min-h-0 min-w-0 flex-1 flex flex-col overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y rounded-xl bg-white/80 ${settings.compactLayout ? "p-1 sm:p-1.5" : "p-1.5 sm:p-2"} ${immersiveScene ? "" : "h-[58dvh] min-h-[280px] max-h-[760px]"}`} style={{fontSize:"var(--life-font)", rowGap: `${settings.messageGapPx ?? 4}px`, WebkitOverflowScrolling:"touch"}}>
            {sceneMessages.length===0 && <div className="grid min-h-36 place-items-center text-center text-sm text-stone-400"><p>暂无消息</p></div>}
            {displaySceneMessages.map(message=><div key={message.id} className="group flex min-w-0 max-w-full flex-col rounded-xl transition-colors" onTouchStart={() => { longPressTriggeredRef.current = false; clearMessageLongPress(); longPressTimerRef.current = window.setTimeout(() => { longPressTriggeredRef.current = true; openMessageActions(message); }, 550); }} onTouchEnd={clearMessageLongPress} onTouchMove={clearMessageLongPress} onTouchCancel={clearMessageLongPress} onContextMenu={event => { event.preventDefault(); clearMessageLongPress(); openMessageActions(message); }}>
              {message.role==="system" ? (message.imageId ? <div className="mx-auto flex w-full max-w-[92%] flex-col items-center gap-1.5 rounded-xl px-2 py-2"><button type="button" onClick={() => { const index = sceneViewerImages.findIndex(image => image.id === message.imageId); if (index >= 0) { setImageViewerIndex(index); setImageViewerOpen(true); } }} className="block max-w-full overflow-hidden rounded-xl border border-stone-200 bg-white shadow-sm">{imageObjectUrls[message.imageId] ? <img src={imageObjectUrls[message.imageId]} alt={sceneViewerImages.find(image => image.id === message.imageId)?.alt || "生活现场图片"} className="max-h-72 max-w-full object-contain" /> : <span className="grid h-36 w-56 place-items-center text-xs text-stone-400">场景图片加载中…</span>}</button><p className="text-[10px] text-stone-400">{message.action || "场景图片"} · {new Date(message.createdAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</p></div> : <div className="mx-auto max-w-[92%] px-2 py-1 text-center italic leading-relaxed text-stone-500"><p className="whitespace-pre-wrap text-center leading-snug" style={{fontSize:"var(--life-narration-font)",fontFamily:settings.narrationFontFamily || undefined}}>{message.action || message.dialogue}</p></div>) : <>
                {message.action&&(message.role==="player"?<div className="flex items-center gap-2 px-1" style={{marginBlock: `${settings.narrationGapPx ?? 4}px`}} aria-label="我的行动"><span className="h-px flex-1 bg-stone-300/80"/><p className="min-w-0 max-w-[82%] break-words text-center italic leading-relaxed text-stone-500 [overflow-wrap:anywhere]" style={{fontSize:"var(--life-narration-font)",fontFamily:settings.narrationFontFamily || undefined}}>{message.action}</p><span className="h-px flex-1 bg-stone-300/80"/></div>:<div className="relative mx-auto w-full max-w-[94%] py-1" style={{marginBlock: `${settings.narrationGapPx ?? 4}px`}} aria-label="角色行动卡片"><svg viewBox="0 0 320 96" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true"><rect x="1" y="1" width="318" height="94" rx="3" fill="#fffaf4" fillOpacity=".92" stroke="#d8b89c" strokeWidth="1.2"/><rect x="5" y="5" width="310" height="86" rx="2" fill="none" stroke="#ead8c4" strokeWidth=".7"/></svg><div className="relative px-4 py-2.5 text-center"><div className="mb-1 text-[9px] tracking-[.22em] text-[#b08b6c]">✦  MOMENT  ✦</div><p className="whitespace-pre-wrap break-words text-center italic leading-relaxed text-[#806957] [overflow-wrap:anywhere]" style={{fontSize:"var(--life-narration-font)",fontFamily:settings.narrationFontFamily || undefined}}>{message.action}</p></div></div>)}
                {message.dialogue&&<div className={`flex min-w-0 max-w-full items-end gap-1.5 ${message.role==="player"?"justify-end":"justify-start"}`}>{message.role!=="player"&&<span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[#efe1d2] text-[11px] text-stone-700">{actors.find(actor=>actor.ownerType==="character"&&actor.ownerId===message.speakerId)?.avatar?<img src={actors.find(actor=>actor.ownerType==="character"&&actor.ownerId===message.speakerId)?.avatar??undefined} alt="" className="h-full w-full object-cover"/>:(message.speakerName||"角").slice(0,1)}</span>}<div style={{fontSize:"var(--life-font)", fontFamily:settings.dialogueFontFamily || undefined, padding: `${settings.bubblePadding}px ${settings.bubblePadding}px`}} className={`life-scene-bubble min-w-0 max-w-[88%] border border-stone-200/70 break-words [overflow-wrap:anywhere] ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-xl":"rounded-lg"} ${message.role==="player"?"bg-[#f0dfcf] text-stone-800":"bg-white/95 text-stone-800"}`}><p className="min-w-0 whitespace-pre-wrap break-words leading-relaxed [overflow-wrap:anywhere]">{message.dialogue}</p></div>{message.role==="player"&&<span className="grid h-7 w-7 shrink-0 place-items-center overflow-hidden rounded-full bg-[#e9d4c0] text-[11px] text-stone-700">{playerIdentity?.avatarUrl?<img src={playerIdentity.avatarUrl} alt="" className="h-full w-full object-cover"/>:playerName.slice(0,1)}</span>}</div>}
              </>}
            </div>)}
            {busy&&<div className="text-xs text-stone-400">角色正在回应……</div>}
          </div>
           <details className="mb-1 shrink-0 rounded-xl border border-stone-200/70 bg-white/50 px-2 py-1.5">
             <summary className="cursor-pointer list-none text-xs text-stone-500">场景相册 · {sceneImageRecords.filter(image=>image.status==="active").length} 张 · 生图</summary>
             <div className="mt-2 flex items-center justify-end gap-3">
               <button type="button" disabled={sceneImageBusy} onClick={()=>void generateSceneImages({count:1,participantIds:imageParticipantIds.length?imageParticipantIds:activeScene.participants.filter(p=>p.ownerType==="character").map(p=>p.ownerId),prompt:sceneImagePrompt})} className="inline-flex items-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50"><Sparkles size={14}/>{sceneImageBusy?"正在生成…":"生成场景"}</button>
             </div>
             {sceneImageRecords.filter(image=>image.status==="active").length>0&&<div className="mt-2 flex gap-2 overflow-x-auto pb-1">{sceneImageRecords.filter(image=>image.status==="active").map((image,index)=><button type="button" key={image.id} onClick={()=>{setImageViewerIndex(sceneViewerImages.findIndex(item=>item.id===image.id));setImageViewerOpen(true);}} aria-label={`查看第 ${index+1} 张场景图`} className={`shrink-0 overflow-hidden rounded-xl border ${sceneViewerImages[imageViewerIndex]?.id===image.id?"border-[var(--life-accent)]":"border-stone-200"}`}>{imageObjectUrls[image.id]?<img src={imageObjectUrls[image.id]} alt={image.alt||"场景图"} className="h-16 w-16 object-cover"/>:<span className="grid h-16 w-16 place-items-center text-[10px] text-stone-400">加载中</span>}</button>)}</div>}{sceneImageRecords.filter(image=>image.status==="active").length>0&&<div className="mt-2 flex gap-2 overflow-x-auto pb-1">{sceneImageRecords.filter(image=>image.status==="active").map((image,index)=><button key={"bg-"+image.id} type="button" disabled={backgroundUploadBusy!==null} onClick={()=>void setSceneImageAsBackground(image.id)} className="shrink-0 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[10px] text-stone-600 disabled:opacity-50">{backgroundUploadBusy==="location"?"处理中…":`第 ${index+1} 张设为地点背景`}</button>)}</div>}
           </details>
          
          
          <form onSubmit={sendSceneTurn} className={`life-scene-composer shrink-0 rounded-xl border border-stone-200/70 bg-white/95 ${settings.compactLayout ? "space-y-1 p-1.5" : "space-y-1.5 p-2"}`}>
            <div className={`grid gap-1.5 sm:grid-cols-[0.75fr_1.25fr] ${settings.compactLayout ? "sm:gap-1" : ""}`}>
              <label className="block text-xs font-medium text-stone-600">行动 / 旁白<textarea value={sceneActionInput} onChange={e=>setSceneActionInput(e.target.value)} placeholder="行动（可选）" rows={1} className="mt-1 w-full resize-y rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm leading-snug"/></label>
              <label className="block text-xs font-medium text-stone-600">说话 / 对话气泡<textarea value={sceneInput} onChange={e=>setSceneInput(e.target.value)} placeholder="想对角色说的话……" rows={1} className="mt-1 w-full resize-y rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-sm leading-snug"/></label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2"><label className="inline-flex items-center gap-2 text-[11px] text-stone-500"><input type="checkbox" checked={settings.randomSceneResponses !== false} onChange={event => patchSettings({ randomSceneResponses: event.target.checked })} disabled={busy}/>随机角色回应</label><span className="mr-auto truncate text-[10px] text-stone-400">{busy ? (pendingSceneTurnsRef.current.length ? `角色回应中 · 排队 ${pendingSceneTurnsRef.current.length}` : "角色正在回应…") : selectedSpeakerId ? "已指定追加角色；再次点选可取消" : "默认随机；点选角色可追加回应"}</span><button type="button" onClick={() => void sendSceneTurn(undefined, true)} disabled={busy || !activeScene || !activeScene.participants.some(p => p.ownerType === "character" && Boolean(resolveLifeCharacterId(p.ownerId)) && characters.some(c => c.id === resolveLifeCharacterId(p.ownerId)))} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--life-accent)]/40 bg-white px-3 py-1.5 text-xs text-[var(--life-accent)] disabled:opacity-40"><MessagesSquare size={13}/>让角色回应</button><button type="submit" disabled={!sceneInput.trim()&&!sceneActionInput.trim()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--life-accent)] px-3 py-1.5 text-xs text-white disabled:opacity-40"><Send size={13}/>{busy?"排队发送":"发送"}</button></div>
          </form>
          {imageViewerOpen && sceneViewerImages[imageViewerIndex] && <div role="dialog" aria-modal="true" aria-label="场景图片查看器" className="fixed inset-0 z-[120] flex flex-col items-center justify-center bg-black/90 p-3 sm:p-6" onClick={() => setImageViewerOpen(false)}>
            <div className="absolute right-3 top-3 flex items-center gap-2">
              <button type="button" onClick={event=>{event.stopPropagation();setImageViewerOpen(false);}} aria-label="关闭图片" className="grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white"><X size={20}/></button>
            </div>
            <div className="flex min-h-0 w-full max-w-5xl flex-1 items-center justify-center gap-2 sm:gap-5" onClick={event=>event.stopPropagation()}>
              <button type="button" disabled={imageViewerIndex<=0} onClick={()=>setImageViewerIndex(index=>Math.max(0,index-1))} aria-label="上一张" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-white disabled:opacity-25">‹</button>
              {imageObjectUrls[sceneViewerImages[imageViewerIndex].id] ? <img src={imageObjectUrls[sceneViewerImages[imageViewerIndex].id]} alt={sceneViewerImages[imageViewerIndex].alt || "生活现场图片"} className="max-h-full min-w-0 max-w-[calc(100%-6rem)] object-contain"/> : <div className="grid h-48 w-full place-items-center text-sm text-white/70">图片加载中…</div>}
              <button type="button" disabled={imageViewerIndex>=sceneViewerImages.length-1} onClick={()=>setImageViewerIndex(index=>Math.min(sceneViewerImages.length-1,index+1))} aria-label="下一张" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white/15 text-white disabled:opacity-25">›</button>
            </div>
            <div className="mt-3 flex items-center gap-3 text-xs text-white/80" onClick={event=>event.stopPropagation()}>
              <span>{imageViewerIndex+1} / {sceneViewerImages.length}</span>
              <span>{sceneViewerImages[imageViewerIndex].alt || "场景图片"}</span>
              <button type="button" onClick={()=>void downloadSceneImage(sceneViewerImages[imageViewerIndex])} className="rounded-full bg-white/15 px-3 py-2 text-white">下载原图</button>
            </div>
          </div>}
        </>}
      </section>}
          <section className={`mt-4 rounded-2xl border border-stone-200/70 bg-white/60 p-3 sm:p-4 ${immersiveScene ? "hidden" : ""}`}>
            <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-stone-800">今天发生的事</p></div><span className="rounded-full bg-white px-2.5 py-1 text-[10px] text-stone-500">{lifeTimeline.length} 条</span></div>
            {recentLifeTimeline.length ? <div className="space-y-2">{recentLifeTimeline.map(entry=><div key={entry.id} className="flex gap-3 rounded-xl bg-white/80 p-3"><span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-stone-800">{entry.title}</p>{entry.details&&<p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">{entry.details}</p>}<p className="mt-1 text-[10px] text-stone-400">{entry.actorName ? entry.actorName+" · " : ""}{entry.locationName ? entry.locationName+" · " : ""}{entry.category === "location" ? "地点" : entry.category === "scene" ? "场景" : entry.category === "action" ? "行动" : entry.category === "dialogue" ? "对话" : entry.category === "schedule" ? "日程" : entry.category === "tool" ? "工具" : entry.category === "social" ? "朋友圈" : entry.category === "diary" ? "日记" : entry.category === "chat" ? "消息" : "生活记录"}</p>{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-56 w-auto max-w-full rounded-xl object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 disabled:opacity-50"><Sparkles size={12}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button></div></div>)}</div> : <div className="rounded-xl bg-white/70 p-4 text-center text-xs text-stone-500">还没有符合当前筛选条件的记录。开始行动或互动后，这里会逐渐形成你的一天。</div>}
            {olderLifeTimeline.length>0&&<details className="mt-3 rounded-xl border border-stone-200/70 bg-white/50 p-3"><summary className="cursor-pointer text-xs font-medium text-stone-600">展开更早的记录（{olderLifeTimeline.length}）</summary><div className="mt-3 space-y-2">{olderLifeTimeline.map(entry=><div key={entry.id} className="flex gap-3 border-l-2 border-stone-200 pl-3 py-1"><span className="w-12 shrink-0 text-[10px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",hour12:false})}</span><div className="min-w-0 flex-1"><p className="text-xs font-medium">{entry.title}</p>{entry.details&&<p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-stone-500">{entry.details}</p>}{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-48 w-auto max-w-full rounded-lg object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-1.5 inline-flex min-h-7 items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-1 text-[10px] text-stone-600 disabled:opacity-50"><Sparkles size={11}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button></div></div>)}</div></details>}
          </section>
        </div>}

      {tab === "locations" && <div className="space-y-4">
        <section className="rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm sm:p-6">
          {!locationDossierOpen && <><div className="mb-4 flex items-center justify-between gap-3"><SectionTitle eyebrow="LOCATION ARCHIVE" title="地点库" note="点开地点卡片进入独立档案页，编辑地点设定并查看生活记录。搜索与整理收纳在独立入口，不占用地点列表空间。"/><div className="flex shrink-0 items-center gap-2"><button type="button" onClick={() => setLibraryLocationSearchOpen(true)} aria-label="搜索地点库" title="搜索地点库" className="grid h-10 w-10 place-items-center rounded-xl border border-stone-200 bg-white text-stone-600"><Search size={17}/></button><button type="button" onClick={() => setFolderDialogOpen(true)} aria-label="管理地点文件夹" title="管理文件夹" className="grid h-10 w-10 place-items-center rounded-xl border border-stone-200 bg-white text-stone-600"><Plus size={16}/></button><button type="button" onClick={() => { setLocationSelectionMode(value => !value); setSelectedLocationIds([]); }} aria-label={locationSelectionMode ? "退出批量整理" : "批量整理地点"} title={locationSelectionMode ? "完成选择" : "批量整理"} className={`grid h-10 w-10 place-items-center rounded-xl border text-sm ${locationSelectionMode ? "border-[var(--life-accent)] bg-[#fffaf5] text-[var(--life-accent)]" : "border-stone-200 bg-white text-stone-600"}`}>☑</button></div></div>
          {locationSelectionMode && <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-stone-200/70 bg-white/65 p-3"><label className="flex min-h-9 items-center gap-2 text-xs text-stone-600"><input type="checkbox" checked={filteredLibraryLocations.length > 0 && filteredLibraryLocations.every(location => selectedLocationIds.includes(location.id))} onChange={event => setSelectedLocationIds(event.target.checked ? filteredLibraryLocations.map(location => location.id) : [])}/>全选当前结果</label><span className="text-xs text-stone-400">已选 {selectedLocationIds.length} 个</span><select aria-label="批量移动到文件夹" value={batchFolderId} onChange={event => setBatchFolderId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"><option value="unfiled">未整理</option>{locationFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><button type="button" disabled={!selectedLocationIds.length} onClick={moveSelectedLocations} className="rounded-lg bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40">移动所选</button></div>}
          <div className="mb-4 rounded-2xl border border-[#ead8c8] bg-[#fffaf5] p-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-stone-800">从角色卡 / 世界书导入地点</h3><p className="mt-1 text-xs leading-relaxed text-stone-500">自动提取地点、别名、环境、氛围、布局和道具，并保留来源。这里直接扫描所选世界书的启用条目，不依赖普通聊天的关键词触发；默认勾选该角色绑定的聊天与栖所世界书，也可手动选择其他书。</p></div>
              <button type="button" disabled={locationImportBusy || !locationImportCharacterId} onClick={() => void importWorldbookLocations()} className="shrink-0 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{locationImportBusy ? "处理中…" : "分析并导入地点"}</button>
            </div>
            <label className="mt-3 block text-xs font-medium text-stone-600">角色卡
              <select value={locationImportCharacterId} onChange={event => { const nextId = event.target.value; setLocationImportCharacterId(nextId); const chat = resolveBinding(bindingConfig, nextId, "chat"); const dwelling = resolveBinding(bindingConfig, nextId, "dwelling"); setLocationImportWorldBookIds([...new Set([...(chat.worldBookIds ?? []), ...(dwelling.worldBookIds ?? [])])]); }} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">
                <option value="">选择角色</option>{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
              </select>
            </label>
            <div className="mt-3"><p className="mb-2 text-xs font-medium text-stone-600">参与分析的世界书（仅读取启用条目）</p>
              {worldBooks.length ? <div className="grid max-h-40 gap-1.5 overflow-y-auto sm:grid-cols-2">{worldBooks.map(book => <label key={book.id} className="flex min-w-0 items-center gap-2 rounded-lg bg-white/80 px-2.5 py-2 text-xs text-stone-600"><input type="checkbox" checked={locationImportWorldBookIds.includes(book.id)} onChange={event => setLocationImportWorldBookIds(current => event.target.checked ? [...new Set([...current, book.id])] : current.filter(id => id !== book.id))}/><span className="min-w-0 truncate">{book.name}</span></label>)}</div> : <p className="text-xs text-stone-400">当前没有世界书；仍可从所选角色卡中提取地点。</p>}
            </div>
          </div>
          <form onSubmit={event => { event.preventDefault(); addLocation(); }} className="flex gap-2">
            <input value={newLocationName} onChange={event => setNewLocationName(event.target.value)} placeholder="创建一个新地点，例如：旧城区的花店" className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
            <button type="submit" className="shrink-0 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white"><Plus size={15} className="mr-1 inline"/>添加地点</button>
          </form>
          <div className="mt-4 space-y-3">
            {filteredLibraryLocations.length === 0 && <p className="rounded-2xl border border-dashed border-stone-300 p-6 text-center text-sm text-stone-500">没有找到符合条件的地点。</p>}
            {Array.from(libraryLocationGroups.entries()).map(([folderId, folderLocations]) => <section key={folderId} className="space-y-2 rounded-2xl border border-stone-200/70 bg-white/35 p-2">
              <button type="button" onClick={() => setCollapsedLocationFolders(current => ({ ...current, ["library:"+folderId]: !current["library:"+folderId] }))} className="flex w-full items-center justify-between rounded-xl bg-white/75 px-3 py-2.5 text-left text-xs font-semibold text-stone-600"><span>{locationFolderName(folderId === "unfiled" ? undefined : folderId)} · {folderLocations.length} 个地点</span><span>{collapsedLocationFolders["library:"+folderId] ? "展开 +" : "收起 −"}</span></button>
              {!collapsedLocationFolders["library:"+folderId] && <div className="space-y-3">{folderLocations.map(location => {
              const entries = state.timeline.filter(entry => entry.locationName === location.name);
              const eventCount = state.events.filter(event => event.locationId === location.id || event.locationName === location.name).length;
              const actualPeople = characters.filter(character => state.actorStates.some(actor => actor.ownerType === "character" && actor.ownerId === character.id && actor.actualLocationId === location.id));
              return <article key={location.id} className="rounded-2xl border border-stone-200/70 bg-white/70 p-3">
                {locationSelectionMode && <label className="mb-1 flex min-h-8 items-center gap-2 px-2 text-xs text-stone-500"><input type="checkbox" checked={selectedLocationIds.includes(location.id)} onChange={event => setSelectedLocationIds(current => event.target.checked ? [...new Set([...current, location.id])] : current.filter(id => id !== location.id))}/>选择此地点</label>}
                <button type="button" onClick={() => { setSelectedLocationId(location.id); setLocationDossierOpen(true); }} className={`w-full min-h-12 touch-manipulation rounded-xl p-2 text-left transition ${selectedLocationId === location.id ? "bg-[#fffaf5]" : "hover:bg-white"}`}>
                  <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h3 className="font-semibold text-stone-800">{location.name}</h3><p className="mt-1 line-clamp-2 text-xs leading-relaxed text-stone-500">{location.description || "尚未添加地点描写"}</p></div><span className="shrink-0 rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">{location.visibility === "private" ? "私人" : "公共"}</span></div>
                  <div className="mt-2 flex flex-wrap gap-1.5"><span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">{locationFolderName(location.folderId)}</span></div>
                  <div className="mt-3 flex flex-wrap gap-1.5">{actualPeople.length ? <span className="inline-flex items-center gap-1.5 rounded-full border border-[#d7c2af] bg-[#efe1d2] px-2.5 py-1 text-[10px] text-stone-700"><Users size={11}/>{actualPeople.length} 位角色在场</span> : <span className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-500">目前没有实际在场角色</span>}</div>
                  <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-stone-400"><span>生活记录 {entries.length} 条 · 事件 {eventCount} 件</span><span>{location.props?.length ?? 0} 件道具 · 查看档案 →</span></div>
                </button>

              </article>;
            })}</div>}
            </section>)}
          </div>
          </>}
        </section>
        {locationDossierOpen && selectedLocation && <section className="rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm sm:p-6">
          <button type="button" onClick={() => setLocationDossierOpen(false)} className="mb-4 inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700"><ArrowLeft size={16}/>返回地点列表</button>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><span className="text-[11px] leading-5 text-stone-500">删除只移除地点库条目；已发生的生活记录仍保留地点名称快照。</span><button type="button" disabled={selectedLocation.id === "home"} onClick={() => { const current = stateRef.current; const name = selectedLocation.name; if (!window.confirm("确定删除地点「" + name + "」吗？历史记录会保留名称；正在此处的角色会暂时归回「家」。此操作无法直接撤销。")) return; commit({ ...current, locations: current.locations.filter(location => location.id !== selectedLocation.id), schedules: current.schedules.map(slot => slot.plannedLocationId === selectedLocation.id ? { ...slot, plannedLocationId: null, plannedLocationName: slot.plannedLocationName || name, plannedLocationDeleted: true, updatedAt: new Date().toISOString() } : slot), actorStates: current.actorStates.map(actor => actor.actualLocationId === selectedLocation.id ? { ...actor, actualLocationId: "home", actualLocationName: "家", activity: "暂时回到家" } : actor), scenes: current.scenes.map(scene => scene.status === "active" && scene.locationId === selectedLocation.id ? { ...scene, status: "paused", locationId: "removed-" + selectedLocation.id + "-" + Date.now().toString(36), locationName: name + "（已删除）", updatedAt: new Date().toISOString() } : scene) }); setSelectedLocationId("home"); setLocationDossierOpen(false); setNotice("已删除地点「" + name + "」；历史记录保留原地点名称。"); }} className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-700 disabled:opacity-40">{selectedLocation.id === "home" ? "默认家不可删除" : "删除此地点"}</button></div>
          <div className="mb-4 grid grid-cols-3 gap-2">
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">到访次数</p><p className="mt-1 text-lg font-semibold text-stone-800">{selectedLocationVisitStats.visits}</p></div>
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">累计停留</p><p className="mt-1 text-lg font-semibold text-stone-800">{Math.floor(selectedLocationVisitStats.minutes / 60)}h {selectedLocationVisitStats.minutes % 60}m</p></div>
            <div className="rounded-2xl bg-[#f5ede4] p-3"><p className="text-[10px] text-stone-500">本次停留</p><p className="mt-1 text-lg font-semibold text-stone-800">{Math.floor(selectedLocationVisitStats.activeMinutes / 60)}h {selectedLocationVisitStats.activeMinutes % 60}m</p></div>
          </div>
          
          <SectionTitle title={selectedLocation.name + " · 地点档案"}/>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#fffaf5] p-3"><div className="text-xs text-stone-500">{(selectedLocation.sourceRefs ?? []).length ? "来源：" + (selectedLocation.sourceRefs ?? []).map(source => source.kind === "worldbook" ? source.worldBookName + (source.entryComment ? " · " + source.entryComment : "") : source.kind === "character-card" ? source.characterName + " 的角色卡" : "手动").join("；") : "暂无导入来源；可由 AI 根据地点名称与角色设定补全。"}</div><button type="button" disabled={locationImportBusy} onClick={() => void completeSelectedLocationProfile()} className="shrink-0 rounded-lg border border-[#d7b99f] bg-white px-3 py-2 text-xs font-medium text-stone-700 disabled:opacity-50">{locationImportBusy ? "处理中…" : "AI 补全 / 刷新档案"}</button></div>
          <label className="mb-3 block text-sm font-medium text-stone-700">地点名称<input value={locationNameDraft} onChange={event => { setLocationNameDraft(event.target.value); setLocationSaveFeedback(false); }} placeholder="例如：我们的小家" className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
          <label className="mb-3 block text-sm font-medium text-stone-700">别名 / 日程匹配关键词<textarea value={(selectedLocation.aliases ?? []).join("、")} onChange={event => commit({ ...stateRef.current, locations: stateRef.current.locations.map(location => location.id === selectedLocation.id ? { ...location, aliases: event.target.value.split(/[、,，;；\n]/).map(value => value.trim()).filter(Boolean), fieldOrigins: { ...(location.fieldOrigins ?? {}), aliases: "user" } } : location) })} rows={2} placeholder="例如：旧城区花店、花店、花房" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
           <div className="mb-4 grid gap-3"><label className="block text-sm font-medium text-stone-700">环境描写<textarea value={locationDescriptionDraft} onChange={event => setLocationDescriptionDraft(event.target.value)} rows={4} placeholder="空间类型、大小、光线、声音、气味及环境中的固定事实" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">氛围<textarea value={locationAtmosphereDraft} onChange={event => setLocationAtmosphereDraft(event.target.value)} rows={3} placeholder="时段、天气、人声、气息与整体情绪" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">空间布局<textarea value={locationLayoutDraft} onChange={event => setLocationLayoutDraft(event.target.value)} rows={3} placeholder="门窗、家具、通道、座位及区域之间的位置关系" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
              <label className="block text-sm font-medium text-stone-700">可用道具<textarea value={locationPropsDraft} onChange={event => setLocationPropsDraft(event.target.value)} rows={2} placeholder="填写可见、可使用或可互动的物品，用顿号分隔" className="mt-1.5 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm leading-relaxed"/></label>
            </div>
            <div className="mb-2 flex items-center justify-between gap-2"><div><h3 className="text-sm font-semibold text-stone-700">专属聊天室背景</h3></div>
              {selectedLocation.backgroundImage && <button type="button" onClick={()=>updateSelectedLocationBackground({backgroundImage:undefined})} className="shrink-0 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-600">移除</button>}
            </div>
            {selectedLocation.backgroundImage ? <div className="relative mb-3 h-32 overflow-hidden rounded-xl border border-white/80"><img src={selectedLocation.backgroundImage} alt={selectedLocation.name+"聊天室背景预览"} className="h-full w-full object-cover" style={{filter:`blur(${Math.max(0,Math.min(18,selectedLocation.backgroundBlur??0))}px) brightness(${Math.max(.45,Math.min(1.4,(selectedLocation.backgroundBrightness??100)/100))})`}}/><div className="absolute inset-0" style={{backgroundColor:`rgba(255,250,245,${Math.max(0,Math.min(85,selectedLocation.backgroundOverlay??18))/100})`}}/></div> : <div className="mb-3 grid h-24 place-items-center rounded-xl border border-dashed border-rose-200 bg-white/60 text-center text-xs text-stone-500">当前继承全局背景<br/>上传后仅覆盖这个地点</div>}
            <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-2 text-sm font-medium text-white"><Upload size={15}/>{backgroundUploadBusy==="location"?"正在处理…":selectedLocation.backgroundImage?"更换此地点背景":"上传此地点背景"}<input type="file" accept="image/*" className="hidden" disabled={backgroundUploadBusy!==null} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void handleLifeBackgroundUpload(file,"location");}}/></label>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <label className="block text-[11px] text-stone-600">模糊 · {selectedLocation.backgroundBlur??0}px<input type="range" min="0" max="18" value={selectedLocation.backgroundBlur??0} onChange={e=>updateSelectedLocationBackground({backgroundBlur:Number(e.target.value)})} className="mt-1.5 w-full"/></label>
              <label className="block text-[11px] text-stone-600">亮度 · {selectedLocation.backgroundBrightness??100}%<input type="range" min="45" max="140" value={selectedLocation.backgroundBrightness??100} onChange={e=>updateSelectedLocationBackground({backgroundBrightness:Number(e.target.value)})} className="mt-1.5 w-full"/></label>
              <label className="block text-[11px] text-stone-600">遮罩 · {selectedLocation.backgroundOverlay??18}%<input type="range" min="0" max="85" value={selectedLocation.backgroundOverlay??18} onChange={e=>updateSelectedLocationBackground({backgroundOverlay:Number(e.target.value)})} className="mt-1.5 w-full"/></label>
            </div>
            
          {(selectedLocation.id === "home" || selectedLocation.id.startsWith("home-")) && <section className="mb-4 rounded-xl border border-stone-200/80 bg-white/80 p-3">
            <h3 className="text-sm font-semibold text-stone-700">同住设置</h3>
            
            <div className="mt-3 space-y-2">{characters.map(character => <label key={character.id} className="flex min-h-11 items-center gap-3 border-b border-stone-100 py-2 text-sm text-stone-700 last:border-0">
              {character.avatar ? <img src={character.avatar} alt="" className="h-8 w-8 rounded-full object-cover"/> : <span className="grid h-8 w-8 place-items-center rounded-full bg-[#efe1d2]">{character.name.slice(0,1)}</span>}
              <span className="min-w-0 flex-1">{character.name}</span>
              <input type="checkbox" checked={(selectedLocation.residents ?? []).includes(character.id) || selectedLocation.id === "home-" + character.id} disabled={selectedLocation.id === "home-" + character.id} onChange={event => {
                const current = stateRef.current;
                const enabled = event.target.checked;
                const homeLocationId = selectedLocation.id;
                // 一个角色同一时间只有一个住处：勾选时从其他 home 型地点移除，取消时补建自己的独居住处。
                let nextLocations = current.locations.map(location => {
                  if (!(location.id === "home" || location.id.startsWith("home-"))) return location;
                  const residents = new Set(location.residents ?? []);
                  // Repair older saved home records whose owner was never stored in residents.
                  if (location.id.startsWith("home-")) residents.add(location.id.slice("home-".length));
                  if (location.id === homeLocationId && enabled) residents.add(character.id); else residents.delete(character.id);
                  return { ...location, residents: [...residents] };
                });
                const personalHomeId = "home-" + character.id;
                if (!enabled) {
                  const existingPersonalHome = nextLocations.find(location => location.id === personalHomeId);
                  if (existingPersonalHome) {
                    nextLocations = nextLocations.map(location => location.id === personalHomeId
                      ? { ...location, residents: [...new Set([...(location.residents ?? []), character.id])] }
                      : location);
                  } else {
                    nextLocations = [...nextLocations, { id: personalHomeId, name: character.name + "的家", description: character.name + "自己的私人住处。", atmosphere: "熟悉、私密、可以放松的空间。", layout: "有自己的起居区域与休息空间。", props: ["沙发", "茶几", "水杯", "床头灯"], visibility: "private" as const, residents: [character.id] }];
                  }
                }
                // Move future home slots through the shared runtime helper. Manual places and
                // work/study/commute/outings are intentionally preserved.
                const now = resolveActorLifeNow(getActorClock(current, "character", character.id)).getTime();
                const destinationHome = nextLocations.find(location => location.id === (enabled ? homeLocationId : personalHomeId));
                const destinationHomeId = enabled ? homeLocationId : personalHomeId;
                const destinationName = destinationHome?.name ?? (enabled ? selectedLocation.name : character.name + "的家");
                const migrated = synchronizeCharacterHomeSchedule(
                  { ...current, locations: nextLocations },
                  { characterId: character.id, destinationHomeId, destinationHomeName: destinationName, now: new Date(now) },
                );
                const synchronizedScheduleCount = migrated.synchronizedScheduleCount;
                const next = migrated.state;
                commit(next);
                setNotice(enabled
                  ? synchronizedScheduleCount
                    ? "同住已保存：已同步 " + synchronizedScheduleCount + " 个未来居家时段到「" + destinationName + "」，工作、学习和外出安排保留。"
                    : "同住关系已保存到「" + destinationName + "」，但当前没有识别到未来居家时段。原有行程未被删除；请检查七日日程中的地点名称，后续生成的居家安排会使用新住处。"
                  : "已取消同住：" + synchronizedScheduleCount + " 个未来居家时段已恢复到" + character.name + "自己的住处，其他行程不变。");
              }} className="h-4 w-4 accent-[var(--life-accent)]"/>
            </label>)}</div>
          </section>}
          <button type="button" onClick={saveLocationDetails} className="w-full rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white active:scale-[.99]">{locationSaveFeedback ? "已保存" : "保存地点设定"}</button>
          <div className="mt-5 border-t border-stone-200/70 pt-4">
            <SectionTitle title="角色在这里的习惯"/>
            <div className="space-y-3">{characters.map(character => {
              const history = state.timeline.filter(entry => entry.locationName === selectedLocation.name && (entry.actorId === character.id || entry.actorName === character.name));
              const frequentActions = [...new Set(history.map(entry => entry.title).filter(Boolean))].slice(0, 4);
              return <div key={character.id} className="rounded-2xl border border-stone-200/70 bg-white/80 p-3">
                <div className="flex items-center gap-2">{character.avatar ? <img src={character.avatar} alt="" className="h-9 w-9 rounded-full object-cover"/> : <span className="grid h-9 w-9 place-items-center rounded-full bg-[#efe1d2]">{character.name.slice(0,1)}</span>}<div className="min-w-0 flex-1"><p className="text-sm font-semibold">{character.name}</p></div></div>
                <label className="mt-3 block text-xs font-medium text-stone-600">地点习惯<textarea value={locationHabitDrafts[character.id] ?? ""} onChange={event => setLocationHabitDrafts(current => ({ ...current, [character.id]: event.target.value }))} rows={2} placeholder="记录角色在此地点的日常习惯" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
                {frequentActions.length > 0 && <div className="mt-2"><p className="text-[10px] font-medium text-stone-500">已记录过的事情</p><div className="mt-1 flex flex-wrap gap-1.5">{frequentActions.map(action => <span key={action} className="rounded-full bg-stone-100 px-2 py-1 text-[10px] text-stone-600">{action}</span>)}</div></div>}
                <button type="button" onClick={() => saveCharacterLocationHabit(character.id)} className="mt-3 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">保存 {character.name} 的习惯</button>
              </div>;
            })}</div>
          </div>
          <div className="mt-5 border-t border-stone-200/70 pt-4"><SectionTitle title="这里发生过什么"/>
            {state.timeline.filter(entry => entry.locationName === selectedLocation.name).slice().sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0,20).length ? <div className="space-y-2">{state.timeline.filter(entry => entry.locationName === selectedLocation.name).slice().sort((a,b) => b.occurredAt.localeCompare(a.occurredAt)).slice(0,20).map(entry => <div key={entry.id} className="rounded-xl bg-white/80 p-3"><p className="text-sm font-medium">{entry.title}</p>{entry.details && <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-stone-500">{entry.details}</p>}<p className="mt-1 text-[10px] text-stone-400">{entry.actorName || "生活记录"} · {new Date(entry.occurredAt).toLocaleString("zh-CN")}</p></div>)}</div> : <p className="rounded-xl bg-white/70 p-4 text-sm text-stone-500">这个地点还没有已发生的生活记录。角色习惯和地点设定保存后，会影响未来互动。</p>}
          </div>
        </section>}
      </div>}

      {libraryLocationSearchOpen && tab === "locations" && <div role="dialog" aria-modal="true" aria-label="搜索地点档案" className="fixed inset-0 z-[150] flex items-end justify-center bg-black/35 p-2 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setLibraryLocationSearchOpen(false)}><section className="max-h-[88dvh] w-full max-w-xl overflow-hidden rounded-3xl border border-white/80 bg-[var(--life-overlay)] shadow-2xl" onClick={event => event.stopPropagation()}><header className="flex items-center justify-between border-b border-stone-200/70 px-4 py-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--life-accent)]">Location library</p><h2 className="text-lg font-semibold">查找地点档案</h2></div><button type="button" onClick={() => setLibraryLocationSearchOpen(false)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full bg-white/75"><X size={18}/></button></header><div className="space-y-2 p-3"><input autoFocus value={libraryLocationSearch} onChange={event => setLibraryLocationSearch(event.target.value)} placeholder="搜索地点名称、别名或描写" className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/><div className="grid grid-cols-1 gap-2"><select value={libraryLocationFolderFilter} onChange={event => setLibraryLocationFolderFilter(event.target.value)} className="min-w-0 rounded-xl border border-stone-200 bg-white px-2 py-2 text-xs"><option value="all">全部文件夹</option><option value="unfiled">未整理</option>{locationFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></div></div><div className="max-h-[58dvh] space-y-1 overflow-y-auto px-3 pb-3">{filteredLibraryLocations.map(location => <button type="button" key={location.id} onClick={() => { setSelectedLocationId(location.id); setLocationDossierOpen(true); setLibraryLocationSearchOpen(false); }} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-stone-200/70 bg-white/75 p-3 text-left"><span className="min-w-0"><span className="block font-medium text-stone-800">{location.name}</span><span className="mt-1 block truncate text-xs text-stone-500">{location.description || "暂无地点描写"}</span></span><span className="shrink-0 text-xs text-[var(--life-accent)]">编辑档案 ›</span></button>)}{!filteredLibraryLocations.length && <p className="p-6 text-center text-sm text-stone-500">没有找到地点</p>}</div></section></div>}
      {folderDialogOpen && tab === "locations" && <div role="dialog" aria-modal="true" aria-label="地点文件夹管理" className="fixed inset-0 z-[160] flex items-end justify-center bg-black/35 p-2 backdrop-blur-sm sm:items-center sm:p-4" onClick={() => setFolderDialogOpen(false)}><section className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-[var(--life-overlay)] p-4 shadow-2xl" onClick={event => event.stopPropagation()}><header className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold text-stone-800">文件夹</h2><button type="button" onClick={() => setFolderDialogOpen(false)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full bg-white"><X size={18}/></button></header><form onSubmit={event => { event.preventDefault(); saveLocationFolder(); }} className="flex gap-2"><input autoFocus value={folderNameDraft} onChange={event => setFolderNameDraft(event.target.value)} placeholder={editingFolderId ? "重命名文件夹" : "新建文件夹名称"} className="min-w-0 flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/><button type="submit" className="rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">{editingFolderId ? "保存" : "创建"}</button>{editingFolderId && <button type="button" onClick={() => { setEditingFolderId(null); setFolderNameDraft(""); }} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs">取消</button>}</form><div className="mt-4 space-y-2">{locationFolders.map(folder => <div key={folder.id} className="flex items-center gap-2 rounded-xl border border-stone-200/70 bg-white/75 p-3"><span className="min-w-0 flex-1 text-sm text-stone-700">{folder.name} · {state.locations.filter(location => location.folderId === folder.id).length}</span><button type="button" onClick={() => { setEditingFolderId(folder.id); setFolderNameDraft(folder.name); }} className="rounded-lg border border-stone-200 px-3 py-1.5 text-xs">重命名</button><button type="button" onClick={() => setFolderDeleteConfirmId(folder.id)} className="rounded-lg border border-rose-200 px-3 py-1.5 text-xs text-rose-700">删除</button></div>)}{!locationFolders.length && <p className="rounded-xl bg-white/65 p-4 text-center text-xs text-stone-500">还没有文件夹</p>}</div>{folderDeleteConfirmId && <div className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3"><p className="text-sm text-rose-800">删除后，文件夹内地点会移入「未整理」，不会删除地点本身。</p><div className="mt-2 flex justify-end gap-2"><button type="button" onClick={() => setFolderDeleteConfirmId(null)} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-xs">取消</button><button type="button" onClick={() => deleteLocationFolder(folderDeleteConfirmId)} className="rounded-lg bg-rose-600 px-3 py-2 text-xs text-white">确认删除</button></div></div>}</section></div>}
      {tab === "daily" && <div role="tablist" aria-label="角色日程视图" className="mb-4 grid grid-cols-3 gap-1 rounded-2xl border border-white/80 bg-white/55 p-1">
        <button type="button" role="tab" aria-selected={dailySubtab === "people"} onClick={() => setDailySubtab("people")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "people" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>角色动态</button>
        <button type="button" role="tab" aria-selected={dailySubtab === "plans"} onClick={() => setDailySubtab("plans")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "plans" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>七日日程</button>
        <button type="button" role="tab" aria-selected={dailySubtab === "observe"} onClick={() => setDailySubtab("observe")} className={`min-w-0 rounded-xl px-2 py-2.5 text-sm transition ${dailySubtab === "observe" ? "bg-white font-semibold text-[var(--life-accent)] shadow-sm" : "text-stone-500"}`}>观察生活</button>
      </div>}
      {tab === "daily" && dailySubtab === "observe" && <div className="rounded-3xl border border-white/80 bg-white/55 p-3 shadow-sm sm:p-4"><LifeObservation characters={characters} active={true} onNotice={setNotice} /></div>}
      {(tab === "people" || (tab === "daily" && dailySubtab === "people")) && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <SectionTitle title="角色动态" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {characters.map(character => {
            const presence = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
            const realNow = resolveActorLifeNow(getActorClock(state, "character", character.id));
            const schedule = getCurrentActorSchedule(state, "character", character.id, realNow);
            const actualLocation = presence?.actualLocationName || state.locations.find(item => item.id === presence?.actualLocationId)?.name;
            const scene = state.scenes.find(item => item.status === "active" && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id)) ?? state.scenes.filter(item => item.status === "paused" && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            const place = actualLocation || schedule?.plannedLocationName || scene?.locationName;
            const isActual = !!actualLocation;
            return <article key={character.id} className="rounded-2xl border border-stone-200/80 bg-white/75 p-4">
              <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate text-sm font-semibold">{character.name}</h3><p className="mt-1 text-xs text-stone-500">角色生活动态 · 具体时段不公开</p></div><span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${isActual?"bg-emerald-50 text-emerald-700":"bg-amber-50 text-amber-700"}`}>{isActual?"位置已记录":place?"按日程推测":"位置未知"}</span></div>
              <div className="mt-3 rounded-xl bg-stone-50/90 p-3"><p className="text-sm font-medium">{presence?.activity || schedule?.title || "暂未记录当前活动"}</p><p className="mt-1 text-xs text-stone-500">地点：{place || "未知"}{!isActual && schedule?.plannedLocationName ? "（计划地点，不代表实时在场）" : ""}</p>{scene && <p className="mt-1 text-[11px] text-[var(--life-accent)]">正在互动场景中</p>}</div>
              <div className="mt-3 flex gap-2"><button type="button" onClick={()=>goToCharacter(character)} disabled={!place} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs font-medium text-white disabled:opacity-40">去找 TA</button><button type="button" onClick={()=>{setSelectedActorKey("character:"+character.id);openDaily("plans");}} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">看日程</button></div>
            </article>;
          })}
          {characters.length===0 && <p className="rounded-xl bg-white/60 p-4 text-sm text-stone-500">还没有载入角色。添加角色后，这里会统一显示他们的动态。</p>}
        </div>
      </section>}

      {(tab === "plans" || (tab === "daily" && dailySubtab === "plans")) && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="mb-4 rounded-2xl border border-[#d9c2ae] bg-[#fbf5ee] p-3 sm:p-4">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0"><p className="text-sm font-semibold text-stone-800">AI 自动规划角色七日日程</p><p className="mt-1 max-w-xl text-xs leading-relaxed text-stone-500">不用手动填。AI 会读取每个角色的人设、近期共同记忆、生活记录、世界书、地点习惯和当前预设；生成后仍可微调。</p></div>
            <div className="flex w-full min-w-0 flex-wrap gap-2 sm:w-auto sm:shrink-0">
              <button type="button" onClick={syncAllCharactersToSchedules} className="min-w-0 w-full whitespace-nowrap rounded-xl border border-[#d9c2ae] bg-white px-3 py-3 text-center text-sm font-semibold text-stone-700 sm:w-auto sm:px-4">同步全部角色当前位置</button>

              <button type="button" onClick={() => void regenerateAllCharacterSchedulesWithAI()} disabled={batchScheduleGenerating || scheduleRegenerationOwnerId !== null || characters.length === 0} className="inline-flex min-w-0 w-full items-center justify-center gap-2 whitespace-nowrap rounded-xl bg-[var(--life-accent)] px-3 py-3 text-sm font-semibold text-white shadow-sm disabled:opacity-50 sm:w-auto sm:shrink-0 sm:px-4"><Sparkles size={15}/>{batchScheduleGenerating ? "AI 正在逐个规划…" : "AI 生成全部角色日程"}</button>
            </div>
          </div>

          <div className="mt-4 border-t border-[#e6d5c4] pt-3">
            <p className="text-sm font-semibold text-stone-800">AI 日程指导 · 先预览再保存</p>
            
            <div className="mt-3 rounded-xl border border-stone-200 bg-white/80 p-3">
              <p className="mb-2 text-xs text-stone-500">安排对象（可多选）</p>
              <div className="flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-1">{actors.map(actor=>{const key=actor.ownerType+":"+actor.ownerId;return <label key={key} className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-2 text-xs"><input type="checkbox" checked={scheduleGuidanceActorKeys.includes(key)} onChange={event=>setScheduleGuidanceActorKeys(current=>event.target.checked?[...new Set([...current,key])]:current.filter(value=>value!==key))}/>{actor.name}{actor.ownerType==="player"?"（我）":"（角色）"}</label>;})}</div>
            </div>
            <textarea value={scheduleGuidanceText} onChange={event=>setScheduleGuidanceText(event.target.value)} rows={3} placeholder="例如：工作日晚上留一小时学习；周三下午不要安排活动；周六和我一起去公园散步。" className="mt-2 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
            <button type="button" onClick={()=>void generateGuidedScheduleDrafts()} disabled={guidedScheduleBusy||!scheduleGuidanceText.trim()||scheduleGuidanceActorKeys.length===0} className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50"><Sparkles size={14}/>{guidedScheduleBusy?"AI 正在分析现有日程…":"AI 生成待确认预览"}</button>
          </div>
          <div className="mt-4 border-t border-[#e6d5c4] pt-3"><p className="text-sm font-semibold text-stone-800">手动补充 · 一句话安排日程</p>
          </div>
          <textarea value={quickPlanText} onChange={e=>setQuickPlanText(e.target.value)} rows={3} placeholder={"明天下午3点到5点在咖啡馆画画\n周五晚上7点去公园散步"} className="mt-3 w-full resize-y rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
          <button type="button" onClick={()=>{
            const lines=quickPlanText.split(/\n|；|;/).map(line=>line.trim()).filter(Boolean);
            if(!lines.length){setNotice("先写下你想安排的事情。");return;}
            let next=stateRef.current;const drafts:QuickPlanDraft[]=[];const errors:string[]=[];
            const periodPattern="(?:上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?";
            // 支持「3点」「3点半」「3点30分」「15:30」「下午3时」等常见写法。
            const clockPattern=periodPattern+"\\s*\\d{1,2}(?:\\s*(?::|：)\\s*\\d{1,2}|\\s*点(?:\\s*\\d{1,2}\\s*分?)?|\\s*时(?:\\s*\\d{1,2}\\s*分?)?)?";
            const parseClock=(raw:string, fallbackHour:number)=>{
              const m=raw.trim().match(/^(上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)?\s*(\d{1,2})(?:(?:\s*[:：]\s*(\d{1,2}))|(?:\s*点(?:\s*(\d{1,2})\s*分?)?)|(?:\s*时(?:\s*(\d{1,2})\s*分?)?))?$/);
              if(!m)return {hour:fallbackHour,minute:0};
              let hour=Number(m[2]);const minute=Number(m[3]??m[4]??m[5]??0);const period=m[1]||"";
              if(["下午","傍晚","晚上","夜里"].includes(period)&&hour<12)hour+=12;
              if(["凌晨"].includes(period)&&hour===12)hour=0;
              if(["中午"].includes(period)&&hour<11)hour+=12;
              if(["上午","早上","清晨"].includes(period)&&hour===12)hour=0;
              return {hour:Math.min(23,Math.max(0,hour)),minute:Math.min(59,Math.max(0,minute))};
            };
            for(const line of lines){
              const pref=line.match(/^([^：:]{1,30})[：:]\s*(.+)$/);
              const namedActor=pref?actors.find(a=>a.name.trim()===pref[1].trim()):undefined;
              const actor=namedActor||(selectedActor&&selectedActor.ownerType?selectedActor:actors[0]);
              let body=(pref?pref[2]:line).trim();
              const chineseNumber = (raw: string) => {
                const digits: Record<string, number> = {"零":0,"〇":0,"一":1,"二":2,"两":2,"三":3,"四":4,"五":5,"六":6,"七":7,"八":8,"九":9};
                if (/^\d+$/.test(raw)) return Number(raw);
                if (raw.includes("十")) {
                  const [tens, ones] = raw.split("十");
                  return (tens ? digits[tens] ?? 0 : 1) * 10 + (ones ? digits[ones] ?? 0 : 0);
                }
                return digits[raw] ?? Number.NaN;
              };
              body = body
                .replace(/([零〇一二两三四五六七八九十]{1,3})\s*点\s*半/g, (_match, number: string) => String(chineseNumber(number)) + "点30分")
                .replace(/([零〇一二两三四五六七八九十]{1,3})\s*(?=点|时|分)/g, (_match, number: string) => String(chineseNumber(number)))
                .replace(/(\d{1,2})\s*点\s*半/g, "$1点30分")
                .replace(/点([零〇一二两三四五六七八九十]{1,2})\s*分/g, (_match, number: string) => "点" + String(chineseNumber(number)) + "分")
                .replace(/时([零〇一二两三四五六七八九十]{1,2})\s*分/g, (_match, number: string) => "时" + String(chineseNumber(number)) + "分")
                .replace(/(\d{1,2})\s+点/g, "$1点")
                .replace(/([点时])\s+(\d{1,2})/g, "$1$2")
                .replace(/(\d{1,2})\s*分/g, "$1分");
              const day=new Date(actorNow(actor));day.setSeconds(0,0);
              if(/后天/.test(body))day.setDate(day.getDate()+2);else if(/明天|明日/.test(body))day.setDate(day.getDate()+1);else if(/今天|今日/.test(body)){}else{
                const weekday=body.match(/周([一二三四五六日天])|星期([一二三四五六日天])/);
                if(weekday){const weekMap:Record<string,number>={"一":1,"二":2,"三":3,"四":4,"五":5,"六":6,"日":0,"天":0};const n=weekMap[weekday[1]||weekday[2]]??0;let delta=(n-day.getDay()+7)%7;if(delta===0)delta=7;day.setDate(day.getDate()+delta);}
              }
              const range=body.match(new RegExp("("+clockPattern+")\\s*(?:到|至|—|-|~|～)\\s*("+clockPattern+")"));
              const single=body.match(new RegExp("(?:在|于|约|大概)?\\s*("+clockPattern+")"));
              if(!range&&!single){errors.push(line);continue;}
              const startClock=parseClock(range?.[1]||single?.[1]||"",9);
              const endClock=range?parseClock(range[2],startClock.hour+1):{hour:(startClock.hour+1)%24,minute:startClock.minute};if(range&&startClock.hour>=12&&startClock.hour<20&&endClock.hour<startClock.hour&&!/(上午|早上|清晨|中午|下午|傍晚|晚上|夜里|凌晨)/.test(range[2]))endClock.hour+=12;
              const start=new Date(day);start.setHours(startClock.hour,startClock.minute,0,0);
              const end=new Date(day);end.setHours(endClock.hour,endClock.minute,0,0);if(end<=start)end.setDate(end.getDate()+1);
              const knownLocation=next.locations.find(loc=>[loc.name,...(loc.aliases??[])].some(alias=>alias && body.includes(alias)));
              // Prefer known places directly. Otherwise strip date/time first, so a range's
              // connector (e.g. 「到9点」) can never be mistaken for a location name.
              const placeSearchText=body
                .replace(/后天|明天|明日|今天|今日|周[一二三四五六日天]|星期[一二三四五六日天]/g,"")
                .replace(new RegExp("("+clockPattern+")\\s*(?:到|至|—|-|~|～)\\s*("+clockPattern+")","g")," ")
                .replace(new RegExp(clockPattern,"g")," ")
                .replace(/[到至—~～-]/g," ");
              const placeMatch=knownLocation?null:placeSearchText.match(/(?:在|去|到|于|回)\s*([^，,。；;\s]+?)(?=(?:做|和|跟|一起|参加|开会|学习|工作|看|吃|喝|玩|逛|运动|散步|读|写|画|练|休息|睡|聊|见|约|$))/);
              const placeName=knownLocation?.name||placeMatch?.[1];
              let location=knownLocation;
              if(!location&&placeName){location={id:id("location"),name:placeName,description:"从快速日程输入识别的地点",visibility:"public"};next={...next,locations:[...next.locations,location]};}
              let title=body
                .replace(/后天|明天|明日|今天|今日|周[一二三四五六日天]|星期[一二三四五六日天]/g,"")
                .replace(new RegExp("("+clockPattern+")\\s*(?:到|至|—|-|~|～)\\s*("+clockPattern+")","g"),"")
                .replace(new RegExp(clockPattern,"g"),"");
              if(placeMatch)title=title.replace(placeMatch[0],"");
              else if(location){for(const prefix of ["在","去","到","于"])title=title.replace(prefix+location.name,"");}
              title=title.replace(/\s+/g," ").replace(/^[，,、\s]+|[，,。；;\s]+$/g,"").trim();
              if(!title)title=location?"在"+location.name+"活动":"日程安排";
              const actual=next.actorStates.find(item=>item.ownerType===actor.ownerType&&item.ownerId===actor.ownerId);
              drafts.push({id:id("quick-plan-draft"),ownerType:actor.ownerType,ownerId:actor.ownerId,startAt:start.toISOString(),endAt:end.toISOString(),title,locationName:location?.name??actual?.actualLocationName??""});
            }
            if(drafts.length){setQuickPlanDrafts(drafts);setNotice("识别出 "+drafts.length+" 条待确认日程。请检查并修改下面的表单，再点击确认保存。");}
            else setNotice("没能识别出时间范围。试试“明天下午3点到5点在咖啡馆画画”，一件事写一行。");
            if(errors.length&&drafts.length)setNotice("识别出 "+drafts.length+" 条；另有 "+errors.length+" 条未识别，请补充明确时间后重新识别。");
          }} className="mt-2 rounded-xl bg-[var(--life-accent)] px-4 py-2.5 text-sm font-medium text-white">识别并填入日程</button>
          {quickPlanDrafts.length>0 && <div className="mt-4 rounded-2xl border border-stone-200 bg-white/85 p-3">
            <div className="mb-3 flex items-center justify-between gap-2"><p className="text-sm font-semibold">识别结果 · {quickPlanDrafts.length} 条待保存</p><button type="button" onClick={()=>setQuickPlanDrafts([])} className="text-xs text-stone-500">清空</button></div>
            <div className="space-y-3">{quickPlanDrafts.map((draft,index)=>{const owner=actors.find(actor=>actor.ownerType===draft.ownerType&&actor.ownerId===draft.ownerId);const update=(patch:Partial<QuickPlanDraft>)=>setQuickPlanDrafts(items=>items.map(item=>item.id===draft.id?{...item,...patch}:item));return <div key={draft.id} className="rounded-xl border border-stone-200/80 bg-[#fffdf9] p-3">
              <p className="mb-2 text-xs font-medium text-[var(--life-accent)]">安排 {index+1} · {owner?.name??"角色"} · {({add:"新增",move:"移动",update:"修改",cancel:"取消"} as Record<string,string>)[draft.operation??"add"]}</p>
              {draft.reason && <p className="mb-2 text-[11px] leading-relaxed text-stone-500">调整理由：{draft.reason}</p>}
              {draft.operation !== "cancel" && <div className="grid gap-2 sm:grid-cols-2"><label className="text-[11px] text-stone-500">开始时间<input type="datetime-local" value={toLocalDateTimeInput(draft.startAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)update({startAt:value});}} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500">结束时间<input type="datetime-local" value={toLocalDateTimeInput(draft.endAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)update({endAt:value});}} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label></div>}
              {draft.operation === "cancel" && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">这项未来安排将在确认时取消；固定或已确认邀约不会进入可取消预览。</p>}
              <label className="mt-2 block text-[11px] text-stone-500">活动内容<input value={draft.title} onChange={e=>update({title:e.target.value})} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label>
              <label className="mt-2 block text-[11px] text-stone-500">计划地点（可选已有地点或自定义）<input list={"life-location-options-" + draft.id} value={draft.locationName} onChange={e=>update({locationName:e.target.value})} placeholder="输入地点名，或从已有地点中选择" className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/><datalist id={"life-location-options-" + draft.id}>{visibleLocations.map(location=><option key={location.id} value={location.name}/>)}</datalist></label>{draft.locationName.trim() && !state.locations.some(location=>location.name.trim().toLocaleLowerCase()===draft.locationName.trim().toLocaleLowerCase()) && <label className="mt-2 flex items-center gap-2 text-[11px] text-stone-500"><input type="checkbox" checked={Boolean(draft.saveLocationToLibrary)} onChange={e=>update({saveLocationToLibrary:e.target.checked})} className="accent-[var(--life-accent)]"/>同时保存为地点库中的新地点</label>}
              <button type="button" onClick={()=>setQuickPlanDrafts(items=>items.filter(item=>item.id!==draft.id))} className="mt-2 text-xs text-rose-600">删除这条</button>
            </div>})}</div>
            <div className="mt-3 flex gap-2"><button type="button" onClick={()=>setQuickPlanDrafts([])} className="flex-1 rounded-xl border border-stone-200 px-3 py-2.5 text-sm">取消</button><button type="button" onClick={confirmQuickPlanDrafts} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm font-medium text-white">确认保存调整</button></div>
          </div>}
        </div>
      </section>}
      {(tab === "plans" || (tab === "daily" && dailySubtab === "plans")) && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3"><SectionTitle title="你和角色的七日日程" /><button onClick={ensurePlans} title="只补全本地规则缺失的时间段，不替代 AI 生成" className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600"><RefreshCw size={14}/>补全缺失时段</button></div>
        {actors.map(actor => {
          const realNow = actorNow(actor);
          const slots = state.schedules.filter(slot => slot.ownerType === actor.ownerType && slot.ownerId === actor.ownerId && new Date(slot.endAt).getTime() > realNow.getTime() - DAY_MS).sort((x,y) => x.startAt.localeCompare(y.startAt));
          const byDay = new Map<string, typeof slots>();
          for (const slot of slots) { const day = localDateKey(slot.startAt) || "日期未知"; const group = byDay.get(day) ?? []; group.push(slot); byDay.set(day,group); }
          const today = localDateKey(realNow.toISOString());
          return <details key={actor.ownerType + ":" + actor.ownerId} className="mb-3 overflow-hidden rounded-2xl border border-stone-200/80 bg-white/75">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-3 marker:hidden">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--life-accent)]/10 text-sm font-semibold text-[var(--life-accent)]">{actor.name.slice(0,1)}</span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-stone-800">{actor.name}</span><span className="block pt-0.5 text-[10px] text-stone-500">{actor.ownerType === "player" ? "我的行程" : "角色行程"} · {slots.length} 条 · {byDay.size} 天</span></span><ChevronDown size={16} className="text-stone-400"/>
            </summary>
            <div className="space-y-2 border-t border-stone-100 p-2.5">
              <div className="flex gap-2">{actor.ownerType === "character" && <button type="button" disabled={scheduleRegenerationOwnerId !== null || batchScheduleGenerating} onClick={() => void regenerateActorScheduleWithAI(actor)} className="rounded-lg border border-[var(--life-accent)]/30 bg-white px-3 py-2 text-[11px] text-[var(--life-accent)] disabled:opacity-50">{scheduleRegenerationOwnerId === actor.ownerId ? "AI 正在规划…" : "AI 重新生成"}</button>}<button type="button" onClick={() => addManualPlan(actor)} className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-[11px]">＋ 添加日程</button></div>
              {[...byDay.entries()].sort(([x],[y]) => x.localeCompare(y)).map(([dayKey,daySlots]) => <details key={dayKey} open={actor.ownerType === "player" && dayKey === today} className="rounded-xl border border-stone-200/70 bg-[#fcfaf6]">
                <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-3 text-xs marker:hidden"><span className="flex-1 font-medium text-stone-700">{dayKey === "日期未知" ? dayKey : new Date(daySlots[0].startAt).toLocaleDateString("zh-CN",{month:"long",day:"numeric",weekday:"long"})}</span><span className="rounded-full bg-stone-100 px-2 py-0.5 text-[10px] text-stone-500">{daySlots.length} 项</span><ChevronDown size={14} className="text-stone-400"/></summary>
                <div className="space-y-2 border-t border-stone-100 p-2">{daySlots.map(slot => { const conflict = findScheduleConflict(slot, slots); return <div key={slot.id} className="rounded-xl border border-stone-200/70 bg-white p-3">
                  {actor.ownerType === "character" && editingRoleScheduleId !== slot.id ? <div><div className="flex items-center justify-between gap-2"><span className="text-[10px] text-stone-400">行程线索</span><button type="button" onClick={() => setEditingRoleScheduleId(slot.id)} className="rounded-full border border-[#d9c2ae] bg-white px-3 py-1.5 text-[11px] text-[#8f6755]">微调</button></div><p className="mt-1.5 text-sm font-medium text-stone-700">{slot.title}</p><span className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full bg-[#efe1d2] px-2.5 py-1 text-xs text-stone-700"><MapPin size={12}/><span className="break-words">{slot.plannedLocationName || "地点暂未确定"}</span></span></div>
                  : <div className="grid gap-2 sm:grid-cols-2"><label className="text-[11px] text-stone-500">开始<input type="datetime-local" value={toLocalDateTimeInput(slot.startAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)updateManualPlan(slot,{startAt:value});}} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500">结束<input type="datetime-local" value={toLocalDateTimeInput(slot.endAt)} onChange={e=>{const value=fromLocalDateTimeInput(e.target.value);if(value)updateManualPlan(slot,{endAt:value});}} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-2 py-2 text-xs"/></label><label className="text-[11px] text-stone-500 sm:col-span-2">活动<input value={slot.title} onChange={e=>updateManualPlan(slot,{title:e.target.value})} onBlur={()=>recordManualPlanEdit(slot)} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="text-[11px] text-stone-500 sm:col-span-2">地点（可选择已有地点，也可输入自定义地点）<input list={"role-schedule-locations-" + slot.id} value={slot.plannedLocationName ?? ""} onChange={e=>updateManualPlan(slot,{plannedLocationName:e.target.value})} onBlur={()=>{recordManualPlanEdit(slot);const name=(slot.plannedLocationName ?? "").trim();const current=stateRef.current;if(name&&saveCustomScheduleLocations[slot.id]&&!current.locations.some(location=>location.name.trim().toLocaleLowerCase()===name.toLocaleLowerCase())){const location={id:id("location"),name,description:"从角色日程编辑添加的地点",visibility:"public" as const};commit({...current,locations:[...current.locations,location],schedules:current.schedules.map(item=>item.id===slot.id?{...item,plannedLocationId:location.id,plannedLocationName:name,updatedAt:new Date().toISOString()}:item)});setSaveCustomScheduleLocations(items=>({...items,[slot.id]:false}));setNotice("已将「"+name+"」保存到地点库并关联当前日程。");}}} className="mt-1 w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"/><datalist id={"role-schedule-locations-" + slot.id}>{visibleLocations.map(location=><option key={location.id} value={location.name}/>)}</datalist></label>{(slot.plannedLocationName ?? "").trim()&&!state.locations.some(location=>location.name.trim().toLocaleLowerCase()===(slot.plannedLocationName ?? "").trim().toLocaleLowerCase())&&<label className="mt-1 flex items-center gap-2 text-[10px] text-stone-500 sm:col-span-2"><input type="checkbox" checked={Boolean(saveCustomScheduleLocations[slot.id])} onChange={e=>setSaveCustomScheduleLocations(items=>({...items,[slot.id]:e.target.checked}))} className="accent-[var(--life-accent)]"/>将自定义地点保存到地点库</label>}</div>}
                  <div className="mt-2 flex items-center justify-between gap-2"><span className="text-[10px] text-stone-400">{actor.ownerType === "player" ? fmt(new Date(slot.startAt)) + " – " + fmt(new Date(slot.endAt)) + " · " : ""}{slot.source === "manual" ? "手动日程" : slot.source === "character-tool" ? "角色主动调整" : "可编辑计划"}</span><div className="flex flex-wrap items-center gap-2">{actor.ownerType === "character" && slot.source === "manual" && <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700">已改</span>}{actor.ownerType === "character" && conflict && <><span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] text-rose-700"><span className="h-1.5 w-1.5 rounded-full bg-rose-500"/>时间冲突</span><button type="button" onClick={() => resolveScheduleConflict(slot, slots)} className="rounded-lg border border-rose-200 bg-white px-2 py-1 text-[10px] text-rose-700">自动顺延</button></>}{actor.ownerType === "character" && editingRoleScheduleId === slot.id && <button type="button" onClick={() => setEditingRoleScheduleId(null)} className="rounded-lg border border-[#d9c2ae] px-2.5 py-1.5 text-[11px] text-[#8f6755]">完成</button>}<button type="button" onClick={() => deleteManualPlan(slot)} className="rounded-lg border border-stone-200 px-2.5 py-1.5 text-[11px] text-stone-500">删除</button></div></div>
                </div>; })}</div>
              </details>)}
              {slots.length === 0 && <p className="rounded-xl bg-white/60 p-3 text-xs text-stone-400">还没有日程，可以直接添加或补全缺失时段。</p>}
            </div>
          </details>;
        })}
      </section>}



      {tab === "invitations" && <div className="grid gap-4 lg:grid-cols-[.85fr_1.15fr]">
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle title="创建邀约" />
          <form onSubmit={addInvitation} className="space-y-3"><label className="block text-sm">邀请谁<select value={inviteCharacterId} onChange={e=>setInviteCharacterId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="">选择角色</option>{characters.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label className="block text-sm">事件 / 活动<input value={inviteActivity} onChange={e=>setInviteActivity(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">邀约理由<textarea value={inviteReason} onChange={e=>setInviteReason(e.target.value)} placeholder="例如：最近想和你聊聊，或者想把这件有趣的事分享给你" rows={2} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="block text-sm">时间<input type="datetime-local" value={inviteAt} onChange={e=>{setInviteAtEdited(true);setInviteAt(e.target.value)}} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/><span className="mt-1 block text-[11px] text-stone-500">默认按你的现实时间预填；系统会根据现实时间和双方现有日程检查是否来得及赴约。</span></label><label className="block text-sm">地点<select value={inviteLocationId} onChange={e=>setInviteLocationId(e.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5">{visibleLocations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label><button disabled={busy} className="w-full rounded-2xl bg-[var(--life-accent)] px-4 py-3 text-sm font-medium text-white disabled:opacity-50">{busy?"等待角色回应…":"发出邀约"}</button></form>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle title="邀约记录" />
          {state.invitations.length===0?<p className="rounded-2xl bg-white/60 p-4 text-sm text-stone-400">这里会保存待确认、已确认和已取消的邀约。</p>:<div className="space-y-3">{state.invitations.map(invite=>{const char=characters.find(c=>c.id===invite.characterId);const editable=invite.status==="proposed"||invite.status==="confirmed";const editing=editingInvitationId===invite.id;return <div key={invite.id} className="rounded-2xl border border-stone-200/70 bg-white/70 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{char?.name??"未知角色"} · {invite.kind==="follow-request"?"陪伴申请":"邀约"} · {invite.activity}</p><p className="mt-1 text-xs text-stone-500">{fmt(invite.proposedAt)} · {invite.kind==="follow-request"?(invite.durationMinutes??120)+" 分钟 · 跟随你的实际行程":invite.locationName??"地点待定"} · {invite.durationMinutes??60} 分钟</p>{invite.reason&&<p className="mt-1 text-xs leading-relaxed text-stone-600">理由：{invite.reason}</p>}{invite.responseReason&&<p className="mt-1 text-xs leading-relaxed text-stone-600">回应：{invite.responseReason}</p>}</div><span className="shrink-0 rounded-full bg-[#f0e3d5] px-2.5 py-1 text-[11px]">{(invite.status==="proposed"&&invite.proposedBy==="player"?"等待角色回应":({proposed:"待确认",confirmed:"已确认",declined:"已拒绝",cancelled:"已取消",completed:"已完成"} as Record<string,string>)[invite.status])}</span></div>{editing&&<div className="mt-4 grid gap-3 rounded-2xl bg-[#faf5ef] p-3"><label className="block text-xs">活动内容<input value={editInvitationDraft.activity} onChange={e=>setEditInvitationDraft(d=>({...d,activity:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">邀约理由<textarea value={editInvitationDraft.reason} onChange={e=>setEditInvitationDraft(d=>({...d,reason:e.target.value}))} rows={2} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">时间<input type="datetime-local" value={editInvitationDraft.proposedAt} onChange={e=>setEditInvitationDraft(d=>({...d,proposedAt:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label><label className="block text-xs">持续时长（分钟）<input type="number" min={15} max={1440} step={15} value={editInvitationDraft.durationMinutes} onChange={e=>setEditInvitationDraft(d=>({...d,durationMinutes:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"/></label>{invite.kind!=="follow-request"&&<label className="block text-xs">地点<select value={editInvitationDraft.locationId} onChange={e=>setEditInvitationDraft(d=>({...d,locationId:e.target.value}))} className="mt-1 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm">{visibleLocations.map(loc=><option key={loc.id} value={loc.id}>{loc.name}</option>)}</select></label>}<div className="flex gap-2"><button type="button" onClick={()=>saveInvitationEdit(invite.id)} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">保存并同步日程</button><button type="button" onClick={()=>setEditingInvitationId(null)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">取消编辑</button></div></div>}{!editing&&<div className="mt-3 flex flex-wrap gap-2">{invite.status==="proposed"&&invite.proposedBy!=="player"&&<><button onClick={()=>confirmInvitation(invite.id)} className="rounded-xl bg-[var(--life-accent)] px-3 py-2 text-xs text-white">{invite.kind==="follow-request"?"接受陪伴申请":"确认并同步日程"}</button><button onClick={()=>declineInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">拒绝</button></>}{editable&&<button onClick={()=>beginEditInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">编辑 / 重新安排</button>}{editable&&<button onClick={()=>cancelInvitation(invite.id)} className="rounded-xl border border-red-200 px-3 py-2 text-xs text-red-600">取消邀约</button>}{(invite.status==="declined"||invite.status==="cancelled")&&<button onClick={()=>reuseInvitation(invite.id)} className="rounded-xl border border-stone-200 px-3 py-2 text-xs">复制并重新发起</button>}</div>}</div>;})}</div>}
        </section>
      </div>}

      {tab === "experiences" && <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6">
        <SectionTitle title="共同经历" />
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-medium text-stone-600">参与角色
            <select value={experienceActorFilter} onChange={event => setExperienceActorFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="all">所有角色</option>
              {actors.map(actor => <option key={actor.ownerType + ":" + actor.ownerId} value={actor.ownerId}>{actor.name}</option>)}
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">记录类型
            <select value={experienceCategoryFilter} onChange={event => setExperienceCategoryFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="all">全部类型</option>
              <option value="location">地点变化</option><option value="scene">场景</option><option value="action">行动</option><option value="dialogue">对话</option><option value="schedule">日程</option><option value="tool">工具</option><option value="social">社交动态</option><option value="diary">日记</option><option value="chat">消息</option><option value="system">系统记录</option>
            </select>
          </label>
          <label className="block text-xs font-medium text-stone-600">指定日期
            <input type="date" value={experienceDateFilter} onChange={event => setExperienceDateFilter(event.target.value)} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/>
          </label>
          <label className="block text-xs font-medium text-stone-600">分组方式
            <select value={experienceGroupBy} onChange={event => setExperienceGroupBy(event.target.value as "date" | "character")} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">
              <option value="date">按日期分组</option><option value="character">按角色分组</option>
            </select>
          </label>
        </div>
        <div className="mb-3 flex items-center justify-between gap-3 text-xs text-stone-500"><span>找到 {experienceTimeline.length} 条记录</span><button type="button" onClick={() => { setExperienceActorFilter("all"); setExperienceCategoryFilter("all"); setExperienceDateFilter(""); setExperienceGroupBy("date"); }} className="rounded-lg border border-stone-200 bg-white px-3 py-1.5">重置筛选</button></div>
        {sortedExperienceGroups.length === 0 ? <div className="rounded-2xl bg-white/65 p-8 text-center"><p className="text-sm font-medium text-stone-700">还没有符合条件的经历</p><p className="mt-1 text-xs text-stone-500">开始行动、聊天或一起参加活动后，记录会逐渐出现在这里。</p></div> : <div className="max-h-[62dvh] space-y-4 overflow-y-auto overscroll-contain touch-pan-y pr-1" style={{ WebkitOverflowScrolling: "touch" }}>
          {sortedExperienceGroups.map(([groupKey, entries]) => <section key={groupKey} className="overflow-hidden rounded-2xl border border-stone-200/70 bg-white/60">
            <h3 className="border-b border-stone-200/70 bg-[#fbf7f0] px-4 py-3 text-sm font-semibold text-stone-700">{experienceGroupBy === "date" ? (groupKey === "日期未知" ? groupKey : new Date(groupKey + "T12:00:00").toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" })) : groupKey}</h3>
            <div className="space-y-2 p-3">{entries.map(entry => <article key={entry.id} className="flex gap-3 rounded-xl bg-white/85 p-3">
              <span className="w-12 shrink-0 pt-0.5 text-[11px] tabular-nums text-stone-400">{new Date(entry.occurredAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
              <div className="min-w-0 flex-1"><p className="break-words text-sm font-medium text-stone-800">{entry.title}</p>{entry.details && <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">{entry.details}</p>}
                <p className="mt-1 text-[10px] text-stone-400">{experienceGroupBy === "character" ? localDateKey(entry.occurredAt) + " · " : ""}{entry.actorName ? entry.actorName + " · " : ""}{entry.locationName ? entry.locationName + " · " : ""}{entry.category === "location" ? "地点变化" : entry.category === "scene" ? "场景" : entry.category === "action" ? "行动" : entry.category === "dialogue" ? "对话" : entry.category === "schedule" ? "日程" : entry.category === "tool" ? "工具" : entry.category === "social" ? "社交动态" : entry.category === "diary" ? "日记" : entry.category === "chat" ? "消息" : "生活记录"}</p>{timelineImageUrls[entry.id]&&<img src={timelineImageUrls[entry.id]} alt={entry.title} className="mt-2 max-h-56 w-auto max-w-full rounded-xl object-contain"/>}<button type="button" disabled={Boolean(timelineImageBusyId)} onClick={()=>void generateTimelineImage(entry)} className="mt-2 inline-flex min-h-8 items-center gap-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-medium text-stone-600 disabled:opacity-50"><Sparkles size={12}/>{timelineImageBusyId===entry.id?"正在生成…":entry.imageMediaRef?"重新生成图片":"生成场景图片"}</button>
              </div>
            </article>)}</div>
          </section>)}
        </div>}
      </section>}
      {tab === "settings" && <div className="grid gap-4 lg:grid-cols-2">
        <LifeDiagnosticsPanel />
        <section className="rounded-3xl border border-white/80 bg-white/75 p-4 shadow-sm sm:p-6 lg:col-span-2">
          <SectionTitle title="生活系统全局背景"/>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div>
              <div className="relative grid min-h-36 place-items-center overflow-hidden rounded-2xl border border-rose-200/70 bg-[#fbf5ee]">
                {settings.globalBackgroundImage ? <img src={settings.globalBackgroundImage} alt="全局背景预览" className="absolute inset-0 h-full w-full object-cover" style={{filter:`blur(${Math.max(0,Math.min(18,settings.globalBackgroundBlur??0))}px) brightness(${Math.max(.45,Math.min(1.4,(settings.globalBackgroundBrightness??100)/100))})`}}/> : <div className="px-4 py-6 text-center text-xs text-stone-500"><Wallpaper size={22} className="mx-auto mb-2"/>尚未设置全局背景，将使用原有主题样式</div>}
                {settings.globalBackgroundImage && <div className="absolute inset-0" style={{backgroundColor:`rgba(255,250,245,${Math.max(0,Math.min(85,settings.globalBackgroundOverlay??18))/100})`}}/>}
                {settings.globalBackgroundImage && <span className="relative rounded-full bg-white/85 px-3 py-1.5 text-xs text-stone-700">全局背景预览</span>}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <label className="inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-4 py-2 text-sm font-medium text-white">
                  <Upload size={15}/>{backgroundUploadBusy==="global"?"正在处理…":settings.globalBackgroundImage?"更换全局背景":"上传全局背景"}
                  <input type="file" accept="image/*" className="hidden" disabled={backgroundUploadBusy!==null} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";void handleLifeBackgroundUpload(file,"global");}}/>
                </label>
                {settings.globalBackgroundImage && <button type="button" onClick={()=>patchSettings({globalBackgroundImage:undefined})} className="min-h-10 rounded-xl border border-stone-200 bg-white px-4 py-2 text-sm text-stone-600">移除背景</button>}
              </div>
            </div>
            <div className="space-y-3">
              <label className="block text-xs text-stone-600">模糊程度 · {settings.globalBackgroundBlur??0}px<input type="range" min="0" max="18" value={settings.globalBackgroundBlur??0} onChange={e=>patchSettings({globalBackgroundBlur:Number(e.target.value)})} className="mt-2 w-full"/></label>
              <label className="block text-xs text-stone-600">背景亮度 · {settings.globalBackgroundBrightness??100}%<input type="range" min="45" max="140" value={settings.globalBackgroundBrightness??100} onChange={e=>patchSettings({globalBackgroundBrightness:Number(e.target.value)})} className="mt-2 w-full"/></label>
              <label className="block text-xs text-stone-600">浅色遮罩 · {settings.globalBackgroundOverlay??18}%<input type="range" min="0" max="85" value={settings.globalBackgroundOverlay??18} onChange={e=>patchSettings({globalBackgroundOverlay:Number(e.target.value)})} className="mt-2 w-full"/></label>
              <p className="rounded-xl bg-white/65 p-3 text-[11px] leading-relaxed text-stone-500">图片会压缩后保存在生活系统数据中，不使用临时 blob 地址；移除全局背景不会影响各地点已设置的专属背景。</p>
            </div>
          </div>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle title="生活模拟规则" />
          <div className="space-y-2">
            <Toggle checked={settings.enabled} onChange={v=>patchSettings({enabled:v})} label="启用虚拟生活引擎" hint="关闭后保留数据，但暂停新生活场景功能。"/>
            <Toggle checked={settings.autoGenerateWeeklyPlans} onChange={v=>patchSettings({autoGenerateWeeklyPlans:v})} label="自动生成每周日程"/>
            <Toggle checked={settings.generateSpecialEvents} onChange={v=>patchSettings({generateSpecialEvents:v})} label="允许偶发特殊事件"/>
            <Toggle checked={settings.enableCoincidences} onChange={v=>patchSettings({enableCoincidences:v})} label="启用偶遇与注意力判断" hint="关闭后场景仍可互动，但不做随机偶遇判断。"/>
            <Toggle checked={settings.enableCharacterAutonomy} onChange={v=>patchSettings({enableCharacterAutonomy:v})} label="允许角色自主行动"/>
            <Toggle checked={settings.enableProactiveSceneMessages !== false} onChange={v=>patchSettings({enableProactiveSceneMessages:v})} label="后台主动消息" hint="App 在后台或被清后，仍按日程让角色主动发消息；需要部署离线推送。"/>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200/70 bg-white/60 px-3 py-2 text-xs text-stone-700">
              <span>主动消息间隔</span>
              <div className="flex items-center gap-1">
                <input
                  key={"proactive-min-" + (settings.proactiveSceneIntervalMinutes ?? 5)}
                  type="number" inputMode="numeric" min={3} max={120}
                  defaultValue={settings.proactiveSceneIntervalMinutes ?? 5}
                  aria-label="主动消息最短间隔分钟"
                  onBlur={event => patchSettings({ proactiveSceneIntervalMinutes: Math.max(3, Math.min(120, Math.round(Number(event.currentTarget.value) || 5))) })}
                  className="w-16 rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs"
                />
                <span>至</span>
                <input
                  key={"proactive-max-" + (settings.proactiveSceneIntervalMaxMinutes ?? 15)}
                  type="number" inputMode="numeric" min={3} max={180}
                  defaultValue={settings.proactiveSceneIntervalMaxMinutes ?? 15}
                  aria-label="主动消息最长间隔分钟"
                  onBlur={event => patchSettings({ proactiveSceneIntervalMaxMinutes: Math.max(3, Math.min(180, Math.round(Number(event.currentTarget.value) || 15))) })}
                  className="w-16 rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs"
                />
                <span>分钟</span>
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200/70 bg-white/60 px-3 py-2 text-xs text-stone-700">
              <span>现场安静多久后才主动</span>
              <div className="flex items-center gap-1">
                <input
                  key={"proactive-silence-" + (settings.proactiveSceneSilenceMinutes ?? 10)}
                  type="number" inputMode="numeric" min={1} max={120}
                  defaultValue={settings.proactiveSceneSilenceMinutes ?? 10}
                  aria-label="现场安静多少分钟后主动"
                  onBlur={event => patchSettings({ proactiveSceneSilenceMinutes: Math.max(1, Math.min(120, Math.round(Number(event.currentTarget.value) || 10))) })}
                  className="w-16 rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs"
                />
                <span>分钟</span>
              </div>
            </div>
            <Toggle checked={settings.enableSpontaneousDeviation !== false} onChange={v=>patchSettings({enableSpontaneousDeviation:v})} label="角色会临时起意" hint="角色按日程移动时偶尔改去别处，只改实际位置，不改日程。"/>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200/70 bg-white/60 px-3 py-2 text-xs text-stone-700">
              <span>每天最多几次</span>
              <input
                key={settings.deviationDailyLimit ?? 2}
                type="number"
                inputMode="numeric"
                min={1}
                max={5}
                defaultValue={settings.deviationDailyLimit ?? 2}
                onBlur={event => patchSettings({ deviationDailyLimit: Math.max(1, Math.min(5, Math.round(Number(event.currentTarget.value) || 2))) })}
                aria-label="每天最多临时起意几次"
                className="w-20 rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs"
              />
            </div>
            <p className="ml-3 rounded-xl bg-white/60 p-3 text-xs leading-relaxed text-stone-500">具体生活工具的独立开关已放入现场聊天工具箱；这里仅保留角色自主行动总开关。</p>

            <Toggle checked={settings.saveConfirmedEventsToMemory} onChange={v=>patchSettings({saveConfirmedEventsToMemory:v})} label="将已发生的事件写入生活记忆"/>
            <div className="rounded-lg border border-stone-200/70 bg-white/60 px-3 py-2 text-xs leading-relaxed text-stone-500">角色动作卡片已启用：连续动作合并显示，对白仍按消息分条显示。</div>
            <Toggle checked={settings.keepDialogueConcise} onChange={v=>patchSettings({keepDialogueConcise:v})} label="默认保持短回合对话"/>
            <Toggle checked={settings.allowCharactersToStaySilent} onChange={v=>patchSettings({allowCharactersToStaySilent:v})} label="允许角色沉默或专注做自己的事"/>
            <Toggle checked={settings.allowOnlineChatDuringSleep} onChange={v=>patchSettings({allowOnlineChatDuringSleep:v})} label="角色睡觉时仍正常回复线上聊天" hint="开启后，睡眠日程仍保留，但不会因此拦截普通私聊和后台回复；角色可以表现出困倦或刚睡醒。"/>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-stone-200/70 bg-white/60 px-3 py-2 text-xs text-stone-700">
              <span>连续纯行动上限</span>
              <select value={activeMaxConsecutiveActionOnly} onChange={event => patchSettings({ maxConsecutiveActionOnly: Number(event.target.value) as 0 | 1 | 2 })} className="rounded-lg border border-stone-200 bg-white px-2 py-1 text-xs">
                <option value={0}>0（不允许）</option>
                <option value={1}>1（推荐）</option>
                <option value={2}>2</option>
              </select>
            </div>
            <Toggle checked={settings.enableLifeFormatRepair !== false} onChange={v=>patchSettings({enableLifeFormatRepair:v})} label="格式异常自动修复重试一次"/>
            <Toggle checked={settings.showTimeline} onChange={v=>patchSettings({showTimeline:v})} label="显示日程时间线"/>
            <Toggle checked={settings.showLocationHints} onChange={v=>patchSettings({showLocationHints:v})} label="显示计划地点线索"/>
            <div className="mt-3 rounded-2xl border border-stone-200/70 bg-white/60 p-3"><p className="mb-2 text-xs font-semibold text-stone-700">生活记录显示筛选</p><div className="space-y-2">
              <Toggle checked={settings.recordLocationChanges} onChange={v=>patchSettings({recordLocationChanges:v})} label="地点与场景变化"/>
              <Toggle checked={settings.recordCharacterActions} onChange={v=>patchSettings({recordCharacterActions:v})} label="我和角色的行动"/>
              <Toggle checked={settings.recordSceneMessages} onChange={v=>patchSettings({recordSceneMessages:v})} label="生活现场的对话记录"/>
              <label className="block rounded-2xl border border-black/5 bg-white/70 px-4 py-3 text-sm text-stone-700">每几条对白汇总成一条记录
                <input key={settings.sceneRecordBatchSize ?? 10} type="number" inputMode="numeric" min="1" max="100" defaultValue={settings.sceneRecordBatchSize ?? 10} onBlur={event => patchSettings({sceneRecordBatchSize:Math.max(1,Math.min(100,Number(event.currentTarget.value)||10))})} className="mt-2 w-full rounded-lg border border-stone-200 bg-white px-3 py-2.5"/>
                <span className="mt-1 block text-[11px] text-stone-500">默认 10 条；同一组记录会持续更新，不会每说一句就新增记录。</span>
              </label>
              <Toggle checked={settings.recordChatActivity} onChange={v=>patchSettings({recordChatActivity:v})} label="消息 APP 聊天动态"/>
              <Toggle checked={settings.recordSocialActivity} onChange={v=>patchSettings({recordSocialActivity:v})} label="朋友圈动态"/>
              <Toggle checked={settings.recordDiaryActivity} onChange={v=>patchSettings({recordDiaryActivity:v})} label="日记动态"/>
              <Toggle checked={settings.recordToolCalls} onChange={v=>patchSettings({recordToolCalls:v})} label="角色调用工具"/>
              <Toggle checked={settings.recordScheduleChanges} onChange={v=>patchSettings({recordScheduleChanges:v})} label="日程与时间变化"/>
            </div><p className="mt-2 text-[10px] leading-relaxed text-stone-500">关闭某一项只会将该类记录从时间线隐藏，不会删除已保存的记录。</p></div>
            <Toggle checked={settings.enableAmbientDetails} onChange={v=>patchSettings({enableAmbientDetails:v})} label="启用环境细节"/>
          </div>
          <div className="mt-4 rounded-2xl border border-[var(--life-accent)]/25 bg-white/70 p-4">
            <p className="text-sm font-semibold">角色可调用的生活工具</p>
            
            <div className="mt-3 space-y-2 text-xs">
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_propose_invitation</code><p className="mt-1 text-stone-500">角色主动邀约你一起做某件事</p></div><span className={settings.enableCharacterAutonomy&&settings.enableInvitations?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableInvitations?"已启用":"已关闭"}</span></div>
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_request_follow</code><p className="mt-1 text-stone-500">角色主动申请陪伴，并跟随你的实际行程</p></div><span className={settings.enableCharacterAutonomy&&settings.enableFollowRequestTool?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableFollowRequestTool?"已启用":"已关闭"}</span></div>
              <div className="flex items-start justify-between gap-3 rounded-xl bg-white/80 p-3"><div><code>life_change_schedule</code><p className="mt-1 text-stone-500">角色调整自己当天未开始的普通日程</p></div><span className={settings.enableCharacterAutonomy&&settings.enableScheduleChangeTool?"text-emerald-700":"text-stone-400"}>{settings.enableCharacterAutonomy&&settings.enableScheduleChangeTool?"已启用":"已关闭"}</span></div>
            </div>
          </div>
          <label className="mt-4 block text-sm">位置情报权限<select value={settings.revealExactLocations} onChange={e=>patchSettings({revealExactLocations:e.target.value as LifeEngineSettings["revealExactLocations"]})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value="ask-only">只有询问或可靠渠道才能得知精确位置</option><option value="clues">默认只显示习惯与模糊线索</option><option value="open">允许公开查看实际位置</option></select></label>
        </section>
        <section className="rounded-3xl border border-white/80 bg-white/70 p-4 shadow-sm sm:p-6"><SectionTitle title="界面自定义" />
          <label className="mb-4 block text-sm">玩家显示名称<input value={playerName} onChange={e=>patchSettings({playerDisplayName:e.target.value})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label><label className="mb-4 block text-sm">场景主题<select value={settings.sceneTheme} onChange={e=>patchSettings({sceneTheme:e.target.value as LifeEngineSettings["sceneTheme"]})} className="mt-1.5 w-full rounded-xl border border-[rgb(var(--life-border-rgb)/.8)] bg-[rgb(var(--life-surface-rgb)/.96)] px-3 py-2.5 text-[var(--life-text)]">
            {Object.entries(themePresets).map(([value, theme])=><option key={value} value={value}>{theme.label}</option>)}
          </select></label>
          <div className="mb-4 rounded-xl border border-[rgb(var(--life-border-rgb)/.8)] bg-[rgb(var(--life-surface-rgb)/.7)] p-3">
            <p className="mb-2 text-sm font-medium">强调色</p>
            <label className="flex items-center gap-2 text-sm"><input type="radio" name="life-accent-mode" checked={settings.accentColorMode !== "custom"} onChange={()=>patchSettings({accentColorMode:"theme"})}/>跟随主题色 <span className="ml-auto inline-block h-5 w-5 rounded-full border" style={{backgroundColor:themeAccentColor}}/></label>
            <label className="mt-2 flex items-center gap-2 text-sm"><input type="radio" name="life-accent-mode" checked={settings.accentColorMode === "custom"} onChange={()=>patchSettings({accentColorMode:"custom"})}/>自定义颜色</label>
            {settings.accentColorMode === "custom" && <div className="mt-2 flex items-center gap-2"><input aria-label="选择强调色" type="color" value={settings.accentColor} onChange={e=>patchSettings({accentColor:e.target.value,accentColorMode:"custom"})} className="h-10 w-12 shrink-0 rounded-lg border-0 bg-transparent"/><input aria-label="强调色色号" type="text" inputMode="text" spellCheck={false} maxLength={7} value={settings.accentColor} onChange={e=>{const value=e.target.value.trim();if(/^#[0-9a-f]{0,6}$/i.test(value))patchSettings({accentColor:value,accentColorMode:"custom"});}} onBlur={e=>{const value=e.currentTarget.value.trim();if(/^#[0-9a-f]{6}$/i.test(value))patchSettings({accentColor:value.toLowerCase(),accentColorMode:"custom"});}} placeholder="#C66B82" className="min-w-0 flex-1 rounded-lg border border-[rgb(var(--life-border-rgb)/.8)] bg-[rgb(var(--life-strong-rgb)/.9)] px-3 py-2 font-mono text-sm text-[var(--life-text)]"/></div>}
            
          </div>
          <label className="mb-4 block text-sm">面板不透明度：{settings.panelOpacity}%<input type="range" min="50" max="100" value={settings.panelOpacity} onChange={e=>patchSettings({panelOpacity:Number(e.target.value)})} className="mt-2 w-full accent-[var(--life-accent)]"/></label>
          <label className="mb-4 block text-sm">对白字号（px）<input key={settings.dialogueFontSize} type="number" inputMode="numeric" min="8" max="48" defaultValue={settings.dialogueFontSize} onBlur={e=>patchSettings({dialogueFontSize:Math.max(8,Math.min(48,Number(e.currentTarget.value)||13))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">动作旁白字号（px）<input key={settings.narrationFontSize} type="number" inputMode="numeric" min="8" max="36" defaultValue={settings.narrationFontSize} onBlur={e=>patchSettings({narrationFontSize:Math.max(8,Math.min(36,Number(e.currentTarget.value)||14))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">气泡内边距（px）<input key={settings.bubblePadding} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.bubblePadding} onBlur={e=>patchSettings({bubblePadding:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">对白字体（CSS font-family）<input value={settings.dialogueFontFamily} onChange={e=>patchSettings({dialogueFontFamily:e.target.value})} placeholder="系统默认 / Arial / sans-serif" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label><label className="mb-4 block text-sm">旁白字体（CSS font-family）<input value={settings.narrationFontFamily} onChange={e=>patchSettings({narrationFontFamily:e.target.value})} placeholder='"Microsoft YaHei", sans-serif' className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
          <Toggle checked={settings.compactLayout} onChange={v=>patchSettings({compactLayout:v})} label="紧凑布局"/>
           <div className="mt-4 rounded-2xl border border-stone-200 bg-[#f8f4ee] p-3">
             <p className="mb-2 text-sm font-semibold text-stone-700">聊天显示实时预览</p>
             
             <div className="life-scene-chat flex min-w-0 flex-col rounded-xl bg-white/80 p-2" style={{fontSize:"var(--life-font)",rowGap:`${settings.messageGapPx ?? 4}px`}}>
               <div className="flex items-center gap-2" style={{marginBlock:`${settings.narrationGapPx ?? 4}px`}}><span className="h-px flex-1 bg-stone-300/80"/><p className="max-w-[82%] text-center italic leading-relaxed text-stone-500" style={{fontSize:`${settings.narrationFontSize}px`,fontFamily:settings.narrationFontFamily || undefined}}>轻轻推开门，走到窗边坐下。</p><span className="h-px flex-1 bg-stone-300/80"/></div>
               <div className="flex justify-start"><div className={`life-scene-bubble min-w-0 max-w-[88%] break-words bg-white text-stone-800 shadow-sm ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"}`} style={{fontSize:`${settings.dialogueFontSize}px`,fontFamily:settings.dialogueFontFamily || undefined,padding:`${settings.bubblePadding}px`}}><p>这样就能预览字号、气泡、间距和字体效果。</p></div></div>
               <div className="flex justify-end"><div className={`life-scene-bubble min-w-0 max-w-[88%] break-words bg-[#e9d4c0] text-stone-800 ${settings.dialogueBubbleStyle==="square"?"rounded-md":settings.dialogueBubbleStyle==="soft"?"rounded-[1.4rem]":"rounded-2xl"}`} style={{fontSize:`${settings.dialogueFontSize}px`,fontFamily:settings.dialogueFontFamily || undefined,padding:`${settings.bubblePadding}px`}}>玩家示例消息</div></div>
             </div>
           </div>
           <div className="mt-4 grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
             <label className="block min-w-0 text-sm">消息间距（px）<input key={settings.messageGapPx ?? 4} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.messageGapPx ?? 4} onBlur={e=>patchSettings({messageGapPx:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
             <label className="block min-w-0 text-sm">旁白间距（px）<input key={settings.narrationGapPx ?? 4} type="number" inputMode="numeric" min="0" max="24" defaultValue={settings.narrationGapPx ?? 4} onBlur={e=>patchSettings({narrationGapPx:Math.max(0,Math.min(24,Number(e.currentTarget.value)||0))})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
             <label className="block min-w-0 text-sm">对白气泡形状<select value={settings.dialogueBubbleStyle} onChange={e=>patchSettings({dialogueBubbleStyle:e.target.value as LifeEngineSettings["dialogueBubbleStyle"]})} className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"><option value="rounded">圆润</option><option value="soft">柔和大圆角</option><option value="square">方形</option></select></label>
             <label className="block min-w-0 text-sm">旁白 / 场景卡片字体<input value={settings.narrationFontFamily} onChange={e=>patchSettings({narrationFontFamily:e.target.value})} placeholder='"Microsoft YaHei", sans-serif' className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white px-3 py-2"/></label>
           </div>
           <label className="mt-4 block min-w-0 text-sm">自定义 CSS（仅生活聊天室）<textarea value={settings.customSceneCss ?? ""} onChange={e=>patchSettings({customSceneCss:e.target.value})} rows={5} spellCheck={false} placeholder=".life-scene-bubble { padding: 6px 9px !important; max-width: 76% !important; }" className="mt-1.5 w-full min-w-0 rounded-xl border border-stone-200 bg-white p-3 font-mono text-xs"/></label>
           

          <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white/60 p-4"><p className="text-sm font-semibold">玩家形象设置</p></div>
          <div className="mt-4 rounded-2xl border border-stone-200/80 bg-white/60 p-4">
            <p className="text-sm font-semibold">场景生图</p>
            
            <div className="mt-3 space-y-2">
              <Toggle checked={settings.autoGenerateSceneImages} onChange={v=>patchSettings({autoGenerateSceneImages:v})} label="场景变化时自动生成图片" hint="关闭时只在你点生图按钮后生成；新场景、地点或参与者活动发生变化时才自动生成，同一状态不会因重开页面重复扣费。"/>
              <label className="block text-sm">每次生成张数<select value={settings.sceneImageCount} onChange={e=>patchSettings({sceneImageCount:Number(e.target.value) as 1|2|3|4})} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"><option value={1}>1 张</option><option value={2}>2 张</option><option value={3}>3 张</option><option value={4}>4 张</option></select></label>
              <label className="block text-sm">场景画风<textarea value={settings.sceneImageStyle} onChange={e=>patchSettings({sceneImageStyle:e.target.value})} rows={2} className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
              <label className="block text-sm">场景画面补充描述<textarea value={sceneImagePrompt} onChange={e=>patchSettings({sceneImagePrompt:e.target.value})} rows={2} placeholder="例如：雨天咖啡店窗边，两个人捧着热饮。" className="mt-1.5 w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm"/></label>
              {activeScene&&<div><p className="mb-1 text-sm">本次画面角色</p><div className="flex flex-wrap gap-2">{activeScene.participants.map(p=>{const actor=actors.find(a=>a.ownerType===p.ownerType&&a.ownerId===p.ownerId);const checked=imageParticipantIds.length===0?p.ownerType==="character":imageParticipantIds.includes(p.ownerId);return <label key={p.ownerType+":"+p.ownerId} className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs"><input type="checkbox" checked={checked} onChange={e=>setImageParticipantIds(prev=>{const current=prev.length?prev:activeScene.participants.filter(item=>item.ownerType==="character").map(item=>item.ownerId);return e.target.checked?[...new Set([...current,p.ownerId])]:current.filter(id=>id!==p.ownerId)})}/>{actor?.name??p.ownerId}</label>;})}</div></div>}              {activeScene?.images?.some(image=>image.status==="archived")&&<div className="mt-3 border-t border-stone-200 pt-3"><p className="mb-2 text-sm font-medium">旧图归档 · 可恢复或删除</p><div className="space-y-2">{activeScene.images.filter(image=>image.status==="archived").map(image=><div key={image.id} className="flex items-center gap-2 rounded-xl bg-white/80 p-2">{imageObjectUrls[image.id]?<img src={imageObjectUrls[image.id]} alt={image.alt||""} className="h-12 w-12 rounded-lg object-cover"/>:<div className="h-12 w-12 rounded-lg bg-stone-100"/>}<span className="min-w-0 flex-1 truncate text-[11px] text-stone-500">{new Date(image.createdAt).toLocaleString("zh-CN")}</span><button type="button" onClick={()=>setSceneImageStatus(image.id,"active")} className="rounded-lg bg-stone-100 px-2 py-1.5 text-[11px]">恢复</button><button type="button" onClick={()=>{if(window.confirm("永久删除这张旧图并清理媒体缓存？"))void removeSceneImage(image.id)}} className="rounded-lg px-2 py-1.5 text-[11px] text-red-600">删除</button></div>)}</div></div>}
            </div>
          </div>
          <button onClick={()=>patchSettings({ ...DEFAULT_LIFE_ENGINE_SETTINGS })} className="mt-4 rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm text-stone-600">恢复默认设置</button>
        </section>
      </div>}
      {messageActionTarget && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-stone-950/35 p-3 sm:items-center" onMouseDown={event => { if (event.target === event.currentTarget) setMessageActionTarget(null); }}>
        <section role="dialog" aria-modal="true" aria-label="消息操作" className="w-full max-w-md rounded-3xl border border-white/70 bg-[#fffaf5] p-4 shadow-2xl sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-[var(--life-accent)]">消息操作</p><h3 className="mt-1 text-base font-semibold text-stone-800">{messageActionTarget.speakerName || "场景消息"}</h3></div><button type="button" onClick={() => setMessageActionTarget(null)} aria-label="关闭" className="grid h-9 w-9 place-items-center rounded-full bg-white text-stone-500"><X size={18}/></button></div>
          {messageActionMode === "menu" && <>
            <p className="mb-4 line-clamp-3 whitespace-pre-wrap rounded-2xl bg-white/80 p-3 text-sm leading-relaxed text-stone-600">{messageActionTarget.dialogue || messageActionTarget.action || "这条记录没有对白文本。"}</p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => handleMessageAction("edit")} className="flex items-center justify-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-3 text-sm"><Pencil size={16}/>编辑消息</button>
              <button type="button" onClick={() => handleMessageAction("delete")} className="flex items-center justify-center gap-2 rounded-xl border border-red-100 bg-white px-3 py-3 text-sm text-red-600"><Trash2 size={16}/>删除消息</button>
              <button type="button" disabled={messageActionTarget.role === "system" || busy} onClick={() => handleMessageAction("regenerate")} className="col-span-2 flex items-center justify-center gap-2 rounded-xl bg-[var(--life-accent)] px-3 py-3 text-sm text-white disabled:opacity-40"><RefreshCw size={16}/>{messageActionTarget.role === "player" ? "重新生成对应角色回复" : "重新生成这条角色回复"}</button>
            </div>
            <p className="mt-3 text-center text-[11px] text-stone-400">删除会同步清理这条消息的时间线记录。</p>
          </>}
          {messageActionMode === "edit" && <>
            <label className="mb-3 block text-sm font-medium text-stone-700">动作 / 旁白（可选）<textarea value={messageEditActionDraft} onChange={event => setMessageEditActionDraft(event.target.value)} rows={2} className="mt-2 w-full resize-y rounded-2xl border border-stone-200 bg-white p-3 text-sm leading-relaxed outline-none focus:border-[var(--life-accent)]" placeholder="编辑动作；留空会移除动作。"/></label>
            <label className="block text-sm font-medium text-stone-700">对白内容<textarea autoFocus value={messageEditDraft} onChange={event => setMessageEditDraft(event.target.value)} rows={4} className="mt-2 w-full resize-y rounded-2xl border border-stone-200 bg-white p-3 text-sm leading-relaxed outline-none focus:border-[var(--life-accent)]" placeholder="编辑对白；留空也可以保存。"/></label>
            <div className="mt-3 flex gap-2"><button type="button" onClick={() => setMessageActionMode("menu")} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">返回</button><button type="button" onClick={saveMessageEdit} className="flex-1 rounded-xl bg-[var(--life-accent)] px-3 py-2.5 text-sm text-white">保存修改</button></div>
          </>}
          {messageActionMode === "delete-confirm" && <>
            <p className="rounded-2xl bg-white/80 p-3 text-sm leading-relaxed text-stone-600">确定删除这条消息吗？关联的行动／对白时间线记录也会一起删除，此操作无法撤销。</p>
            <div className="mt-3 flex gap-2"><button type="button" onClick={() => setMessageActionMode("menu")} className="flex-1 rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm">取消</button><button type="button" onClick={deleteSceneMessage} className="flex-1 rounded-xl bg-red-600 px-3 py-2.5 text-sm text-white">确认删除</button></div>
          </>}
        </section>
      </div>}
      <footer className={`mt-6 flex flex-wrap items-center justify-between gap-2 px-1 text-[11px] opacity-55 ${immersiveScene ? "hidden" : ""}`}><span>数据保存在当前设备的 KV 数据库中</span><span>生活系统跟随现实时间 · 计划不等于实际在场 · 场景持续保存</span></footer>
    </div>
  </main>;
}