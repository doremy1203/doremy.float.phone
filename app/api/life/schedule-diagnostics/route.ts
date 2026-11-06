import { NextResponse } from "next/server";

import { getCurrentAccount } from "@/lib/server/account-auth";
import { encodeSupabaseFilter, getSupabaseServerConfig, supabaseRestFetch } from "@/lib/server/supabase-rest";

type CloudLifeDiagnostic = {
  id: string;
  severity: "error" | "warning" | "info";
  code: string;
  detail: string;
  repair_hint: string;
  updated_at: string;
  trace_id?: string;
  resolved_at: string | null;
};

type CloudLifeDiagnosticEvent = {
  id: string; trace_id: string; stage: string; severity: string; code: string; detail: string;
  actor_id: string | null; session_id: string | null; job_id: string | null; created_at: string;
};

export async function GET(request: Request) {
  if (!getSupabaseServerConfig()) {
    return NextResponse.json({ ok: false, error: "站点 Supabase 未配置。", diagnostics: [] }, { status: 503 });
  }
  const account = await getCurrentAccount(request).catch(() => null);
  if (!account) {
    return NextResponse.json({ ok: false, error: "未登录。", diagnostics: [] }, { status: 401 });
  }
  const result = await supabaseRestFetch<CloudLifeDiagnostic[]>(
    "life_schedule_diagnostics?user_id=eq." + encodeSupabaseFilter(account.id)
      + "&resolved_at=is.null&select=id,severity,code,detail,repair_hint,updated_at,resolved_at"
      + "&order=updated_at.desc&limit=20",
  );
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error, diagnostics: [] }, { status: 502 });
  }
  const events = await supabaseRestFetch<CloudLifeDiagnosticEvent[]>(
    "life_schedule_diagnostic_events?user_id=eq." + encodeSupabaseFilter(account.id)
      + "&select=id,trace_id,stage,severity,code,detail,actor_id,session_id,job_id,created_at"
      + "&order=created_at.desc&limit=100",
  );
  return NextResponse.json({
    ok: true,
    diagnostics: result.data,
    events: events.ok ? events.data : [],
  });
}
