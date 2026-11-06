import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/turn-coordinator.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, AbortController, Date, Map, console });
const { beginTurn, getActiveTurn, listActiveTurns } = moduleBox.exports;

const life = beginTurn({ kind: "life_scene", characterId: "char-a", sessionId: "life-session" });
assert.ok(life, "life scene should start when the character is idle");
const chat = beginTurn({ kind: "user_reply", characterId: "char-a", sessionId: "chat-session" });
assert.ok(chat, "direct user reply in another session must take priority");
assert.equal(life.signal.aborted, true, "user reply must preempt the life-scene generation");
assert.equal(life.isCurrent(), false, "preempted life turn must no longer own the character");
assert.equal(getActiveTurn("char-a", "life-session")?.turnId, chat.turnId, "the character-wide turn must be visible from either session");
assert.equal(beginTurn({ kind: "life_scene", characterId: "char-a", sessionId: "life-session" }), null, "life autonomy must not interrupt an active direct chat");
chat.end();
const resumedLife = beginTurn({ kind: "life_scene", characterId: "char-a", sessionId: "life-session" });
assert.ok(resumedLife, "life autonomy can resume after direct chat finishes");
assert.equal(listActiveTurns().length, 1);
resumedLife.end();
assert.equal(listActiveTurns().length, 0);

console.log("Turn coordinator cross-channel arbitration tests passed.");
