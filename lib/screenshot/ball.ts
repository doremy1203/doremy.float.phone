"use client";

// 截屏悬浮球 ↔ 安卓壳的桥。
//
// 与查岗的区别只有一个：**谁发起的**。
//   查岗 = 角色到点想看你 → 有明确的 characterId；
//   悬浮球 = 你自己点一下 → 没有 characterId，「发给谁」等同意后取最近会话。
// 两者点击后都走 CheckInService 那套预览与审批，所以这里只做「拉起/收起」两件事。

import type { ScreenshotBallCapabilities } from "./types";

type BallBridgeLike = {
  getScreenshotBallCapabilities?: () => string;
  prepareScreenshotBall?: () => boolean;
  stopScreenshotBall?: () => void;
  setScreenshotBallStyle?: (json: string) => boolean;
  getScreenshotBallStyle?: () => string;
};

function bridge(): BallBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: BallBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供悬浮球（老 APK 没有）。 */
export function hasScreenshotBallBridge(): boolean {
  return typeof bridge()?.prepareScreenshotBall === "function";
}

/** 读悬浮球能力与运行状态。 */
export function readScreenshotBallCapabilities(): ScreenshotBallCapabilities {
  try {
    const raw = bridge()?.getScreenshotBallCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScreenshotBallCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 拉起悬浮球。返回 false 多半是没给浮窗权限——调用方据此引导授权。
 * 必须由网页在 App 前台时调用（Android 12+ 禁止后台启动前台服务）。
 */
export function prepareScreenshotBall(): boolean {
  try {
    return bridge()?.prepareScreenshotBall?.() === true;
  } catch {
    return false;
  }
}

/** 收掉悬浮球。 */
export function stopScreenshotBall(): void {
  try {
    bridge()?.stopScreenshotBall?.();
  } catch {
    /* 忽略 */
  }
}

/** 壳是否支持自定义悬浮球外观（老 APK 没有）。 */
export function supportsBallStyle(): boolean {
  return typeof bridge()?.setScreenshotBallStyle === "function";
}

/** 悬浮球外观。 */
export type BallStyle = {
  /** 球上的文字，最多 4 字符；空串 = 不显示文字 */
  text: string;
  /** 主色，形如 #RRGGBB 或 #AARRGGBB */
  color: string;
  /** 直径（dp），32~96 */
  diameter: number;
  /**
   * 自定义图片（base64 PNG，不含 data: 前缀）。
   *
   * 空串 = 清除图片、回到纯色圆点；undefined = 这次不改图片，
   * 保留原样——两者必须区分开，否则「只改颜色」会把用户上传的图弄丢。
   */
  image?: string;
};

/**
 * 把外观下发给原生并即时生效（球正显示着会当场重画）。
 *
 * @returns 原生是否收下；老壳返回 false（此时球仍是默认样子，不是错误）
 */
export function setScreenshotBallStyle(style: BallStyle): boolean {
  try {
    return bridge()?.setScreenshotBallStyle?.(JSON.stringify(style)) === true;
  } catch {
    return false;
  }
}

/** 读原生当前的球外观（设置页回显用）。读不到返回 null。 */
export function readScreenshotBallStyle(): BallStyle | null {
  try {
    const raw = bridge()?.getScreenshotBallStyle?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BallStyle>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      color: typeof parsed.color === "string" ? parsed.color : "",
      diameter: Number.isFinite(Number(parsed.diameter)) ? Number(parsed.diameter) : 50,
    };
  } catch {
    return null;
  }
}

/** 原生当前的球是否用了自定义图片。 */
export function readBallHasImage(): boolean {
  try {
    const raw = bridge()?.getScreenshotBallStyle?.();
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { hasImage?: boolean };
    return parsed?.hasImage === true;
  } catch {
    return false;
  }
}
