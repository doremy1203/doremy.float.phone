// AI Phone Cloudflare Worker - 离线推送与主动消息
// 部署到用户自己的 Cloudflare 账户，替代 Supabase Edge Functions

interface Env {
  DB: D1Database;
  WXPUSHER_SPT?: string;
  SITE_ORIGIN?: string;
}

interface PushMessage {
  id?: string;
  user_id: string;
  title: string;
  content: string;
  url?: string;
  session_id?: string;
  character_name?: string;
  created_at?: string;
  delivered?: boolean;
}

interface ScheduledMessage {
  id?: string;
  user_id: string;
  title: string;
  content: string;
  url?: string;
  scheduled_for: string;
  created_at?: string;
  sent?: boolean;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-ai-phone-service-key, x-ai-phone-origin",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function generateId(): string {
  return crypto.randomUUID();
}

// WxPusher 推送
async function sendWxPusher(env: Env, title: string, content: string, url?: string): Promise<{ ok: boolean; error?: string }> {
  const spt = env.WXPUSHER_SPT;
  if (!spt) return { ok: false, error: "未配置 WxPusher SPT" };

  try {
    const response = await fetch("https://wxpusher.zjiecode.com/api/send/message/simple-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: spt,
        title: title.slice(0, 100),
        content: content.slice(0, 500),
        url: url || env.SITE_ORIGIN || undefined,
      }),
    });
    const data = await response.json() as { code?: number; msg?: string };
    if (data.code === 1000) return { ok: true };
    return { ok: false, error: data.msg || "WxPusher 推送失败" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "网络错误" };
  }
}

// 保存消息到 D1
async function saveMessage(env: Env, msg: PushMessage): Promise<void> {
  const id = msg.id || generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO messages (id, user_id, title, content, url, session_id, character_name, created_at, delivered)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    msg.user_id,
    msg.title,
    msg.content,
    msg.url || null,
    msg.session_id || null,
    msg.character_name || null,
    now,
    msg.delivered ? 1 : 0
  ).run();
}

// 保存定时消息
async function saveScheduledMessage(env: Env, msg: ScheduledMessage): Promise<void> {
  const id = msg.id || generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO scheduled_messages (id, user_id, title, content, url, scheduled_for, created_at, sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    msg.user_id,
    msg.title,
    msg.content,
    msg.url || null,
    msg.scheduled_for,
    now,
    0
  ).run();
}

// 处理待发送的定时消息（由 Cron 触发）
async function processScheduledMessages(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(
    `SELECT * FROM scheduled_messages WHERE sent = 0 AND scheduled_for <= ? LIMIT 10`
  ).bind(now).all<ScheduledMessage & { id: string }>();

  for (const msg of results || []) {
    const pushResult = await sendWxPusher(env, msg.title, msg.content, msg.url);
    if (pushResult.ok) {
      await env.DB.prepare(
        `UPDATE scheduled_messages SET sent = 1 WHERE id = ?`
      ).bind(msg.id).run();
    }
  }
}

// 健康检查
async function handleHealth(env: Env): Promise<Response> {
  try {
    await env.DB.prepare("SELECT 1").first();
    return json({
      ok: true,
      service: "ai-phone-cloudflare-worker",
      version: "1.0.0",
      wxpusher: Boolean(env.WXPUSHER_SPT),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return json({ ok: false, error: "D1 数据库连接失败" }, 503);
  }
}

// 发送即时推送
async function handleSend(env: Env, request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      user_id?: string;
      title?: string;
      content?: string;
      url?: string;
      session_id?: string;
      character_name?: string;
    };

    const title = cleanText(body.title, 100);
    const content = cleanText(body.content, 500);
    if (!title || !content) {
      return json({ ok: false, error: "标题和内容不能为空" }, 400);
    }

    const msg: PushMessage = {
      user_id: cleanText(body.user_id, 64) || "owner",
      title,
      content,
      url: cleanText(body.url, 500),
      session_id: cleanText(body.session_id, 64),
      character_name: cleanText(body.character_name, 100),
    };

    // 保存到数据库
    await saveMessage(env, msg);

    // 发送 WxPusher
    const pushResult = await sendWxPusher(env, msg.title, msg.content, msg.url);
    if (!pushResult.ok) {
      return json({ ok: false, error: pushResult.error }, 502);
    }

    return json({ ok: true, message: "推送已发送" });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "处理失败" }, 500);
  }
}

// 预约定时推送
async function handleSchedule(env: Env, request: Request): Promise<Response> {
  try {
    const body = await request.json() as {
      user_id?: string;
      title?: string;
      content?: string;
      url?: string;
      scheduled_for?: string;
    };

    const title = cleanText(body.title, 100);
    const content = cleanText(body.content, 500);
    const scheduledFor = cleanText(body.scheduled_for, 30);

    if (!title || !content || !scheduledFor) {
      return json({ ok: false, error: "标题、内容和预约时间不能为空" }, 400);
    }

    // 验证时间格式
    const scheduledDate = new Date(scheduledFor);
    if (isNaN(scheduledDate.getTime())) {
      return json({ ok: false, error: "预约时间格式无效" }, 400);
    }

    const msg: ScheduledMessage = {
      user_id: cleanText(body.user_id, 64) || "owner",
      title,
      content,
      url: cleanText(body.url, 500),
      scheduled_for: scheduledDate.toISOString(),
    };

    await saveScheduledMessage(env, msg);
    return json({ ok: true, message: "预约已创建", scheduled_for: msg.scheduled_for });
  } catch (err) {
    return json({ ok: false, error: err instanceof Error ? err.message : "处理失败" }, 500);
  }
}

// 获取消息历史
async function handleHistory(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);
  const offset = Math.max(parseInt(url.searchParams.get("offset") || "0", 10), 0);

  try {
    const { results } = await env.DB.prepare(
      `SELECT * FROM messages ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all<PushMessage>();

    return json({ ok: true, messages: results || [], limit, offset });
  } catch (err) {
    return json({ ok: false, error: "获取历史失败" }, 500);
  }
}

// 主请求处理
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const action = url.searchParams.get("action") || "";

    try {
      // 健康检查
      if (action === "health" || path === "/health") {
        return handleHealth(env);
      }

      // 发送推送
      if (request.method === "POST" && (action === "send" || path === "/send")) {
        return handleSend(env, request);
      }

      // 预约定时推送
      if (request.method === "POST" && (action === "schedule" || path === "/schedule")) {
        return handleSchedule(env, request);
      }

      // 消息历史
      if (request.method === "GET" && (action === "history" || path === "/history")) {
        return handleHistory(env, request);
      }

      // 默认响应
      return json({
        service: "AI Phone Cloudflare Worker",
        endpoints: {
          health: "GET /?action=health",
          send: "POST /?action=send { title, content, url?, session_id?, character_name? }",
          schedule: "POST /?action=schedule { title, content, scheduled_for, url? }",
          history: "GET /?action=history&limit=50&offset=0",
        },
        wxpusher_configured: Boolean(env.WXPUSHER_SPT),
      });
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : "内部错误" }, 500);
    }
  },

  // Cron 触发器：每分钟检查定时消息
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processScheduledMessages(env));
  },
};
