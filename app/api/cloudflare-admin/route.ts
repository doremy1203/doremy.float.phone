import { NextResponse } from "next/server";

// Cloudflare 管理 API 代理：浏览器直连 Cloudflare API 有 CORS 限制，
// 与 Supabase 一键部署走服务端转发是同一原因。
// API Token 与取回的密钥均只在本次请求中透传，不存储、不记录。

export const runtime = "nodejs";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

type AdminPayload = {
  action?: string;
  token?: string;
  accountId?: string;
  workerName?: string;
  d1DatabaseId?: string;
  wxpusherSpt?: string;
  siteOrigin?: string;
  sql?: string;
  code?: string;
  cron?: string;
};

function cleanToken(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanAccountId(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value.trim()) ? value.trim() : "";
}

function cleanWorkerName(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(raw) ? raw : "";
}

function cleanSpt(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  return /^SPT_[A-Za-z0-9]+$/.test(raw) ? raw : "";
}

function safeErrorText(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\b[a-f0-9]{32}\b/gi, "[ID 已隐藏]")
    .replace(/\beyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[JWT 已隐藏]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

async function cloudflareFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${CLOUDFLARE_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
}

async function upstreamMessage(response: Response, operation: string): Promise<string> {
  const raw = await response.text().catch(() => "");
  let detail = "";
  try {
    const data = JSON.parse(raw) as { errors?: Array<{ message?: string }>; messages?: string[] };
    detail = data.errors?.[0]?.message || data.messages?.[0] || "";
  } catch {
    detail = safeErrorText(raw);
  }

  let guidance: string;
  if (response.status === 401) {
    guidance = "Cloudflare 未接受这个 API Token。请确认粘贴的是令牌页生成的完整 Token，且令牌尚未过期。";
  } else if (response.status === 403) {
    guidance = `API Token 已被识别，但缺少"${operation}"所需权限。请检查令牌权限范围。`;
  } else if (response.status === 429) {
    guidance = "Cloudflare 请求过于频繁，请稍候一分钟再试。";
  } else if (response.status >= 500) {
    guidance = "Cloudflare 服务暂时异常，请稍后再试。";
  } else {
    guidance = `Cloudflare 未能完成"${operation}"。`;
  }

  return [
    guidance,
    `失败步骤：${operation}（HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}）`,
    detail ? `Cloudflare 提示：${safeErrorText(detail)}` : "Cloudflare 没有返回更多错误信息。",
  ].join("\n");
}

// 验证 Token 并获取账户信息
async function handleVerifyToken(token: string): Promise<NextResponse> {
  const response = await cloudflareFetch(token, "/user/tokens/verify");
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response, "验证 API Token") }, { status: response.status });
  }
  const data = await response.json() as { result?: { id?: string; status?: string } };
  return NextResponse.json({ ok: true, tokenId: data.result?.id, status: data.result?.status });
}

// 获取账户列表
async function handleAccounts(token: string): Promise<NextResponse> {
  const response = await cloudflareFetch(token, "/accounts");
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response, "读取账户列表") }, { status: response.status });
  }
  const data = await response.json() as { result?: Array<{ id?: string; name?: string }> };
  const accounts = (data.result || [])
    .filter(item => item.id && item.name)
    .map(item => ({ id: item.id!, name: item.name! }));
  return NextResponse.json({ ok: true, accounts });
}

// 创建 D1 数据库（如果已存在则返回现有的）
async function handleCreateD1(token: string, accountId: string, name: string): Promise<NextResponse> {
  // 先尝试创建
  const response = await cloudflareFetch(token, `/accounts/${accountId}/d1/database`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });

  // 先读取 body（只能读一次）
  const responseText = await response.text();

  if (response.ok) {
    try {
      const data = JSON.parse(responseText) as { result?: { uuid?: string; name?: string } };
      return NextResponse.json({ ok: true, databaseId: data.result?.uuid, databaseName: data.result?.name });
    } catch {
      return NextResponse.json({ ok: false, error: "创建 D1 数据库返回了无效的响应" }, { status: 502 });
    }
  }

  // 如果创建失败，检查是否因为数据库已存在
  if (responseText.includes("already exists") || responseText.includes("duplicate")) {
    // 查询现有数据库列表，找到同名的
    const listResponse = await cloudflareFetch(token, `/accounts/${accountId}/d1/database`);
    if (listResponse.ok) {
      const listData = await listResponse.json() as { result?: Array<{ uuid?: string; name?: string }> };
      const existing = (listData.result || []).find(db => db.name === name);
      if (existing?.uuid) {
        return NextResponse.json({ ok: true, databaseId: existing.uuid, databaseName: existing.name, reused: true });
      }
    }
  }

  // 构建错误信息
  let detail = "";
  try {
    const errorData = JSON.parse(responseText) as { errors?: Array<{ message?: string }> };
    detail = errorData.errors?.[0]?.message || "";
  } catch {
    detail = responseText.slice(0, 300);
  }

  return NextResponse.json({
    ok: false,
    error: `创建 D1 数据库失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`,
  }, { status: response.status });
}

// 执行 D1 SQL
async function handleD1Query(token: string, accountId: string, databaseId: string, sql: string): Promise<NextResponse> {
  const response = await cloudflareFetch(token, `/accounts/${accountId}/d1/database/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response, "执行 D1 SQL") }, { status: response.status });
  }
  const data = await response.json() as { result?: Array<{ results?: unknown[]; success?: boolean }> };
  return NextResponse.json({ ok: true, result: data.result });
}

// 部署 Worker（ES Module 格式，同时绑定 D1 和环境变量）
async function handleDeployWorker(
  token: string,
  accountId: string,
  workerName: string,
  code: string,
  options: {
    d1DatabaseId?: string;
    wxpusherSpt?: string;
    siteOrigin?: string;
  }
): Promise<NextResponse> {
  const bindings: Array<Record<string, unknown>> = [];

  // D1 绑定
  if (options.d1DatabaseId) {
    bindings.push({
      name: "DB",
      type: "d1",
      id: options.d1DatabaseId,
    });
  }

  // 环境变量（secrets）
  if (options.wxpusherSpt) {
    bindings.push({
      name: "WXPUSHER_SPT",
      type: "secret_text",
      text: options.wxpusherSpt,
    });
  }
  if (options.siteOrigin) {
    bindings.push({
      name: "SITE_ORIGIN",
      type: "plain_text",
      text: options.siteOrigin,
    });
  }

  // 使用 multipart/form-data 上传 ES Module Worker
  const formData = new FormData();
  formData.append("metadata", JSON.stringify({
    main_module: "worker.js",
    bindings,
    compatibility_date: "2024-01-01",
  }));
  formData.append("worker.js", new Blob([code], { type: "application/javascript+module" }), "worker.js");

  const uploadResponse = await fetch(`${CLOUDFLARE_API}/accounts/${accountId}/workers/scripts/${workerName}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: formData,
  });

  if (!uploadResponse.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(uploadResponse, "上传 Worker 脚本") }, { status: uploadResponse.status });
  }

  return NextResponse.json({ ok: true, workerName });
}

// 设置 Cron 触发器
async function handleSetCron(token: string, accountId: string, workerName: string, cron: string): Promise<NextResponse> {
  const response = await cloudflareFetch(token, `/accounts/${accountId}/workers/scripts/${workerName}/schedules`, {
    method: "PUT",
    body: JSON.stringify([{ cron }]),
  });
  if (!response.ok) {
    return NextResponse.json({ ok: false, error: await upstreamMessage(response, "设置 Cron 触发器") }, { status: response.status });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request): Promise<NextResponse> {
  let payload: AdminPayload;
  try {
    payload = await request.json() as AdminPayload;
  } catch {
    return NextResponse.json({ ok: false, error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const token = cleanToken(payload.token);
  if (!token) return NextResponse.json({ ok: false, error: "缺少 API Token。" }, { status: 400 });

  try {
    if (payload.action === "verify_token") return await handleVerifyToken(token);
    if (payload.action === "accounts") return await handleAccounts(token);

    const accountId = cleanAccountId(payload.accountId);
    if (!accountId) return NextResponse.json({ ok: false, error: "账户 ID 不合法。" }, { status: 400 });

    if (payload.action === "create_d1") {
      const name = cleanWorkerName(payload.workerName) || "ai-phone-push";
      return await handleCreateD1(token, accountId, `${name}-db`);
    }

    if (payload.action === "d1_query") {
      const databaseId = typeof payload.d1DatabaseId === "string" ? payload.d1DatabaseId.trim() : "";
      if (!databaseId) return NextResponse.json({ ok: false, error: "数据库 ID 不合法。" }, { status: 400 });
      const sql = typeof payload.sql === "string" ? payload.sql : "";
      if (!sql.trim()) return NextResponse.json({ ok: false, error: "缺少要执行的 SQL。" }, { status: 400 });
      return await handleD1Query(token, accountId, databaseId, sql);
    }

    if (payload.action === "deploy_worker") {
      const workerName = cleanWorkerName(payload.workerName);
      if (!workerName) return NextResponse.json({ ok: false, error: "Worker 名称不合法。" }, { status: 400 });
      const code = typeof payload.code === "string" ? payload.code : "";
      if (!code || code.length > 500_000) return NextResponse.json({ ok: false, error: "Worker 代码无效。" }, { status: 400 });
      const wxpusherSpt = cleanSpt(payload.wxpusherSpt);
      const siteOrigin = typeof payload.siteOrigin === "string" ? payload.siteOrigin.trim() : "";
      const d1DatabaseId = typeof payload.d1DatabaseId === "string" ? payload.d1DatabaseId.trim() : "";
      return await handleDeployWorker(token, accountId, workerName, code, {
        d1DatabaseId,
        wxpusherSpt,
        siteOrigin,
      });
    }

    if (payload.action === "set_cron") {
      const workerName = cleanWorkerName(payload.workerName);
      if (!workerName) return NextResponse.json({ ok: false, error: "Worker 名称不合法。" }, { status: 400 });
      const cron = typeof payload.cron === "string" ? payload.cron : "* * * * *";
      return await handleSetCron(token, accountId, workerName, cron);
    }

    return NextResponse.json({ ok: false, error: "未知操作。" }, { status: 400 });
  } catch (error) {
    const detail = safeErrorText(error instanceof Error ? error.message : String(error));
    return NextResponse.json({
      ok: false,
      error: [
        "暂时无法连接 Cloudflare 管理接口，请检查网络后重试。",
        detail ? `本地连接提示：${detail}` : "没有可用的连接错误详情。",
      ].join("\n"),
    }, { status: 502 });
  }
}
