-- ⚠️ 旧版站点共享推送迁移，不适用于新建个人推送云。
-- 新版个人云请通过应用内「云服务部署」更新 Schema 与 Edge Functions。
-- 仅当目标项目确实使用 docs/push-supabase.sql 的旧表结构时，才评估是否执行本迁移。

-- Reality Bridge shortcut continuation after the PWA is suspended or killed.
-- Safe to run after docs/push-supabase.sql; no URL replacement is required.

begin;

alter table public.push_jobs drop constraint if exists push_jobs_kind_check;
alter table public.push_jobs add constraint push_jobs_kind_check
  check (kind in ('followup', 'reply_bailout', 'timed_task', 'bridge_scan', 'shortcut_resume'));

commit;

-- After running this migration, redeploy the push-generate Edge Function from:
-- supabase/functions/push-generate/index.ts
-- Also deploy push-shortcut-result and disable JWT verification:
-- supabase/functions/push-shortcut-result/index.ts
