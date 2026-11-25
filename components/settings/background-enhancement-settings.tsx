"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity, BatteryCharging, Bell, ExternalLink, RefreshCw } from "lucide-react";
import { Toggle } from "@/components/ui/form";

type BackgroundDiagnostics = {
  available: boolean;
  mode: "smart" | "enhanced";
  manufacturer: string;
  model: string;
  sdk: number;
  batteryOptimizationIgnored: boolean;
  notificationsEnabled: boolean;
  overlayGranted: boolean;
  accessibilityEnabled: boolean;
  exactAlarmAccess: boolean;
  exactAlarmUsed: boolean;
  foreground: boolean;
  pendingCheckIns: Array<{ name: string; backgroundOnly: boolean; fired: boolean; dueAt: number }>;
};

type NativeBackgroundBridge = {
  getBackgroundEnhancementDiagnostics?: () => string;
  setBackgroundEnhancementMode?: (mode: string) => boolean;
  openBackgroundEnhancementSettings?: (kind: string) => boolean;
};

function nativeBridge(): NativeBackgroundBridge | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { AndroidShell?: NativeBackgroundBridge }).AndroidShell ?? null;
}

function readDiagnostics(): BackgroundDiagnostics | null {
  try {
    const raw = nativeBridge()?.getBackgroundEnhancementDiagnostics?.();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackgroundDiagnostics;
    return parsed.available ? parsed : null;
  } catch {
    return null;
  }
}

function Status({ ok, unknown = false }: { ok: boolean; unknown?: boolean }) {
  return <span style={{ color: unknown ? "var(--c-text-muted)" : ok ? "var(--per-accent, #6f5bd6)" : "var(--c-danger, #d9534f)", fontSize: 12 }}>
    {unknown ? "无法自动确认" : ok ? "已满足" : "需要检查"}
  </span>;
}

export function BackgroundEnhancementSettings({ onNotice }: { onNotice?: (message: string) => void }) {
  const [diag, setDiag] = useState<BackgroundDiagnostics | null>(() => readDiagnostics());
  const refresh = useCallback(() => setDiag(readDiagnostics()), []);

  useEffect(() => {
    refresh();
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    const timer = window.setInterval(refresh, 15000);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  const setMode = (enhanced: boolean) => {
    const bridge = nativeBridge();
    if (!bridge?.setBackgroundEnhancementMode) {
      onNotice?.("当前安卓壳版本不支持后台增强设置，请更新 APK");
      return;
    }
    const ok = bridge.setBackgroundEnhancementMode(enhanced ? "enhanced" : "smart");
    if (!ok) {
      onNotice?.("保存后台模式失败");
      return;
    }
    refresh();
    onNotice?.(enhanced ? "已启用后台增强模式" : "已切换为智能省电模式");
  };

  const openSetting = (kind: string) => {
    const ok = nativeBridge()?.openBackgroundEnhancementSettings?.(kind) === true;
    if (!ok) onNotice?.("无法打开该系统设置，请从手机系统设置中手动进入应用管理");
  };

  const manufacturer = (diag?.manufacturer || "").toLowerCase();
  const vendorHint = manufacturer.includes("honor") || manufacturer.includes("huawei")
    ? "荣耀 / 华为：在应用启动管理中允许自动管理或手动开启自启动、关联启动和后台活动；再到电池设置中允许后台运行。"
    : manufacturer.includes("xiaomi") || manufacturer.includes("redmi")
      ? "小米 / Redmi：检查自启动、后台弹出界面、省电策略，并可在最近任务中锁定应用。"
      : manufacturer.includes("oppo") || manufacturer.includes("oneplus") || manufacturer.includes("realme")
        ? "OPPO / 一加 / realme：检查允许自启动、允许关联启动、后台运行和电池优化设置。"
        : manufacturer.includes("vivo") || manufacturer.includes("iqoo")
          ? "vivo / iQOO：检查后台高耗电、允许自启动和后台运行权限。"
          : manufacturer.includes("samsung")
            ? "三星：检查电池后台使用限制，避免应用进入深度休眠或休眠应用列表。"
            : "不同厂商的自启动入口名称不同。请在系统设置的应用管理、电池或启动管理中检查；当前无法可靠读取该权限状态。";

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="per-note is-warn" style={{ padding: "0 var(--ui-padding, 16px)" }}>
        <div style={{ fontWeight: 650 }}>后台增强不是“强制保活”</div>
        <div style={{ marginTop: 6, lineHeight: 1.65 }}>
          原生闹钟负责在任务到期时提醒系统；AI、网页逻辑和截图仍需应用执行环境。Android 强制停止、厂商限制或权限撤销都可能阻止后台工作，任何模式都不能保证永久存活。
        </div>
      </div>

      {!diag ? (
        <div className="menu-group">
          <div className="menu-item">
            <div className="menu-label-group">
              <span className="menu-label">原生后台接口不可用</span>
              <span className="menu-desc">请在 Android WebView 壳中使用新版 APK；浏览器/PWA 不支持本机闹钟。</span>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="settings-menu-section-title">运行模式</div>
          <div className="menu-group">
            <div className="menu-item">
              <div className="menu-icon"><BatteryCharging size={17} /></div>
              <div className="menu-label-group">
                <span className="menu-label">后台增强模式</span>
                <span className="menu-desc">启用原生一次性唤醒提醒与开机恢复；不会自动申请电池豁免。推荐开启。</span>
              </div>
              <Toggle checked={diag.mode === "enhanced"} onChange={setMode} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group">
                <span className="menu-label">智能省电模式</span>
                <span className="menu-desc">仅使用网页前后台调度；不注册原生到期闹钟，耗电与权限要求最低。</span>
              </div>
              <Status ok={diag.mode === "smart"} />
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">极致后台模式</span>
                <span className="menu-desc">暂不提供虚假常驻服务或无限唤醒锁。只有出现明确、合规的持续任务时才考虑增加前台服务。</span>
              </div>
              <Status ok={false} />
            </div>
          </div>

          <div className="settings-menu-section-title">系统状态</div>
          <div className="menu-group">
            <div className="menu-item">
              <div className="menu-icon"><Bell size={17} /></div>
              <div className="menu-label-group"><span className="menu-label">通知权限</span><span className="menu-desc">后台任务到期提醒依赖通知权限</span></div>
              <Status ok={diag.notificationsEnabled} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">电池优化豁免</span><span className="menu-desc">系统可能延迟后台闹钟；豁免不是永久保活保证</span></div>
              <Status ok={diag.batteryOptimizationIgnored} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">悬浮窗权限</span><span className="menu-desc">查岗确认浮层及部分原生浮窗功能需要</span></div>
              <Status ok={diag.overlayGranted} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">无障碍服务</span><span className="menu-desc">查岗截图依赖现有无障碍截图链路</span></div>
              <Status ok={diag.accessibilityEnabled} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">精确闹钟权限</span><span className="menu-desc">增强模式使用非精确闹钟，不申请该权限</span></div>
              <Status ok={true} />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">厂商自启动权限</span><span className="menu-desc">{diag.manufacturer || "当前设备"}：{vendorHint}</span></div>
              <Status ok={false} unknown />
            </div>
            <div className="menu-item">
              <div className="menu-label-group"><span className="menu-label">设备信息</span><span className="menu-desc">{diag.manufacturer} {diag.model} · Android API {diag.sdk}</span></div>
              <button type="button" className="ui-btn ui-btn-outline" onClick={refresh}><RefreshCw size={15} /></button>
            </div>
          </div>

          <div className="settings-menu-section-title">权限快捷入口</div>
          <div className="menu-group">
            {[
              ["battery", "电池优化设置", "查看系统电池限制"],
              ["notifications", "通知权限", "允许后台任务提醒"],
              ["overlay", "悬浮窗权限", "允许查岗确认浮层"],
              ["accessibility", "无障碍设置", "保持查岗截图能力可用"],
              ["autostart", "自启动 / 应用管理", "打开应用信息；厂商自启动需手动设置"],
            ].map(([kind, label, desc]) => (
              <button type="button" className="menu-item" key={kind} onClick={() => openSetting(kind)} style={{ width: "100%", textAlign: "left" }}>
                <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc">{desc}</span></div>
                <ExternalLink size={15} />
              </button>
            ))}
          </div>
        </>
      )}

      <div className="settings-menu-section-title">后台任务兼容性说明</div>
      <div className="menu-group">
        {[
          ["主动查岗", "原生一次性闹钟可在 WebView 暂停时留下到期提醒；AI 判断和截图仍由现有 JS / 无障碍链路完成，不会静默截屏。"],
          ["离线推送", "继续使用现有 PushService 前台服务与开机恢复逻辑；需要通知权限、网络和服务端推送链路。"],
          ["现实桥本机事件", "充电、电量等已接入的原生事件可脱离 WebView 记录并按已同步的本机规则处理；网页定时规则仍需 WebView 运行。"],
          ["生活系统主动日程", "云端已托管的日程/任务可继续在服务端推进；最新地点、场景和本地状态同步仍依赖应用联网。"],
          ["桌面小组件自动生成", "生成内容需要 WebView、模型接口和本地数据；恢复应用后会补推当前内容，不能承诺进程死亡时继续生成。"],
          ["自动云备份 / 媒体维护", "目前由网页调度器执行；应用恢复时补查是否到期，系统冻结期间不保证执行。"],
        ].map(([label, desc]) => (
          <div className="menu-item" key={label} style={{ cursor: "default", alignItems: "flex-start" }}>
            <div className="menu-icon"><Activity size={16} /></div>
            <div className="menu-label-group"><span className="menu-label">{label}</span><span className="menu-desc" style={{ lineHeight: 1.55 }}>{desc}</span></div>
          </div>
        ))}
      </div>
    </div>
  );
}
