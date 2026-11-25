import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [app, runtime, observation, cloud, coordinator, scheduler, bailout, reply, queue, push, chatStorage, nativeBridge, nativeReceiver, chatRoom, mainApp, splashAnimation, builtinPrompts, debugPromptRegistry, debugPromptPanel, watchApp, moduleDiagnostics, runtimeDiagnostics, debugStore, checkinEngine, followUpService, shortTermAssembler, lifePresence, globalNoticeHost, sceneTurnQueue, scenePrompt] = await Promise.all([
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
  read("../lib/life/life-memory-bridge.ts"),
  read("../components/ui/global-notice-host.tsx"),
  read("../lib/life/life-scene-turn-queue.ts"),
  read("../lib/life/life-scene-prompt.ts"),
]);


const updateActorLocationStart = app.indexOf("const updateActorLocation = (actor: ActorChoice, locationId: string) => {");
const transferSceneStart = app.indexOf("const performTransferSceneWithCompanions = (targetLocationId = selectedLocationId) => {", updateActorLocationStart);
assert.ok(updateActorLocationStart >= 0 && transferSceneStart > updateActorLocationStart, "player/character location update handler must remain identifiable");
assert.doesNotMatch(app.slice(updateActorLocationStart, transferSceneStart), /locationId:\s*location\.id/, "changing an actor actual location must not rewrite the room identity");
assert.match(app, /const destinationParticipants = mergeLifeSceneParticipants\(/, "destination room membership must merge existing occupants with arrivals");
assert.match(app, /findLifeSceneForLocation\(stateRef\.current\.scenes, destination\.id\)/, "entering a location must resolve its canonical room");
assert.match(app, /useMemo\(\(\) => findLifeSceneForLocation\(state\.scenes, selectedLocationId\)/, "foreground room must be selected by the currently displayed location");
assert.doesNotMatch(app, /const continuingScene = next\.scenes\.find\(scene => scene\.status === "active"\)/, "timeline settlement must never migrate an arbitrary active room to the player location");
assert.match(app, /const existingRoom = findLifeSceneForLocation\(next\.scenes, location\.id, location\.name\)/, "go-find-character must reuse or create the destination location room");
assert.match(app, /performEnterLocationSolo\(targetLocationId\);/, "the single travel entry must reuse the canonical arrival flow");
assert.match(app, /transferSceneWithCompanions\(location\.id\)/, "location cards must use the merged travel-and-enter entry");
assert.doesNotMatch(app, /进入互动|performCreateScene/, "travel and interaction must stay a single entry, without a second scene-start button");
assert.match(app, /const playerLocation = normalized\.locations\.find\(location => location\.id === restoredPlayer\?\.actualLocationId\)/, "startup must restore from the player actual location before considering a prior room");
assert.match(app, /const roomNeedsUpdate = !playerRoom/, "a new actual location must get its own room instead of borrowing another location room");
assert.doesNotMatch(runtime, /eventId: event\.id,\s*participants/, "scheduled invitations must not create event-owned chat rooms");
assert.doesNotMatch(runtime, /locationId: nextLocationId, locationName: nextLocationName/, "schedule settlement must not rewrite the active room location");

assert.match(app, /setSelectedCharacterIds\(destinationParticipants\.filter\(participant => participant\.ownerType === "character"\)/, "the UI responder selection must include the merged destination occupants");

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
assert.match(builtinPrompts, /禁止连续 2 轮 dialogue 都为空/);
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
assert.match(lifePresence, /allowOnlineChatDuringSleep/);
assert.match(lifePresence, /onlineChatAwakeUntil/);
assert.doesNotMatch(lifePresence, /saveVirtualLifeState|settleActorTimelineToNow/, "chat context assembly must not mutate life state");
assert.match(lifePresence, /wakeForThisReply/, "sleep wake behavior must be derived without a storage write");
assert.match(lifePresence, /findCurrentLifeScene\(state\.scenes\.filter\(belongsToCharacter\)\)/, "online chat presence must resolve the canonical room for that character");
const workshopSearch = await read("../components/phone-qa-app.tsx");
const workshopStyles = await read("../styles/qa.css");
assert.match(workshopSearch, /pendingSearchJump/);
assert.match(workshopSearch, /qa-search-controls/);
assert.match(workshopStyles, /\.qa-search-controls/);
assert.match(globalNoticeHost, /document\.querySelector<HTMLElement>\("\.phone-shell"\)/);
assert.match(globalNoticeHost, /position: inPhoneShell \? "absolute" : "fixed"/);
assert.match(globalNoticeHost, /maxHeight: "min\(70%, 420px\)"/);

assert.match(followUpService, /loaded\.settings\.allowOnlineChatDuringSleep/);
assert.match(followUpService, /getLatestCharacterStateValues\(characterId\)/,
  "missing current-turn anxiety must fall back to the latest state for that same character");
assert.match(followUpService, /value\.name === config\.anxietyFieldName && Number\.isFinite\(value\.value\)/,
  "follow-up must ignore malformed anxiety values");
assert.match(followUpService, /source=\$\{anxietySource\}/,
  "follow-up diagnostics must report whether anxiety came from the current reply or character history");
assert.match(followUpService, /const characterId = session && !session\.isGroup \? resolveSessionCharacterId\(session\) : undefined/,
  "historical state fallback must be scoped to the private session's character");
assert.match(app, /角色睡觉时仍正常回复线上聊天/);
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
assert.match(app, /searchParams\.get\("sceneId"\)/, "notification deep links must select the requested scene");
assert.match(app, /recoverPendingLifeSceneTurns\(\)/, "queued scene turns must recover after the app reloads");
assert.match(app, /setActiveLifeSceneTurn\(pendingTurn\)/, "in-flight scene turns must be persisted before generation");
assert.match(app, /replyToMessageId: pendingTurn\.messageId/, "scene replies must be linked to their player turn for idempotent recovery");
assert.match(app, /item\.replyToMessageId === message\.id/, "regenerating a player message must find its exact response even when later player turns were queued");
assert.match(app, /item\.id === targetMessage\.replyToMessageId/, "regenerating a character message must restore its matching player input");
const regenerateStart = app.indexOf("const regenerateSceneMessage = async");
const pushMessageStart = app.indexOf("const pushSceneMessage =", regenerateStart);
const regenerateSource = app.slice(regenerateStart, pushMessageStart);
assert.match(regenerateSource, /beginTurn\(\{ kind: "life_scene"/, "regeneration must use the shared turn coordinator");
assert.match(regenerateSource, /busyRef\.current = true/, "regeneration must lock the scene composer");
assert.match(regenerateSource, /lifeTurn\.end\(\)/, "regeneration must release its turn lease");
assert.match(app, /buildLifeScenePromptContext\(stateRef\.current, turnScene, target\.id, pendingTurn\?\.messageId\)/, "queued turns must not see later player messages");
assert.match(scenePrompt, /repliesByTurn/, "scene prompt history must restore each reply directly after its player turn");
assert.match(scenePrompt, /for \(const reply of prefix\)/, "queued scene context must exclude replies generated after the queued player turn");
assert.match(shortTermAssembler, /options\?\.includeDirectChatEntries === false/, "life prompts must honor explicit exclusion of direct chat history");
assert.match(shortTermAssembler, /const offlineDirectChatEntries = skipDirectChatEntries\s*\?\s*\[\]/, "direct-chat exclusion must cover offline direct-message timeline entries too");
assert.match(app, /savePendingLifeSceneTurns\(pendingSceneTurnsRef\.current\)/, "new queued scene turns must be persisted");
assert.match(sceneTurnQueue, /life-scene-turn-queue-v1/, "scene turn queue must use a durable versioned storage key");
assert.match(app, /focusScene\(pending\.sceneId\)/, "pending notification replies must reopen their exact scene");
assert.match(app, /const restoredLocationId = savedLocationId[\s\S]*playerLocation\?\.id/, "startup must restore the last viewed room and fall back to the player actual location");
assert.doesNotMatch(app, /findCurrentLifeScene\(state\.scenes\)|findCurrentLifeScene\(normalized\.scenes\)/, "the main life UI must not pick a global foreground room");
assert.match(app, /peekPendingLifeSceneReply/);
assert.match(app, /claimPendingLifeSceneReply/);
assert.match(app, /retryPendingLifeSceneReply/);
assert.match(app, /failPendingLifeSceneReply\(pending\.replyId, reason\)/);
assert.match(app, /failPendingLifeSceneReply/);
assert.match(app, /if \(!ready \|\| busy\) return/);
assert.match(app, /acknowledgePendingLifeSceneReply\(pending\.replyId\)/);
assert.match(app, /outcome === "completed"/);
assert.match(app, /sendSceneTurn\(undefined, true, pending\.replyId\)/);
assert.match(app, /const userText = forceReaction \? "" : queuedTurn\?\.userText \?\? sceneInput\.trim\(\)/);
assert.match(app, /const userAction = forceReaction \? "" : queuedTurn\?\.userAction \?\? sceneActionInput\.trim\(\)/);
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
assert.match(app, /const sharedResidence = current\.locations\.find/);
assert.match(app, /"住所事实：角色住所「"/, "life runtime must inject residence facts, not hardcode natural-language policy");
assert.doesNotMatch(app, /严禁把用户的家当作该角色住所|【住所身份锁定】|必须填写上述住所的准确名称/, "residence policy must live in editable preset entries");
assert.match(builtinPrompts, /LIFE_SCHEDULE_RESIDENCE_PROMPT/);
assert.match(builtinPrompts, /life_schedule_residence_rules/);
assert.match(builtinPrompts, /只有动态上下文明确标记该角色与用户同居/);
assert.match(builtinPrompts, /必须使用允许地点列表中对应的准确地点名称/);
assert.match(app, /const characterHome = sharedResidence/);
assert.match(app, /const homeIntent = !placeKey/);
assert.match(app, /some\(name => normalizeLocation\(name\) === placeKey\)/,
  "generated schedule locations must resolve by exact location name/alias, never substring-match a generic 家");
assert.doesNotMatch(app.slice(app.indexOf("const rawPlace = String(item.location"), app.indexOf("days.add(d);", app.indexOf("const rawPlace = String(item.location"))), /placeKey\.includes\(n\)|n\.includes\(placeKey\)/,
  "generic home labels must not collide with the player's or another character's home");
assert.match(app, /plannedLocationName:place\?\.name \?\? \(homeIntent \? character\.name \+ "的家"/,
  "unresolved non-home places must not be silently reassigned to a home");
assert.match(app, /synchronizeCharacterHomeSchedule/);
assert.doesNotMatch(app, /reserveCharacterLocationStay/, "companion travel must rewrite schedules instead of writing a manual location override");
assert.match(app, /id\("companion-follow"\)/, "companion travel must insert a protected companion-follow schedule slot");
assert.match(app, /const inserted = insertManualLifeScheduleSlot\(insertBase, companionSlot\)/, "companion travel must go through the shared manual schedule insertion rule");
assert.match(app, /title: "与我同行：" \+ destination\.name/, "companion schedule title must name the destination");
assert.match(app, /activeSlot\?\.kind === "appointment" \|\| activeSlot\?\.source === "event"/, "characters with appointments or fixed events must not be moved by a companion trip");
assert.match(app, /有约会，未同行/, "skipped companions must be reported to the player");
assert.match(app, /locationSource: "schedule",\s*manualSetAt: undefined,\s*manualPinned: undefined/, "companion travel must merge a schedule-sourced actual location without leaving manual markers");
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

const [chatEngine, toolStorage, lifeTools, lifeRuntime, lifeMemoryBridge, guidedSchedule] = await Promise.all([
  read("../lib/chat-engine.ts"),
  read("../lib/tool-storage.ts"),
  read("../lib/life/life-tools.ts"),
  read("../lib/life/life-runtime.ts"),
  read("../lib/life/life-memory-bridge.ts"),
  read("../lib/life/life-guided-schedule.ts"),
]);
assert.match(chatEngine, /if \(tool\.source === "life"\) return true;/);
for (const name of ["life_view_schedule", "life_create_schedule", "life_change_schedule", "life_cancel_schedule", "life_move_location"]) {
  assert.ok(lifeTools.includes('name: "' + name + '"'), name + " must be registered");
}
assert.match(lifeTools, /reserveCharacterLocationStay\(state, \{/, "move-location tool must reuse the schedule-preserving stay helper");
assert.match(toolStorage, /isScheduleRead = tool\.name === "life_view_schedule"/);
assert.match(toolStorage, /isScheduleWrite = tool\.name === "life_create_schedule"/);
assert.match(toolStorage, /if \(lifeSettings\.enabled\) \{/, "schedule read tools remain registered when character autonomy is disabled");
assert.match(toolStorage, /isScheduleRead \|\| lifeSettings\.enableCharacterAutonomy/);
assert.match(lifeTools, /name !== "life_view_schedule" && !state\.settings\.enableCharacterAutonomy/);
assert.match(lifeTools, /Math\.random\(\)\.toString\(36\)\.slice\(2, 9\)/, "cancelled-slot tombstone IDs need a collision-resistant suffix");
assert.match(lifeMemoryBridge, /new Date\(item\.endAt\)\.getTime\(\) > now\.getTime\(\)/, "today context must retain already-started but not-yet-ended slots");
assert.match(lifeTools, /slot\.source === "character-tool"/);
assert.match(lifeTools, /slot\.ownerId === characterId/);
assert.match(lifeRuntime, /horizonEnd = new Date\(characterNow\.getTime\(\) \+ 7 \* 24 \* 60 \* 60_000\)/);
assert.match(lifeRuntime, /protectedManualActivity/);
assert.match(lifeRuntime, /slot\.source === "event"/);
assert.match(lifeRuntime, /candidate\.source !== "weekly-generation" \|\| existing\.source !== "character-tool"/);
assert.match(lifeRuntime, /isAlreadyInProgress/);
assert.match(guidedSchedule, /isAlreadyInProgress/);
assert.match(app, /existingStart <= Date\.now\(\) && existingEnd > Date\.now\(\)/);
assert.match(lifeMemoryBridge, /remainingToday/);
assert.match(lifeMemoryBridge, /item\.id !== schedule\?\.id/);
assert.match(guidedSchedule, /existing\.source === "manual"/,
  "guided re-planning must reject user-authored schedule mutations");
assert.match(guidedSchedule, /slot\.kind === "free-time" && !isAlreadyInProgress/,
  "only generated free-time may be treated as an open slot");
assert.match(app, /existing\.source === "manual"/,
  "the atomic guided-plan commit must revalidate manual schedule protection");
assert.match(app, /kind: "free-time", source: "character-tool"/,
  "guided cancellations must leave a protected free-time placeholder");
assert.match(lifeTools, /kind: "free-time" as const, source: "character-tool" as const/,
  "tool cancellations must leave a protected free-time placeholder");
assert.match(app, /daysUntilWeekEnd <= 2/);
assert.match(app, /nextWeek\.setDate\(nextWeek\.getDate\(\) \+ 7\)/);


const [checkinConfig, checkinScheduler] = await Promise.all([
  read("../lib/screenshot/checkin-config.ts"),
  read("../components/screenshot/checkin-scheduler.tsx"),
]);
assert.match(checkinConfig, /triggerMode: "background"/, "new and legacy check-in settings default to background-only");
assert.match(checkinConfig, /nextDueBackgroundMs/, "background interval must use persisted cumulative background time");
assert.match(checkinConfig, /ensureCheckInDueTime/, "random due time must be sampled once and persisted");
assert.match(checkinEngine, /readCheckInAppState\(\)/, "scheduled check-in must use native lifecycle state");
assert.match(checkinEngine, /getActiveChatSessionId\(\)/, "scheduled check-in must avoid interrupting the active private chat");
assert.match(checkinEngine, /config\.triggerMode === "background"/);
assert.doesNotMatch(checkinEngine, /if \(!life\.settings\.enableCharacterAutonomy\) return false/,
  "independent check-in must not be disabled by the general life autonomy switch");
assert.doesNotMatch(followUpService, /pollCheckIn\(now\)/,
  "follow-up polling must not compete with the dedicated check-in scheduler");
assert.match(checkinScheduler, /check-in-config-changed/, "enabling or changing a mode must initialize the schedule immediately");
assert.match(nativeBridge, /fun getCheckInAppState\(\): String/);
assert.match(nativeBridge, /CheckInService\.onHostBackground\(this\)/);
assert.match(nativeBridge, /CheckInService\.onHostForeground\(this\)/);

const [
  backgroundManager,
  backgroundAlarmReceiver,
  backgroundManifest,
  backgroundBootReceiver,
  backgroundSettings,
  phoneSettings,
  backupScheduler,
  widgetScheduler,
  mediaScheduler,
] = await Promise.all([
  read("../android-shell/app/src/main/java/app/floatphone/shell/BackgroundEnhancementManager.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/BackgroundTaskAlarmReceiver.kt"),
  read("../android-shell/app/src/main/AndroidManifest.xml"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/BootReceiver.kt"),
  read("../components/settings/background-enhancement-settings.tsx"),
  read("../components/phone-settings-app.tsx"),
  read("../components/cloud-backup-scheduler.tsx"),
  read("../components/widget/widget-scheduler.tsx"),
  read("../components/media-maintenance-scheduler.tsx"),
]);

assert.match(backgroundManager, /setAndAllowWhileIdle/, "native scheduler must use inexact allow-while-idle alarms");
assert.match(backgroundManager, /mode\(context\) != MODE_ENHANCED/, "native alarms must be gated by the user's enhanced-mode opt-in");
assert.doesNotMatch(backgroundManager, /ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS/, "do not trigger policy-sensitive battery exemption requests");
assert.doesNotMatch(backgroundManager, /setExactAndAllowWhileIdle|setExact\(/, "background reminders must not require exact-alarm access");
assert.match(backgroundManager, /remainingMs/, "background-only timers must pause while the app is foreground");
assert.match(backgroundManager, /batteryOptimizationIgnored/, "background diagnostics must report battery optimization state");
assert.match(backgroundManager, /put\("exactAlarmUsed", false\)/, "diagnostics must disclose that exact alarms are not used");
assert.match(backgroundAlarmReceiver, /BackgroundEnhancementManager\.onAlarm/);
assert.doesNotMatch(backgroundAlarmReceiver, /ScreenshotBridge|captureScreenshot|startForegroundService/, "alarm receiver must not secretly capture or launch an FGS");
assert.match(backgroundManifest, /BackgroundTaskAlarmReceiver/);
assert.match(backgroundBootReceiver, /BackgroundEnhancementManager\.restore/);
assert.match(nativeBridge, /fun getBackgroundEnhancementDiagnostics\(\): String/);
assert.match(nativeBridge, /fun scheduleBackgroundCheckIn\(/);
assert.match(nativeBridge, /BackgroundEnhancementManager\.onHostBackground\(this\)/);
assert.match(nativeBridge, /BackgroundEnhancementManager\.onHostForeground\(this\)/);
assert.match(checkinEngine, /scheduleNativeCheckIn\(/);
assert.match(checkinEngine, /cancelNativeCheckIn\(/);
assert.match(backgroundSettings, /不会静默截屏/);
assert.match(phoneSettings, /BackgroundEnhancementSettings/);
assert.match(backupScheduler, /pageshow/);
assert.match(widgetScheduler, /pageshow/);
assert.match(mediaScheduler, /pageshow/);

const [kvDbSource, lifeStorageSource, lifeTypesSource] = await Promise.all([
  read("../lib/kv-db.ts"),
  read("../lib/life/life-storage.ts"),
  read("../lib/life/life-types.ts"),
]);
assert.match(kvDbSource, /const _writeQueues = new Map<string, Promise<void>>\(\)/,
  "IndexedDB writes must be serialized per key so an older snapshot cannot finish after a newer one");
assert.match(kvDbSource, /previous\.catch\(\(\) => undefined\)\.then\(async \(\) => \{[\s\S]*?await kvDb\.entries\.put\(\{ key, value \}\)/,
  "each durable key write must wait for the previous write to settle");
assert.match(kvDbSource, /if \(_cache\.get\(key\) === value\) writeFallbackLocalStorage\(key, value\)/,
  "a failed stale write must not overwrite the latest localStorage fallback");
assert.match(kvDbSource, /enqueueKvWrite\(key, value\)/,
  "both sync and async KV setters must use the ordered write queue");
assert.match(lifeStorageSource, /sceneMessageFormatVersion: typeof raw\.sceneMessageFormatVersion === "number" \? raw\.sceneMessageFormatVersion : 0/,
  "legacy scene message migration version must survive state normalization");
assert.match(lifeTypesSource, /sceneMessageFormatVersion\?: number/);
assert.match(app, /if \(\(normalized\.sceneMessageFormatVersion \?\? 0\) < 1\)/,
  "legacy scene action/dialogue parsing must run once, not on every app entry");
assert.match(app, /sceneMessageFormatVersion: 1/);
assert.match(app, /message\.action\?\.trim\(\)/,
  "already structured action/dialogue messages must not be parsed again");
assert.match(app, /pendingSceneTurnsRef\.current\.push/,
  "player turns sent during generation must be queued for sequential replies");
assert.match(app, /pendingSceneTurnsRef\.current = pendingSceneTurnsRef\.current\.filter\(turn => turn\.messageId !== pendingTurn\.messageId\)/,
  "queued player turns must be drained after the current root response");
assert.match(app, /已保存，暂无可回应角色/,
  "player input must remain persisted even when no responder exists");
assert.match(app, /const sceneContext = buildLifeScenePromptContext\(stateRef\.current, turnScene, target\.id, pendingTurn\?\.messageId\)/,
  "queued replies must use their original scene context");
const composerSource = app.slice(app.indexOf('<form onSubmit={sendSceneTurn}'), app.indexOf('</form>', app.indexOf('<form onSubmit={sendSceneTurn}')));
assert.doesNotMatch(composerSource, /<textarea[^>]*disabled=\{busy\}/,
  "scene composer must remain available while a reply is generating");

assert.match(lifeTypesSource, /imageId\?: string/,
  "scene image chat cards must reference gallery media by ID rather than duplicate image bytes");
assert.match(app, /legacySceneImageMessages/,
  "pre-existing gallery images must be backfilled into the scene chat timeline");
assert.match(app, /sceneMessages: \[\.\.\.latest\.sceneMessages, \.\.\.imageMessages\]/,
  "newly generated scene images must append chat cards in the same state commit");
assert.match(app, /message\.imageId \? <div/,
  "scene chat must render image references as image cards");
assert.match(app, /setImageViewerOpen\(true\)/,
  "tapping a chat or gallery image must open the viewer");
assert.match(app, /ArrowLeft/);
assert.match(app, /ArrowRight/);
assert.match(app, /const downloadSceneImage = async/);
assert.match(app, /await downloadFile\(blob,/,
  "scene image download must use the shared native-aware file saver in Android WebView");
assert.match(app, /const blob = await response\.blob\(\)/,
  "original download must use the stored media blob without recompressing it");
assert.match(app, /sceneMessages: stateRef\.current\.sceneMessages\.filter\(message => message\.imageId !== imageId\)/,
  "deleting a gallery image must remove its chat reference without leaving a broken card");

const [realityNative, realityCallControl, realityRoute, realityPushWorker, realityUi, realityPushService, realityActivity, diagnostics, realityEngine, realityScheduler] = await Promise.all([
  read("../android-shell/app/src/main/java/app/floatphone/shell/NativeRealityBridge.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/CallControlService.kt"),
  read("../app/api/push/bridge-native-event/route.ts"),
  read("../supabase/functions/push-bridge/index.ts"),
  read("../components/reality-bridge-app.tsx"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/PushService.kt"),
  read("../android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt"),
  read("../components/settings/runtime-diagnostics.tsx"),
  read("../lib/reality-bridge/engine.ts"),
  read("../components/reality-bridge-scheduler.tsx"),
]);
assert.match(realityNative, /fun postOfflineNotificationFallback\([\s\S]*?enqueueChatMessage\([\s\S]*?postNotification\(/, "offline fallback must persist a chat message and show its native alert");
assert.match(realityNative, /fun pendingChatMessages/, "native bridge must expose its durable chat queue");
assert.match(realityNative, /fun acknowledgeChatMessages/, "native bridge must acknowledge only imported chat messages");
assert.match(realityCallControl, /NativeRealityBridge\.postOfflineNotificationFallback/, "background events must use the local offline rule path");
assert.match(realityCallControl, /native-reality-bridge-local/, "native event processing must run off the accessibility callback");
assert.match(realityCallControl, /api\/push\/bridge-native-event/, "Android native events must asynchronously enter the cloud bridge endpoint");
assert.match(realityCallControl, /hasPostedBridgeReceipt/, "native delivery must stop waiting when the cloud notification is posted");
assert.match(realityCallControl, /repeat\(6\)/, "native cloud wait must be bounded before local fallback");
assert.match(realityCallControl, /postBridgeReceipt\(id, "fallback"\)/, "local fallback must publish a receipt to suppress a late cloud duplicate");
assert.match(realityActivity, /getPendingNativeRealityBridgeMessages/, "WebView must be able to retrieve pending local bridge messages");
assert.match(realityActivity, /acknowledgeNativeRealityBridgeMessages/, "WebView must acknowledge messages after chat persistence");
assert.match(realityUi, /characterId: rule\.actions\.chat\?\.characterId/, "native rules must retain the target character identity");
assert.match(realityEngine, /export function normalizeBridgeSignal/, "reality bridge must normalize raw signal payloads before they reach chat");
assert.match(realityEngine, /export function fillBridgeSignalTemplate/, "bridge reply templates must share one placeholder implementation");
assert.match(realityEngine, /promptHasSignal \? prompt \+ contextBlock/, "AI processing must not append a duplicate payload after a placeholder");
assert.match(realityEngine, /return normalizeBridgeSignal\(item\)/, "raw bridge rules must use normalized human-readable text");
assert.match(realityNative, /private fun normalizeSignal/, "Android offline fallback must normalize signals before queuing chat");
assert.match(realityNative, /private fun fillSignalTemplate/, "Android offline replies must use {signal}/{payload} consistently");
assert.match(realityNative, /CHANNEL = "shell_messages"/, "native offline alerts must share the normal Android message notification channel");
assert.match(realityNative, /RemoteInput\.Builder\(NotificationReplyReceiver\.KEY_REPLY_TEXT\)/, "native offline alerts must expose the same inline RemoteInput reply action");
assert.match(realityNative, /putExtra\(NotificationReplyReceiver\.EXTRA_SESSION_ID, sid\)/, "native offline reply actions must target the canonical chat session");
assert.match(realityUi, /sessionId: \(\(\) => \{[\s\S]*?chatSessions\.find\(session => session\.characterId === characterId/, "native rule sync must include an existing canonical chat session when available");
assert.match(realityPushWorker, /const isRuleTask = job\.trigger_key\.startsWith\("bridge:rule:"\)/, "push-bridge must distinguish one-rule worker jobs from inbox scans");
assert.match(realityPushWorker, /encryptJobPayload\(JSON\.stringify\(\{ item, ruleId: rule\.id \}\), payloadKey\)/, "each matched event-rule pair must be persisted as an encrypted independent task");
assert.match(realityPushWorker, /const taskMatched = matched\.filter\(rule => rule\.id === taskRuleId\)/, "each child worker must execute only its claimed rule");
assert.match(realityPushWorker, /sharded \$\{taskRows\.length\} item-rule tasks/, "root scans must enqueue child jobs instead of running multiple AI rules inline");
const bridgeSchema = await read("../docs/personal-push-supabase.sql");
assert.match(bridgeSchema, /ai_phone_bridge_increment_daily_count/, "parallel bridge workers must update daily statistics atomically");
assert.match(bridgeSchema, /ai_phone_bridge_reserve_rule_runs/, "concurrent bridge scans must merge per-rule cooldown reservations without replacing other rules");

assert.match(realityEngine, /export async function syncNativeOfflineBridgeMessages/, "native offline replies must be imported into chat");
assert.match(realityEngine, /upsertImportedChatMessage\([\s\S]*?channel: "reality_bridge"/, "native bridge messages must use the canonical chat storage");
assert.match(realityEngine, /dispatchChatMessageNotice\(/, "native bridge messages must reuse the existing chat banner");
assert.match(realityScheduler, /syncNativeOfflineBridgeMessages\(\)/, "native chat queue must be drained when the WebView scheduler resumes");
assert.match(realityPushWorker, /bridgeEventId\?: string/, "bridge push payloads must carry a stable event ID for display receipts");
assert.match(realityPushWorker, /bridge-notify-\$\{item\.id\}.*item\.id/, "generic bridge pushes must carry the event ID");
assert.match(realityPushWorker, /bridge-\$\{item\.id\}-\$\{rule\.id\}-\$\{index\}[\s\S]*?item\.id/, "role reply pushes must carry the event ID");
assert.match(realityPushWorker, /await sendPush\(\s*rule\.chat\.characterName[\s\S]*?item\.id,\s*\{[\s\S]*?sessionId: rule\.chat\.sessionId[\s\S]*?kind: "chat"/, "role replies remain on the cloud processing and push path with canonical chat metadata and event receipts");
assert.match(realityPushWorker, /await sendPush\(`现实桥 · \$\{item\.type\}`[\s\S]*?item\.id\)/, "generic notifications remain on the cloud processing path");
assert.match(realityUi, /请以这个角色本人的口吻，生成 15 条可直接作为 Android 系统通知正文的离线回复/, "offline reply generation must prepare character-voiced native notification text");
assert.match(realityUi, /offlineReplies: \(rule\.offlineReplies === undefined \? defaultOfflineReplies\(rule\.matchType\) : rule\.offlineReplies\)/, "legacy rules receive defaults but intentionally emptied reply libraries stay empty");

const bridgeSync = await read("../lib/push-bridge-sync.ts");
assert.match(bridgeSync, /offlineReplies:/, "offline reply libraries must be synchronized to the personal cloud");
assert.match(bridgeSync, /avatar: character\.avatar/, "bridge notification snapshots must carry the character avatar");
assert.match(bridgeSync, /createOrGetSession\(contact\?\.id \|\| characterId\)/, "bridge notification session IDs must use the canonical chat contact ID");
assert.match(realityPushWorker, /sessionId: rule\.chat\.sessionId/, "cloud bridge notifications must carry the correct chat session");
assert.match(realityPushWorker, /bodyText\.slice\(0, 200\)/, "cloud bridge previews must use the same 200-character limit as normal push");
assert.match(realityPushWorker, /hasLocalFallbackReceipt/, "cloud worker must suppress late duplicates after native local fallback");

const receiptRoute = await read("../app/api/push/bridge-native-event/receipt/route.ts");
assert.match(receiptRoute, /status: body\.status/, "receipt endpoint must persist displayed and fallback states");
assert.match(receiptRoute, /receipt\.status === "displayed"/, "native polling must receive actual display acknowledgement");
assert.match(realityPushWorker, /endpoint=like\.shell:\*/, "reality bridge worker must discover shell subscriptions independently of personal-cloud owner IDs");
assert.match(realityPushWorker, /shellpush:\$\{ownerId\}/, "reality bridge worker must broadcast to the site account ID embedded in shell subscriptions");
assert.match(realityPushWorker, /realtime\/v1\/api\/broadcast/, "reality bridge worker must use Supabase Realtime for Android Shell");
assert.match(realityPushWorker, /webSubs = accountSubs\.filter\(sub => !sub\.endpoint\.startsWith\("shell:"\)\)/, "browser subscriptions must remain on the Web Push path");
assert.match(realityPushWorker, /sendWebPushRaw\(sub, message, vapid, 3600\)/, "browser Web Push delivery must remain intact");
assert.match(realityPushWorker, /name\.startsWith\("native_"\)[\s\S]*?replace\(/, "native event filenames must normalize back to the original event ID");
assert.match(realityPushService, /bridgeEventId/);
assert.match(realityPushService, /sendBridgeReceipt\(bridgeEventId\)/, "Android Shell must acknowledge native notifications after posting");
assert.match(realityPushService, /put\("status", "posted"\)/, "native acknowledgement must describe system posting rather than human visibility");
assert.match(realityPushService, /NotificationManagerCompat\.from\(this\)\.areNotificationsEnabled\(\)/, "Android must not acknowledge a globally disabled notification channel");
assert.match(realityActivity, /fun getNativePerceptionDiagnostics\(\): String/, "native queue state must be available to the diagnostics page");
assert.match(diagnostics, /getNativePerceptionDiagnostics/, "runtime diagnostics must display native upload queue state");
assert.match(diagnostics, /api\/push\/selfcheck\?probe=0/, "automatic diagnostics must not send a test notification");
assert.match(diagnostics, /api\/push\/selfcheck\?probe=1/, "test notification must require an explicit user action");
assert.match(realityPushWorker, /bridgeEventId/, "push worker must attach event identity to notification payload");
assert.match(realityUi, /请以这个角色本人的口吻，生成 15 条可直接作为 Android 系统通知正文的离线回复/, "offline reply generation must prepare character-voiced native notification text");
assert.match(realityUi, /offlineReplies: \(rule\.offlineReplies === undefined \? defaultOfflineReplies\(rule\.matchType\) : rule\.offlineReplies\)/, "legacy rules receive defaults but intentionally emptied reply libraries stay empty");

console.log("Life-system and background-enhancement wiring checks passed.");
