-- AI Phone Cloudflare Worker D1 Schema
-- 消息存储表

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  session_id TEXT,
  character_name TEXT,
  created_at TEXT NOT NULL,
  delivered INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

-- 定时消息表
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'owner',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  url TEXT,
  scheduled_for TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scheduled_pending ON scheduled_messages(sent, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_scheduled_user ON scheduled_messages(user_id);

-- 元数据表（版本控制）
CREATE TABLE IF NOT EXISTS ai_phone_meta (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO ai_phone_meta (id, schema_version, created_at, updated_at)
VALUES ('cloudflare-worker', 1, datetime('now'), datetime('now'));
