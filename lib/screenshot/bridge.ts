"use client";

import { isCompatibilityFeatureEnabled } from "../device-compatibility";

// 截屏 ↔ 安卓壳的原生桥对接层。
//
// 与其它桥最大的不同：**它是异步的**。
//   takeScreenshot() 本身是回调式 API，原生不可能同步把几 MB 的 PNG 返回；
//   所以 captureScreenshot() 只负责「发起」，画面稍后经 window 的
//   'shell-call-overlay' 事件（action='screenshot'）推回来。
//   本模块把这条异步链路包装成一个 Promise，调用方不必自己处理事件与超时。
//
// 非壳环境或老 APK 一律安全降级，调用方无需分支判断。

import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";
import type { ScreenshotCapabilities, ScreenshotCaptureResult, ScreenshotDiagnostics } from "./types";

type ScreenshotBridgeLike = {
  getScreenshotCapabilities?: () => string;
  captureScreenshot?: () => string;
  getScreenshotDiagnostics?: () => string;
};

function bridge(): ScreenshotBridgeLike | null {
  if (typeof window === "undefined" || !isCompatibilityFeatureEnabled("screenshot")) return null;
  const candidate = (window as unknown as { AndroidShell?: ScreenshotBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供截屏桥（老 APK 没有）。 */
export function hasScreenshotBridge(): boolean {
  return typeof bridge()?.captureScreenshot === "function";
}

/**
 * 读截屏桥的内部状态（诊断面板用）。壳不支持或读失败都返回 null，
 * 面板据此显示「当前版本不支持」，而不是抓一堆 undefined 去猜。
 */
export function readScreenshotDiagnostics(): ScreenshotDiagnostics | null {
  try {
    const raw = bridge()?.getScreenshotDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScreenshotDiagnostics;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 读截屏能力与状态。壳不支持或读失败时全报 false——
 * 与「有这能力但没授权」是两回事，所以三个字段分开报。
 */
export function readScreenshotCapabilities(): ScreenshotCapabilities {
  try {
    const raw = bridge()?.getScreenshotCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as ScreenshotCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 发起时原生回的那一下：只表示「受理了没」。 */
type CaptureAck = { ok: true } | { ok: false; reason: string };

function parseAck(raw: unknown): CaptureAck {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "截屏调用没有返回结果" };
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; reason?: string };
    if (parsed?.ok === true) return { ok: true };
    return { ok: false, reason: parsed?.reason || "截屏未能发起" };
  } catch {
    return { ok: false, reason: "截屏返回内容无法解析" };
  }
}

/**
 * 截一张当前屏幕。
 *
 * 返回 Promise：成功给 { ok:true, base64, width, height, bytes }，
 * 失败给 { ok:false, reason }。**永远 resolve，不 reject**——
 * 调用方拿到的要么是画面，要么是一句能转述给用户的原因。
 *
 * @param timeoutMs 等原生的上限。默认 8 秒：正常一两秒就回来；
 *                  超时多半是无障碍中途被关或 ROM 卡住，此时必须给失败，
 *                  否则 Promise 永远悬着、界面一直转圈。
 */
export function captureScreenshot(timeoutMs = 8000): Promise<ScreenshotCaptureResult> {
  return new Promise<ScreenshotCaptureResult>((resolve) => {
    if (!isCompatibilityFeatureEnabled("screenshot")) {
      resolve({ ok: false, reason: "截屏接口已在系统设置 → 设备兼容性中停用" });
      return;
    }
    const b = bridge();
    if (!b?.captureScreenshot) {
      resolve({ ok: false, reason: "当前 App 版本不支持截屏，需要更新安卓壳" });
      return;
    }

    let settled = false;
    const cleanup: { timer?: ReturnType<typeof setTimeout>; unsubscribe?: () => void } = {};

    const finish = (result: ScreenshotCaptureResult) => {
      if (settled) return;
      settled = true;
      if (cleanup.timer) clearTimeout(cleanup.timer);
      cleanup.unsubscribe?.();
      resolve(result);
    };

    // 先订阅、再发起：原生回调可能很快，若反过来会漏掉事件。
    ensureShellOverlayListener();
    cleanup.unsubscribe = subscribeShellOverlayEvents((event) => {
      if (event.action !== "screenshot") return;
      if (event.ok === false) {
        finish({ ok: false, reason: event.reason || "截屏失败" });
        return;
      }
      if (typeof event.base64 === "string" && event.base64) {
        finish({
          ok: true,
          base64: event.base64,
          width: typeof event.width === "number" ? event.width : 0,
          height: typeof event.height === "number" ? event.height : 0,
          bytes: typeof event.bytes === "number" ? event.bytes : 0,
        });
      }
    });

    cleanup.timer = setTimeout(() => {
      finish({ ok: false, reason: "截屏超时了，请确认无障碍服务还开着，然后重试" });
    }, Math.max(1000, timeoutMs));

    // 发起。这里同步抛或返回失败都在 finish 之前，settled 保证只结算一次。
    let ack: CaptureAck;
    try {
      ack = parseAck(b.captureScreenshot());
    } catch {
      ack = { ok: false, reason: "截屏调用失败" };
    }
    if (!ack.ok) finish({ ok: false, reason: ack.reason });
  });
}
