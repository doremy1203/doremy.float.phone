"use client";

import { useEffect } from "react";

import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import { processBridgeItem, runDueDelayedTasks, runDueScheduledRules, syncNativeOfflineBridgeMessages } from "@/lib/reality-bridge/engine";
import { bridgeConnection, loadBridgeSettings, pullBridgeInbox } from "@/lib/reality-bridge/storage";

export const REALITY_BRIDGE_FEED_UPDATED_EVENT = "reality-bridge-feed-updated";

let pollRunning = false;

async function pollOnce(force = false): Promise<number> {
  if (pollRunning) return 0;
  pollRunning = true;
  try {
    await hydrateKvDb();
    // 原生离线通知在 Android 端持久化；WebView 恢复后写入角色聊天室并触发现有消息横幅。
    const nativeImported = await syncNativeOfflineBridgeMessages();
    const settings = loadBridgeSettings();
    const { config, ready } = bridgeConnection();

    // ── 先跑纯本地的那两类：定时联动、延迟补执行 ──
    //
    // **必须在任何开关判断之前**。它们不经过云端、不需要 iPhone，
    // 只依赖「小手机开着」这一件事。原来的写法把 settings.enabled 的判断
    // 放在了最前面（settings.enabled 是「接收快捷指令消息」开关），
    // 于是那个开关一关，连「每天早上说句早安」这种纯本地的定时规则
    // 都不会被检查——到点不触发、历史里也没有任何记录（实测反馈）。
    // 注释当时写着「与云端无关」，但代码没做到，这里补上。
    const localFired = (await runDueScheduledRules()) + (await runDueDelayedTasks());

    // ── 再处理需要云端的那条路 ──
    // force = 用户手动点刷新，是明确意图，不受自动接收开关限制。
    let pulled = 0;
    if (ready && (settings.enabled || force)) {
      const items = await pullBridgeInbox(config);
      for (const item of items) {
        await processBridgeItem(item);
      }
      pulled = items.length;
    }

    // 任一有动静就通知界面刷新（历史页/概览都要跟着变）
    if ((pulled > 0 || localFired > 0 || nativeImported > 0) && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(REALITY_BRIDGE_FEED_UPDATED_EVENT));
    }
    return pulled;
  } catch (err) {
    console.warn("[现实桥] 轮询失败", err);
    return 0;
  } finally {
    pollRunning = false;
  }
}

/** 手动触发一次拉取（现实桥 APP 的「立即同步」按钮用），无视自动接收开关。 */
export async function pollRealityBridgeNow(): Promise<number> {
  return pollOnce(true);
}

/** 隐形调度器：挂在 main-app 里，小手机打开期间按间隔轮询收件箱。 */
export function RealityBridgeScheduler() {
  useEffect(() => {
    let cancelTimer: (() => void) | null = null;
    let disposed = false;

    const schedule = () => {
      if (disposed) return;
      const seconds = loadBridgeSettings().pollSeconds;
      // Worker 定时器：iOS 后台会冻结主线程 setTimeout（即使音频保活让进程活着），
      // 与追问/日记/朋友圈等后台服务同款走 bg-timer，保活期间后台照常轮询
      cancelTimer = bgSetTimeout(async () => {
        await pollOnce();
        schedule();
      }, Math.max(10, seconds) * 1000);
    };

    const cancelStartDelay = bgSetTimeout(() => {
      void pollOnce();
      schedule();
    }, 2000);

    // iOS PWA 从后台恢复时 focus 不一定触发，visibilitychange/pageshow 兜底：
    // 一回到小手机就立刻收取积压事件
    const onResume = () => { void pollOnce(); };
    const onVisible = () => { if (document.visibilityState === "visible") void pollOnce(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      cancelStartDelay();
      if (cancelTimer) cancelTimer();
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
