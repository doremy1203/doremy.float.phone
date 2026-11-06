"use client";

// 截屏的执行入口：截一张 → 存进媒体库 → 记一条 → 发通知。
//
// 与设备动作的 engine 同一套路：这里是**唯一的决策点**。
// 门控（任一不过就不截，且都给出明确原因）：
//   ① 总开关（设置 → 看一眼我的屏幕）
//   ② 壳支不支持
//   ③ 无障碍开没开（截屏的前提）
//
// 设计原则：**不静默、不谎报**。
//   · 用户必须知道「刚才截了一张」——所以默认发一条系统通知；
//   · 截失败就把原生的原因如实带出来，绝不返回一张空白图。

import { deleteMediaRef, storeMediaBase64 } from "../media-cache-storage";
import { captureScreenshot, hasScreenshotBridge, readScreenshotCapabilities } from "./bridge";
import { loadScreenshotConfig, loadScreenshotRecords, saveScreenshotRecords } from "./config";
import type { ScreenshotCapabilities, ScreenshotRecord } from "./types";
import { sendShellNotification } from "../shell-notify";

/** 一次截屏的结论。ok=false 时 reason 一定是给人看的整句。 */
export type ScreenshotOutcome =
  | { ok: true; record: ScreenshotRecord }
  | { ok: false; reason: string };

/** 门控检查结果，设置面板与角色工具共用。 */
export function checkScreenshotAvailability(): {
  configEnabled: boolean;
  bridgeAvailable: boolean;
  supported: boolean;
  accessibilityOn: boolean;
  available: boolean;
} {
  const config = loadScreenshotConfig();
  const caps = readScreenshotCapabilities();
  const bridgeAvailable = hasScreenshotBridge();
  const supported = caps.supported === true;
  const accessibilityOn = caps.accessibilityOn === true;
  return {
    configEnabled: config.enabled,
    bridgeAvailable,
    supported,
    accessibilityOn,
    available: config.enabled && bridgeAvailable && supported && accessibilityOn,
  };
}

/** 截屏能力快照（含授权态），给设置面板显示三态。 */
export function readScreenshotStatus(): ScreenshotCapabilities & { bridgeAvailable: boolean } {
  return { ...readScreenshotCapabilities(), bridgeAvailable: hasScreenshotBridge() };
}

/**
 * 截一张并落库。
 *
 * @param options.silent 为 true 时不发通知（设置页的「测试截屏」用——
 *        用户正盯着屏幕看结果，再弹一条通知纯属打扰）。
 */
export async function captureAndStoreScreenshot(options?: { silent?: boolean }): Promise<ScreenshotOutcome> {
  const config = loadScreenshotConfig();
  if (!config.enabled) {
    return { ok: false, reason: "还没有开启截屏（设置 → 看一眼我的屏幕）" };
  }
  if (!hasScreenshotBridge()) {
    return { ok: false, reason: "当前 App 版本不支持截屏，需要更新安卓壳" };
  }
  const caps = readScreenshotCapabilities();
  if (caps.supported !== true) {
    return { ok: false, reason: "系统版本太低，截屏需要 Android 11 及以上" };
  }
  if (caps.accessibilityOn !== true) {
    return { ok: false, reason: "无障碍服务没有开启，截屏无法进行" };
  }

  const captured = await captureScreenshot();
  if (!captured.ok) return { ok: false, reason: captured.reason };

  // 存进媒体库：与「粘贴 base64 图片」走同一条链路，聊天里能直接当图片用。
  const record = await storeScreenshotRecord(captured);
  if (!record) return { ok: false, reason: "截屏已拿到，但保存图片失败" };

  if (!options?.silent && config.notifyOnCapture) {
    notifyScreenshot(record);
  }

  return { ok: true, record };
}

/**
 * 把一张已经拿到的画面存进媒体库并记一条记录。
 *
 * 抽出来是因为有两条来源：`captureAndStoreScreenshot` 是网页自己发起的截屏，
 * 悬浮球那条路（见 checkin-engine 的 deliverUserShot）则是原生把图回传过来——
 * 两者都要「存图 + 记一条」，不该各写一份。
 *
 * 返回 null 表示图没能存进媒体库（调用方据此如实报失败，不假装发成功）。
 */
async function storeScreenshotRecord(captured: {
  base64: string;
  width: number;
  height: number;
  /** 原图字节数。老壳不回传（或回传 0）时按 base64 长度估算——它只用于列表里
   *  显示「多大」，为它把整张图算成「0 KB」比估算更失真。 */
  bytes?: number;
}): Promise<ScreenshotRecord | null> {
  let ref: string;
  try {
    const stored = await storeMediaBase64(captured.base64, "image/png");
    ref = stored.ref;
  } catch {
    return null;
  }

  const record: ScreenshotRecord = {
    id: `shot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ref,
    width: captured.width,
    height: captured.height,
    bytes: captured.bytes && captured.bytes > 0
      ? captured.bytes
      // base64 每 4 个字符编 3 字节，去掉换行等空白后估算
      : Math.floor(captured.base64.replace(/\s/g, "").length * 0.75),
    at: Date.now(),
  };

  // 记录整理失败（存储配额之类）不该让整件事失败——图已经存好了，
  // 「最近截屏」列表少一条远不如「图发不出去」严重。
  try {
    const config = loadScreenshotConfig();
    const kept = await trimRecords([record, ...loadScreenshotRecords()], config.keepRecent);
    saveScreenshotRecords(kept);
  } catch (err) {
    console.warn("[Screenshot] 记录整理失败", err);
  }

  return record;
}

/**
 * 记一张「用户自己截的」画面（悬浮球发起）。
 *
 * 悬浮球那条路上，图是原生回传的 base64，网页这边拿到时早已过了
 * `captureAndStoreScreenshot` 那个入口——所以单独开一个口子，
 * 与自动截屏共用同一套存储与记录整理。
 *
 * 返回记录（含 media-store ref，可直接当图片地址用）；
 * null 表示没能存进媒体库，调用方应如实报失败。
 */
export async function recordUserShot(captured: {
  base64: string;
  width: number;
  height: number;
  bytes?: number;
}): Promise<ScreenshotRecord | null> {
  return storeScreenshotRecord(captured);
}

/**
 * 只保留最近 keep 条，把被挤掉的图片从媒体库删掉。
 *
 * 删图这一步很重要：记录列表只是索引，真正的几 MB 图片在媒体库里，
 * 只截索引的链会导致图片永远留着、悄悄把存储占满。
 */
async function trimRecords(records: ScreenshotRecord[], keep: number): Promise<ScreenshotRecord[]> {
  const kept = records.slice(0, Math.max(1, keep));
  const evicted = records.slice(kept.length);
  for (const item of evicted) {
    await deleteMediaRef(item.ref);
  }
  return kept;
}

/** 移除一条截屏记录，并清理对应媒体文件。 */
export async function removeScreenshotRecord(id: string): Promise<void> {
  const records = loadScreenshotRecords();
  const target = records.find(record => record.id === id);
  if (!target) return;
  await deleteMediaRef(target.ref);
  saveScreenshotRecords(records.filter(record => record.id !== id));
}

/** 清空全部截屏记录与对应图片。 */
export async function clearAllScreenshots(): Promise<void> {
  const records = loadScreenshotRecords();
  for (const item of records) {
    await deleteMediaRef(item.ref);
  }
  saveScreenshotRecords([]);
}

/**
 * 发一条「刚截了你的屏幕」系统通知。
 *
 * 这里刻意不用 dispatchChatMessageNotice：它要求 sessionId 非空（没有归属的
 * 消息会被直接丢掉），而截屏多数是用户在设置页手动触发或查岗自动截的，
 * 本来就没有「哪个角色在操作」。所以直走壳原生通知通道，只当一条系统提醒。
 * 非壳环境（浏览器）下它是空操作——那种环境下用户就站在页面前，看得到结果。
 */
function notifyScreenshot(record: ScreenshotRecord): void {
  sendShellNotification(
    "小手机",
    `刚截了一张你的屏幕（${record.width}×${record.height}）`,
    null,
    null,
  );
}
