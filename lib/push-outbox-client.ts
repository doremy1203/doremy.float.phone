// 离线推送·回端合并：App 打开/回前台时拉取服务端生成的原始输出，
// 用客户端同一条解析管线（输出正则 → parseAndSaveResponse）落进聊天记录。

import { parseAndSaveResponse, scheduleFollowUp } from "./follow-up-service";
import { applyOutputRegex } from "./llm-prompt-assembler";
import type { RegexConfig } from "./settings-types";
import { stripHallucinatedTimestamps } from "./llm-provider-adapter";
import { MacroEngine } from "./macro-engine";
import { getActiveAppTags } from "./content-tag-utils";
import { parseLifeOutput } from "./life/life-output";
import { loadChatMessages, loadChatSessions, reindexSessionMessageOrdersByTime } from "./chat-storage";
import { hasAccountPushSubscription, isShellEnvironment } from "./push-client";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "./personal-push-cloud";
import { removeTimedWakeSchedule } from "./timed-wake-storage";
import { appendBridgeFeed } from "./reality-bridge/storage";
import { loadScreenChatSettings, saveScreenChatAck } from "./reality-bridge/storage";

type OutboxEntry = {
    id: string;
    session_id: string | null;
    trigger_key: string | null;
    raw_text: string;
    meta: {
        sessionId?: string;
        followUpIndex?: number;
        prevCount?: number;
        regexes?: RegexConfig[];
        characterName?: string;
        userName?: string;
        appId?: string;
        appTags?: string[];
        followUpCount?: number;
        armAt?: string;
        /** 挂单时最后一条用户消息的因果锚点；回端时若用户已发新消息，旧回复必须丢弃 */
        snapshotLastUserMessageId?: string;
        snapshotLastUserMessageAt?: string;
        replyAfterLocalMessageId?: string;
        replyAfterCreatedAt?: string;
        /** 云端触发快捷动作失败的摘要；成功时不带这个字段 */
        shortcutDeliveryError?: string;
        /** Server-generated proactive life-scene turn; must never be merged into online chat. */
        lifeScene?: { sceneId?: string; characterId?: string; characterName?: string };
    } | null;
    created_at: string;
};

let consuming = false;
let lastConsumeAt = 0;
let consumerInstalled = false;
let consumeRequestTimer: number | null = null;
const OUTBOX_BATCH_SIZE = 20;
const MAX_OUTBOX_BATCHES_PER_PASS = 10;
const OUTBOX_FOREGROUND_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function getTimedWakeIdFromTriggerKey(triggerKey: string | null): string | null {
    if (!triggerKey?.startsWith("timedwake:")) return null;
    const id = triggerKey.slice("timedwake:".length);
    return id.trim() || null;
}

function clearTimedWakeIfHandled(triggerKey: string | null): void {
    const timedWakeId = getTimedWakeIdFromTriggerKey(triggerKey);
    if (timedWakeId) removeTimedWakeSchedule(timedWakeId);
}
function parseLifeSceneProactiveOutput(raw: string): { action: string; dialogues: string[] } {
    // 服务端离线生活主动现在也走 JSON 协议；保留旧 XML/纯文本兜底。
    const parsed = parseLifeOutput(raw);
    return {
        action: parsed.action?.trim() || "",
        dialogues: parsed.dialogues.map(item => item.trim()).filter(Boolean),
    };
}

export async function consumeServerOutbox(options?: { silent?: boolean; force?: boolean }): Promise<void> {
    if (typeof window === "undefined") return;
    // 壳环境的任务与回传箱都走站点（账号 id 与壳订阅一致，见 pushJobsFetch）：
    // 服务端生成的消息落在站点库里，user_id = 站点账号 id。个人云那条路在壳里
    // 是断的（网关按 OWNER_ID 存取），所以壳必须读站点回传箱，不能读个人云。
    const shellMode = isShellEnvironment();
    // 共享回传箱已紧急停用：没有个人 Supabase 时直接结束，不请求 status/outbox。
    if (!shellMode && !isPersonalPushCloudActive()) return;
    if (consuming) return;
    if (options?.force !== true && Date.now() - lastConsumeAt < OUTBOX_FOREGROUND_CHECK_INTERVAL_MS) return;
    // 没有任何设备订阅推送时，服务端不可能产生普通离线回传；避免所有在线用户空轮询。
    if (!loadScreenChatSettings().enabled && !(await hasAccountPushSubscription())) return;
    consuming = true;
    lastConsumeAt = Date.now();
    const passStartMs = Date.now();
    try {
        // 壳读站点回传箱（与它的任务同源）；其余情况读个人云回传箱。
        const sources: Array<"personal" | "shared"> = shellMode ? ["shared"] : ["personal"];
        const handledTriggerKeys = new Set<string>();
        for (const source of sources) {
          for (let batch = 0; batch < MAX_OUTBOX_BATCHES_PER_PASS; batch += 1) {
            const response = await (source === "personal"
                ? personalPushFetch("outbox")
                : fetch("/api/push/outbox", { credentials: "include" }))
                .catch(() => null);
            if (!response || !response.ok) break;
            const data = await response.json().catch(() => ({})) as { ok?: boolean; entries?: OutboxEntry[] };
            const entries = data.ok && Array.isArray(data.entries) ? data.entries : [];
            if (entries.length === 0) break;

            const consumedIds: string[] = [];
            for (const entry of entries) {
                try {
                    if (entry.trigger_key && handledTriggerKeys.has(entry.trigger_key)) {
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const meta = entry.meta || {};

                    if ((meta as { kind?: string }).kind === "bridge") {
                        const bridgeMeta = meta as Record<string, unknown> & {
                            reply?: { sessionId?: string; regexes?: RegexConfig[]; characterName?: string; userName?: string; appId?: string; appTags?: string[] } | null;
                            screenChat?: boolean;
                            screenChatCharacterId?: string;
                            screenChatSequence?: number;
                            screenChatResponseBatchId?: string;
                            screenChatAssistantAt?: string;
                        };
                        const engine = await import("./reality-bridge/engine");
                        const applied = await engine.applyServerBridgeEntry(bridgeMeta as Parameters<typeof engine.applyServerBridgeEntry>[0]);
                        const replyMeta = bridgeMeta.reply || null;
                        const replySessionId = applied.sessionId || replyMeta?.sessionId || "";
                        if (entry.raw_text.trim() && replySessionId) {
                            const responseBatchId = typeof bridgeMeta.screenChatResponseBatchId === "string"
                                ? bridgeMeta.screenChatResponseBatchId
                                : undefined;
                            const existing = loadChatMessages(replySessionId);
                            const alreadyImported = Boolean(
                                responseBatchId && existing.some(message => message.responseBatchId === responseBatchId),
                            );
                            if (!alreadyImported) {
                                let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                                const regexes = Array.isArray(replyMeta?.regexes) ? replyMeta.regexes : [];
                                if (regexes.length > 0) {
                                    const macroEngine = new MacroEngine(replyMeta?.characterName ?? "", replyMeta?.userName ?? "用户");
                                    const activeTags = getActiveAppTags(replyMeta?.appId ?? "chat", { appTags: replyMeta?.appTags });
                                    text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                                }
                                const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                                    text,
                                    replySessionId,
                                    0,
                                    undefined,
                                    existing,
                                    {
                                        silent: options?.silent !== false,
                                        responseBatchId,
                                        createdAt: bridgeMeta.screenChatAssistantAt,
                                    },
                                );
                                if (hasVisible && newCount < 10) scheduleFollowUp(replySessionId, newCount, stateValues);
                            }
                            if (bridgeMeta.screenChat === true) reindexSessionMessageOrdersByTime(replySessionId);
                        }
                        if (
                            bridgeMeta.screenChat === true
                            && typeof bridgeMeta.screenChatCharacterId === "string"
                            && Number.isSafeInteger(bridgeMeta.screenChatSequence)
                        ) {
                            saveScreenChatAck(bridgeMeta.screenChatCharacterId, Number(bridgeMeta.screenChatSequence));
                        }
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }
                    // 云端触发快捷动作失败的诊断行：角色已经说了"我去看一眼"却什么
                    // 都没发生，写进现实桥动态让用户查得到原因。这是一条独立的
                    // outbox 行（云端在投递之后才写），不是角色消息——消费掉即可，
                    // 绝不能走下面的建消息流程，否则聊天里会凭空多出一条。
                    // Life-scene output has its own durable destination. Never insert it into the
                    // character's online chat history, even though the push job uses that session
                    // only to build the provider snapshot and carry notification metadata.
                    const lifeScene = meta.lifeScene;
                    if (lifeScene?.sceneId && lifeScene.characterId) {
                        const lifeCharacterId = lifeScene.characterId;
                        const { loadVirtualLifeState, saveVirtualLifeState, appendLifeTimelineEntry } = await import("./life/life-storage");
                        const state = loadVirtualLifeState();
                        const scene = state.scenes.find(item => item.id === lifeScene.sceneId && item.status === "active");
                        const playerPresent = scene?.participants.some(item => item.ownerType === "player" && item.ownerId === "player");
                        const characterPresent = scene?.participants.some(item => item.ownerType === "character" && item.ownerId === lifeCharacterId && item.activity !== "离开");
                        const messageBaseId = "life-outbox-" + entry.id;
                        if (scene && playerPresent && characterPresent && !state.sceneMessages.some(item => item.id.startsWith(messageBaseId))) {
                            const parsed = parseLifeSceneProactiveOutput(entry.raw_text);
                            if (parsed.action || parsed.dialogues.length > 0) {
                                const now = new Date().toISOString();
                                const speakerName = lifeScene.characterName || meta.characterName || "角色";
                                // 与在线路径保持一致：action 单独一张卡，dialogue 按段拆成多条气泡。
                                const newMessages = [
                                    ...(parsed.action ? [{
                                        id: `${messageBaseId}-action`, sceneId: scene.id, speakerType: "character" as const,
                                        speakerId: lifeCharacterId, speakerName, role: "character" as const,
                                        action: parsed.action, dialogue: "", createdAt: now, channel: "life_offline" as const,
                                    }] : []),
                                    ...parsed.dialogues.map((text, index) => ({
                                        id: `${messageBaseId}-dialogue-${index}`, sceneId: scene.id, speakerType: "character" as const,
                                        speakerId: lifeCharacterId, speakerName, role: "character" as const,
                                        action: undefined, dialogue: text, createdAt: now, channel: "life_offline" as const,
                                    })),
                                ];
                                let next = {
                                    ...state, sceneMessages: [...state.sceneMessages, ...newMessages],
                                    scenes: state.scenes.map(item => item.id === scene.id ? { ...item, updatedAt: now } : item),
                                };
                                if (parsed.action) next = appendLifeTimelineEntry(next, {
                                    category: "action", title: speakerName + "的行动", details: parsed.action,
                                    actorId: lifeCharacterId, actorName: speakerName, locationName: scene.locationName,
                                    sceneId: scene.id, sourceId: `${messageBaseId}-action`,
                                });
                                parsed.dialogues.forEach((text, index) => {
                                    next = appendLifeTimelineEntry(next, {
                                        category: "dialogue", title: speakerName + "说", details: text,
                                        actorId: lifeCharacterId, actorName: speakerName, locationName: scene.locationName,
                                        sceneId: scene.id, sourceId: `${messageBaseId}-dialogue-${index}`,
                                    });
                                });
                                saveVirtualLifeState(next);
                                const bannerDetail = {
                                    sceneId: scene.id,
                                    characterId: lifeScene.characterId,
                                    characterName: speakerName,
                                    avatar: "",
                                    locationName: scene.locationName,
                                    action: parsed.action || "",
                                    dialogue: parsed.dialogues[0] || "",
                                    createdAt: now,
                                };
                                // Persist a short-lived banner handoff as well as dispatching it.
                                // If the life page is not mounted during outbox consumption, it can
                                // still display the same life-scene banner when opened moments later.
                                try {
                                    localStorage.setItem("life-scene-pending-banner-v1", JSON.stringify(bannerDetail));
                                } catch { /* banner is best-effort; the scene message is already saved */ }
                                window.dispatchEvent(new CustomEvent("life-scene-proactive-message", { detail: bannerDetail }));
                            }
                        }
                        // If the scene ended while the app was offline, consume the stale turn
                        // rather than leaking it into online chat.
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }
                    if ((meta as { kind?: string }).kind === "shortcut_delivery_error") {
                        const detail = typeof meta.shortcutDeliveryError === "string"
                            ? meta.shortcutDeliveryError
                            : entry.raw_text;
                        try {
                            appendBridgeFeed({
                                id: `shortcut_fail_${entry.id}`,
                                type: "快捷动作",
                                payload: detail,
                                rules: [],
                                actions: [],
                                error: detail,
                                receivedAt: new Date().toISOString(),
                            });
                        } catch { /* 动态写失败不影响其余条目消费 */ }
                        consumedIds.push(entry.id);
                        continue;
                    }
                    const sessionId = meta.sessionId || entry.session_id || "";
                    const session = sessionId ? loadChatSessions().find(s => s.id === sessionId) : undefined;
                    if (!session) {
                        console.warn("[PushOutbox] session not found, keep entry pending:", entry.id, sessionId);
                        continue;
                    }

                    const periodCare = (meta as { periodCare?: { characterId?: string; cycleKey?: string } }).periodCare;
                    if (periodCare?.characterId && periodCare.cycleKey) {
                        const { saveMenstrualPeriodCareTrigger } = await import("./menstrual-storage");
                        saveMenstrualPeriodCareTrigger({ characterId: periodCare.characterId, sessionId, cycleKey: periodCare.cycleKey });
                    }

                    const followUpIndex = typeof meta.followUpIndex === "number" ? meta.followUpIndex : undefined;
                    const existingMessages = loadChatMessages(sessionId);

                    // 因果锚点：服务端回复必须仍然接在挂单时那条用户消息后面。
                    // 如果用户已经发了更新的消息，这条旧回复一旦落库就会被排到新消息后面，
                    // 下一轮模型会接着旧话题说——宁可丢弃，也不能污染上下文。
                    const latestUserMessage = [...existingMessages].reverse().find(message =>
                        message.role === "user" && message.status !== "failed" && !message.isRetracted,
                    );
                    const snapshotUserId = typeof meta.snapshotLastUserMessageId === "string"
                        ? meta.snapshotLastUserMessageId
                        : "";
                    const snapshotUserAt = typeof meta.snapshotLastUserMessageAt === "string"
                        ? meta.snapshotLastUserMessageAt
                        : "";
                    const replyAfterId = typeof meta.replyAfterLocalMessageId === "string"
                        ? meta.replyAfterLocalMessageId
                        : "";
                    const replyAfterAt = typeof meta.replyAfterCreatedAt === "string"
                        ? meta.replyAfterCreatedAt
                        : "";
                    const replyAfterMessage = replyAfterId
                        ? existingMessages.find(message => message.id === replyAfterId)
                        : undefined;
                    const replyAfterIsUser = replyAfterMessage?.role === "user" && !replyAfterMessage.isRetracted;
                    const anchorUserId = snapshotUserId || (replyAfterIsUser ? replyAfterId : "");
                    const anchorUserAt = snapshotUserAt || (replyAfterIsUser ? replyAfterAt : "");
                    const anchorTime = anchorUserAt ? Date.parse(anchorUserAt) : NaN;
                    const latestUserTime = latestUserMessage ? Date.parse(latestUserMessage.createdAt) : NaN;
                    const staleByUser = Boolean(anchorUserId) && (!latestUserMessage || latestUserMessage.id !== anchorUserId);
                    const staleByTime = Number.isFinite(anchorTime) && Number.isFinite(latestUserTime) && latestUserTime > anchorTime;
                    if (staleByUser || staleByTime) {
                        console.info("[PushOutbox] Dropped stale proactive reply", {
                            entryId: entry.id,
                            triggerKey: entry.trigger_key,
                            anchorUserId,
                            latestUserId: latestUserMessage?.id,
                            anchorUserAt,
                            latestUserAt: latestUserMessage?.createdAt,
                        });
                        clearTimedWakeIfHandled(entry.trigger_key);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    const idleMeta = (meta as { idleReconnect?: { ruleId?: string; firedAt?: number } }).idleReconnect;
                    if (idleMeta?.ruleId) {
                        const { markIdleReconnectFired } = await import("./idle-reconnect-storage");
                        markIdleReconnectFired(idleMeta.ruleId, typeof idleMeta.firedAt === "number" ? idleMeta.firedAt : Date.now());
                    }

                    if (followUpIndex && existingMessages.some(m => m.role === "assistant" && m.followUpIndex === followUpIndex)) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    const armAtMs = typeof meta.armAt === "string" ? Date.parse(meta.armAt) : NaN;
                    if (Number.isFinite(armAtMs) && existingMessages.some(m => {
                        if (m.role !== "assistant") return false;
                        const createdMs = Date.parse(m.createdAt);
                        return createdMs > armAtMs && createdMs < passStartMs;
                    })) {
                        clearTimedWakeIfHandled(entry.trigger_key);
                        consumedIds.push(entry.id);
                        if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                        continue;
                    }

                    let text = stripHallucinatedTimestamps(entry.raw_text.trim());
                    const regexes = Array.isArray(meta.regexes) ? meta.regexes : [];
                    if (regexes.length > 0) {
                        const macroEngine = new MacroEngine(meta.characterName ?? "", meta.userName ?? "用户");
                        const activeTags = getActiveAppTags(meta.appId ?? "chat", { appTags: meta.appTags, followUpCount: meta.followUpCount });
                        text = applyOutputRegex(text, regexes, { macroEngine, activeTags });
                    }

                    // 云端执行过的快捷动作标记：在原始位置落一对 tool_call/tool_notice——
                    // 上下文里保留标记原文，UI 显示与小手机内直接调用一致
                    const rawMarker = (meta as { shortcutMarker?: { text?: unknown; insertAt?: unknown; name?: unknown } }).shortcutMarker;
                    const shortcutMarker = rawMarker
                        && typeof rawMarker.text === "string" && rawMarker.text
                        && typeof rawMarker.name === "string" && rawMarker.name
                        ? {
                            text: rawMarker.text,
                            insertAt: typeof rawMarker.insertAt === "number" && Number.isFinite(rawMarker.insertAt)
                                ? rawMarker.insertAt
                                : Number.MAX_SAFE_INTEGER,
                            name: rawMarker.name,
                        }
                        : undefined;
                    const { hasVisible, newCount, stateValues } = await parseAndSaveResponse(
                        text,
                        sessionId,
                        meta.prevCount ?? 0,
                        followUpIndex,
                        existingMessages,
                        { silent: options?.silent !== false, ...(shortcutMarker ? { shortcutMarker } : {}) },
                    );
                    if (hasVisible && newCount < 10) scheduleFollowUp(sessionId, newCount, stateValues);
                    clearTimedWakeIfHandled(entry.trigger_key);
                    consumedIds.push(entry.id);
                    if (entry.trigger_key) handledTriggerKeys.add(entry.trigger_key);
                } catch (err) {
                    console.warn("[PushOutbox] merge failed for entry:", entry.id, err);
                    // 屏幕速聊各轮有严格因果顺序；前一轮未合并时不能越过它消费后一轮。
                    if ((entry.meta as { screenChat?: boolean } | null)?.screenChat === true) break;
                }
            }

            if (consumedIds.length === 0) break;
            const ackInit: RequestInit = {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids: consumedIds }),
            };
            const ackResponse = await (source === "personal"
                ? personalPushFetch("outbox", ackInit)
                : fetch("/api/push/outbox", { ...ackInit, credentials: "include" }))
                .catch(() => null);
            if (!ackResponse || !ackResponse.ok) break;
            if (entries.length < OUTBOX_BATCH_SIZE) break;
          }
        }
    } finally {
        consuming = false;
    }
}

/** 安装自动消费钩子：启动后拉一次，之后每次回前台再拉。 */
export function installServerOutboxConsumer(): void {
    if (typeof window === "undefined" || consumerInstalled) return;
    consumerInstalled = true;

    const requestConsume = (force = false) => {
        if (consumeRequestTimer !== null) window.clearTimeout(consumeRequestTimer);
        consumeRequestTimer = window.setTimeout(() => {
            consumeRequestTimer = null;
            void consumeServerOutbox({ force });
        }, 150);
    };

    // 每次冷启动都强制拉一次（force=true 会绕过 consumeServerOutbox 内的 5 分钟节流）。
    //
    // 之前这里是非强制：用户若在 5 分钟内重开 App，启动拉取被节流跳过，聊天里就看不到
    // 服务端已经生成、通知也已经弹过的那条消息——「弹窗比聊天里的消息慢」正是这么来的。
    // 主动消息本来就该「打开 App 即见」，不该依赖用户去点那条通知，也不该被节流挡下。
    // 代价仅是多一次 outbox 查询；服务端返回空列表时客户端立刻结束。
    requestConsume(true);
    document.addEventListener("visibilitychange", () => {
        if (!document.hidden) requestConsume(true);
    });
    navigator.serviceWorker?.addEventListener("message", (event) => {
        if (event.data?.type === "push_outbox_ready") {
            requestConsume(true);
            return;
        }
        if (event.data?.type === "run_shortcut" && typeof event.data.url === "string") {
            const url: string = event.data.url;
            // 站点线的 /shortcut-run 票据地址、个人线的同源转发路由，
            // 或个人云网关自己的 run 入口
            const personal = loadPersonalPushCloudState();
            const allowed = url.startsWith(`${window.location.origin}/shortcut-run`)
                || url.startsWith(`${window.location.origin}/personal-shortcut-run?`)
                || (personal !== null && url.startsWith(`${personal.url}/functions/v1/ai-phone-push?action=run&`));
            if (allowed) window.location.href = url;
        }
    });
}
