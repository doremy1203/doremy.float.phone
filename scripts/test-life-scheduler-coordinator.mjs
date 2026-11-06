import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-scheduler-coordinator.ts", import.meta.url), "utf8");
const proactive = readFileSync(new URL("../lib/life/life-proactive-scheduler.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const values = new Map();
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key),
};
const moduleBox = { exports: {} };
const dispatchedEvents = [];
const sandbox = { module: moduleBox, exports: moduleBox.exports, window: { dispatchEvent: event => dispatchedEvents.push(event.type) }, localStorage, Date, Math, Event, console };
vm.runInNewContext(compiled, sandbox, { filename: "life-scheduler-coordinator.cjs" });
const {
  LIFE_SCENE_FOREGROUND_LEASE_KEY,
  LIFE_PRESENCE_LEASE_UPDATED_EVENT,
  setLifeSceneForegroundLease,
  readLifeSceneForegroundLease,
  setOnlineChatForegroundLease,
  readOnlineChatForegroundLease,
} = moduleBox.exports;

setLifeSceneForegroundLease("scene-a", true);
assert.equal(readLifeSceneForegroundLease().sceneId, "scene-a", "visible scene should own the lease");
setLifeSceneForegroundLease("scene-b", false);
assert.equal(readLifeSceneForegroundLease().sceneId, "scene-a", "a different scene must not clear the current lease");
assert.ok(values.has(LIFE_SCENE_FOREGROUND_LEASE_KEY));
setLifeSceneForegroundLease("scene-a", false);
assert.equal(readLifeSceneForegroundLease(), null, "the owning scene should be able to release its lease");
setLifeSceneForegroundLease("scene-a", true);
assert.equal(readLifeSceneForegroundLease(Date.now() + 121_000), null, "an expired lease must not block offline jobs");

setOnlineChatForegroundLease("char-a", "chat-a", true);
assert.equal(readOnlineChatForegroundLease().characterId, "char-a", "visible direct chat should publish its character lease");
setOnlineChatForegroundLease("char-b", "chat-b", false);
assert.equal(readOnlineChatForegroundLease().sessionId, "chat-a", "a different chat must not clear the active lease");
setOnlineChatForegroundLease("char-a", "chat-a", false);
assert.equal(readOnlineChatForegroundLease(), null, "closing the owning direct chat should release its lease");
setOnlineChatForegroundLease("char-a", "chat-a", true);
assert.equal(readOnlineChatForegroundLease(Date.now() + 91_000), null, "a stale direct-chat lease must expire");
assert.equal(dispatchedEvents.length, 8, "every scene/chat lease mutation must notify the cloud snapshot scheduler");
assert.ok(dispatchedEvents.every(type => type === LIFE_PRESENCE_LEASE_UPDATED_EVENT), "lease notifications must use the shared event");
assert.match(proactive, /LIFE_PRESENCE_LEASE_UPDATED_EVENT, onScheduleChanged/);
assert.match(proactive, /parsed\.cloudManaged === true && .*armed.*true/);
assert.match(proactive, /if \(result\.ok\) \{\s*try \{ localStorage\.setItem\(ARM_META_PREFIX \+ trigger, JSON\.stringify\(\{ executeAt: executeAtMs, cloudManaged: true, armed: true \}\)\)/);
const armHelper = proactive.slice(proactive.indexOf("function nextArmAt"), proactive.indexOf("const armedCache"));
assert.doesNotMatch(armHelper, /localStorage\.setItem/, "the local arm marker must not be committed before the server acknowledges the job");

console.log("Life scheduler coordinator tests passed.");
