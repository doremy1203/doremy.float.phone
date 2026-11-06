import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-notification-queue.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const values = new Map();
let failWrites = false;
const localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => { if (failWrites) throw new Error("quota exceeded"); values.set(key, String(value)); },
};
const moduleBox = { exports: {} };
const dispatchedEvents = [];
const sandbox = { module: moduleBox, exports: moduleBox.exports, window: { dispatchEvent(event) { dispatchedEvents.push(event.type); } }, localStorage, Date, Math, Event, console };
vm.runInNewContext(compiled, sandbox, { filename: "life-notification-queue.cjs" });
const { enqueuePendingLifeSceneReply, peekPendingLifeSceneReply, claimPendingLifeSceneReply, failPendingLifeSceneReply, retryPendingLifeSceneReply, acknowledgePendingLifeSceneReply, readFailedLifeSceneReplies, resetFailedLifeSceneReply } = moduleBox.exports;

const first = { replyId: "reply-1", sceneId: "scene-a", characterId: "char-a", replyMode: "action" };
const second = { replyId: "reply-2", sceneId: "scene-a", characterId: "char-a", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(first);
assert.ok(dispatchedEvents.includes("life-scene-notification-queue-updated"), "queue writes should notify the life app to resume pending work");
enqueuePendingLifeSceneReply(first);
enqueuePendingLifeSceneReply(second);
assert.equal(peekPendingLifeSceneReply().replyId, first.replyId, "queue should preserve FIFO order and deduplicate stable reply IDs");
assert.equal(peekPendingLifeSceneReply().status, "pending");
const claimed = claimPendingLifeSceneReply("reply-1", 1000);
assert.equal(claimed.status, "processing", "claiming a reply should persist a processing lease");
assert.equal(claimPendingLifeSceneReply("reply-1", 1001), null, "a second worker must not claim an already-processing reply");
assert.equal(peekPendingLifeSceneReply(2000).replyId, "reply-1", "processing replies remain durable until acknowledged");
retryPendingLifeSceneReply("reply-1", "model temporarily busy", 2000);
assert.equal(peekPendingLifeSceneReply(2001).attempts, 1, "real model failures should retain their attempt count");
const retryable = peekPendingLifeSceneReply(2001);
assert.equal(retryable.replyId, "reply-1", "failed attempts should remain in the durable queue");
assert.equal(retryable.status, "pending", "retry should return the item to pending");
assert.equal(peekPendingLifeSceneReply(6999).replyId, "reply-1", "retry delay must not discard the queued item");
const claimedAgain = claimPendingLifeSceneReply("reply-1", 7000);
assert.equal(claimedAgain.status, "processing", "reply should be claimable after backoff");
acknowledgePendingLifeSceneReply("reply-1");
assert.equal(peekPendingLifeSceneReply().replyId, second.replyId, "acknowledging a completed reply should expose the next queue item");
acknowledgePendingLifeSceneReply("reply-2");
assert.equal(peekPendingLifeSceneReply(), null, "queue should become empty after all replies are acknowledged");

const third = { replyId: "reply-3", sceneId: "scene-b", characterId: "char-b", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(third);
claimPendingLifeSceneReply("reply-3", 10000);
assert.equal(peekPendingLifeSceneReply(10000).status, "processing");
const { renewPendingLifeSceneReply } = moduleBox.exports;
renewPendingLifeSceneReply("reply-3", 90000);
assert.equal(peekPendingLifeSceneReply(10000 + 90_001).status, "processing", "heartbeat should keep a long-running model request claimed");
assert.equal(peekPendingLifeSceneReply(180001).status, "pending", "expired processing lease should recover after an interrupted page");
acknowledgePendingLifeSceneReply("reply-3");

const exhausted = { replyId: "reply-4", sceneId: "scene-c", characterId: "char-c", replyMode: "action" };
enqueuePendingLifeSceneReply(exhausted);
for (let attempt = 0; attempt < 5; attempt++) {
  const item = peekPendingLifeSceneReply(20000 + attempt * 600000);
  if (item.replyId !== "reply-4") break;
  claimPendingLifeSceneReply("reply-4", 20000 + attempt * 600000);
  retryPendingLifeSceneReply("reply-4", "persistent error", 20000 + attempt * 600000, true);
}
assert.equal(peekPendingLifeSceneReply(9999999), null, "exhausted items should stop retrying after the configured attempt limit");

const stale = { replyId: "reply-stale", sceneId: "scene-gone", characterId: "char-gone", replyMode: "dialogue" };
enqueuePendingLifeSceneReply(stale);
failPendingLifeSceneReply("reply-stale", "scene no longer exists");
assert.equal(peekPendingLifeSceneReply(), null, "terminal stale-scene replies must not block the retry queue");
assert.equal(readFailedLifeSceneReplies().length, 2, "terminal replies and exhausted model failures should remain visible for manual inspection");
resetFailedLifeSceneReply("reply-stale");
assert.equal(peekPendingLifeSceneReply().replyId, "reply-stale", "manual retry should allow a terminal reply to be retried after the scene is restored");
acknowledgePendingLifeSceneReply("reply-stale");
resetFailedLifeSceneReply("reply-4");
assert.equal(readFailedLifeSceneReplies().length, 0, "manual retry should clear the selected exhausted state");
assert.equal(peekPendingLifeSceneReply().replyId, "reply-4", "manual retry should return the reply to the pending queue");
acknowledgePendingLifeSceneReply("reply-4");
for (let index = 0; index < 100; index++) {
  assert.equal(enqueuePendingLifeSceneReply({ replyId: "capacity-" + index, sceneId: "scene-capacity", characterId: "char-capacity", replyMode: "dialogue" }), true);
}
assert.equal(enqueuePendingLifeSceneReply({ replyId: "capacity-overflow", sceneId: "scene-capacity", characterId: "char-capacity", replyMode: "dialogue" }), false, "a full queue must reject new work instead of evicting older replies");
assert.equal(peekPendingLifeSceneReply().replyId, "capacity-0", "queue overflow must preserve the oldest unprocessed reply");
for (let index = 0; index < 100; index++) acknowledgePendingLifeSceneReply("capacity-" + index);

const migratedOverflow = Array.from({ length: 101 }, (_, index) => ({
  replyId: "migrated-" + index, sceneId: "scene-migrated", characterId: "char-migrated", replyMode: "dialogue", status: "pending", attempts: 0,
}));
localStorage.setItem("life-scene-notification-reply-queue-v2", JSON.stringify(migratedOverflow));
assert.equal(peekPendingLifeSceneReply().replyId, "migrated-0");
assert.ok(claimPendingLifeSceneReply("migrated-0", 50000), "oversized migrated queues must still be processable");
acknowledgePendingLifeSceneReply("migrated-0");
assert.equal(peekPendingLifeSceneReply().replyId, "migrated-1", "draining a legacy overflow must preserve FIFO order");
for (let index = 1; index < 101; index++) acknowledgePendingLifeSceneReply("migrated-" + index);
assert.equal(peekPendingLifeSceneReply(), null, "all migrated legacy entries should be drainable");

failWrites = true;
assert.equal(enqueuePendingLifeSceneReply({ replyId: "quota-reply", sceneId: "scene-z", characterId: "char-z", replyMode: "dialogue" }), false, "queue storage failure must be reported so the native queue is not acknowledged");
failWrites = false;


localStorage.setItem("life-scene-notification-reply-queue-v2", JSON.stringify([
  { replyId: "malformed-processing", sceneId: "scene-m", characterId: "char-m", replyMode: "dialogue", status: "processing", processingAt: "not-a-time", attempts: "bad" },
  { replyId: "malformed-status", sceneId: "scene-m", characterId: "char-m", replyMode: "action", status: "unknown", attempts: -4 },
]));
const normalized = peekPendingLifeSceneReply();
assert.equal(normalized.replyId, "malformed-processing");
assert.equal(normalized.status, "pending", "invalid processing leases must recover instead of blocking FIFO");
assert.equal(normalized.attempts, 0, "invalid retry counters must be normalized");
acknowledgePendingLifeSceneReply("malformed-processing");
assert.equal(peekPendingLifeSceneReply().status, "pending", "unknown queue states must recover as pending");

localStorage.setItem("life-scene-notification-reply-queue-v1", JSON.stringify([
  { replyId: "legacy-reply", sceneId: "scene-old", characterId: "char-old", replyMode: "dialogue" },
]));
localStorage.setItem("life-scene-notification-reply-queue-v2", "{corrupted");
assert.equal(peekPendingLifeSceneReply().replyId, "legacy-reply", "corrupted v2 storage should recover legacy queued replies");
localStorage.setItem("life-scene-notification-reply-queue-v2", "[]");
assert.equal(peekPendingLifeSceneReply(), null, "an intentional empty v2 queue must not resurrect stale legacy replies");

console.log("Life notification reply queue tests passed.");
