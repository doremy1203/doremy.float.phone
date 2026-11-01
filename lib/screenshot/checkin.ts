"use client";

// 查岗 ↔ 安卓壳原生浮层的对接层。
//
// 与截屏桥的区别：截屏桥是「截了直接回网页」，查岗是**三段式**——
//   ① 网页请求查岗 → ② 原生截屏并弹浮层给用户过目 → ③ 用户决定后才回传结果。
// 中间那段完全在原生，网页不参与，也就拿不到「用户看到的那张图」——
// 这正是隐私设计的关键：**没同意之前，图根本不会到网页**。
//
// 所以这里的 requestCheckIn 返回 Promise，等原生把用户的选择回推过来。

import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";
import type { CheckInCapabilities, CheckInDiagnostics, CheckInOutcome } from "./types";

type CheckInBridgeLike = {
  getCheckInCapabilities?: () => string;
  prepareCheckIn?: () => boolean;
  stopCheckIn?: () => void;
  requestCheckIn?: (characterId: string, name: string, avatar: string) => void;
  getCheckInDiagnostics?: () => string;
  consumePendingUserShot?: () => string;
  setScreenshotShareTargets?: (json: string) => boolean;
  getScreenshotShareTargets?: () => string;
  /** 查岗 / 截屏确认浮层的配色（老 APK 没有） */
  getCheckInTheme?: () => string;
  setCheckInTheme?: (json: string) => boolean;
  scheduleNativeCheckIn?: (json: string) => boolean;
  cancelNativeCheckIn?: () => void;
  consumePendingCheckIn?: () => string;
  hasPendingCheckIn?: () => boolean;
  getNativeCheckInDiagnostics?: () => string;
  notifyCheckInUnavailable?: (characterName: string) => void;
};

function bridge(): CheckInBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: CheckInBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/**
 * 将网页算出的下一次触发时间交给原生闹钟。闹钟只通知，不会后台截屏。
 * 返回 false 表示当前是浏览器或旧版 APK，没有原生调度能力。
 */
export function scheduleNativeCheckIn(payload: {
  characterId: string;
  name: string;
  dueAt: number;
  configKey?: string;
}): boolean {
  try {
    return bridge()?.scheduleNativeCheckIn?.(JSON.stringify(payload)) === true;
  } catch {
    return false;
  }
}

/** 没有任何角色启用查岗时取消原生闹钟。 */
export function cancelNativeCheckIn(): void {
  try { bridge()?.cancelNativeCheckIn?.(); } catch { /* 忽略 */ }
}

/** 原生闹钟状态：只返回计划时间与队列状态，不含截图内容。 */
export type NativeCheckInDiagnostics = {
  scheduled: boolean;
  characterName: string;
  characterId: string;
  configKey: string;
  dueAt: number;
  pending: boolean;
  opened: boolean;
  accessibilityConnected: boolean;
  accessibilityEnabledInSettings: boolean;
  notificationsEnabled: boolean;
  ignoringBatteryOptimizations: boolean;
};

export function readNativeCheckInDiagnostics(): NativeCheckInDiagnostics | null {
  try {
    const raw = bridge()?.getNativeCheckInDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NativeCheckInDiagnostics>;
    return {
      scheduled: parsed.scheduled === true,
      characterName: typeof parsed.characterName === "string" ? parsed.characterName : "",
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      configKey: typeof parsed.configKey === "string" ? parsed.configKey : "",
      dueAt: Number(parsed.dueAt) || 0,
      pending: parsed.pending === true,
      opened: parsed.opened === true,
      accessibilityConnected: parsed.accessibilityConnected === true,
      accessibilityEnabledInSettings: parsed.accessibilityEnabledInSettings === true,
      notificationsEnabled: parsed.notificationsEnabled === true,
      ignoringBatteryOptimizations: parsed.ignoringBatteryOptimizations === true,
    };
  } catch {
    return null;
  }
}

/** 通知点击后是否有待处理查岗；用于跳过启动页，直达处理流程。 */
export function hasPendingNativeCheckIn(): boolean {
  try { return bridge()?.hasPendingCheckIn?.() === true; } catch { return false; }
}

/** 用户点击原生查岗提醒后，读取待处理角色 id。读取即清空。 */
export function consumePendingNativeCheckIn(): string | null {
  try {
    const raw = bridge()?.consumePendingCheckIn?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { characterId?: unknown };
    return typeof parsed.characterId === "string" && parsed.characterId.trim()
      ? parsed.characterId.trim()
      : null;
  } catch {
    return null;
  }
}

/** 无障碍实例断连时显示 Android 原生修复通知（浏览器/旧壳自动忽略）。 */
export function notifyCheckInUnavailable(characterName: string): void {
  try { bridge()?.notifyCheckInUnavailable?.(characterName); } catch { /* 通知失败不影响主流程 */ }
}

/** 壳是否提供查岗浮层（老 APK 没有）。 */
export function hasCheckInBridge(): boolean {
  return typeof bridge()?.requestCheckIn === "function";
}

/** 读查岗能力与状态（系统支持 / 无障碍 / 浮窗权限）。 */
export function readCheckInCapabilities(): CheckInCapabilities {
  try {
    const raw = bridge()?.getCheckInCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as CheckInCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 读走「用户主动截屏（悬浮球）」的结果。
 *
 * 返回 null 表示没有待取的结果。壳不支持时同样返回 null——
 * 老 APK 上没有悬浮球，这个入口是空的，不是错误。
 */
export function consumePendingUserShot(): CheckInOutcome | null {
  try {
    const raw = bridge()?.consumePendingUserShot?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { accepted?: boolean; base64?: string; width?: number; height?: number; bytes?: number; reply?: string; reason?: string; characterId?: string };
    const reply = typeof parsed?.reply === "string" && parsed.reply.trim() ? parsed.reply.trim() : undefined;
    // 目标角色：浮层里当场选的那个（或者设了默认角色时的默认值）。
    // 老壳不带这个字段 → undefined，调用方退回「最近聊过的私聊会话」。
    const characterId = typeof parsed?.characterId === "string" && parsed.characterId.trim()
      ? parsed.characterId.trim()
      : undefined;
    if (parsed?.accepted === true && typeof parsed.base64 === "string" && parsed.base64) {
      return {
        accepted: true,
        base64: parsed.base64,
        width: typeof parsed.width === "number" ? parsed.width : 0,
        height: typeof parsed.height === "number" ? parsed.height : 0,
        bytes: typeof parsed.bytes === "number" ? parsed.bytes : undefined,
        reply,
        characterId,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 壳是否提供「分享目标清单」接口（老 APK 没有）。 */
export function supportsShareTargets(): boolean {
  return typeof bridge()?.setScreenshotShareTargets === "function";
}

/**
 * 把「可分享角色清单 + 默认角色」交给原生保管。
 *
 * 为什么必须提前推、而不是浮层弹出时现取：点球的是原生，那一刻网页
 * 十有八九已被系统回收，现取只会拿到空清单。推过去原生存着（还落了
 * SharedPreferences，服务被系统重启也在），浮层直接读本地。
 *
 * @returns 原生是否收下了；老壳返回 false（此时仍走「最近会话」老路）
 */
export function pushScreenshotShareTargets(
  targets: Array<{ id: string; name: string }>,
  defaultId: string,
): boolean {
  try {
    return bridge()?.setScreenshotShareTargets?.(
      JSON.stringify({ targets, defaultId }),
    ) === true;
  } catch {
    return false;
  }
}

/** 读原生手上的分享目标状态（诊断面板用）。读不到返回 null。 */
export function readScreenshotShareTargets(): import("./types").ScreenshotShareTargetState | null {
  try {
    const raw = bridge()?.getScreenshotShareTargets?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<import("./types").ScreenshotShareTargetState>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      count: Number.isFinite(Number(parsed.count)) ? Number(parsed.count) : 0,
      defaultId: typeof parsed.defaultId === "string" ? parsed.defaultId : "",
      defaultName: typeof parsed.defaultName === "string" ? parsed.defaultName : "",
      lastTargetName: typeof parsed.lastTargetName === "string" ? parsed.lastTargetName : "",
      lastTargetReason: typeof parsed.lastTargetReason === "string" ? parsed.lastTargetReason : "",
    };
  } catch {
    return null;
  }
}

/** 读查岗浮层的内部状态（诊断面板用）。读不到返回 null。 */
export function readCheckInDiagnostics(): CheckInDiagnostics | null {
  try {
    const raw = bridge()?.getCheckInDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CheckInDiagnostics;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 预热查岗服务。用户开启任一角色的查岗时（App 在前台）调用一次。
 * 返回是否成功发起；false 多半是没给浮窗权限。
 */
export function prepareCheckInService(): boolean {
  try {
    return bridge()?.prepareCheckIn?.() === true;
  } catch {
    return false;
  }
}

/** 收掉查岗服务（所有角色的查岗都关了时调用）。 */
export function stopCheckInService(): void {
  try {
    bridge()?.stopCheckIn?.();
  } catch {
    /* 忽略 */
  }
}

/**
 * 请求一次查岗：截当前屏并弹浮层，等用户决定。
 *
 * 返回：
 *   { accepted: true, base64, width, height } —— 用户同意，可以发给角色
 *   { accepted: false, reason }               —— 用户拒绝 / 超时 / 截屏失败
 *
 * **永远 resolve，不 reject**：调用方要么拿到图，要么拿到一句能转述的原因。
 *
 * @param timeoutMs 等用户决定的时长。要比原生自己的自动关闭（90 秒）长一点，
 *                  让原生先收场；这里只是兜底，防止事件没送到时 Promise 永远悬着。
 */
export function requestCheckIn(
  characterId: string,
  name: string,
  avatar: string,
  timeoutMs = 100_000,
): Promise<CheckInOutcome> {
  return new Promise<CheckInOutcome>((resolve) => {
    const b = bridge();
    if (!b?.requestCheckIn) {
      resolve({ accepted: false, reason: "当前 App 版本不支持查岗，需要更新安卓壳" });
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;

    // 用户随口说的那句话（同意/拒绝都可能有），统一在下面几处带进结果里。
    const finish = (result: CheckInOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsubscribe?.();
      resolve(result);
    };

    // 先订阅、再请求：浮层若很快出结果，反过来会漏掉事件。
    ensureShellOverlayListener();
    unsubscribe = subscribeShellOverlayEvents((event) => {
      if (event.action !== "checkIn") return;
      // 同一时刻可能只有一次查岗，但仍按 characterId 校验，避免张冠李戴
      if (event.characterId && event.characterId !== characterId) return;
      const reply = typeof event.reply === "string" && event.reply.trim() ? event.reply.trim() : undefined;
      if (event.accepted === true && typeof event.base64 === "string" && event.base64) {
        finish({
          accepted: true,
          base64: event.base64,
          width: typeof event.width === "number" ? event.width : 0,
          height: typeof event.height === "number" ? event.height : 0,
          reply,
        });
        return;
      }
      finish({ accepted: false, reason: event.reason || "user_rejected", reply });
    });

    timer = setTimeout(() => {
      finish({ accepted: false, reason: "timeout" });
    }, Math.max(1000, timeoutMs));

    try {
      b.requestCheckIn(characterId, name, avatar || "");
    } catch {
      finish({ accepted: false, reason: "查岗请求失败" });
    }
  });
}
