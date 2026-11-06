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
const { buildLifeSceneResponderQueue } = moduleBox.exports;

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

console.log("Life scene responder queue tests passed.");
