"use client";

// 查岗调度器：把「到点该查岗」这件事真正跑起来。
//
// 为什么单独一个组件、挂在 main-app 而不是设置页——两层原因，缺一不可：
//
//  ① 角色查岗是**角色**发起的。那一刻用户多半正在别的 App 里，
//     设置页压根没开着；轮询挂在设置页上，等于永远等不到触发时机。
//     原来的实现就是这个毛病：pollDueCheckIns 写好了，却谁也
//     没调用它，于是「手动试一次」能弹、到点一次都不弹。
//
//  ② 「用户自己点悬浮球截屏」的结果由 ShellPushRegistrar 统一接收，
//     与查岗轮询分开，避免同一原生事件被多个监听器重复消费。
//
// 挂载点与 RealityBridgeScheduler / WidgetScheduler 完全一致。

import { useEffect } from "react";

import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import {
  cancelNativeCheckIn,
  checkInReadiness,
  consumePendingNativeCheckIn,
  hasAnyCheckInEnabled,
  hasPendingNativeCheckIn,
  findLatestPrivateSession,
  pollDueCheckIns,
  prepareCheckInService,
  readCheckInDiagnostics,
  readNativeCheckInDiagnostics,
  runCheckIn,
  scheduleNativeCheckIn,
} from "@/lib/screenshot";
import { loadCheckInConfig, readCharacterRuntime } from "@/lib/screenshot/checkin-config";
import { loadCharacters } from "@/lib/character-storage";

/** 扫描间隔。查岗的节奏本身就按分钟算（最短 5 分钟），一分钟扫一遍足够细，
 *  又不至于让每次扫描都白跑一趟。真正的「该不该触发」由每个角色自己的
 *  间隔配置决定，见 checkin-config.ts 的 shouldFireCheckIn。 */
const SCAN_INTERVAL_MS = 60_000;

/** 冷启动后第一次扫描的延迟。太早扫会读到还没水合完的配置。 */
const FIRST_SCAN_DELAY_MS = 5_000;

export function CheckInScheduler() {
  useEffect(() => {
    let cancelTimer: (() => void) | null = null;
    let disposed = false;

    /**
     * 扫一遍所有角色，把到点的查岗跑一遍。
     *
     * 顺带补一件容易被忽略、但用户一定会撞上的事：**App 重启后把常驻服务重新暖起来**。
     * 查岗浮层要求原生服务已常驻（Android 12+ 不允许后台起前台服务），而预热
     * 只在用户「打开开关」那一刻做过一次。用户第二天重开小手机时，网页是新的、
     * 服务却未必还在——那时弹窗会静默失败，表现和「到点没反应」一模一样。
     * 这里在读诊断时顺手补一次，且只在「有角色开着 + 服务没跑」时补。
     */
    const stableDelayMinutes = (characterId: string, lastFiredAt: number, min: number, max: number) => {
      const input = characterId + ":" + String(lastFiredAt);
      let hash = 2166136261;
      for (let i = 0; i < input.length; i += 1) {
        hash ^= input.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      const span = Math.max(0, max - min);
      return min + ((hash >>> 0) % (span + 1));
    };

    const syncNativeSchedule = () => {
      const configs = loadCheckInConfig();
      const characters = loadCharacters();
      const now = Date.now();
      const native = readNativeCheckInDiagnostics();
      // 上一次闹钟已到点但用户尚未处理时，保留这一条待处理请求，不继续排下一条，
      // 避免用户不在场时每隔一个间隔就收到重复查岗通知。
      if (native?.pending) return;
      const candidates = Object.entries(configs)
        .filter(([id, config]) => {
          const runtime = readCharacterRuntime(id);
          return config.enabled && runtime.countToday < config.dailyLimit && Boolean(findLatestPrivateSession(id));
        })
        .map(([id, config]) => {
          const runtime = readCharacterRuntime(id);
          const delay = stableDelayMinutes(id, runtime.lastFiredAt, config.minMinutes, config.maxMinutes);
          const configKey = [config.minMinutes, config.maxMinutes, config.dailyLimit].join(":");
          // 首次触发前 lastFiredAt=0。不能每分钟都用 now+min 重算，
          // 否则闹钟会一直向后漂移、永远到不了。相同角色和配置沿用原生已登记的绝对时间。
          const dueAt = runtime.lastFiredAt > 0
            ? runtime.lastFiredAt + delay * 60_000
            : native?.scheduled && native.characterId === id && native.configKey === configKey && native.dueAt > now
              ? native.dueAt
              : now + config.minMinutes * 60_000;
          const character = characters.find(item => item.id === id);
          return { characterId: id, name: character?.name?.trim() || "角色", dueAt, configKey };
        })
        .sort((a, b) => a.dueAt - b.dueAt);
      const next = candidates[0];
      if (!next) {
        cancelNativeCheckIn();
        return;
      }
      scheduleNativeCheckIn(next);
    };

    const scan = async () => {
      try {
        await hydrateKvDb();
        if (!hasAnyCheckInEnabled()) {
          cancelNativeCheckIn();
          return;
        }

        // 原生闹钟只会在用户点击提醒（或点击修复无障碍按钮）后标记待处理。
        // 若无障碍服务尚未重新连接，先保留请求，不要提前消费；用户从系统设置返回、
        // 服务恢复后再继续原有的预览审批流程。
        if (hasPendingNativeCheckIn() && checkInReadiness().ready) {
          const pendingCharacterId = consumePendingNativeCheckIn();
          if (pendingCharacterId) await runCheckIn(pendingCharacterId);
        }

        // 服务没在跑就先暖起来。此刻多半在前台（挂载 / 回到前台触发的），
        // 正是唯一合法的启动时机；失败也不打断下面的扫描，
        // 该弹不出来会如实记进诊断面板。
        const diagnostics = readCheckInDiagnostics();
        if (diagnostics && diagnostics.running === false && checkInReadiness().ready) {
          prepareCheckInService();
        }

        await pollDueCheckIns();
        // WebView 定时器只能作为前台补偿；真正跨进程存活的是 Android 原生闹钟。
        // 它到点只发通知，用户点开后才回到上述审批流程。
        syncNativeSchedule();
      } catch (err) {
        console.warn("[查岗] 扫描失败", err);
      }
    };

    const schedule = () => {
      if (disposed) return;
      // 走 Worker 定时器（bg-timer）：iOS 后台会冻结主线程的 setTimeout，
      // 后台保活期间这个跟追问/朋友圈等服务同款，照常轮询。
      cancelTimer = bgSetTimeout(async () => {
        await scan();
        schedule();
      }, SCAN_INTERVAL_MS);
    };

    const cancelFirstScan = bgSetTimeout(() => {
      void scan();
      schedule();
    }, FIRST_SCAN_DELAY_MS);

    // 回到前台立刻补一次：后台期间定时器被冻结，该触发的那几次就靠这一刻补上。
    // 与查岗「不做隐蔽触发」的约定不冲突——这里只是把已经到点的补上，
    // 每一次仍然会弹浮层让用户当场决定。
    const onResume = () => { void scan(); };
    const onVisible = () => { if (document.visibilityState === "visible") void scan(); };
    const onConfigChanged = () => { void scan(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    window.addEventListener("check-in-config-changed", onConfigChanged);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      cancelFirstScan();
      if (cancelTimer) cancelTimer();
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      window.removeEventListener("check-in-config-changed", onConfigChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
