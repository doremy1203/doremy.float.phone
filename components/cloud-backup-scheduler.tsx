"use client";

import { useEffect } from "react";

import { isCloudBackupConfigured, loadCloudBackupConfig } from "@/lib/cloud-backup/config";
import { loadCloudBackupState, runCloudBackup } from "@/lib/cloud-backup/engine";

// Module-level guard so overlapping timers/mounts never run two backups at once.
let backupRunning = false;

/**
 * Invisible component that drives auto cloud backup. Mounted once at the app
 * root. It checks every few minutes whether a backup is due (per the user's
 * interval) and, when idle, runs a content-addressed incremental backup.
 *
 * Respect the user's excludeMedia setting: the config defaults to excluding
 * media to avoid repeatedly uploading large image/audio/video payloads. Media
 * can still be included when the user explicitly opts in.
 */
export function CloudBackupScheduler() {
  useEffect(() => {
    let cancelled = false;

    const runWhenIdle = (fn: () => void) => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(() => fn(), { timeout: 4000 });
      } else {
        window.setTimeout(fn, 400);
      }
    };

    const tick = () => {
      if (cancelled || backupRunning) return;
      const config = loadCloudBackupConfig();
      if (!config.enabled || !isCloudBackupConfigured(config)) return;

      const state = loadCloudBackupState();
      const dueMs = config.intervalHours * 3600_000;
      const last = state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : state.lastCreatedAt ? Date.parse(state.lastCreatedAt) : 0;
      if (Number.isFinite(last) && last > 0 && Date.now() - last < dueMs) return;

      runWhenIdle(async () => {
        if (cancelled || backupRunning) return;
        backupRunning = true;
        try {
          // Do not override the user's media policy: false means full media backup,
          // true means back up structured data while excluding large media blobs.
          await runCloudBackup(config, { excludeMedia: config.excludeMedia });
        } catch {
          /* surfaced in the data page status on next open */
        } finally {
          backupRunning = false;
        }
      });
    };

    const interval = window.setInterval(tick, 5 * 60_000);
    const initial = window.setTimeout(tick, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(initial);
    };
  }, []);

  return null;
}
