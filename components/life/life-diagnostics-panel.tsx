"use client";

import { useEffect, useState } from "react";
import { Download, RefreshCw, Trash2 } from "lucide-react";
import {
  clearLifeDiagnostics,
  readLifeDiagnostics,
  type LifeDiagnosticEntry,
  type LifeDiagnosticStatus,
} from "@/lib/life/life-diagnostics";
import { readFailedLifeSceneReplies, resetFailedLifeSceneReply, type PendingLifeSceneNotificationReply } from "@/lib/life/life-notification-queue";
import { isPersonalPushCloudActive, loadPersonalPushCloudState, personalPushFetch } from "@/lib/personal-push-cloud";
import { isShellEnvironment } from "@/lib/shell-detect";
import { resetLifeSystemData } from "@/lib/life/life-reset";

const STATUS_LABEL: Record<LifeDiagnosticStatus, string> = {
  ok: "成功",
  warning: "警告",
  error: "失败",
  info: "记录",
};

const STATUS_STYLE: Record<LifeDiagnosticStatus, string> = {
  ok: "bg-emerald-100 text-emerald-700",
  warning: "bg-amber-100 text-amber-700",
  error: "bg-rose-100 text-rose-700",
  info: "bg-stone-100 text-stone-600",
};

type DiagnosticFilter = "all" | LifeDiagnosticStatus;

export function LifeDiagnosticsPanel() {
  const [entries, setEntries] = useState<LifeDiagnosticEntry[]>([]);
  const [cloudEntries, setCloudEntries] = useState<LifeDiagnosticEntry[]>([]);
  const [filter, setFilter] = useState<DiagnosticFilter>("all");
  const [failedReplies, setFailedReplies] = useState<PendingLifeSceneNotificationReply[]>([]);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetResult, setResetResult] = useState("");

  const refresh = async () => {
    setEntries(readLifeDiagnostics());
    setFailedReplies(readFailedLifeSceneReplies());
    try {
      const personalCloudReady = isPersonalPushCloudActive()
        && !isShellEnvironment()
        && (loadPersonalPushCloudState()?.schemaVersion ?? 0) >= 4;
      const response = personalCloudReady
        ? await personalPushFetch("life-schedule-diagnostics", { method: "GET" })
        : await fetch("/api/life/schedule-diagnostics", { cache: "no-store" });
      const data = await response.json().catch(() => ({})) as {
        ok?: boolean;
        diagnostics?: Array<{ id: string; severity: string; code: string; detail: string; repair_hint: string; trace_id?: string; updated_at: string }>;
        events?: Array<{ id: string; trace_id: string; stage: string; severity: string; code: string; detail: string; actor_id?: string | null; session_id?: string | null; job_id?: string | null; created_at: string }>;
      };
      if (!response.ok || !data.ok || !Array.isArray(data.diagnostics)) return;
      const diagnosticEntries = data.diagnostics.map(item => ({
        id: "cloud:" + item.id,
        at: item.updated_at,
        traceId: item.trace_id || undefined,
        source: "云端生活引擎",
        event: item.code || "日程诊断",
        status: item.severity === "warning" ? "warning" as const : item.severity === "info" ? "info" as const : "error" as const,
        detail: [item.detail, item.repair_hint ? "修复建议：" + item.repair_hint : ""].filter(Boolean).join("\n"),
        meta: { cloudDiagnosticId: item.id, traceId: item.trace_id || undefined },
      }));
      const traceEntries = (data.events || []).map(item => ({
        id: "trace:" + item.id,
        at: item.created_at,
        traceId: item.trace_id,
        source: "云端执行链路",
        event: item.stage + " · " + item.code,
        status: item.severity === "error" ? "error" as const : item.severity === "warning" ? "warning" as const : "info" as const,
        detail: item.detail,
        meta: { traceId: item.trace_id, actorId: item.actor_id, sessionId: item.session_id, jobId: item.job_id },
      }));
      setCloudEntries([...traceEntries, ...diagnosticEntries].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)));
    } catch {
      // Cloud diagnostics are additive; local diagnostics remain available offline.
    }
  };
  const retryFailedReply = (replyId: string) => { resetFailedLifeSceneReply(replyId); refresh(); };

  const resetLife = async () => {
    if (resetBusy) return;
    if (!window.confirm("确定要完整重置生活系统吗？将清除生活现场、日程、邀约、生活记录、生活通知队列和云端生活任务；角色卡、线上聊天、照片墙、图片参考和 API 配置会保留。")) return;
    if (!window.confirm("最后确认：生活数据和未送达的生活主动消息将无法恢复。是否继续？")) return;
    setResetBusy(true);
    setResetResult("");
    try {
      await resetLifeSystemData();
      setResetResult("生活系统已重置。后台自主运行已关闭；需要重新启用后才会开始新的生活日程。");
      await refresh();
    } catch (error) {
      setResetResult("重置未完成：" + (error instanceof Error ? error.message : String(error)) + "。本机生活数据尚未清除。");
    } finally {
      setResetBusy(false);
    }
  };

  useEffect(() => {
    let active = true;
    const poll = () => { if (active && document.visibilityState === "visible") void refresh(); };
    poll();
    const timer = window.setInterval(poll, 60_000);
    const onUpdated = () => { void refresh(); };
    const onVisibility = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("life-diagnostics-updated", onUpdated);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("life-diagnostics-updated", onUpdated);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const allEntries = [...entries, ...cloudEntries].sort((a, b) => b.at.localeCompare(a.at));
  const visible = filter === "all"
    ? allEntries
    : allEntries.filter(entry => entry.status === filter);

  const activeIssues = allEntries
    .filter(entry => entry.status === "error" || entry.status === "warning")
    .filter(issue => !allEntries.some(entry => entry.status === "ok" && entry.source === issue.source && entry.event === issue.event && entry.at > issue.at))
    .slice(0, 3);

  const counts = allEntries.reduce<Record<LifeDiagnosticStatus, number>>(
    (result, entry) => {
      result[entry.status] += 1;
      return result;
    },
    { ok: 0, warning: 0, error: 0, info: 0 },
  );

  const exportLog = () => {
    const blob = new Blob([JSON.stringify(allEntries, null, 2)], { type: "application/json" });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = "life-diagnostics.json";
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  };

  const clearLog = () => {
    if (!window.confirm("清空本机诊断记录？不会影响生活数据。")) return;
    clearLifeDiagnostics();
    refresh();
  };

  return (
    <section className="rounded-3xl border border-[var(--life-accent)]/25 bg-white/75 p-4 shadow-sm sm:p-6 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--life-accent)]">
            System diagnostics
          </p>
          <h2 className="mt-1 text-lg font-semibold text-stone-800">生活系统诊断记录</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-500">
            汇总本机链路记录与云端常驻日程引擎故障；本机最多保留 300 条，云端只保留未解决故障。
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs"
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            type="button"
            disabled={!entries.length}
            onClick={exportLog}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs disabled:opacity-40"
          >
            <Download size={14} />
            导出 JSON
          </button>
          <button
            type="button"
            disabled={!entries.length}
            onClick={clearLog}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border border-rose-200 bg-white px-3 text-xs text-rose-700 disabled:opacity-40"
          >
            <Trash2 size={14} />
            清空
          </button>
        </div>
      </div>

      <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <b className="text-sm text-rose-900">完整重置生活系统</b>
            <p className="mt-1 text-[11px] leading-relaxed text-rose-800">清理本机生活数据、生活图片缓存、待处理通知回复，以及云端 life-scene 任务、回传消息和七日日程快照。不会清理角色卡、普通聊天、其他 APP 或 API 配置。</p>
          </div>
          <button type="button" onClick={() => void resetLife()} disabled={resetBusy} className="min-h-10 rounded-xl border border-rose-300 bg-white px-3 text-xs font-semibold text-rose-800 disabled:opacity-50">{resetBusy ? "正在重置…" : "完整重置"}</button>
        </div>
        {resetResult && <p role="status" className="mt-2 whitespace-pre-wrap text-xs text-rose-900">{resetResult}</p>}
      </div>

      {activeIssues.length > 0 && (
        <div role="alert" aria-live="polite" className={`mt-4 rounded-2xl border p-3 ${activeIssues.some(entry => entry.status === "error") ? "border-rose-300 bg-rose-50/90" : "border-amber-300 bg-amber-50/90"}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <b className={`text-sm ${activeIssues.some(entry => entry.status === "error") ? "text-rose-900" : "text-amber-900"}`}>生活系统有 {allEntries.filter(issue => (issue.status === "error" || issue.status === "warning") && !allEntries.some(entry => entry.status === "ok" && entry.source === issue.source && entry.event === issue.event && entry.at > issue.at)).length} 项需要关注</b>
            <button type="button" onClick={() => setFilter(activeIssues.some(entry => entry.status === "error") ? "error" : "warning")} className="rounded-lg border border-current/20 bg-white/80 px-3 py-1.5 text-xs font-medium">查看故障记录</button>
          </div>
          <div className="mt-2 space-y-1.5">
            {activeIssues.map(entry => <div key={entry.id} className="rounded-xl bg-white/75 px-3 py-2">
              <p className="text-xs font-semibold text-stone-800">{entry.source} · {entry.event}</p>
              <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-stone-600">{entry.detail}</p>
            </div>)}
          </div>
        </div>
      )}

      {failedReplies.length > 0 && (
        <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/80 p-3">
          <b className="text-sm text-rose-800">有 {failedReplies.length} 条通知回复已暂停</b>
          <p className="mt-1 text-[11px] leading-relaxed text-rose-700">可能是自动重试次数已用尽，或原现场/角色已失效。原始现场消息仍保留在本机；修复对应问题后可重新排队。</p>
          <div className="mt-2 space-y-2">
            {failedReplies.map(reply => (
              <div key={reply.replyId} className="flex flex-wrap items-center gap-2 rounded-xl border border-rose-200/80 bg-white/80 p-2">
                <div className="min-w-0 flex-1">
                  <p className="break-all text-[10px] text-stone-600">角色 {reply.characterId} · 场景 {reply.sceneId}</p>
                  <p className="mt-0.5 break-words text-[10px] text-rose-700">{reply.lastError || "角色回应连续失败。"}</p>
                </div>
                <button type="button" onClick={() => retryFailedReply(reply.replyId)} className="min-h-9 rounded-lg border border-rose-300 bg-white px-3 text-xs font-medium text-rose-700">重新排队</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 grid grid-cols-4 gap-2">
        {(["ok", "warning", "error", "info"] as const).map(status => (
          <button
            key={status}
            type="button"
            onClick={() => setFilter(current => current === status ? "all" : status)}
            className={`rounded-xl border px-2 py-2 text-left ${
              filter === status
                ? "border-[var(--life-accent)] bg-[var(--life-accent)]/10"
                : "border-stone-200 bg-white/80"
            }`}
          >
            <b className="block text-lg">{counts[status]}</b>
            <span className="text-[10px] text-stone-500">{STATUS_LABEL[status]}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs font-medium text-stone-600">最近记录 · {visible.length}</p>
        <select
          value={filter}
          onChange={event => setFilter(event.target.value as DiagnosticFilter)}
          className="rounded-lg border bg-white px-2 py-1.5 text-xs"
          aria-label="筛选诊断记录"
        >
          <option value="all">全部</option>
          <option value="error">失败</option>
          <option value="warning">警告</option>
          <option value="ok">成功</option>
          <option value="info">记录</option>
        </select>
      </div>

      <div
        className="mt-2 max-h-[28rem] space-y-2 overflow-y-auto pr-1"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        {visible.slice(0, 100).map(entry => (
          <article key={entry.id} className="rounded-xl border border-stone-200/70 bg-white/85 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${STATUS_STYLE[entry.status]}`}>
                {STATUS_LABEL[entry.status]}
              </span>
              <b className="text-xs">{entry.source} · {entry.event}</b>
              {entry.traceId && <span className="max-w-full break-all rounded bg-stone-100 px-1.5 py-0.5 text-[9px] text-stone-500">Trace: {entry.traceId}</span>}
              <time className="ml-auto text-[10px] text-stone-400">
                {new Date(entry.at).toLocaleString("zh-CN")}
              </time>
            </div>

            <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-relaxed text-stone-600">
              {entry.detail}
            </p>

            {entry.meta && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10px] text-stone-400">链路参数</summary>
                <pre className="mt-1 overflow-x-auto rounded-lg bg-stone-50 p-2 text-[10px]">
                  {JSON.stringify(entry.meta, null, 2)}
                </pre>
              </details>
            )}
          </article>
        ))}

        {!visible.length && (
          <p className="rounded-xl bg-white/70 p-4 text-center text-xs text-stone-500">
            暂无记录；执行日程同步或云端调度后会自动显示。
          </p>
        )}
      </div>

      <p className="mt-2 text-[10px] text-stone-400">
        导出前请检查是否包含不想分享的角色名称或错误详情；导出内容包含本机记录和云端未解决故障。
      </p>
    </section>
  );
}
