// 离线推送·兜底预约（客户端侧）：
// 追问排期时把「组装好的完整请求快照」预约到服务端；本地正常触发就撤销，
// App 被杀则由服务端 cron 到点接管生成并推送。组装用的就是前台同一条
// buildChatPromptMessages → buildProviderRequest 链路，零新逻辑。

import { bgSetInterval, bgSetTimeout } from "./bg-timer";
import { BAILOUT_DIRTY_EVENT } from "./bailout-dirty";
import { BAILOUT_CANCEL_EVENT, type BailoutCancelDetail } from "./bailout-cancel";
import { buildChatPromptMessages } from "./chat-engine";
import { resolveLifeCharacterIdForContact } from "./life/life-autonomy";
import { isCallActiveForSession } from "./call-session-store";
import { buildProviderRequest, toLlmRequestMessages, type LlmRequestPayload } from "./llm-provider-adapter";
import { loadChatContacts, loadChatMessages, loadChatSessions, loadFollowUpSchedule, resolveSessionCharacterId as resolveChatSessionCharacterId, type ChatMessage, type ChatSession } from "./chat-storage";
import { hasAccountPushSubscription, isShellEnvironment, isWithinPushQuietHours, loadPushQuietHours, peekAccountPushSubscribed } from "./push-client";
import { isPersonalPushCloudActive, pushJobsFetch } from "./personal-push-cloud";
import {
    buildOfflineShortcutContinuation,
    maybeAppendShortcutCapability,
    maybeAppendWeixinChannel,
    type OfflineShortcutContinuation,
} from "./offline-shortcut-capability";
import {
    getMenstrualPeriodCareEvent,
    hasMenstrualPeriodCareTriggered,
    loadMenstrualConfig,
    loadMenstrualRecords,
} from "./menstrual-storage";
import { loadTimedWakeSchedules, removeTimedWakeSchedule, type TimedWakeSchedule } from "./timed-wake-storage";
import {
    IDLE_RECONNECT_MAX_CONSECUTIVE,
    loadIdleReconnectRules,
    removeIdleReconnectRule,
    type IdleReconnectRule,
} from "./idle-reconnect-storage";
import { loadCharacters } from "./character-storage";
import { loadVirtualLifeState } from "./life/life-storage";
import type { RegexConfig } from "./settings-types";
import type { LLMMessage } from "./llm-prompt-assembler";

// ── 离线来电：让 AI 自己决定"这条主动消息要不要改成打电话" ──────────
// 只在主动类离线任务（冷场重连/定时唤醒）的生成快照里注入一句能力说明；
// AI 使用小手机既有的「[我向用户名发起了语音通话]」格式时，
// 由 push-generate 以来电形式投递；服务端仍兼容旧的【拨打电话】标记。
// 频控在客户端：同一角色约 20 小时内只授权一次，防止模型学会了天天打。
// 安静时段无需在此处理——这两类任务落在安静时段根本不会预约（见上方门控）。

const CALL_INVITE_WINDOW_MS = 20 * 60 * 60 * 1000;
const CALL_INVITE_STORE_KEY = "ai_phone_call_invite_armed_v1";

const CALL_INVITE_INSTRUCTION = "（可选能力：如果你此刻更想直接给对方打语音电话——想念、着急、有情绪、"
    + "或者事情几句话说不清——就在回复的第一行使用你已有的小手机通话格式：[我向当前聊天对象发起了语音通话]，"
    + "其中聊天对象按当前用户填写；从第二行开始写你接通后要说的话。"
    + "不适合打电话就正常发消息。无论选哪种，都不要提及本条说明。）";

// ── 离线推送的会话信息：通知点击直达 + 角色头像 ────────────────
// notify 字段随快照一起上传，服务端广播时原样带给壳（PushService 读
// sessionId 决定点击跳哪个会话、读 avatar 当大图标）。
// 头像走 data URL 时可能很大，而快照有 900KB 上限——超限会被服务端 413
// 拒收、整条离线回复都发不出，所以这里卡一个远低于上限的阈值，超了就
// 只发通知不发头像（宁可图标退回默认，也不能让消息发不出来）。
const NOTIFY_AVATAR_MAX_CHARS = 120_000;

/** 按会话取角色头像：群聊没有单一角色，返回 undefined。 */
function resolveNotifyAvatar(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    try {
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session || session.isGroup) return undefined;
        const characterId = resolveSessionCharacterId(session);
        const avatar = characterId ? loadCharacters().find(c => c.id === characterId)?.avatar : undefined;
        if (typeof avatar !== "string") return undefined;
        const trimmed = avatar.trim();
        if (!trimmed || trimmed.length > NOTIFY_AVATAR_MAX_CHARS) return undefined;
        // 只放行壳侧解得了的形态：内联 data URL 或 http(s) 直链
        if (trimmed.startsWith("data:image/") || trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return trimmed;
        }
        return undefined;
    } catch {
        return undefined;
    }
}

/** 组装 notify 字段：标题 + 站内地址，能取到头像就一并带上。 */
function notifyField(title: string, sessionId: string | undefined): Record<string, unknown> {
    const avatar = resolveNotifyAvatar(sessionId);
    return { title, url: "/", ...(avatar ? { avatar } : {}) };
}

function readCallInviteArmedMap(): Record<string, number> {
    try {
        const raw = localStorage.getItem(CALL_INVITE_STORE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? parsed as Record<string, number> : {};
    } catch {
        return {};
    }
}

/** 尝试为该角色的生成快照追加"可以打电话"的能力说明；频控窗口内返回 false 不追加。 */
function maybeAppendCallInvite(llmMessages: LLMMessage[], characterId: string): boolean {
    try {
        const map = readCallInviteArmedMap();
        const last = map[characterId] ?? 0;
        if (Date.now() - last < CALL_INVITE_WINDOW_MS) return false;
        llmMessages.push({ role: "system", content: CALL_INVITE_INSTRUCTION });
        map[characterId] = Date.now();
        // 顺手清理超窗旧记录，防止无限增长
        for (const key of Object.keys(map)) {
            if (Date.now() - map[key] > CALL_INVITE_WINDOW_MS * 2) delete map[key];
        }
        localStorage.setItem(CALL_INVITE_STORE_KEY, JSON.stringify(map));
        return true;
    } catch {
        return false;
    }
}

/** 追问兜底宽限：本地触发开始后有心跳续约，宽限只需覆盖「客户端整个死了」的场景。 */
export const FOLLOWUP_BAILOUT_GRACE_MS = 180_000;

/** 发送兜底租约：心跳每 30s 一跳把接管时刻推到 now+90s，为后台定时器降频留足抖动空间。 */
export const REPLY_BAILOUT_LEASE_MS = 90_000;

const HEARTBEAT_INTERVAL_MS = 30_000;

export type BailoutArmResult =
    | { ok: true }
    | { ok: false; reason: string };

function bailoutEnabled(): boolean {
    // 离线任务只写用户自己的云；单机自部署与账号站点使用同一链路。
    //
    // 壳环境额外放行：壳的订阅是以站点账号 id 注册的，任务必须走站点接口
    // （见 pushJobsFetch 的说明）才能真正投递到壳；若这里仍以「个人云是否
    // 激活」为准，壳在只配了个人云、没走一遍部署引导的情况下会整体跳过兜底。
    return typeof window !== "undefined"
        && (isPersonalPushCloudActive() || isShellEnvironment());
}

/** Session.contactId is a contact-record ID in newer data; life scenes use character IDs. */
function resolveSessionCharacterId(session: Pick<ChatSession, "contactId">): string | null {
    return resolveChatSessionCharacterId(session);
}

/**
 * 主动消息快照的因果锚点：记录挂单时最后一条用户消息。
 * 回端时如果用户已经发了更新消息，这条主动消息必须丢弃，否则会被排到
 * 新用户消息后面，模型就会接着旧话题说。
 */
function buildCausalSnapshot(sessionId: string): { lastUserMessageId: string; lastUserMessageAt: string } | null {
    const messages = loadChatMessages(sessionId);
    const lastUser = [...messages].reverse().find(message =>
        message.role === "user" && message.status !== "failed" && !message.isRetracted,
    );
    return lastUser ? { lastUserMessageId: lastUser.id, lastUserMessageAt: lastUser.createdAt } : null;
}

function resolveTimedWakeElapsedMinutes(schedule: TimedWakeSchedule, history: ChatMessage[]): number {
    if (schedule.source === "user") {
        const lastUser = [...history].reverse().find(message => message.role === "user");
        const lastUserAt = lastUser ? Date.parse(lastUser.createdAt) : schedule.createdAt;
        return Math.max(1, Math.round((schedule.fireAt - lastUserAt) / 60000));
    }
    return Math.max(1, Math.round((schedule.fireAt - schedule.createdAt) / 60000));
}

/** 本地生成期间给兜底预约续命；返回停止函数。 */
export function startBailoutHeartbeat(triggerKey: string): () => void {
    if (!bailoutEnabled()) return () => undefined;
    const beat = () => {
        void pushJobsFetch({
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ triggerKey }),
        }).catch(() => undefined);
    };
    return bgSetInterval(beat, HEARTBEAT_INTERVAL_MS);
}

export type ReplyBailoutHandle = { settle: () => void };

/**
 * 发送兜底：本地开始生成回复的同时，把同一份请求快照（无工具的非流式孪生）
 * 预约到服务端，租约 90s、心跳续命。本地完成（成功或失败）即撤销；
 * App 被杀则心跳停跳，约 90s+扫描间隔后服务端接管生成并推送。
 */
export async function armReplyBailout(params: {
    sessionId: string;
    characterName: string;
    userName?: string;
    regexes: RegexConfig[];
    request: Pick<LlmRequestPayload, "url" | "headers" | "body" | "providerKind">;
    /** 云回复必须排在这条本地输入之后；跨设备排序不能只依赖两边时钟。 */
    replyAfter?: { localMessageId: string; createdAt: string };
    signal?: AbortSignal;
}): Promise<ReplyBailoutHandle | null> {
    if (!bailoutEnabled()) return null;
    // The online chat's server fallback must not race the life-scene channel for a
    // character physically present with the player. Otherwise killing the app can
    // produce a chat notification for a turn that belongs to the life scene.
    const replySession = loadChatSessions().find(item => item.id === params.sessionId);
    if (replySession && !replySession.isGroup) {
        const characterId = resolveSessionCharacterId(replySession);
        if (characterId && isCharacterCoPresentInLifeScene(characterId)) return null;
    }
    if (!(await hasAccountPushSubscription())) return null;
    if (params.signal?.aborted) return null;

    const triggerKey = `reply:${params.sessionId}`;
    const armAt = new Date().toISOString();
    const causalSnapshot = buildCausalSnapshot(params.sessionId);
    const response = await pushJobsFetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            triggerKey,
            kind: "reply_bailout",
            executeAt: new Date(Date.now() + REPLY_BAILOUT_LEASE_MS).toISOString(),
            payload: {
                request: {
                    url: params.request.url,
                    headers: params.request.headers,
                    body: params.request.body,
                    providerKind: params.request.providerKind,
                },
                notify: notifyField(params.characterName, params.sessionId),
                merge: {
                    sessionId: params.sessionId,
                    prevCount: 0,
                    regexes: params.regexes,
                    characterName: params.characterName,
                    userName: params.userName ?? "用户",
                    appId: "chat",
                    appTags: ["chat", "text"],
                    armAt,
                    ...(causalSnapshot
                        ? {
                            snapshotLastUserMessageId: causalSnapshot.lastUserMessageId,
                            snapshotLastUserMessageAt: causalSnapshot.lastUserMessageAt,
                        }
                        : {}),
                    ...(params.replyAfter?.localMessageId
                        ? {
                            replyAfterLocalMessageId: params.replyAfter.localMessageId,
                            replyAfterCreatedAt: params.replyAfter.createdAt,
                        }
                        : {}),
                },
            },
        }),
    }).catch(() => null);
    if (!response || !response.ok) {
        // 413 = 快照超过服务端 900KB 上限（提示词太大/贴图太多）。以前这里
        // 完全静默，用户只会发现"App 被杀后没收到回复"却查不到原因。
        if (response) console.warn("[PushBailout] 回复兜底预约失败：HTTP", response.status);
        return null;
    }
    if (params.signal?.aborted) {
        await deleteBailoutJob(triggerKey);
        return null;
    }

    const stopHeartbeat = startBailoutHeartbeat(triggerKey);
    let settled = false;
    let detachAbort: (() => void) | null = null;
    const settle = () => {
        if (settled) return;
        settled = true;
        stopHeartbeat();
        detachAbort?.();
        void deleteBailoutJob(triggerKey);
    };
    if (params.signal) {
        const onAbort = () => settle();
        params.signal.addEventListener("abort", onAbort, { once: true });
        detachAbort = () => params.signal?.removeEventListener("abort", onAbort);
    }
    return {
        settle,
    };
}

async function deleteBailoutJob(triggerKey: string): Promise<void> {
    await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerKey }),
    }).catch(() => undefined);
}

/** 复刻 fireFollowUp 的沉默标记注入，但时间基准取"预约触发时刻"而非现在。 */
export function buildFollowUpSilenceMessages(
    session: ChatSession,
    latestMessages: ChatMessage[],
    atMs: number,
): ChatMessage[] {
    const lastUserMsg = [...latestMessages].reverse().find(m => m.role === "user");
    const lastUserTime = lastUserMsg ? new Date(lastUserMsg.createdAt).getTime() : atMs;

    const annotated: ChatMessage[] = [];
    let currentRound = 0;
    for (const msg of latestMessages) {
        if (msg.role === "assistant" && msg.followUpIndex && msg.followUpIndex > currentRound) {
            currentRound = msg.followUpIndex;
            const markerTime = new Date(msg.createdAt).getTime();
            const silenceSec = Math.round((markerTime - lastUserTime) / 1000);
            annotated.push({
                id: `_marker_${currentRound}_${atMs}`,
                sessionId: session.id,
                role: "user",
                content: `[对方没有回复你的消息，距上次回复已过约${silenceSec}秒]`,
                status: "sent",
                createdAt: msg.createdAt,
            });
        }
        annotated.push(msg);
    }

    const finalSilenceSec = Math.round((atMs - lastUserTime) / 1000);
    return [
        ...annotated,
        {
            id: `_silence_${atMs}`,
            sessionId: session.id,
            role: "system",
            content: `[对方没有回复你的消息，距上次回复已过约${finalSilenceSec}秒]`,
            status: "sent",
            createdAt: new Date(atMs).toISOString(),
        },
    ];
}

/** 追问排期后挂兜底预约。失败静默（网络/未登录都不影响本地追问）。 */
export async function armFollowUpBailout(
    sessionId: string,
    prevCount: number,
    delaySec: number,
    fireAt: number,
): Promise<void> {
    if (!bailoutEnabled()) return;
    try {
        if (!(await hasAccountPushSubscription())) return;
        if (isWithinPushQuietHours(fireAt + FOLLOWUP_BAILOUT_GRACE_MS)) return; // 安静时段不打扰
        const session = loadChatSessions().find(s => s.id === sessionId);
        if (!session || session.isGroup) return; // 第一期只覆盖单聊追问
        const characterId = resolveSessionCharacterId(session);
        if (characterId && isCharacterCoPresentInLifeScene(characterId)) return; // 同场时不再从线上聊天渠道主动追问
        // 正在通话中：不挂追问兜底。通话期间角色其实一直在说话，但系统看不到
        // 你的文字回复，会按沉默判成「对方没回」，到点生成一条主动消息弹通知——
        // 人明明在电话里聊着（用户实报）。通话本身就是最强的「在场」信号。
        if (isCallActiveForSession(sessionId)) return;
        const latestMessages = loadChatMessages(sessionId);
        const causalSnapshot = buildCausalSnapshot(sessionId);
        const count = prevCount + 1;
        const messagesWithHint = buildFollowUpSilenceMessages(session, latestMessages, fireAt);

        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            messagesWithHint,
            { appTags: ["chat", "text", "followup"], followUpCount: count, followUpDelay: delaySec },
        );
        // 无原生工具重放：服务端执行不了本地工具循环，兜底生成按纯补全组装。
        // 但标记式快捷动作云端是支持的（push-generate 解析【快捷动作：名称】），
        // 所以照常注入动作目录，别让角色在离线追问里以为自己什么都做不了。
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);

        // 组装耗时不短——上传前复核排期还在且没被改过（用户可能已回复触发了取消）
        const latestSchedule = loadFollowUpSchedule(sessionId);
        if (!latestSchedule || latestSchedule.count !== prevCount || Math.abs(latestSchedule.fireAt - fireAt) > 1000) return;

        await pushJobsFetch({
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                triggerKey: `followup:${sessionId}:${count}`,
                kind: "followup",
                executeAt: new Date(fireAt + FOLLOWUP_BAILOUT_GRACE_MS).toISOString(),
                payload: {
                    request: {
                        url: request.url,
                        headers: request.headers,
                        body: request.body,
                        providerKind: request.providerKind,
                    },
                    notify: notifyField(character.name, sessionId),
                    ...(shortcutContinuation ? { shortcutContinuation } : {}),
                    merge: {
                        sessionId,
                        followUpIndex: count,
                        prevCount,
                        regexes,
                        characterName: character.name,
                        userName: userIdentity?.name ?? "用户",
                        appId: "chat",
                        appTags: ["chat", "text", "followup"],
                        followUpCount: count,
                        ...(causalSnapshot
                            ? {
                                snapshotLastUserMessageId: causalSnapshot.lastUserMessageId,
                                snapshotLastUserMessageAt: causalSnapshot.lastUserMessageAt,
                            }
                            : {}),
                    },
                },
            }),
        });
    } catch (err) {
        console.warn("[PushBailout] arm failed:", err);
    }
}

/** 通用预约上传：组装快照 → POST 服务端任务。返回是否成功。 */
async function postBailoutJob(input: {
    triggerKey: string;
    kind: "followup" | "reply_bailout" | "timed_task";
    executeAtMs: number;
    request: Pick<LlmRequestPayload, "url" | "headers" | "body" | "providerKind">;
    notifyTitle: string;
    merge: Record<string, unknown>;
    weixinBotId?: string;
    shortcutContinuation?: OfflineShortcutContinuation | null;
}): Promise<boolean> {
    const response = await pushJobsFetch({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            triggerKey: input.triggerKey,
            kind: input.kind,
            executeAt: new Date(input.executeAtMs).toISOString(),
            payload: {
                request: {
                    url: input.request.url,
                    headers: input.request.headers,
                    body: input.request.body,
                    providerKind: input.request.providerKind,
                },
                notify: notifyField(input.notifyTitle, typeof input.merge.sessionId === "string" ? input.merge.sessionId : undefined),
                ...(input.weixinBotId ? { weixin: { botId: input.weixinBotId } } : {}),
                ...(input.shortcutContinuation ? { shortcutContinuation: input.shortcutContinuation } : {}),
                merge: input.merge,
            },
        }),
    }).catch(() => null);
    return Boolean(response && response.ok);
}

/**
 * 撤销前的门控短路是否该放行。
 *
 * peekAccountPushSubscribed() 读的是本地缓存，可能停在很久以前的 false 上。
 * 壳环境里这个缓存没有意义（hasAccountPushSubscription 恒为 true，壳订阅由常驻
 * 长连接天然持有），却会让撤销被静默跳过——服务端那条预约占依然照常执行，
 * 和本地这次生成叠成两套内容（通知里一套、聊天里另一套）。壳里一律放行。
 */
function maySkipBailoutCancel(): boolean {
    if (isShellEnvironment()) return false;
    return peekAccountPushSubscribed() === false;
}

/** 撤销任意兜底预约（精确键）。 */
export function cancelBailoutKey(triggerKey: string): void {
    if (!bailoutEnabled()) return;
    if (maySkipBailoutCancel()) return;
    void pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerKey }),
    }).catch(() => undefined);
}

/** 撤销一批兜底预约（前缀）。excludeKey 可保留一个刚挂上的新键（先挂后清模式）。
 *  返回 Promise 以便调用方在重挂前先等撤销落地。 */
export async function cancelBailoutPrefix(triggerPrefix: string, excludeKey?: string): Promise<void> {
    if (!bailoutEnabled()) return;
    if (maySkipBailoutCancel()) return;
    await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(excludeKey ? { triggerPrefix, excludeKey } : { triggerPrefix }),
    }).catch(() => undefined);
}

/**
 * Schedule one server-side life-scene proactive turn. The model request is snapshotted
 * while the app is available; push-generate runs it if the app is backgrounded/killed.
 * The outbox carries lifeScene metadata so the reply is restored to the scene, not chat.
 */
export async function armLifeSceneProactiveBailout(input: {
    sessionId: string;
    sceneId: string;
    characterId: string;
    characterName: string;
    prompt: string;
    appId?: string;
    appTags?: string[];
    executeAtMs: number;
    /** 可选：服务端在这一单完成后继续按 interval 续排，实现 App 关闭后的循环主动消息。 */
    repeat?: { intervalMs: number; remaining: number };
    /** Separate foreground, manual and schedule-owned jobs so they cannot overwrite one another. */
    source?: "foreground" | "manual" | "schedule";
}): Promise<BailoutArmResult> {
    if (!bailoutEnabled()) return { ok: false, reason: "当前环境不支持服务端离线预约" };
    try {
        if (!(await hasAccountPushSubscription())) return { ok: false, reason: "当前账号没有可用的离线推送订阅" };
        if (isWithinPushQuietHours(input.executeAtMs)) return { ok: false, reason: "触发时间落在推送安静时段内" };
        const session = loadChatSessions().find(item => item.id === input.sessionId);
        if (!session || session.isGroup || resolveLifeCharacterIdForContact(session.contactId, loadChatContacts()) !== input.characterId) return { ok: false, reason: "找不到对应的单聊会话" };
        if (isCallActiveForSession(session.id)) return { ok: false, reason: "会话正在通话中" };
        const promptMessage: ChatMessage = {
            id: "life-autonomy-snapshot-" + Date.now().toString(36),
            sessionId: session.id,
            role: "user",
            status: "sent",
            createdAt: new Date().toISOString(),
            content: input.prompt,
        };
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            [promptMessage],
            { appId: input.appId ?? "life", appTags: input.appTags ?? ["life", "turn", "autonomy"], includeDirectChatEntries: false },
        );
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const posted = await postBailoutJob({
            triggerKey: "life-scene:" + input.sceneId + ":" + input.characterId + ":" + (input.source ?? "foreground"),
            kind: "timed_task",
            executeAtMs: input.executeAtMs,
            request,
            // Make the life-scene channel visually distinct from normal online-chat push.
            notifyTitle: "生活现场 · " + (input.characterName || character.name),
            merge: {
                sessionId: session.id,
                prevCount: 0,
                regexes,
                characterName: input.characterName || character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text", "offline", "life-scene"],
                armAt: new Date(input.executeAtMs).toISOString(),
                lifeScene: { sceneId: input.sceneId, characterId: input.characterId, characterName: input.characterName || character.name },
                ...(input.repeat && input.repeat.intervalMs > 0 && input.repeat.remaining > 0
                    ? { idleRepeat: { intervalMs: input.repeat.intervalMs, remaining: input.repeat.remaining, quietWin: null } }
                    : {}),
            },
        });
        return posted ? { ok: true } : { ok: false, reason: "服务端预约接口没有确认成功" };
    } catch (err) {
        console.warn("[PushBailout] life-scene arm failed:", err);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** Cancel only stale foreground fallbacks when a local foreground turn takes over.
 * Background schedule/manual jobs remain armed and are deferred by the foreground lease.
 */
export async function cancelLifeSceneProactiveBailouts(sceneId: string, characterIds: string[]): Promise<void> {
    if (!sceneId || !characterIds.length) return;
    await Promise.all([...new Set(characterIds)].map(characterId =>
        cancelBailoutPrefix("life-scene:" + sceneId + ":" + characterId + ":foreground"),
    ));
}

/** Prevent a second proactive channel from talking while a character is physically co-present. */
export function isCharacterCoPresentInLifeScene(characterId: string): boolean {
    try {
        const state = loadVirtualLifeState();
        if (!state.settings.enabled) return false;
        return state.scenes.some(scene => scene.status === "active"
            && scene.participants.some(participant => participant.ownerType === "player" && participant.ownerId === "player")
            && scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId && participant.activity !== "离开"));
    } catch {
        return false;
    }
}

/** Keep online cold-reconnect and life-scene autonomy mutually exclusive per character.
 * Re-evaluate persisted scene presence every time the life scene changes or resumes:
 * cancel queued online tasks only for genuinely co-present characters; re-arm the
 * existing online rule as soon as the character is no longer in the player's scene. */
export async function reconcileIdleReconnectWithLifeScenes(characterIds?: string[]): Promise<void> {
    if (!bailoutEnabled()) return;
    const rules = loadIdleReconnectRules();
    const filter = characterIds?.length ? new Set(characterIds) : null;
    for (const rule of rules) {
        if (filter && !filter.has(rule.characterId)) continue;
        if (isCharacterCoPresentInLifeScene(rule.characterId)) {
            await cancelBailoutPrefix("idle:" + rule.id + ":");
            const session = loadChatSessions().find(item => item.id === rule.sessionId);
            if (session) await cancelBailoutPrefix("followup:" + session.id + ":");
        } else {
            await armIdleReconnectBailout(rule);
        }
    }
}

/** Backward-compatible helper used when entering a life scene. */
export async function suspendIdleReconnectForLifeScene(characterIds: string[]): Promise<void> {
    if (!characterIds.length) return;
    await reconcileIdleReconnectWithLifeScenes(characterIds);
}
/**
 * 通话开始/结束时处理这个会话的离线预约。
 *
 * 为什么需要：离线任务（冷场重连 / 追问）按「用户最后一条文字消息 + 间隔」
 * 排期。通话期间用户不写字，但角色一直在说话——系统看不见，仍会按时生成一条
 * 主动消息弹通知，只在通知里出现、聊天室里没有对应记录，人明明在电话里聊着
 * （用户实报）。
 *
 * arm* 里的门控只能拦住「通话期间新挂的」，通话开始前就已经挂在服务端的
 * 仍会到点触发，所以这里显式撤销。通话结束后不必主动重挂：等用户下次发消息
 * 或下一轮巡检，规则会按新的沉默时间自然重排。
 */
export async function suspendBailoutsForCall(sessionId: string): Promise<void> {
    if (!bailoutEnabled()) return;
    await cancelBailoutPrefix(`followup:${sessionId}:`);
    cancelBailoutKey(`reply:${sessionId}`);
    // 冷场重连的键是 idle:<ruleId>:<序号>，不带会话 id，得按规则找到它
    for (const rule of loadIdleReconnectRules()) {
        if (rule.sessionId !== sessionId) continue;
        await cancelBailoutPrefix(`idle:${rule.id}:`);
    }
}

/** 把本地安静时段设置编成服务端可用的窗口（分钟制 + 时区偏移），未启用返回 null。 */
function buildQuietWindowMeta(): { startMin: number; endMin: number; tzOffsetMin: number } | null {
    const match = loadPushQuietHours().match(/^(\d{1,2}):(\d{2})\s*[-~—]\s*(\d{1,2}):(\d{2})$/);
    if (!match) return null;
    return {
        startMin: Number(match[1]) * 60 + Number(match[2]),
        endMin: Number(match[3]) * 60 + Number(match[4]),
        tzOffsetMin: -new Date().getTimezoneOffset(),
    };
}

/** 冷场重连兜底：按「用户最后一条消息 + 间隔」预约服务端触发；
 *  服务端触发一次后会自动排下一发（连发上限内），用户回复后客户端重挂新周期。 */
export async function armIdleReconnectBailout(rule: IdleReconnectRule): Promise<BailoutArmResult> {
    if (!bailoutEnabled()) return { ok: false, reason: "当前环境不支持服务端离线预约" };
    try {
        if (!(await hasAccountPushSubscription())) return { ok: false, reason: "当前账号没有可用的离线推送订阅" };
        const session = loadChatSessions().find(s => s.id === rule.sessionId);
        if (!session || session.isGroup || resolveSessionCharacterId(session) !== rule.characterId) return { ok: false, reason: "找不到对应的单聊会话" };
        if (isCharacterCoPresentInLifeScene(rule.characterId)) return { ok: false, reason: "角色正在生活现场与玩家同场，已优先交给生活现场主动性" };
        // 正在通话中：不挂冷场重连。通话期间系统看不到文字回复，会误判成用户
        // 沉默了、按规则发来主动消息，只在通知里冒出来（用户实报）。
        if (isCallActiveForSession(session.id)) return { ok: false, reason: "会话正在通话中" };
        const history = loadChatMessages(session.id);
        const lastUser = [...history].reverse().find(m => m.role === "user");
        if (!lastUser) return { ok: false, reason: "这个会话还没有你的消息，无法计算沉默时间" };
        const lastUserAt = new Date(lastUser.createdAt).getTime();
        const causalSnapshot = { lastUserMessageId: lastUser.id, lastUserMessageAt: lastUser.createdAt };

        const effectiveConsecutive = rule.lastFiredAt && rule.lastFiredAt > lastUserAt ? rule.consecutiveCount : 0;
        if (effectiveConsecutive >= IDLE_RECONNECT_MAX_CONSECUTIVE) {
            // 不再挂新单，把该规则的存量排队任务清干净
            await cancelBailoutPrefix(`idle:${rule.id}:`);
            return { ok: false, reason: "已达到连续主动联系上限" };
        }

        const intervalMs = Math.max(1, rule.intervalMinutes) * 60_000;
        const nextDueAt = Math.max(
            lastUserAt + intervalMs,
            rule.lastFiredAt ? rule.lastFiredAt + intervalMs : 0,
            rule.suppressedUntil ?? 0,
        );
        const fireAt = Math.max(nextDueAt, Date.now() + 30_000);
        if (isWithinPushQuietHours(fireAt)) {
            // 首发落在安静时段就不挂（本地醒着时会择机触发），存量任务一并清掉
            await cancelBailoutPrefix(`idle:${rule.id}:`);
            return { ok: false, reason: "触发时间落在推送安静时段内" };
        }

        const elapsedMinutes = Math.max(1, Math.round((fireAt - lastUserAt) / 60000));
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            history,
            { appTags: ["chat", "text", "idle_wake"], timedWakeElapsedMinutes: elapsedMinutes },
        );
        maybeAppendCallInvite(llmMessages, rule.characterId);
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const weixinBotId = maybeAppendWeixinChannel(llmMessages, rule.characterId);
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);
        const remaining = IDLE_RECONNECT_MAX_CONSECUTIVE - effectiveConsecutive - 1;
        // 先挂后清：POST 本身按同键先删后插（幂等覆盖），挂稳后再清理同前缀的其他旧键
        //（旧连发序号、服务端续排的 "+" 后缀键）。之前是先清后挂，切后台/杀进程
        // 发生在清理和重挂之间会把预约整个删空——服务端从此无单可执行。
        const triggerKey = `idle:${rule.id}:${effectiveConsecutive}`;
        const posted = await postBailoutJob({
            triggerKey,
            kind: "timed_task",
            executeAtMs: fireAt + 15_000,
            request,
            notifyTitle: character.name,
            weixinBotId,
            shortcutContinuation,
            merge: {
                sessionId: session.id,
                prevCount: 0,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text", "idle_wake"],
                armAt: new Date(fireAt).toISOString(),
                ...(causalSnapshot
                    ? {
                        snapshotLastUserMessageId: causalSnapshot.lastUserMessageId,
                        snapshotLastUserMessageAt: causalSnapshot.lastUserMessageAt,
                    }
                    : {}),
                idleReconnect: { ruleId: rule.id, firedAt: fireAt },
                ...(remaining > 0 ? { idleRepeat: { intervalMs, remaining, quietWin: buildQuietWindowMeta() } } : {}),
            },
        });
        if (!posted) return { ok: false, reason: "服务端预约接口没有确认成功" };
        // 清理不阻塞结果：新单已挂稳；旧键偶尔清不掉，下次任一重挂时机会再清
        void cancelBailoutPrefix(`idle:${rule.id}:`, triggerKey);
        // 服务端是"生成完才插入下一轮续排任务"——上面的清理可能赶在插入前跑完，
        // 旧链尾巴漏网就会和新链并存多发一轮。延迟再扫一次兜住这个竞态；
        // 新链首发至少在 30 秒后才会生成续排任务，10 秒时点不会误伤。
        // 必须用后台安全的计时器：window.setTimeout 在 WebView 进后台后被冻结，
        // 这个补扫永远不执行，于是服务端续排的旧链尾巴漏网，和新链并存多发一轮
        //（实测同规则 2 分半内跑出 6 单）。Worker 计时器不受后台冻结影响。
        bgSetTimeout(() => void cancelBailoutPrefix(`idle:${rule.id}:`, triggerKey), 10_000);
        return { ok: true };
    } catch (err) {
        console.warn("[PushBailout] idle reconnect arm failed:", err);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** 定时唤醒（稍后主动联系）兜底：创建/刷新时把到点生成预约到服务端。
 *  "已过X分钟"的语境按预定触发时刻精确烤入。 */
export async function armTimedWakeBailout(schedule: TimedWakeSchedule): Promise<BailoutArmResult> {
    if (!bailoutEnabled()) return { ok: false, reason: "当前环境不支持服务端离线预约" };
    try {
        if (!(await hasAccountPushSubscription())) return { ok: false, reason: "当前账号没有可用的离线推送订阅" };
        if (isWithinPushQuietHours(schedule.fireAt)) return { ok: false, reason: "触发时间落在推送安静时段内" };
        const session = loadChatSessions().find(s => s.id === schedule.sessionId);
        if (!session || session.isGroup || resolveSessionCharacterId(session) !== schedule.characterId) return { ok: false, reason: "找不到对应的单聊会话" };
        const history = loadChatMessages(session.id);
        const elapsedMinutes = resolveTimedWakeElapsedMinutes(schedule, history);

        const wakeTag = schedule.source === "user" ? "user_timed_wake" : "timed_wake";
        const { llmMessages, character, config, preset, regexes, userIdentity } = await buildChatPromptMessages(
            session,
            history,
            { appTags: ["chat", "text", wakeTag], timedWakeElapsedMinutes: elapsedMinutes, timedWakeIntent: schedule.intent },
        );
        maybeAppendCallInvite(llmMessages, schedule.characterId);
        maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
        const weixinBotId = maybeAppendWeixinChannel(llmMessages, schedule.characterId);
        const request = buildProviderRequest(config, preset, toLlmRequestMessages(llmMessages));
        const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
            const req = buildProviderRequest(config, preset, toLlmRequestMessages(messages));
            return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
        }, config.enableImageRecognition === true);
        const posted = await postBailoutJob({
            triggerKey: `timedwake:${schedule.id}`,
            kind: "timed_task",
            executeAtMs: schedule.fireAt + 15_000,
            request,
            notifyTitle: character.name,
            weixinBotId,
            shortcutContinuation,
            merge: {
                sessionId: session.id,
                prevCount: 0,
                regexes,
                characterName: character.name,
                userName: userIdentity?.name ?? "用户",
                appId: "chat",
                appTags: ["chat", "text", wakeTag],
                armAt: new Date(schedule.fireAt).toISOString(),
            },
        });
        return posted ? { ok: true } : { ok: false, reason: "服务端预约接口没有确认成功" };
    } catch (err) {
        console.warn("[PushBailout] timed wake arm failed:", err);
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
}

/** 经期关怀兜底：预测未来 7 天内的关怀日，为选中的角色各挂一单（每周期幂等）。 */
export async function armPeriodCareBailouts(): Promise<void> {
    if (!bailoutEnabled()) return;
    try {
        const config = loadMenstrualConfig();
        if (!config.periodCareEnabled || config.periodCareCharacterIds.length === 0) return;
        if (!(await hasAccountPushSubscription())) return;

        const records = loadMenstrualRecords();
        const now = new Date();
        for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
            const target = new Date(now.getTime() + dayOffset * 86_400_000);
            const targetDate = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(target.getDate()).padStart(2, "0")}`;
            const event = getMenstrualPeriodCareEvent(records, config, targetDate);
            if (!event) continue;

            // 当天 09:30 触发；已过则 10 分钟后
            const fireAt = new Date(target.getFullYear(), target.getMonth(), target.getDate(), 9, 30).getTime();
            const executeAtMs = Math.max(fireAt, Date.now() + 10 * 60_000);
            if (isWithinPushQuietHours(executeAtMs)) return;

            const sessions = loadChatSessions()
                .filter(session => !session.isGroup && config.periodCareCharacterIds.includes(resolveSessionCharacterId(session) || ""))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            const seen = new Set<string>();
            for (const session of sessions) {
                const characterId = resolveSessionCharacterId(session);
                if (!characterId || seen.has(characterId)) continue;
                seen.add(characterId);
                if (hasMenstrualPeriodCareTriggered(characterId, event.cycleKey)) continue;
                const characterName = loadCharacters().find(c => c.id === characterId)?.name ?? "小手机";
                const history = loadChatMessages(session.id);
                const { llmMessages, config: apiConfig, preset, regexes, userIdentity } = await buildChatPromptMessages(
                    session,
                    history,
                    { appTags: ["chat", "text", "period_care"], periodCareContext: event.context },
                );
                maybeAppendShortcutCapability(llmMessages, { continuationAvailable: true });
                const request = buildProviderRequest(apiConfig, preset, toLlmRequestMessages(llmMessages));
                const shortcutContinuation = buildOfflineShortcutContinuation(llmMessages, messages => {
                    const req = buildProviderRequest(apiConfig, preset, toLlmRequestMessages(messages));
                    return { url: req.url, headers: req.headers, body: req.body, providerKind: req.providerKind };
                }, apiConfig.enableImageRecognition === true);
                await postBailoutJob({
                    triggerKey: `periodcare:${characterId}:${event.cycleKey}`,
                    kind: "timed_task",
                    executeAtMs,
                    request,
                    notifyTitle: characterName,
                    shortcutContinuation,
                    merge: {
                        sessionId: session.id,
                        prevCount: 0,
                        regexes,
                        characterName,
                        userName: userIdentity?.name ?? "用户",
                        appId: "chat",
                        appTags: ["chat", "text", "period_care"],
                        armAt: new Date(executeAtMs).toISOString(),
                        periodCare: { characterId, cycleKey: event.cycleKey },
                    },
                });
            }
            return; // 只挂最近的一个关怀日
        }
    } catch (err) {
        console.warn("[PushBailout] period care arm failed:", err);
    }
}

let refreshingScheduled = false;

/** 刷新所有"已知触发时刻"的兜底快照（排期变更/切后台/启动时调用，保证上下文最新）。 */
export async function refreshScheduledBailouts(): Promise<void> {
    if (refreshingScheduled || !bailoutEnabled()) {
        if (!bailoutEnabled()) console.warn("[PushBailout] 跳过刷新：当前环境不支持服务端离线预约");
        return;
    }
    refreshingScheduled = true;
    try {
        for (const schedule of loadTimedWakeSchedules()) {
            // 失败原因过去被直接丢弃，导致「push_jobs 一条记录都没有」完全无法定位：
            // 是没走到、被安静时段拦了、找不到会话、还是 POST 被拒，全都看不见。
            // 这里逐条打出来（安卓可用 chrome://inspect 远程查看）。
            const result = await armTimedWakeBailout(schedule);
            console.warn(result.ok
                ? `[PushBailout] 定时唤醒已挂上：${schedule.id}`
                : `[PushBailout] 定时唤醒未挂上：${schedule.id} — ${result.reason}`);
        }
        for (const rule of loadIdleReconnectRules()) {
            const result = await armIdleReconnectBailout(rule);
            console.warn(result.ok
                ? `[PushBailout] 冷场重连已挂上：${rule.id}`
                : `[PushBailout] 冷场重连未挂上：${rule.id} — ${result.reason}`);
        }
        await armPeriodCareBailouts();
    } finally {
        refreshingScheduled = false;
    }
}

/**
 * 安装刷新钩子。触发时机有四类，缺一不可：
 *
 * ① 排期/规则变更（关键修复）——新建「主动联系」后立刻上传。
 *    旧实现只认「启动 20 秒后」与「切后台」两个时点，而上传本身要重新组装完整
 *    提示词与 LLM 请求，用户新建后若很快退出/被杀，POST 根本来不及发生，
 *    服务端连这个任务的存在都不知道。改为变更即上传后，先落库、后任杀。
 * ② 切后台——被杀前的最后一搏，保留作为兜底。
 * ③ 启动后尽快（3 秒）补挂一次，覆盖上次没走完的漏网。
 * ④ 前台定期巡检，兜住「创建时恰好在组装中被打断」的情况。
 */
export function installScheduledBailoutRefresher(): void {
    if (typeof window === "undefined") return;
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) void refreshScheduledBailouts();
    });
    window.addEventListener(BAILOUT_DIRTY_EVENT, () => { void refreshScheduledBailouts(); });
    // 规则被关闭/删除时撤销服务端预约。这是「关掉了还在弹」的唯一解：
    // 「长时间没消息时（可重复）」的下一发由服务端自己续排，本地删除不会
    // 让服务端停手，必须在删规则的那一刻显式 DELETE。
    window.addEventListener(BAILOUT_CANCEL_EVENT, (event) => {
        const detail = (event as CustomEvent<BailoutCancelDetail>).detail;
        if (!detail) return;
        if (detail.key) cancelBailoutKey(detail.key);
        if (detail.prefix) void cancelBailoutPrefix(detail.prefix);
    });
    // 通话结束：把通话开始时撤销掉的离线预约重新挂上。
    //
    // suspendBailoutsForCall 会撤销该会话的追问兜底与冷场重连，但撤销之后
    // 原先没有任何时机会重挂它们——refreshScheduledBailouts 要等 10 分钟巡检，
    // 而用户常在通话后不久就退出 App，那笔预约就一直是空的。
    // 表现：打过一次电话之后，角色再也不主动搭话（用户实报）。
    //
    // 只在正常挂断时触发：endCall() 先清 activeCall 再派发本事件，所以 arm*
    // 里的 isCallActiveForSession 门控会自然放行。崩溃/强杀不派发此事件，
    // 那种情况仍由下面的巡检兜底。
    window.addEventListener("chat-call-ended", () => { void refreshScheduledBailouts(); });
    window.setTimeout(() => { void refreshScheduledBailouts(); }, 3_000);
    // arm* 内部按 triggerKey 幂等覆盖，重复巡检只是覆盖同一行，代价极低。
    bgSetInterval(() => { void refreshScheduledBailouts(); }, 10 * 60_000);
}

/**
 * 清空本账号名下全部离线预约。
 *
 * 存量任务散落在多种前缀下（followup: / reply: / idle: / timedwake: /
 * periodcare: / shortcut:），逐条列举既容易漏、又会随功能增加而过时，
 * 所以直接让服务端按账号全清（running 标 cancelled、pending 删除）。
 *
 * 刻意不做「订阅门控短路」：那条短路依赖本地缓存，缓存说没订阅、服务端
 * 却还挂着单，正是「删了规则还在发」的典型情形——用户点这个按钮时就是
 * 要无条件把服务端清干净，哪怕多一个请求。
 */
export async function purgeAllBailoutJobs(): Promise<{ ok: boolean; error?: string }> {
    const response = await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ all: true }),
    }).catch(() => null);
    if (!response) return { ok: false, error: "请求没有发出去（网络或跨域失败）。" };
    if (response.ok) return { ok: true };
    // 把服务端给的原因带出来。以前只回一个 false，界面统一显示「请检查离线推送
    // 是否已部署、网络是否正常」——而真实原因可能是「网关不认 all 参数」这种
    // 具体问题，用户照着那句提示去查部署和网络，永远查不出所以然。
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${response.status}` };
}

/**
 * 列出服务端还在排队/执行中的全部预约。
 *
 * 失败时把原因带出来——这个面板存在的意义就是「看清到底挂了什么」，
 * 读不到还静默返回空列表，会让人误以为「已经清干净了」。
 */
export async function fetchScheduledJobs(): Promise<{
    ok: boolean;
    jobs?: Array<{ trigger_key: string; kind: string; execute_at: string; status: string }>;
    error?: string;
}> {
    if (!bailoutEnabled()) return { ok: false, error: "当前环境不支持服务端离线预约" };
    const response = await pushJobsFetch({ method: "GET" }).catch(() => null);
    if (!response) return { ok: false, error: "请求没有发出去（网络异常）。" };
    const data = await response.json().catch(() => ({})) as { ok?: boolean; jobs?: unknown; error?: string };
    if (!response.ok || data.ok !== true) {
        return { ok: false, error: data.error || `HTTP ${response.status}` };
    }
    const jobs = Array.isArray(data.jobs) ? data.jobs as Array<{ trigger_key: string; kind: string; execute_at: string; status: string }> : [];
    return { ok: true, jobs };
}

/**
 * 删掉一条服务端预约（精确键）。
 *
 * 刻意**不**走 maySkipBailoutCancel 那道门控：那是给「本地生成时顺手撤销」用的
 * 省请求优化，而这里是用户盯着某一条亲手点删除——必须真的发出去。
 */
export async function deleteScheduledJob(triggerKey: string): Promise<{ ok: boolean; error?: string }> {
    if (!bailoutEnabled()) return { ok: false, error: "当前环境不支持服务端离线预约" };
    if (!triggerKey) return { ok: false, error: "缺少任务键。" };
    const response = await pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ triggerKey }),
    }).catch(() => null);
    if (!response) return { ok: false, error: "请求没有发出去（网络异常）。" };
    if (response.ok) return { ok: true };
    const data = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, error: data.error || `HTTP ${response.status}` };
}

/**
 * 停掉某个角色的全部主动消息：服务端排期 + 本地排期一起清。
 *
 * 为什么不能只删服务端那一条：本地排期还在的话，下一次巡检
 *（refreshScheduledBailouts，切后台/每 10 分钟）会立刻把它重新挂上去——
 * 用户看到的就是「删了又回来」。所以这里连本地规则/排期一起关掉。
 *
 * 【一处刻意的例外】追问（followup）由角色输出里的焦虑值自动排期，
 * 不在本地留任何长期规则。这里只能撤掉眼前这一条；只要角色下一轮输出里
 * 焦虑值仍越过阈值，它会立刻再排一条。想根治得去调追问阈值/字段名
 *（面板下方有说明），不是删任务能解决的。
 */
export async function stopCharacterScheduledActivity(
    characterId: string,
): Promise<{ ok: boolean; localCleared: number; error?: string }> {
    if (!bailoutEnabled()) return { ok: false, localCleared: 0, error: "当前环境不支持服务端离线预约" };
    if (!characterId) return { ok: false, localCleared: 0, error: "缺少角色标识。" };
    let localCleared = 0;
    try {
        // ① 追问 / 回复兜底：按会话撤（它们的键里带的是 sessionId，不是角色 id）
        const sessions = loadChatSessions().filter(session => !session.isGroup && resolveSessionCharacterId(session) === characterId);
        for (const session of sessions) {
            await cancelBailoutPrefix(`followup:${session.id}:`);
            await deleteScheduledJob(`reply:${session.id}`);
        }
        // ② 冷场重连：撤服务端链，并关掉本地规则（否则 10 分钟内必然重挂）
        for (const rule of loadIdleReconnectRules().filter(item => item.characterId === characterId)) {
            await cancelBailoutPrefix(`idle:${rule.id}:`);
            removeIdleReconnectRule(rule.id);
            localCleared += 1;
        }
        // ③ 定时主动联系：本地删掉即会派发撤销事件
        for (const schedule of loadTimedWakeSchedules().filter(item => item.characterId === characterId)) {
            removeTimedWakeSchedule(schedule.id);
            localCleared += 1;
        }
        // ④ 经期关怀：键里带角色 id
        await cancelBailoutPrefix(`periodcare:${characterId}:`);
        return { ok: true, localCleared };
    } catch (err) {
        return { ok: false, localCleared, error: err instanceof Error ? err.message : String(err) };
    }
}

/** 撤销追问兜底预约：带 count 只撤该轮的精确键，不带则撤该会话全部。 */
export function cancelFollowUpBailout(sessionId: string, count?: number): void {
    if (!bailoutEnabled()) return;
    if (maySkipBailoutCancel()) return; // 账号没订阅→从没挂过单，别浪费请求
    void pushJobsFetch({
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
            typeof count === "number"
                ? { triggerKey: `followup:${sessionId}:${count}` }
                : { triggerPrefix: `followup:${sessionId}:` },
        ),
    }).catch(() => undefined);
}
