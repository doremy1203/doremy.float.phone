import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

async function loadTs(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, Date, Math }, { filename: path });
  return moduleBox.exports;
}

async function loadTsWithMocks(path, mocks, extras = {}) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const moduleBox = { exports: {} };
  const noOp = () => undefined;
  const customRequire = name => mocks[name] || new Proxy({}, { get: () => noOp });
  vm.runInNewContext(compiled, {
    module: moduleBox, exports: moduleBox.exports, require: customRequire,
    Date, Math, Promise, JSON, console, setTimeout, clearTimeout, ...extras,
  }, { filename: path });
  return moduleBox.exports;
}

const identity = await loadTs("../lib/character-id-contract.ts");
const guided = await loadTs("../lib/life/life-guided-schedule.ts");
const lifeEngineSource = await readFile(new URL("../components/life/life-engine-app.tsx", import.meta.url), "utf8");
assert.match(lifeEngineSource, /actorId.*actorType.*actorName/);
assert.match(lifeEngineSource, /parseGuidedScheduleResponse\(result\.content\.trim\(\)/);
const lifeSchedulerSource = await readFile(new URL("../lib/life/life-proactive-scheduler.ts", import.meta.url), "utf8");
assert.match(lifeSchedulerSource, /resolveSessionCharacterId\(item\) === character\.id/);



// Exercise the actual chat-storage hydration/migration path with an in-memory
// IndexedDB boundary. This catches ordering regressions that a helper-only test
// would miss while keeping the test deterministic and network-free.
const storedCharacters = [{ id: "char_alpha", name: "小满" }, { id: "char_beta", name: "小满" }];
const persisted = { sessions: [], contacts: [] };
const dbMock = {
  chatDb: {},
  initChatDb: async () => ({
    messages: [],
    contacts: [
      { id: "contact_alpha", characterId: "char_alpha", addedAt: "2026-01-01T00:00:00.000Z" },
      { id: "contact_beta", characterId: "char_beta", addedAt: "2026-01-02T00:00:00.000Z" },
    ],
    sessions: [
      { id: "sess_alpha", contactId: "contact_alpha", unreadCount: 0, updatedAt: "2026-01-01T00:00:00.000Z", isPinned: false },
      { id: "sess_beta_legacy", contactId: "char_beta", unreadCount: 0, updatedAt: "2026-01-02T00:00:00.000Z", isPinned: false },
      { id: "sess_group", contactId: "group_legacy", isGroup: true, participantIds: ["char_alpha", "char_beta"], unreadCount: 0, updatedAt: "2026-01-03T00:00:00.000Z", isPinned: false },
    ],
  }),
  dbReplaceSessions: rows => { persisted.sessions = rows; },
  dbReplaceContacts: rows => { persisted.contacts = rows; },
};
const noOp = () => undefined;
const moduleMocks = {
  "./chat-db": dbMock,
  "./settings-storage": { resolveUserIdentity: noOp },
  "./character-storage": { loadCharacters: () => storedCharacters, saveCharacters: noOp },
  "./kv-db": { kvGet: () => null, kvSet: noOp, registerKvMigration: noOp },
  "./chat-plugin-hooks": { emitChatPluginEvent: noOp, runChatPluginTransformSync: (_event, value) => value },
  "./rich-message-parser": { parseAIResponse: noOp },
  "./text-tool-protocol": { extractTextToolDirectiveText: value => value },
  "./chat-avatar-intent": { findUserAvatarChangeIntent: noOp, inferAvatarDecisionFromReply: noOp },
  "./life/life-storage": { appendLifeTimelineEntry: noOp, loadVirtualLifeState: () => ({ settings: { enabled: false } }), saveVirtualLifeState: noOp },
  "./life/life-runtime": { getActorClock: noOp, resolveActorLifeNow: () => new Date() },
  "./character-id-contract": identity,
};
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const chatStorageCompiled = ts.transpileModule(chatStorageSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const chatStorageModule = { exports: {} };
const customRequire = name => moduleMocks[name] || new Proxy({}, { get: () => noOp });
const browserWindow = { dispatchEvent: noOp, localStorage: { getItem: () => null, setItem: noOp, removeItem: noOp } };
vm.runInNewContext(chatStorageCompiled, {
  module: chatStorageModule, exports: chatStorageModule.exports, require: customRequire,
  window: browserWindow, CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  Date, Math, Promise, console, setTimeout, clearTimeout,
}, { filename: "chat-storage.integration.cjs" });
await chatStorageModule.exports.hydrateChatStorage();
const hydratedSessions = chatStorageModule.exports.loadChatSessions();
assert.equal(hydratedSessions.find(item => item.id === "sess_alpha")?.characterId, "char_alpha",
  "real chat-storage hydration must canonicalize ChatContact.id to Character.id");
assert.equal(hydratedSessions.find(item => item.id === "sess_beta_legacy")?.characterId, "char_beta",
  "real chat-storage hydration must preserve legacy Character.id sessions");
assert.equal(hydratedSessions.find(item => item.id === "sess_group")?.characterId, undefined,
  "group synthetic contact IDs must remain outside private character identity");
assert.equal(chatStorageModule.exports.resolveSessionCharacterId(
  hydratedSessions.find(item => item.id === "sess_alpha"),
), "char_alpha", "public chat-storage resolver must return canonical Character.id");
assert.equal(chatStorageModule.exports.createOrGetSession("contact_alpha").characterId, "char_alpha",
  "new private sessions must persist the canonical character ID alongside the contact reference");
assert.ok(persisted.sessions.some(item => item.id === "sess_alpha" && item.characterId === "char_alpha"),
  "canonical identity migration must be persisted back to IndexedDB");


const characters = new Set(["char_alpha", "char_beta"]);
const contacts = [
  { id: "contact_alpha", characterId: "char_alpha" },
  { id: "contact_beta", characterId: "char_beta" },
];

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_alpha" }, contacts, characters,
), "char_alpha", "new-format contact references must resolve to Character.id");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "char_beta" }, contacts, characters,
), "char_beta", "legacy sessions that stored Character.id must remain readable");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_alpha", characterId: "char_beta" }, contacts, characters,
), "char_beta", "a valid canonical session characterId must survive a changed contact mapping");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "group_123", isGroup: true }, contacts, characters,
), null, "synthetic group contact IDs must never resolve as a private character");

assert.equal(identity.resolveSessionCharacterIdentity(
  { contactId: "contact_deleted" }, contacts, characters,
), null, "an orphaned contact ID must fail closed rather than guess by display name");

const now = new Date("2026-11-05T08:00:00.000Z");
// Match the production caller: day boundaries are local calendar midnights,
// not UTC midnights. This keeps the same virtual day in DST and non-DST zones.
const dayStart = new Date(now);
dayStart.setHours(0, 0, 0, 0);
const dayEnd = new Date(dayStart);
dayEnd.setDate(dayEnd.getDate() + 7);
const contexts = [
  { ownerType: "character", ownerId: "char_alpha", name: "小满", now, dayStart, dayEnd, existing: [] },
  { ownerType: "character", ownerId: "char_beta", name: "小满", now, dayStart, dayEnd, existing: [] },
  { ownerType: "player", ownerId: "player", name: "我", now, dayStart, dayEnd, existing: [] },
];

const good = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_alpha", actorType: "character", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "阅读", location: "家",
}] }), contexts);
assert.equal(good.drafts.length, 1);
assert.equal(good.drafts[0].ownerId, "char_alpha", "the schedule draft must retain the canonical Character.id");

const legacyNameOnly = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorName: "我", actorType: "player", dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(legacyNameOnly.drafts.length, 1, "unique legacy name-only output remains compatible");

const ambiguousNameOnly = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorName: "小满", actorType: "character", dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(ambiguousNameOnly.drafts.length, 0, "same-name characters must not be guessed");

const wrongId = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_unknown", actorType: "character", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(wrongId.drafts.length, 0, "a supplied invalid actorId must not be overridden by actorName");

const wrongType = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_alpha", actorType: "player", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(wrongType.drafts.length, 0, "actorType mismatch must be rejected");

const invalidType = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [{
  actorId: "char_alpha", actorType: "contact", actorName: "小满",
  dayOffset: 0, start: "15:00", end: "16:00", title: "学习",
}] }), contexts);
assert.equal(invalidType.drafts.length, 0, "unknown actorType values must be rejected");

const overlap = guided.parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char_alpha", actorType: "character", actorName: "小满", dayOffset: 0, start: "15:00", end: "16:00", title: "阅读" },
  { actorId: "char_alpha", actorType: "character", actorName: "小满", dayOffset: 0, start: "15:30", end: "16:30", title: "写作" },
] }), contexts);
assert.equal(overlap.drafts.length, 1);
assert.equal(overlap.conflicts.length, 1, "overlapping drafts must be reported instead of silently dropped");

// Migrate existing calendar plans stored under contact IDs without losing either side.
const kvValues = new Map();
const kvMocks = {
  kvGet: key => kvValues.get(key) ?? null,
  kvSet: (key, value) => kvValues.set(key, String(value)),
  kvRemove: key => kvValues.delete(key),
  registerKvMigration: () => undefined,
  registerDynamicPrefix: () => undefined,
};
const calendarUtils = await loadTs("../lib/calendar-utils.ts");
const calendarStoreKey = "ai_phone_calendar_plans_v1";
kvValues.set(calendarStoreKey, JSON.stringify({ plans: [
  { id: "legacy-plan", ownerType: "character", ownerId: "contact_alpha", weekStart: "2026-11-02", updatedAt: "2026-11-03T00:00:00.000Z", items: [
    { id: "legacy-item", date: "2026-11-05", weekday: "周四", startTime: "09:00", endTime: "10:00", location: "家", title: "旧日程", colorKey: "blue", source: "manual", createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
  ] },
  { id: "canonical-plan", ownerType: "character", ownerId: "char_alpha", weekStart: "2026-11-02", updatedAt: "2026-11-04T00:00:00.000Z", items: [
    { id: "canonical-item", date: "2026-11-05", weekday: "周四", startTime: "11:00", endTime: "12:00", location: "公司", title: "新日程", colorKey: "green", source: "manual", createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z" },
  ] },
] }));
const calendarStorage = await loadTsWithMocks("../lib/calendar-storage.ts", {
  "./kv-db": kvMocks,
  "./calendar-utils": calendarUtils,
}, { window: { dispatchEvent: noOp } });
assert.equal(calendarStorage.migrateCalendarOwnerIdentity("contact_alpha", "char_alpha"), 1);
const migratedPlans = calendarStorage.loadOwnerCalendarPlans("character", "char_alpha");
assert.equal(migratedPlans.length, 1);
assert.equal(migratedPlans[0].items.length, 2, "legacy and canonical calendar items must merge without loss");

// Exercise the actual life-storage migration for all actor-bearing records.
const lifeTypes = await loadTs("../lib/life/life-types.ts");
const lifeValues = new Map();
const lifeWindow = { dispatchEvent: noOp };
const lifeStorage = await loadTsWithMocks("../lib/life/life-storage.ts", {
  "../kv-db": kvMocksFor(lifeValues),
  "./life-types": lifeTypes,
  "./life-runtime": { getActorClock: noOp, resolveActorLifeNow: () => new Date() },
}, { window: lifeWindow, CustomEvent: class CustomEvent { constructor(type) { this.type = type; } } });
function kvMocksFor(values) {
  return {
    kvGet: key => values.get(key) ?? null,
    kvSet: (key, value) => values.set(key, String(value)),
    kvRemove: key => values.delete(key),
    registerKvMigration: () => undefined,
    registerDynamicPrefix: () => undefined,
  };
}
const lifeState = lifeTypes.createEmptyVirtualLifeState("2026-11-05T00:00:00.000Z");
lifeState.actorClocks = [
  { ownerType: "character", ownerId: "contact_alpha", mode: "real-time", realAnchorAt: "2026-11-05T00:00:00.000Z", virtualAnchorAt: "2026-11-05T00:00:00.000Z", speed: 1, updatedAt: "2026-11-05T01:00:00.000Z" },
];
lifeState.actorStates = [
  { ownerType: "character", ownerId: "contact_alpha", activity: "旧状态", updatedAt: "2026-11-05T01:00:00.000Z" },
  { ownerType: "character", ownerId: "char_alpha", activity: "新状态", updatedAt: "2026-11-05T02:00:00.000Z" },
];
lifeState.schedules = [
  { id: "old-slot", ownerType: "character", ownerId: "contact_alpha", startAt: "2026-11-05T09:00:00.000Z", endAt: "2026-11-05T10:00:00.000Z", title: "上班", kind: "work", source: "manual", updatedAt: "2026-11-05T01:00:00.000Z" },
  { id: "new-slot", ownerType: "character", ownerId: "char_alpha", startAt: "2026-11-05T09:00:00.000Z", endAt: "2026-11-05T10:00:00.000Z", title: "上班", kind: "work", source: "manual", updatedAt: "2026-11-05T02:00:00.000Z" },
];
lifeState.locations = [{ id: "home", name: "家", visibility: "private", residents: ["contact_alpha"], characterHabits: { contact_alpha: "旧习惯" } }];
lifeState.scenes = [{
  id: "scene-a", locationId: "home", locationName: "家", startedAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T01:00:00.000Z", status: "active", lastSettledEventIds: [],
  participants: [
    { ownerType: "character", ownerId: "contact_alpha", activity: "旧活动", awarenessByActorId: { contact_alpha: "aware" } },
    { ownerType: "character", ownerId: "char_alpha", activity: "新活动", awarenessByActorId: {} },
  ],
  images: [{ id: "scene-image", sceneId: "scene-a", mediaRef: "media", prompt: "", participantIds: ["contact_alpha"], createdAt: "2026-11-05T00:00:00.000Z", status: "active" }],
}];
lifeState.sceneMessages = [{ id: "scene-msg", sceneId: "scene-a", speakerType: "character", speakerId: "contact_alpha", speakerName: "小满", role: "character", dialogue: "你好", createdAt: "2026-11-05T00:00:00.000Z" }];
lifeState.events = [{ id: "event", kind: "activity", status: "planned", participantIds: ["contact_alpha"], title: "活动", createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" }];
lifeState.invitations = [{ id: "invite", characterId: "contact_alpha", playerId: "player", proposedAt: "2026-11-05T00:00:00.000Z", activity: "见面", status: "proposed", updatedAt: "2026-11-05T00:00:00.000Z" }];
lifeState.memories = [{ id: "fact", eventId: "event", occurredAt: "2026-11-05T00:00:00.000Z", participants: ["contact_alpha"], fact: "一起活动", interpretations: { contact_alpha: "旧解释" } }];
lifeState.timeline = [{ id: "timeline", category: "chat", occurredAt: "2026-11-05T00:00:00.000Z", title: "聊天", actorId: "contact_alpha" }];
lifeValues.set("ai_phone_virtual_life_state_v1", JSON.stringify(lifeState));
assert.ok(lifeStorage.migrateLifeCharacterIdentity("contact_alpha", "char_alpha") > 0);
const migratedLife = lifeStorage.loadVirtualLifeState();
assert.equal(migratedLife.actorStates.length, 1, "duplicate actor states must collapse to one canonical actor");
assert.equal(migratedLife.actorStates[0].ownerId, "char_alpha");
assert.equal(migratedLife.schedules.length, 1, "identical old/new schedule slots must not duplicate");
assert.equal(migratedLife.scenes[0].participants.length, 1);
assert.equal(migratedLife.scenes[0].participants[0].ownerId, "char_alpha");
assert.equal(migratedLife.scenes[0].participants[0].awarenessByActorId.char_alpha, "aware");
assert.deepEqual(Array.from(migratedLife.scenes[0].images[0].participantIds), ["char_alpha"]);
assert.equal(migratedLife.sceneMessages[0].speakerId, "char_alpha");
assert.deepEqual(Array.from(migratedLife.events[0].participantIds), ["char_alpha"]);
assert.equal(migratedLife.invitations[0].characterId, "char_alpha");
assert.deepEqual(Array.from(migratedLife.memories[0].participants), ["char_alpha"]);
assert.equal(migratedLife.memories[0].interpretations.char_alpha, "旧解释");
assert.equal(migratedLife.timeline[0].actorId, "char_alpha");
assert.deepEqual(Array.from(migratedLife.locations[0].residents), ["char_alpha"]);
assert.equal(migratedLife.locations[0].characterHabits.char_alpha, "旧习惯");

// Fake IndexedDB boundary: memory rows and per-character summary metadata move atomically.
const memoryRows = [{
  id: "memory-old", characterId: "contact_alpha", sourceApp: "chat", type: "long_term",
  content: "历史记忆", importance: 0.8, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
}];
const fakeDb = {
  transaction: () => {
    const tx = { oncomplete: null, onerror: null, onabort: null };
    const store = {
      getAll: () => {
        const request = { result: undefined, onsuccess: null, onerror: null };
        setTimeout(() => {
          request.result = [...memoryRows];
          request.onsuccess?.();
          queueMicrotask(() => tx.oncomplete?.());
        }, 0);
        return request;
      },
      put: entry => {
        const index = memoryRows.findIndex(item => item.id === entry.id);
        if (index >= 0) memoryRows[index] = entry;
        else memoryRows.push(entry);
      },
    };
    tx.objectStore = () => store;
    return tx;
  },
  close: noOp,
};
const memoryTypes = await loadTs("../lib/memory-types.ts");
const memoryValues = new Map([
  ["ai_phone_mem_evt_count_contact_alpha", "2"],
  ["ai_phone_mem_evt_count_char_alpha", "3"],
  ["ai_phone_mem_last_sum_contact_alpha", "2026-11-04T00:00:00.000Z"],
]);
const memoryStorage = await loadTsWithMocks("../lib/memory-storage.ts", {
  "./memory-types": memoryTypes,
  "./kv-db": kvMocksFor(memoryValues),
  "./idb-open": { openIndexedDbAtLeast: async () => fakeDb },
}, { window: {}, indexedDB: {} });
const memoryMigration = await memoryStorage.migrateCharacterMemoryIdentities([
  { fromId: "contact_alpha", toId: "char_alpha" },
]);
assert.equal(memoryMigration.available, true);
assert.equal(memoryMigration.migratedEntries, 1);
assert.equal(memoryRows[0].characterId, "char_alpha");
assert.equal(memoryValues.get("ai_phone_mem_evt_count_char_alpha"), "5");
assert.equal(memoryValues.has("ai_phone_mem_evt_count_contact_alpha"), false);
assert.equal(memoryValues.get("ai_phone_mem_last_sum_char_alpha"), "2026-11-04T00:00:00.000Z");

console.log("Character ID + guided schedule integration checks passed.");
