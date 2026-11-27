"use client";

export type NativeSpeechEvent = {
    type: "ready" | "partial" | "final" | "end" | "error";
    text?: string;
    code?: string;
    message?: string;
};

type NativeSpeechBridge = {
    startNativeSpeech?: (lang: string) => string;
    stopNativeSpeech?: () => boolean;
    cancelNativeSpeech?: () => boolean;
};

type NativeSpeechWindow = Window & {
    AndroidShell?: NativeSpeechBridge;
    __aiPhoneNativeSpeech?: (detail: NativeSpeechEvent) => void;
};

function bridge(): NativeSpeechBridge | null {
    if (typeof window === "undefined") return null;
    const value = (window as NativeSpeechWindow).AndroidShell;
    return value && typeof value.startNativeSpeech === "function" ? value : null;
}

export function isNativeSpeechAvailable(): boolean {
    return bridge() !== null;
}

export function startNativeSpeech(
    lang: string,
    onEvent: (event: NativeSpeechEvent) => void,
): { ok: boolean; reason?: string } {
    const api = bridge();
    if (!api) return { ok: false, reason: "当前壳版本不支持系统语音识别" };
    const target = window as NativeSpeechWindow;
    target.__aiPhoneNativeSpeech = (detail) => {
        if (!detail || typeof detail !== "object") return;
        onEvent(detail);
        if (detail.type === "final" || detail.type === "error") {
            if (target.__aiPhoneNativeSpeech) target.__aiPhoneNativeSpeech = undefined;
        }
    };
    try {
        const raw = api.startNativeSpeech?.(lang || "zh-CN") || "";
        if (raw) {
            const parsed = JSON.parse(raw) as { ok?: boolean; reason?: string };
            if (parsed.ok === false) {
                target.__aiPhoneNativeSpeech = undefined;
                return { ok: false, reason: parsed.reason || "系统语音识别启动失败" };
            }
        }
        return { ok: true };
    } catch (error) {
        target.__aiPhoneNativeSpeech = undefined;
        return { ok: false, reason: error instanceof Error ? error.message : "系统语音识别启动失败" };
    }
}

export function stopNativeSpeech(): void {
    try { bridge()?.stopNativeSpeech?.(); } catch { /* ignore */ }
}

export function cancelNativeSpeech(): void {
    try { bridge()?.cancelNativeSpeech?.(); } catch { /* ignore */ }
    if (typeof window !== "undefined") {
        (window as NativeSpeechWindow).__aiPhoneNativeSpeech = undefined;
    }
}
