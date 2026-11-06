"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { loadPhotoWallState } from "@/lib/photo-wall-storage";
import { hasWidgetBridge, isWidgetPlaced, readWidgetDiagnostics } from "@/lib/widget/bridge";
import { loadWidgetConfig } from "@/lib/widget/storage";
import { readPerceptionDiagnostics } from "@/lib/perception/diagnostics";

type ModuleSnapshot = {
  photoWall: { photos: number; annotations: number; doodles: number; world: string; background: boolean; lastError: string };
  watch: string;
  widget: { bridge: boolean; enabled: boolean; placed: boolean; native: ReturnType<typeof readWidgetDiagnostics> };
  reality: { shell: boolean; bridge: boolean; running: boolean; accessibility: boolean; lastSampleAt: string; unmatched: number; location: string };
};

function readModuleSnapshot(): ModuleSnapshot {
  const wall = loadPhotoWallState();
  const widgetConfig = loadWidgetConfig();
  const widgetNative = readWidgetDiagnostics();
  const reality = readPerceptionDiagnostics();
  let watch = "";
  try { watch = localStorage.getItem("watch_last_diagnostics_report_v1") || ""; } catch { /* local-only diagnostic */ }
  return {
    photoWall: {
      photos: wall.photos.length,
      annotations: wall.photos.reduce((sum, photo) => sum + photo.annotations.length, 0),
      doodles: (wall.wallDoodles?.length ?? 0)
        + wall.photos.reduce((sum, photo) => sum + (photo.doodles?.length ?? 0) + (photo.backDoodles?.length ?? 0), 0),
      world: (wall.world?.width ?? 0) + " × " + (wall.world?.height ?? 0),
      background: Boolean(wall.wallBackgroundRef),
      lastError: wall.settings.lastDailyGenerationError || "",
    },
    watch,
    widget: {
      bridge: hasWidgetBridge(),
      enabled: widgetConfig.enabled,
      placed: isWidgetPlaced(),
      native: widgetNative,
    },
    reality: {
      shell: reality.inShell,
      bridge: reality.bridgeAvailable,
      running: reality.running,
      accessibility: reality.accessibility,
      lastSampleAt: reality.lastSampleAt,
      unmatched: reality.unmatchedSignals,
      location: reality.location ? "已取得位置读数" : "暂无位置读数",
    },
  };
}

function Row({ label, value }: { label: string; value: string }) {
  return <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid var(--border, rgba(128,128,128,.12))", fontSize: 12 }}>
    <span style={{ opacity: .68 }}>{label}</span><span style={{ textAlign: "right", overflowWrap: "anywhere" }}>{value}</span>
  </div>;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return <section style={{ border: "1px solid var(--border, rgba(128,128,128,.18))", borderRadius: 16, padding: 14 }}>
    <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{title}</div>{children}
  </section>;
}

export function ModuleDiagnostics() {
  const [snapshot, setSnapshot] = useState<ModuleSnapshot | null>(null);
  const refresh = useCallback(() => {
    try { setSnapshot(readModuleSnapshot()); }
    catch (error) { console.warn("[ModuleDiagnostics] refresh failed", error); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  if (!snapshot) return <Card title="照片墙 / 一起看 / 桌面小组件 / 现实桥梁"><p style={{ fontSize: 12, opacity: .7 }}>正在读取各模块本机诊断快照…</p><button type="button" onClick={refresh} style={{ marginTop: 8, fontSize: 12 }}>重新读取</button></Card>;

  const native = snapshot.widget.native;
  const reality = snapshot.reality;
  return <div style={{ display: "grid", gap: 10 }}>
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <button type="button" onClick={refresh} style={{ border: "1px solid var(--border, #ddd)", borderRadius: 9, padding: "7px 10px", background: "transparent", fontSize: 11 }}>刷新模块诊断</button>
    </div>
    <Card title="照片墙 · 本机数据检查">
      <Row label="照片数量" value={String(snapshot.photoWall.photos)} />
      <Row label="批注数量" value={String(snapshot.photoWall.annotations)} />
      <Row label="涂鸦数量" value={String(snapshot.photoWall.doodles)} />
      <Row label="画布世界尺寸" value={snapshot.photoWall.world} />
      <Row label="全局背景" value={snapshot.photoWall.background ? "已设置" : "未设置"} />
      {snapshot.photoWall.lastError && <p style={{ marginTop: 8, color: "#dc2626", fontSize: 12 }}>最近自动生成失败：{snapshot.photoWall.lastError}</p>}
      <p style={{ marginTop: 7, fontSize: 10, opacity: .55 }}>只读检查存储数据，不修改照片、贴纸尺寸或画布内容。</p>
    </Card>
    <Card title="一起看 · 最近播放诊断">
      {snapshot.watch
        ? <><pre style={{ maxHeight: 220, overflow: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 10, lineHeight: 1.5 }}>{snapshot.watch}</pre><button type="button" onClick={() => { try { navigator.clipboard.writeText(snapshot.watch); } catch {} }} style={{ marginTop: 7, border: "1px solid var(--border, #ddd)", borderRadius: 8, padding: "6px 9px", background: "transparent", fontSize: 11 }}>复制播放诊断</button></>
        : <p style={{ fontSize: 12, opacity: .7 }}>还没有保存的播放诊断报告。请在一起看 → 设置 → 播放诊断中点击「生成播放诊断报告」，再返回此处刷新。</p>}
    </Card>
    <Card title="桌面小组件 · 网页与原生链路">
      <Row label="原生小组件桥" value={snapshot.widget.bridge ? "可用" : "不可用"} />
      <Row label="网页总开关" value={snapshot.widget.enabled ? "已开启" : "关闭"} />
      <Row label="桌面实例" value={snapshot.widget.placed ? "已放置" : "未检测到实例"} />
      <Row label="原生 HTML" value={native ? (native.hasHtml ? "已收到（" + native.htmlChars + " 字）" : "未收到") : "当前 APK 不提供详情"} />
      <Row label="PNG 落盘" value={native ? (native.pngExists ? "成功（" + Math.round(native.pngBytes / 1024) + " KB）" : "未落盘") : "未知"} />
      <Row label="最近渲染" value={native ? (native.rendering ? "进行中" : native.renderAt <= 0 ? "从未渲染" : native.renderOk ? "成功" : "失败：" + (native.renderError || "无错误原因")) : "未知"} />
    </Card>
    <Card title="现实桥梁 · 感知桥诊断">
      <Row label="Android 原生壳" value={reality.shell ? "已检测" : "非原生环境"} />
      <Row label="感知桥" value={reality.bridge ? "可用" : "不可用"} />
      <Row label="采样引擎" value={reality.running ? "运行中" : "未运行"} />
      <Row label="无障碍服务" value={reality.accessibility ? "已连接" : "未连接 / 不可读取"} />
      <Row label="最近采样" value={reality.lastSampleAt ? new Date(reality.lastSampleAt).toLocaleString() : "暂无记录"} />
      <Row label="最近位置读数" value={reality.location} />
      <Row label="未匹配信号" value={String(reality.unmatched)} />
      <p style={{ marginTop: 7, fontSize: 10, opacity: .55 }}>此处显示现实桥的感知链路快照；快捷指令执行与回传历史仍以现实桥应用内记录为准。</p>
    </Card>
  </div>;
}
