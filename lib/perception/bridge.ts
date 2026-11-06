"use client";

import { isCompatibilityFeatureEnabled } from "../device-compatibility";

// 感知系统 ↔ 安卓壳的原生桥对接层。
//
// 与 lib/shell-call-overlay.ts 同一套路：非壳环境一律安全降级为 no-op，
// 老版 APK 没有这些方法时也返回「不可用」而不是抛错，调用方无需分支判断。

import type {
  AppUsageEntry,
  HealthDiagnostics,
  LocationDiagnostics,
  LocationSnapshot,
  PerceptionCapability,
  SleepSnapshot,
} from "./types";

type PerceptionBridgeLike = {
  getPerceptionSnapshot?: () => string;
  getAppLabel?: (packageName: string) => string;
  getPerceptionCapabilities?: () => string;
  hasStepPermission?: () => boolean;
  requestStepPermission?: () => boolean;
  readUsageStats?: (maxEntries: number) => string;
  configureBackgroundPerception?: (json: string) => boolean;
  supportsBackgroundDwellTracking?: () => boolean;
  getLocationCapabilities?: () => string;
  hasLocationPermission?: () => boolean;
  requestLocationPermission?: () => boolean;
  readLocation?: () => string;
  refreshLocation?: () => void;
  getLocationDiagnostics?: () => string;
  getHealthCapabilities?: () => string;
  hasHealthPermission?: () => boolean;
  requestHealthPermission?: () => boolean;
  readSleep?: () => string;
  refreshHealth?: () => void;
  getHealthDiagnostics?: () => string;
  openHealthSettings?: () => boolean;
};

function bridge(): PerceptionBridgeLike | null {
  if (typeof window === "undefined" || !isCompatibilityFeatureEnabled("perception")) return null;
  const candidate = (window as unknown as { AndroidShell?: PerceptionBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供感知桥（老 APK 没有 → 感知功能整体不可用）。 */
export function hasPerceptionBridge(): boolean {
  return typeof bridge()?.getPerceptionSnapshot === "function";
}

/** 壳是否支持「包名 → 应用名」翻译。 */
export function supportsAppLabel(): boolean {
  return typeof bridge()?.getAppLabel === "function";
}

export type DeviceSnapshot = {
  battery: { percent: number; charging: boolean };
  network: { type: string; metered: boolean };
  /** 当天步数；-1 = 原生不支持或未授权（老 APK / 未开活动识别权限） */
  steps: number;
};

/** 取设备快照。失败返回 null（调用方按「本轮跳过」处理）。 */
export function readPerceptionSnapshot(): DeviceSnapshot | null {
  try {
    const raw = bridge()?.getPerceptionSnapshot?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceSnapshot>;
    if (!parsed || typeof parsed !== "object") return null;
    return {
      battery: {
        percent: Number(parsed.battery?.percent ?? -1),
        charging: parsed.battery?.charging === true,
      },
      network: {
        type: String(parsed.network?.type ?? "none"),
        metered: parsed.network?.metered !== false,
      },
      steps: Number.isFinite(Number(parsed.steps)) ? Number(parsed.steps) : -1,
    };
  } catch {
    return null;
  }
}

/** 步数所需的「活动识别」权限是否已授予（老壳不支持该接口时返回 false）。 */
export function hasStepPermission(): boolean {
  try {
    return bridge()?.hasStepPermission?.() === true;
  } catch {
    return false;
  }
}

/**
 * 申请活动识别权限（步数）。
 *
 * 返回 true 表示「现在就可以用了」（已授权或系统不需要），false 表示弹出了系统
 * 对话框、结果要稍后由 hasStepPermission() 轮询确认——申请是异步的，
 * 不能同步拿到结果。老壳没有这个接口时同样返回 false 并提示需更新。
 */
export function requestStepPermission(): boolean {
  try {
    return bridge()?.requestStepPermission?.() === true;
  } catch {
    return false;
  }
}

/** 壳是否提供步数权限申请接口（老 APK 没有）。 */
export function supportsStepPermission(): boolean {
  return typeof bridge()?.requestStepPermission === "function";
}

/** 包名 → 应用显示名。失败返回空串，调用方退回显示包名。 */export function readAppLabel(packageName: string): string {
  try {
    return bridge()?.getAppLabel?.(packageName) ?? "";
  } catch {
    return "";
  }
}

/**
 * 读今天各应用的使用时长，按时长降序。
 *
 * 未授权、壳不支持、读不到都返回空数组——调用方据此说「读不到」，
 * 绝不编造数据，也绝不返回一批 0 分钟的假记录。
 */
export function readUsageStats(maxEntries = 12): AppUsageEntry[] {
  try {
    const raw = bridge()?.readUsageStats?.(maxEntries);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AppUsageEntry => (
      !!item
      && typeof item === "object"
      && typeof (item as AppUsageEntry).package === "string"
      && Number.isFinite((item as AppUsageEntry).minutes)
    ));
  } catch {
    return [];
  }
}

/** 壳是否提供使用统计读取（老 APK 没有）。 */
export function supportsUsageStats(): boolean {
  return typeof bridge()?.readUsageStats === "function";
}

/** 是否有原生后台连续停留计时；老 APK 自动回退网页端实现。 */
export function supportsBackgroundDwellTracking(): boolean {
  try {
    return bridge()?.supportsBackgroundDwellTracking?.() === true
      && typeof bridge()?.configureBackgroundPerception === "function";
  } catch {
    return false;
  }
}

/** 将感知开关与停留阈值同步到原生无障碍服务的持久化配置。 */
export function configureBackgroundPerception(config: {
  enabled: boolean;
  thresholdMinutes: number;
  foregroundAppEnabled: boolean;
  usageStatsEnabled: boolean;
  usageSignalMinutes: number;
  usageOverrides: Array<{ pattern: string; minutes: number }>;
  ruleFilters: Array<{ matchType: string; payloadFilter?: string }>;
  targetPackage?: string;
  targetFilter?: string;
}): boolean {
  try {
    return bridge()?.configureBackgroundPerception?.(JSON.stringify(config)) === true;
  } catch {
    return false;
  }
}

/** 位置桥上报的能力与授权状态（老壳/浏览器返回空对象）。 */
export type LocationCapabilities = {
  /** 壳能不能读位置（这个版本都行） */
  location?: boolean;
  /** 定位权限给没给 */
  locationGranted?: boolean;
  /** 是否拿到了精确档（false 但 locationGranted 为 true = 只有粗略定位） */
  locationFineGranted?: boolean;
  /** 系统定位总开关有没有开着 */
  locationServiceOn?: boolean;
  /** 原生手里有没有新鲜缓存 */
  locationCached?: boolean;
};

export function readLocationCapabilities(): LocationCapabilities {
  try {
    const raw = bridge()?.getLocationCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LocationCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 壳是否提供位置读取（老 APK 没有）。 */
export function supportsLocation(): boolean {
  return typeof bridge()?.readLocation === "function";
}

/** 定位权限是否已授予（老壳不支持该接口时返回 false）。 */
export function hasLocationPermission(): boolean {
  try {
    return bridge()?.hasLocationPermission?.() === true;
  } catch {
    return false;
  }
}

/**
 * 申请定位权限。
 *
 * 返回 true 表示「现在就可以用了」（已授权），false 表示弹出了系统对话框、
 * 结果要稍后由 hasLocationPermission() 轮询确认——申请是异步的。
 * 老壳没有这个接口时同样返回 false 并提示需更新。
 */
export function requestLocationPermission(): boolean {
  try {
    return bridge()?.requestLocationPermission?.() === true;
  } catch {
    return false;
  }
}

/** 壳是否提供定位权限申请接口（老 APK 没有）。 */
export function supportsLocationPermission(): boolean {
  return typeof bridge()?.requestLocationPermission === "function";
}

/**
 * 读当前位置。
 *
 * 未授权、定位开关关着、壳不支持、读不到，一律返回 null——调用方据此
 * 说「读不到」，绝不返回一个假坐标（角色会当真，比不说更糟）。
 */
export function readLocation(): LocationSnapshot | null {
  try {
    const raw = bridge()?.readLocation?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LocationSnapshot>;
    const lat = Number(parsed?.lat);
    const lon = Number(parsed?.lon);
    // 0,0 是几内亚湾海面，不是用户的位置——原生的空对象不该被当成坐标
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
    return {
      lat,
      lon,
      accuracy: Number.isFinite(Number(parsed?.accuracy)) ? Number(parsed?.accuracy) : 0,
      place: typeof parsed?.place === "string" ? parsed.place : "",
    };
  } catch {
    return null;
  }
}

/** 请壳主动取一次实时位置（一次性，不是持续追踪）。 */
export function refreshLocation(): void {
  try {
    bridge()?.refreshLocation?.();
  } catch {
    /* 忽略 */
  }
}

/** 健康桥上报的能力与授权状态（老壳/浏览器返回空对象）。 */
export type HealthCapabilities = {
  /** 壳接没接健康数据（这一版接了） */
  health?: boolean;
  /** Health Connect 在这台设备上能不能用（没装就是 false） */
  healthAvailable?: boolean;
  /** 睡眠读取权限给没给 */
  healthGranted?: boolean;
  /** 原始的 SDK 状态码，排障用 */
  healthSdkStatus?: number;
};

export function readHealthCapabilities(): HealthCapabilities {
  try {
    const raw = bridge()?.getHealthCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HealthCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 壳是否提供健康数据读取（老 APK 没有）。 */
export function supportsHealth(): boolean {
  return typeof bridge()?.readSleep === "function";
}

/** 睡眠读取权限是否已授予。 */
export function hasHealthPermission(): boolean {
  try {
    return bridge()?.hasHealthPermission?.() === true;
  } catch {
    return false;
  }
}

/**
 * 申请睡眠读取权限。
 *
 * 返回 true 表示「现在就能读」，false 表示弹出了授权页、结果要稍后由
 * hasHealthPermission() 轮询确认——申请是异步的，不能同步拿到结果。
 * 未安装 Health Connect 时同样返回 false，由调用方引导去安装。
 */
export function requestHealthPermission(): boolean {
  try {
    return bridge()?.requestHealthPermission?.() === true;
  } catch {
    return false;
  }
}

/** 壳是否提供健康权限申请接口（老 APK 没有）。 */
export function supportsHealthPermission(): boolean {
  return typeof bridge()?.requestHealthPermission === "function";
}

/**
 * 读最近一觉。
 *
 * 未授权、Health Connect 不可用、没数据，一律返回 null——调用方据此说
 * 「读不到」，绝不编一个「昨晚睡了 8 小时」：这种假数据角色会当真。
 */
export function readSleep(): SleepSnapshot | null {
  try {
    const raw = bridge()?.readSleep?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const minutes = Number(parsed?.sleepMinutes);
    const endAt = Number(parsed?.sleepEndAt);
    const startAt = Number(parsed?.sleepStartAt);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    if (!Number.isFinite(endAt) || endAt <= 0) return null;
    return {
      minutes,
      startAt: Number.isFinite(startAt) ? startAt : 0,
      endAt,
    };
  } catch {
    return null;
  }
}

/** 请壳在后台取一次睡眠数据（结果落缓存，随后的 readSleep 能读到）。 */
export function refreshHealth(): void {
  try {
    bridge()?.refreshHealth?.();
  } catch {
    /* 忽略 */
  }
}

/** 跳 Health Connect 设置页。返回是否成功（没装时退回应用市场页）。 */
export function openHealthSettings(): boolean {
  try {
    return bridge()?.openHealthSettings?.() === true;
  } catch {
    return false;
  }
}

/** 读健康桥的内部状态（诊断面板用）。读不到返回 null。 */
export function readHealthDiagnostics(): HealthDiagnostics | null {
  try {
    const raw = bridge()?.getHealthDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HealthDiagnostics;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 读位置桥的内部状态（诊断面板用）。读不到返回 null。 */
export function readLocationDiagnostics(): LocationDiagnostics | null {
  try {
    const raw = bridge()?.getLocationDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocationDiagnostics;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 壳如实上报的可用能力表。
 *
 * 这是这次审计的直接产物：以前 Manifest 声明了一堆权限，底下什么都没有，
 * 用户完全看不出来。现在原生必须逐项回答「我真的支持吗」，
 * 设置页据此显示「已接通 / 不支持」，不再让人对着没反应的开关猜。
 */
/** 壳上报的能力表：能力标识 → 是否支持；另有 usageStatsGranted 等授权态字段。 */
export type NativePerceptionCapabilities = Partial<Record<PerceptionCapability, boolean>> & {
  /** 是否已授予「使用情况访问」权限（与 usageStats 的「支不支持」是两回事） */
  usageStatsGranted?: boolean;
  /** 是否已授予定位权限（与 location 的「支不支持」是两回事） */
  locationGranted?: boolean;
  /** 系统定位总开关有没有开着（权限给了但开关关着同样读不到） */
  locationServiceOn?: boolean;
};

export function readNativeCapabilities(): NativePerceptionCapabilities {
  try {
    const raw = bridge()?.getPerceptionCapabilities?.();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as NativePerceptionCapabilities;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
