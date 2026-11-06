"use client";

// 通知栏「直接回复」的网页侧处理：普通聊天写回会话，生活现场回复写回原场景。
// 原生只负责把文本、sceneId 和回复类型可靠落入持久队列；上下文组装、模型回应
// 与生活现场时间线仍由 WebView 中的 JS 引擎完成。

import { loadChatMessages, loadChatSessions, pushChatMessage, resolveSessionCharacterId } from "./chat-storage";
import { loadVirtualLifeState, saveVirtualLifeState, appendLifeTimelineEntry } from "./life/life-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "./shell-call-overlay";
import { recordLifeDiagnostic } from "./life/life-diagnostics";
import { enqueuePendingLifeSceneReply } from "./life/life-notification-queue";

type ReplyBridge = {
    consumePendingReplies?: () => string;
    peekPendingReplies?: () => string;
    acknowledgePendingReplies?: (idsJson: string) => boolean;
};

function bridge(): ReplyBridge | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ReplyBridge }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否支持通知栏直接回复（老 APK 没有）。 */
export function hasNotificationReplyBridge(): boolean {
    const api = bridge();
    return typeof api?.consumePendingReplies === "function"
        || (typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function");
}

/** 原生队列里的一条待发回复。 */
export type PendingNotificationReply = {
    id: string;
    sessionId: string;
    text: string;
    /** 用户按下发送的时刻（原生记的墙钟），仅用于排查 */
    at: number;
    sceneId?: string;
    replyMode?: "action" | "dialogue" | "chat" | string;
};

/** 优先 peek 原生队列，等网页数据持久化后再 ack；旧 APK 退回 read-and-clear。 */
export function readPendingReplies(): PendingNotificationReply[] {
    try {
        const api = bridge();
        const raw = typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function"
            ? api.peekPendingReplies()
            : api?.consumePendingReplies?.();
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((item): item is PendingNotificationReply => (
            !!item
            && typeof item === "object"
            && typeof (item as PendingNotificationReply).id === "string"
            && typeof (item as PendingNotificationReply).sessionId === "string"
            && typeof (item as PendingNotificationReply).text === "string"
            && (item as PendingNotificationReply).text.trim().length > 0
        ));
    } catch {
        return [];
    }
}

/** Mirror a native life-scene reply into its exact active scene; non-life replies use chat fallback. */
/**
 * Life-scene replies arrive through the same native queue as ordinary chat replies.
 * Preserve the existing chat delivery, but also mirror the user's words into the
 * active scene when the notification belongs to a character who is physically
 * present with the player. The stable native reply id makes this idempotent.
 */
function mirrorNotificationReplyToLifeScene(item: PendingNotificationReply, text: string): "written" | "missing-scene" | "not-life" | "retry" {
    try {
        if (!item.sceneId || !["action", "dialogue"].includes(item.replyMode || "")) return "not-life";
        const session = loadChatSessions().find(candidate => candidate.id === item.sessionId);
        if (!session || session.isGroup) return "not-life";
        const characterId = resolveSessionCharacterId(session);
        if (!characterId) return "not-life";
        const state = loadVirtualLifeState();
        if (!state.settings.enabled || state.settings.recordSceneMessages === false) return "missing-scene";
        const scene = state.scenes.find(candidate => candidate.id === item.sceneId && candidate.status === "active"
            && candidate.participants.some(participant => participant.ownerType === "player" && participant.ownerId === "player")
            && candidate.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId && participant.activity !== "离开"));
        if (!scene) return "missing-scene";
        const messageId = "notification-reply-" + item.id;
        const alreadyWritten = state.sceneMessages.some(message => message.id === messageId);
        const createdAt = Number.isFinite(item.at) && item.at > 0 ? new Date(item.at).toISOString() : new Date().toISOString();
        const playerName = state.settings.playerDisplayName || "我";
        const isAction = item.replyMode === "action";
        if (!alreadyWritten) {
            const message = {
                id: messageId, sceneId: scene.id, speakerType: "player" as const, speakerId: "player",
                speakerName: playerName, role: "player" as const,
                action: isAction ? text : "", dialogue: isAction ? "" : text, createdAt,
            };
            let next = {
                ...state,
                scenes: state.scenes.map(candidate => candidate.id === scene.id ? { ...candidate, updatedAt: new Date().toISOString() } : candidate),
                sceneMessages: [...state.sceneMessages, message],
            };
            next = appendLifeTimelineEntry(next, {
                category: isAction ? "action" : "dialogue", occurredAt: createdAt,
                title: playerName + (isAction ? "通过通知回复行动" : "通过通知回复"),
                details: text, actorId: "player", actorName: playerName,
                locationName: scene.locationName, sceneId: scene.id, sourceId: message.id,
            });
            saveVirtualLifeState(next);
        }
        const queued = enqueuePendingLifeSceneReply({
            replyId: item.id, sceneId: scene.id, characterId, replyMode: isAction ? "action" : "dialogue",
        });
        if (!queued) {
            recordLifeDiagnostic({ source: "通知回复", event: "生活现场回复队列持久化失败", status: "error", detail: "现场消息已写入，但本机自动回应队列未能保存；原生通知队列将保留并重试。", meta: { replyId: item.id, sceneId: scene.id, characterId } });
            return "retry";
        }
        if (typeof window !== "undefined") {
            window.dispatchEvent(new Event("life-scene-message-added"));
            window.dispatchEvent(new CustomEvent("life-scene-notification-reply", { detail: { replyId: item.id, sceneId: scene.id, characterId, replyMode: item.replyMode } }));
            if (window.location.pathname !== "/life" && window.location.pathname !== "/life/") {
                window.location.assign("/life?sceneId=" + encodeURIComponent(scene.id));
            }
        }
        recordLifeDiagnostic({ source: "通知回复", event: isAction ? "行动已写入生活现场" : "对白已写入生活现场", status: "ok", detail: "通知回复已写入指定现场并保留回复类型。", meta: { replyId: item.id, sceneId: scene.id, characterId, replyMode: item.replyMode } });
        return "written";
    } catch (error) {
        recordLifeDiagnostic({ source: "通知回复", event: "生活现场写回异常", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { replyId: item.id, sceneId: item.sceneId } });
        console.warn("[NotificationReply] life-scene writeback failed:", error);
        return "retry";
    }
}

let notificationReplyFlushPromise: Promise<number> | null = null;

export function flushPendingNotificationReplies(): Promise<number> {
    if (notificationReplyFlushPromise) return notificationReplyFlushPromise;
    const task = flushPendingNotificationRepliesInternal();
    notificationReplyFlushPromise = task.finally(() => { notificationReplyFlushPromise = null; });
    return notificationReplyFlushPromise;
}

async function flushPendingNotificationRepliesInternal(): Promise<number> {
    const api = bridge();
    const durableBridge = typeof api?.peekPendingReplies === "function" && typeof api?.acknowledgePendingReplies === "function";
    const pending = readPendingReplies();
    if (pending.length === 0) return 0;

    const sessions = new Set(loadChatSessions().map(session => session.id));
    const completedIds: string[] = [];
    let sent = 0;
    const chatReplies = new Set<string>();
    for (const item of pending) {
        if (!sessions.has(item.sessionId)) {
            recordLifeDiagnostic({ source: "通知回复", event: "回复丢弃", status: "warning", detail: "对应会话已不存在，已将原生队列项标记为终态。", meta: { replyId: item.id, sessionId: item.sessionId } });
            completedIds.push(item.id);
            continue;
        }
        const text = item.text.trim();
        if (!text) { completedIds.push(item.id); continue; }
        const result = mirrorNotificationReplyToLifeScene(item, text);
        if (result === "written") {
            recordLifeDiagnostic({ source: "通知回复", event: "通知回复已写入并排队", status: "ok", detail: "生活现场消息和本机 AI 回复任务均已持久化。", meta: { replyId: item.id, sceneId: item.sceneId, replyMode: item.replyMode } });
            completedIds.push(item.id);
            sent += 1;
            continue;
        }
        if (result === "retry") {
            recordLifeDiagnostic({ source: "通知回复", event: "原生回复保留待重试", status: "error", detail: "网页侧持久化未完整成功，未确认原生通知队列；下次恢复时会再次处理。", meta: { replyId: item.id, sessionId: item.sessionId, sceneId: item.sceneId } });
            continue;
        }

        // Ordinary-chat fallback uses a stable message ID. If native acknowledgement
        // fails, the next flush sees the same ID and will not create a duplicate bubble.
        const chatMessageId = "notification-reply-chat-" + item.id;
        try {
            const messagesBefore = loadChatMessages(item.sessionId);
            const alreadyPersisted = messagesBefore.some(message => message.id === chatMessageId);
            if (!alreadyPersisted) pushChatMessage({ id: chatMessageId, sessionId: item.sessionId, role: "user", content: text });
            const messagesAfter = alreadyPersisted ? messagesBefore : loadChatMessages(item.sessionId);
            const userIndex = messagesAfter.findIndex(message => message.id === chatMessageId);
            const hasAssistantResponse = userIndex >= 0 && messagesAfter.slice(userIndex + 1).some(message => message.role === "assistant" && message.status !== "failed" && !message.isRetracted);
            if (!hasAssistantResponse) chatReplies.add(item.sessionId);
            completedIds.push(item.id);
            sent += 1;
            recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复已持久化", status: "info", detail: result === "missing-scene" ? "原生活现场不可用，已按普通聊天兼容处理。" : "通知回复已写入普通聊天会话。", meta: { replyId: item.id, sessionId: item.sessionId, replyMode: item.replyMode || "chat" } });
        } catch (error) {
            recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复持久化失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { replyId: item.id, sessionId: item.sessionId } });
        }
    }

    if (durableBridge && completedIds.length > 0) {
        let acknowledged = false;
        try { acknowledged = api?.acknowledgePendingReplies?.(JSON.stringify(completedIds)) === true; }
        catch (error) { recordLifeDiagnostic({ source: "通知回复", event: "原生队列确认异常", status: "warning", detail: error instanceof Error ? error.message : String(error), meta: { replyIds: completedIds } }); }
        if (!acknowledged) recordLifeDiagnostic({ source: "通知回复", event: "原生队列确认失败", status: "warning", detail: "网页侧数据已持久化，但原生队列仍保留；稳定消息 ID 会阻止重复写入。", meta: { replyIds: completedIds } });
        else recordLifeDiagnostic({ source: "通知回复", event: "原生通知队列已确认", status: "ok", detail: "仅确认已成功写入本机数据库/生活队列的回复。", meta: { replyIds: completedIds } });
    }

    for (const sessionId of chatReplies) {
        void requestBackgroundChatReply(sessionId).catch(error => recordLifeDiagnostic({ source: "通知回复", event: "普通聊天回复生成失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { sessionId } }));
    }
    return sent;
}

/**
 * 启动通知回复的处理：页面挂载时补发一次，之后每次收到 userReply 事件再拉一次。
 *
 * 返回取消函数（组件卸载时用）。重复调用无害——新壳侧队列使用 peek + ack；旧壳兼容 read-and-clear，网页侧稳定 ID 可避免重复写入。
 */
export function startNotificationReplyBridge(): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    if (!hasNotificationReplyBridge()) return () => { /* noop */ };

    // 挂载时补发：页面被系统回收期间，用户从通知里回的话都还堆在原生队列里
    void flushPendingNotificationReplies().catch(() => undefined);

    ensureShellOverlayListener();
    const unsubscribeShell = subscribeShellOverlayEvents((event) => {
        if (event.action !== "userReply") return;
        void flushPendingNotificationReplies().catch(() => undefined);
    });
    const onLifeQueueUpdated = () => { void flushPendingNotificationReplies().catch(() => undefined); };
    window.addEventListener("life-scene-notification-queue-updated", onLifeQueueUpdated);
    return () => {
        unsubscribeShell();
        window.removeEventListener("life-scene-notification-queue-updated", onLifeQueueUpdated);
    };
}
