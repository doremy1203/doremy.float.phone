import { isCompatibilityFeatureEnabled } from "./device-compatibility";
// lib/shell-call-overlay.ts
//
// 网页 ↔ 安卓壳「通话浮窗」桥。
//
// 背景：网页里的小窗出不了浏览器窗口，切到别的 App 就看不见了。壳侧新增了
// CallOverlayService（WindowManager + TYPE_APPLICATION_OVERLAY），能把通话
// 做成真正浮在其他 App 上层的原生小窗。本模块是它在网页侧的对接层。
//
// 四个方向：
//   1. 网页 → 原生：start/update/stop（window.AndroidShell）；
//   2. 原生 → 网页：window 上的 'shell-call-overlay' CustomEvent；
//   3. 权限引导：浮窗权限、无障碍未开时给出跳转入口；
//   4. 测试链路：debug 面板可查看最近事件，排查用。
//
// 全部 API 在非壳环境（普通浏览器）下安全降级为 no-op，调用方无需分支判断。

import { useEffect, useState } from "react";

type ShellBridgeLike = {
    getVersion?: () => string;
    canDrawOverlay?: () => boolean;
    requestOverlayPermission?: () => void;
    startCallOverlay?: (name: string, avatar: string, meta: string, callId: string, elapsedSeconds: number) => boolean;
    /** 切到后台：显示预热好的浮窗；回到前台：藏起来（服务继续活着） */
    showCallOverlay?: () => void;
    hideCallOverlay?: () => void;
    updateCallOverlay?: (name: string, avatar: string, meta: string, elapsedSeconds: number) => void;
    /** 左上角「待发 N」角标（0 = 隐藏）。新壳才有 */
    updateCallOverlayPending?: (count: number) => void;
    stopCallOverlay?: () => void;
    /** 快捷回复条配色主题（存在壳侧 SharedPreferences） */
    getOverlayTheme?: () => string;
    setOverlayTheme?: (key: string) => void;
    /** 完整配色的 JSON（预设键 + 逐项自定义），新壳才有 */
    getOverlayThemeJson?: () => string;
    setOverlayThemeJson?: (json: string) => void;
    /** 浮窗内部状态快照（JSON），排障用 */
    getOverlayDebugInfo?: () => string;
    isAccessibilityConnected?: () => boolean;
    openAccessibilitySettings?: () => void;
};

/** 原生浮窗事件 */
export type ShellOverlayAction = "restore" | "hangup" | "reply" | "tick" | "needPermission" | "accessibility" | "foregroundApp" | "screenshot" | "checkIn" | "userReply";

export type ShellOverlayEvent = {
    action: ShellOverlayAction;
    /** action='reply' 时的文本 */
    text?: string;
    /** action='tick' 时的通话秒数（原生计时，后台也走） */
    seconds?: number;
    /** 本次通话 id，用于校验事件属于哪一通 */
    callId?: string;
    /** action='foregroundApp' 时的前台包名 */
    package?: string;
    /** action='screenshot'：截屏是否成功 */
    ok?: boolean;
    /** action='screenshot' 失败时的原因 */
    reason?: string;
    /** action='screenshot' 成功时的 PNG base64（不含 data: 前缀） */
    base64?: string;
    /** action='screenshot' 成功时画面的宽 */
    width?: number;
    /** action='screenshot' 成功时画面的高 */
    height?: number;
    /** action='screenshot' 成功时 PNG 字节数 */
    bytes?: number;
    /** action='checkIn'：哪个角色发起的查岗 */
    characterId?: string;
    /** action='checkIn'：用户是否同意给角色看 */
    accepted?: boolean;
    /** action='checkIn' 用户在浮层回复框里顺手说的话（可选） */
    reply?: string;
    /** action='userReply'：用户从通知栏直接回复，待发消息落在哪个会话 */
    sessionId?: string;
};

/** 原生事件到达时触发（跨页面/跨组件订阅用） */
export const SHELL_OVERLAY_EVENT = "shell-call-overlay";

function bridge(): ShellBridgeLike | null {
    if (typeof window === "undefined") return null;
    const candidate = (window as unknown as { AndroidShell?: ShellBridgeLike }).AndroidShell;
    return candidate && typeof candidate === "object" ? candidate : null;
}

/** 是否运行在安卓壳里（普通浏览器 / PWA 返回 false） */
export function isShellEnvironment(): boolean {
    return bridge() !== null;
}

/** 壳是否支持通话浮窗（老版本 APK 没有这些方法） */
export function supportsCallOverlay(): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;

    const b = bridge();
    return !!b && typeof b.startCallOverlay === "function";
}

/** 浮窗权限是否已授予（非壳环境恒为 false） */
export function canDrawOverlay(): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;

    return !!bridge()?.canDrawOverlay?.();
}

/** 跳到系统「显示在其他应用上层」授权页 */
export function requestOverlayPermission(): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    bridge()?.requestOverlayPermission?.();
}

/** 无障碍服务是否已开启 */
export function isAccessibilityConnected(): boolean {
    return !!bridge()?.isAccessibilityConnected?.();
}

/** 跳到系统「无障碍」设置页 */
export function openAccessibilitySettings(): void {
    bridge()?.openAccessibilitySettings?.();
}

/** 让原生开一个通话浮窗。返回 false 表示没有浮窗权限（需要引导授权）。 */
export function startShellCallOverlay(params: {
    name: string;
    avatar?: string | null;
    meta?: string[];
    callId: string;
    /** 网页侧已通话秒数。浮窗是切到后台才建的，必须带上基准，
     *  否则原生从 0 起数，和网页计时两套并行、时长对不上。 */
    elapsedSeconds?: number;
}): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;
    const b = bridge();
    if (!b?.startCallOverlay) return false;
    try {
        return !!b.startCallOverlay(
            params.name,
            params.avatar || "",
            (params.meta ?? []).join("\n"),
            params.callId,
            Math.max(0, Math.floor(params.elapsedSeconds ?? 0)),
        );
    } catch {
        return false;
    }
}

/** 更新浮窗内容（名称/头像/时长），不重建窗口 */
export function updateShellCallOverlay(params: {
    name: string;
    avatar?: string | null;
    meta?: string[];
    elapsedSeconds?: number;
}): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;
    const b = bridge();
    if (!b?.updateCallOverlay) return;
    try {
        b.updateCallOverlay(
            params.name,
            params.avatar || "",
            (params.meta ?? []).join("\n"),
            Math.max(0, Math.floor(params.elapsedSeconds ?? 0)),
        );
    } catch {
        /* 浮窗不在或 WebView 已销毁，忽略 */
    }
}

/**
 * 更新原生浮窗左上角的「待发 N」角标（0 = 隐藏）。
 *
 * 与网页小窗的角标对齐：通话忙碌时从浮窗回复条发出去的消息会排队等角色说完，
 * 没有角标用户根本不知道消息还排着，只会以为「又空发了」。
 * 老壳没有这个方法，静默忽略。
 */
export function updateShellCallOverlayPending(count: number): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    const b = bridge();
    if (!b?.updateCallOverlayPending) return;
    try {
        b.updateCallOverlayPending(Math.max(0, Math.floor(count)));
    } catch {
        /* 浮窗不在或 WebView 已销毁，忽略 */
    }
}

/**
 * 显示浮窗（页面转入后台时调用）。
 *
 * 浮窗服务在通话接通、App 还在前台时就已经预热好了，这里只是把窗口亮出来。
 * 过去是在这一刻才去启动前台服务，而 Android 12+ 禁止后台启动前台服务，
 * 于是浮窗时不时不弹。
 */
export function showShellCallOverlay(): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    const b = bridge();
    if (!b?.showCallOverlay) return;
    try {
        b.showCallOverlay();
    } catch {
        /* 忽略 */
    }
}

/** 隐藏浮窗（回到 App 前台时调用）。服务继续运行，下次切出去秒显。 */
export function hideShellCallOverlay(): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    const b = bridge();
    if (!b?.hideCallOverlay) return;
    try {
        b.hideCallOverlay();
    } catch {
        /* 忽略 */
    }
}

/** 壳是否支持「预热后显示/隐藏」这套浮窗生命周期（老 APK 没有）。 */
export function supportsOverlayShowHide(): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;

    return typeof bridge()?.showCallOverlay === "function";
}

/** 读当前快捷回复条主题键（非壳环境返回空串）。 */
export function getShellOverlayTheme(): string {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return "";

    try {
        return bridge()?.getOverlayTheme?.() ?? "";
    } catch {
        return "";
    }
}

/** 设置快捷回复条主题键；已弹出的回复条会即时换色。 */
export function setShellOverlayTheme(key: string): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    const b = bridge();
    if (!b?.setOverlayTheme) return;
    try {
        b.setOverlayTheme(key);
    } catch {
        /* 忽略 */
    }
}

/** 壳是否支持自定义回复条主题（老 APK 没有）。 */
export function supportsOverlayTheme(): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;

    return typeof bridge()?.setOverlayTheme === "function";
}

/** 读壳里存的完整配色 JSON（老 APK 返回空串）。 */
export function getShellOverlayThemeJson(): string {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return "";

    try {
        return bridge()?.getOverlayThemeJson?.() ?? "";
    } catch {
        return "";
    }
}

/** 下发完整配色 JSON（预设键 + 自定义覆盖）；已弹出的回复条会即时重绘。 */
export function setShellOverlayThemeJson(json: string): void {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return;

    const b = bridge();
    if (!b?.setOverlayThemeJson) return;
    try {
        b.setOverlayThemeJson(json);
    } catch {
        /* 忽略 */
    }
}

/** 壳是否支持逐项自定义配色（老 APK 只认主题键）。 */
export function supportsOverlayCustomColors(): boolean {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return false;

    return typeof bridge()?.setOverlayThemeJson === "function";
}

/** 浮窗内部状态快照。浮窗「不出现」时用它定位卡在哪一环。 */
export type ShellOverlayDebugInfo = {
    /** 系统是否允许画浮层（false = 权限没给） */
    canDraw: boolean;
    /** 服务是否在运行 */
    running: boolean;
    /** 壳自己认知的前后台 */
    hostInForeground: boolean;
    /** 是否有活动实例（通话有没有发过 START） */
    hasInstance: boolean;
    /** 窗口是否真的挂上了（false 且 hasInstance = addView 失败） */
    windowAdded: boolean;
    /** 窗口是否处于「应可见」状态 */
    visible: boolean;
    /** 最近一次失败原因（空串 = 没记录到失败） */
    lastError: string;
};

export function readShellOverlayDebugInfo(): ShellOverlayDebugInfo | null {
    if (!isCompatibilityFeatureEnabled("callOverlay")) return null;

    try {
        const raw = bridge()?.getOverlayDebugInfo?.();
        if (!raw) return null;
        return JSON.parse(raw) as ShellOverlayDebugInfo;
    } catch {
        return null;
    }
}

/** 收掉原生浮窗 */
export function stopShellCallOverlay(): void {
    const b = bridge();
    if (!b?.stopCallOverlay) return;
    try {
        b.stopCallOverlay();
    } catch {
        /* 忽略 */
    }
}

// ── 事件订阅 ──

type Listener = (event: ShellOverlayEvent) => void;
const listeners = new Set<Listener>();

/**
 * 订阅原生浮窗事件。返回取消订阅函数。
 * 用模块级 Set 而不是每次 addEventListener：多个组件（通话屏、全局层、调试面板）
 * 同时监听时，window 上只挂一个真正的监听器，退出时也不容易漏删。
 */
export function subscribeShellOverlayEvents(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

let domListenerInstalled = false;

/** 把 window 上的 CustomEvent 转成模块内订阅（只装一次） */
export function ensureShellOverlayListener(): void {
    if (typeof window === "undefined" || domListenerInstalled) return;
    domListenerInstalled = true;
    window.addEventListener(SHELL_OVERLAY_EVENT, (event) => {
        const detail = (event as CustomEvent).detail as ShellOverlayEvent | undefined;
        if (!detail || typeof detail.action !== "string") return;
        recordOverlayTrace(detail);
        listeners.forEach((listener) => {
            try {
                listener(detail);
            } catch (error) {
                console.warn("[shell-call-overlay] 监听器异常", error);
            }
        });
    });
}

// ── 测试链路：最近事件留痕 ──
//
// 浮窗出问题时最难查的是「事件到底有没有从原生过来」。这里在模块级留一小段
// 环形缓冲，设置页/调试面板可以直接读，不必连 USB 调试。

const TRACE_LIMIT = 40;
const traceBuffer: Array<{ at: number; event: ShellOverlayEvent }> = [];

function recordOverlayTrace(event: ShellOverlayEvent): void {
    traceBuffer.push({ at: Date.now(), event });
    if (traceBuffer.length > TRACE_LIMIT) traceBuffer.splice(0, traceBuffer.length - TRACE_LIMIT);
    // 挂到 window 上一份，方便在远程调试控制台直接看
    if (typeof window !== "undefined") {
        (window as unknown as { __shellOverlayTrace?: unknown }).__shellOverlayTrace = traceBuffer;
    }
}

/** 读取最近的原生浮窗事件（调试用） */
export function readShellOverlayTrace(): Array<{ at: number; event: ShellOverlayEvent }> {
    return [...traceBuffer];
}

/** 清空事件留痕 */
export function clearShellOverlayTrace(): void {
    traceBuffer.length = 0;
}

/**
 * 环境自检：一次性返回壳/权限/无障碍状态，用于「浮窗设置」页展示与排障。
 * 每次调用都重新问原生，不做缓存——用户在系统设置里授权后回来要能立刻看到变化。
 */
export function inspectShellOverlay(): {
    inShell: boolean;
    supported: boolean;
    canDraw: boolean;
    accessibility: boolean;
    version: string;
} {
    const b = bridge();
    return {
        inShell: !!b,
        supported: supportsCallOverlay(),
        canDraw: canDrawOverlay(),
        accessibility: isAccessibilityConnected(),
        version: b?.getVersion?.() ?? "",
    };
}

// ── React 便捷钩子 ──

/** 订阅原生浮窗事件（组件内用）。handler 变化不会重装监听。 */
export function useShellOverlayEvents(handler: (event: ShellOverlayEvent) => void): void {
    useEffect(() => {
        ensureShellOverlayListener();
        const unsubscribe = subscribeShellOverlayEvents(handler);
        return unsubscribe;
        // handler 走 ref 语义：这里只订阅一次，避免每次渲染重装
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
}

/** 环境与权限状态（进设置页时刷新一次；提供 refresh 供用户授权后手动重查） */
export function useShellOverlayStatus(): [ReturnType<typeof inspectShellOverlay>, () => void] {
    const [status, setStatus] = useState<ReturnType<typeof inspectShellOverlay>>(() => inspectShellOverlay());
    const refresh = () => setStatus(inspectShellOverlay());
    useEffect(() => {
        ensureShellOverlayListener();
        // 从系统设置页返回时（页面重新可见）自动刷新一次权限状态
        const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => document.removeEventListener("visibilitychange", onVisible);
    }, []);
    return [status, refresh];
}
