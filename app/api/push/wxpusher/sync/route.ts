import { NextResponse } from "next/server";

import { encodeSupabaseFilter, supabaseRestFetch } from "@/lib/server/supabase-rest";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { isValidWxPusherSpt } from "@/lib/server/wxpusher";

type SptRow = { user_id: string; spt: string };

export async function GET(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });

  try {
    const result = await supabaseRestFetch<SptRow[]>(
      `push_channel_spt?user_id=eq.${encodeSupabaseFilter(account.id)}&select=user_id,spt&limit=1`,
    );
    if (!result.ok) {
      if (/42P01|does not exist|push_channel_spt/.test(result.error)) {
        return NextResponse.json({ ok: true, spt: null });
      }
      return NextResponse.json({ ok: false, error: result.error || "读取失败" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, spt: result.data?.[0]?.spt || null });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "读取失败" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const account = await getCurrentAccount(request);
  if (!account) return NextResponse.json({ ok: false, error: "未登录" }, { status: 401 });

  const body = await request.json().catch(() => ({})) as { spt?: unknown; action?: unknown };
  const action = String(body.action ?? "save");

  if (action === "clear" || !body.spt) {
    try {
      await supabaseRestFetch(`push_channel_spt?user_id=eq.${encodeSupabaseFilter(account.id)}`, { method: "DELETE" });
    } catch { /* 表不存在或其他错误，静默 */ }
    return NextResponse.json({ ok: true, message: "已清除" });
  }

  const spt = String(body.spt ?? "").trim();
  if (!isValidWxPusherSpt(spt)) {
    return NextResponse.json({ ok: false, error: "SPT 格式不正确" }, { status: 400 });
  }

  try {
    const res = await supabaseRestFetch("push_channel_spt", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{ user_id: account.id, channel: "wxpusher", spt, updated_at: new Date().toISOString() }]),
    });
    if (!res.ok) {
      if (/42P01|does not exist|push_channel_spt/.test(res.error)) {
        return NextResponse.json({
          ok: false,
          error: "服务端尚未建 push_channel_spt 表。请在 Supabase SQL Editor 执行 docs/push-channel-spt-migration.sql（或重跑云服务部署脚本）。",
        }, { status: 503 });
      }
      return NextResponse.json({ ok: false, error: res.error || "保存失败" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "保存失败" }, { status: 502 });
  }
}
