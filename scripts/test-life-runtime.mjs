import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Exercise the shared location-room helpers through the runtime module, not a stub.

const source = readFileSync(new URL("../lib/life/life-runtime.ts", import.meta.url), "utf8");
const engineSource = readFileSync(new URL("../lib/life/life-engine.ts", import.meta.url), "utf8");
const compile = input => ts.transpileModule(input, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const engineBox = { exports: {} };
vm.runInNewContext(compile(engineSource), {
  module: engineBox, exports: engineBox.exports, Date, Math, console,
}, { filename: "life-engine.cjs" });
const moduleBox = { exports: {} };
const sandbox = {
  module: moduleBox,
  exports: moduleBox.exports,
  Date, Math, console,
  require: specifier => specifier === "./life-engine" ? engineBox.exports : {},
};
vm.runInNewContext(compile(source), sandbox, { filename: "life-runtime.cjs" });
const { applyCharacterLifeScheduleChange, confirmLifeInvitation, generateWeeklyLifePlan, getCurrentActorSchedule, insertManualLifeScheduleSlot, overlayScheduleSlotsOverFreeTime, placeAppointmentInActorSchedule, resolveActorLifeNow, settleActorTimelineToNow, syncScheduleLocationsToLibrary, synchronizeCharacterHomeSchedule, reserveCharacterLocationStay, resolveActorLocation } = moduleBox.exports;
assert.equal(typeof generateWeeklyLifePlan, "function", "weekly planner should be exported");
assert.equal(typeof getCurrentActorSchedule, "function", "current schedule selector should be exported");
assert.equal(typeof insertManualLifeScheduleSlot, "function", "manual schedule insertion should be exported");
assert.equal(typeof settleActorTimelineToNow, "function", "timeline settlement should be exported");

assert.equal(typeof confirmLifeInvitation, "function", "invitation confirmation should be exported");
assert.equal(typeof placeAppointmentInActorSchedule, "function", "appointment placement should be exported");


function makeState(schedules = []) {
  return {
    schedules,
    actorStates: [],
    locations: [],
    settings: {},
  };
}

function localIso(dayOffset, hour, minute = 0) {
  const date = new Date(2026, 9, 12, 0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date.toISOString();
}

function assertWeekHasNoGapsOrOverlaps(schedules, ownerType, ownerId, weekStart) {
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  for (let offset = 0; offset < 7; offset++) {
    const dayStart = new Date(start);
    dayStart.setDate(start.getDate() + offset);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const daySlots = schedules
      .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
      .filter(slot => new Date(slot.startAt) < dayEnd && new Date(slot.endAt) > dayStart)
      .map(slot => ({ ...slot, start: new Date(slot.startAt).getTime(), end: new Date(slot.endAt).getTime() }))
      .sort((a, b) => a.start - b.start);
    let cursor = dayStart.getTime();
    for (const slot of daySlots) {
      assert.equal(slot.start, cursor, `gap or overlap on day ${offset}: ${slot.title}`);
      assert.ok(slot.end > slot.start, "every schedule slot must have positive duration");
      cursor = slot.end;
    }
    assert.equal(cursor, dayEnd.getTime(), `day ${offset} must be fully covered`);
  }
}

const weekStart = new Date(2026, 9, 12, 0, 0, 0, 0);
const emptyPlan = generateWeeklyLifePlan(makeState(), "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.ok(emptyPlan.schedules.length >= 60, "a new week should receive a complete schedule skeleton");
assertWeekHasNoGapsOrOverlaps(emptyPlan.schedules, "player", "player", weekStart);

const dstWeekStart = new Date(2026, 2, 2, 0, 0, 0, 0);
const dstWeekPlan = generateWeeklyLifePlan(
  makeState(),
  "player",
  "player",
  "我",
  dstWeekStart,
  { id: "home", name: "家" },
  "",
  false,
);
assertWeekHasNoGapsOrOverlaps(dstWeekPlan.schedules, "player", "player", dstWeekStart);


// A single manually added appointment must not block generation of the rest of the week.
const appointment = {
  id: "manual-appointment",
  ownerType: "player",
  ownerId: "player",
  startAt: localIso(1, 10),
  endAt: localIso(1, 11),
  title: "重要约定",
  kind: "appointment",
  source: "event",
  plannedLocationId: "cafe",
  plannedLocationName: "街角咖啡店",
  updatedAt: new Date().toISOString(),
};
const partial = generateWeeklyLifePlan(makeState([appointment]), "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.ok(partial.schedules.some(slot => slot.id === appointment.id), "existing appointment must be preserved");
assertWeekHasNoGapsOrOverlaps(partial.schedules, "player", "player", weekStart);

const partiallyGeneratedWeek = makeState([{
  id: "legacy-generated-monday-sleep",
  ownerType: "player",
  ownerId: "player",
  startAt: localIso(0, 0),
  endAt: localIso(0, 7),
  title: "睡眠",
  kind: "habit",
  source: "weekly-generation",
  plannedLocationId: "home",
  plannedLocationName: "家",
}]);
const repairedWeek = generateWeeklyLifePlan(
  partiallyGeneratedWeek,
  "player",
  "player",
  "我",
  weekStart,
  { id: "home", name: "家" },
  "",
  false,
);
assert.ok(
  repairedWeek.schedules.some(slot => slot.id === "legacy-generated-monday-sleep"),
  "repairing a partial week must preserve existing generated slots",
);
assertWeekHasNoGapsOrOverlaps(repairedWeek.schedules, "player", "player", weekStart);


// Re-opening or re-running generation must not reroll a week already generated.
const rerun = generateWeeklyLifePlan(partial, "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false);
assert.equal(rerun, partial, "an already generated week must remain stable");
 
// A future manual slot must not prevent generation of the current calendar week.
const futureSlot = {
  id: "future-manual-slot",
  ownerType: "player",
  ownerId: "player",
  startAt: "2026-10-20T10:00:00.000Z",
  endAt: "2026-10-20T11:00:00.000Z",
  title: "下周的手动安排",
  kind: "special",
  source: "manual",
  updatedAt: "2026-10-15T15:00:00.000Z",
};
const currentWeekWithFutureSlot = generateWeeklyLifePlan(
  makeState([futureSlot]), "player", "player", "我", weekStart, { id: "home", name: "家" }, "", false,
);
assert.ok(
  currentWeekWithFutureSlot.schedules.some(slot => slot.source === "weekly-generation" && new Date(slot.startAt) < new Date("2026-10-19T00:00:00.000Z")),
  "a future manual slot must not block generation of the current calendar week",
);

 
// Inserting a manual activity should carve the generated baseline around it,
// keeping the rest of the day covered without overlapping slots.
const manualActivity = {
  id: "new-manual-activity",
  ownerType: "player",
  ownerId: "player",
  startAt: localIso(1, 10),
  endAt: localIso(1, 11),
  title: "临时安排",
  kind: "free-time",
  source: "manual",
  plannedLocationName: "街角咖啡店",
  updatedAt: new Date().toISOString(),
};
const inserted = insertManualLifeScheduleSlot(emptyPlan, manualActivity);
assert.equal(inserted.conflict, undefined, "ordinary generated slots should be safely split");
assert.ok(inserted.state.schedules.some(slot => slot.id === manualActivity.id), "manual activity should be inserted");
assertWeekHasNoGapsOrOverlaps(inserted.state.schedules, "player", "player", weekStart);
 
// Moving a manual plan must restore its old interval as free time before the
// new interval is inserted; deleting a manual plan follows the same invariant.
const restoredOldInterval = {
  ...manualActivity,
  id: "restored-old-interval",
  title: "自由活动",
  kind: "free-time",
  source: "weekly-generation",
};
const planWithoutOriginal = {
  ...inserted.state,
  schedules: [
    ...inserted.state.schedules.filter(slot => slot.id !== manualActivity.id),
    restoredOldInterval,
  ],
};
const movedManualActivity = insertManualLifeScheduleSlot(planWithoutOriginal, {
  ...manualActivity,
  startAt: localIso(1, 12),
  endAt: localIso(1, 13),
});
assert.equal(movedManualActivity.conflict, undefined);
assertWeekHasNoGapsOrOverlaps(movedManualActivity.state.schedules, "player", "player", weekStart);
const deletedPlanRestored = {
  ...inserted.state,
  schedules: [
    ...inserted.state.schedules.filter(slot => slot.id !== manualActivity.id),
    restoredOldInterval,
  ],
};
assertWeekHasNoGapsOrOverlaps(deletedPlanRestored.schedules, "player", "player", weekStart);


// Confirmed appointments and other user-authored slots are protected from silent overwrite.
const protectedAppointment = {
  ...manualActivity,
  id: "confirmed-appointment",
  title: "已确认约会",
  kind: "appointment",
  source: "event",
};
const withAppointment = { ...emptyPlan, schedules: [...emptyPlan.schedules, protectedAppointment] };
const blocked = insertManualLifeScheduleSlot(withAppointment, manualActivity);
assert.equal(blocked.conflict?.id, protectedAppointment.id, "manual insertion must report confirmed appointment conflicts");
assert.equal(blocked.state, withAppointment, "a conflicting insert must leave the schedule unchanged");

const characterToolPlan = { ...manualActivity, id: "character-tool-plan", title: "角色主动调整的计划", kind: "study", source: "character-tool" };
const withCharacterToolPlan = { ...emptyPlan, schedules: [...emptyPlan.schedules, characterToolPlan] };
const blockedByCharacterTool = insertManualLifeScheduleSlot(withCharacterToolPlan, { ...manualActivity, id: "overlapping-user-plan" });
assert.equal(blockedByCharacterTool.conflict?.id, characterToolPlan.id, "manual plans must not silently overwrite a character-authored schedule change");

const overlapState = makeState([
  { id: "earlier", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z", title: "旧安排" },
  { id: "later", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "新安排" },
]);
assert.equal(
  getCurrentActorSchedule(overlapState, "character", "c1", new Date("2026-10-15T10:30:00.000Z"))?.id,
  "later",
  "legacy overlapping slots should resolve deterministically to the most recently started slot",
);

assert.equal(
  getCurrentActorSchedule(makeState([
    { id: "same-start-old", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z", title: "较早修改", updatedAt: "2026-10-14T00:00:00.000Z" },
    { id: "same-start-new", ownerType: "character", ownerId: "c1", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "较新修改", updatedAt: "2026-10-15T09:00:00.000Z" },
  ]), "character", "c1", new Date("2026-10-15T10:30:00.000Z"))?.id,
  "same-start-new",
  "same-start legacy overlaps should use updatedAt as a deterministic tie-breaker",
);


// If a schedule was removed or ended and no replacement covers the current time,
// the actor must not retain a stale slot id or claim to still be doing the old activity.
const now = new Date("2026-10-15T15:00:00.000Z");
const staleState = {
  ...makeState([{
    id: "old-slot", ownerType: "character", ownerId: "c1",
    startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T10:00:00.000Z",
    title: "已结束的旧安排", kind: "work", source: "manual",
    plannedLocationId: "office", plannedLocationName: "办公室", updatedAt: now.toISOString(),
  }]),
  actorClocks: [{
    ownerType: "character", ownerId: "c1", mode: "real-time",
    realAnchorAt: now.toISOString(), virtualAnchorAt: now.toISOString(), speed: 1, updatedAt: now.toISOString(),
  }],
  actorStates: [{
    ownerType: "character", ownerId: "c1", activity: "已结束的旧安排",
    scheduleSlotId: "old-slot", actualLocationId: "office", actualLocationName: "办公室",
    updatedAt: now.toISOString(),
  }],
  events: [], memories: [], invitations: [], scenes: [], timeline: [],
  settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我" },
  updatedAt: now.toISOString(),
};
const settled = settleActorTimelineToNow(staleState, "character", "c1", now);
const settledActor = settled.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c1");
assert.equal(settledActor?.scheduleSlotId, null, "stale schedule references must be cleared");
assert.equal(settledActor?.activity, "自由活动", "actor should leave an ended activity when no current slot exists");
const eventTime = "2026-10-15T13:00:00.000Z";
const nowTime = new Date("2026-10-15T15:00:00.000Z");
function stateWithCompletedSharedEvent(allowMemory) {
  return {
    ...makeState(),
    actorClocks: [
      { ownerType: "player", ownerId: "player", mode: "real-time", realAnchorAt: nowTime.toISOString(), virtualAnchorAt: nowTime.toISOString(), speed: 1, updatedAt: nowTime.toISOString() },
      { ownerType: "character", ownerId: "c1", mode: "real-time", realAnchorAt: nowTime.toISOString(), virtualAnchorAt: nowTime.toISOString(), speed: 1, updatedAt: nowTime.toISOString() },
    ],
    actorStates: [],
    events: [{ id: "event-1", kind: "invitation", status: "active", startsAt: eventTime, endsAt: "2026-10-15T14:00:00.000Z", participantIds: ["player", "c1"], title: "一起喝咖啡", details: "confirmed-appointment", createdAt: eventTime, updatedAt: eventTime }],
    memories: [],
    invitations: [],
    scenes: [{ id: "scene-1", locationId: "cafe", locationName: "咖啡店", startedAt: eventTime, updatedAt: "2026-10-15T14:00:00.000Z", status: "completed", eventId: "event-1", participants: [], lastSettledEventIds: [] }],
    timeline: [],
    settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: allowMemory },
  };
}
assert.equal(settleActorTimelineToNow(stateWithCompletedSharedEvent(false), "character", "c1", nowTime).memories.length, 0);
assert.equal(settleActorTimelineToNow(stateWithCompletedSharedEvent(true), "character", "c1", nowTime).memories.length, 1);
const apNow = new Date("2026-10-15T13:30:00.000Z");
const apStart = "2026-10-15T13:00:00.000Z";
const apEnd = "2026-10-15T14:00:00.000Z";
const apSlots = ["player", "c1"].map(ownerId => ({
  id: "ap-" + ownerId,
  ownerType: ownerId === "player" ? "player" : "character",
  ownerId,
  startAt: apStart,
  endAt: apEnd,
  title: "一起喝咖啡",
  kind: "appointment",
  source: "event",
  plannedLocationId: "cafe",
  plannedLocationName: "街角咖啡店",
  updatedAt: apNow.toISOString(),
}));
const apState = {
  ...makeState(apSlots),
  actorClocks: ["player", "c1"].map(ownerId => ({ ownerType: ownerId === "player" ? "player" : "character", ownerId, mode: "real-time", realAnchorAt: apNow.toISOString(), virtualAnchorAt: apNow.toISOString(), speed: 1, updatedAt: apNow.toISOString() })),
  actorStates: [{ ownerType: "player", ownerId: "player", activity: "在家", actualLocationId: "home", actualLocationName: "家", updatedAt: apNow.toISOString() }, { ownerType: "character", ownerId: "c1", activity: "在家", actualLocationId: "home", actualLocationName: "家", updatedAt: apNow.toISOString() }],
  events: [{ id: "ap-event", kind: "invitation", status: "confirmed", startsAt: apStart, endsAt: apEnd, locationId: "cafe", locationName: "街角咖啡店", participantIds: ["player", "c1"], title: "一起喝咖啡", details: "confirmed-appointment", createdAt: apStart, updatedAt: apStart }],
  invitations: [], scenes: [], memories: [], timeline: [],
  locations: [{ id: "home", name: "家", visibility: "private" }, { id: "cafe", name: "街角咖啡店", visibility: "public" }],
  settings: { defaultClockMode: "real-time", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const apStarted = settleActorTimelineToNow(apState, "player", "player", apNow);
assert.equal(apStarted.events[0].status, "active");
assert.equal(apStarted.scenes.length, 1, "an appointment must reuse/create one location room, not a separate event room");
assert.equal(apStarted.scenes[0].locationId, "cafe");
assert.equal(apStarted.scenes[0].status, "paused", "scheduled events must not steal the foreground room");
assert.equal(apStarted.scenes[0].eventId, undefined, "new location rooms must not be keyed as event scenes");
assert.equal(apStarted.actorStates.find(actor => actor.ownerType === "player").actualLocationId, "cafe");

const appointmentWithNamedLocation = {
  ...apState,
  events: apState.events.map(event => ({ ...event, locationId: undefined, locationName: "Cafe Alias" })),
  locations: apState.locations.map(location => location.id === "cafe" ? { ...location, aliases: ["Cafe Alias"] } : location),
};
const settledNamedLocation = settleActorTimelineToNow(appointmentWithNamedLocation, "player", "player", apNow);
assert.equal(settledNamedLocation.scenes[0].locationId, "cafe", "event location aliases must resolve to the canonical location id rather than the player's prior location");


const apCharacterSettled = settleActorTimelineToNow(apStarted, "character", "c1", apNow);
assert.equal(apCharacterSettled.actorStates.find(actor => actor.ownerType === "character").actualLocationId, "cafe");

const caughtUpAfterAppointment = settleActorTimelineToNow(
  apState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(
  caughtUpAfterAppointment.events.find(event => event.id === "ap-event")?.status,
  "completed",
  "a confirmed appointment crossed entirely during catch-up should be completed, not marked missed",
);
assert.equal(caughtUpAfterAppointment.scenes.length, 1, "catch-up should retain one canonical location room");
assert.equal(caughtUpAfterAppointment.scenes[0].locationId, "cafe");
assert.equal(caughtUpAfterAppointment.scenes[0].status, "paused", "a completed event must not complete its location chat room");
assert.equal(caughtUpAfterAppointment.scenes[0].eventId, undefined);
assert.equal(
  caughtUpAfterAppointment.memories.length,
  1,
  "an elapsed confirmed shared appointment should be eligible for life-memory persistence",
);

const existingSharedSceneState = {
  ...apState,
  scenes: [{
    id: "scene-opened-manually",
    locationId: "cafe",
    locationName: "街角咖啡店",
    startedAt: apStart,
    updatedAt: apStart,
    status: "active",
    participants: [
      { ownerType: "player", ownerId: "player", activity: "喝咖啡", awarenessByActorId: {} },
      { ownerType: "character", ownerId: "c1", activity: "喝咖啡", awarenessByActorId: {} },
      { ownerType: "character", ownerId: "c2", activity: "在店里看书", awarenessByActorId: { player: "aware" } },
    ],
    lastSettledEventIds: [],
  }],
};
const attachedExistingScene = settleActorTimelineToNow(
  existingSharedSceneState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(attachedExistingScene.scenes.length, 1, "catch-up should reuse an existing matching shared scene");
assert.equal(attachedExistingScene.scenes[0].id, "scene-opened-manually", "the elapsed appointment should reuse the existing location room");
assert.equal(attachedExistingScene.scenes[0].eventId, undefined, "legacy event identity must not partition the location room");
assert.equal(attachedExistingScene.scenes[0].status, "active", "settling an appointment must not change the current room state");
assert.deepEqual(
  Array.from(attachedExistingScene.scenes[0].participants, participant => participant.ownerType + ":" + participant.ownerId),
  ["player:player", "character:c1", "character:c2"],
  "settling an appointment must preserve other people already in the location room",
);
assert.equal(attachedExistingScene.events.find(event => event.id === "ap-event")?.status, "completed");

const activeAppointmentWithoutScene = {
  ...apState,
  events: apState.events.map(event => event.id === "ap-event" ? { ...event, status: "active" } : event),
};
const recoveredActiveAppointment = settleActorTimelineToNow(
  activeAppointmentWithoutScene,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(
  recoveredActiveAppointment.events.find(event => event.id === "ap-event")?.status,
  "completed",
  "an already-active appointment that lost its scene should be recovered during catch-up",
);
assert.equal(recoveredActiveAppointment.scenes.length, 1);
assert.equal(recoveredActiveAppointment.scenes[0].locationId, "cafe");
assert.equal(recoveredActiveAppointment.scenes[0].status, "paused");
assert.equal(recoveredActiveAppointment.scenes[0].eventId, undefined, "recovery must create a location room, not an event room");

const staleCompletedSceneState = {
  ...activeAppointmentWithoutScene,
  scenes: [{
    id: "ap-existing-scene",
    locationId: "cafe",
    locationName: "街角咖啡店",
    startedAt: apStart,
    updatedAt: apEnd,
    status: "completed",
    eventId: "ap-event",
    participants: [
      { ownerType: "player", ownerId: "player", activity: "一起喝咖啡", awarenessByActorId: {} },
      { ownerType: "character", ownerId: "c1", activity: "一起喝咖啡", awarenessByActorId: {} },
    ],
    lastSettledEventIds: [],
  }],
};
const recoveredStaleScene = settleActorTimelineToNow(
  staleCompletedSceneState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(recoveredStaleScene.scenes.length, 1, "recovery must reuse the event-linked scene even when its previous status was stale");
assert.equal(recoveredStaleScene.scenes[0].id, "ap-existing-scene");
assert.equal(recoveredStaleScene.scenes[0].status, "paused", "legacy completed event rooms are folded back into reusable location rooms");
assert.equal(recoveredStaleScene.scenes[0].eventId, undefined);

const staleActiveSceneState = {
  ...activeAppointmentWithoutScene,
  scenes: [{
    id: "unrelated-active-scene",
    locationId: "home",
    locationName: "家",
    startedAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    status: "active",
    participants: [
      { ownerType: "player", ownerId: "player", activity: "在家", awarenessByActorId: {} },
    ],
    lastSettledEventIds: [],
  }],
};
const recoveredOngoingAppointment = settleActorTimelineToNow(
  staleActiveSceneState,
  "player",
  "player",
  apNow,
);
assert.equal(
  recoveredOngoingAppointment.scenes.find(scene => scene.id === "unrelated-active-scene")?.status,
  "active",
  "recovering an ongoing appointment must not switch the user's currently open room",
);
assert.equal(recoveredOngoingAppointment.scenes.length, 2);
assert.equal(recoveredOngoingAppointment.scenes.find(scene => scene.locationId === "cafe")?.status, "paused");
assert.equal(recoveredOngoingAppointment.scenes.find(scene => scene.locationId === "cafe")?.eventId, undefined);

const historicalAppointmentWithCurrentScene = settleActorTimelineToNow(
  staleActiveSceneState,
  "player",
  "player",
  new Date("2026-10-15T15:00:00.000Z"),
);
assert.equal(
  historicalAppointmentWithCurrentScene.scenes.find(scene => scene.id === "unrelated-active-scene")?.status,
  "active",
  "catching up a historical appointment must not pause the current active scene",
);




const malformedInvitationState = {
  ...makeState(),
  invitations: [{
    id: "malformed-invite",
    status: "proposed",
    proposedAt: "not-a-date",
    durationMinutes: Number.NaN,
    characterId: "c1",
    playerId: "player",
    activity: "无效约会",
  }],
  events: [],
};
assert.equal(
  confirmLifeInvitation(malformedInvitationState, "malformed-invite"),
  malformedInvitationState,
  "invalid invitation dates must not create malformed events",
);
const malformedLegacySlot = {
  id: "legacy-invalid-slot",
  ownerType: "player",
  ownerId: "player",
  startAt: "invalid",
  endAt: "invalid",
  title: "旧数据",
};
const placedAppointment = placeAppointmentInActorSchedule(
  makeState([malformedLegacySlot]),
  {
    id: "valid-appointment",
    ownerType: "player",
    ownerId: "player",
    startAt: "2026-10-15T10:00:00.000Z",
    endAt: "2026-10-15T11:00:00.000Z",
    title: "有效约会",
    kind: "appointment",
    source: "event",
  },
);
assert.ok(placedAppointment.schedules.some(slot => slot.id === "legacy-invalid-slot"), "appointment placement must not silently delete malformed legacy slots");


assert.equal(typeof synchronizeCharacterHomeSchedule, "function", "cohabitation migration should be a testable runtime operation");
const homeMigrationNow = new Date("2026-10-15T10:30:00.000Z");
const homeMigrationState = {
  ...makeState([
    { id: "past-home", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T08:00:00.000Z", endAt: "2026-10-15T09:00:00.000Z", title: "在家休息", kind: "habit", source: "weekly-generation", plannedLocationId: "home-c-home", plannedLocationName: "小明的家", updatedAt: "2026-10-15T08:00:00.000Z" },
    { id: "active-home", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "在家休息", kind: "habit", source: "weekly-generation", plannedLocationId: "home-c-home", plannedLocationName: "小明的家", updatedAt: "2026-10-15T10:00:00.000Z" },
    { id: "future-home", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T13:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z", title: "回家做自己的事", kind: "free-time", source: "weekly-generation", plannedLocationId: "home-c-home", plannedLocationName: "小明的家", updatedAt: "2026-10-15T13:00:00.000Z" },
    { id: "future-work", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T14:00:00.000Z", endAt: "2026-10-15T15:00:00.000Z", title: "公司工作", kind: "work", source: "weekly-generation", plannedLocationId: "office", plannedLocationName: "公司", updatedAt: "2026-10-15T14:00:00.000Z" },
    { id: "manual-home", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T15:00:00.000Z", endAt: "2026-10-15T16:00:00.000Z", title: "手动安排在家", kind: "free-time", source: "manual", plannedLocationId: "home-c-home", plannedLocationName: "小明的家", updatedAt: "2026-10-15T15:00:00.000Z" },
    { id: "generic-rest-outing", ownerType: "character", ownerId: "c-home", startAt: "2026-10-15T16:00:00.000Z", endAt: "2026-10-15T17:00:00.000Z", title: "休息", kind: "free-time", source: "weekly-generation", plannedLocationId: "park", plannedLocationName: "公园", updatedAt: "2026-10-15T16:00:00.000Z" },
  ]),
  locations: [
    { id: "home", name: "我的家", visibility: "private" },
    { id: "home-c-home", name: "小明的家", visibility: "private" },
    { id: "home-shared", name: "我们的家", visibility: "private" },
    { id: "office", name: "公司", visibility: "public" },
    { id: "park", name: "公园", visibility: "public" },
  ],
  actorStates: [{ ownerType: "character", ownerId: "c-home", activity: "在家休息", actualLocationId: "home-c-home", actualLocationName: "小明的家", updatedAt: homeMigrationNow.toISOString() }],
};
const movedHome = synchronizeCharacterHomeSchedule(homeMigrationState, {
  characterId: "c-home", destinationHomeId: "home-shared", destinationHomeName: "我们的家", now: homeMigrationNow,
});
assert.equal(movedHome.synchronizedScheduleCount, 2, "only active/future generated home slots should migrate");
const movedHomeSlots = Object.fromEntries(movedHome.state.schedules.map(slot => [slot.id, slot]));
assert.equal(movedHomeSlots["active-home"].plannedLocationId, "home-shared");
assert.equal(movedHomeSlots["future-home"].plannedLocationName, "我们的家");
assert.equal(movedHomeSlots["past-home"].plannedLocationId, "home-c-home", "past home slots remain historical");
assert.equal(movedHomeSlots["future-work"].plannedLocationId, "office", "work schedule remains unchanged");
assert.equal(movedHomeSlots["manual-home"].plannedLocationId, "home-c-home", "explicit manual places are never rewritten");
assert.equal(movedHomeSlots["generic-rest-outing"].plannedLocationId, "park", "generic rest at a non-home location is not misclassified");
const movedHomeActor = movedHome.state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-home");
assert.equal(movedHomeActor.actualLocationId, "home-shared", "an actor currently at their home should move to the shared home");
const restoredHome = synchronizeCharacterHomeSchedule(movedHome.state, {
  characterId: "c-home", destinationHomeId: "home-c-home", destinationHomeName: "小明的家", now: homeMigrationNow,
});
assert.equal(restoredHome.state.schedules.find(slot => slot.id === "future-home").plannedLocationId, "home-c-home", "ending cohabitation restores generated future home slots");
assert.equal(restoredHome.state.schedules.find(slot => slot.id === "manual-home").plannedLocationId, "home-c-home", "manual locations remain untouched when ending cohabitation");
assert.equal(restoredHome.state.actorStates.find(actor => actor.ownerType === "character").actualLocationId, "home-c-home", "an actor at the shared home returns to their personal home when cohabitation ends");


assert.equal(typeof reserveCharacterLocationStay, "function", "manual companion transfer should be a testable runtime operation");
const tripStart = new Date("2026-10-15T10:30:00.000Z");
const requestedTripEnd = new Date("2026-10-15T12:30:00.000Z");
const tripEnd = new Date("2026-10-15T11:00:00.000Z");
const transferState = {
  ...makeState([
    { id: "before-trip", ownerType: "character", ownerId: "c-trip", startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "原地点上午安排", kind: "work", source: "weekly-generation", plannedLocationId: "office", plannedLocationName: "公司", updatedAt: "2026-10-15T09:00:00.000Z" },
    { id: "during-trip", ownerType: "character", ownerId: "c-trip", startAt: "2026-10-15T11:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z", title: "原地点中间安排", kind: "free-time", source: "weekly-generation", plannedLocationId: "park", plannedLocationName: "公园", updatedAt: "2026-10-15T11:00:00.000Z" },
    { id: "crossing-trip-end", ownerType: "character", ownerId: "c-trip", startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T13:00:00.000Z", title: "原地点下午安排", kind: "study", source: "weekly-generation", plannedLocationId: "library", plannedLocationName: "图书馆", updatedAt: "2026-10-15T12:00:00.000Z" },
    { id: "after-trip", ownerType: "character", ownerId: "c-trip", startAt: "2026-10-15T13:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z", title: "后续安排", kind: "work", source: "weekly-generation", plannedLocationId: "office", plannedLocationName: "公司", updatedAt: "2026-10-15T13:00:00.000Z" },
    { id: "other-character", ownerType: "character", ownerId: "c-other", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "其他角色安排", kind: "work", source: "weekly-generation", plannedLocationId: "office", plannedLocationName: "公司", updatedAt: "2026-10-15T10:00:00.000Z" },
  ]),
  actorStates: [],
  locations: [],
};
const transferred = reserveCharacterLocationStay(transferState, {
  characterId: "c-trip",
  locationId: "cafe",
  locationName: "街角咖啡店",
  startAt: tripStart,
  endAt: requestedTripEnd,
  title: "与我同行：前往街角咖啡店",
});
const tripSlots = transferred.schedules.filter(slot => slot.ownerType === "character" && slot.ownerId === "c-trip");
const truncated = tripSlots.find(slot => slot.id === "before-trip");
assert.equal(truncated.endAt, tripStart.toISOString(), "the elapsed prefix of the interrupted itinerary remains intact");
assert.ok(tripSlots.some(slot => slot.source === "manual" && slot.plannedLocationId === "cafe" && slot.startAt === tripStart.toISOString() && slot.endAt === tripEnd.toISOString()), "manual travel replaces the current activity only until its next schedule boundary");
assert.ok(!tripSlots.some(slot => slot.title === "原地点上午安排" && slot.startAt === tripEnd.toISOString()), "the unfinished tail of the replaced activity must not be restored");
assert.ok(tripSlots.some(slot => slot.id === "during-trip" && slot.startAt === tripEnd.toISOString()), "the next future itinerary entry remains unchanged");
assert.ok(tripSlots.some(slot => slot.id === "crossing-trip-end" && slot.plannedLocationId === "library"), "later future itinerary entries remain intact");
assert.ok(tripSlots.some(slot => slot.id === "after-trip" && slot.plannedLocationId === "office"), "all later slots remain intact");
assert.ok(transferred.schedules.some(slot => slot.id === "other-character"), "other characters' itineraries remain untouched");
const tripActor = transferred.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-trip");
assert.equal(tripActor.actualLocationId, "cafe", "the companion's actual location follows the player");
assert.equal(tripActor.actualLocationUntil, tripEnd.toISOString(), "the manual trip ends at the next planned activity boundary");

const companionOverlay = overlayScheduleSlotsOverFreeTime(transferred, [{
  id: "night-home-generated",
  ownerType: "character",
  ownerId: "c-trip",
  startAt: tripStart.toISOString(),
  endAt: tripEnd.toISOString(),
  title: "夜间私人时间",
  kind: "free-time",
  source: "weekly-generation",
  plannedLocationId: "home-c-trip",
  plannedLocationName: "角色的家",
  updatedAt: tripStart.toISOString(),
}]);
assert.ok(companionOverlay.schedules.some(slot => slot.source === "manual" && slot.plannedLocationId === "cafe"), "weekly generation must not replace the active manual travel slot");
assert.ok(!companionOverlay.schedules.some(slot => slot.id === "night-home-generated"), "conflicting weekly home schedule must be rejected during companion travel");
const companionToolChange = applyCharacterLifeScheduleChange(transferred, "c-trip", {
  startAt: "2026-10-15T10:40:00.000Z",
  endAt: "2026-10-15T10:50:00.000Z",
  title: "角色自主安排",
  locationId: "office",
}, new Date("2026-10-15T10:00:00.000Z"));
assert.ok(companionToolChange.error, "character-authored schedule changes must not overwrite an active manual travel slot");
assert.ok(companionToolChange.state.schedules.some(slot => slot.source === "manual" && slot.plannedLocationId === "cafe"), "rejected autonomous change must preserve the active manual travel slot");
const companionTimelineState = { ...transferred, events: [], memories: [], invitations: [], scenes: [], timeline: [], settings: { playerDisplayName: "我", saveConfirmedEventsToMemory: true } };
const duringCompanionStay = settleActorTimelineToNow(companionTimelineState, "character", "c-trip", new Date("2026-10-15T10:45:00.000Z"));
const duringCompanionActor = duringCompanionStay.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-trip");
assert.equal(duringCompanionActor.actualLocationId, "cafe", "timeline settlement keeps the companion at the chosen location during the replacement slot");
assert.equal(duringCompanionActor.actualLocationUntil, tripEnd.toISOString(), "timeline settlement retains the replacement slot boundary");
const afterCompanionStay = settleActorTimelineToNow(duringCompanionStay, "character", "c-trip", tripEnd);
const afterCompanionActor = afterCompanionStay.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-trip");
assert.equal(afterCompanionActor.actualLocationName, "公园", "the next preserved itinerary entry takes over when the replaced activity ends");
assert.ok(afterCompanionActor.actualLocationId, "the resumed schedule resolves to a concrete location id");
assert.equal(afterCompanionActor.activity, "原地点中间安排", "the next preserved itinerary activity resumes without restoring the interrupted activity remainder");



// Schedule place names become editable library entries, while only the slot active
// at the actor's virtual now controls movement (future plans must not teleport).
assert.equal(typeof syncScheduleLocationsToLibrary, "function");
const movementNow = new Date("2026-10-15T10:30:00.000Z");
const movementState = {
  ...makeState([
    { id: "active-slot", ownerType: "character", ownerId: "c-move", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "在咖啡店工作", kind: "habit", source: "weekly-generation", plannedLocationName: "街角咖啡店" },
    { id: "future-slot", ownerType: "character", ownerId: "c-move", startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T13:00:00.000Z", title: "去图书馆", kind: "habit", source: "weekly-generation", plannedLocationName: "城市图书馆" },
  ]),
  actorClocks: [{ ownerType: "character", ownerId: "c-move", mode: "simulation", realAnchorAt: movementNow.toISOString(), virtualAnchorAt: movementNow.toISOString(), speed: 1, updatedAt: movementNow.toISOString() }],
  actorStates: [],
  events: [],
  memories: [],
  invitations: [],
  scenes: [],
  timeline: [],
  locations: [{ id: "home", name: "家", visibility: "private" }],
  settings: { defaultClockMode: "simulation", defaultSpeed: 1, playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const settledMovement = settleActorTimelineToNow(movementState, "character", "c-move", movementNow);
const movedActor = settledMovement.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-move");
assert.equal(movedActor.actualLocationName, "街角咖啡店", "actor should move to the currently active schedule location");
assert.ok(settledMovement.locations.some(location => location.name === "街角咖啡店"), "active schedule location should sync to library");
assert.ok(settledMovement.locations.some(location => location.name === "城市图书馆"), "future schedule location should sync to library without moving actor there");
assert.notEqual(movedActor.actualLocationName, "城市图书馆", "future schedule must not teleport actor");


assert.equal(typeof resolveActorLocation, "function", "all life subsystems should share one location resolver");
const locationNow = new Date("2026-10-15T10:30:00.000Z");
const locationState = {
  ...makeState([
    { id: "current-office", ownerType: "character", ownerId: "c-location", startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z", title: "工作", kind: "work", source: "weekly-generation", plannedLocationId: "office", plannedLocationName: "公司", updatedAt: "2026-10-15T10:00:00.000Z" },
  ]),
  locations: [{ id: "office", name: "公司" }, { id: "cafe", name: "咖啡店" }],
  actorStates: [{ ownerType: "character", ownerId: "c-location", actualLocationId: "cafe", actualLocationName: "咖啡店", locationSource: "manual", manualSetAt: "2026-10-15T10:00:00.000Z", updatedAt: locationNow.toISOString() }],
};
assert.equal(resolveActorLocation(locationState, "character", "c-location", locationNow).id, "cafe", "manual actual location should override a different planned location");
const expiredLocationState = {
  ...locationState,
  actorStates: [{ ...locationState.actorStates[0], actualLocationUntil: "2026-10-15T10:00:00.000Z" }],
};
assert.equal(resolveActorLocation(expiredLocationState, "character", "c-location", locationNow).id, "office", "an expired temporary override should resume the current schedule");
const temporaryLocationState = {
  ...locationState,
  actorStates: [{ ...locationState.actorStates[0], actualLocationUntil: "2026-10-15T12:00:00.000Z" }],
};
assert.equal(resolveActorLocation(temporaryLocationState, "character", "c-location", locationNow).id, "cafe", "an active temporary location should override the schedule");

const manualTravelNow = new Date("2026-10-15T10:30:00.000Z");
const manualTravelState = {
  ...makeState([{
    id: "home-routine",
    ownerType: "character",
    ownerId: "c-travel",
    startAt: "2026-10-15T10:00:00.000Z",
    endAt: "2026-10-15T12:00:00.000Z",
    title: "在家洗澡、听故事",
    kind: "habit",
    source: "weekly-generation",
    plannedLocationId: "home-c-travel",
    plannedLocationName: "角色的家",
    updatedAt: "2026-10-15T10:00:00.000Z",
  }]),
  actorStates: [{
    ownerType: "character", ownerId: "c-travel", activity: "与玩家同行",
    scheduleSlotId: "previous-slot", actualLocationId: "bedroom",
    actualLocationName: "玩家所在卧室", actualLocationUntil: null,
    locationSource: "manual", manualSetAt: "2026-10-15T10:20:00.000Z",
    updatedAt: "2026-10-15T10:20:00.000Z",
  }],
  events: [], memories: [], invitations: [], scenes: [], timeline: [],
  locations: [{ id: "home-c-travel", name: "角色的家" }, { id: "bedroom", name: "玩家所在卧室" }],
  settings: { playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const settledManualTravel = settleActorTimelineToNow(manualTravelState, "character", "c-travel", manualTravelNow);
const manualTravelActor = settledManualTravel.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-travel");
assert.equal(manualTravelActor.actualLocationId, "bedroom",
  "an explicit manual location must survive a newly active home schedule");
assert.equal(manualTravelActor.activity, "与玩家同行",
  "schedule settlement must not overwrite the activity during a manual location override");
assert.equal(manualTravelActor.manualSetAt, "2026-10-15T10:20:00.000Z",
  "settlement must never refresh the manual TTL marker");
assert.equal(manualTravelActor.locationSource, "manual",
  "an active manual override keeps its manual source marker");

// The 2-hour TTL is measured from manualSetAt only; once it elapses the schedule
// owns presence again even when no slot currently covers the moment.
const manualExpiredAt = new Date("2026-10-15T12:21:00.000Z");
const settledExpiredManual = settleActorTimelineToNow(manualTravelState, "character", "c-travel", manualExpiredAt);
const expiredManualActor = settledExpiredManual.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === "c-travel");
assert.equal(expiredManualActor.actualLocationId, "home-c-travel",
  "an expired manual location must fall back to the character's residence when no slot is active");
assert.equal(expiredManualActor.locationSource, "schedule",
  "expired manual overrides must clear the manual source marker");

const playerRoomState = {
  ...makeState([{
    id: "player-next-slot",
    ownerType: "player",
    ownerId: "player",
    startAt: "2026-10-15T10:00:00.000Z",
    endAt: "2026-10-15T12:00:00.000Z",
    title: "去公园散步",
    kind: "habit",
    source: "weekly-generation",
    plannedLocationId: "park",
    plannedLocationName: "公园",
    updatedAt: "2026-10-15T09:00:00.000Z",
  }]),
  actorStates: [{
    ownerType: "player", ownerId: "player", activity: "临时停留",
    actualLocationId: "cafe", actualLocationName: "咖啡店",
    actualLocationUntil: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T09:00:00.000Z",
  }],
  events: [], memories: [], invitations: [],
  scenes: [{
    id: "stable-cafe-room", locationId: "cafe", locationName: "咖啡店",
    startedAt: "2026-10-15T08:00:00.000Z", updatedAt: "2026-10-15T09:00:00.000Z",
    status: "active",
    participants: [{ ownerType: "player", ownerId: "player", activity: "聊天", awarenessByActorId: {} }],
    lastSettledEventIds: [],
  }],
  timeline: [],
  locations: [{ id: "cafe", name: "咖啡店" }, { id: "park", name: "公园" }],
  settings: { playerDisplayName: "我", saveConfirmedEventsToMemory: true },
};
const settledPlayerRoom = settleActorTimelineToNow(playerRoomState, "player", "player", locationNow);
assert.equal(settledPlayerRoom.actorStates[0].actualLocationId, "park", "expired stays must still advance the player's actual location");
assert.equal(settledPlayerRoom.scenes[0].id, "stable-cafe-room");
assert.equal(settledPlayerRoom.scenes[0].locationId, "cafe", "schedule settlement must never move the location room or its history");
assert.equal(settledPlayerRoom.scenes[0].status, "active", "schedule settlement must not steal the currently open room");
assert.equal(settledPlayerRoom.timeline.at(-1).sceneId, undefined, "a location movement record must not be attached to the old room");



 
// All legacy per-actor clock records are ignored: schedule time is always wall-clock time.
const wallClockNow = new Date("2026-10-15T10:30:00.000Z");
assert.equal(
  resolveActorLifeNow({ mode: "simulation", realAnchorAt: "2026-10-15T08:00:00.000Z", virtualAnchorAt: "2026-10-20T08:00:00.000Z", speed: 20 }, wallClockNow).getTime(),
  wallClockNow.getTime(),
  "legacy simulation clocks must never shift life-system time",
);

// Automatic generation may replace only generated free-time placeholders.
const freeTimeOverlay = overlayScheduleSlotsOverFreeTime(makeState([{
  id: "free-placeholder", ownerType: "character", ownerId: "c-overlay",
  startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T18:00:00.000Z",
  title: "自由活动", kind: "free-time", source: "weekly-generation",
}]), [{
  id: "ai-study", ownerType: "character", ownerId: "c-overlay",
  startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z",
  title: "学习", kind: "study", source: "weekly-generation",
}]);
assert.ok(freeTimeOverlay.schedules.some(slot => slot.id === "ai-study"), "AI candidate should replace generated free-time");
assert.ok(freeTimeOverlay.schedules.some(slot => slot.startAt === "2026-10-15T09:00:00.000Z" && slot.endAt === "2026-10-15T12:00:00.000Z" && slot.kind === "free-time"), "free-time before the AI plan should be preserved");
assert.ok(freeTimeOverlay.schedules.some(slot => slot.startAt === "2026-10-15T14:00:00.000Z" && slot.endAt === "2026-10-15T18:00:00.000Z" && slot.kind === "free-time"), "free-time after the AI plan should be preserved");
assert.equal(freeTimeOverlay.schedules.filter(slot => slot.ownerId === "c-overlay").length, 3, "overlay should split one generated free-time slot into two edges plus one AI plan");

const manualFreeOverlay = overlayScheduleSlotsOverFreeTime(makeState([{
  id: "manual-free", ownerType: "character", ownerId: "c-manual-free",
  startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T18:00:00.000Z",
  title: "用户安排的自由时间", kind: "free-time", source: "manual",
}]), [{
  id: "ai-study-manual", ownerType: "character", ownerId: "c-manual-free",
  startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z",
  title: "学习", kind: "study", source: "weekly-generation",
}]);
assert.ok(manualFreeOverlay.schedules.some(slot => slot.id === "ai-study-manual"),
  "weekly generation may replace a free-time placeholder even if its legacy source is manual");
assert.ok(manualFreeOverlay.schedules.some(slot => slot.startAt === "2026-10-15T09:00:00.000Z" && slot.endAt === "2026-10-15T12:00:00.000Z"),
  "free-time before the generated activity must be preserved");
assert.ok(manualFreeOverlay.schedules.some(slot => slot.startAt === "2026-10-15T14:00:00.000Z" && slot.endAt === "2026-10-15T18:00:00.000Z"),
  "free-time after the generated activity must be preserved");

const cancelledFreeOverlay = overlayScheduleSlotsOverFreeTime(makeState([{
  id: "cancelled-free", ownerType: "character", ownerId: "c-cancelled",
  startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T18:00:00.000Z",
  title: "自由活动", kind: "free-time", source: "character-tool",
}]), [{
  id: "regenerated-slot", ownerType: "character", ownerId: "c-cancelled",
  startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z",
  title: "自动安排的学习", kind: "study", source: "weekly-generation",
}]);
assert.equal(cancelledFreeOverlay.schedules.length, 1,
  "a cancelled slot represented as character free-time must not be regenerated");
assert.equal(cancelledFreeOverlay.schedules[0]?.id, "cancelled-free",
  "the cancellation tombstone must remain the only overlapping schedule");

const userCanFillCancelledTime = insertManualLifeScheduleSlot(makeState([{
  id: "cancelled-free-manual-fill", ownerType: "character", ownerId: "c-fill",
  startAt: "2026-10-15T09:00:00.000Z", endAt: "2026-10-15T18:00:00.000Z",
  title: "自由活动", kind: "free-time", source: "character-tool",
}]), {
  id: "user-replacement", ownerType: "character", ownerId: "c-fill",
  startAt: "2026-10-15T12:00:00.000Z", endAt: "2026-10-15T14:00:00.000Z",
  title: "用户新安排", kind: "special", source: "manual",
});
assert.equal(userCanFillCancelledTime.conflict, undefined,
  "a user must be able to replace a character's cancelled free-time placeholder");
assert.ok(userCanFillCancelledTime.state.schedules.some(slot => slot.id === "user-replacement"));

// Character-initiated changes may occupy a free-time placeholder, including
// legacy records whose source is manual; real manual activities remain protected.
const autonomyOverFree = applyCharacterLifeScheduleChange(makeState([{
  id: "character-free", ownerType: "character", ownerId: "c-autonomy",
  startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z",
  title: "自由活动", kind: "free-time", source: "manual",
}]), "c-autonomy", {
  startAt: "2026-10-15T10:30:00.000Z", endAt: "2026-10-15T11:30:00.000Z",
  title: "去咖啡店学习",
}, new Date("2026-10-15T09:00:00.000Z"));
assert.equal(autonomyOverFree.error, undefined);
assert.ok(autonomyOverFree.state.schedules.some(slot => slot.title === "去咖啡店学习"),
  "character AI activity may replace a free-time placeholder regardless of legacy source");

const inProgressChange = applyCharacterLifeScheduleChange(makeState([{
  id: "in-progress", ownerType: "character", ownerId: "c-progress",
  startAt: "2026-10-15T08:00:00.000Z", endAt: "2026-10-15T12:00:00.000Z",
  title: "正在学习", kind: "study", source: "weekly-generation",
}]), "c-progress", {
  startAt: "2026-10-15T10:00:00.000Z", endAt: "2026-10-15T11:00:00.000Z",
  title: "临时外出",
}, new Date("2026-10-15T09:00:00.000Z"));
assert.match(inProgressChange.error || "", /冲突/,
  "character tools must not reshape an activity that has already started");


const householdA = { id: "home-a", name: "A的家", residents: ["a"], visibility: "private" };
const householdB = { id: "home-b", name: "B的家", residents: ["b"], visibility: "private" };
const visitToB = {
  id: "a-visits-b", ownerType: "character", ownerId: "a",
  startAt: "2026-12-02T18:00:00.000Z", endAt: "2026-12-02T20:00:00.000Z",
  title: "去B家吃晚饭", kind: "meal", source: "weekly-generation",
  plannedLocationId: "home-b", plannedLocationName: "B的家", updatedAt: "2026-12-01T00:00:00.000Z",
};
const householdState = { ...makeState([visitToB]), locations: [householdA, householdB] };
const syncedA = synchronizeCharacterHomeSchedule(householdState, {
  characterId: "a", destinationHomeId: "home-a", destinationHomeName: "A的家",
  now: new Date("2026-12-01T12:00:00.000Z"),
});
assert.equal(syncedA.state.schedules.find(slot => slot.id === "a-visits-b")?.plannedLocationId, "home-b",
  "changing A's residence must not rewrite A's planned visit to B's home");

const legacyHomeSlot = { ...visitToB, id: "legacy-own-home", title: "在家休息", plannedLocationId: null, plannedLocationName: "家" };
const syncedLegacy = synchronizeCharacterHomeSchedule(
  { ...householdState, schedules: [legacyHomeSlot] },
  { characterId: "a", destinationHomeId: "home-a", destinationHomeName: "A的家", now: new Date("2026-12-01T12:00:00.000Z") },
);
assert.equal(syncedLegacy.state.schedules[0].plannedLocationId, "home-a",
  "unresolved legacy home slots should migrate to the actor's own home");

const generatedWithVisit = generateWeeklyLifePlan(
  householdState, "character", "a", "A", new Date("2026-12-01T00:00:00.000Z"), undefined, "", false,
);
assert.equal(generatedWithVisit.schedules.find(slot => slot.id === "a-visits-b")?.plannedLocationId, "home-b",
  "weekly plan migration must preserve an explicit visit to another character's home");

const scheduleStart = "2026-12-02T18:00:00.000Z";
const scheduleEnd = "2026-12-02T19:00:00.000Z";
const createVisit = applyCharacterLifeScheduleChange(householdState, "a", {
  startAt: scheduleStart, endAt: scheduleEnd, title: "去B家吃饭", locationId: "home-b",
}, new Date("2026-12-01T12:00:00.000Z"));
assert.equal(createVisit.error, undefined, "a character should be able to schedule a visit to another known household");
assert.equal(createVisit.state.schedules.find(slot => slot.id.startsWith("life-tool-plan-a-"))?.plannedLocationId, "home-b");

const invalidDestination = applyCharacterLifeScheduleChange(householdState, "a", {
  startAt: scheduleStart, endAt: scheduleEnd, title: "去不存在的地方", locationId: "missing-home",
}, new Date("2026-12-01T12:00:00.000Z"));
assert.match(invalidDestination.error ?? "", /不存在/);
assert.equal(invalidDestination.state, householdState,
  "an unknown location must not silently fall back to the player's home");

const defaultOwnHome = applyCharacterLifeScheduleChange(householdState, "a", {
  startAt: scheduleStart, endAt: scheduleEnd, title: "回家休息",
}, new Date("2026-12-01T12:00:00.000Z"));
assert.equal(defaultOwnHome.state.schedules.find(slot => slot.id.startsWith("life-tool-plan-a-"))?.plannedLocationId, "home-a",
  "an omitted destination should resolve to the actor's own residence, not the player's home");

const importedDossier = {
  id: "imported-place-old-town-flower-shop", name: "旧城区花店",
  description: "临街的老式花店，窗边有自然光。", atmosphere: "安静、清新。",
  layout: "入口朝街，柜台在右侧。", props: ["花桶", "剪刀"],
  sourceRefs: [{ sourceKey: "worldbook:city:flower-shop", kind: "worldbook", worldBookId: "city", entryUid: "flower-shop", importedAt: "2026-11-15T00:00:00.000Z" }],
  visibility: "public",
};
const oldScheduleStub = { id: "schedule-place-old-town-flower-shop", name: "旧城区花店", description: "由角色日程自动同步建立；可在地点库中继续编辑。", atmosphere: "", layout: "", props: [], visibility: "public" };
const placeholderState = makeState([{
  id: "slot-old-flower-shop", ownerType: "character", ownerId: "a",
  startAt: "2026-12-02T08:00:00.000Z", endAt: "2026-12-02T09:00:00.000Z",
  title: "去花店", kind: "free-time", source: "weekly-generation",
  plannedLocationId: oldScheduleStub.id, plannedLocationName: oldScheduleStub.name, updatedAt: "2026-12-01T00:00:00.000Z",
}]);
placeholderState.locations = [oldScheduleStub, importedDossier];
placeholderState.actorStates = [{ ownerType: "character", ownerId: "a", activity: "在花店", actualLocationId: oldScheduleStub.id, actualLocationName: oldScheduleStub.name, updatedAt: "2026-12-01T00:00:00.000Z" }];
placeholderState.scenes = [{ id: "scene-old-flower-shop", locationId: oldScheduleStub.id, locationName: oldScheduleStub.name, startedAt: "2026-12-02T08:00:00.000Z", updatedAt: "2026-12-02T08:00:00.000Z", status: "active", participants: [], lastSettledEventIds: [] }];
const remappedLocations = syncScheduleLocationsToLibrary(placeholderState);
assert.equal(remappedLocations.schedules[0].plannedLocationId, importedDossier.id, "a schedule-only placeholder must remap to a richer imported location dossier");
assert.equal(remappedLocations.schedules[0].plannedLocationName, importedDossier.name);
assert.equal(remappedLocations.locations.find(location => location.id === importedDossier.id).sourceRefs[0].sourceKey, importedDossier.sourceRefs[0].sourceKey, "schedule synchronization must preserve imported provenance");
assert.equal(remappedLocations.locations.length, 2, "remapping should not duplicate the imported dossier");
assert.equal(remappedLocations.actorStates[0].actualLocationId, importedDossier.id, "active actor state must follow the remapped canonical location");
assert.equal(remappedLocations.scenes[0].locationId, importedDossier.id, "active scenes must follow the remapped canonical location");

const generatedResidenceState = generateWeeklyLifePlan(makeState(), "character", "char-without-home", "测试角色", new Date("2026-12-01T00:00:00.000Z"), undefined, "", false);
assert.ok(generatedResidenceState.locations.some(location => location.id === "home-char-without-home"), "weekly generation must persist the actor personal home in the location catalog");
assert.ok(generatedResidenceState.schedules.some(slot => slot.ownerId === "char-without-home" && slot.plannedLocationId === "home-char-without-home"), "generated home schedule slots must reference the canonical personal home ID");

console.log("Life schedule regression tests passed.");
