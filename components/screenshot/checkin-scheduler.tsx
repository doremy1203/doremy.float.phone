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
//  ② 「用户自己点悬浮球截屏」的结果也要有人来取（startUserShotBridge）。
//     点球那一刻网页十有八九已被系统回收，事件是丢的，只能靠一个
//     常驻的接收端在回到前台时把图捞回来。这条链路**不依赖查岗开关**，
//     只要用户用了悬浮球就该收得到，所以与下面的定时扫描分开处理。
//
// 挂载点与 RealityBridgeScheduler / WidgetScheduler 完全一致。

import { useEffect } from "react";

import { bgSetTimeout } from "@/lib/bg-timer";
import { hydrateKvDb } from "@/lib/kv-db";
import {
  checkInReadiness,
  hasAnyCheckInEnabled,
  pollDueCheckIns,
  prepareCheckInService,
  readCheckInDiagnostics,
  startUserShotBridge,
} from "@/lib/screenshot";

/** 扫描间隔。查岗的节奏本身就按分钟算（最短 5 分钟），一分钟扫一遍足够细，
 *  又不至于让每次扫描都白跑一趟。真正的「该不该触发」由每个角色自己的
 *  间隔配置决定，见 checkin-config.ts 的 shouldFireCheckIn。 */
const SCAN_INTERVAL_MS = 60_000;

/** 冷启动后第一次扫描的延迟。太早扫会读到还没水合完的配置。 */
const FIRST_SCAN_DELAY_MS = 5_000;

export function CheckInScheduler() {
  useEffect(() => {
    // 主动截屏接收端：挂载时补收一张，之后每次收到 checkIn 事件再拉一次。
    // 原生侧是「读到即空」，重复调用不会把同一张图发两遍。
    const stopUserShotBridge = startUserShotBridge();

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
    const scan = async () => {
      try {
        if (!hasAnyCheckInEnabled()) return;
        await hydrateKvDb();

        // 服务没在跑就先暖起来。此刻多半在前台（挂载 / 回到前台触发的），
        // 正是唯一合法的启动时机；失败也不打断下面的扫描，
        // 该弹不出来会如实记进诊断面板。
        const diagnostics = readCheckInDiagnostics();
        if (diagnostics && diagnostics.running === false && checkInReadiness().ready) {
          prepareCheckInService();
        }

        await pollDueCheckIns();
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
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      cancelFirstScan();
      if (cancelTimer) cancelTimer();
      stopUserShotBridge();
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
