/**
 * 全局生活主动消息调度器。
 *
 * 和 life-engine 里的“前台场景自主回合”不同：这里负责 App 退到后台后的日程同场兜底。
 * 角色必须同时满足：当前日程/实际地点与玩家一致，并且已经是当前 active scene 的参与者；
 * 不再凭地点相同就伪造一个场景。前台场景持有短租约时，后台任务仍保留在服务端，
 * push-generate 会按快照租约延后执行；前台停止刷新租约后，后台链自动恢复。
 */
import { loadCharacters } from "@/lib/character-storage";
import { loadChatContacts, loadChatSessions, resolveSessionCharacterId } from "@/lib/chat-storage";
import { armLifeSceneProactiveBailout, cancelBailoutPrefix } from "@/lib/push-bailout-client";
import { syncLifeScheduleSnapshot } from "./life-schedule-cloud";
import { loadVirtualLifeState } from "./life-storage";
import { resolveActorLocation } from "./life-runtime";
import type { VirtualLifeState } from "./life-types";
import { recordLifeDiagnostic } from "./life-diagnostics";
import { LIFE_PRESENCE_LEASE_UPDATED_EVENT } from "./life-scheduler-coordinator";

const PLAYER_ID = "player";
const LIFE_PROACTIVE_MESSAGES_ENABLED = false; // Keep server-side life scheduling, disable message jobs.
const ARM_META_PREFIX = "life-schedule-arm:";
const STATUS_KEY = "life-proactive-last-status-v1";
export type LifeProactiveStatus = { at: string; ok: boolean; character?: string; reason?: string };
export function readLifeProactiveStatus(): LifeProactiveStatus | null {
  try {
    const raw = localStorage.getItem(STATUS_KEY);
    return raw ? JSON.parse(raw) as LifeProactiveStatus : null;
  } catch { return null; }
}
function writeLifeProactiveStatus(status: LifeProactiveStatus) {
  try { localStorage.setItem(STATUS_KEY, JSON.stringify(status)); } catch { /* best effort */ }
}
const TICK_MS = 60_000;
const MIN_DELAY_MS = 3 * 60_000;
const MAX_DELAY_MS = 9 * 60_000;

function playerLocation(state: VirtualLifeState): { id: string; name: string } | null {
  return resolveActorLocation(state, "player", PLAYER_ID);
}

function characterLocation(state: VirtualLifeState, characterId: string): string | null {
  return resolveActorLocation(state, "character", characterId)?.id ?? null;
}


function nextArmAt(triggerKey: string, now: number): number {
  try {
    const raw = localStorage.getItem(ARM_META_PREFIX + triggerKey);
    if (raw) {
      const parsed = JSON.parse(raw) as { executeAt?: number; cloudManaged?: boolean };
      // Once the cloud owns this scene/character, the durable server row is re-armed
      // in place. The browser must not create a second timer chain.
      if (parsed.cloudManaged === true && (parsed as { armed?: boolean }).armed === true) return 0;
      if (typeof parsed.executeAt === "number" && parsed.executeAt > now + 60_000) return parsed.executeAt;
    }
  } catch { /* fall through */ }
  // Do not mark the row cloud-owned until the server has acknowledged the arm.
  // A WebView killed between local marker write and POST would otherwise suppress
  // every future retry forever.
  return now + MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
}

const armedCache = new Map<string, number>();
/** 已取消过线下循环的 scene:character，避免每 60 秒重复 DELETE。 */
const cancelledOffline = new Set<string>();

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let rerunRequested = false;
let stopped = false;
let lastDisabledCleanupKey = "";

async function runOnce(): Promise<void> {
  if (stopped || typeof document === "undefined") return;
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;
  try {
    const state = loadVirtualLifeState();
    if (!LIFE_PROACTIVE_MESSAGES_ENABLED || !state.settings.enabled || !state.settings.enableCharacterAutonomy || state.settings.enableProactiveSceneMessages === false) {
      const disabledKey = [state.settings.enabled, state.settings.enableCharacterAutonomy, state.settings.enableProactiveSceneMessages].join(":");
      if (disabledKey !== lastDisabledCleanupKey) {
        lastDisabledCleanupKey = disabledKey;
        await syncLifeScheduleSnapshot(true);
        const obsoleteJobs = state.scenes.flatMap(scene => scene.participants
          .filter(participant => participant.ownerType === "character")
          .map(participant => ({ sceneId: scene.id, characterId: participant.ownerId })));
        await Promise.all(obsoleteJobs.map(async item => {
          const key = item.sceneId + ":" + item.characterId;
          try { localStorage.removeItem(ARM_META_PREFIX + key); } catch { /* best effort */ }
          await cancelBailoutPrefix("life-scene:" + item.sceneId + ":" + item.characterId);
        }));
        recordLifeDiagnostic({ source: "主动调度", event: "主动消息已关闭，撤销待执行任务", status: "info", detail: "自主行动或主动消息开关已关闭；云端仍按七日日程计算角色活动与地点，本地仅清理不再需要的主动消息预约。", meta: { enabled: state.settings.enabled, autonomy: state.settings.enableCharacterAutonomy, proactive: state.settings.enableProactiveSceneMessages, cancelled: obsoleteJobs.length } });
      }
      return;
    }
    lastDisabledCleanupKey = "";
    const snapshotSynced = await syncLifeScheduleSnapshot();
    if (!snapshotSynced) {
      recordLifeDiagnostic({ source: "主动调度", event: "快照未同步，暂停挂载", status: "error", detail: "无法确认最新玩家/角色地点，本轮不创建离线主动任务。" });
      return;
    }
    // Remove local ownership markers for participants/scenes that no longer exist.
    // This lets a character re-entering a scene acquire a fresh durable cloud row.
    const activeScenePairs = new Set(state.scenes
      .filter(scene => scene.status === "active")
      .flatMap(scene => scene.participants
        .filter(participant => participant.ownerType === "character" && participant.activity !== "离开")
        .map(participant => scene.id + ":" + participant.ownerId)));
    const staleMarkers: string[] = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith(ARM_META_PREFIX)) continue;
        const pairKey = key.slice(ARM_META_PREFIX.length);
        if (!activeScenePairs.has(pairKey)) staleMarkers.push(pairKey);
      }
    } catch { /* best effort */ }
    for (const pairKey of staleMarkers) {
      try { localStorage.removeItem(ARM_META_PREFIX + pairKey); } catch { /* best effort */ }
      const splitAt = pairKey.lastIndexOf(":");
      if (splitAt > 0) {
        await cancelBailoutPrefix("life-scene:" + pairKey.slice(0, splitAt) + ":" + pairKey.slice(splitAt + 1));
      }
      armedCache.delete(pairKey);
    }
    // Create only the initial durable row. The cloud evaluator reuses that same row
    // after each turn; foreground/chat leases defer it without blocking either interface.
    const player = playerLocation(state);
    if (!player) return;
    const characters = loadCharacters();
    // 玩家离开后，旧地点的线下循环立即撤销；角色离开玩家地点也撤销它自己的链。
    const coLocated = new Set(
      characters.filter(character => characterLocation(state, character.id) === player.id).map(character => "life-scene:" + character.id),
    );
    for (const scene of state.scenes) {
      for (const participant of scene.participants) {
        if (participant.ownerType !== "character") continue;
        const exact = "life-scene:" + participant.ownerId;
        const triggerPrefix = "life-scene:" + scene.id + ":" + participant.ownerId;
        const isCoLocated = scene.status === "active" && participant.activity !== "离开" && coLocated.has(exact);
        if (!isCoLocated && !cancelledOffline.has(triggerPrefix)) {
          cancelledOffline.add(triggerPrefix);
          try { localStorage.removeItem(ARM_META_PREFIX + scene.id + ":" + participant.ownerId); } catch { /* best effort */ }
          void cancelBailoutPrefix(triggerPrefix).catch(() => undefined);
        } else if (isCoLocated) {
          cancelledOffline.delete(triggerPrefix);
        }
      }
    }
    const now = Date.now();
    for (const character of characters) {
      const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
      if (/睡眠|睡觉|入睡|午休/.test(actor?.activity || "")) continue;
      const contact = loadChatContacts().find(item => item.characterId === character.id);
      const session = loadChatSessions().find(item => !item.isGroup && (item.contactId === contact?.id || resolveSessionCharacterId(item) === character.id));
      if (!session) continue;
      // 只在玩家当前所在的现场里触发：角色必须是 active scene 的参与者。
      // 不再按角色新建场景，避免同一地点出现多个互不相干的“生活现场”。
      const scene = state.scenes.find(item => item.status === "active"
        && item.participants.some(p => p.ownerType === "player" && p.ownerId === PLAYER_ID)
        && item.participants.some(p => p.ownerType === "character" && p.ownerId === character.id && p.activity !== "离开"));
      if (!scene) continue;
      const trigger = scene.id + ":" + character.id;
      const executeAtMs = nextArmAt(trigger, now);
      if (!executeAtMs) continue;
      if (armedCache.get(trigger) === executeAtMs) continue;
      armedCache.set(trigger, executeAtMs);
      const result = await armLifeSceneProactiveBailout({
        sessionId: session.id,
        sceneId: scene.id,
        characterId: character.id,
        characterName: character.name,
        prompt: [
          "【日程同场自动搭话：不是对玩家新消息的回复】",
          "请先读取系统在本轮生成前注入的最新云端日程、活动与地点状态。",
          "角色：" + character.name,
          "请以角色身份自然发起一小回合生活现场对话或行动；不要替玩家发言，不要写成长篇。",
          "不得沿用预约时的旧地点或旧活动；若当前没有自然的话可说，可以保持安静。",
        ].join("\n\n"),
        appId: "life",
        appTags: ["life", "turn", "autonomy", ...(state.settings.enableCharacterAutonomy ? ["tools"] : [])],
        executeAtMs,        // No repeat counter: the cloud scheduler reuses this one durable row forever.
        source: "schedule",
      });
      writeLifeProactiveStatus({ at: new Date().toISOString(), ok: result.ok, character: character.name, reason: result.ok ? undefined : result.reason });
      if (result.ok) {
        try { localStorage.setItem(ARM_META_PREFIX + trigger, JSON.stringify({ executeAt: executeAtMs, cloudManaged: true, armed: true })); } catch { /* best effort */ }
      }
      recordLifeDiagnostic({ source: "主动调度", event: result.ok ? "离线主动任务已挂载" : "离线主动任务挂载失败", status: result.ok ? "ok" : "error", detail: result.ok ? character.name + " 的主动消息已提交服务端预约。" : character.name + "：" + (result.reason || "未知原因"), meta: { sceneId: scene.id, characterId: character.id, sessionId: session.id, executeAt: new Date(executeAtMs).toISOString() } });
      if (!result.ok) {
        // 没挂上就清掉“已挂”标记，下一轮继续重试，不能一次失败永远不排。
        try { localStorage.removeItem(ARM_META_PREFIX + trigger); } catch { /* best effort */ }
        armedCache.delete(trigger);
        console.warn("[LifeSchedule] 主动消息未挂上：", character.name, result.reason);
      }
    }
  } catch (error) {
    console.warn("[LifeSchedule] scheduler failed:", error);
    recordLifeDiagnostic({ source: "主动调度", event: "调度器异常", status: "error", detail: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
    if (rerunRequested && !stopped) {
      rerunRequested = false;
      void runOnce();
    }
  }
}

export function installLifeScheduleProactiveScheduler(): () => void {
  if (typeof window === "undefined") return () => undefined;
  // The scheduler is mounted by the app shell. Guard against accidental duplicate
  // mounts while preserving React StrictMode setup -> cleanup -> setup.
  if (timer) return () => undefined;
  stopped = false;
  const start = () => { void runOnce(); };
  start();
  timer = setInterval(start, TICK_MS);
  const onVisible = () => { if (document.visibilityState === "visible") start(); };
  const onScheduleChanged = () => { start(); };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("life-force-sync", onScheduleChanged);
  window.addEventListener("virtual-life-state-updated", onScheduleChanged);
  window.addEventListener(LIFE_PRESENCE_LEASE_UPDATED_EVENT, onScheduleChanged);
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("life-force-sync", onScheduleChanged);
    window.removeEventListener("virtual-life-state-updated", onScheduleChanged);
    window.removeEventListener(LIFE_PRESENCE_LEASE_UPDATED_EVENT, onScheduleChanged);
  };
}


/** Clear browser-side metadata for life-scene scheduling without touching online-chat leases. */
export function clearLifeProactiveSchedulerLocalState(): void {
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(STATUS_KEY);
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index);
        if (key?.startsWith(ARM_META_PREFIX)) localStorage.removeItem(key);
      }
    } catch { /* best effort */ }
  }
  armedCache.clear();
  cancelledOffline.clear();
}
