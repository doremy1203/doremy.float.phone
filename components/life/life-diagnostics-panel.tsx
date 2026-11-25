"use client";

import { useEffect, useRef, useState } from "react";
import { ClipboardCopy, Download, RefreshCw, Trash2 } from "lucide-react";
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
import { loadVirtualLifeState } from "@/lib/life/life-storage";
import { CLOUD_BREAKER_CHANGED_EVENT, cloudBreakerState, resetCloudBreaker, type CloudBreakerState } from "@/lib/cloud-circuit-breaker";
import { downloadFile } from "@/lib/download-utils";
import { copyTextToClipboard } from "@/lib/clipboard-utils";
import { loadCharacters } from "@/lib/character-storage";
import { isManualLocationOverrideActive } from "@/lib/life/life-runtime";

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
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [cloudStatus, setCloudStatus] = useState("尚未刷新");
  const [localSnapshot, setLocalSnapshot] = useState<Record<string, unknown> | null>(null);
  const [summaryText, setSummaryText] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [snapshotBreaker, setSnapshotBreaker] = useState<CloudBreakerState>(() => cloudBreakerState("life-snapshot"));
  const [pushBreaker, setPushBreaker] = useState<CloudBreakerState>(() => cloudBreakerState("push"));
  const refreshInFlightRef = useRef(false);

  useEffect(() => {
    const sync = () => {
      setSnapshotBreaker(cloudBreakerState("life-snapshot"));
      setPushBreaker(cloudBreakerState("push"));
    };
    window.addEventListener(CLOUD_BREAKER_CHANGED_EVENT, sync);
    return () => window.removeEventListener(CLOUD_BREAKER_CHANGED_EVENT, sync);
  }, []);

  const refresh = async () => {
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setRefreshing(true);
    setCloudEntries([]);
    try {
      const localEntries = readLifeDiagnostics();
      const life = loadVirtualLifeState();
      const now = Date.now();
      const player = life.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
      const characterNames = new Map(loadCharacters().map(character => [character.id, character.name]));
      const messagesByScene = new Map<string, typeof life.sceneMessages>();
      for (const message of life.sceneMessages) {
        const group = messagesByScene.get(message.sceneId) ?? [];
        group.push(message);
        messagesByScene.set(message.sceneId, group);
      }
      const localStorageStats = { keyCount: 0, estimatedCharacters: 0 };
      try {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key) continue;
          localStorageStats.keyCount += 1;
          localStorageStats.estimatedCharacters += key.length + (localStorage.getItem(key)?.length ?? 0);
        }
      } catch { /* host storage may be restricted */ }
      const snapshot = {
        collectedAt: new Date().toISOString(),
        environment: {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          online: navigator.onLine,
          visibility: document.visibilityState,
          secureContext: window.isSecureContext,
          viewport: { width: window.innerWidth, height: window.innerHeight, pixelRatio: window.devicePixelRatio },
          screen: { width: window.screen.width, height: window.screen.height },
          indexedDbAvailable: typeof indexedDB !== "undefined",
          serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
          localStorage: localStorageStats,
        },
        lifeSystem: {
          updatedAt: life.updatedAt,
          enabled: life.settings.enabled,
          characterAutonomy: life.settings.enableCharacterAutonomy,
          proactiveMessages: life.settings.enableProactiveSceneMessages,
          player: player ? {
            activity: player.activity,
            actualLocationId: player.actualLocationId,
            actualLocationName: player.actualLocationName,
            actualLocationUntil: player.actualLocationUntil ?? null,
            updatedAt: player.updatedAt,
          } : null,
          actors: life.actorStates.map(actor => {
            const activeSlots = life.schedules.filter(slot => slot.ownerType === actor.ownerType && slot.ownerId === actor.ownerId
              && Date.parse(slot.startAt) <= now && Date.parse(slot.endAt) > now)
              .sort((a, b) => Date.parse(b.startAt) - Date.parse(a.startAt) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
            const slot = activeSlots[0];
            const until = actor.actualLocationUntil ? Date.parse(actor.actualLocationUntil) : Number.NaN;
            const temporaryStay = Number.isFinite(until) && until > now;
            // Same TTL rule as settlement/UI: expired manual choices are no longer overrides.
            const manualOverride = isManualLocationOverrideActive(actor, new Date(now));
            return {
              ownerType: actor.ownerType,
              ownerId: actor.ownerId,
              name: actor.ownerType === "player" ? (life.settings.playerDisplayName || "我") : (characterNames.get(actor.ownerId) || actor.ownerId),
              activity: actor.activity,
              actualLocationId: actor.actualLocationId ?? null,
              actualLocationName: actor.actualLocationName ?? null,
              plannedLocationId: slot?.plannedLocationId ?? null,
              plannedLocationName: slot?.plannedLocationName ?? null,
              scheduleTitle: slot?.title ?? null,
              scheduleStartAt: slot?.startAt ?? null,
              scheduleEndAt: slot?.endAt ?? null,
              activeScheduleCount: activeSlots.length,
              locationControl: temporaryStay ? "限时停留" : manualOverride ? "手动地点覆盖" : "日程",
              actualLocationUntil: actor.actualLocationUntil ?? null,
              updatedAt: actor.updatedAt,
            };
          }),
          counts: {
            locations: life.locations.length, actors: life.actorStates.length,
            schedules: life.schedules.length, scenes: life.scenes.length,
            sceneMessages: life.sceneMessages.length, timeline: life.timeline.length,
            events: life.events.length, invitations: life.invitations.length, memories: life.memories.length,
          },
          locations: life.locations.map(location => ({ id: location.id, name: location.name, visibility: location.visibility })),
          scenes: life.scenes.map(scene => {
            const messages = messagesByScene.get(scene.id) ?? [];
            const latest = messages.reduce<typeof messages[number] | undefined>(
              (current, message) => !current || message.createdAt > current.createdAt ? message : current,
              undefined,
            );
            return {
              id: scene.id, locationId: scene.locationId, locationName: scene.locationName,
              status: scene.status, eventLinked: Boolean(scene.eventId),
              startedAt: scene.startedAt, updatedAt: scene.updatedAt,
              participants: scene.participants.map(item => ({ ownerType: item.ownerType, ownerId: item.ownerId, activity: item.activity })),
              messageCount: messages.length, latestMessageAt: latest?.createdAt ?? null,
            };
          }),
          currentSchedules: life.schedules.filter(slot =>
            new Date(slot.startAt).getTime() <= now && new Date(slot.endAt).getTime() > now,
          ).map(slot => ({
            id: slot.id, ownerType: slot.ownerType, ownerId: slot.ownerId, title: slot.title,
            startAt: slot.startAt, endAt: slot.endAt,
            plannedLocationId: slot.plannedLocationId, plannedLocationName: slot.plannedLocationName,
            source: slot.source, kind: slot.kind,
          })),
          recentTimeline: life.timeline.slice(-30).reverse().map(entry => ({
            occurredAt: entry.occurredAt, category: entry.category, title: entry.title,
            details: entry.details?.slice(0, 240), actorId: entry.actorId,
            locationName: entry.locationName, sceneId: entry.sceneId,
          })),
        },
        localDiagnosticCount: localEntries.length,
      };
      const actorRows = snapshot.lifeSystem.actors as Array<{
        name: string; ownerType: string; activity: string; actualLocationName: string | null;
        plannedLocationName: string | null; scheduleTitle: string | null; scheduleStartAt: string | null;
        scheduleEndAt: string | null; activeScheduleCount: number; locationControl: string; actualLocationUntil: string | null;
      }>;
      const activeScenes = snapshot.lifeSystem.scenes.filter(scene => scene.status === "active" || scene.status === "paused");
      const duplicateSchedules = actorRows.filter(actor => actor.activeScheduleCount > 1);
      const issueLines = [
        ...duplicateSchedules.map(actor => `日程重叠：${actor.name} 当前有 ${actor.activeScheduleCount} 条同时生效的日程。`),
        ...actorRows.filter(actor => actor.locationControl === "手动地点覆盖").map(actor => `地点覆盖：${actor.name} 当前在「${actor.actualLocationName || "未知"}」，日程计划为「${actor.plannedLocationName || "未指定"}」；手动地点应优先于日程。`),
        ...activeScenes.filter(scene => scene.status === "active" && player?.actualLocationId && scene.locationId !== player.actualLocationId).map(scene => `场景位置不一致：场景「${scene.locationName}」与玩家实际地点「${player?.actualLocationName || player?.actualLocationId}」不同。`),
      ];
      const timeLabel = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未设置";
      const summary = [
        "生活系统排查摘要",
        "采集时间：" + new Date().toLocaleString("zh-CN", { hour12: false }),
        "运行状态：" + (life.settings.enabled ? "已启用" : "未启用") + "；角色自主：" + (life.settings.enableCharacterAutonomy ? "开启" : "关闭"),
        "玩家位置：" + (player?.actualLocationName || "未知") + (player?.activity ? "；行动：" + player.activity : ""),
        "",
        "角色位置与当前日程：",
        ...actorRows.filter(actor => actor.ownerType === "character").map(actor =>
          `- ${actor.name}：实际「${actor.actualLocationName || "未知"}」；计划「${actor.plannedLocationName || "无"}」；活动「${actor.activity || "无"}」；日程「${actor.scheduleTitle || "无"}」(${timeLabel(actor.scheduleStartAt)}—${timeLabel(actor.scheduleEndAt)})；位置规则：${actor.locationControl}${actor.actualLocationUntil ? "，停留至 " + timeLabel(actor.actualLocationUntil) : ""}${actor.activeScheduleCount > 1 ? "；同时生效日程 " + actor.activeScheduleCount + " 条" : ""}`
        ),
        "",
        "当前场景：",
        ...activeScenes.map(scene => `- ${scene.locationName}（${scene.status}）；参与者：${scene.participants.map(item => item.ownerType === "player" ? "我" : characterNames.get(item.ownerId) || item.ownerId).join("、") || "无"}；场景 ID：${scene.id}`),
        "",
        "自动检查：",
        ...(issueLines.length ? issueLines.map(line => "- " + line) : ["- 未发现明显的日程重叠或场景位置冲突。"]),
        "",
        "最近的位置/日程/场景变化：",
        ...life.timeline.filter(entry => ["location", "schedule", "scene"].includes(entry.category)).slice(-12).reverse().map(entry =>
          `- ${timeLabel(entry.occurredAt)}｜${entry.actorName || entry.actorId || "系统"}｜${entry.title}${entry.details ? "｜" + entry.details.slice(0, 180) : ""}`
        ),
      ].join("\n");
      setSummaryText(summary);
      setCopyStatus("");
      setEntries(localEntries);
      setFailedReplies(readFailedLifeSceneReplies());
      setLocalSnapshot(snapshot);
      setCloudStatus("正在读取云端补充记录…");
      try {
        const personalCloudReady = isPersonalPushCloudActive()
          && !isShellEnvironment()
          && (loadPersonalPushCloudState()?.schemaVersion ?? 0) >= 4;
        const request = personalCloudReady
          ? personalPushFetch("life-schedule-diagnostics", { method: "GET" })
          : fetch("/api/life/schedule-diagnostics", { cache: "no-store" });
        let timeoutId = 0;
        const response = await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(() => reject(new Error("云端诊断请求超时")), 10_000);
          }),
        ]).finally(() => window.clearTimeout(timeoutId));
        const data = await response.json().catch(() => ({})) as {
          ok?: boolean;
          diagnostics?: Array<{ id: string; severity: string; code: string; detail: string; repair_hint: string; trace_id?: string; updated_at: string }>;
          events?: Array<{ id: string; trace_id: string; stage: string; severity: string; code: string; detail: string; actor_id?: string | null; session_id?: string | null; job_id?: string | null; created_at: string }>;
        };
        if (!response.ok || !data.ok || !Array.isArray(data.diagnostics)) {
          setCloudStatus("云端补充记录暂不可用；本机快照和本机记录已刷新。");
        } else {
          const diagnosticEntries = data.diagnostics.map(item => ({
            id: "cloud:" + item.id, at: item.updated_at, traceId: item.trace_id || undefined,
            source: "云端生活引擎", event: item.code || "日程诊断",
            status: item.severity === "warning" ? "warning" as const : item.severity === "info" ? "info" as const : "error" as const,
            detail: [item.detail, item.repair_hint ? "修复建议：" + item.repair_hint : ""].filter(Boolean).join("\n"),
            meta: { cloudDiagnosticId: item.id, traceId: item.trace_id || undefined },
          }));
          const traceEntries = (data.events || []).map(item => ({
            id: "trace:" + item.id, at: item.created_at, traceId: item.trace_id,
            source: "云端执行链路", event: item.stage + " · " + item.code,
            status: item.severity === "error" ? "error" as const : item.severity === "warning" ? "warning" as const : "info" as const,
            detail: item.detail,
            meta: { traceId: item.trace_id, actorId: item.actor_id, sessionId: item.session_id, jobId: item.job_id },
          }));
          setCloudEntries([...traceEntries, ...diagnosticEntries].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)));
          setCloudStatus("云端补充记录已更新：" + (traceEntries.length + diagnosticEntries.length) + " 条。");
        }
      } catch (error) {
        setCloudEntries([]);
        setCloudStatus("云端补充记录未连接：" + (error instanceof Error ? error.message : String(error)));
      }
    } catch (error) {
      setCloudStatus("本机快照读取失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      refreshInFlightRef.current = false;
      setRefreshing(false);
    }
  };
  const retryFailedReply = (replyId: string) => { resetFailedLifeSceneReply(replyId); refresh(); };

  const resetLife = async () => {
    if (resetBusy) return;
    if (!window.confirm("重置生活系统？将清空生活现场、七日日程、邀约活动、生活记录与通知、地点库及文件夹、外观与生活设置、观察生活记录（含图片）。角色卡、普通聊天、照片墙和 API 配置会保留。重置后生活引擎为关闭状态，需要时请到设置重新开启。此操作不可撤销。")) return;
    setResetBusy(true);
    setResetResult("");
    try {
      const result = await resetLifeSystemData();
      setResetResult(result.cloudOk
        ? "已重置本机生活数据（含观察生活记录），云端生活任务也已清理。生活引擎已关闭，可在设置中重新开启。"
        : "已重置本机生活数据（含观察生活记录）。生活引擎已关闭，可在设置中重新开启。云端任务清理未确认：" + (result.cloudError || "服务端未配置") + "；不影响本机重置。");
      await refresh();
    } catch (error) {
      setResetResult("重置失败：" + (error instanceof Error ? error.message : String(error)));
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

  const exportLog = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const payload = {
        schemaVersion: 2,
        exportedAt: new Date().toISOString(),
        localSnapshot,
        localDiagnostics: entries,
        failedReplies,
        cloudDiagnostics: cloudEntries,
      };
      await downloadFile(
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" }),
        "life-diagnostics.json",
      );
    } catch (error) {
      setCloudStatus("JSON 导出失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      setExporting(false);
    }
  };

  const copySummary = async () => {
    if (!summaryText) return;
    const copied = await copyTextToClipboard(summaryText);
    setCopyStatus(copied ? "排查摘要已复制" : "复制失败，请刷新后重试");
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--life-accent)]">System diagnostics</p>
          <h2 className="mt-1 text-lg font-semibold text-stone-800">生活系统诊断记录</h2>
          <p className="mt-1 text-xs leading-relaxed text-stone-500">本机运行快照、地点聊天室、日程与本机错误优先；云端记录仅作补充。</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copySummary()}
            disabled={!summaryText}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs disabled:opacity-40"
          >
            <ClipboardCopy size={14} />
            复制排查摘要
          </button>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "刷新中…" : "刷新"}
          </button>
          <button
            type="button"
            disabled={exporting || (!localSnapshot && !allEntries.length)}
            onClick={() => void exportLog()}
            className="inline-flex min-h-10 items-center gap-1 rounded-xl border bg-white px-3 text-xs disabled:opacity-40"
          >
            <Download size={14} />
            {exporting ? "导出中…" : "导出 JSON"}
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

      {snapshotBreaker.paused || pushBreaker.paused ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <span>
            {snapshotBreaker.paused ? ("日程快照已暂停（连续 " + snapshotBreaker.failures + " 次" + (snapshotBreaker.lastError ? "，" + snapshotBreaker.lastError : "") + "）。") : ""}
            {pushBreaker.paused ? ("离线推送挂载已暂停（连续 " + pushBreaker.failures + " 次" + (pushBreaker.lastError ? "，" + pushBreaker.lastError : "") + "）。") : ""}
            自动重试已停止，避免继续消耗云端额度。
          </span>
          <button
            type="button"
            onClick={() => {
              resetCloudBreaker("life-snapshot");
              resetCloudBreaker("push");
              setSnapshotBreaker(cloudBreakerState("life-snapshot"));
              setPushBreaker(cloudBreakerState("push"));
              void refresh();
            }}
            className="inline-flex min-h-9 items-center gap-1 rounded-xl border border-amber-300 bg-white px-3 text-xs"
          >
            重试云端同步
          </button>
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50/80 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <b className="text-sm text-stone-800">运行状态摘要</b>
          <span className="text-[10px] text-stone-400">{localSnapshot ? "已采集" : "等待刷新"}</span>
        </div>
        {localSnapshot ? (
          <>
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white p-3 text-[11px] leading-relaxed text-stone-700">{summaryText}</pre>
            {copyStatus && <p role="status" className="mt-2 text-[11px] text-emerald-700">{copyStatus}</p>}
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-stone-500">查看原始快照（JSON）</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-white p-3 text-[10px] leading-relaxed text-stone-600">{JSON.stringify(localSnapshot, null, 2)}</pre>
            </details>
          </>
        ) : <p className="mt-1 text-xs text-stone-500">点击刷新采集本机数据；不依赖云端连接。</p>}
        <p className="mt-2 text-[10px] text-stone-500">{cloudStatus}</p>
      </div>
      <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <b className="text-sm text-rose-900">完整重置生活系统</b>
            <p className="mt-1 text-[11px] leading-relaxed text-rose-800/80">清理生活现场、七日日程、邀约、生活记录与通知、地点库及文件夹、外观与生活设置、观察生活记录（含图片）。重置后生活引擎为关闭状态。</p>
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
        JSON 包含设备信息、生活状态、地点聊天室结构、近期生活记录、本机诊断和云端补充记录；分享前请检查隐私内容。
      </p>
    </section>
  );
}
