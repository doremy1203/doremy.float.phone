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
const { beginTurn, getActiveTurn, listActiveTurns, abortTurnsForCharacter, abortTurnsForSession } = moduleBox.exports;

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

// A group turn locks every participant atomically and is visible through each character.
const group = beginTurn({
  kind: "user_reply",
  characterId: "char-a",
  participantIds: ["char-a", "char-b", "char-c", "char-b"],
  sessionId: "group-session",
});
assert.ok(group, "group reply should acquire all participant locks");
assert.equal(listActiveTurns().length, 1, "one group turn must be listed once");
assert.equal(getActiveTurn("char-b", "another-session")?.turnId, group.turnId, "group turn must own every participant");
assert.equal(beginTurn({ kind: "life_scene", characterId: "char-c", sessionId: "life-session" }), null, "life autonomy must not race a group participant");
const otherCharacter = beginTurn({ kind: "user_reply", characterId: "char-d", sessionId: "direct-session" });
assert.ok(otherCharacter, "unrelated characters remain independently available");
assert.equal(abortTurnsForCharacter("char-b"), 1, "aborting one participant must abort the whole group turn once");
assert.equal(group.signal.aborted, true, "participant cancellation must abort group generation");
assert.equal(getActiveTurn("char-a", "group-session"), null, "all group participant locks must be released together");
otherCharacter.end();

const group2 = beginTurn({ kind: "user_reply", characterId: "char-a", participantIds: ["char-a", "char-b"], sessionId: "group-session-2" });
assert.ok(group2);
assert.equal(abortTurnsForSession("group-session-2"), 1, "session cancellation counts a multi-lock turn once");
assert.equal(group2.signal.aborted, true);
assert.equal(listActiveTurns().length, 0);

// Preempting a group turn through one member must release the other members too.
const group3 = beginTurn({ kind: "user_reply", characterId: "char-a", participantIds: ["char-a", "char-b", "char-c"], sessionId: "group-session-3" });
assert.ok(group3);
const replacement = beginTurn({ kind: "user_reply", characterId: "char-a", sessionId: "direct-session-3" });
assert.ok(replacement, "a new direct user reply may replace the previous user reply");
assert.equal(group3.signal.aborted, true);
assert.equal(getActiveTurn("char-b", "group-session-3"), null, "preempting one participant must release every old group lock");
replacement.end();
assert.equal(listActiveTurns().length, 0);

console.log("Turn coordinator cross-channel and group arbitration tests passed.");
