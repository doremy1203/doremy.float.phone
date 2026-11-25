import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { decryptPushJobPayload, type EncryptedPayload } from "@/lib/server/push-job-crypto";
import { getOrCreatePushPayloadKey } from "@/lib/server/push-service";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";
type ConfigRow = { cloud_config?: EncryptedPayload | null };
const BUCKET = "ai-phone-backup";
function validId(value: unknown) { const id = String(value ?? "").trim(); return /^[a-zA-Z0-9_-]{8,100}$/.test(id) ? id : ""; }
async function cloud(request: Request) {
  if (!getSupabaseServerConfig()) throw new Error("站点 Supabase 未配置。");
  const account = await getCurrentAccount(request); if (!account) throw new Error("未登录。");
  const row = await supabaseRestFetch<ConfigRow[]>(`push_bridge_config?user_id=eq.${encodeSupabaseFilter(account.id)}&select=cloud_config&limit=1`);
  if (!row.ok) throw new Error(row.error || "读取现实桥配置失败。");
  if (!row.data[0]?.cloud_config) throw new Error("现实桥个人云配置尚未同步。");
  const key = await getOrCreatePushPayloadKey();
  const value = JSON.parse(decryptPushJobPayload(row.data[0].cloud_config, key)) as { url?: string; key?: string };
  const url = String(value.url ?? "").replace(/\/+$/, ""), secret = String(value.key ?? "").trim();
  if (!/^https:\/\//i.test(url) || !secret) throw new Error("个人云配置无效。");
  return { url, secret };
}
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({})) as { eventId?: unknown; status?: unknown };
    const id = validId(body.eventId); if (!id || !["displayed", "posted", "fallback"].includes(String(body.status))) return NextResponse.json({ ok: false }, { status: 400 });
    const { url, secret } = await cloud(request);
    const response = await fetch(`${url}/storage/v1/object/${BUCKET}/bridge-receipts/${encodeURIComponent(id)}.json`, { method: "POST", headers: { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json", "x-upsert": "true" }, body: JSON.stringify({ status: body.status, at: new Date().toISOString() }), cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) return NextResponse.json({ ok: false }, { status: 502 });
    return NextResponse.json({ ok: true });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return NextResponse.json({ ok: false, error: formatSupabaseRestError(message) }, { status: /未登录/.test(message) ? 401 : 500 }); }
}
export async function GET(request: Request) {
  try {
    const id = validId(new URL(request.url).searchParams.get("id")); if (!id) return NextResponse.json({ displayed: false }, { status: 400 });
    const { url, secret } = await cloud(request);
    const response = await fetch(`${url}/storage/v1/object/${BUCKET}/bridge-receipts/${encodeURIComponent(id)}.json`, { headers: { apikey: secret, Authorization: `Bearer ${secret}` }, cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (response.status === 404) return NextResponse.json({ displayed: false });
    if (!response.ok) return NextResponse.json({ displayed: false }, { status: 502 });
    const receipt = await response.json() as { status?: string }; return NextResponse.json({ displayed: receipt.status === "displayed" || receipt.status === "posted", posted: receipt.status === "posted", fallback: receipt.status === "fallback" });
  } catch (error) { const message = error instanceof Error ? error.message : String(error); return NextResponse.json({ displayed: false, error: formatSupabaseRestError(message) }, { status: /未登录/.test(message) ? 401 : 500 }); }
}