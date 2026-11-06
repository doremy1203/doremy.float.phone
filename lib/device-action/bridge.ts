"use client";

import { isCompatibilityFeatureEnabled } from "../device-compatibility";

// 设备动作 ↔ 安卓壳的原生桥对接层。
//
// 与 lib/perception/bridge.ts 同一套路：非壳环境一律安全降级为 no-op，
// 老版 APK 没有这些方法时也返回「不可用」而不是抛错，调用方无需分支判断。
//
// 与感知桥的分工：感知只「读」，这里只「写」。每个动作都是一次性、
// 立即可见、可撤销的——刻意不做任何持续或隐蔽行为。

import type { DeviceActionCapabilities, DeviceActionResult } from "./types";

type DeviceActionBridgeLike = {
  setTorch?: (on: boolean) => string;
  isTorchOn?: () => boolean;
  setVolume?: (stream: string, action: string, level: number) => string;
  setBrightness?: (level: number) => string;
  setDnd?: (on: boolean) => string;
  openApp?: (packageName: string) => string;
  findPackageByLabel?: (label: string) => string;
  setAlarm?: (hour: number, minute: number, message: string) => string;
  setTimer?: (seconds: number, message: string) => string;
  mediaControl?: (action: string) => string;
  openWebUrl?: (url: string) => string;
  hasUsageStatsAccess?: () => boolean;
  getDeviceActionCapabilities?: () => string;
  openSystemSettings?: (which: string) => boolean;
};

function bridge(): DeviceActionBridgeLike | null {
  if (typeof window === "undefined" || !isCompatibilityFeatureEnabled("deviceActions")) return null;
  const candidate = (window as unknown as { AndroidShell?: DeviceActionBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供设备动作桥（老 APK 没有 → 设备动作整体不可用）。 */
export function hasDeviceActionBridge(): boolean {
  return typeof bridge()?.setTorch === "function";
}

/** 把原生返回的 JSON 字符串解析成结果对象；解析失败一律算失败，不假装成功。 */
function parseResult(raw: unknown, fallbackReason: string): DeviceActionResult {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: fallbackReason };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && parsed.ok === true) {
      return { ...parsed, ok: true } as DeviceActionResult;
    }
    return {
      ok: false,
      reason: typeof parsed?.reason === "string" && parsed.reason ? parsed.reason : fallbackReason,
      needPermission: typeof parsed?.needPermission === "string" ? parsed.needPermission : undefined,
    };
  } catch {
    return { ok: false, reason: fallbackReason };
  }
}

/** 开关手电筒。 */
export function setTorch(on: boolean): DeviceActionResult {
  try {
    const raw = bridge()?.setTorch?.(on);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持控制手电筒" };
    return parseResult(raw, "手电筒未能切换");
  } catch {
    return { ok: false, reason: "手电筒调用失败" };
  }
}

/** 手电筒当前状态（仅本进程内的记忆）。 */
export function isTorchOn(): boolean {
  try {
    return bridge()?.isTorchOn?.() === true;
  } catch {
    return false;
  }
}

/**
 * 调音量。
 *
 * @param stream media / ring / alarm / notification
 * @param action up / down / set / mute
 * @param level 仅 action=set 时用，0-100
 */
export function setVolume(stream: string, action: string, level = 0): DeviceActionResult {
  try {
    const raw = bridge()?.setVolume?.(stream, action, level);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持调节音量" };
    return parseResult(raw, "音量未能调节");
  } catch {
    return { ok: false, reason: "音量调用失败" };
  }
}

/** 设屏幕亮度（需要「修改系统设置」权限）。 */
export function setBrightness(level: number): DeviceActionResult {
  try {
    const raw = bridge()?.setBrightness?.(level);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持调节亮度" };
    return parseResult(raw, "亮度未能调节");
  } catch {
    return { ok: false, reason: "亮度调用失败" };
  }
}

/** 开关勿扰模式（需要勿扰访问权限）。 */
export function setDnd(on: boolean): DeviceActionResult {
  try {
    const raw = bridge()?.setDnd?.(on);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持勿扰模式" };
    return parseResult(raw, "勿扰模式未能切换");
  } catch {
    return { ok: false, reason: "勿扰模式调用失败" };
  }
}

/** 按包名打开另一个应用。 */
export function openApp(packageName: string): DeviceActionResult {
  try {
    const raw = bridge()?.openApp?.(packageName);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持打开应用" };
    return parseResult(raw, "应用未能打开");
  } catch {
    return { ok: false, reason: "打开应用失败" };
  }
}

/** 设闹钟（系统时钟 App 会打开让用户确认）。 */
export function setAlarm(hour: number, minute: number, message = ""): DeviceActionResult {
  try {
    const raw = bridge()?.setAlarm?.(hour, minute, message);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持设闹钟" };
    return parseResult(raw, "闹钟未能设置");
  } catch {
    return { ok: false, reason: "设置闹钟失败" };
  }
}

/** 设倒计时（秒）。 */
export function setTimer(seconds: number, message = ""): DeviceActionResult {
  try {
    const raw = bridge()?.setTimer?.(seconds, message);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持设倒计时" };
    return parseResult(raw, "倒计时未能设置");
  } catch {
    return { ok: false, reason: "设置倒计时失败" };
  }
}

/** 媒体播放控制：play / pause / toggle / next / prev / stop。 */
export function mediaControl(action: string): DeviceActionResult {
  try {
    const raw = bridge()?.mediaControl?.(action);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持媒体控制" };
    return parseResult(raw, "媒体控制失败");
  } catch {
    return { ok: false, reason: "媒体控制调用失败" };
  }
}

/** 用系统浏览器打开链接（只放行 http/https）。 */
export function openUrl(url: string): DeviceActionResult {
  try {
    const raw = bridge()?.openWebUrl?.(url);
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持打开网页" };
    return parseResult(raw, "链接未能打开");
  } catch {
    return { ok: false, reason: "打开链接失败" };
  }
}

/** 是否已授予「使用情况访问」权限。 */
export function hasUsageStatsAccess(): boolean {
  try {
    return bridge()?.hasUsageStatsAccess?.() === true;
  } catch {
    return false;
  }
}

/**
 * 按显示名找包名。
 *
 * 角色多半说「打开微信」而不知道 com.tencent.mm，这是给它的兜底路径。
 * 找不到返回空串——调用方要如实说找不到，绝不猜一个包名去启动。
 */
export function findPackageByLabel(label: string): string {
  try {
    return bridge()?.findPackageByLabel?.(label) ?? "";
  } catch {
    return "";
  }
}

/** 本机支持哪些设备动作（含授权状态）。壳不支持时全部报 false。 */
export function readDeviceActionCapabilities(): DeviceActionCapabilities {
  try {
    const raw = bridge()?.getDeviceActionCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DeviceActionCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 跳系统授权页：write_settings / dnd / accessibility / battery / app_details。 */
export function openSystemSettings(which: string): boolean {
  try {
    return bridge()?.openSystemSettings?.(which) === true;
  } catch {
    return false;
  }
}
