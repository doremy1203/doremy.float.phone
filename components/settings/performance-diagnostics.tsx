"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Clipboard, RefreshCw, Trash2 } from "lucide-react";
import {
  getPerformanceDiagnosticsSnapshot,
  resetPerformanceDiagnostics,
  recordPerformanceMetric,
  type PerformanceDiagnosticsSnapshot,
} from "@/lib/performance-diagnostics";

type RuntimeSample = {
  sampledAt: string;
  domNodes: number;
  mountedChatRooms: number;
  hiddenChatRooms: number;
  visible: boolean;
  eventLoopLagMs: number;
  jsHeapUsedBytes: number | null;
  jsHeapLimitBytes: number | null;
  deviceMemoryGb: number | null;
};

type PerformanceMemory = {
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
  jsHeapSizeLimit?: number;
};

type NavigatorWithMemory = Navigator & { deviceMemory?: number };
type WindowWithMemory = Window & { performance?: Performance & { memory?: PerformanceMemory } };

function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "当前设备不支持";
  if (value < 1024 * 1024) return (value / 1024).toFixed(0) + " KB";
  return (value / (1024 * 1024)).toFixed(1) + " MB";
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 14, padding: 13, minWidth: 0 }}>
      <div style={{ fontSize: 11, opacity: .62 }}>{label}</div>
      <div style={{ fontSize: 19, fontWeight: 650, marginTop: 5, overflowWrap: "anywhere" }}>{value}</div>
      {hint ? <div style={{ fontSize: 10, opacity: .52, marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

export function PerformanceDiagnostics() {
  const [snapshot, setSnapshot] = useState<PerformanceDiagnosticsSnapshot>(() => getPerformanceDiagnosticsSnapshot());
  const [sample, setSample] = useState<RuntimeSample | null>(null);
  const [notice, setNotice] = useState("");
  const [sampleCount, setSampleCount] = useState(0);

  useEffect(() => {
    let previousTick = performance.now();
    const timer = window.setInterval(() => {
      const currentTick = performance.now();
      const eventLoopLagMs = Math.max(0, currentTick - previousTick - 1500);
      previousTick = currentTick;
      if (eventLoopLagMs >= 80) {
        recordPerformanceMetric("runtime.event_loop_lag", eventLoopLagMs, { thresholdMs: 80 });
      }
      const memory = (window as WindowWithMemory).performance?.memory;
      const chatRoomLayers = Array.from(document.querySelectorAll<HTMLElement>(".chat-room-layer"));
      const hiddenChatRooms = chatRoomLayers.filter(element => (
        window.getComputedStyle(element).display === "none"
        || window.getComputedStyle(element).visibility === "hidden"
      )).length;
      setSample({
        sampledAt: new Date().toISOString(),
        domNodes: document.getElementsByTagName("*").length,
        mountedChatRooms: chatRoomLayers.length,
        hiddenChatRooms,
        visible: document.visibilityState === "visible",
        eventLoopLagMs: Math.round(eventLoopLagMs),
        jsHeapUsedBytes: typeof memory?.usedJSHeapSize === "number" ? memory.usedJSHeapSize : null,
        jsHeapLimitBytes: typeof memory?.jsHeapSizeLimit === "number" ? memory.jsHeapSizeLimit : null,
        deviceMemoryGb: typeof (navigator as NavigatorWithMemory).deviceMemory === "number"
          ? (navigator as NavigatorWithMemory).deviceMemory!
          : null,
      });
      setSnapshot(getPerformanceDiagnosticsSnapshot());
      setSampleCount(value => value + 1);
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const report = useMemo(() => ({
    generatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    viewport: typeof window !== "undefined"
      ? { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio }
      : null,
    runtime: sample,
    diagnostics: snapshot,
    notes: [
      "此报告不包含聊天正文、角色名称、API Key 或用户输入内容。",
      "JS Heap 和 Long Task 指标仅在浏览器支持时提供。",
      "当前页面打开期间会持续采样；切回应用复现卡顿后再返回此页查看记录。",
    ],
  }), [sample, snapshot]);

  const exportReport = useCallback(async () => {
    const json = JSON.stringify(report, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setNotice("诊断报告已复制");
    } catch {
      const blob = new Blob([json], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "doremy-performance-diagnostics.json";
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice("已导出诊断报告");
    }
    window.setTimeout(() => setNotice(""), 2400);
  }, [report]);

  const reset = useCallback(() => {
    resetPerformanceDiagnostics();
    setSnapshot(getPerformanceDiagnosticsSnapshot());
    setSampleCount(0);
    setNotice("已清空本次性能记录");
    window.setTimeout(() => setNotice(""), 2400);
  }, []);

  const heapUsed = sample?.jsHeapUsedBytes ?? null;
  const longTaskCount = snapshot.longTasks.length;
  const slowest = snapshot.metrics[0];

  return (
    <section style={{ display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <Activity size={19} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>性能诊断</div>
          <div style={{ fontSize: 11, opacity: .58 }}>采集主线程长任务、内存、DOM 规模和聊天存储耗时</div>
        </div>
        <button type="button" onClick={() => setSnapshot(getPerformanceDiagnosticsSnapshot())} aria-label="刷新诊断" style={{ padding: 7 }}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 9 }}>
        <MetricCard label="JS 堆内存" value={formatBytes(heapUsed)} hint={sample?.jsHeapLimitBytes ? "上限 " + formatBytes(sample.jsHeapLimitBytes) : "浏览器可能不支持内存 API"} />
        <MetricCard label="页面 DOM 节点" value={sample ? sample.domNodes.toLocaleString() : "采集中"} hint="包含当前页面内所有元素" />
        <MetricCard label="主线程长任务" value={String(longTaskCount)} hint="单个任务超过 50ms；仅支持的浏览器可用" />
        <MetricCard label="已挂载聊天室" value={sample ? String(sample.mountedChatRooms) : "采集中"} hint={sample ? "其中隐藏 " + sample.hiddenChatRooms + " 个" : "统计缓存的聊天室组件"} />
        <MetricCard label="事件循环延迟" value={sample ? sample.eventLoopLagMs + " ms" : "采集中"} hint="约每 1.5 秒采样一次" />
        <MetricCard label="已记录性能指标" value={String(snapshot.metrics.length)} hint="按最大耗时排序" />
        <MetricCard label="采样次数" value={String(sampleCount)} hint={sample?.visible ? "页面前台" : "等待采样"} />
      </div>

      {sample?.deviceMemoryGb ? <div style={{ fontSize: 11, opacity: .6 }}>设备内存等级：{sample.deviceMemoryGb} GB（浏览器提供的近似值）</div> : null}
      {notice ? <div role="status" style={{ fontSize: 12, color: "var(--c-accent)" }}>{notice}</div> : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => void exportReport()} style={{ flex: 1, display: "inline-flex", justifyContent: "center", alignItems: "center", gap: 7, padding: "10px 12px", borderRadius: 11, background: "var(--c-accent)", color: "#fff", fontSize: 12 }}>
          <Clipboard size={15} />复制/导出报告
        </button>
        <button type="button" onClick={reset} style={{ display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 12px", borderRadius: 11, border: "1px solid var(--border, rgba(128,128,128,.18))", fontSize: 12 }}>
          <Trash2 size={14} />清空
        </button>
      </div>

      <div style={{ borderTop: "1px solid var(--border, rgba(128,128,128,.18))", paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>耗时热点</div>
        {snapshot.metrics.length ? snapshot.metrics.slice(0, 12).map(metric => (
          <div key={metric.name} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border, rgba(128,128,128,.1))" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, overflowWrap: "anywhere" }}>{metric.name}</div>
              <div style={{ fontSize: 10, opacity: .52 }}>次数 {metric.count} · 平均 {metric.averageMs} ms · 最大 {metric.maxMs} ms</div>
              {metric.metadata ? <div style={{ fontSize: 10, opacity: .48 }}>{Object.entries(metric.metadata).map(([key, value]) => key + ": " + value).join(" · ")}</div> : null}
            </div>
            <div style={{ fontSize: 12, fontWeight: 650, whiteSpace: "nowrap" }}>{metric.lastMs} ms</div>
          </div>
        )) : <div style={{ fontSize: 11, opacity: .55, padding: "8px 0" }}>暂未记录到带埋点的操作。先清空后正常使用聊天，再回来查看。</div>}
      </div>

      <div style={{ borderTop: "1px solid var(--border, rgba(128,128,128,.18))", paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650, marginBottom: 8 }}>最近主线程长任务</div>
        {snapshot.longTasks.length ? snapshot.longTasks.slice(0, 8).map((task, index) => (
          <div key={task.at + index} style={{ fontSize: 11, padding: "6px 0", opacity: .76 }}>
            {new Date(task.at).toLocaleTimeString()} · {task.durationMs} ms
          </div>
        )) : <div style={{ fontSize: 11, opacity: .55 }}>暂无记录，或当前浏览器不支持 Long Task API。</div>}
      </div>
      <div style={{ fontSize: 10, opacity: .5, lineHeight: 1.5 }}>
        最近采样：{sample?.sampledAt ? new Date(sample.sampledAt).toLocaleTimeString() : "等待中"}。慢任务记录最多保留 160 条，数据只保存在当前页面内存中。
        {slowest ? " 当前最大耗时热点：" + slowest.name + "。" : ""}
      </div>
    </section>
  );
}
