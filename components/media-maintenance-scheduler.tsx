"use client";

import { useEffect } from "react";
import { runScheduledMediaMaintenance } from "@/lib/media-maintenance";

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

export function MediaMaintenanceScheduler() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    let timeoutHandle: number | null = null;
    let idleHandle: number | null = null;

    const run = () => {
      if (cancelled) return;
      void runScheduledMediaMaintenance().catch((error) => {
        console.warn("[MediaMaintenanceScheduler] scheduled run failed:", error);
      });
    };

    const scheduleRun = () => {
      if (cancelled) return;
      const idleWindow = window as WindowWithIdleCallback;
      if (typeof idleWindow.requestIdleCallback === "function") {
        idleHandle = idleWindow.requestIdleCallback(run, { timeout: 5000 });
      } else {
        run();
      }
    };
    timeoutHandle = window.setTimeout(scheduleRun, 45000);

    // Maintenance engine enforces its own 24-hour auto-run interval and a single
    // in-flight promise, so a resume catch-up cannot duplicate a completed run.
    const onResume = () => {
      if (document.visibilityState !== "visible") return;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) (window as WindowWithIdleCallback).cancelIdleCallback?.(idleHandle);
      scheduleRun();
    };
    window.addEventListener("focus", onResume);
    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);

    return () => {
      cancelled = true;
      if (timeoutHandle !== null) window.clearTimeout(timeoutHandle);
      if (idleHandle !== null) {
        (window as WindowWithIdleCallback).cancelIdleCallback?.(idleHandle);
      }
      window.removeEventListener("focus", onResume);
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, []);

  return null;
}
