import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-engine.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox, exports: moduleBox.exports,
  console, JSON, Set, Map, Array, String, Number, Boolean, RegExp, Date, Math,
}, { filename: "life-engine.cjs" });
const { buildLifeSceneResponderQueue, findCurrentLifeScene, findLifeSceneForLocation, mergeLifeSceneParticipants } = moduleBox.exports;

assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: true, randomSeed: 1,
    selectedCharacterId: "a", awarenessCharacterId: "c",
  })),
  ["b", "a", "c"],
  "random + specified + awareness can produce three distinct responders in order",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: true, randomSeed: 1,
    selectedCharacterId: "b", awarenessCharacterId: "b",
  })),
  ["b"],
  "the same character selected by all three routes must respond only once",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b", "c"], randomEnabled: false, randomSeed: 1,
    selectedCharacterId: "a", awarenessCharacterId: "c",
  })),
  ["a", "c"],
  "manual mode keeps the specified and independently aware characters without random selection",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: ["a", "b"], randomEnabled: true, randomSeed: 0,
    awarenessCharacterId: "b",
  })),
  ["a", "b"],
  "random mode can add a separate awareness responder",
);
assert.deepEqual(
  Array.from(buildLifeSceneResponderQueue({
    presentCharacterIds: [], randomEnabled: true, randomSeed: 0,
    selectedCharacterId: "missing", awarenessCharacterId: "missing",
  })),
  [],
  "non-present characters are never queued",
);


const foregroundRoom = findCurrentLifeScene([
  { id: "legacy-active", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", status: "active", eventId: "old-event", participants: [], lastSettledEventIds: [] },
  { id: "location-active", locationId: "home", locationName: "家", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z", status: "paused", participants: [], lastSettledEventIds: [] },
]);
assert.equal(foregroundRoom.id, "location-active", "legacy event-linked scenes must not win foreground selection over a location room");
assert.equal(findCurrentLifeScene([{ id: "completed-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", status: "completed", participants: [], lastSettledEventIds: [] }]), undefined, "completed rooms must not reopen as the foreground scene");

const fiveRooms = ["home", "cafe", "park", "library", "studio"].map((locationId, index) => ({
  id: "room-" + locationId,
  locationId,
  locationName: locationId,
  startedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: new Date(Date.UTC(2026, 10, 10 + index)).toISOString(),
  status: index === 4 ? "active" : "paused",
  participants: [{ ownerType: "player", ownerId: "player", activity: "在这里" }],
  lastSettledEventIds: [],
}));
for (const locationId of ["home", "cafe", "park", "library", "studio"]) {
  assert.equal(findLifeSceneForLocation(fiveRooms, locationId)?.id, "room-" + locationId,
    "five coexisting rooms must always resolve by location ID, not whichever room was updated last");
}
assert.equal(findLifeSceneForLocation(fiveRooms, "home")?.id, "room-home",
  "a newer update to another location must not rotate the player's home room");
assert.equal(findLifeSceneForLocation(fiveRooms, "museum"), undefined,
  "a missing location must not fall back to an unrelated room");
const characterOnlyRoom = {
  id: "room-work",
  locationId: "work",
  locationName: "公司",
  startedAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T08:00:00.000Z",
  status: "paused",
  participants: [{ ownerType: "character", ownerId: "a", activity: "正在工作" }],
  lastSettledEventIds: [],
};
const roomsWithoutPlayerParticipation = [...fiveRooms, characterOnlyRoom];
assert.equal(findLifeSceneForLocation(roomsWithoutPlayerParticipation, "work")?.id, "room-work",
  "a player entering a character's existing schedule location must reuse its room even when the player did not participate in the earlier schedule");
const repeatedLocationHops = ["work", "home", "cafe", "park", "work", "home", "work", "cafe", "home"];
assert.deepEqual(
  repeatedLocationHops.map(locationId => findLifeSceneForLocation(roomsWithoutPlayerParticipation, locationId)?.id),
  ["room-work", "room-home", "room-cafe", "room-park", "room-work", "room-home", "room-work", "room-cafe", "room-home"],
  "repeated navigation must always resolve the same location-owned room and never rotate room identity",
);


const canonicalRoom = findLifeSceneForLocation([
  { id: "legacy-event-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z", status: "active", eventId: "old-event", participants: [], lastSettledEventIds: [] },
  { id: "canonical-location-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", status: "paused", participants: [], lastSettledEventIds: [] },
], "cafe");
assert.equal(canonicalRoom.id, "canonical-location-room", "a normal location room must win over a newer legacy event-linked room");
const distinctSameNameRoom = findLifeSceneForLocation([
  { id: "same-name-other-location", locationId: "cafe-branch", locationName: "咖啡店", startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-11-16T00:00:00.000Z", status: "active", participants: [], lastSettledEventIds: [] },
  { id: "correct-location-room", locationId: "cafe", locationName: "咖啡店", startedAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", status: "paused", participants: [], lastSettledEventIds: [] },
], "cafe", "咖啡店");
assert.equal(distinctSameNameRoom.id, "correct-location-room", "same-named but distinct locations must never share a chat room");

const mergedParticipants = mergeLifeSceneParticipants(
  [
    { ownerType: "player", ownerId: "player", activity: "在咖啡店", awarenessByActorId: { a: "aware" } },
    { ownerType: "character", ownerId: "a", activity: "正在看书", awarenessByActorId: { player: "aware" } },
    { ownerType: "character", ownerId: "b", activity: "正在喝咖啡", awarenessByActorId: { player: "suspects" } },
  ],
  [
    { ownerType: "player", ownerId: "player", activity: "刚来到这里", awarenessByActorId: {} },
    { ownerType: "character", ownerId: "a", activity: "正在看书", awarenessByActorId: { player: "aware", b: "aware" } },
    { ownerType: "character", ownerId: "c", activity: "刚刚同行到达", awarenessByActorId: { player: "aware" } },
  ],
);
assert.deepEqual(
  Array.from(mergedParticipants, item => item.ownerType + ":" + item.ownerId),
  ["player:player", "character:a", "character:b", "character:c"],
  "destination room members are retained and newly arrived companions are appended exactly once",
);
assert.equal(mergedParticipants.find(item => item.ownerId === "player").activity, "刚来到这里");
assert.equal(mergedParticipants.find(item => item.ownerId === "a").awarenessByActorId.b, "aware");

const lifeApp = readFileSync(new URL("../components/life/life-engine-app.tsx", import.meta.url), "utf8");
assert.doesNotMatch(lifeApp, /setSelectedLocationId\(currentPlayerLocation\.id\)/,
  "background schedule settlement must never switch the room currently viewed by the player");
assert.match(lifeApp, /life:last-viewed-location/,
  "the last explicitly viewed location must be restored when reopening the life app");
assert.match(lifeApp, /setSelectedLocationId\(restoredLocationId\)/,
  "initial room selection must prefer the saved room and fall back to the player's actual location");
assert.match(lifeApp, /const actualCharacters = characters\.filter\(char =>[\s\S]*?actor\.actualLocationId === destination\.id/,
  "entering a location must discover characters by their current actual location, even when the player was absent from their earlier schedule");
assert.match(lifeApp, /const existingScene = findLifeSceneForLocation\(stateRef\.current\.scenes, destination\.id\)/,
  "entering a scheduled location must resolve its existing location-owned room");
assert.match(lifeApp, /const retainedDestinationParticipants = \(existingScene\?\.participants \?\? \[\]\)/,
  "re-entering a location must preserve participants already belonging to that room");
assert.match(lifeApp, /mergeLifeSceneParticipants\([\s\S]*?retainedDestinationParticipants/,
  "the existing destination room and currently present characters must be merged without rotating room identity");


console.log("Life scene responder queue and destination participant merge tests passed.");
