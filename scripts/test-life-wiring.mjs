import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, runtime, observation, cloud, coordinator, scheduler, bailout, reply, queue, push, chatStorage, nativeBridge, nativeReceiver, chatRoom, mainApp, splashAnimation, builtinPrompts, debugPromptRegistry, debugPromptPanel, watchApp, moduleDiagnostics, runtimeDiagnostics, debugStore, checkinEngine, followUpService, shortTermAssembler] = await Promise.all([
  read("../components/life/life-engine-app.tsx"),
  read("../lib/life/life-runtime.ts"),
  read("../components/life/life-observation.tsx"),
  read("../lib/life/life-schedule-cloud.ts"),
  read("../lib/life/life-scheduler-coordinator.ts"),
  read("../lib/life/life-proactive-scheduler.ts"),
  read("../lib/push-bailout-client.ts"),
  read("../lib/notification-reply.ts"),
  read("../lib/life/life-notification-queue.ts"),
  read("../supabase/functions/push-generate/index.ts"),
  read("../lib/chat-storage.ts"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/NotificationReplyReceiver.kt"),
  read("../components/chat/chat-room.tsx"),
  read("../components/main-app.tsx"),
  read("../components/splash-animation.tsx"),
  read("../lib/builtin-app-prompts.ts"),
  read("../components/debug-prompt-registry.ts"),
  read("../components/debug-prompt-panel.tsx"),
  read("../components/watch-together-app.tsx"),
  read("../components/settings/module-diagnostics.tsx"),
  read("../components/settings/runtime-diagnostics.tsx"),
  read("../lib/debug-store.ts"),
  read("../lib/screenshot/checkin-engine.ts"),
  read("../lib/follow-up-service.ts"),
  read("../lib/short-term-assembler.ts"),
]);

assert.match(app, /if \(settings\.autoGenerateWeeklyPlans\)\s*\{\s*next = generateWeeklyLifePlan/);
assert.match(app, /if \(liveSettings\.autoGenerateWeeklyPlans\)/);
assert.match(app, /<LifeDiagnosticsPanel\s*\/>/);
assert.match(mainApp, /installLifeScheduleProactiveScheduler/);
assert.match(mainApp, /<LifeScheduleScheduler\s*\/>/);
assert.match(mainApp, /className="app-root splash-root" onClick=\{ready \? onEnter : undefined\}/);
assert.doesNotMatch(mainApp, /phone-shell splash-phone-screen" onClick=/);
assert.match(splashAnimation, /splash-animation-stage/);
assert.match(scheduler, /if \(timer\) return \(\) => undefined/);
assert.doesNotMatch(app, /splitLifeReplySegments/);
assert.match(app, /preserveLifeDialogueSegments\(parsed\.dialogues\)/);
assert.match(builtinPrompts, /没有对白也没有动作时，仍输出严格 JSON 对象/);
assert.match(builtinPrompts, /不得连续两轮纯行动/);
assert.match(builtinPrompts, /实际附带截图时，可以描述截图中确实可见的内容/);
for (const appId of ["life", "photo_wall", "checkin", "watch_together", "phone_widget", "reality_bridge"]) {
  assert.match(debugPromptRegistry, new RegExp('id: "' + appId + '"'));
}
assert.match(debugPromptPanel, /activeExtraSnapshot/);
assert.match(debugPromptPanel, /本次真实请求允许的工具/);
assert.match(debugPromptPanel, /getDebugPromptSnapshotByApp/);
assert.match(debugStore, /_promptSnapshotsByApp\.set/);
assert.doesNotMatch(debugPromptRegistry, /snapshotOnly: true/);
assert.match(checkinEngine, /appId: "checkin"/);
for (const appId of ["life", "photo_wall", "checkin", "watch_together", "phone_widget", "reality_bridge"]) {
  assert.match(debugPromptPanel, new RegExp('extraAppId === "' + appId + '"'));
}
assert.match(debugPromptPanel, /previewPromptPayload\(session/);
assert.match(debugPromptPanel, /lifePreviewMode/);
assert.match(debugPromptPanel, /photoWallPreviewMode/);
assert.match(debugPromptPanel, /checkInPreviewKind/);
assert.match(debugPromptPanel, /watchPreviewMode/);
assert.match(debugPromptPanel, /loadWidgetConfig\(\)/);
assert.match(debugPromptPanel, /loadBridgeRules\(\)/);
assert.match(followUpService, /appId: options\?\.appId/);
assert.match(followUpService, /appTags: options\?\.appTags/);
assert.match(watchApp, /frameOverride !== undefined/);
assert.match(watchApp, /framePromise/);
assert.match(watchApp, /watch_last_diagnostics_report_v1/);
assert.match(moduleDiagnostics, /照片墙 · 本机数据检查/);
assert.match(moduleDiagnostics, /一起看 · 最近播放诊断/);
assert.match(moduleDiagnostics, /桌面小组件 · 网页与原生链路/);
assert.match(moduleDiagnostics, /现实桥梁 · 感知桥诊断/);
assert.match(runtimeDiagnostics, /<ModuleDiagnostics\s*\/>/);
assert.match(app, /life-scene-notification-reply/);
assert.match(app, /peekPendingLifeSceneReply/);
assert.match(app, /claimPendingLifeSceneReply/);
assert.match(app, /retryPendingLifeSceneReply/);
assert.match(app, /failPendingLifeSceneReply\(pending\.replyId, reason\)/);
assert.match(app, /failPendingLifeSceneReply/);
assert.match(app, /if \(!ready \|\| busy\) return/);
assert.match(app, /acknowledgePendingLifeSceneReply\(pending\.replyId\)/);
assert.match(app, /outcome === "completed"/);
assert.match(app, /sendSceneTurn\(undefined, true, pending\.replyId\)/);
assert.match(app, /const userText = forceReaction \? "" : sceneInput\.trim\(\)/);
assert.match(app, /const userAction = forceReaction \? "" : sceneActionInput\.trim\(\)/);
assert.match(app, /notification-reply-response-/);
assert.match(app, /const pushSceneMessages = \(messages: LifeSceneMessage\[\], baseState: VirtualLifeState = stateRef\.current\)/);
assert.match(app, /pushSceneMessages\(replyMessages, structuredNext\)/);
assert.match(app, /message\.id === notificationResponsePrefix \+ "-action"/);
assert.match(app, /outcome !== "deferred"/);
assert.match(app, /refreshNotificationReplyQueue\(value => value \+ 1\)/);
const notificationOutcomeIndex = app.indexOf("const outcome = await sendSceneTurn(undefined, true, pending.replyId)");
const notificationAckIndex = app.indexOf("acknowledgePendingLifeSceneReply(pending.replyId)", notificationOutcomeIndex);
assert.ok(notificationOutcomeIndex >= 0 && notificationAckIndex > notificationOutcomeIndex, "notification queue must only acknowledge after the AI turn completes");

assert.match(app, /return "completed"/);
assert.match(app, /return forceReaction \? "deferred" : "failed"/);
assert.match(app, /refreshForegroundLease/);
assert.match(app, /setLifeSceneForegroundLease/);
assert.match(app, /document\.visibilityState === "visible"/);
assert.match(app, /synchronizeCharacterHomeSchedule/);
assert.match(app, /reserveCharacterLocationStay/);
assert.match(app, /前台后续兜底任务已挂载/);
assert.match(app, /请先启用生活系统、角色自主行动和主动消息/);
assert.match(runtime, /export function synchronizeCharacterHomeSchedule/);
assert.match(runtime, /export function reserveCharacterLocationStay/);
assert.match(runtime, /export function resolveActorLocation/);
assert.match(cloud, /resolveActorLocation\(state, "player", "player"\)/);
assert.match(scheduler, /resolveActorLocation\(state, "character", characterId\)/);
assert.match(observation, /生活片段补写完成/);
assert.match(observation, /生活片段补写失败/);
assert.match(observation, /const fromMs = Math\.max\(previousCovered, defaultStart\)/);
assert.match(observation, /coveredUntil: new Date\(nowMs\)\.toISOString\(\)/);
assert.match(observation, /busyRef\.current\.add\(character\.id\)/);
assert.match(cloud, /const fingerprint = JSON\.stringify\(\{ version: 5, playerLocationId, scenes, characterLocations, scheduleSlots, actorStates, scheduleSettings, \.\.\.foregroundLease, \.\.\.onlineChatLeaseSnapshot \}\)/);
assert.match(cloud, /const scheduleSlots = state\.schedules/);
assert.match(cloud, /readOnlineChatForegroundLease/);
assert.match(cloud, /onlineChatLeaseUntil/);
assert.match(cloud, /foregroundLeaseUntil/);
assert.match(cloud, /readLifeSceneForegroundLease/);
assert.match(coordinator, /export function setLifeSceneForegroundLease/);
assert.match(coordinator, /export function readLifeSceneForegroundLease/);
assert.match(coordinator, /120_000/);
assert.match(cloud, /Promise<boolean>/);
assert.match(cloud, /MAX_SNAPSHOT_AGE_MS = 5 \* 60_000/);
assert.match(cloud, /const scheduleSlots = state\.schedules/);
assert.match(cloud, /readOnlineChatForegroundLease/);
assert.match(chatRoom, /setOnlineChatForegroundLease/);
assert.match(chatRoom, /syncLifeScheduleSnapshot\(\)/, "opening or leaving a direct chat must publish its foreground lease to the cloud");
assert.match(chatRoom, /setInterval\(syncCloudLease, 60_000\)/, "cloud chat lease must be renewed before its server-side expiry");
assert.match(chatRoom, /onVisibilityChange/);
assert.match(chatRoom, /setOnlineChatForegroundLease\(characterId, session\.id, false\);[\s\S]*?syncCloudLease\(\);/, "chat unmount must release and publish the cleared lease");
assert.match(push, /isLifeSleepActivity/);
assert.match(push, /appendLifeScheduleContext/);
assert.match(push, /onlineChatCharacterId === lifeSceneMeta\.characterId/);
assert.match(push, /daily generation cap reached/);
assert.match(scheduler, /cloudManaged: true/);
assert.doesNotMatch(scheduler, /remaining: 72|repeatUntil/);

assert.match(scheduler, /await syncLifeScheduleSnapshot\(\)/);
assert.match(scheduler, /rerunRequested = true/);
assert.match(scheduler, /const onScheduleChanged = \(\) => \{ start\(\); \}/);
assert.match(scheduler, /const scene = state\.scenes\.find\(item => item\.status === "active"\s*&& item\.participants\.some/);
assert.match(scheduler, /source: "schedule"/);
assert.match(scheduler, /主动消息已关闭，撤销待执行任务/);
assert.match(scheduler, /云端仍按七日日程计算角色活动与地点/);
assert.match(scheduler, /scene\.status === "active" && participant\.activity !== "离开"/);
assert.doesNotMatch(scheduler, /cancelBailoutPrefix\(prefix\)/);
assert.match(bailout, /input\.source \?\? "foreground"/);
assert.match(bailout, /characterId \+ ":foreground"/);
assert.match(reply, /action: isAction \? text : ""/);
assert.match(reply, /dialogue: isAction \? "" : text/);
assert.match(reply, /通知回复已写入并排队/);
assert.match(reply, /peekPendingReplies/);
assert.match(reply, /acknowledgePendingReplies\?\.\(JSON\.stringify\(completedIds\)\)/);
assert.match(reply, /notification-reply-chat-/);
assert.match(reply, /notificationReplyFlushPromise/);
assert.match(reply, /window\.addEventListener\("life-scene-notification-queue-updated"/);
assert.match(reply, /window\.removeEventListener\("life-scene-notification-queue-updated"/);
assert.match(reply, /if \(result === "retry"\)/);
assert.match(reply, /enqueuePendingLifeSceneReply/);
assert.match(reply, /if \(!queued\)/);
assert.match(chatStorage, /if \(msg\.id\)/);
assert.match(chatStorage, /getSortedSessionMessages\(msg\.sessionId\)\.find/);
assert.match(nativeBridge, /fun peekPendingReplies/);
assert.match(nativeBridge, /fun acknowledgePendingReplies/);
assert.match(nativeReceiver, /fun peekPendingReplies/);
assert.match(nativeReceiver, /fun acknowledgePendingReplies/);
assert.match(nativeReceiver, /import androidx\.core\.app\.RemoteInput/);
assert.doesNotMatch(nativeReceiver, /import android\.app\.RemoteInput/);
assert.match(nativeReceiver, /fun enqueue\([^\n]+\): Boolean/);
assert.match(nativeReceiver, /MAX_QUEUE = 100/);
assert.match(nativeReceiver, /if \(!enqueue\(context, sessionId, text, sceneId, replyMode\)\)/);
assert.match(app, /待处理回复已交给生活现场 AI/);
assert.match(app, /生活现场已生成角色回应/);
assert.match(reply, /enqueuePendingLifeSceneReply/);
assert.match(reply, /window\.location\.assign\("\/life\?sceneId=/);
assert.match(queue, /export function enqueuePendingLifeSceneReply/);
assert.match(queue, /export function claimPendingLifeSceneReply/);
assert.match(queue, /export function retryPendingLifeSceneReply/);
assert.match(queue, /export function failPendingLifeSceneReply/);
assert.match(queue, /export function failPendingLifeSceneReply/);
assert.match(queue, /life-scene-notification-queue-updated/);
assert.match(app, /life-scene-notification-queue-updated/);
assert.match(queue, /export function renewPendingLifeSceneReply/);
assert.match(app, /renewPendingLifeSceneReply\(pending\.replyId\)/);
assert.match(queue, /PROCESSING_LEASE_MS/);
assert.match(push, /snapshot missing; rejected safely/);
assert.match(push, /foreground scene lease active; deferred until/);
assert.match(push, /status: "pending"/);
assert.match(push, /characterLocation === snapshot\.playerLocationId/);
assert.doesNotMatch(push, /characterLocation === snapshot\.playerLocationId \|\| scene\?\.characterIds/);


assert.match(shortTermAssembler, /CUSTOM_APP_TIMELINE_SOURCES = new Set<string>/);
for (const source of ["photo_wall", "watch", "phone_widget", "life"]) {
  assert.ok(shortTermAssembler.includes(`"${source}"`), `short-term timeline source ${source} must be included`);
}
assert.equal((shortTermAssembler.match(/timeline\.filter\(e => CUSTOM_APP_TIMELINE_SOURCES\.has\(e\.sourceApp\)\)/g) ?? []).length, 2,
  "both direct-chat and group-chat assemblers must inject special app timeline entries");
assert.match(shortTermAssembler, /CUSTOM_APP_TIMELINE_SOURCES\.has\(entry\.sourceApp\) \? "recent_custom_app"/);

console.log("Life-system wiring checks passed.");
