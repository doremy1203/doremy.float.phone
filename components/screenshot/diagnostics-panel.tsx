"use client";

// 截屏 / 查岗的诊断面板。
//
// 为什么单独做这个：截屏与浮层这类能力的故障几乎都是「什么都没发生」——
// 用户只能描述成「没反应」，而可能的原因有四层：权限没给 → 服务没起来 →
// 窗口没挂上 → 截图被系统拒。没有留痕就只能一层层试。
//
// 这里把原生记下的状态摊开，让用户自己能看出卡在哪一环，
// 也方便他把这段文字发出来求助（不用连 USB 调试）。
//
// 刻意不显示任何画面内容——留痕里本来就没有，这里也不会去读。

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Stethoscope } from "lucide-react";

import { isShellEnvironment as isShell } from "@/lib/shell-call-overlay";
import {
  readCheckInDiagnostics,
  readNativeCheckInDiagnostics,
  readScreenshotDiagnostics,
  readScreenshotShareTargets,
} from "@/lib/screenshot";
import type { CheckInDiagnostics, ScreenshotDiagnostics, ScreenshotShareTargetState } from "@/lib/screenshot";

function formatWhen(at: number | undefined): string {
  if (!at || at <= 0) return "从未";
  try {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  } catch {
    return "未知";
  }
}

type Row = { label: string; value: string; tone?: "ok" | "warn" | "bad" };

function toneOf(ok: boolean | undefined): "ok" | "warn" | "bad" {
  if (ok === true) return "ok";
  return "bad";
}

const TONE_COLOR: Record<string, string> = {
  ok: "var(--per-accent, #6f5bd6)",
  warn: "#d08700",
  bad: "var(--c-danger, #d9534f)",
};

export function ScreenshotDiagnosticsPanel({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [shot, setShot] = useState<ScreenshotDiagnostics | null>(null);
  const [checkIn, setCheckIn] = useState<CheckInDiagnostics | null>(null);
  const [nativeCheckIn, setNativeCheckIn] = useState<ReturnType<typeof readNativeCheckInDiagnostics>>(null);
  const [share, setShare] = useState<ScreenshotShareTargetState | null>(null);
  const [open, setOpen] = useState(false);

  const inShell = isShell();

  const refresh = useCallback(() => {
    setShot(readScreenshotDiagnostics());
    setCheckIn(readCheckInDiagnostics());
    setNativeCheckIn(readNativeCheckInDiagnostics());
    setShare(readScreenshotShareTargets());
  }, []);

  // 展开时才读一次，之后切回前台补一次（用户可能刚去系统设置授过权）
  useEffect(() => {
    if (!open) return;
    refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [open, refresh]);

  const shotRows: Row[] = shot
    ? [
        { label: "系统支持", value: shot.supported ? "支持（Android 11+）" : "不支持（需 Android 11+）", tone: toneOf(shot.supported) },
        { label: "无障碍实例连接", value: shot.accessibilityOn ? "已连接" : "未连接（可能被系统回收）", tone: toneOf(shot.accessibilityOn) },
        { label: "当前可截", value: shot.ready ? "可以" : "不可以", tone: toneOf(shot.ready) },
        { label: "进行中", value: shot.capturing ? "有一张还没截完" : "空闲", tone: shot.capturing ? "warn" : "ok" },
        { label: "累计截屏", value: `${shot.captureCount ?? 0} 次`, tone: "ok" },
        {
          label: "最近一次",
          value: shot.lastCaptureAt
            ? `${formatWhen(shot.lastCaptureAt)} · ${shot.lastCaptureOk ? "成功" : "失败"}${shot.lastCaptureNote ? ` · ${shot.lastCaptureNote}` : ""}`
            : "从未截过",
          tone: shot.lastCaptureAt ? (shot.lastCaptureOk ? "ok" : "bad") : "warn",
        },
        ...(shot.lastError ? [{ label: "最近失败", value: shot.lastError, tone: "bad" as const }] : []),
      ]
    : [];

  /**
   * 「发给谁」这一段。
   *
   * 用户主动截屏这条路上，「点了球没发出去」只有三种可能：网页从没推过
   * 角色清单、还没选收件人、图没处理成功。没有留痕时它们长得一模一样，
   * 用户只能描述成「点了没反应」。
   */
  const shareRows: Row[] = share
    ? [
        {
          label: "可选角色",
          value: share.count > 0 ? `${share.count} 位` : "0（网页还没推送清单）",
          tone: share.count > 0 ? "ok" : "warn",
        },
        {
          label: "默认收件人",
          value: share.defaultName || (share.defaultId ? "已设置的这位已被删除" : "未设置（每次让你选）"),
          tone: share.defaultId && !share.defaultName ? "bad" : "ok",
        },
        {
          label: "上次发给了谁",
          value: share.lastTargetName || "还没发过",
          tone: share.lastTargetName ? "ok" : "warn",
        },
        ...(share.lastTargetReason
          ? [{ label: "上次没能发", value: share.lastTargetReason, tone: "warn" as const }]
          : []),
      ]
    : [];

  const nativeRows: Row[] = nativeCheckIn
    ? [
        { label: "无障碍系统开关", value: nativeCheckIn.accessibilityEnabledInSettings ? "系统设置显示已开启" : "系统设置显示未开启", tone: nativeCheckIn.accessibilityEnabledInSettings ? "ok" : "bad" },
        { label: "无障碍实例", value: nativeCheckIn.accessibilityConnected ? "当前已连接" : "未连接 / 可能被系统回收", tone: nativeCheckIn.accessibilityConnected ? "ok" : "bad" },
        { label: "通知权限", value: nativeCheckIn.notificationsEnabled ? "允许通知" : "通知被关闭，无法显示故障横幅", tone: nativeCheckIn.notificationsEnabled ? "ok" : "bad" },
        { label: "忽略电池优化", value: nativeCheckIn.ignoringBatteryOptimizations ? "已允许" : "未允许（建议开启）", tone: nativeCheckIn.ignoringBatteryOptimizations ? "ok" : "warn" },
        { label: "原生闹钟", value: nativeCheckIn.scheduled ? "已登记" : "未登记", tone: nativeCheckIn.scheduled ? "ok" : "warn" },
        ...(nativeCheckIn.scheduled
          ? [{ label: "下次提醒", value: `${nativeCheckIn.characterName || "角色"} · ${formatWhen(nativeCheckIn.dueAt)}`, tone: "ok" as const }]
          : []),
        { label: "待处理提醒", value: nativeCheckIn.pending ? (nativeCheckIn.opened ? "已点击，等待网页接收" : "已到点，等待用户点击") : "无", tone: nativeCheckIn.pending ? "warn" : "ok" },
      ]
    : [];

  const checkInRows: Row[] = checkIn
    ? [
        { label: "浮窗权限", value: checkIn.canDraw ? "已授予" : "未授予", tone: toneOf(checkIn.canDraw) },
        { label: "常驻服务", value: checkIn.running ? "运行中" : "未运行", tone: toneOf(checkIn.running) },
        { label: "活动实例", value: checkIn.hasInstance ? "有" : "无", tone: checkIn.hasInstance ? "ok" : "warn" },
        { label: "窗口已挂上", value: checkIn.windowAdded ? "是" : "否", tone: checkIn.hasInstance ? toneOf(checkIn.windowAdded) : "warn" },
        { label: "窗口可见", value: checkIn.windowVisible ? "是" : "否", tone: checkIn.windowVisible ? "ok" : "warn" },
        { label: "等你决定", value: checkIn.awaitingDecision ? "有一张待处理" : "无", tone: checkIn.awaitingDecision ? "warn" : "ok" },
        { label: "累计弹出", value: `${checkIn.showCount ?? 0} 次`, tone: "ok" },
        { label: "最近弹出", value: formatWhen(checkIn.lastShowAt), tone: checkIn.lastShowAt ? "ok" : "warn" },
        ...(checkIn.lastError ? [{ label: "最近失败", value: checkIn.lastError, tone: "bad" as const }] : []),
      ]
    : [];

  return (
    <div>
      <div className="settings-menu-section-title">诊断</div>

      {!open ? (
        <div className="menu-group" style={{ marginTop: 10 }}>
          <div className="menu-item" style={{ cursor: "default" }}>
            <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
              <Stethoscope size={17} strokeWidth={1.8} />
            </div>
            <div className="menu-label-group">
              <span className="menu-label">截屏与查岗状态</span>
              <span className="menu-desc">截不到、浮层不弹的时候，在这里看卡在哪一环</span>
            </div>
            <button type="button" className="ui-btn ui-btn-outline" onClick={() => setOpen(true)}>
              展开
            </button>
          </div>
        </div>
      ) : (
        <div className="menu-group" style={{ marginTop: 10 }}>
          {!inShell ? (
            <div className="per-note is-warn" style={{ margin: "0 0 10px" }}>
              当前不在小手机 App 内，读不到原生状态（下面显示的是默认值）。
            </div>
          ) : null}

          <div style={{ padding: "6px 0", fontWeight: 600 }}>截屏桥</div>
          {shotRows.length === 0 ? (
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc">读不到截屏桥状态（当前 App 版本可能还没有诊断接口，请更新安卓壳）</span>
              </div>
            </div>
          ) : (
            shotRows.map(row => (
              <div className="menu-item" key={row.label} style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-label" style={{ fontSize: 13 }}>{row.label}</span>
                </div>
                <span style={{ fontSize: 12, color: TONE_COLOR[row.tone ?? "ok"], maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>
                  {row.value}
                </span>
              </div>
            ))
          )}

          <div style={{ padding: "14px 0 6px", fontWeight: 600 }}>发给谁</div>
          {shareRows.length === 0 ? (
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc">读不到收件人状态（当前 App 版本可能还没有这个接口，请更新安卓壳）</span>
              </div>
            </div>
          ) : (
            shareRows.map(row => (
              <div className="menu-item" key={row.label} style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-label" style={{ fontSize: 13 }}>{row.label}</span>
                </div>
                <span style={{ fontSize: 12, color: TONE_COLOR[row.tone ?? "ok"], maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>
                  {row.value}
                </span>
              </div>
            ))
          )}

          <div style={{ padding: "14px 0 6px", fontWeight: 600 }}>后台调度</div>
          {nativeRows.length === 0 ? (
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc">读不到原生闹钟状态（请更新安卓壳）</span>
              </div>
            </div>
          ) : (
            nativeRows.map(row => (
              <div className="menu-item" key={row.label} style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-label" style={{ fontSize: 13 }}>{row.label}</span>
                </div>
                <span style={{ fontSize: 12, color: TONE_COLOR[row.tone ?? "ok"], maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>
                  {row.value}
                </span>
              </div>
            ))
          )}

          <div style={{ padding: "14px 0 6px", fontWeight: 600 }}>查岗浮层</div>
          {checkInRows.length === 0 ? (
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-desc">读不到查岗浮层状态（当前 App 版本可能还没有诊断接口，请更新安卓壳）</span>
              </div>
            </div>
          ) : (
            checkInRows.map(row => (
              <div className="menu-item" key={row.label} style={{ cursor: "default" }}>
                <div className="menu-label-group">
                  <span className="menu-label" style={{ fontSize: 13 }}>{row.label}</span>
                </div>
                <span style={{ fontSize: 12, color: TONE_COLOR[row.tone ?? "ok"], maxWidth: "60%", textAlign: "right", wordBreak: "break-all" }}>
                  {row.value}
                </span>
              </div>
            ))
          )}

          <div className="per-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline"
              onClick={() => { refresh(); onNotice?.("已重新检测"); }}
            >
              <RefreshCw size={15} />
              重新检测
            </button>
            <button type="button" className="ui-btn ui-btn-outline" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>

          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)", marginTop: 6 }}>
            这里只显示状态，不含任何画面内容。若系统开关显示已开启、但无障碍实例未连接，通常是服务被系统回收：到系统无障碍设置关闭再开启「小手机/通话控制服务」；若仍反复断开，再允许自启动、后台运行并关闭电池优化。通知权限关闭时，系统无法展示故障横幅。
          </div>
        </div>
      )}
    </div>
  );
}
