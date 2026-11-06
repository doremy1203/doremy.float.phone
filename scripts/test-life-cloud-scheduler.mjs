import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = path => readFile(new URL(path, import.meta.url), "utf8");
const [scheduler, snapshot, client, generator, deployRoute, deployClient, schema, build, diagnosticsRoute, diagnosticsPanel, gateway] = await Promise.all([
  read("../supabase/functions/life-scheduler/index.ts"),
  read("../lib/life/life-schedule-cloud.ts"),
  read("../lib/life/life-proactive-scheduler.ts"),
  read("../supabase/functions/push-generate/index.ts"),
  read("../app/api/push/deploy-personal/route.ts"),
  read("../lib/personal-push-cloud.ts"),
  read("../docs/personal-push-supabase.sql"),
  read("../scripts/build-personal-push-dist.mjs"),
  read("../app/api/life/schedule-diagnostics/route.ts"),
  read("../components/life/life-diagnostics-panel.tsx"),
  read("../supabase/functions/ai-phone-push/index.ts"),
]);

assert.match(scheduler, /Deno\.serve/);
assert.match(scheduler, /life_schedule_runtime/);
assert.match(scheduler, /life_schedule_diagnostics/);
assert.match(scheduler, /life_schedule_diagnostic_events/);
assert.match(scheduler, /life_job_armed/);
assert.match(scheduler, /push_jobs\?user_id=.*trigger_key=eq/);
assert.match(scheduler, /status: "pending", execute_at/);
assert.doesNotMatch(scheduler, /push_jobs",\s*\{\s*method:\s*"POST"/);
assert.match(scheduler, /weekly-generation/);
assert.match(scheduler, /projectedWeeklySlots/);
assert.match(scheduler, /nextOverlap/);
assert.match(scheduler, /expiredOverride/);
assert.match(scheduler, /actualLocationUntil/);
assert.match(scheduler, /changed \|\| chatLeaseJustEnded \? null/);
assert.match(scheduler, /const lifeEnabled = snapshot\.enabled !== false && snapshot\.autonomyEnabled !== false/);
assert.match(scheduler, /const proactiveEnabled = snapshot\.proactiveEnabled !== false/);
assert.doesNotMatch(scheduler, /const nextRun = !enabled \|\| !hasSubscription/);
assert.doesNotMatch(scheduler, /if \(!hasSubscription \|\| !samePlace/);
assert.match(scheduler, /direct chat ended; resumed deferred task/);
assert.match(scheduler, /notification_unavailable/);
assert.match(scheduler, /next_run_at = iso\(executeAt\)/);
assert.match(scheduler, /onlineChatCharacterId/);
assert.match(scheduler, /life_push_subscription_missing/);
assert.match(scheduler, /life_generation_failed/);
assert.match(scheduler, /life_notification_delivery_failed/);
assert.match(scheduler, /life_generation_daily_cap/);
assert.match(scheduler, /life_job_dispatch_stalled/);
assert.match(scheduler, /life_job_execution_stalled/);
assert.match(scheduler, /cancelledAt/);
assert.match(scheduler, /status=in\.\(done,failed,cancelled\)/);
assert.match(scheduler, /sendWebPushRaw/);
assert.match(scheduler, /push_subscriptions\?user_id=eq\.\$\{encodeURIComponent\(userId\)\}/);
assert.match(scheduler, /push_subscriptions\?user_id=eq\.\$\{encodeURIComponent\(row\.user_id\)\}/);
assert.doesNotMatch(scheduler, /rest\("push_subscriptions\?user_id=eq\.\$\{/);
assert.match(generator, /push_subscriptions\?user_id=eq\.\$\{encodeURIComponent\(job\.user_id\)\}/);
assert.doesNotMatch(generator, /rest\("push_subscriptions\?user_id=eq\.\$\{/);
assert.match(scheduler, /生活系统 · 云端诊断/);
assert.match(scheduler, /schedule_version/);
assert.match(scheduler, /player_activity/);

assert.match(snapshot, /const scheduleSlots = state\.schedules/);
assert.match(snapshot, /actualLocationUntil/);
assert.match(snapshot, /autonomyEnabled/);
assert.match(snapshot, /proactiveIntervalMax/);
assert.match(snapshot, /version: 5/);
assert.doesNotMatch(snapshot, /if \(!state\.settings\.enabled\) return false/);

assert.match(client, /cloudManaged: true/);
assert.match(client, /armLifeSceneProactiveBailout/);
assert.match(client, /activeScenePairs/);
assert.match(client, /participant\.activity !== "离开"/);
assert.doesNotMatch(client, /remaining: 72/);
assert.doesNotMatch(client, /repeatUntil/);
assert.doesNotMatch(client, /repeat: \{ intervalMs/);
assert.match(client, /syncLifeScheduleSnapshot\(true\)/);

assert.match(generator, /currentLocationName/);
assert.match(generator, /weekly-generation/);
assert.match(generator, /当前生活状态/);
assert.match(generator, /lifeSceneMeta/);
assert.match(generator, /runtimeResponse/);
assert.match(generator, /cloud schedule state is stale/);
assert.match(generator, /life_schedule_snapshot_stale/);
assert.match(generator, /life_schedule_runtime_unavailable/);
assert.match(generator, /authoritative runtime unavailable/);
assert.match(generator, /runtimeReady/);
assert.match(generator, /life_schedule_runtime_changed_during_generation/);
assert.match(generator, /life_outbox_write_failed/);
assert.match(generator, /life_notification_delivery_failed/);
assert.match(generator, /life_schedule_diagnostic_events/);
assert.match(generator, /life_outbox_committed/);
assert.match(generator, /life_delivery_completed/);
assert.match(generator, /life_job_final_done/);
assert.match(generator, /life-scheduler:\$\{job\.user_id\}:\$\{code\}/);
assert.match(diagnosticsPanel, /setInterval\(poll, 60_000\)/);
assert.match(generator, /latestRuntimeAt/);
assert.match(generator, /Number\(latestRuntime\.state_version\) !== lifeRuntimeStateVersionAtStart/);
assert.match(generator, /sendWebPushRaw/);
assert.match(generator, /!payload\.merge\?\.lifeScene && idleRepeat/);
assert.match(generator, /autonomous life actions disabled by latest cloud settings/);
assert.match(generator, /if \(!rows.length\) return isLifeSceneJob/);
assert.match(generator, /Revalidate after the provider call/);
assert.match(generator, /direct chat opened during generation/);
assert.match(generator, /actor activity.*location changed during generation/);

assert.match(schema, /values\s*\('personal-cloud', 5, now\(\)\)/);
assert.match(schema, /create table if not exists public\.life_schedule_runtime/);
assert.match(schema, /create table if not exists public\.life_schedule_diagnostics/);
assert.match(schema, /create table if not exists public\.life_schedule_diagnostic_events/);
assert.match(schema, /trace_id text not null default/);
assert.match(schema, /ai-phone-life-schedule-evaluate/);
assert.match(schema, /functions\/v1\/life-scheduler/);
assert.match(schema, /alter table public\.life_schedule_runtime enable row level security/);
assert.match(schema, /public\.life_schedule_diagnostics/);
assert.match(schema, /delete from public\.push_jobs\s+where trigger_key like 'life-scene:%:schedule\+%'/);
assert.match(schema, /cron\.unschedule\(jobid\)/);

assert.match(build, /life-scheduler\.mjs/);
assert.match(deployRoute, /LIFE_SCHEDULER_SLUG/);
assert.match(deployRoute, /lifeSchedulerCode/);
assert.match(deployRoute, /部署云端生活日程引擎失败/);
assert.match(deployClient, /life-scheduler\.mjs/);
assert.match(deployClient, /PERSONAL_PUSH_SCHEMA_VERSION = 4/);
assert.match(snapshot, /life-schedule-snapshot/);
assert.match(snapshot, /personalCloudReady/);
assert.match(snapshot, /schemaVersion \?\? 0\) >= 4/);
assert.match(diagnosticsPanel, /life-schedule-diagnostics/);
assert.match(diagnosticsPanel, /personalPushFetch/);
assert.match(gateway, /action === "life-schedule-snapshot"/);
assert.match(gateway, /action === "life-schedule-diagnostics"/);
assert.match(gateway, /life-execution-trace/);
assert.match(gateway, /user_id=eq.\$\{OWNER_ID\}/);
assert.match(diagnosticsRoute, /life_schedule_diagnostics/);
assert.match(diagnosticsRoute, /life_schedule_diagnostic_events/);
assert.match(diagnosticsPanel, /Trace:/);
assert.match(diagnosticsPanel, /api\/life\/schedule-diagnostics/);
assert.match(diagnosticsPanel, /云端生活引擎/);

console.log("Cloud life scheduler regression checks passed.");
