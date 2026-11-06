import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { broadcastShellNotify, resolvePushSubject, sendPushToUser } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

/**
 * 离线推送自检 + 测试。
 *
 * POST：App 内「测试」按钮调用（客户端已确保自己在线）。
 * GET ：浏览器直接打开本地址即可自检——这条链路完全跑在站点（Netlify）上，
 *       不依赖个人云部署，因此它是排查推送问题时最可靠的一根探针：
 *       它会先把账号、订阅两处状态原样列出来，再发一条真实广播并回报结果。
 *       哪一环断，返回里直接写清楚，不用再去 Supabase 翻表。
 */
async function runTest(request: Request, includeDiagnostics: boolean) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, step: "server", error: "站点未配置 Supabase 环境变量（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) {
      return NextResponse.json({ ok: false, step: "account", error: "未登录。" }, { status: 401 });
    }

    const testBody = request.method === "POST" ? await request.clone().json().catch(() => ({})) as Record<string, unknown> : {};
    // 生活现场专用测试：只广播到安卓壳 Realtime 通道，不把网页内预览冒充原生通知。
    // 只查本账号——这正是与个人云那套 OWNER_ID 寻址的关键差异，也是本链路可靠的原因。
    let subscriptions: { endpoint: string; user_id: string }[] = [];
    let shellEndpoints: string[] = [];
    if (includeDiagnostics) {
      const subs = await supabaseRestFetch<{ endpoint: string; user_id: string }[]>(
        `push_subscriptions?user_id=eq.${encodeSupabaseFilter(account.id)}&select=endpoint,user_id&limit=50`,
      );
      subscriptions = subs.ok ? subs.data : [];
      shellEndpoints = subscriptions.filter(row => row.endpoint.startsWith("shell:")).map(row => row.endpoint);
    }

    if (testBody.kind === "life_scene") {
      const sessionId = typeof testBody.sessionId === "string" ? testBody.sessionId.trim() : "";
      const sceneId = typeof testBody.sceneId === "string" ? testBody.sceneId.trim() : "";
      if (!sessionId || !sceneId) return NextResponse.json({ ok: false, step: "life-scene-payload", error: "缺少生活现场 sessionId 或 sceneId。" }, { status: 400 });
      const shellSubsResult = await supabaseRestFetch<{ endpoint: string }[]>(
        "push_subscriptions?user_id=eq." + encodeSupabaseFilter(account.id) + "&select=endpoint&limit=50",
      );
      if (!shellSubsResult.ok) return NextResponse.json({ ok: false, step: "subscriptions", error: shellSubsResult.error }, { status: 500 });
      if (!shellSubsResult.data.some(row => row.endpoint.startsWith("shell:"))) {
        return NextResponse.json({ ok: false, step: "no-shell-subscription", error: "当前账号没有安卓壳 shell: 订阅。请先打开安卓壳并等待常驻通知显示“已连接，等待角色消息”。" }, { status: 400 });
      }
      await new Promise(resolve => setTimeout(resolve, 1200));
      const sent = await broadcastShellNotify(account.id, {
        title: "生活现场 · 主动消息",
        body: typeof testBody.body === "string" ? testBody.body : "这是一条生活现场原生通知测试。",
        kind: "life_scene",
        sessionId,
        sceneId,
        characterName: typeof testBody.characterName === "string" ? testBody.characterName : "",
        avatar: typeof testBody.avatar === "string" ? testBody.avatar : "",
        url: "/#open-chat=" + encodeURIComponent(sessionId),
      });
      if (!sent) return NextResponse.json({ ok: false, step: "shell-broadcast", error: "安卓壳原生通知广播发送失败，请检查 Supabase Realtime 配置。" }, { status: 502 });
      return NextResponse.json({ ok: true, message: "已向安卓壳 Realtime 通道发送生活现场原生通知。", sent: 1, total: 1 });
    }

    // 留出杀后台的时间窗：请求收到后等 6 秒再发送（客户端此时可能已经被杀，无妨）。
    await new Promise(resolve => setTimeout(resolve, 6000));
    const result = await sendPushToUser(account.id, {
      title: "小手机",
      body: "离线推送已连通。关掉后台也能收到这样的通知。",
      tag: "push-test",
      url: new URL("/", request.url).toString(),
    }, resolvePushSubject(request.url));

    const diagnostics = includeDiagnostics
      ? {
          accountId: account.id,
          subscriptionCount: subscriptions.length,
          shellEndpoints,
          endpoints: subscriptions.map(row => row.endpoint).slice(0, 10),
        }
      : undefined;

    if (result.total === 0) {
      return NextResponse.json({
        ok: false,
        step: "no-subscription",
        error: `账号「${account.id}」名下没有任何推送订阅。壳需要在 App 里成功连过一次才会注册（通知栏常驻通知显示「已连接，等待角色消息」即为已注册）。`,
        diagnostics,
      }, { status: 400 });
    }
    if (result.sent === 0) {
      return NextResponse.json({
        ok: false,
        step: "send-failed",
        error: `订阅有 ${result.total} 条，但发送全部失败：${result.errors[0] || "未知错误"}`,
        diagnostics,
      }, { status: 500 });
    }
    return NextResponse.json({
      ok: true,
      message: shellEndpoints.length > 0
        ? "已向安卓壳通道发出测试广播。若此刻 App 已杀后台，几秒内应收到系统通知。"
        : "已发出测试推送。注意：本账号没有 shell: 订阅，说明这次发的不是壳通道。",
      sent: result.sent,
      total: result.total,
      diagnostics,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, step: "exception", error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  return runTest(request, false);
}

/** 浏览器直接打开即可自检（带完整诊断信息）。 */
export async function GET(request: Request) {
  return runTest(request, true);
}
