import { deleteMediaRef } from "@/lib/media-cache-storage";
import { isPersonalPushCloudActive, personalPushFetch } from "@/lib/personal-push-cloud";
import { isShellEnvironment } from "@/lib/shell-detect";
import { clearLifeDiagnostics } from "./life-diagnostics";
import { clearLifeSceneNotificationQueue } from "./life-notification-queue";
import { clearLifeProactiveSchedulerLocalState } from "./life-proactive-scheduler";
import { resetVirtualLifeState, loadVirtualLifeState } from "./life-storage";
import { LIFE_SCENE_FOREGROUND_LEASE_KEY } from "./life-scheduler-coordinator";

/** Full reset is cloud-first: if remote jobs cannot be confirmed cancelled, local data is left intact. */
export async function resetLifeSystemData(): Promise<void> {
  const response = isPersonalPushCloudActive() && !isShellEnvironment()
    ? await personalPushFetch("life-reset", { method: "POST" })
    : await fetch("/api/life/reset", { method: "POST", credentials: "include", cache: "no-store" });
  const result = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
  if (!response.ok || !result.ok) {
    const detail = result.error || `云端生活重置接口返回 HTTP ${response.status}`;
    if (response.status === 404 || /unknown action|not found/i.test(detail)) {
      throw new Error(detail + "；个人云网关版本可能过旧，请重新部署个人离线推送服务后再重试。");
    }
    throw new Error(detail);
  }

  const state = loadVirtualLifeState();
  const mediaRefs = new Set<string>();
  for (const scene of state.scenes) for (const image of scene.images ?? []) if (image.mediaRef) mediaRefs.add(image.mediaRef);
  for (const entry of state.timeline) if (entry.imageMediaRef) mediaRefs.add(entry.imageMediaRef);
  await Promise.allSettled([...mediaRefs].map(ref => deleteMediaRef(ref)));

  clearLifeSceneNotificationQueue();
  clearLifeDiagnostics();
  clearLifeProactiveSchedulerLocalState();
  resetVirtualLifeState();
  try { localStorage.removeItem(LIFE_SCENE_FOREGROUND_LEASE_KEY); } catch { /* best effort */ }
  try { localStorage.removeItem("life-scene-pending-banner-v1"); } catch { /* best effort */ }
  window.dispatchEvent(new Event("life-presence-lease-updated"));
}
