/**
 * 云端调用熔断器：连续失败 5 次就停自动重试，发一次系统通知，等用户手动重试。
 *
 * 背景：Supabase 共享额度被反复失败重试空转吃掉（快照 500 / push_jobs 400 时，
 * 每个调度 tick 都再打一次云端）。这里按「通道」计数：
 *  · 成功 → 清零
 *  · 失败 → +1；达到 5 次 → paused=true，之后所有调用直接短路（不发请求）
 *  · 手动重试（诊断页按钮）→ reset，恢复自动同步
 */
import { kvGet, kvSet } from "@/lib/kv-db";
import { sendBrowserNotification } from "@/lib/browser-notification";
import { isShellEnvironment } from "@/lib/shell-detect";
import { sendShellNotification } from "@/lib/shell-notify";

export type CloudChannel = "life-snapshot" | "push" | "reality-bridge";
export type CloudBreakerState = {
    failures: number;
    paused: boolean;
    lastError: string;
    lastAt: number;
};

const KEY = "ai_phone_cloud_breaker_v1";
export const CLOUD_BREAKER_THRESHOLD = 5;
export const CLOUD_BREAKER_CHANGED_EVENT = "cloud-breaker-changed";

type Store = Partial<Record<CloudChannel, CloudBreakerState>>;

function load(): Store {
    try {
        const raw = kvGet(KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function save(store: Store): void {
    try {
        kvSet(KEY, JSON.stringify(store));
    } catch {
        /* 存不进去就退化为内存态之外的「不熔断」，不影响功能 */
    }
}

function notifyChanged(): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CLOUD_BREAKER_CHANGED_EVENT));
}

export function cloudBreakerState(channel: CloudChannel): CloudBreakerState {
    return load()[channel] ?? { failures: 0, paused: false, lastError: "", lastAt: 0 };
}

/** 该通道是否已熔断（调用前先问，true 就别发请求）。 */
export function cloudBreakerPaused(channel: CloudChannel): boolean {
    return cloudBreakerState(channel).paused;
}

export function noteCloudSuccess(channel: CloudChannel): void {
    const store = load();
    const cur = store[channel];
    if (!cur || (cur.failures === 0 && !cur.paused)) return;
    store[channel] = { failures: 0, paused: false, lastError: "", lastAt: Date.now() };
    save(store);
    notifyChanged();
}

export function noteCloudFailure(channel: CloudChannel, reason: string): CloudBreakerState {
    const store = load();
    const cur = store[channel] ?? { failures: 0, paused: false, lastError: "", lastAt: 0 };
    const failures = cur.failures + 1;
    const justPaused = !cur.paused && failures >= CLOUD_BREAKER_THRESHOLD;
    const next: CloudBreakerState = {
        failures,
        paused: cur.paused || justPaused,
        lastError: String(reason || "").slice(0, 200),
        lastAt: Date.now(),
    };
    store[channel] = next;
    save(store);
    notifyChanged();
    if (justPaused) {
        /* 只通知一次：告诉用户暂停了，去诊断页可手动重试 */
        const body = "连续 " + CLOUD_BREAKER_THRESHOLD + " 次失败（" + next.lastError + "）。已停止自动重试以免继续消耗额度，可在「我的 → 故障诊断」手动重试。";
        if (isShellEnvironment()) sendShellNotification("云端同步已暂停", body);
        else sendBrowserNotification("云端同步已暂停", { body });
    }
    return next;
}

/** 手动重试：清零并恢复自动同步（用户明确要求时调用）。 */
export function resetCloudBreaker(channel?: CloudChannel): void {
    const store = load();
    if (!channel) {
        save({});
        notifyChanged();
        return;
    }
    delete store[channel];
    save(store);
    notifyChanged();
}
