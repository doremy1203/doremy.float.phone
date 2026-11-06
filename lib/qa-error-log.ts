// ── 工坊：全局报错收集（轻量 ring buffer）────────────
// 供工坊与「设置 → 运行诊断」读取。仅保存在本机，不自动上传。

export type QaErrorEntry = {
    ts: number;
    kind: "error" | "unhandledrejection";
    message: string;
    source?: string;
};

const MAX_ENTRIES = 50;
const STORAGE_KEY = "float.qa-error-log.v1";
const entries: QaErrorEntry[] = [];
let installed = false;

function sanitizeMessage(value: unknown): string {
    let message: string;
    try {
        if (value instanceof Error) message = value.message;
        else if (typeof value === "string") message = value;
        else message = JSON.stringify(value ?? "未知错误") ?? "未知错误";
    } catch {
        message = String(value ?? "未知错误");
    }
    return message
        .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[已隐藏]")
        .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[已隐藏]")
        .slice(0, 400);
}

function persist(): void {
    try {
        if (typeof window === "undefined") return;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
    } catch {
        // Storage may be unavailable/full. Diagnostics must never break the app.
    }
}

function restore(): void {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const item of parsed.slice(-MAX_ENTRIES)) {
            if (!item || typeof item !== "object") continue;
            const entry = item as Partial<QaErrorEntry>;
            if (typeof entry.ts !== "number") continue;
            if (entry.kind !== "error" && entry.kind !== "unhandledrejection") continue;
            if (typeof entry.message !== "string") continue;
            entries.push({
                ts: entry.ts,
                kind: entry.kind,
                message: sanitizeMessage(entry.message),
                source: typeof entry.source === "string" ? entry.source.slice(0, 160) : undefined,
            });
        }
    } catch {
        // Ignore malformed/stale diagnostic cache.
    }
}

function push(entry: QaErrorEntry): void {
    entries.push({ ...entry, message: sanitizeMessage(entry.message) });
    if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
    persist();
}

export function installQaErrorLog(): void {
    if (installed || typeof window === "undefined") return;
    installed = true;
    restore();

    window.addEventListener("error", (event) => {
        push({
            ts: Date.now(),
            kind: "error",
            message: sanitizeMessage(event.message || event.error || "未知错误"),
            source: event.filename ? event.filename.split("/").pop() + ":" + event.lineno : undefined,
        });
    });

    window.addEventListener("unhandledrejection", (event) => {
        push({ ts: Date.now(), kind: "unhandledrejection", message: sanitizeMessage(event.reason) });
    });

    // 收集来自游戏/剧场 iframe 的运行时报错（见 qa-iframe-error-bridge）
    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || typeof data !== "object" || data.source !== "ai-phone-iframe-error") return;
        const origin = typeof data.origin === "string" && data.origin ? data.origin : "iframe";
        const loc = typeof data.source_loc === "string" && data.source_loc ? data.source_loc : undefined;
        push({
            ts: Date.now(),
            kind: "error",
            message: "[" + origin + "] " + String(data.message ?? "").slice(0, 360),
            source: loc,
        });
    });
}

export function getQaErrorEntries(): QaErrorEntry[] {
    return [...entries];
}

// 浏览器端导入即安装
installQaErrorLog();
