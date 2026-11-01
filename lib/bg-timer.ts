// Background-safe timers using a Web Worker, with automatic native-timer recovery.
// A Worker crash must not silently strand timers used by check-in, follow-up,
// reality bridge, widgets, and other background schedulers.

type TimerRecord = {
    callback: () => void;
    ms: number;
    repeat: boolean;
    dueAt: number;
    nativeId: ReturnType<typeof setTimeout> | null;
};

let worker: Worker | null = null;
const timers = new Map<string, TimerRecord>();
let idCounter = 0;

function scheduleNative(id: string, delay: number): void {
    const record = timers.get(id);
    if (!record) return;
    if (record.nativeId !== null) clearTimeout(record.nativeId);
    record.dueAt = Date.now() + Math.max(0, delay);
    record.nativeId = setTimeout(() => {
        const current = timers.get(id);
        if (!current) return;
        current.nativeId = null;
        if (!current.repeat) timers.delete(id);
        try {
            current.callback();
        } finally {
            if (current.repeat && timers.has(id) && !worker) {
                scheduleNative(id, current.ms);
            }
        }
    }, Math.max(0, delay));
}

function recoverWorkerTimers(failedWorker: Worker): void {
    if (worker !== failedWorker) return;
    worker = null;
    try { failedWorker.terminate(); } catch { /* already terminated */ }
    for (const [id, record] of timers) {
        const remaining = Math.max(0, record.dueAt - Date.now());
        scheduleNative(id, remaining);
    }
}

function ensureWorker(): Worker | null {
    if (worker) return worker;
    if (typeof window === "undefined" || typeof Worker === "undefined") return null;
    try {
        const created = new Worker("/timer-worker.js");
        worker = created;
        created.onmessage = (e) => {
            if (e.data?.type !== "tick") return;
            const record = timers.get(String(e.data.id));
            if (!record) return;
            if (!record.repeat) timers.delete(String(e.data.id));
            record.dueAt = record.repeat ? Date.now() + record.ms : 0;
            record.callback();
        };
        created.onerror = () => recoverWorkerTimers(created);
        return created;
    } catch {
        return null;
    }
}

function startTimer(callback: () => void, ms: number, repeat: boolean): () => void {
    const id = `bgt_${++idCounter}`;
    const duration = Math.max(0, Number.isFinite(ms) ? ms : 0);
    const record: TimerRecord = {
        callback,
        ms: duration,
        repeat,
        dueAt: Date.now() + duration,
        nativeId: null,
    };
    timers.set(id, record);

    const w = ensureWorker();
    if (w) {
        try {
            w.postMessage({
                type: repeat ? "start-interval" : "start-timeout",
                id,
                ms: duration,
            });
        } catch {
            recoverWorkerTimers(w);
            if (timers.has(id) && record.nativeId === null) scheduleNative(id, duration);
        }
    } else {
        scheduleNative(id, duration);
    }

    return () => {
        const current = timers.get(id);
        if (!current) return;
        timers.delete(id);
        if (current.nativeId !== null) clearTimeout(current.nativeId);
        try { worker?.postMessage({ type: "stop", id }); } catch { /* worker unavailable */ }
    };
}

/** setInterval that survives background tab throttling while the Worker is alive. */
export function bgSetInterval(callback: () => void, ms: number): () => void {
    return startTimer(callback, ms, true);
}

/** setTimeout that survives background tab throttling while the Worker is alive. */
export function bgSetTimeout(callback: () => void, ms: number): () => void {
    return startTimer(callback, ms, false);
}

/** Promise delay backed by the worker timer, with optional abort support. */
export function bgDelay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        let cancel: () => void = () => {};
        const onAbort = () => {
            cancel();
            reject(new DOMException("Aborted", "AbortError"));
        };
        cancel = bgSetTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/** Clean up all timers and terminate the Worker (call on app teardown). */
export function bgTimerCleanup(): void {
    if (worker) {
        try { worker.postMessage({ type: "stop-all" }); } catch { /* ignore */ }
        worker.terminate();
        worker = null;
    }
    for (const record of timers.values()) {
        if (record.nativeId !== null) clearTimeout(record.nativeId);
    }
    timers.clear();
}
