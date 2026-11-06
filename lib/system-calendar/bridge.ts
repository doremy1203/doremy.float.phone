"use client";

import { isCompatibilityFeatureEnabled } from "../device-compatibility";

// 系统日历 ↔ 安卓壳的原生桥对接层。
//
// 与感知（只读）、设备动作（只写）不同，日历**两个方向都有**，
// 所以这里同时有 read 和 write 两组方法，且权限独立：
//   · 读（READ_CALENDAR）——角色知道「TA 今天有什么安排」；
//   · 写（WRITE_CALENDAR）——角色把纪念日写进系统日历。
// 用户可能只想给其中一个，所以状态分开报、权限分开申请。
//
// 非壳环境或老 APK 一律安全降级，调用方无需分支判断。

import type { SystemCalendarCapabilities, SystemCalendarEvent, SystemCalendarWriteResult } from "./types";

type CalendarBridgeLike = {
  hasCalendarReadPermission?: () => boolean;
  hasCalendarWritePermission?: () => boolean;
  requestCalendarPermission?: (read: boolean, write: boolean) => boolean;
  readCalendarEvents?: (daysAhead: number, daysBack: number) => string;
  insertCalendarEvent?: (
    title: string,
    allDay: boolean,
    year: number,
    month: number,
    day: number,
    startMillis: number,
    endMillis: number,
    description: string,
  ) => string;
  deleteCalendarEvent?: (eventId: number) => string;
  getCalendarCapabilities?: () => string;
};

function bridge(): CalendarBridgeLike | null {
  if (typeof window === "undefined" || !isCompatibilityFeatureEnabled("calendar")) return null;
  const candidate = (window as unknown as { AndroidShell?: CalendarBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供日历桥（老 APK 没有）。 */
export function hasCalendarBridge(): boolean {
  return typeof bridge()?.readCalendarEvents === "function";
}

/** 是否已授予读日历权限。 */
export function hasCalendarReadPermission(): boolean {
  try {
    return bridge()?.hasCalendarReadPermission?.() === true;
  } catch {
    return false;
  }
}

/** 是否已授予写日历权限。 */
export function hasCalendarWritePermission(): boolean {
  try {
    return bridge()?.hasCalendarWritePermission?.() === true;
  } catch {
    return false;
  }
}

/**
 * 申请日历权限。
 *
 * 返回 true 表示「现在已经可用」，false 表示弹出了系统对话框、
 * 结果要稍后由 hasCalendarXxxPermission() 轮询确认——申请是异步的。
 */
export function requestCalendarPermission(read: boolean, write: boolean): boolean {
  try {
    return bridge()?.requestCalendarPermission?.(read, write) === true;
  } catch {
    return false;
  }
}

/**
 * 读系统日历里未来/过去若干天的事件。
 *
 * 未授权、壳不支持、数据异常时一律返回空数组——调用方据此说「读不到」，
 * 而不是拿到一个 undefined 再崩在某个 .map 上。
 */
export function readSystemCalendarEvents(daysAhead: number, daysBack = 0): SystemCalendarEvent[] {
  try {
    const raw = bridge()?.readCalendarEvents?.(daysAhead, daysBack);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is SystemCalendarEvent => (
      !!item && typeof item === "object" && typeof (item as SystemCalendarEvent).title === "string"
    ));
  } catch {
    return [];
  }
}

/** 往系统日历新增一条事件（只新增，不修改不删除已有安排）。 */
export function insertSystemCalendarEvent(params: {
  title: string;
  allDay: boolean;
  year?: number;
  /** 1-12（人类习惯；原生侧会转成 0-11） */
  month?: number;
  day?: number;
  startMillis?: number;
  endMillis?: number;
  description?: string;
}): SystemCalendarWriteResult {
  try {
    const raw = bridge()?.insertCalendarEvent?.(
      params.title,
      params.allDay,
      params.year ?? 0,
      params.month ?? 1,
      params.day ?? 1,
      params.startMillis ?? 0,
      params.endMillis ?? 0,
      params.description ?? "",
    );
    if (raw === undefined) return { ok: false, reason: "当前 App 版本不支持写入日历" };
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && parsed.ok === true) return parsed as unknown as SystemCalendarWriteResult;
    return {
      ok: false,
      reason: typeof parsed?.reason === "string" && parsed.reason ? parsed.reason : "写入日历失败",
      needPermission: typeof parsed?.needPermission === "string" ? parsed.needPermission : undefined,
    };
  } catch {
    return { ok: false, reason: "写入日历失败" };
  }
}

/** 删除一条由角色写入的日程（用户后悔时的清理路径）。 */
export function deleteSystemCalendarEvent(eventId: number): boolean {
  try {
    const raw = bridge()?.deleteCalendarEvent?.(eventId);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { ok?: boolean };
    return parsed?.ok === true;
  } catch {
    return false;
  }
}

/** 日历能力与授权状态。壳不支持时全部报 false。 */
export function readSystemCalendarCapabilities(): SystemCalendarCapabilities {
  try {
    const raw = bridge()?.getCalendarCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SystemCalendarCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
