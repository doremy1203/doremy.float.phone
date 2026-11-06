import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import {
  createEmptyVirtualLifeState,
  DEFAULT_LIFE_ENGINE_SETTINGS,
  type LifeEvent,
  type LifeEventStatus,
  type LifeEngineSettings,
  type LifeTimelineEntry,
  type LifeOwnerType,
  type VirtualLifeState,
} from "./life-types";

const STORAGE_KEY = "ai_phone_virtual_life_state_v1";
registerKvMigration(STORAGE_KEY);

function normalizeSettings(value: unknown): LifeEngineSettings {
  const raw = value && typeof value === "object" ? value as Partial<LifeEngineSettings> : {};
  const settings = { ...DEFAULT_LIFE_ENGINE_SETTINGS, ...raw };
  // Drop the retired life-system offline-push flag from legacy saved settings.
  delete (settings as LifeEngineSettings & { enableLifeOfflinePush?: boolean }).enableLifeOfflinePush;
  // Remove retired independent-clock settings from legacy persisted records.
  delete (settings as LifeEngineSettings & { defaultClockMode?: unknown }).defaultClockMode;
  delete (settings as LifeEngineSettings & { defaultSpeed?: unknown }).defaultSpeed;
  settings.panelOpacity = Number.isFinite(settings.panelOpacity) ? Math.max(50, Math.min(settings.panelOpacity, 100)) : 96;
  settings.dialogueFontSize = Number.isFinite(settings.dialogueFontSize) ? Math.max(8, Math.min(settings.dialogueFontSize, 48)) : 15;
  settings.narrationFontSize = Number.isFinite(settings.narrationFontSize) ? Math.max(8, Math.min(settings.narrationFontSize, 36)) : 12;
  settings.dialogueFontFamily = typeof settings.dialogueFontFamily === "string" ? settings.dialogueFontFamily.slice(0, 160) : "";
  settings.narrationFontFamily = typeof settings.narrationFontFamily === "string" ? settings.narrationFontFamily.slice(0, 160) : "";
  settings.bubblePadding = Number.isFinite(settings.bubblePadding) ? Math.max(0, Math.min(settings.bubblePadding, 24)) : DEFAULT_LIFE_ENGINE_SETTINGS.bubblePadding;
  settings.messageGapPx = Number.isFinite(settings.messageGapPx) ? Math.max(0, Math.min(settings.messageGapPx, 24)) : DEFAULT_LIFE_ENGINE_SETTINGS.messageGapPx;
  settings.narrationGapPx = Number.isFinite(settings.narrationGapPx) ? Math.max(0, Math.min(settings.narrationGapPx, 24)) : DEFAULT_LIFE_ENGINE_SETTINGS.narrationGapPx;
  if (!/^#[0-9a-f]{6}$/i.test(settings.accentColor)) settings.accentColor = DEFAULT_LIFE_ENGINE_SETTINGS.accentColor;
  settings.accentColorMode = settings.accentColorMode === "custom" ? "custom" : "theme";
  return settings;
}

function normalizeState(value: unknown): VirtualLifeState {
  if (!value || typeof value !== "object") return createEmptyVirtualLifeState();
  const raw = value as Partial<VirtualLifeState>;
  const empty = createEmptyVirtualLifeState();
  return {
    schemaVersion: 1,
    scheduleProfileVersion: typeof raw.scheduleProfileVersion === "number" ? raw.scheduleProfileVersion : 0,
    settings: normalizeSettings(raw.settings),
    locations: Array.isArray(raw.locations) ? raw.locations : [],
    actorStates: Array.isArray(raw.actorStates) ? raw.actorStates : [],
    schedules: Array.isArray(raw.schedules) ? raw.schedules.map(slot => {
      // Older UI forms incorrectly labelled ordinary manual activities as free-time.
      // Keep explicit free-time labels replaceable, but protect real user-authored plans.
      const legacyManualActivity = (slot.source === "manual" || slot.source === "character-tool")
        && slot.kind === "free-time"
        && !/(自由活动|自由时间|空闲|待安排)/.test(typeof slot.title === "string" ? slot.title : "");
      return legacyManualActivity ? { ...slot, kind: "special" as const } : slot;
    }) : [],
    scenes: Array.isArray(raw.scenes) ? raw.scenes : [],
    sceneMessages: Array.isArray(raw.sceneMessages) ? raw.sceneMessages : [],
    events: Array.isArray(raw.events) ? raw.events : [],
    invitations: Array.isArray(raw.invitations) ? raw.invitations : [],
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    timeline: Array.isArray(raw.timeline) ? raw.timeline : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : empty.updatedAt,
  };
}

/** Loads persisted state without generating schedules or advancing anyone's clock. */
export function loadVirtualLifeState(): VirtualLifeState {
  if (typeof window === "undefined") return createEmptyVirtualLifeState();
  try {
    const raw = kvGet(STORAGE_KEY);
    return raw ? normalizeState(JSON.parse(raw)) : createEmptyVirtualLifeState();
  } catch {
    return createEmptyVirtualLifeState();
  }
}

export function saveVirtualLifeState(state: VirtualLifeState): VirtualLifeState {
  const saved = { ...state, schemaVersion: 1 as const, updatedAt: new Date().toISOString() };
  if (typeof window !== "undefined") {
    kvSet(STORAGE_KEY, JSON.stringify(saved));
    window.dispatchEvent(new CustomEvent("virtual-life-state-updated"));
  }
  return saved;
}

/** Migrate character-scoped life records written under an old ChatContact.id. */
export function migrateLifeCharacterIdentity(fromId: string, toId: string): number {
  if (!fromId || !toId || fromId === toId || typeof window === "undefined") return 0;
  const state = loadVirtualLifeState();
  let changed = 0;
  const replaceId = (value: string) => value === fromId ? (changed += 1, toId) : value;
  const replaceIds = (values: string[] | undefined) => values
    ? [...new Set(values.map(replaceId))]
    : values;
  const replaceOwner = <T extends { ownerType: LifeOwnerType; ownerId: string }>(value: T): T => {
    if (value.ownerType !== "character" || value.ownerId !== fromId) return value;
    changed += 1;
    return { ...value, ownerId: toId };
  };

  const locations = state.locations.map(location => {
    const residents = replaceIds(location.residents);
    const habits = location.characterHabits ? { ...location.characterHabits } : undefined;
    if (habits && Object.prototype.hasOwnProperty.call(habits, fromId)) {
      if (!(toId in habits)) habits[toId] = habits[fromId];
      delete habits[fromId];
      changed += 1;
    }
    return residents !== location.residents || habits !== location.characterHabits
      ? { ...location, residents, characterHabits: habits }
      : location;
  });
  const scenes = state.scenes.map(scene => {
    const participants = [...scene.participants]
      .sort((a, b) => Number(b.ownerId === toId) - Number(a.ownerId === toId))
      .map(participant => {
        const normalized = replaceOwner(participant);
        if (!Object.prototype.hasOwnProperty.call(normalized.awarenessByActorId, fromId)) return normalized;
        const awarenessByActorId = { ...normalized.awarenessByActorId };
        if (!(toId in awarenessByActorId)) awarenessByActorId[toId] = awarenessByActorId[fromId];
        delete awarenessByActorId[fromId];
        changed += 1;
        return { ...normalized, awarenessByActorId };
      });
    const participantMap = new Map<string, typeof participants[number]>();
    for (const participant of participants) {
      const key = participant.ownerType + ":" + participant.ownerId;
      const existing = participantMap.get(key);
      if (!existing) participantMap.set(key, participant);
      else participantMap.set(key, {
        ...existing,
        awarenessByActorId: { ...participant.awarenessByActorId, ...existing.awarenessByActorId },
      });
    }
    return {
      ...scene,
      participants: [...participantMap.values()],
      images: scene.images?.map(image => {
        const participantIds = replaceIds(image.participantIds) ?? [];
        return participantIds !== image.participantIds ? { ...image, participantIds } : image;
      }),
    };
  });
  const mergeOwnerRecords = <T extends { ownerType: LifeOwnerType; ownerId: string; updatedAt: string }>(items: T[]): T[] => {
    const merged = new Map<string, T>();
    for (const item of items.map(replaceOwner)) {
      const key = item.ownerType + ":" + item.ownerId;
      const existing = merged.get(key);
      if (!existing || item.updatedAt >= existing.updatedAt) merged.set(key, item);
    }
    return [...merged.values()];
  };
  const sceneMessages = state.sceneMessages.map(message =>
    message.speakerType === "character" && message.speakerId === fromId
      ? (changed += 1, { ...message, speakerId: toId })
      : message,
  );
  const events = state.events.map(event => {
    const participantIds = replaceIds(event.participantIds) ?? [];
    return participantIds !== event.participantIds ? { ...event, participantIds } : event;
  });
  const invitations = state.invitations.map(invitation =>
    invitation.characterId === fromId ? (changed += 1, { ...invitation, characterId: toId }) : invitation,
  );
  const memories = state.memories.map(memory => {
    const participants = replaceIds(memory.participants) || [];
    let interpretations = memory.interpretations;
    if (interpretations && Object.prototype.hasOwnProperty.call(interpretations, fromId)) {
      interpretations = { ...interpretations };
      if (!(toId in interpretations)) interpretations[toId] = interpretations[fromId];
      delete interpretations[fromId];
      changed += 1;
    }
    return participants !== memory.participants || interpretations !== memory.interpretations
      ? { ...memory, participants, interpretations }
      : memory;
  });
  const timeline = state.timeline.map(entry =>
    entry.actorId === fromId ? (changed += 1, { ...entry, actorId: toId }) : entry,
  );
  const scheduleMap = new Map<string, typeof state.schedules[number]>();
  const schedules = [...state.schedules]
    .sort((a, b) => Number(b.ownerId === toId) - Number(a.ownerId === toId))
    .map(replaceOwner);
  for (const slot of schedules) {
    const key = JSON.stringify([slot.ownerType, slot.ownerId, slot.startAt, slot.endAt, slot.title]);
    if (!scheduleMap.has(key)) scheduleMap.set(key, slot);
  }
  const next: VirtualLifeState = {
    ...state,
    actorStates: mergeOwnerRecords(state.actorStates),
    schedules: [...scheduleMap.values()],
    locations,
    scenes,
    sceneMessages,
    events,
    invitations,
    memories,
    timeline,
  };
  if (changed > 0) saveVirtualLifeState(next);
  return changed;
}

export function appendLifeTimelineEntry(
  state: VirtualLifeState,
  entry: Omit<LifeTimelineEntry, "id" | "occurredAt"> & {
    id?: string;
    occurredAt?: string;
    /** Optional actor owner for events whose actor ID cannot be inferred from current state. */
    ownerType?: LifeOwnerType;
    ownerId?: string;
  },
): VirtualLifeState {
  const { ownerId: explicitOwnerId, ...timelineEntry } = entry;
  const item: LifeTimelineEntry = {
    ...timelineEntry,
    id: entry.id ?? "life-log-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    occurredAt: entry.occurredAt ?? new Date().toISOString(),
    recordedAt: entry.recordedAt ?? new Date().toISOString(),
  };
  return { ...state, timeline: [...(state.timeline ?? []), item].slice(-5000) };
}

export function upsertLifeScheduleSlot(state: VirtualLifeState, slot: VirtualLifeState["schedules"][number]): VirtualLifeState {
  const schedules = state.schedules.filter(item => item.id !== slot.id);
  schedules.push({ ...slot, updatedAt: new Date().toISOString() });
  schedules.sort((a, b) => a.startAt.localeCompare(b.startAt));
  return { ...state, schedules };
}

export function settleLifeEventOnce(
  state: VirtualLifeState,
  eventId: string,
  settlementKey: string,
  status: Extract<LifeEventStatus, "completed" | "cancelled">,
): { state: VirtualLifeState; changed: boolean } {
  const existing = state.events.find(event => event.id === eventId);
  if (!existing || existing.settlementKey === settlementKey || existing.status === "completed" || existing.status === "cancelled") {
    return { state, changed: false };
  }
  const now = new Date().toISOString();
  const nextEvent: LifeEvent = {
    ...existing, status, settlementKey, updatedAt: now,
    ...(status === "completed" ? { completedAt: now } : { cancelledAt: now }),
  };
  return { state: { ...state, events: state.events.map(event => event.id === eventId ? nextEvent : event) }, changed: true };
}


/** Clear only life-engine data. Other apps, characters, chats and global settings are untouched. */
export function resetVirtualLifeState(): VirtualLifeState {
  const empty = createEmptyVirtualLifeState();
  empty.settings = {
    ...empty.settings,
    enabled: false,
    enableCharacterAutonomy: false,
    enableProactiveSceneMessages: false,
  };
  return saveVirtualLifeState(empty);
}
