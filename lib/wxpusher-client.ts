// WxPusher 极简推送（SPT）客户端设置。
// SPT 属于用户私密凭证，只保存在本机 KV 库；服务端仅按请求转发。

import { kvGet, kvRemove, kvSet } from "./kv-db";

const WXPUSHER_SPT_KEY = "wxpusher_spt_v1";

export function isValidWxPusherSpt(value: string): boolean {
    return /^SPT_[A-Za-z0-9_-]{8,}$/.test(value.trim());
}

export function loadWxPusherSpt(): string {
    if (typeof window === "undefined") return "";
    return (kvGet(WXPUSHER_SPT_KEY) || "").trim();
}

export function saveWxPusherSpt(spt: string): void {
    if (typeof window === "undefined") return;
    const trimmed = spt.trim();
    if (trimmed) kvSet(WXPUSHER_SPT_KEY, trimmed);
    else kvRemove(WXPUSHER_SPT_KEY);
}

export function clearWxPusherSpt(): void {
    if (typeof window === "undefined") return;
    kvRemove(WXPUSHER_SPT_KEY);
}

type WxPusherApiResult = { ok: boolean; error?: string; message?: string };

async function postWxPusher(path: string, spt: string, extra?: Record<string, unknown>): Promise<WxPusherApiResult> {
    try {
        const response = await fetch(path, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ spt, ...extra }),
        });
        const data = await response.json().catch(() => ({})) as WxPusherApiResult;
        if (!response.ok || !data.ok) return { ok: false, error: data.error || `请求失败（HTTP ${response.status}）。` };
        return { ok: true, message: data.message };
    } catch {
        return { ok: false, error: "网络异常，请检查网络后重试。" };
    }
}

export function connectWxPusher(spt: string): Promise<WxPusherApiResult> {
    return postWxPusher("/api/push/wxpusher/connect", spt);
}

export function sendWxPusherTest(spt: string): Promise<WxPusherApiResult> {
    return postWxPusher("/api/push/wxpusher/test", spt);
}
