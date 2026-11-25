import { hydrateKvDb, kvGet, kvRemove } from "@/lib/kv-db";
import { deleteMediaRef } from "@/lib/media-cache-storage";
import { isPersonalPushCloudActive, personalPushFetch } from "@/lib/personal-push-cloud";
import { isShellEnvironment } from "@/lib/shell-detect";
import { clearLifeDiagnostics } from "./life-diagnostics";
import { clearLifeSceneNotificationQueue } from "./life-notification-queue";
import { clearLifeProactiveSchedulerLocalState } from "./life-proactive-scheduler";
import { resetVirtualLifeState, loadVirtualLifeState } from "./life-storage";
import { LIFE_SCENE_FOREGROUND_LEASE_KEY } from "./life-scheduler-coordinator";

/** 观察生活记录（含图片媒体引用）与其他生活数据一样，完整重置时必须一并清理。 */
export const LIFE_OBSERVATION_STORAGE_KEY = "ai_phone_life_observation_v1";
const CLOUD_RESET_TIMEOUT_MS = 12_000;

export type LifeResetResult = {
  /** 是否真正发起了云端清理请求。 */
  cloudAttempted: boolean;
  /** 云端清理是否已确认成功；false 不影响本地重置结果。 */
  cloudOk: boolean;
  cloudError?: string;
};

function collectObservationMediaRefs(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { entries?: Array<{ imageMediaRef?: string }> };
    return (parsed.entries ?? []).map(entry => entry.imageMediaRef).filter((ref): ref is string => Boolean(ref));
  } catch {
    return [];
  }
}

/**
 * 完整重置生活系统：本地优先。
 *
 * 先无条件清空本机生活数据（含地点库/文件夹/外观设置/观察生活记录及其图片），
 * 再尽力通知云端撤销生活任务。云端未配置、超时或报错都不会阻止本地重置，
 * 只会通过返回值提示用户云端清理尚未确认。
 */
export async function resetLifeSystemData(): Promise<LifeResetResult> {
  // Waiting for hydration is best-effort: older observations may not be in the
  // in-memory cache yet, and their media refs must still be found for cleanup.
  await hydrateKvDb();
  const state = loadVirtualLifeState();
  const mediaRefs = new Set<string>();
  for (const scene of state.scenes) for (const image of scene.images ?? []) if (image.mediaRef) mediaRefs.add(image.mediaRef);
  for (const entry of state.timeline) if (entry.imageMediaRef) mediaRefs.add(entry.imageMediaRef);
  const observationRaw = kvGet(LIFE_OBSERVATION_STORAGE_KEY);
  for (const ref of collectObservationMediaRefs(observationRaw)) mediaRefs.add(ref);
  await Promise.allSettled([...mediaRefs].map(ref => deleteMediaRef(ref)));

  kvRemove(LIFE_OBSERVATION_STORAGE_KEY);
  clearLifeSceneNotificationQueue();
  clearLifeDiagnostics();
  clearLifeProactiveSchedulerLocalState();
  resetVirtualLifeState();
  try { localStorage.removeItem(LIFE_SCENE_FOREGROUND_LEASE_KEY); } catch { /* best effort */ }
  try { localStorage.removeItem("life-scene-pending-banner-v1"); } catch { /* best effort */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("life-observation-updated"));
    window.dispatchEvent(new Event("life-presence-lease-updated"));
  }

  const controller = typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = typeof window !== "undefined" ? window.setTimeout(() => controller?.abort(), CLOUD_RESET_TIMEOUT_MS) : 0;
  try {
    const response = isPersonalPushCloudActive() && !isShellEnvironment()
      ? await personalPushFetch("life-reset", { method: "POST", signal: controller?.signal })
      : await fetch("/api/life/reset", { method: "POST", credentials: "include", cache: "no-store", signal: controller?.signal });
    const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
    if (!response.ok || !result.ok) {
      const detail = result.error || `云端生活重置接口返回 HTTP ${response.status}`;
      return { cloudAttempted: true, cloudOk: false, cloudError: detail };
    }
    return { cloudAttempted: true, cloudOk: true };
  } catch (error) {
    return {
      cloudAttempted: true,
      cloudOk: false,
      cloudError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (typeof window !== "undefined") window.clearTimeout(timer);
  }
}
