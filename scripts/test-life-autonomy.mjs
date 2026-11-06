import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../lib/life/life-autonomy.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleBox = { exports: {} };
vm.runInNewContext(compiled, { module: moduleBox, exports: moduleBox.exports, Date, Math, console }, { filename: "life-autonomy.cjs" });
const { evaluateLifeAutonomyWindow, chooseLifeAutonomyCharacter, resolveLifeCharacterIdForContact } = moduleBox.exports;

const now = new Date("2026-10-17T12:00:00.000Z").getTime();
const scene = {
  id: "scene-1",
  status: "active",
  participants: [
    { ownerType: "player", ownerId: "player", activity: "在场" },
    { ownerType: "character", ownerId: "c1", activity: "看书" },
    { ownerType: "character", ownerId: "c2", activity: "喝咖啡" },
  ],
};
const base = {
  scene,
  playerId: "player",
  messages: [],
  now,
  lastAttemptAt: now - 10 * 60_000,
  intervalMinutes: 5,
  busy: false,
  visible: true,
  enabled: true,
};
assert.equal(evaluateLifeAutonomyWindow(base).eligible, true, "eligible co-present scene can take an autonomous turn");
assert.deepEqual(Array.from(evaluateLifeAutonomyWindow(base).characterIds), ["c1", "c2"]);

assert.equal(evaluateLifeAutonomyWindow({ ...base, enabled: false }).reason, "disabled");
assert.equal(evaluateLifeAutonomyWindow({ ...base, visible: false }).reason, "app-not-visible");
assert.equal(evaluateLifeAutonomyWindow({ ...base, busy: true }).reason, "another-turn-running");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, status: "paused" } }).reason, "no-active-scene");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, participants: scene.participants.filter(p => p.ownerType !== "player") } }).reason, "player-not-present");
assert.equal(evaluateLifeAutonomyWindow({ ...base, scene: { ...scene, participants: scene.participants.filter(p => p.ownerType !== "character") } }).reason, "no-character-present");
assert.equal(evaluateLifeAutonomyWindow({ ...base, lastAttemptAt: now - 60_000 }).reason, "cooldown");

const recentMessage = { sceneId: scene.id, role: "player", createdAt: new Date(now - 30_000).toISOString() };
assert.equal(evaluateLifeAutonomyWindow({ ...base, messages: [recentMessage] }).reason, "recent-scene-message");

const dailyMessages = Array.from({ length: 12 }, (_, index) => ({
  sceneId: scene.id,
  role: "character",
  createdAt: new Date(now - (index + 1) * 10 * 60_000).toISOString(),
}));
assert.equal(evaluateLifeAutonomyWindow({ ...base, messages: dailyMessages }).reason, "daily-limit");

assert.equal(chooseLifeAutonomyCharacter(["c1", "c2"], "c1") !== "c1", true, "speaker selection should avoid immediate repetition where possible");
assert.equal(chooseLifeAutonomyCharacter([], undefined), null);
const c1SpokeRecently = [{
  sceneId: scene.id,
  role: "character",
  speakerId: "c1",
  createdAt: new Date(now - 60_000).toISOString(),
}];
assert.equal(
  chooseLifeAutonomyCharacter(["c1", "c2"], undefined, c1SpokeRecently, scene.id),
  "c2",
  "proactive selection should favor a character who has not spoken in the current scene",
);

const contacts = [{ id: "contact-uuid-123", characterId: "character-id-456" }];
assert.equal(resolveLifeCharacterIdForContact("contact-uuid-123", contacts), "character-id-456", "contact ID must resolve to the linked character ID");
assert.equal(resolveLifeCharacterIdForContact("character-id-456", contacts), null, "character ID must not be treated as a contact ID");
assert.equal(resolveLifeCharacterIdForContact("missing-contact", contacts), null, "unknown contact IDs must not resolve");
const chatRoomSource = readFileSync(new URL("../components/chat/chat-room.tsx", import.meta.url), "utf8");
const lifeUiSource = readFileSync(new URL("../components/life/life-engine-app.tsx", import.meta.url), "utf8");
const pushBailoutSource = readFileSync(new URL("../lib/push-bailout-client.ts", import.meta.url), "utf8");
const notificationReplySource = readFileSync(new URL("../lib/notification-reply.ts", import.meta.url), "utf8");
const outboxSource = readFileSync(new URL("../lib/push-outbox-client.ts", import.meta.url), "utf8");
const pushGenerateSource = readFileSync(new URL("../supabase/functions/push-generate/index.ts", import.meta.url), "utf8");
const diagnosticsSource = readFileSync(new URL("../components/settings/runtime-diagnostics.tsx", import.meta.url), "utf8");
assert.ok(lifeUiSource.includes("armLifeSceneProactiveBailout"), "active life scenes must arm a server-side proactive fallback while the WebView is available");
assert.ok(lifeUiSource.includes("cancelLifeSceneProactiveBailouts"), "foreground takeover must cancel the matching server fallback to avoid duplicate turns");
assert.ok(!lifeUiSource.includes("后台/关闭应用时继续主动推送"), "life settings must not expose offline push");
assert.ok(lifeUiSource.includes("evaluateLifeAutonomyWindow"), "foreground life-scene autonomy must remain enabled");
assert.ok(notificationReplySource.includes("mirrorNotificationReplyToLifeScene"), "notification replies must be mirrored into the active life scene");
assert.ok(notificationReplySource.includes("notification-reply-"), "life-scene notification writeback must use a dedupe key");
assert.ok(pushBailoutSource.includes("lifeScene: { sceneId: input.sceneId, characterId: input.characterId"), "background life-scene job must carry scene and character identity");
assert.ok(outboxSource.includes("const lifeScene = meta.lifeScene;") && outboxSource.includes("life-outbox-"), "server outbox must restore life-scene output to the durable scene message log");
assert.ok(pushGenerateSource.includes('kind: "life_scene"') && pushGenerateSource.includes('(isLifeSceneNotification ? "/life"'), "background life-scene push must deep-link to life scene rather than ordinary chat");
assert.ok(diagnosticsSource.includes('id: "life-scene-outbox"') && diagnosticsSource.includes('id: "life-notification-reply-writeback"'), "runtime diagnostics must expose background outbox and notification reply checks");
assert.ok(!lifeUiSource.includes("__group__") && lifeUiSource.includes("participantIds: explicitParticipants"), "life-scene generation must use explicit participants and must not depend on a global group collage");
assert.ok(chatRoomSource.includes("resolveSessionCharacterId(session)"), "online follow-up arbitration must resolve the session contact ID through the shared character-identity resolver");
assert.ok(pushBailoutSource.includes("if (characterId && isCharacterCoPresentInLifeScene(characterId)) return null;"), "normal online-reply offline fallback must not race a co-present life-scene character");
assert.ok(pushBailoutSource.includes("resolveSessionCharacterId(session)"), "offline follow-up and idle-reconnect guards must resolve contact IDs to character IDs");
assert.ok(pushBailoutSource.includes("resolveSessionCharacterId(replySession)"), "reply bailout must resolve the session contact to the life-scene character");

console.log("Life autonomy guardrail tests passed.");
