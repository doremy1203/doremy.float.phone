// 专注倒计时桌面小组件的样式：独立于角色留言小组件（那边是整段 HTML 模板，
// 这边要保住原生 Chronometer 的秒级走表，所以样式是「字段 + 实时预览」形态，
// 由壳侧 RemoteViews 动态上色，而不是离屏截图）。
//
// 存储：kv（AiPhoneKvDB）独立键，跟会话状态互不影响——
// 壳侧 FocusWidgetProvider 把 style 存在自己的 prefs 里，
// 网页只在样式变化时推一次 styleOnly 载荷，专注会话状态照常由 App 推。

import { kvGet, kvSet } from "@/lib/kv-db";

export type FocusWidgetStyle = {
    /** 背景色（hex，不含透明度） */
    bg: string;
    /** 背景不透明度 0~100 */
    bgAlpha: number;
    /** 主文字色（倒计时数字、任务行） */
    textColor: string;
    /** 次要文字不透明度 0~100（标题行 / TA 行用它套在 textColor 上） */
    dimAlpha: number;
    /** 圆角档位：8 / 16 / 24 dp */
    radius: number;
    showTask: boolean;
    showTa: boolean;
};

export const DEFAULT_FOCUS_WIDGET_STYLE: FocusWidgetStyle = {
    bg: "#1B2030",
    bgAlpha: 92,
    textColor: "#E8ECF5",
    dimAlpha: 55,
    radius: 18,
    showTask: true,
    showTa: true,
};

const KEY = "ai_phone_focus_widget_style_v1";

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeHex(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    const v = value.trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;
}

export function normalizeFocusWidgetStyle(raw: unknown): FocusWidgetStyle {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<FocusWidgetStyle>;
    return {
        bg: normalizeHex(r.bg, DEFAULT_FOCUS_WIDGET_STYLE.bg),
        bgAlpha: clamp(Number(r.bgAlpha), 0, 100) || DEFAULT_FOCUS_WIDGET_STYLE.bgAlpha,
        textColor: normalizeHex(r.textColor, DEFAULT_FOCUS_WIDGET_STYLE.textColor),
        dimAlpha: clamp(Number(r.dimAlpha), 0, 100),
        radius: clamp(Number(r.radius), 8, 24) || DEFAULT_FOCUS_WIDGET_STYLE.radius,
        showTask: typeof r.showTask === "boolean" ? r.showTask : true,
        showTa: typeof r.showTa === "boolean" ? r.showTa : true,
    };
}

export function loadFocusWidgetStyle(): FocusWidgetStyle {
    if (typeof window === "undefined") return { ...DEFAULT_FOCUS_WIDGET_STYLE };
    try {
        const raw = kvGet(KEY);
        if (!raw) return { ...DEFAULT_FOCUS_WIDGET_STYLE };
        return normalizeFocusWidgetStyle(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_FOCUS_WIDGET_STYLE };
    }
}

export function saveFocusWidgetStyle(style: FocusWidgetStyle): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(KEY, JSON.stringify(normalizeFocusWidgetStyle(style)));
    } catch { }
}
