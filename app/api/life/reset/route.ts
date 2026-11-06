import { NextResponse } from "next/server";
import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, formatSupabaseRestError, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

export async function POST(request: Request) {
  try {
    if (!getSupabaseServerConfig()) {
      return NextResponse.json({ ok: false, error: "Supabase 环境变量未配置，无法确认云端生活任务已清理。" }, { status: 503 });
    }
    const account = await getCurrentAccount(request);
    if (!account) return NextResponse.json({ ok: false, error: "未登录，无法安全定位当前账号的生活任务。" }, { status: 401 });
    const userFilter = `user_id=eq.${encodeSupabaseFilter(account.id)}`;
    const lifeKeyFilter = `&trigger_key=like.${encodeSupabaseFilter("life-scene:%")}`;
    const mutate = async (path: string, method: "PATCH" | "DELETE", body?: Record<string, unknown>) => {
      const result = await supabaseRestFetch(path, {
        method,
        headers: { Prefer: "return=representation", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!result.ok) throw new Error(result.error || `Supabase ${method} failed`);
      return Array.isArray(result.data) ? result.data.length : 0;
    };
    // Remove the authoritative snapshot first so future scheduler ticks cannot re-arm life jobs.
    const deletedSnapshots = await mutate(`push_bridge_snapshots?${userFilter}&rule_id=eq.life-schedule`, "DELETE");
    const cancelledRunning = await mutate(`push_jobs?${userFilter}${lifeKeyFilter}&status=eq.running`, "PATCH", {
      status: "cancelled", result_note: "life system reset by user", updated_at: new Date().toISOString(),
    });
    const deletedPending = await mutate(`push_jobs?${userFilter}${lifeKeyFilter}&status=not.eq.cancelled`, "DELETE");
    const deletedOutbox = await mutate(`push_outbox?${userFilter}${lifeKeyFilter}`, "DELETE");
    const deletedRuntime = await mutate(`life_schedule_runtime?${userFilter}`, "DELETE");
    const deletedDiagnostics = await mutate(`life_schedule_diagnostics?${userFilter}`, "DELETE");
    return NextResponse.json({ ok: true, cancelledRunning, deletedPending, deletedOutbox, deletedSnapshots, deletedRuntime, deletedDiagnostics });
  } catch (error) {
    return NextResponse.json({ ok: false, error: formatSupabaseRestError(error instanceof Error ? error.message : String(error)) }, { status: 500 });
  }
}
