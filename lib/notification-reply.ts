"use client";

// 通知栏「直接回复」的网页侧处理。
//
// 链路：用户在消息通知横幅上回一句 → 原生 NotificationReplyReceiver 落队列
//       → 戳一下页面（event=userReply）或等页面下次挂载 → 本模块拉队列 →
//         以「用户发言」写进对应会话 → 触发角色回复。
//
// 为什么由网页来写消息而不是原生直接写：聊天引擎（上下文组装、模型调用、
// 消息落库）整个跑在 WebView 的 JS 里，原生没有那套逻辑。原生只负责
// 「别把用户打的字弄丢」——这是它唯一能可靠承担的职责。

import { loadChatSessions, pushChatMessage } from "./chat-storage";
import { requestBackgroundChatReply } from "./follow-up-service";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "./shell-call-overlay";

type ReplyBridge = {
    /** 旧壳兼容：读取时清空。 */
    consumePendingReplies?: () => string;
    /** 新壳：读取快照，成功落库后单独确认。 */
    readPendingReplies?: () => string;
    ackPendingReplies?: (idsJson: string) => void;
};

function bridge(): ReplyBridge | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ReplyBridge }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否支持通知栏直接回复（老 APK 没有）。 */
export function hasNotificationReplyBridge(): boolean {
    const api = bridge();
    return typeof api?.readPendingReplies === "function"
        || typeof api?.consumePendingReplies === "function";
}

/** 原生队列里的一条待发回复。 */
export type PendingNotificationReply = {
    id: string;
    sessionId: string;
    text: string;
    /** 用户按下发送的时刻（原生记的墙钟），仅用于排查 */
    at: number;
};

/** 读取原生待发队列快照；成功写入聊天后由调用方逐条确认。 */
export function readPendingReplies(): PendingNotificationReply[] {
    try {
        const api = bridge();
        // 新壳用可重试的 peek/ack；旧壳只有 consume（读即清空），继续兼容旧语义。
        const raw = api?.readPendingReplies?.() ?? api?.consumePendingReplies?.();
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

/**
 * 把待发队列里的回复逐条写进聊天并触发角色回应。
 *
 * 会话已被删除时跳过——一条无归属的回复写不进去，也不该硬造一个会话。
 * 返回实际发出的条数。
 */
let flushInFlight: Promise<number> | null = null;

export function flushPendingNotificationReplies(): Promise<number> {
    if (flushInFlight) return flushInFlight;
    flushInFlight = flushPendingNotificationRepliesOnce().finally(() => { flushInFlight = null; });
    return flushInFlight;
}

async function flushPendingNotificationRepliesOnce(): Promise<number> {
    const pending = readPendingReplies();
    if (pending.length === 0) return 0;

    const sessionIds = new Set(loadChatSessions().map(s => s.id));
    let sent = 0;
    const touched = new Set<string>();
    for (const item of pending) {
        if (!sessionIds.has(item.sessionId)) {
            // 会话已删除，无法投递；确认丢弃，避免一条无归属回复永久堵住队列。
            bridge()?.ackPendingReplies?.(JSON.stringify([item.id]));
            continue;
        }
        const text = item.text.trim();
        if (!text) {
            bridge()?.ackPendingReplies?.(JSON.stringify([item.id]));
            continue;
        }
        // pushChatMessage 同步完成本地写入；只有写入成功后才确认原生队列。
        // 若这里抛错，该条仍留在原生队列，下次页面启动会重试。
        pushChatMessage({ sessionId: item.sessionId, role: "user", content: text });
        bridge()?.ackPendingReplies?.(JSON.stringify([item.id]));
        touched.add(item.sessionId);
        sent += 1;
    }

    // 每个会话只触发一次回复：同一会话连回几句时，一次生成就该看到全部，
    // 逐条触发会连出好几轮，读起来像角色在自说自话。
    for (const sessionId of touched) {
        void requestBackgroundChatReply(sessionId).catch(() => undefined);
    }
    return sent;
}

/**
 * 启动通知回复的处理：页面挂载时补发一次，之后每次收到 userReply 事件再拉一次。
 *
 * 返回取消函数（组件卸载时用）。并发 flush 会合并为同一个 Promise，
 * 只有本地聊天写入成功后才确认原生队列，异常时保留待重试。
 */
export function startNotificationReplyBridge(): () => void {
    if (typeof window === "undefined") return () => { /* noop */ };
    if (!hasNotificationReplyBridge()) return () => { /* noop */ };

    // 挂载时补发：页面被系统回收期间，用户从通知里回的话都还堆在原生队列里
    void flushPendingNotificationReplies().catch(() => undefined);

    ensureShellOverlayListener();
    return subscribeShellOverlayEvents((event) => {
        if (event.action !== "userReply") return;
        void flushPendingNotificationReplies().catch(() => undefined);
    });
}
