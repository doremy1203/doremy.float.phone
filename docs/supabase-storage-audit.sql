-- 小手机 Supabase 存储审计（只读版）
-- 在 Supabase Dashboard → SQL Editor 中逐段执行。
-- 本文件不执行 DELETE / TRUNCATE / VACUUM，不修改任何数据。
-- 目标：先定位 Database Size、Storage、推送队列和 cron 日志分别占用多少，再决定清理策略。
--
-- 重要：
-- 1. 每个 SELECT 是独立查询，某个可选表/扩展不存在时，该段可能报错；跳过即可。
-- 2. cron.job_run_details 的历史清理应先看实际体积；不要仅凭旧环境的历史数字就直接清空。
-- 3. Storage 文件删除与数据库行删除是两件事；不要直接删除仍被业务引用的对象。
-- 4. Supabase 平台 Logs Explorer 的日志保留/摄取量通常不由 public 表决定，需要在 Usage/Logs 面板单独检查。

-- ─────────────────────────────────────────────────────────────
-- A. 数据库总体大小
-- ─────────────────────────────────────────────────────────────
select
  current_database() as database_name,
  pg_size_pretty(pg_database_size(current_database())) as database_size_bytes;

-- ─────────────────────────────────────────────────────────────
-- B. 所有 schema 的表占用（含索引），定位 public 以外的空间
-- ─────────────────────────────────────────────────────────────
select
  n.nspname as schema_name,
  c.relname as table_name,
  pg_size_pretty(pg_total_relation_size(c.oid)) as total_size,
  pg_size_pretty(pg_relation_size(c.oid)) as table_data_size,
  pg_size_pretty(pg_indexes_size(c.oid)) as indexes_size,
  coalesce(s.n_live_tup, 0) as estimated_live_rows,
  coalesce(s.n_dead_tup, 0) as estimated_dead_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_stat_user_tables s on s.relid = c.oid
where c.relkind in ('r', 'm')
  and n.nspname not in ('pg_catalog', 'information_schema')
order by pg_total_relation_size(c.oid) desc
limit 50;

-- ─────────────────────────────────────────────────────────────
-- C. Schema 总量（含索引）
-- ─────────────────────────────────────────────────────────────
select
  n.nspname as schema_name,
  pg_size_pretty(sum(pg_total_relation_size(c.oid))) as total_size
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'm')
  and n.nspname not in ('pg_catalog', 'information_schema')
group by n.nspname
order by sum(pg_total_relation_size(c.oid)) desc;

-- ─────────────────────────────────────────────────────────────
-- D. 推送队列状态和历史数量（表不存在时跳过本段）
-- 先看分布和年龄，不删除任何任务。
-- ─────────────────────────────────────────────────────────────
select 'push_jobs' as table_name, status, count(*) as rows,
       min(created_at) as oldest_created_at, max(created_at) as newest_created_at
from public.push_jobs
group by status
order by rows desc;

select
  count(*) as total_rows,
  count(*) filter (where consumed_at is not null) as consumed_rows,
  count(*) filter (where consumed_at is null) as pending_rows,
  min(created_at) as oldest_created_at,
  max(created_at) as newest_created_at
from public.push_outbox;

select status, count(*) as rows,
       min(created_at) as oldest_created_at, max(created_at) as newest_created_at
from public.push_shortcut_commands
group by status
order by rows desc;

-- ─────────────────────────────────────────────────────────────
-- E. pg_cron 执行日志（仅在 pg_cron 已安装且有权限时执行）
-- 10 秒频率的任务每天可产生 8,640 条执行记录；先看体积与保留期。
-- ─────────────────────────────────────────────────────────────
select
  pg_size_pretty(pg_total_relation_size('cron.job_run_details'::regclass)) as cron_history_size,
  count(*) as history_rows,
  min(start_time) as oldest_run,
  max(start_time) as newest_run
from cron.job_run_details;

select jobid, schedule, command, active
from cron.job
order by jobid;

-- ─────────────────────────────────────────────────────────────
-- F. Supabase Storage 对象体积估算（metadata.size 不存在/不可转换时跳过）
-- 这是对象元数据的估算，不等同于账单最终计量。
-- ─────────────────────────────────────────────────────────────
select
  bucket_id,
  count(*) as object_count,
  pg_size_pretty(sum(nullif(metadata->>'size', '')::bigint)) as estimated_object_bytes,
  min(created_at) as oldest_object,
  max(created_at) as newest_object
from storage.objects
group by bucket_id
order by sum(nullif(metadata->>'size', '')::bigint) desc nulls last;

-- ─────────────────────────────────────────────────────────────
-- G. 当前业务表是否可能把大媒体内容直接塞进 JSON/text
-- PostgreSQL 无法在不知道各表列结构的情况下安全、通用地推断 Base64；
-- 先列出大文本/JSON 列，随后针对结果选表抽样检查，避免全库扫描拖慢生产库。
-- ─────────────────────────────────────────────────────────────
select
  table_schema,
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema in ('public', 'storage')
  and data_type in ('text', 'character varying', 'json', 'jsonb')
order by table_schema, table_name, ordinal_position;

-- ─────────────────────────────────────────────────────────────
-- 下一步决策指引（在看完结果后再操作）：
-- • cron.job_run_details 最大：先确认需要保留多久，再清理历史并设置定期保留策略。
-- • public 表最大：检查具体表的行数、JSON/text 大字段、索引和过期数据。
-- • storage schema / 对象桶最大：按 bucket 检查引用关系和对象生命周期，禁止盲删。
-- • push_jobs / push_outbox 很大：只清理终态且超过保留期的记录，保留 pending/running/未消费行。
-- • Database Size 与各表总量差距明显：检查其他 schema、死元组、TOAST、平台统计口径。
-- • Logs/egress 超额：在 Supabase Usage/Logs 面板排查，不要把它误判成数据库表空间问题。
