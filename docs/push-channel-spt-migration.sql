-- WxPusher / 极简推送 SPT（Simple Push Token）。
-- 每个用户一个 SPT，连接时写入，断开时清空。
-- Edge Functions 和 Next.js 路由都会在发 Web Push 前先查这里，尽力走一条额外通道。
-- 重复执行安全（新库没有 push_channel_spt 表会直接创建，老库用 if not exists 幂等补齐）。
create table if not exists public.push_channel_spt (
  user_id text primary key,
  channel text not null default 'wxpusher',
  spt text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint push_channel_spt_channel_check check (channel in ('wxpusher'))
);

alter table public.push_channel_spt enable row level security;

-- 仅 service_role 可访问：Next 路由和 Edge Functions 都用它读写。
grant select, insert, update, delete on table public.push_channel_spt to service_role;
