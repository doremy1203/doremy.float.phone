import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { decryptPushJobPayload, encryptPushJobPayload, type EncryptedPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type BridgeConfigRow = { cloud_config?: EncryptedPayload | null };
type NativeEventBody = { id?: unknown; type?: unknown; payload?: unknown; createdAt?: unknown; notifyAlreadyShown?: unknown };

/**
 * Android 原生后台感知事件入口。
 *
 * 使用站点登录 Cookie 识别账号；个人 Supabase 凭据只在服务端解密使用，
 * 不要求把 service key 交给原生常驻服务。事件写入个人云现实桥收件箱，
 * 随后唤醒现有 push-bridge 扫描任务，复用现有规则匹配/冷却/角色回复链路。
 */
export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "站点 Supabase 未配置。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "未登录。" }, { status: 401 });

    const body = await request.json().catch(() => ({})) as NativeEventBody;
    const id = String(body.id ?? "").trim().slice(0, 100);
    const type = String(body.type ?? "").trim().slice(0, 60);
    const payload = String(body.payload ?? "").trim().slice(0, 1000);
    const timestamp = typeof body.createdAt === "number" && Number.isFinite(body.createdAt)
      ? body.createdAt
      : Date.parse(String(body.createdAt ?? ""));
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(id) || !["长时间使用", "应用用太久"].includes(type) || !payload) {
      return NextResponse.json({ ok: false, error: "事件格式无效。" }, { status: 400 });
    }
    if (!Number.isFinite(timestamp) || timestamp > Date.now() + 60_000 || Date.now() - timestamp > 2 * 60 * 60 * 1000) {
      return NextResponse.json({ ok: false, error: "事件已过期或时间无效。" }, { status: 410 });
    }

    const filter = `push_bridge_config?user_id=eq.${encodeSupabaseFilter(account.id)}&select=cloud_config&limit=1`;
    const configResult = await supabaseRestFetch<BridgeConfigRow[]>(filter);
    if (!configResult.ok) return NextResponse.json({ ok: false, error: configResult.error }, { status: 500 });
    const encryptedCloud = configResult.data[0]?.cloud_config;
    if (!encryptedCloud) {
      return NextResponse.json({ ok: false, error: "现实桥个人云配置尚未同步。" }, { status: 409 });
    }

    const payloadKey = await getOrCreatePushPayloadKey();
    const cloud = JSON.parse(decryptPushJobPayload(encryptedCloud, payloadKey)) as { url?: string; key?: string };
    const cloudUrl = String(cloud.url ?? "").replace(/\/+$/, "");
    const cloudKey = String(cloud.key ?? "").trim();
    if (!/^https:\/\//i.test(cloudUrl) || !cloudKey) {
      return NextResponse.json({ ok: false, error: "个人云配置无效。" }, { status: 409 });
    }

    // 文件名由事件 ID 决定；重复请求会覆盖同一对象，避免同一段停留被重复入队。
    const fileName = `native_${id}.json`;
    const objectUrl = `${cloudUrl}/storage/v1/object/ai-phone-backup/bridge-inbox/${encodeURIComponent(fileName)}`;
    const upload = await fetch(objectUrl, {
      method: "POST",
      headers: {
        apikey: cloudKey,
        Authorization: `Bearer ${cloudKey}`,
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify({ type, payload, createdAt: new Date(timestamp).toISOString() }),
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
    if (!upload.ok) {
      const detail = (await upload.text().catch(() => "")).slice(0, 240);
      return NextResponse.json({ ok: false, error: `个人云收件箱写入失败：HTTP ${upload.status} ${detail}` }, { status: 502 });
    }

    // 个人云模式下，规则与 push-bridge worker 都在用户自己的 Supabase。
    // 用已有 bridge_token 唤醒个人云网关，避免把个人规则/快照复制到站点数据库。
    const siteSupabase = getSupabaseServerConfig();
    const sameProject = Boolean(siteSupabase
      && new URL(siteSupabase.url).origin.toLowerCase() === new URL(cloudUrl).origin.toLowerCase());
    if (!sameProject) {
      const personalHeaders = { apikey: cloudKey, Authorization: `Bearer ${cloudKey}` };
      const tokenResponse = await fetch(
        `${cloudUrl}/rest/v1/push_bridge_config?user_id=eq.owner&select=bridge_token&limit=1`,
        { headers: personalHeaders, cache: "no-store", signal: AbortSignal.timeout(8_000) },
      );
      if (!tokenResponse.ok) {
        return NextResponse.json({ ok: false, error: "无法读取个人云现实桥令牌。" }, { status: 502 });
      }
      const tokenRows = await tokenResponse.json() as { bridge_token?: string }[];
      const bridgeToken = String(tokenRows[0]?.bridge_token ?? "");
      if (!bridgeToken) {
        return NextResponse.json({ ok: false, error: "个人云现实桥尚未初始化；请先打开现实桥设置并完成同步。" }, { status: 409 });
      }
      const wake = await fetch(`${cloudUrl}/functions/v1/ai-phone-push?action=bridge-wake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: bridgeToken }),
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!wake.ok) {
        const detail = (await wake.text().catch(() => "")).slice(0, 200);
        return NextResponse.json({ ok: false, error: `个人云唤醒失败：HTTP ${wake.status} ${detail}` }, { status: 502 });
      }
      return NextResponse.json({ ok: true, queued: true, personalCloud: true });
    }

    // 同项目模式直接复用站点 bridge_scan worker。删除旧状态任务再插入，避免唯一索引被 done/failed 行卡住。
    const triggerKey = `bridge:scan:${account.id}`;
    const jobFilter = `push_jobs?user_id=eq.${encodeSupabaseFilter(account.id)}&trigger_key=eq.${encodeSupabaseFilter(triggerKey)}`;
    await supabaseRestFetch(jobFilter, { method: "DELETE" });
    const job = await supabaseRestFetch("push_jobs", {
      method: "POST",
      body: JSON.stringify([{
        id: `job_${crypto.randomUUID()}`,
        user_id: account.id,
        trigger_key: triggerKey,
        kind: "bridge_scan",
        execute_at: new Date(Date.now() + 1_500).toISOString(),
        status: "pending",
        payload: encryptPushJobPayload(JSON.stringify({ kind: "bridge_scan" }), payloadKey),
      }]),
    });
    if (!job.ok) {
      if (/duplicate key/i.test(job.error || "")) return NextResponse.json({ ok: true, duplicate: true });
      return NextResponse.json({ ok: false, error: job.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, queued: true });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: formatSupabaseRestError(err instanceof Error ? err.message : String(err)) },
      { status: 500 },
    );
  }
}
