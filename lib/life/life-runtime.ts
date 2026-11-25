import type { LifeActorClock, LifeActorState, LifeEvent, LifeInvitation, LifeLocation, LifeOwnerType, LifeScheduleSlot, LifeSceneParticipant, LifeSceneState, VirtualLifeState } from "./life-types";
import { findLifeSceneForLocation, mergeLifeSceneParticipants } from "./life-engine";

export const lifeActorKey = (ownerType: LifeOwnerType, ownerId: string) => `${ownerType}:${ownerId}`;

/**
 * Compatibility adapter for older callers and persisted records.
 * Life actors no longer own independent clocks: every operation uses wall-clock time.
 */
export function getActorClock(_state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): LifeActorClock {
  const now = new Date().toISOString();
  return { ownerType, ownerId, realAnchorAt: now, updatedAt: now };
}

export function resolveActorLifeNow(_legacyClock: LifeActorClock, realNow = new Date()): Date {
  return realNow;
}

export function findActorState(state: VirtualLifeState, ownerType: LifeActorState["ownerType"], ownerId: string) {
  return state.actorStates.find(actor => actor.ownerType === ownerType && actor.ownerId === ownerId);
}
export function upsertActorState(
  state: VirtualLifeState,
  nextActor: Pick<LifeActorState, "ownerType" | "ownerId" | "activity"> & Partial<Omit<LifeActorState, "ownerType" | "ownerId" | "activity">>,
): VirtualLifeState {
  const existing = state.actorStates.find(actor => actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId);
  const actorStates = state.actorStates.filter(actor => !(actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId));
  // Merge instead of replacing the whole record: callers that only change one
  // field must not silently drop scheduleSlotId, locationSource or manualSetAt.
  actorStates.push({
    ...existing,
    ...nextActor,
    updatedAt: nextActor.updatedAt ?? new Date().toISOString(),
  });
  return { ...state, actorStates };
}

/** A user-picked location takes precedence over the schedule for two hours. */
export const MANUAL_LOCATION_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * A manual location override is active only while the explicit manual marker is
 * present and its TTL has not elapsed. `updatedAt` is deliberately ignored: it is
 * refreshed by ordinary settlement and would renew the override forever.
 */
export function isManualLocationOverrideActive(actor: LifeActorState | undefined, now = new Date()): boolean {
  if (!actor?.actualLocationId || actor.locationSource !== "manual" || !actor.manualSetAt || actor.actualLocationUntil != null) return false;
  // 用户明确选择「一直停留」时不看时间，直到再次手动改动地点。
  if (actor.manualPinned) return true;
  const setAt = Date.parse(actor.manualSetAt);
  return Number.isFinite(setAt) && now.getTime() - setAt < MANUAL_LOCATION_TTL_MS;
}

/** The manual marker is present but its 2-hour TTL has elapsed; the schedule owns presence again. */
export function isManualLocationOverrideExpired(actor: LifeActorState | undefined, now = new Date()): boolean {
  if (!actor?.actualLocationId || actor.locationSource !== "manual" || !actor.manualSetAt || actor.actualLocationUntil != null) return false;
  if (actor.manualPinned) return false;
  const setAt = Date.parse(actor.manualSetAt);
  return Number.isFinite(setAt) && now.getTime() - setAt >= MANUAL_LOCATION_TTL_MS;
}

/**
 * Resolve the actual location consistently for UI snapshots and proactive scheduling.
 * A temporary or manually selected actual location wins; otherwise use the current schedule.
 */
export function resolveActorLocation(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  now = new Date(),
): { id: string; name: string } | null {
  const actor = state.actorStates.find(item => item.ownerType === ownerType && item.ownerId === ownerId);
  const slot = getCurrentActorSchedule(state, ownerType, ownerId, now);
  const until = actor?.actualLocationUntil ? Date.parse(actor.actualLocationUntil) : Number.NaN;
  const temporaryStay = Boolean(actor?.actualLocationId && Number.isFinite(until) && until > now.getTime());
  // Shared TTL rule: an expired manual choice is treated exactly like no override,
  // so UI, snapshots and diagnostics all fall back to the current schedule.
  const manualOverride = Boolean(actor?.actualLocationId && isManualLocationOverrideActive(actor, now));
  const useActual = temporaryStay || manualOverride;
  const locationId = (useActual ? actor?.actualLocationId : slot?.plannedLocationId) || actor?.actualLocationId || "";
  if (!locationId) return null;
  const locationName = (useActual ? actor?.actualLocationName : slot?.plannedLocationName)
    || actor?.actualLocationName
    || state.locations.find(location => location.id === locationId)?.name
    || "当前地点";
  return { id: locationId, name: locationName };
}

/**
 * Move only future, automatically generated home slots when a character's residence changes.
 * Explicit manual locations, work/study/commute and non-home outings are never rewritten.
 */
export function synchronizeCharacterHomeSchedule(
  state: VirtualLifeState,
  input: { characterId: string; destinationHomeId: string; destinationHomeName: string; now: Date },
): { state: VirtualLifeState; synchronizedScheduleCount: number } {
  const { characterId, destinationHomeId, destinationHomeName, now } = input;
  const nowMs = now.getTime();
  if (!characterId || !destinationHomeId || !destinationHomeName || !Number.isFinite(nowMs)) {
    return { state, synchronizedScheduleCount: 0 };
  }
  const currentActor = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
  const currentActualId = currentActor?.actualLocationId ?? "";
  const isHomeActivity = (slot: LifeScheduleSlot) =>
    slot.source === "weekly-generation"
    && ["habit", "meal", "free-time"].includes(slot.kind)
    && /回家|在家|居家|家中|家里|家庭|家务|整理房间|打扫房间|睡前/.test(slot.title);
  const isActorResidenceId = (locationId: string) => locationId === "home-" + characterId
    || Boolean(state.locations.find(location => location.id === locationId)?.residents?.includes(characterId));
  const isHomeSlot = (slot: LifeScheduleSlot): boolean => {
    if (slot.source === "manual") return false;
    const plannedId = slot.plannedLocationId ?? "";
    const plannedName = (slot.plannedLocationName ?? "").trim();
    const legacyUnresolvedHome = !plannedId
      && ["家", "家里", "家中", "自己的家"].includes(plannedName);
    // During a residence change, the actor's actual home may no longer list
    // them as a resident (the UI has already changed the residents array).
    // Accept that prior ID only when the current generated activity explicitly
    // describes being at home; "去 B 家吃饭" remains a visit, not a home slot.
    const currentGeneratedHome = Boolean(plannedId && plannedId === currentActualId
      && (plannedId === "home" || plannedId.startsWith("home-")) && isHomeActivity(slot));
    return plannedId === destinationHomeId || isActorResidenceId(plannedId)
      || currentGeneratedHome || legacyUnresolvedHome || (!plannedId && isHomeActivity(slot));
  };
  let synchronizedScheduleCount = 0;
  let schedulesChanged = false;
  const schedules = state.schedules.map(slot => {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId
      || slot.source === "manual" || new Date(slot.endAt).getTime() <= nowMs
      || !isHomeSlot(slot)) return slot;
    if (slot.plannedLocationId === destinationHomeId && (slot.plannedLocationName ?? "") === destinationHomeName) return slot;
    synchronizedScheduleCount += 1;
    schedulesChanged = true;
    return { ...slot, plannedLocationId: destinationHomeId, plannedLocationName: destinationHomeName, updatedAt: now.toISOString() };
  });
  const activeSlot = getCurrentActorSchedule(state, "character", characterId, now);
  const currentActualName = (currentActor?.actualLocationName ?? "").trim();
  const actualIsHome = currentActualId === destinationHomeId
    || isActorResidenceId(currentActualId)
    || Boolean(activeSlot && activeSlot.plannedLocationId === currentActualId
      && (currentActualId === "home" || currentActualId.startsWith("home-")) && isHomeActivity(activeSlot))
    || (!currentActualId && ["家", "家里", "家中", "自己的家"].includes(currentActualName));
  let actorStates = state.actorStates;
  if (activeSlot && isHomeSlot(activeSlot) && actualIsHome && currentActor
    && (currentActor.actualLocationId !== destinationHomeId || currentActor.actualLocationName !== destinationHomeName)) {
    actorStates = state.actorStates.map(actor => actor.ownerType === "character" && actor.ownerId === characterId
      ? { ...actor, actualLocationId: destinationHomeId, actualLocationName: destinationHomeName, actualLocationUntil: undefined, locationSource: "schedule" as const, manualSetAt: undefined, updatedAt: now.toISOString() }
      : actor);
  }
  if (!schedulesChanged && actorStates === state.actorStates) return { state, synchronizedScheduleCount };
  return { state: { ...state, schedules, actorStates }, synchronizedScheduleCount };
}

/**
 * Reserve a character's visit at a manually selected location and split overlapping
 * itinerary slots around the visit. The pre-visit and post-visit portions survive.
 */
export function reserveCharacterLocationStay(
  state: VirtualLifeState,
  input: {
    characterId: string; locationId: string; locationName: string; startAt: Date; endAt: Date; title: string;
    /** 角色工具发起的移动用 character-tool，玩家手动改地点保持 manual。 */
    slotSource?: LifeScheduleSlot["source"];
    locationSource?: LifeActorState["locationSource"];
  },
): VirtualLifeState {
  const { characterId, locationId, locationName, startAt, endAt, title } = input;
  const startMs = startAt.getTime();
  const requestedEndMs = endAt.getTime();
  if (!characterId || !locationId || !locationName || !Number.isFinite(startMs) || !Number.isFinite(requestedEndMs) || requestedEndMs <= startMs) return state;

  const ownerSlots = state.schedules.filter(slot => slot.ownerType === "character" && slot.ownerId === characterId);
  const activeSlot = getCurrentActorSchedule(state, "character", characterId, startAt);
  const nextBoundaryMs = activeSlot
    ? new Date(activeSlot.endAt).getTime()
    : ownerSlots.map(slot => new Date(slot.startAt).getTime())
      .filter(value => Number.isFinite(value) && value > startMs)
      .sort((a, b) => a - b)[0];
  // A manual trip replaces only the activity currently in progress. Its end is
  // bounded by the next planned activity, so future itinerary entries stay intact.
  const endMs = Math.min(requestedEndMs, Number.isFinite(nextBoundaryMs) ? nextBoundaryMs! : requestedEndMs);
  if (endMs <= startMs) return state;

  const startIso = startAt.toISOString();
  const endIso = new Date(endMs).toISOString();
  const updatedAt = new Date().toISOString();
  const retainedSlots: LifeScheduleSlot[] = [];
  for (const slot of state.schedules) {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId) {
      retainedSlots.push(slot);
      continue;
    }
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd <= startMs || slotStart >= endMs) {
      retainedSlots.push(slot);
      continue;
    }
    // Keep only the elapsed prefix of an interrupted activity. Never resurrect
    // its unfinished tail after the user has explicitly replaced that activity.
    if (slotStart < startMs) retainedSlots.push({ ...slot, endAt: startIso, updatedAt });
  }
  retainedSlots.push({
    id: makeId("companion-follow"),
    ownerType: "character",
    ownerId: characterId,
    startAt: startIso,
    endAt: endIso,
    title,
    plannedLocationId: locationId,
    plannedLocationName: locationName,
    kind: "free-time",
    source: input.slotSource ?? "manual",
    updatedAt,
  });
  const existing = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
  const nextActor = {
    ...(existing ?? { ownerType: "character" as const, ownerId: characterId }),
    activity: title,
    actualLocationId: locationId,
    actualLocationName: locationName,
    actualLocationUntil: endIso,
    locationSource: input.locationSource ?? ("companion" as const),
    manualSetAt: undefined,
    updatedAt,
  };
  return {
    ...state,
    schedules: retainedSlots,
    actorStates: [...state.actorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)), nextActor],
  };
}
/**
 * Characters own no manual location override: a player-picked position is always
 * expressed as a schedule slot, so the plan and the actual location stay equal.
 * stay-* inserts a time-bounded protected `companion-follow-*` slot, pin keeps
 * that slot until the next protected plan (or the end of the day), and follow
 * cancels the not-yet-ended companion segments and returns to the current plan.
 */
export function moveCharacterBySchedule(
  state: VirtualLifeState,
  input: {
    characterId: string;
    locationId: string;
    locationName: string;
    mode: "stay-30" | "stay-60" | "stay-120" | "pin" | "follow";
    now: Date;
  },
): { state: VirtualLifeState; error?: string } {
  const { characterId, locationId, locationName, mode } = input;
  const nowDate = input.now;
  const nowMs = nowDate instanceof Date ? nowDate.getTime() : Number.NaN;
  if (!characterId || !Number.isFinite(nowMs)) return { state, error: "缺少有效的角色或时间。" };
  const nowIso = nowDate.toISOString();
  const locations = state.locations ?? [];
  const residence = locations.find(location => location.id === "home-" + characterId)
    ?? locations.find(location => (location.residents ?? []).includes(characterId));
  const isCompanionSegment = (slot: LifeScheduleSlot) =>
    slot.ownerType === "character"
    && slot.ownerId === characterId
    && slot.id.startsWith("companion-follow-");

  if (mode === "follow") {
    // Only unfinished companion segments are cancelled; elapsed ones stay as history.
    const schedules = state.schedules.filter(slot => {
      if (!isCompanionSegment(slot)) return true;
      const endMs = new Date(slot.endAt).getTime();
      return !Number.isFinite(endMs) || endMs <= nowMs;
    });
    const nextState = schedules.length === state.schedules.length ? state : { ...state, schedules };
    const current = getCurrentActorSchedule(nextState, "character", characterId, nowDate);
    const plannedId = current?.plannedLocationId ?? "";
    const target = plannedId
      ? {
          id: plannedId,
          name: (current?.plannedLocationName ?? "").trim()
            || (nextState.locations ?? []).find(location => location.id === plannedId)?.name
            || plannedId,
        }
      : residence ? { id: residence.id, name: residence.name } : undefined;
    if (!target) return { state: nextState, error: "找不到可恢复的日程地点。" };
    return {
      state: upsertActorState(nextState, {
        ownerType: "character",
        ownerId: characterId,
        activity: current?.title ?? findActorState(nextState, "character", characterId)?.activity ?? "自由活动",
        scheduleSlotId: current?.id ?? null,
        actualLocationId: target.id,
        actualLocationName: target.name,
        actualLocationUntil: null,
        locationSource: "schedule",
        manualSetAt: undefined,
        manualPinned: undefined,
        updatedAt: nowIso,
      }),
    };
  }

  if (!locationId || !locationName) return { state, error: "缺少有效的目的地。" };
  const stayMinutes = mode === "stay-30" ? 30 : mode === "stay-60" ? 60 : mode === "stay-120" ? 120 : 0;
  const ownerSlots = state.schedules.filter(slot => slot.ownerType === "character" && slot.ownerId === characterId && !isCompanionSegment(slot));
  let requestedEndMs = nowMs + stayMinutes * 60_000;
  if (mode === "pin") {
    // 一直停留：到下一段受保护日程（约会 / 事件 / 用户手写安排）开始为止；没有则到当天结束。
    const protectedStarts = ownerSlots
      .filter(slot => slot.kind === "appointment" || slot.source === "event" || (slot.source === "manual" && slot.kind !== "free-time"))
      .map(slot => new Date(slot.startAt).getTime())
      .filter(startMs => Number.isFinite(startMs) && startMs > nowMs)
      .sort((a, b) => a - b);
    if (protectedStarts.length) {
      requestedEndMs = protectedStarts[0];
    } else {
      const dayEnd = new Date(nowDate);
      dayEnd.setHours(23, 59, 0, 0);
      // 23:59 已过（深夜）时停到当天结束的午夜，保证时段仍然有效。
      if (dayEnd.getTime() > nowMs) requestedEndMs = dayEnd.getTime();
      else {
        const midnight = new Date(nowDate);
        midnight.setHours(24, 0, 0, 0);
        requestedEndMs = midnight.getTime();
      }
    }
  }
  // 不跨越已有安排：与当前日程的第一个未来边界（当前时段结束 / 下一时段开始）取较早者。
  const firstBoundaryMs = ownerSlots
    .flatMap(slot => [new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime()])
    .filter(boundaryMs => Number.isFinite(boundaryMs) && boundaryMs > nowMs)
    .sort((a, b) => a - b)[0];
  const endMs = typeof firstBoundaryMs === "number" ? Math.min(requestedEndMs, firstBoundaryMs) : requestedEndMs;
  if (!Number.isFinite(endMs) || endMs <= nowMs) return { state, error: "日程时间无效，结束时间必须晚于开始时间。" };

  // 上一次“停留”是系统写入的同行段：再次改地点时先把它收束到此刻，否则会被当成
  // 外来手动安排而永久冲突。真正的约会 / 事件 / 用户安排仍会阻止插入。
  const baseState: VirtualLifeState = {
    ...state,
    schedules: state.schedules.flatMap(slot => {
      if (!isCompanionSegment(slot)) return [slot];
      const slotStart = new Date(slot.startAt).getTime();
      const slotEnd = new Date(slot.endAt).getTime();
      if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd <= nowMs) return [slot];
      return slotStart < nowMs ? [{ ...slot, endAt: nowIso, updatedAt: nowIso }] : [];
    }),
  };
  const slot: LifeScheduleSlot = {
    id: "companion-follow-" + characterId + "-" + Date.now(),
    ownerType: "character",
    ownerId: characterId,
    startAt: nowIso,
    endAt: new Date(endMs).toISOString(),
    title: "你在" + locationName,
    kind: "special",
    source: "manual",
    plannedLocationId: locationId,
    plannedLocationName: locationName,
    updatedAt: nowIso,
  };
  const inserted = insertManualLifeScheduleSlot(baseState, slot);
  if (inserted.error) return { state, error: inserted.error };
  if (inserted.conflict) {
    return { state, error: "该时段与「" + inserted.conflict.title + "」冲突，暂时无法安排停留。" };
  }
  return {
    state: upsertActorState(inserted.state, {
      ownerType: "character",
      ownerId: characterId,
      activity: slot.title,
      scheduleSlotId: slot.id,
      actualLocationId: locationId,
      actualLocationName: locationName,
      actualLocationUntil: slot.endAt,
      locationSource: "schedule",
      manualSetAt: undefined,
      manualPinned: undefined,
      updatedAt: nowIso,
    }),
  };
}

export function upsertLifeEvent(state: VirtualLifeState, nextEvent: LifeEvent): VirtualLifeState {
  return { ...state, events: [...state.events.filter(event => event.id !== nextEvent.id), nextEvent].sort((a,b) => (a.startsAt || a.createdAt).localeCompare(b.startsAt || b.createdAt)) };
}
export function transitionLifeEvent(state: VirtualLifeState, eventId: string, nextStatus: LifeEvent["status"]): VirtualLifeState {
  const current = state.events.find(event => event.id === eventId);
  const allowed: Record<LifeEvent["status"], LifeEvent["status"][]> = { planned: ["confirmed","active","cancelled"], confirmed: ["active","cancelled"], active: ["completed","cancelled"], completed: [], cancelled: [] };
  if (!current || !allowed[current.status].includes(nextStatus)) return state;
  const now = new Date().toISOString();
  const updated = { ...current, status: nextStatus, updatedAt: now, ...(nextStatus === "completed" ? { completedAt: now } : {}), ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}) };
  return { ...state, events: state.events.map(event => event.id === eventId ? updated : event) };
}
export function transitionInvitation(state: VirtualLifeState, invitationId: string, action: "confirm" | "decline" | "cancel"): VirtualLifeState {
  const current = state.invitations.find(invite => invite.id === invitationId);
  if (!current || current.status !== "proposed") return state;
  const now = new Date().toISOString(), status: LifeInvitation["status"] = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
  const next = { ...current, status, updatedAt: now, ...(action === "confirm" ? { confirmedAt: now } : {}) };
  return { ...state, invitations: state.invitations.map(invite => invite.id === invitationId ? next : invite) };
}
export function upsertLifeScene(state: VirtualLifeState, scene: LifeSceneState): VirtualLifeState {
  return { ...state, scenes: [...state.scenes.filter(item => item.id !== scene.id), scene] };
}
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

/** Create an editable weekly baseline while preserving the owner's existing schedule blocks. */
export function generateWeeklyLifePlan(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  ownerName: string,
  weekStart: Date,
  defaultLocation?: { id: string; name: string },
  profile = "",
  includeSpecialEvents = true,
): VirtualLifeState {
  const currentLocations = state.locations ?? [];
  const playerHome = currentLocations.find(location => location.id === "home");
  // 家的解析泛化：角色可以住进玩家家、别的角色家（home-*）或自己独居。
  // 居住地 = 把该角色列为 residents 的 home 型地点；没有则视为独居（home-<id>）。
  const homeLocations = currentLocations.filter(location => location.id === "home" || location.id.startsWith("home-"));
  const livedHome = ownerType === "character" ? homeLocations.find(location => (location.residents ?? []).includes(ownerId)) : undefined;
  const livesWithPlayer = ownerType === "character" && Boolean(playerHome?.residents?.includes(ownerId));
  const personalHomeId = ownerType === "character" ? (livedHome ? livedHome.id : livesWithPlayer ? "home" : "home-" + ownerId) : "home";
  const personalHome: LifeLocation = currentLocations.find(location => location.id === personalHomeId) ?? {
    id: personalHomeId,
    name: ownerType === "character" ? ownerName + "的家" : "家",
    description: ownerType === "character" ? "角色自己的私人住处；可在玩家家的地点档案中设置同居。" : "你自己的家。",
    atmosphere: "熟悉、私密、可以放松的空间。",
    layout: "有自己的起居区域与休息空间。",
    props: ["沙发", "茶几", "水杯", "床头灯"],
    visibility: "private",
  };
  if (ownerType === "character") {
    const now = Date.now();
    const actorResidenceIds = new Set([
      "home-" + ownerId,
      ...currentLocations.filter(location => (location.residents ?? []).includes(ownerId)).map(location => location.id),
    ]);
    const migratedSchedules = state.schedules.map(slot => {
      const plannedId = slot.plannedLocationId ?? "";
      const unresolvedLegacyHome = !plannedId
        && ["家", "家里", "家中", "自己的家"].includes((slot.plannedLocationName ?? "").trim());
      // Migrate only the actor's canonical previous residence or an unresolved
      // legacy "home" label. Other known home IDs are explicit visit destinations.
      const actorOwnPreviousHome = Boolean(plannedId && actorResidenceIds.has(plannedId) && plannedId !== personalHomeId);
      return slot.ownerType === "character" && slot.ownerId === ownerId
        && new Date(slot.endAt).getTime() > now
        && (actorOwnPreviousHome || unresolvedLegacyHome)
        ? { ...slot, plannedLocationId: personalHomeId, plannedLocationName: personalHome.name }
        : slot;
    });
    const migratedLocations = currentLocations.some(location => location.id === personalHomeId) ? currentLocations : [...currentLocations, personalHome];
    if (migratedSchedules.some((slot,index) => slot !== state.schedules[index]) || migratedLocations !== currentLocations) {
      state = { ...state, schedules: migratedSchedules, locations: migratedLocations };
    }
  }
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const ownerSlots = state.schedules.filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId);
  const weekSlots = ownerSlots.filter(slot => {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    return Number.isFinite(slotStart) && Number.isFinite(slotEnd)
      && slotStart < end.getTime() && slotEnd > start.getTime();
  });

  // Fast-path a fully covered week. Partial legacy weeks continue through the
  // normal generator, which preserves existing slots and fills only the gaps.
  const coverage = weekSlots
    .map(slot => ({
      start: Math.max(start.getTime(), new Date(slot.startAt).getTime()),
      end: Math.min(end.getTime(), new Date(slot.endAt).getTime()),
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredUntil = start.getTime();
  for (const range of coverage) {
    if (range.start > coveredUntil) break;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= end.getTime()) return state;
  }

  const now = new Date().toISOString();
  const slots: LifeScheduleSlot[] = [];
  const profileText = profile.toLowerCase();
  const normalizeProfilePlace = (value: string) => value.toLocaleLowerCase().replace(/[\s\u3000·•/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "");
  const discoveredLocations: LifeLocation[] = [];
  const existingLocations = state.locations ?? [];
  let profilePreferredLocation: LifeLocation | undefined = existingLocations.find(location => Boolean(location.characterHabits?.[ownerId]?.trim()));
  const placeCue = /(?:常去|喜欢去|习惯去|经常去|偶尔去|常在|喜欢在|习惯在|经常在|工作地点(?:是|为)?|地点偏好[:：])\s*([^，。；;\n]{2,28})/g;
  const profilePlaceCandidates = [...profile.matchAll(placeCue)].map(match => (match[1] ?? "")
    .replace(/(看书|学习|散步|吃饭|喝咖啡|工作|上课|练习|休息|聊天|买花|买东西|逛街|读书|创作|然后|之后).*$/,"")
    .replace(/^[的在去到：:\s]+|[的了和及\s]+$/g,"").trim()).filter(name => name.length >= 2).slice(0, 5);
  for (const placeName of profilePlaceCandidates) {
    const key = normalizeProfilePlace(placeName);
    if (!key || /^(这里|那里|家里|家中|附近|外面|室内|户外|学校|公司|你身边|身旁|身边|周围|旁边|门口|屋内|房间)$/.test(key)) continue;
    const existing = [...existingLocations, ...discoveredLocations].find(location => {
      const names = [location.name, ...(location.aliases ?? [])].map(normalizeProfilePlace).filter(name => name.length >= 2);
      return names.includes(key) || names.some(name => key.length >= 3 && (key.includes(name) || name.includes(key)));
    });
    if (existing) {
      if (!profilePreferredLocation && existing.id !== "home") profilePreferredLocation = existing;
      continue;
    }
    const idBase = "place-" + key.slice(0, 32);
    let placeId = idBase, suffix = 2;
    while ([...state.locations, ...discoveredLocations].some(location => location.id === placeId)) placeId = idBase + "-" + suffix++;
    const discovered: LifeLocation = {
      id: placeId, name: placeName,
      description: "从角色卡或已绑定世界书中识别出的地点。请在地点库补充固定环境、空间布局与道具。",
      atmosphere: "", layout: "", props: [], aliases: [], visibility: "public",
    };
    discoveredLocations.push(discovered);
    if (!profilePreferredLocation) profilePreferredLocation = discovered;
  }
  const hash = [...ownerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) + start.getDate();
  const specialDay = ownerType === "character" && includeSpecialEvents && hash % 3 !== 0 ? hash % 7 : -1;
  const has = (...patterns: RegExp[]) => patterns.some(pattern => pattern.test(profileText));
  const student = has(/学生|大学|学校|上课|课程|考试|study|student|school|university/);
  const creative = has(/自由职业|艺术家|作家|画家|摄影|音乐|创作|设计师|创业|freelance|artist|writer|designer|creator/);
  const researcher = has(/研究员|研究者|学者|教授|实验|科学家|研究魔法|法师|魔法师|炼金|scholar|researcher|scientist|wizard|mage/);
  const dutyRole = has(/骑士|守卫|警察|保镖|军人|巡逻|护卫|猎人|knight|guard|soldier|police|hunter/);
  const professional = has(/医生|护士|医师|教师|老师|厨师|店员|服务员|经理|职员|上班|工作|doctor|nurse|teacher|chef|employee|manager/);
  const fantasyRole = has(/魔法|法术|修仙|仙人|妖怪|精灵|兽人|吸血鬼|狼人|龙族|骑士|王子|公主|王国|宫廷|中世纪|fantasy|vampire|werewolf|elf|dragon|medieval/);
  const specialTitle = has(/摄影|拍照|相机|photo|photographer/) ? "外出拍摄 / 整理照片"
    : has(/音乐|唱歌|乐器|作曲|music|singer|musician/) ? "练习音乐 / 听现场"
    : has(/运动|健身|跑步|篮球|足球|sport|fitness|runner/) ? "运动与放松"
    : has(/读书|阅读|写作|书店|学习|学生|book|study|student|writer/) ? "阅读、写作或学习"
    : has(/烹饪|做饭|料理|烘焙|cook|chef|baker/) ? "试做新菜 / 料理时间"
    : has(/游戏|电竞|game|gamer/) ? "游戏与休息"
    : "按角色兴趣安排的私人时间";
  const specialLocation = profilePreferredLocation ?? (has(/摄影|拍照|相机|运动|健身|跑步|photo|sport|fitness/) ? { id: "park", name: "公园" }
    : has(/读书|阅读|写作|学习|学生|book|study|student|writer/) ? { id: "library", name: "图书馆" }
    : has(/音乐|唱歌|乐器|music|singer|musician/) ? { id: "studio", name: "音乐 / 创作空间" }
    : has(/烹饪|做饭|料理|烘焙|cook|chef|baker/) ? personalHome
    : has(/游戏|电竞|game|gamer/) ? personalHome
    : defaultLocation ?? personalHome);
  const leisureLocation = ownerType === "character" ? (profilePreferredLocation ?? personalHome) : personalHome;
  const add = (day: Date, sh: number, sm: number, eh: number, em: number, title: string, kind: LifeScheduleSlot["kind"], location?: { id: string; name: string }) => {
    const from = new Date(day);
    from.setHours(sh, sm, 0, 0);
    const to = new Date(day);
    to.setHours(eh, em, 0, 0);
    if (to <= from) to.setDate(to.getDate() + 1);
    const loc = location ?? defaultLocation;
    slots.push({
      id: makeId("slot"), ownerType, ownerId, startAt: from.toISOString(), endAt: to.toISOString(),
      title, kind, source: "weekly-generation",
      plannedLocationId: loc?.id ?? null, plannedLocationName: loc?.name ?? null, updatedAt: now,
    });
  };

  // Use calendar-day arithmetic rather than adding 24 hours, so daylight-saving
  // transitions cannot shift the generated local schedule by an hour.
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    add(day, 0, 0, 7, 0, "睡眠", "habit", personalHome);
    add(day, 7, 0, 7, 30, "起床、洗漱", "habit", personalHome);
    add(day, 7, 30, 8, 0, "早餐", "meal", personalHome);
    if (!weekend) {
      const daytimeLocation = ownerType === "player" ? { id: "work", name: "工作地点" }
        : student ? { id: "school", name: "学校" }
        : researcher ? { id: "library", name: "图书馆 / 研究空间" }
        : dutyRole ? { id: "park", name: "巡逻 / 户外活动地点" }
        : creative ? (has(/音乐|唱歌|乐器|music|musician/) ? { id: "studio", name: "音乐 / 创作空间" } : { id: "cafe", name: "街角咖啡店" })
        : professional ? { id: "work", name: "工作地点" }
        : personalHome;
      if (daytimeLocation.id !== "home") add(day, 8, 0, 9, 0, student ? "前往学校" : researcher ? "前往研究空间" : dutyRole ? "准备外出 / 巡逻" : creative ? "前往工作 / 创作地点" : "通勤 / 前往当天安排", "commute", { id: "transit", name: "通勤途中" });
      const daytime = ownerType === "player" ? "工作 / 学习（可按自己的现实安排修改）"
        : student ? ownerName + "上课 / 学习"
        : researcher ? ownerName + (fantasyRole ? "研究知识 / 练习术法" : "研究 / 阅读 / 实验")
        : dutyRole ? ownerName + (fantasyRole ? "履行职责 / 巡逻" : "值勤 / 巡逻 / 处理事务")
        : creative ? ownerName + "的创作 / 项目时间"
        : professional ? ownerName + "的工作时段"
        : ownerName + "的个人安排 / 自由活动";
      add(day, 9, 0, 12, 0, daytime, ownerType === "player" ? "free-time" : (student || researcher || dutyRole || creative || professional) ? "work" : "free-time", daytimeLocation);
      add(day, 12, 0, 13, 0, "午餐 / 用餐休息", "meal", daytimeLocation.id === "home" ? personalHome : { id: "canteen", name: "食堂 / 附近餐馆" });
      const afternoonTitle = ownerType === "player" ? "下午安排（可自行修改）"
        : student ? ownerName + "的课程 / 自习"
        : researcher ? ownerName + (fantasyRole ? "继续研究 / 训练" : "继续研究 / 整理成果")
        : dutyRole ? ownerName + (fantasyRole ? "执行职责 / 训练" : "下午值勤 / 处理事务")
        : creative ? ownerName + "的创作 / 项目时间"
        : professional ? ownerName + "的工作时段"
        : ownerName + "的个人安排 / 自由活动";
      add(day, 13, 0, 18, 0, afternoonTitle, ownerType === "player" ? "free-time" : (student || researcher || dutyRole || creative || professional) ? "work" : "free-time", daytimeLocation);
    } else {
      add(day, 8, 0, 9, 0, "慢慢开始的一天", "free-time", personalHome);
      add(day, 9, 0, 12, 0, ownerType === "player" ? "周末自由安排" : ownerName + "的周末安排", "free-time", leisureLocation);
      add(day, 12, 0, 13, 0, "午餐", "meal", personalHome);
      add(day, 13, 0, 18, 0, "休闲 / 个人计划", "free-time", leisureLocation);
    }
    add(day, 18, 0, 19, 0, "晚餐", "meal", personalHome);
    if (offset === specialDay) {
      add(day, 19, 0, 19, 30, "回家 / 稍作休息", "free-time", personalHome);
      add(day, 19, 30, 20, 30, specialTitle, "special", specialLocation);
      add(day, 20, 30, 22, 0, "晚间自由时间", "free-time", personalHome);
    } else {
      add(day, 19, 0, 22, 0, ownerType === "player" ? "自由时间" : ownerName + "的私人时间", "free-time", personalHome);
    }
    add(day, 22, 0, 24, 0, "睡眠", "habit", personalHome);
  }

  const occupied = weekSlots
    .map(slot => ({ start: new Date(slot.startAt).getTime(), end: new Date(slot.endAt).getTime() }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const generated: LifeScheduleSlot[] = [];
  for (const template of slots) {
    const templateStart = new Date(template.startAt).getTime();
    const templateEnd = new Date(template.endAt).getTime();
    let cursor = templateStart;
    let part = 0;
    for (const range of occupied) {
      if (range.end <= cursor) continue;
      if (range.start >= templateEnd) break;
      if (range.start > cursor) {
        const partEnd = Math.min(range.start, templateEnd);
        if (partEnd > cursor) {
          generated.push({
            ...template,
            id: part === 0 && partEnd === templateEnd ? template.id : template.id + "-part-" + part,
            startAt: new Date(cursor).toISOString(),
            endAt: new Date(partEnd).toISOString(),
          });
          part++;
        }
      }
      cursor = Math.max(cursor, range.end);
      if (cursor >= templateEnd) break;
    }
    if (cursor < templateEnd) {
      generated.push({
        ...template,
        id: part === 0 && cursor === templateStart ? template.id : template.id + "-part-" + part,
        startAt: new Date(cursor).toISOString(),
        endAt: template.endAt,
      });
    }
  }

  if (generated.length === 0) return state;

  // The location library is the source of truth. Every generated itinerary slot
  // first resolves to an existing canonical place (name/alias/id); only genuinely
  // new places are added to the library. This prevents "library / study room"
  // from becoming a new duplicate every time a plan is generated.
  const normalizePlace = (value: string) => value.toLocaleLowerCase()
    .replace(/[\s\u3000·•/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "");
  const canonicalAliases: Record<string, string[]> = {
    home: ["家", "家里", "住所", "住处", "home"],
    cafe: ["咖啡店", "咖啡馆", "街角咖啡店", "cafe", "coffee shop"],
    park: ["公园", "户外活动地点", "运动场地", "park"],
    library: ["图书馆", "研究空间", "研究室", "图书馆研究空间", "library"],
    school: ["学校", "校园", "教室", "school"],
    work: ["工作地点", "办公室", "工作室", "公司", "workplace", "office"],
    transit: ["通勤途中", "通勤", "路上", "交通途中", "transit"],
    canteen: ["食堂", "附近餐馆", "餐馆", "餐厅", "饭店", "canteen"],
    studio: ["音乐创作空间", "音乐空间", "创作空间", "录音室", "studio"],
  };
  const locations: LifeLocation[] = [
    ...existingLocations,
    ...(existingLocations.some(location => location.id === personalHome.id) ? [] : [personalHome]),
    ...discoveredLocations,
  ];
  const resolveCanonical = (slot: LifeScheduleSlot): LifeScheduleSlot => {
    const rawName = (slot.plannedLocationName ?? "").trim();
    if (!rawName || /跟随玩家的实际地点|地点待定|未知地点/i.test(rawName)) return slot;
    const byId = locations.find(location => location.id === slot.plannedLocationId);
    const normalizedName = normalizePlace(rawName);
    const byName = locations.find(location => {
      const candidates = [location.name, ...(location.aliases ?? []), ...(canonicalAliases[location.id] ?? [])].map(normalizePlace);
      if (candidates.includes(normalizedName)) return true;
      // Match descriptive variants only when one side is a known canonical alias
      // and the other adds a qualifier such as "图书馆 / 研究空间".
      return candidates.some(alias => alias.length >= 2 && normalizedName.length > alias.length
        && (normalizedName.startsWith(alias) || normalizedName.endsWith(alias))
        && (/[\\/／、，,·]/.test(rawName) || /研究空间|附近餐馆|户外活动地点|创作空间/.test(rawName)));
    });
    let canonical = byId ?? byName;
    if (!canonical) {
      const slug = normalizedName.slice(0, 32) || "new-place";
      const baseId = "place-" + slug;
      let newId = baseId, suffix = 2;
      while (locations.some(location => location.id === newId)) newId = baseId + "-" + suffix++;
      canonical = {
        id: newId,
        name: rawName,
        description: "由角色日程首次发现的地点。请在地点库中补充环境描写、固定布局与可用道具。",
        atmosphere: "",
        layout: "",
        props: [],
        aliases: [],
        visibility: "public",
      };
      locations.push(canonical);
    }
    return { ...slot, plannedLocationId: canonical.id, plannedLocationName: canonical.name };
  };
  const canonicalGenerated = generated.map(resolveCanonical);
  return overlayScheduleSlotsOverFreeTime({ ...state, locations }, canonicalGenerated);
}
/**
 * Catch up one actor to the current real time. Every completed schedule slot is
 * settled idempotently, and the current slot updates their real activity/location.
 * This runs on app resume and scheduled real-time refreshes; it never advances another actor.
 */
/**
 * Keep schedule place references canonical and make every itinerary place discoverable
 * in the editable location library. Match existing names/aliases case-insensitively;
 * never overwrite user-authored location metadata or remove existing locations.
 */
export function syncScheduleLocationsToLibrary(state: VirtualLifeState): VirtualLifeState {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const locations = [...(state.locations ?? [])];
  const byId = new Map(locations.map(location => [location.id, location]));
  const findByName = (name: string) => {
    const key = normalize(name);
    const matches = (location: LifeLocation) => normalize(location.name) === key
      || (location.aliases ?? []).some(alias => normalize(alias) === key);
    // Prefer a rich imported/manual dossier over an older schedule-only stub.
    return locations.find(location => !location.id.startsWith("schedule-place-") && matches(location))
      ?? locations.find(matches);
  };
  let changed = false;
  const idRemap = new Map<string, string>();
  const resolveSchedulePlaceholder = (locationId: string | null | undefined, locationName: string | null | undefined) => {
    if (!locationId?.startsWith("schedule-place-")) return undefined;
    const oldLocation = byId.get(locationId);
    const target = findByName((locationName ?? oldLocation?.name ?? "").trim());
    return target && target.id !== locationId ? target : undefined;
  };
  const schedules = state.schedules.map(slot => {
    // A deleted destination is intentionally detached from the library. Keep the
    // historical name on the itinerary, but never recreate it from this snapshot.
    if (slot.plannedLocationDeleted) return slot;
    const name = (slot.plannedLocationName ?? "").trim();
    if (!name) return slot;
    let location = slot.plannedLocationId ? byId.get(slot.plannedLocationId) : undefined;
    const namedLocation = findByName(name);
    if (!location || (location.id.startsWith("schedule-place-") && namedLocation && namedLocation.id !== location.id)) {
      location = namedLocation;
    }
    if (!location) {
      const base = "schedule-place-" + normalize(name).normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || "place";
      let id = base;
      let suffix = 2;
      while (byId.has(id)) id = base + "-" + suffix++;
      location = {
        id, name, description: "由角色日程自动同步建立；可在地点库中继续编辑。",
        atmosphere: "", layout: "", props: [], visibility: "public" as const,
      };
      locations.push(location);
      byId.set(id, location);
      changed = true;
    }
    const canonicalName = location.name;
    if (slot.plannedLocationId && slot.plannedLocationId !== location.id && slot.plannedLocationId.startsWith("schedule-place-")) {
      idRemap.set(slot.plannedLocationId, location.id);
    }
    if (slot.plannedLocationId !== location.id || slot.plannedLocationName !== canonicalName) {
      changed = true;
      return { ...slot, plannedLocationId: location.id, plannedLocationName: canonicalName };
    }
    return slot;
  });
  const actorStates = (state.actorStates ?? []).map(actor => {
    const locationId = actor.actualLocationId ?? "";
    const target = idRemap.has(locationId)
      ? byId.get(idRemap.get(locationId)!)
      : resolveSchedulePlaceholder(locationId, actor.actualLocationName);
    if (!target || target.id === locationId) return actor;
    changed = true;
    return { ...actor, actualLocationId: target.id, actualLocationName: target.name };
  });
  const scenes = (state.scenes ?? []).map(scene => {
    if (scene.status === "completed") return scene;
    const target = idRemap.has(scene.locationId)
      ? byId.get(idRemap.get(scene.locationId)!)
      : resolveSchedulePlaceholder(scene.locationId, scene.locationName);
    if (!target || target.id === scene.locationId) return scene;
    changed = true;
    return { ...scene, locationId: target.id, locationName: target.name };
  });
  return changed ? { ...state, locations, schedules, actorStates, scenes } : state;
}

/** 「临时起意」命中概率：角色按日程搬迁时，有一定概率先改去别处一段时间。 */
export const SPONTANEOUS_DEVIATION_PROBABILITY = 0.3;
/** 临时起意窗口的最短 / 最长分钟数；时段剩余不足最短值时直接跳过。 */
export const SPONTANEOUS_DEVIATION_MIN_MINUTES = 20;
export const SPONTANEOUS_DEVIATION_MAX_MINUTES = 45;
const SPONTANEOUS_DEVIATION_DAILY_LIMIT_DEFAULT = 2;
const SPONTANEOUS_DEVIATION_DAILY_LIMIT_CAP = 5;

/** FNV-1a 32 位字符串哈希：同一输入永远得到同一结果，不依赖运行环境随机源。 */
function hashLifeSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** mulberry32：以固定种子生成 [0,1) 伪随机序列，反复结算得到同一串数值。 */
function createLifeSeededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** 本地日历日 key（YYYY-MM-DD），让「每天最多几次」按角色所在时区自然跨天。 */
function lifeLocalDayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function resolveDeviationDailyLimit(settings: VirtualLifeState["settings"] | undefined): number {
  const configured = settings?.deviationDailyLimit;
  if (typeof configured !== "number" || !Number.isFinite(configured)) return SPONTANEOUS_DEVIATION_DAILY_LIMIT_DEFAULT;
  return Math.max(0, Math.min(SPONTANEOUS_DEVIATION_DAILY_LIMIT_CAP, Math.floor(configured)));
}

type SpontaneousDeviationPlan = {
  locationId: string;
  locationName: string;
  until: string;
  dayKey: string;
  count: number;
};

/**
 * 判断当前时段是否发生一次「临时起意」。随机种子固定为
 * hash(actorId + slot.id + 当天日期)，因此同一角色、同一时段、同一天内反复结算
 * 得到完全一致的结果；当天已触发次数由 actor 上的 deviationDayKey/deviationCount 持久化。
 * 返回 undefined 时保持原有日程行为。
 */
function planSpontaneousDeviation(input: {
  state: VirtualLifeState;
  actor: LifeActorState | undefined;
  slot: LifeScheduleSlot | undefined;
  now: Date;
}): SpontaneousDeviationPlan | undefined {
  const { state, actor, slot, now } = input;
  // 只有角色（不是玩家）会「临时起意」，且必须存在正在执行的日程时段。
  if (!actor || actor.ownerType !== "character" || !slot) return undefined;
  if (state.settings?.enableSpontaneousDeviation === false) return undefined;
  const dailyLimit = resolveDeviationDailyLimit(state.settings);
  if (dailyLimit <= 0) return undefined;
  // 本时段已经临时起意过一次：窗口结束后回到计划，而不是立刻再次偏离。
  if (actor.locationSource === "spontaneous" && actor.scheduleSlotId === slot.id) return undefined;
  const nowMs = now.getTime();
  const slotEndMs = new Date(slot.endAt).getTime();
  if (!Number.isFinite(nowMs) || !Number.isFinite(slotEndMs)) return undefined;
  // 窗口必须完整落在当前时段内：剩余不足 20 分钟就不打扰计划。
  if (slotEndMs - nowMs < SPONTANEOUS_DEVIATION_MIN_MINUTES * 60_000) return undefined;
  const dayKey = lifeLocalDayKey(now);
  const usedToday = actor.deviationDayKey === dayKey ? Math.max(0, actor.deviationCount ?? 0) : 0;
  if (usedToday >= dailyLimit) return undefined;
  const random = createLifeSeededRandom(hashLifeSeed(actor.ownerId + "/" + slot.id + "/" + dayKey));
  if (random() >= SPONTANEOUS_DEVIATION_PROBABILITY) return undefined;
  const durationMinutes = SPONTANEOUS_DEVIATION_MIN_MINUTES
    + Math.floor(random() * (SPONTANEOUS_DEVIATION_MAX_MINUTES - SPONTANEOUS_DEVIATION_MIN_MINUTES + 1));
  const untilMs = Math.min(slotEndMs, nowMs + durationMinutes * 60_000);
  if (untilMs - nowMs < SPONTANEOUS_DEVIATION_MIN_MINUTES * 60_000) return undefined;
  // 只去公开地点，并且不去日程原本安排的地点。
  const plannedLocationId = slot.plannedLocationId ?? "";
  const candidates = (state.locations ?? []).filter(location => location.visibility === "public" && location.id !== plannedLocationId);
  if (!candidates.length) return undefined;
  const target = candidates[Math.floor(random() * candidates.length)];
  return {
    locationId: target.id,
    locationName: target.name,
    until: new Date(untilMs).toISOString(),
    dayKey,
    count: usedToday + 1,
  };
}

export function settleActorTimelineToNow(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  realNow = new Date(),
): VirtualLifeState {
  // Synchronize places referenced by schedules before resolving today's active slot.
  // Only the slot active at realNow can affect position; future plans never teleport actors.
  state = syncScheduleLocationsToLibrary(state);
  const nowIso = realNow.toISOString();
  const formatScheduleTime = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : value;
  };
  let events = state.events;
  let memories = state.memories;
  let invitations = state.invitations;
  let scenes = state.scenes;
  const settledKeys = new Set(events.map(event => event.settlementKey).filter(Boolean));
  for (const slot of state.schedules) {
    if (slot.ownerType !== ownerType || slot.ownerId !== ownerId) continue;
    const endMs = new Date(slot.endAt).getTime();
    if (!Number.isFinite(endMs) || endMs > realNow.getTime()) continue;
    const settlementKey = "schedule:" + slot.id;
    if (settledKeys.has(settlementKey)) continue;
    const event: LifeEvent = {
      id: "life-slot-" + slot.id,
      kind: "activity",
      status: "completed",
      startsAt: slot.startAt,
      endsAt: slot.endAt,
      locationId: slot.plannedLocationId ?? undefined,
      locationName: slot.plannedLocationName ?? undefined,
      participantIds: [ownerId],
      title: slot.title,
      details: "日程时间：" + formatScheduleTime(slot.startAt) + " 至 " + formatScheduleTime(slot.endAt) + "。该时段已按个人时间线经过并结算；此记录只确认计划时段结束，不确认活动中的其他细节。",
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: nowIso,
      settlementKey,
    };
    events = [...events, event];
    settledKeys.add(settlementKey);
  }
  for (const event of [...events]) {
    if (event.kind !== "invitation" || (event.status !== "confirmed" && event.status !== "active") || !event.startsAt || !event.endsAt) continue;
    const allAtOrAfter = (iso: string) => event.participantIds.every(participantId => {
      const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
      return resolveActorLifeNow(getActorClock(state, participantType, participantId), realNow).getTime() >= new Date(iso).getTime();
    });
    const started = allAtOrAfter(event.startsAt);
    const ended = allAtOrAfter(event.endsAt);

    // Invitations describe an activity at a location; they do not own a separate
    // chat room. Reuse the location's canonical room (including legacy event rooms)
    // and keep its active/paused state untouched so schedule settlement cannot
    // steal the room the user is currently viewing.
    const playerPresence = findActorState(state, "player", "player");
    const characterPresence = event.participantIds
      .filter(participantId => participantId !== "player")
      .map(participantId => findActorState(state, "character", participantId))
      .find(Boolean);
    const eventLocation = state.locations.find(location => location.id === event.locationId)
      ?? state.locations.find(location => location.name === event.locationName || (location.aliases ?? []).includes(event.locationName || ""));
    const locationId = eventLocation?.id ?? event.locationId ?? playerPresence?.actualLocationId ?? characterPresence?.actualLocationId ?? "home";
    const locationName = eventLocation?.name
      ?? event.locationName
      ?? playerPresence?.actualLocationName
      ?? characterPresence?.actualLocationName
      ?? "家";
    const matchingScene = findLifeSceneForLocation(
      scenes,
      locationId,
      eventLocation || event.locationId ? undefined : event.locationName || locationName,
    );

    if (started && event.details !== "follow-player") {
      const eventParticipants: LifeSceneParticipant[] = event.participantIds.map(participantId => {
        const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
        return {
          ownerType: participantType,
          ownerId: participantId,
          activity: event.title,
          awarenessByActorId: Object.fromEntries(
            event.participantIds.filter(otherId => otherId !== participantId).map(otherId => [otherId, "aware" as const]),
          ),
        };
      });
      if (matchingScene) {
        const updatedScene: LifeSceneState = {
          ...matchingScene,
          locationId,
          locationName,
          // eventId is legacy metadata only; clear it when folding an old event room
          // back into the single canonical room for this location.
          eventId: undefined,
          status: matchingScene.status === "completed" ? "paused" : matchingScene.status,
          participants: mergeLifeSceneParticipants(matchingScene.participants, eventParticipants),
          updatedAt: nowIso,
        };
        if (updatedScene !== matchingScene) {
          scenes = scenes.map(scene => scene.id === matchingScene.id ? updatedScene : scene);
        }
      } else {
        const locationScene: LifeSceneState = {
          id: makeId("scene"),
          locationId,
          locationName,
          startedAt: event.startsAt,
          updatedAt: nowIso,
          // A scheduled activity must not become the user's foreground room.
          status: "paused",
          participants: eventParticipants,
          lastSettledEventIds: [],
        };
        scenes = [...scenes, locationScene];
      }
    }

    if (ended) {
      const actuallyOccurred = event.details === "follow-player"
        ? event.status === "active" && !!findActorState(state, "player", "player")?.actualLocationId
        : event.status === "active" || !!matchingScene || started;
      const nextStatus = actuallyOccurred ? "completed" as const : "cancelled" as const;
      const updated = { ...event, status: nextStatus, updatedAt: nowIso, ...(actuallyOccurred ? { completedAt: nowIso } : { cancelledAt: nowIso }), settlementKey: "invitation:" + event.id, details: actuallyOccurred ? event.details : "missed:no-shared-scene-before-end" };
      events = events.map(item => item.id === event.id ? updated : item);
      invitations = invitations.map(invite => invite.eventId === event.id ? { ...invite, status: actuallyOccurred ? "completed" as const : "cancelled" as const, updatedAt: nowIso } : invite);
      const memoryId = "memory-" + event.id;
      if (actuallyOccurred && state.settings.saveConfirmedEventsToMemory && !memories.some(memory => memory.id === memoryId)) {
        memories = [{
          id: memoryId, eventId: event.id, occurredAt: event.endsAt, participants: event.participantIds,
          fact: (event.details === "follow-player" ? "角色陪伴并跟随玩家完成了约定时段" : "双方共同完成约定活动") + "「" + event.title + "」" + (event.locationName ? "，地点：" + event.locationName : "") + "。",
        }, ...memories].slice(0, 500);
      }
    } else if (started && event.status === "confirmed") {
      events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
    }
  }
  const current = getCurrentActorSchedule(state, ownerType, ownerId, realNow);
  const previous = findActorState(state, ownerType, ownerId);
  const slotChanged = !!current && previous?.scheduleSlotId !== current.id;
  // The current real-time slot drives routine movement. Respect a manual stay
  // only until its explicit expiry; never apply a future slot before its start time.
  const stayExpired = !!previous?.actualLocationUntil && new Date(previous.actualLocationUntil).getTime() <= realNow.getTime();
  const activeAppointment = current?.kind === "appointment" && current.source === "event"
    ? events.find(event =>
        event.kind === "invitation"
        && event.status === "active"
        && event.details !== "follow-player"
        && event.participantIds.includes(ownerId)
        && !!event.startsAt && !!event.endsAt
        && new Date(event.startsAt).getTime() <= realNow.getTime()
        && new Date(event.endsAt).getTime() > realNow.getTime()
      )
    : undefined;
  // A missing current slot must clear the old slot reference. Otherwise deleting
  // or editing a schedule can leave an actor permanently attached to stale activity.
  const manualStayActive = !!previous?.actualLocationUntil && new Date(previous.actualLocationUntil).getTime() > realNow.getTime();
  // 手动地点的有效期：只看 locationSource/manualSetAt（仅手动写入时设置、结算永不刷新），
  // 不再用 updatedAt 或 actual!=planned 推断——否则日程自己搬迁会被误判成手动覆盖，
  // 而 settle 刷新 updatedAt 又会让覆盖无限续期。
  const manualOverrideActive = isManualLocationOverrideActive(previous, realNow);
  const manualOverrideExpired = !manualOverrideActive && isManualLocationOverrideExpired(previous, realNow);
  // 到期后落到当前日程地点；没有 current slot 时回落到住处（玩家为默认家，角色为
  // home-<id>），再退化为原地。这样即使日程刚被删除，过期的手动地点也会解除。
  const residenceFallback = ownerType === "player"
    ? state.locations.find(location => location.id === "home") ?? state.locations.find(location => location.residents?.includes(ownerId))
    : state.locations.find(location => location.id === "home-" + ownerId) ?? state.locations.find(location => location.residents?.includes(ownerId));
  const expiredOverrideLocationId = current
    ? current.plannedLocationId ?? previous?.actualLocationId ?? null
    : residenceFallback?.id ?? previous?.actualLocationId ?? null;
  const expiredOverrideLocationName = current
    ? current.plannedLocationName ?? previous?.actualLocationName ?? null
    : residenceFallback?.name ?? previous?.actualLocationName ?? null;
  const scheduleMovementDue = !manualStayActive && !manualOverrideActive
    && (manualOverrideExpired || Boolean(current && (slotChanged || stayExpired || !previous?.actualLocationId)));
  let nextActivity = activeAppointment
    ? current.title
    : manualStayActive || manualOverrideActive
      ? previous?.activity ?? current?.title ?? "自由活动"
      : scheduleMovementDue || stayExpired
        ? current?.title ?? "自由活动"
        : current && slotChanged
          ? current.title
          : !current && previous?.scheduleSlotId
            ? "自由活动"
            : previous?.activity ?? current?.title ?? "自由活动";
  let nextLocationId = activeAppointment
    ? current?.plannedLocationId ?? previous?.actualLocationId ?? null
    : scheduleMovementDue
      ? manualOverrideExpired
        ? expiredOverrideLocationId
        : current?.plannedLocationId ?? previous?.actualLocationId ?? null
      : previous?.actualLocationId ?? current?.plannedLocationId ?? null;
  let nextLocationName = activeAppointment
    ? current?.plannedLocationName ?? previous?.actualLocationName ?? null
    : scheduleMovementDue
      ? manualOverrideExpired
        ? expiredOverrideLocationName
        : current?.plannedLocationName ?? previous?.actualLocationName ?? null
      : previous?.actualLocationName ?? current?.plannedLocationName ?? null;
  let nextLocationUntil = activeAppointment
    ? current?.endAt ?? previous?.actualLocationUntil ?? null
    : scheduleMovementDue ? null : previous?.actualLocationUntil ?? null;
  const nextSlotId = current?.id ?? null;
  // 写回时只保留既有 manualSetAt（绝不刷新），并按这次位置的来源打标。
  let nextLocationSource: LifeActorState["locationSource"] = activeAppointment
    ? "appointment"
    : scheduleMovementDue
      ? "schedule"
      : manualOverrideActive
        ? "manual"
        : manualStayActive
          ? previous?.locationSource === "stay" || previous?.locationSource === "companion" || previous?.locationSource === "appointment"
            ? previous.locationSource
            : "stay"
          : previous?.locationSource;
  // 「临时起意」只在角色走按日程搬迁分支时评估：没有约会、临时停留或手动地点
  // 覆盖，并且确实有正在执行的日程时段。日程本身永远不改，只改变实际位置。
  const deviation = !activeAppointment && !manualStayActive && !manualOverrideActive && scheduleMovementDue
    ? planSpontaneousDeviation({ state, actor: previous, slot: current, now: realNow })
    : undefined;
  let nextDeviationDayKey = previous?.deviationDayKey;
  let nextDeviationCount = previous?.deviationCount;
  if (deviation) {
    nextActivity = "临时起意：去" + deviation.locationName;
    nextLocationId = deviation.locationId;
    nextLocationName = deviation.locationName;
    nextLocationUntil = deviation.until;
    nextLocationSource = "spontaneous";
    nextDeviationDayKey = deviation.dayKey;
    nextDeviationCount = deviation.count;
  }
  const nextManualSetAt = nextLocationSource === "manual" ? previous?.manualSetAt : undefined;
  // 固定停留只在手动地点生效；切到日程/约会/陪伴后立即失效，避免以后误判为永不过期。
  const nextManualPinned = nextLocationSource === "manual" ? previous?.manualPinned : undefined;
  const actorChanged = !previous || previous.activity !== nextActivity || (previous.actualLocationId ?? null) !== nextLocationId || (previous.actualLocationName ?? null) !== nextLocationName || (previous.actualLocationUntil ?? null) !== nextLocationUntil || (previous.scheduleSlotId ?? null) !== nextSlotId || (previous.locationSource ?? null) !== (nextLocationSource ?? null) || (previous.manualSetAt ?? null) !== (nextManualSetAt ?? null) || (previous.manualPinned ?? null) !== (nextManualPinned ?? null) || (previous.deviationDayKey ?? null) !== (nextDeviationDayKey ?? null) || (previous.deviationCount ?? null) !== (nextDeviationCount ?? null);
  const actorStates = actorChanged
    ? [...state.actorStates.filter(actor => !(actor.ownerType === ownerType && actor.ownerId === ownerId)), {
        ...(previous ?? {}),
        ownerType, ownerId, activity: nextActivity, scheduleSlotId: nextSlotId,
        actualLocationId: nextLocationId, actualLocationName: nextLocationName,
        actualLocationUntil: nextLocationUntil,
        locationSource: nextLocationSource, manualSetAt: nextManualSetAt, manualPinned: nextManualPinned,
        deviationDayKey: nextDeviationDayKey, deviationCount: nextDeviationCount,
        updatedAt: nowIso,
      }]
    : state.actorStates;
  let timeline = state.timeline;
  if ((stayExpired || manualOverrideExpired) && ownerType === "player" && nextLocationId && nextLocationName && previous?.actualLocationId !== nextLocationId) {
    // Timeline/presence follows the schedule, but the location room is a separate
    // durable history and must never be renamed or moved by schedule settlement.
    timeline = [...timeline, {
      id: makeId("timeline"),
      category: "location",
      occurredAt: realNow.toISOString(),
      recordedAt: nowIso,
      title: "按原计划前往" + nextLocationName,
      details: "临时停留时间已结束，生活行程恢复执行。",
      actorId: ownerId,
      actorName: state.settings.playerDisplayName || "我",
      locationName: nextLocationName,
    }];
  }
  let finalActorStates = actorStates;
  for (const event of events) {
    if (event.kind !== "invitation" || event.status !== "active" || event.details !== "follow-player") continue;
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    const playerState = finalActorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const characterState = finalActorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
    if (!characterId || !playerState?.actualLocationId || !playerState.actualLocationName || !characterState) continue;
    if (characterState.actualLocationId === playerState.actualLocationId
      && characterState.activity === "正在陪伴玩家"
      && characterState.actualLocationUntil === event.endsAt
      && characterState.locationSource === "companion") continue;
    finalActorStates = [
      ...finalActorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)),
      {
        ...characterState,
        activity: "正在陪伴玩家",
        actualLocationId: playerState.actualLocationId,
        actualLocationName: playerState.actualLocationName,
        actualLocationUntil: event.endsAt,
        locationSource: "companion",
        manualSetAt: undefined,
        updatedAt: nowIso,
      },
    ];
  }
  if (events === state.events && memories === state.memories && invitations === state.invitations && scenes === state.scenes && finalActorStates === state.actorStates && timeline === state.timeline) return state;
  return { ...state, events, memories, invitations, scenes, actorStates: finalActorStates, timeline, updatedAt: nowIso };
}

export function getCurrentActorSchedule(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, at: Date) {
  const time = at.getTime();
  return state.schedules
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .filter(slot => {
      const start = new Date(slot.startAt).getTime();
      const end = new Date(slot.endAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && start <= time && end > time;
    })
    // If legacy data contains overlaps, the most recently started slot wins
    // deterministically instead of whichever item happened to be stored first.
    .sort((a, b) =>
      new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
      || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      || a.id.localeCompare(b.id)
    )[0];
}
export function makeLifeInvitation(state: VirtualLifeState, input: Omit<LifeInvitation,"id"|"status"|"updatedAt">): VirtualLifeState {
  const now = new Date().toISOString(), invitation: LifeInvitation = { ...input, id: makeId("invite"), status: "proposed", updatedAt: now };
  return { ...state, invitations: [invitation,...state.invitations] };
}
export function placeAppointmentInActorSchedule(state: VirtualLifeState, slot: LifeScheduleSlot): VirtualLifeState {
  const start = new Date(slot.startAt).getTime(), end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return state;
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime(), b = new Date(existing.endAt).getTime();
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    // Preserve unaffected time before and after the appointment instead of creating gaps.
    if (a < start) nextSlots.push({ ...existing, id: existing.id + "-before-" + slot.id, endAt: slot.startAt, updatedAt: new Date().toISOString() });
    if (b > end) nextSlots.push({ ...existing, id: existing.id + "-after-" + slot.id, startAt: slot.endAt, updatedAt: new Date().toISOString() });
  }
  nextSlots.push(slot);
  nextSlots.sort((a,b)=>a.startAt.localeCompare(b.startAt));
  return { ...state, schedules: nextSlots };
}

/**
 * Insert a user-authored schedule item without silently overwriting another
 * manual plan or a confirmed appointment. Generated baseline slots may be
 * split around it so the person's day remains continuous.
 */
export function insertManualLifeScheduleSlot(
  state: VirtualLifeState,
  slot: LifeScheduleSlot,
): { state: VirtualLifeState; conflict?: LifeScheduleSlot; error?: string } {
  const start = new Date(slot.startAt).getTime();
  const end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { state, error: "日程时间无效，结束时间必须晚于开始时间。" };
  }

  const overlapping = state.schedules.filter(existing => {
    if (existing.ownerType !== slot.ownerType || existing.ownerId !== slot.ownerId) return false;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && a < end && b > start;
  });
  const conflict = overlapping.find(existing =>
    existing.kind === "appointment"
    || (existing.source === "manual" && existing.kind !== "free-time")
    || existing.source === "event"
    || (existing.source === "character-tool" && existing.kind !== "free-time")
  );
  if (conflict) return { state, conflict };

  const now = new Date().toISOString();
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    if (a < start) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-before-" + slot.id,
        endAt: slot.startAt,
        updatedAt: now,
      });
    }
    if (b > end) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-after-" + slot.id,
        startAt: slot.endAt,
        updatedAt: now,
      });
    }
  }
  nextSlots.push({ ...slot, updatedAt: now });
  return { state: { ...state, schedules: nextSlots.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

/**
 * AI-authored schedules may replace any free-time placeholder, regardless of
 * whether it came from weekly generation or a manual edit. Preserve only the
 * unaffected edges of an overlapped free-time slot.
 */
export function overlayScheduleSlotsOverFreeTime(
  state: VirtualLifeState,
  candidates: LifeScheduleSlot[],
): VirtualLifeState {
  let schedules = [...state.schedules];
  const acceptedCandidates: LifeScheduleSlot[] = [];
  for (const candidate of candidates) {
    const start = new Date(candidate.startAt).getTime();
    const end = new Date(candidate.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const protectedOverlap = schedules.some(existing => {
      const sameOwner = existing.ownerType === candidate.ownerType && existing.ownerId === candidate.ownerId;
      const a = new Date(existing.startAt).getTime();
      const b = new Date(existing.endAt).getTime();
      // Free-time is an open placeholder even when legacy/user-edited records
      // carry source=manual. A character-tool free-time slot is a cancellation
      // tombstone and must survive automatic weekly generation.
      // A companion stay is a time-bounded user instruction, not an open
      // free-time placeholder. Keep it intact against weekly and character plans.
      const companionStay = existing.id.startsWith("companion-follow-");
      const replaceableFreeTime = existing.kind === "free-time"
        && !companionStay
        && (candidate.source !== "weekly-generation" || existing.source !== "character-tool");
      return sameOwner && !replaceableFreeTime && Number.isFinite(a) && Number.isFinite(b) && a < end && b > start;
    });
    // A protected overlap rejects the candidate entirely. Merely skipping the
    // overlay loop is insufficient: pushing all candidates at the end would
    // still resurrect the cancelled interval.
    if (protectedOverlap) continue;
    const next: LifeScheduleSlot[] = [];
    for (const existing of schedules) {
      const sameOwner = existing.ownerType === candidate.ownerType && existing.ownerId === candidate.ownerId;
      const a = new Date(existing.startAt).getTime();
      const b = new Date(existing.endAt).getTime();
      // A companion stay is a time-bounded user instruction, not an open
      // free-time placeholder. Keep it intact against weekly and character plans.
      const companionStay = existing.id.startsWith("companion-follow-");
      const replaceableFreeTime = existing.kind === "free-time"
        && !companionStay
        && (candidate.source !== "weekly-generation" || existing.source !== "character-tool");
      if (!sameOwner || !replaceableFreeTime || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
        next.push(existing);
        continue;
      }
      if (a < start) next.push({ ...existing, id: existing.id + "-before-ai-" + candidate.id, endAt: candidate.startAt, updatedAt: new Date().toISOString() });
      if (b > end) next.push({ ...existing, id: existing.id + "-after-ai-" + candidate.id, startAt: candidate.endAt, updatedAt: new Date().toISOString() });
    }
    schedules = next;
    acceptedCandidates.push(candidate);
  }
  schedules.push(...acceptedCandidates);
  return { ...state, schedules: schedules.sort((a, b) => a.startAt.localeCompare(b.startAt)) };
}

/**
 * Apply a character-authored schedule change through one shared business rule.
 * It may reshape generated or previous character-tool slots in the next seven days,
 * but never overwrites any manual slot (including manual free-time), events or appointments.
 */
export function applyCharacterLifeScheduleChange(
  state: VirtualLifeState,
  characterId: string,
  input: { startAt: string; endAt: string; title: string; locationId?: string },
  realNow = new Date(),
): { state: VirtualLifeState; error?: string } {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  const title = input.title.trim().slice(0, 120);
  if (!title || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
    return { state, error: "需要有效的活动内容和开始/结束时间，且结束时间必须晚于开始时间。" };
  }
  const characterNow = realNow;
  const horizonEnd = new Date(characterNow.getTime() + 7 * 24 * 60 * 60_000);
  if (startAt <= characterNow || endAt > horizonEnd) {
    return { state, error: "只能安排角色未来 7 天内、尚未开始的日程。" };
  }

  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  const conflict = state.schedules.find(slot => {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId) return false;
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return false;
    const isAlreadyInProgress = slotStart <= characterNow.getTime() && slotEnd > characterNow.getTime();
    const protectedManualActivity = slot.kind !== "free-time" && slot.source === "manual";
    const protectedCompanionStay = slot.id.startsWith("companion-follow-");
    return (isAlreadyInProgress || slot.kind === "appointment" || protectedManualActivity || protectedCompanionStay || slot.source === "event")
      && slotStart < endMs
      && slotEnd > startMs;
  });
  if (conflict) return { state, error: "该时段与「" + conflict.title + "」冲突；没有覆盖用户安排或已确认约会。" };

  const locationId = input.locationId?.trim();
  const characterHome = state.locations.find(item =>
    (item.id === "home" || item.id.startsWith("home-")) && (item.residents ?? []).includes(characterId)
  ) ?? state.locations.find(item => item.id === "home-" + characterId) ?? {
    id: "home-" + characterId,
    name: "角色的家",
    description: "角色自己的住处；可通过地点库的 residents 设置同居关系。",
    atmosphere: "熟悉、私密、可以放松的空间。",
    layout: "有自己的起居区域与休息空间。",
    props: ["沙发", "茶几", "水杯", "床头灯"],
    visibility: "private" as const,
  };
  const location = locationId ? state.locations.find(item => item.id === locationId) : characterHome;
  if (!location) {
    return { state, error: "指定地点 ID「" + (locationId || "角色自己的家") + "」不存在。请使用地点库中的规范地点 ID；不会自动改去玩家家。" };
  }
  const locations = state.locations.some(item => item.id === location.id)
    ? state.locations
    : [...state.locations, location];
  const schedules: LifeScheduleSlot[] = [];
  const updatedAt = realNow.toISOString();
  for (const slot of state.schedules) {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (
      slot.ownerType !== "character"
      || slot.ownerId !== characterId
      || slot.kind === "appointment"
      || (slot.source === "manual" && slot.kind !== "free-time")
      || slot.source === "event"
      || !Number.isFinite(slotStart)
      || !Number.isFinite(slotEnd)
      || slotEnd <= startMs
      || slotStart >= endMs
    ) {
      schedules.push(slot);
      continue;
    }
    if (slotStart < startMs) {
      schedules.push({ ...slot, id: slot.id + "-before-life-tool-" + startMs, endAt: startAt.toISOString(), updatedAt });
    }
    if (slotEnd > endMs) {
      schedules.push({ ...slot, id: slot.id + "-after-life-tool-" + endMs, startAt: endAt.toISOString(), updatedAt });
    }
  }
  schedules.push({
    id: "life-tool-plan-" + characterId + "-" + startMs,
    ownerType: "character",
    ownerId: characterId,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    title,
    plannedLocationId: location?.id ?? null,
    plannedLocationName: location?.name ?? null,
    kind: "special",
    source: "character-tool",
    updatedAt,
  });
  return { state: { ...state, locations, schedules: schedules.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

export function confirmLifeInvitation(state: VirtualLifeState, invitationId: string): VirtualLifeState {
  const invitation = state.invitations.find(item => item.id===invitationId && item.status==="proposed");
  if (!invitation) return state;
  const startAt = new Date(invitation.proposedAt);
  if (!Number.isFinite(startAt.getTime())) return state;
  const rawDuration = invitation.durationMinutes;
  const durationMinutes = typeof rawDuration === "number" && Number.isFinite(rawDuration)
    ? Math.max(15, Math.min(rawDuration, 24 * 60))
    : 60;
  const endsAt = new Date(startAt.getTime() + durationMinutes * 60_000).toISOString();
  const now = new Date().toISOString(), eventId = makeId("event");
  const event: LifeEvent = { id:eventId, kind:"invitation", status:"confirmed", startsAt:invitation.proposedAt, endsAt, locationId:invitation.locationId, locationName:invitation.locationName, participantIds:["player",invitation.characterId], title:invitation.activity, details:invitation.kind === "follow-request" ? "follow-player" : "confirmed-appointment", createdAt:now, updatedAt:now };
  const next = { ...invitation, status:"confirmed" as const, confirmedAt:now, updatedAt:now, eventId };
  return { ...state, invitations:state.invitations.map(item=>item.id===invitationId?next:item), events:[event,...state.events] };
}
