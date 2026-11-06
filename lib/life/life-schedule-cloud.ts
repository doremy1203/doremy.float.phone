/**
 * Synchronize authoritative player/character presence and active scenes for offline validation.
 */
import { loadVirtualLifeState } from "./life-storage";
import { resolveActorLocation } from "./life-runtime";
import { recordLifeDiagnostic } from "./life-diagnostics";
import { readLifeSceneForegroundLease, readOnlineChatForegroundLease } from "./life-scheduler-coordinator";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "@/lib/personal-push-cloud";
import { isShellEnvironment } from "@/lib/shell-detect";

const PLAYER_ID = "player";
const SNAPSHOT_RULE_ID = "life-schedule";
const MAX_SNAPSHOT_AGE_MS = 5 * 60_000;
let lastJson = "";
let lastSyncedAt = 0;

function foregroundLeaseSnapshot(): { foregroundSceneId: string; foregroundLeaseUntil: string } {
  const lease = readLifeSceneForegroundLease();
  return lease
    ? { foregroundSceneId: lease.sceneId, foregroundLeaseUntil: new Date(lease.expiresAt).toISOString() }
    : { foregroundSceneId: "", foregroundLeaseUntil: "" };
}


export async function syncLifeScheduleSnapshot(force = false): Promise<boolean> {
  if (typeof window === "undefined" || typeof fetch !== "function") return false;
  try {
    const state = loadVirtualLifeState();
    const playerLocationId = resolveActorLocation(state, "player", "player")?.id ?? "";
    const characterIds = new Set([
      ...state.actorStates.filter(actor => actor.ownerType === "character").map(actor => actor.ownerId),
      ...state.schedules.filter(slot => slot.ownerType === "character").map(slot => slot.ownerId),
      ...state.scenes.flatMap(scene => scene.participants.filter(p => p.ownerType === "character").map(p => p.ownerId)),
    ]);
    const scenes = state.scenes.filter(scene => scene.status === "active").map(scene => ({
      id: scene.id,
      // The cloud evaluator recomputes this from the complete schedule on every tick.
      locationId: playerLocationId || scene.locationId,
      characterIds: scene.participants.filter(p => p.ownerType === "character" && p.activity !== "离开").map(p => p.ownerId),
    }));
    const characterLocations = Object.fromEntries([...characterIds].map(id => [id, resolveActorLocation(state, "character", id)?.id ?? ""]));
    // Keep the complete seven-day itinerary in the encrypted cloud snapshot. The
    // server can then evaluate the real current schedule while the WebView is closed,
    // instead of replaying an old "study/work" prompt for the entire repeat chain.
    const relevantOwnerIds = new Set([PLAYER_ID, ...characterIds]);
    const scheduleSlots = state.schedules
      .filter(slot => relevantOwnerIds.has(slot.ownerId)
        && (slot.ownerType === "player" || slot.ownerType === "character"))
      .map(slot => ({
        ownerType: slot.ownerType,
        ownerId: slot.ownerId,
        startAt: slot.startAt,
        endAt: slot.endAt,
        title: slot.title,
        kind: slot.kind,
        source: slot.source,
        plannedLocationId: slot.plannedLocationId ?? "",
        plannedLocationName: slot.plannedLocationName ?? "",
      }));
    const actorStates = state.actorStates
      .filter(actor => relevantOwnerIds.has(actor.ownerId))
      .map(actor => ({
        ownerType: actor.ownerType,
        ownerId: actor.ownerId,
        activity: actor.activity,
        scheduleSlotId: actor.scheduleSlotId ?? "",
        actualLocationId: actor.actualLocationId ?? "",
        actualLocationName: actor.actualLocationName ?? "",
        actualLocationUntil: actor.actualLocationUntil ?? null,
      }));
    // Version the full actor/schedule state, not just the timetable. A manual move
    // or activity override must invalidate a runtime row computed before that change.
    const scheduleJson = JSON.stringify({ scheduleSlots, actorStates, playerLocationId, characterLocations, scenes });
    let scheduleHash = 2166136261;
    for (let index = 0; index < scheduleJson.length; index += 1) {
      scheduleHash = Math.imul(scheduleHash ^ scheduleJson.charCodeAt(index), 16777619);
    }
    const scheduleVersion = String(state.scheduleProfileVersion ?? 0) + ":" + (scheduleHash >>> 0).toString(36);
    const foregroundLease = foregroundLeaseSnapshot();
    const onlineChatLease = readOnlineChatForegroundLease();
    const onlineChatLeaseSnapshot = onlineChatLease ? {
      onlineChatCharacterId: onlineChatLease.characterId,
      onlineChatSessionId: onlineChatLease.sessionId,
      onlineChatLeaseUntil: new Date(onlineChatLease.expiresAt).toISOString(),
    } : { onlineChatCharacterId: "", onlineChatSessionId: "", onlineChatLeaseUntil: "" };
    const scheduleSettings = {
      enabled: state.settings.enabled,
      autonomyEnabled: state.settings.enableCharacterAutonomy,
      proactiveEnabled: false,
      proactiveIntervalMin: state.settings.proactiveSceneIntervalMinutes ?? 5,
      proactiveIntervalMax: state.settings.proactiveSceneIntervalMaxMinutes ?? 15,
      scheduleVersion,
    };
    const fingerprint = JSON.stringify({ version: 5, playerLocationId, scenes, characterLocations, scheduleSlots, actorStates, scheduleSettings, ...foregroundLease, ...onlineChatLeaseSnapshot });
    if (!force && fingerprint === lastJson && Date.now() - lastSyncedAt < MAX_SNAPSHOT_AGE_MS) return true;
    const payload = { version: 5, updatedAt: new Date().toISOString(), playerLocationId, scenes, characterLocations, scheduleSlots, actorStates, ...scheduleSettings, ...foregroundLease, ...onlineChatLeaseSnapshot };
    const requestInit: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshots: [{ ruleId: SNAPSHOT_RULE_ID, payload }] }),
    };
    // Browser personal-cloud jobs use OWNER_ID in the independent project; shell
    // jobs stay on the site Supabase so shellpush:<account-id> matches their owner.
    const personalCloudReady = isPersonalPushCloudActive()
      && !isShellEnvironment()
      && (loadPersonalPushCloudState()?.schemaVersion ?? 0) >= 4;
    const response = personalCloudReady
      ? await personalPushFetch("life-schedule-snapshot", requestInit)
      : await fetch("/api/push/bridge-snapshots", requestInit);
    if (response.ok) {
      lastJson = fingerprint;
      lastSyncedAt = Date.now();
      recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "ok", detail: "玩家地点与 " + Object.keys(characterLocations).length + " 个角色地点已同步。", meta: { sceneCount: scenes.length, playerLocationId } });
      return true;
    }
    recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: "快照接口返回 HTTP " + response.status, meta: { playerLocationId } });
    return false;
  } catch (error) {
    recordLifeDiagnostic({ source: "云端快照", event: "日程位置同步", status: "error", detail: error instanceof Error ? error.message : String(error) });
    return false;
  }
}
