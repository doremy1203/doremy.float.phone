import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-guided-schedule.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, console, JSON, Set, Map, Array, String, Number, Boolean, RegExp, Date, Math }, { filename: "life-guided-schedule.cjs" });
const { parseGuidedScheduleResponse } = moduleBox.exports;

const now = new Date("2026-11-05T08:00:00.000Z");
// Match production's local-calendar boundaries. UTC midnight becomes the
// previous local evening in America/New_York and incorrectly makes same-day
// guided schedule entries appear to be in the past during the DST run.
const dayStart = new Date(now);
dayStart.setHours(0, 0, 0, 0);
const dayEnd = new Date(dayStart);
dayEnd.setDate(dayEnd.getDate() + 7);
const contexts = [{
  ownerType: "character", ownerId: "char-a", name: "小满", now, dayStart, dayEnd,
  existing: [
    { id: "flex-1", startAt: "2026-11-05T13:00:00.000Z", endAt: "2026-11-05T14:00:00.000Z", title: "原学习", source: "weekly-generation", kind: "study" },
    { id: "flex-2", startAt: "2026-11-05T15:00:00.000Z", endAt: "2026-11-05T16:00:00.000Z", title: "原散步", source: "manual", kind: "free-time" },
    { id: "fixed-1", startAt: "2026-11-05T17:00:00.000Z", endAt: "2026-11-05T18:00:00.000Z", title: "已确认约会", source: "event", kind: "appointment" },
  ],
}];

const result = parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "keep", existingScheduleId: "fixed-1" },
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "move", existingScheduleId: "flex-1", dayOffset: 0, start: "14:00", end: "15:00", title: "调整后的学习", location: "图书馆", reason: "避开冲突" },
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "cancel", existingScheduleId: "flex-2", reason: "为用户指定的活动腾出时间" },
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "add", existingScheduleId: "", dayOffset: 0, start: "15:00", end: "16:00", title: "和用户一起散步", location: "公园", reason: "符合用户目标" },
] }), contexts);
assert.equal(result.drafts.length, 3);
assert.deepEqual(Array.from(result.drafts, item => item.operation), ["move", "cancel", "add"]);
assert.equal(result.conflicts.length, 0);
assert.equal(result.rejected.length, 0);

const protectedResult = parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "cancel", existingScheduleId: "fixed-1", reason: "尝试取消固定邀约" },
] }), contexts);
assert.equal(protectedResult.drafts.length, 0);
assert.equal(protectedResult.rejected.length, 1);
assert.match(protectedResult.rejected[0], /已开始、已过去或已确认的固定日程/);

const wrongIdentity = parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char-a", actorType: "player", actorName: "小满", operation: "keep", existingScheduleId: "flex-1" },
] }), contexts);
assert.equal(wrongIdentity.drafts.length, 0);
assert.equal(wrongIdentity.rejected.length, 1);

const legacy = parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char-a", actorType: "character", actorName: "小满", dayOffset: 0, start: "19:00", end: "20:00", title: "晚间阅读", location: "家" },
] }), contexts);
assert.equal(legacy.drafts.length, 1);
assert.equal(legacy.drafts[0].operation, "add");

 
// Any free-time placeholder is an open slot, even when it was saved as a manual edit.
const overwriteFreeTime = parseGuidedScheduleResponse(JSON.stringify({ schedules: [
  { actorId: "char-a", actorType: "character", actorName: "小满", operation: "add", dayOffset: 0, start: "15:00", end: "16:00", title: "去花店", location: "花店", reason: "用自由时间安排活动" },
] }), contexts);
assert.equal(overwriteFreeTime.drafts.length, 1, "AI should be allowed to add an activity over free-time");
assert.equal(overwriteFreeTime.conflicts.length, 0, "free-time must not be reported as a conflict");
assert.equal(overwriteFreeTime.rejected.length, 0);

console.log("Life guided schedule re-plan tests passed.");
