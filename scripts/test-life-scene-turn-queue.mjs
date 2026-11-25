import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-scene-turn-queue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const values = new Map();
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
};
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, {
  module: moduleBox,
  exports: moduleBox.exports,
  window: { localStorage },
  Date, Math, console,
}, { filename: "life-scene-turn-queue.cjs" });

const {
  clearActiveLifeSceneTurn,
  recoverPendingLifeSceneTurns,
  savePendingLifeSceneTurns,
  setActiveLifeSceneTurn,
} = moduleBox.exports;
const first = { sceneId: "scene-a", userText: "第一条", userAction: "", createdAt: "2026-11-16T10:00:00.000Z", messageId: "turn-1" };
const second = { sceneId: "scene-a", userText: "第二条", userAction: "", createdAt: "2026-11-16T10:00:01.000Z", messageId: "turn-2" };

setActiveLifeSceneTurn(first);
savePendingLifeSceneTurns([first, second, second]);
clearActiveLifeSceneTurn("not-the-active-turn");
const recovered = recoverPendingLifeSceneTurns();
assert.deepEqual(Array.from(recovered, turn => turn.messageId), ["turn-1", "turn-2"], "recovery must restore the in-flight turn first and deduplicate queued turns");
const recoveredAgain = recoverPendingLifeSceneTurns();
assert.deepEqual(Array.from(recoveredAgain, turn => turn.messageId), ["turn-1", "turn-2"], "recovered turns remain durable until the caller completes them");

clearActiveLifeSceneTurn("turn-1");
console.log("Life scene turn queue persistence tests passed.");
