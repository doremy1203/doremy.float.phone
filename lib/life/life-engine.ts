import type {
  LifeActorState,
  LifeEvent,
  LifeEventStatus,
  LifeInvitation,
  LifeScheduleSlot,
  LifeSceneState,
  VirtualLifeState,
} from "./life-types";

export function findCurrentScheduleSlot(
  slots: LifeScheduleSlot[],
  ownerType: LifeScheduleSlot["ownerType"],
  ownerId: string,
  at: Date,
): LifeScheduleSlot | undefined {
  const time = at.getTime();
  return slots
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .filter(slot => new Date(slot.startAt).getTime() <= time && new Date(slot.endAt).getTime() > time)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))[0];
}

/** Plan slots can suggest whereabouts; they must never overwrite actual location. */
export function getPlannedLocationHint(
  slots: LifeScheduleSlot[],
  ownerType: LifeScheduleSlot["ownerType"],
  ownerId: string,
  at: Date,
): { locationId?: string | null; locationName?: string | null } | null {
  const slot = findCurrentScheduleSlot(slots, ownerType, ownerId, at);
  if (!slot) return null;
  return { locationId: slot.plannedLocationId, locationName: slot.plannedLocationName };
}

export type EncounterPerception = {
  distance: "near" | "medium" | "far";
  lineOfSight: boolean;
  audible: boolean;
  attention: "focused" | "normal" | "distracted";
  activity: "busy" | "casual" | "waiting";
  noticing: number;
  environmentNoise: number;
};

/** Awareness is evaluated independently; sharing a location alone does not imply noticing. */
export function evaluateEncounterAwareness(input: EncounterPerception, seed = 0): "unaware" | "suspects" | "aware" {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const distanceScore = input.distance === "near" ? 0.38 : input.distance === "medium" ? 0.17 : 0.02;
  const sightScore = input.lineOfSight ? 0.28 : 0;
  const soundScore = input.audible ? 0.14 * (1 - clamp(input.environmentNoise)) : 0;
  const attentionScore = input.attention === "focused" ? 0.02 : input.attention === "normal" ? 0.1 : 0.18;
  const activityScore = input.activity === "waiting" ? 0.16 : input.activity === "casual" ? 0.08 : 0;
  const score = clamp(distanceScore + sightScore + soundScore + attentionScore + activityScore + clamp(input.noticing) * 0.2);
  // Small stable variation prevents every encounter with identical inputs feeling scripted.
  const adjusted = clamp(score + ((Math.abs(seed) % 11) - 5) * 0.012);
  if (adjusted >= 0.55) return "aware";
  if (adjusted >= 0.3) return "suspects";
  return "unaware";
}

/**
 * Build the ordered responder queue for one player-triggered scene turn.
 * Canonical character IDs are de-duplicated before and after selection so the
 * random, explicitly selected and awareness responders can never answer twice.
 */
export function buildLifeSceneResponderQueue(input: {
  presentCharacterIds: string[];
  randomEnabled: boolean;
  randomSeed: number;
  selectedCharacterId?: string;
  awarenessCharacterId?: string;
}): string[] {
  const present = [...new Set(input.presentCharacterIds.filter(Boolean))];
  const selected = input.selectedCharacterId && present.includes(input.selectedCharacterId)
    ? input.selectedCharacterId : "";
  const random = input.randomEnabled && present.length
    ? present[Math.abs(Math.floor(input.randomSeed)) % present.length]
    : "";
  const awareness = input.awarenessCharacterId && present.includes(input.awarenessCharacterId)
    ? input.awarenessCharacterId : "";
  // Random selection, explicit selection and mention-awareness are independent
  // response paths. Turning random selection off must not suppress a character
  // who noticed being addressed; the same character is still deduplicated.
  return [random, selected, awareness].filter((value, index, all) => Boolean(value) && all.indexOf(value) === index).slice(0, 3);
}

export function findActorState(
  state: VirtualLifeState,
  ownerType: LifeActorState["ownerType"],
  ownerId: string,
): LifeActorState | undefined {
  return state.actorStates.find(actor => actor.ownerType === ownerType && actor.ownerId === ownerId);
}

export function upsertActorState(state: VirtualLifeState, nextActor: LifeActorState): VirtualLifeState {
  const actorStates = state.actorStates.filter(actor =>
    !(actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId),
  );
  actorStates.push({ ...nextActor, updatedAt: new Date().toISOString() });
  return { ...state, actorStates };
}

export function upsertLifeEvent(state: VirtualLifeState, nextEvent: LifeEvent): VirtualLifeState {
  const events = state.events.filter(event => event.id !== nextEvent.id);
  events.push(nextEvent);
  events.sort((a, b) => (a.startsAt || a.createdAt).localeCompare(b.startsAt || b.createdAt));
  return { ...state, events };
}

export function transitionLifeEvent(
  state: VirtualLifeState,
  eventId: string,
  nextStatus: LifeEventStatus,
): VirtualLifeState {
  const current = state.events.find(event => event.id === eventId);
  if (!current) return state;
  const allowed: Record<LifeEventStatus, LifeEventStatus[]> = {
    planned: ["confirmed", "active", "cancelled"],
    confirmed: ["active", "cancelled"],
    active: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };
  if (!allowed[current.status].includes(nextStatus)) return state;
  const now = new Date().toISOString();
  const updated: LifeEvent = {
    ...current,
    status: nextStatus,
    updatedAt: now,
    ...(nextStatus === "completed" ? { completedAt: now } : {}),
    ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}),
  };
  return { ...state, events: state.events.map(event => event.id === eventId ? updated : event) };
}

export function transitionInvitation(
  state: VirtualLifeState,
  invitationId: string,
  action: "confirm" | "decline" | "cancel",
): VirtualLifeState {
  const current = state.invitations.find(invite => invite.id === invitationId);
  if (!current || current.status !== "proposed") return state;
  const now = new Date().toISOString();
  const status: LifeInvitation["status"] = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
  const next = { ...current, status, updatedAt: now, ...(action === "confirm" ? { confirmedAt: now } : {}) };
  return { ...state, invitations: state.invitations.map(invite => invite.id === invitationId ? next : invite) };
}

export function upsertLifeScene(state: VirtualLifeState, scene: LifeSceneState): VirtualLifeState {
  const scenes = state.scenes.filter(item => item.id !== scene.id);
  scenes.push(scene);
  return { ...state, scenes };
}
