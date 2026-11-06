"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Clipboard, RotateCcw, Save, Smartphone, Wrench, XCircle } from "lucide-react";
import {
  DEFAULT_DEVICE_COMPATIBILITY_SETTINGS,
  DEVICE_COMPATIBILITY_UPDATED_EVENT,
  loadDeviceCompatibilitySettings,
  readDeviceRuntimeMetrics,
  resetDeviceCompatibilitySettings,
  saveDeviceCompatibilitySettings,
  type CompatibilityFeature,
  type DeviceCompatibilitySettings,
} from "@/lib/device-compatibility";

type NativeApi = {
  notify?: (...args: unknown[]) => unknown;
  startCallOverlay?: (...args: unknown[]) => unknown;
  setTorch?: (...args: unknown[]) => unknown;
  setVolume?: (...args: unknown[]) => unknown;
  setBrightness?: (...args: unknown[]) => unknown;
  openApp?: (...args: unknown[]) => unknown;
  setAlarm?: (...args: unknown[]) => unknown;
  setTimer?: (...args: unknown[]) => unknown;
  getDeviceActionCapabilities?: () => string;
  getPerceptionSnapshot?: (...args: unknown[]) => unknown;
  getPerceptionCapabilities?: () => string;
  getLocationCapabilities?: () => string;
  getHealthCapabilities?: () => string;
  readUsageStats?: (...args: unknown[]) => unknown;
  readCalendarEvents?: (...args: unknown[]) => unknown;
  getCalendarCapabilities?: () => string;
  captureScreenshot?: (...args: unknown[]) => unknown;
  getScreenshotCapabilities?: () => string;
  getScreenshotDiagnostics?: () => string;
  getDiagnosticsSnapshot?: () => string;
};
type WidgetApi = { update?: (...args: unknown[]) => unknown; isSupported?: () => boolean; diagnostics?: () => string };
function getNativeApi(): NativeApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { AndroidShell?: NativeApi }).AndroidShell;
}
function getWidgetApi(): WidgetApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as unknown as { PhoneWidget?: WidgetApi }).PhoneWidget;
}

const FEATURE_ROWS: Array<{
  id: CompatibilityFeature;
  title: string;
  description: string;
  supported: (native: NativeApi | undefined) => boolean;
  probeKeys?: string[];
}> = [
  { id: "notifications", title: "网页即时系统通知", description: "网页仍在运行时通过原生桥发通知；关闭后退回浏览器/站内通知，不影响 APK 被杀后的原生离线推送。", supported: (api) => typeof api?.notify === "function", probeKeys: [] },
  { id: "callOverlay", title: "原生浮窗接口（通话/查岗）", description: "跨应用显示通话小窗与相关浮层；需要新版 APK、悬浮窗权限与系统允许。", supported: (api) => typeof api?.startCallOverlay === "function", probeKeys: [] },
  { id: "deviceActions", title: "设备操作接口", description: "手电筒、音量、亮度、闹钟、打开应用等；每个动作仍可能需要独立权限。", supported: (api) => typeof api?.getDeviceActionCapabilities === "function" || typeof api?.setTorch === "function" || typeof api?.setVolume === "function" || typeof api?.setBrightness === "function" || typeof api?.openApp === "function" || typeof api?.setAlarm === "function" || typeof api?.setTimer === "function", probeKeys: ["deviceActions"] },
  { id: "perception", title: "设备感知接口", description: "电量、网络、应用使用情况、定位和健康等读取能力。", supported: (api) => typeof api?.getPerceptionCapabilities === "function" || typeof api?.getPerceptionSnapshot === "function" || typeof api?.getLocationCapabilities === "function" || typeof api?.getHealthCapabilities === "function" || typeof api?.readUsageStats === "function", probeKeys: ["perception", "location", "health"] },
  { id: "calendar", title: "系统日历接口", description: "读取或写入 Android 系统日历；读写权限独立。", supported: (api) => typeof api?.readCalendarEvents === "function", probeKeys: ["systemCalendar"] },
  { id: "screenshot", title: "屏幕捕获接口", description: "控制网页发起原生截屏；查岗浮层还会受「原生浮窗接口」开关、无障碍和临时截屏授权影响。", supported: (api) => typeof api?.captureScreenshot === "function", probeKeys: ["screenshot", "screenshotDiagnostics"] },
  { id: "widgets", title: "桌面小组件接口", description: "把网页模板交给 APK 原生小组件渲染；需要支持该能力的 APK。", supported: () => typeof getWidgetApi()?.update === "function", probeKeys: ["widgets"] },
];

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--border, rgba(128,128,128,.18))",
  borderRadius: 16,
  padding: 14,
  display: "grid",
  gap: 12,
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: "10px 11px",
  borderRadius: 10,
  border: "1px solid var(--border, rgba(128,128,128,.22))",
  background: "var(--surface-secondary, rgba(128,128,128,.06))",
  color: "inherit",
  font: "inherit",
};
const buttonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  minHeight: 40,
  padding: "9px 12px",
  borderRadius: 10,
  border: "1px solid var(--border, rgba(128,128,128,.22))",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 12,
  cursor: "pointer",
};

export function DeviceCompatibilitySettings({ onNotice }: { onNotice?: (message: string) => void }) {
  const [settings, setSettings] = useState<DeviceCompatibilitySettings>(() => loadDeviceCompatibilitySettings());
  const [metrics, setMetrics] = useState(() => readDeviceRuntimeMetrics());
  const [nativeSnapshot, setNativeSnapshot] = useState<Record<string, unknown> | null>(null);
  const [apiSnapshots, setApiSnapshots] = useState<Record<string, unknown>>({});
  const [reportCopied, setReportCopied] = useState(false);

  const refresh = useCallback(() => {
    setMetrics(readDeviceRuntimeMetrics());
    const api = getNativeApi();
    try {
      const raw = api?.getDiagnosticsSnapshot?.();
      setNativeSnapshot(raw ? JSON.parse(raw) as Record<string, unknown> : null);
    } catch {
      setNativeSnapshot(null);
    }
    const snapshots: Record<string, unknown> = {};
    const readers: Array<[string, (() => string) | undefined]> = [
      ["deviceActions", api?.getDeviceActionCapabilities ? () => api.getDeviceActionCapabilities!() : undefined],
      ["perception", api?.getPerceptionCapabilities ? () => api.getPerceptionCapabilities!() : undefined],
      ["location", api?.getLocationCapabilities ? () => api.getLocationCapabilities!() : undefined],
      ["health", api?.getHealthCapabilities ? () => api.getHealthCapabilities!() : undefined],
      ["systemCalendar", api?.getCalendarCapabilities ? () => api.getCalendarCapabilities!() : undefined],
      ["screenshot", api?.getScreenshotCapabilities ? () => api.getScreenshotCapabilities!() : undefined],
      ["screenshotDiagnostics", api?.getScreenshotDiagnostics ? () => api.getScreenshotDiagnostics!() : undefined],
    ];
    for (const [key, read] of readers) {
      if (!read) continue;
      try {
        const raw = read();
        snapshots[key] = raw ? JSON.parse(raw) as unknown : { available: false };
      } catch {
        snapshots[key] = { readError: true };
      }
    }
    try {
      const raw = getWidgetApi()?.diagnostics?.();
      if (raw) snapshots.widgets = JSON.parse(raw) as unknown;
    } catch {
      snapshots.widgets = { readError: true };
    }
    setApiSnapshots(snapshots);
  }, []);

  useEffect(() => {
    refresh();
    const update = () => {
      setSettings(loadDeviceCompatibilitySettings());
      refresh();
    };
    window.addEventListener("resize", refresh);
    window.addEventListener("orientationchange", refresh);
    window.addEventListener(DEVICE_COMPATIBILITY_UPDATED_EVENT, update);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("orientationchange", refresh);
      window.removeEventListener(DEVICE_COMPATIBILITY_UPDATED_EVENT, update);
    };
  }, [refresh]);

  const native = getNativeApi();
  const report = useMemo(() => {
    const lines = [
      "小手机设备兼容性报告",
      "生成时间：" + new Date().toLocaleString(),
      "系统报告屏幕尺寸（CSS px）：" + metrics.screenWidth + " × " + metrics.screenHeight,
      "当前布局视口：" + metrics.viewportWidth + " × " + metrics.viewportHeight,
      "可视视口：" + metrics.visualWidth + " × " + metrics.visualHeight,
      "设备像素比 DPR：" + metrics.dpr,
      "方向：" + metrics.orientation,
      "UA：" + metrics.userAgent,
      "原生设备：" + (nativeSnapshot ? JSON.stringify({
        manufacturer: nativeSnapshot.manufacturer,
        model: nativeSnapshot.model,
        androidVersion: nativeSnapshot.androidVersion,
        sdkInt: nativeSnapshot.sdkInt,
        webViewPackage: nativeSnapshot.webViewPackage,
        webViewVersion: nativeSnapshot.webViewVersion,
        appVersion: nativeSnapshot.appVersion,
      }) : "未检测到原生诊断信息"),
      "",
      "接口能力：",
      ...FEATURE_ROWS.map((row) => {
        const supported = row.supported(native);
        const enabled = !settings.disabledFeatures.includes(row.id);
        return (enabled ? "[已启用]" : "[手动停用]") + (supported ? "[接口存在] " : "[接口缺失] ") + row.title;
      }),
      "",
      "原生能力快照：" + JSON.stringify(apiSnapshots),
      "适配配置：" + JSON.stringify(settings),
      "注意：报告仅在本机生成，不会自动上传。分享前请检查设备信息。",
    ];
    return lines.join("\n");
  }, [metrics, nativeSnapshot, apiSnapshots, native, settings]);

  const update = <K extends keyof DeviceCompatibilitySettings>(key: K, value: DeviceCompatibilitySettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };
  const toggleFeature = (id: CompatibilityFeature, enabled: boolean) => {
    setSettings((current) => ({
      ...current,
      disabledFeatures: enabled
        ? current.disabledFeatures.filter((item) => item !== id)
        : [...new Set([...current.disabledFeatures, id])],
    }));
  };
  const save = () => {
    saveDeviceCompatibilitySettings(settings);
    onNotice?.("兼容性设置已保存并立即应用。");
    refresh();
  };
  const reset = () => {
    resetDeviceCompatibilitySettings();
    setSettings({ ...DEFAULT_DEVICE_COMPATIBILITY_SETTINGS, disabledFeatures: [] });
    onNotice?.("已恢复自动适配；不会清除应用数据。");
    refresh();
  };
  const copyReport = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setReportCopied(true);
      onNotice?.("兼容性报告已复制；发送前请检查设备信息。");
    } catch {
      onNotice?.("无法自动复制，请长按下方报告文本手动复制。");
    }
  };

  return <div style={{ display: "grid", gap: 14, padding: "4px 0 24px" }}>
    <section style={panelStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Smartphone size={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong style={{ display: "block", fontSize: 16 }}>设备兼容性与适配</strong>
          <div style={{ fontSize: 12, opacity: .7, marginTop: 4 }}>优先自动适配。手动设置只保存在当前设备/浏览器，不会上传。</div>
        </div>
        <button type="button" onClick={refresh} style={buttonStyle} aria-label="刷新设备信息"><Activity size={16} />刷新</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(135px, 1fr))", gap: 8 }}>
        {[
          ["系统屏幕尺寸", metrics.screenWidth + " × " + metrics.screenHeight],
          ["当前视口", metrics.viewportWidth + " × " + metrics.viewportHeight],
          ["可视区域", metrics.visualWidth + " × " + metrics.visualHeight],
          ["DPR / 方向", metrics.dpr + " · " + (metrics.orientation === "portrait" ? "竖屏" : "横屏")],
        ].map(([label, value]) => <div key={label} style={{ padding: 10, borderRadius: 11, background: "var(--surface-secondary, rgba(128,128,128,.07))", minWidth: 0 }}>
          <div style={{ fontSize: 11, opacity: .65 }}>{label}</div>
          <strong style={{ display: "block", fontSize: 14, marginTop: 4, overflowWrap: "anywhere" }}>{value}</strong>
        </div>)}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.65, opacity: .8 }}>
        {nativeSnapshot
          ? "已读取原生设备信息：" + [nativeSnapshot.manufacturer, nativeSnapshot.model, nativeSnapshot.androidVersion ? "Android " + String(nativeSnapshot.androidVersion) : ""].filter(Boolean).join(" · ")
          : "未读取到 Android 原生设备信息。网页/PWA 只能获取有限的屏幕和浏览器数据；APK 需要提供相应原生桥接口。"}
      </div>
    </section>

    <section style={panelStyle}>
      <div><strong style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}><Wrench size={17} />屏幕布局调整</strong>
        <p style={{ fontSize: 12, lineHeight: 1.6, opacity: .72, margin: "6px 0 0" }}>自动模式使用当前设备的可用视口。手动模式可输入参考分辨率，适合遇到边缘裁切、内容过大或比例不一致时试调。系统报告值通常是逻辑像素；若填物理分辨率，请选择物理像素并由 DPR 自动换算。它不会改变 Android 系统真实分辨率。顶部状态栏错位时，可在「桌面 → 主题 → 状态栏」调整顶部偏移和状态栏占位上移。</p>
      </div>
      <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, fontSize: 13 }}>
        <span>布局模式</span>
        <select value={settings.layoutMode} onChange={(event) => update("layoutMode", event.target.value as DeviceCompatibilitySettings["layoutMode"])} style={{ ...inputStyle, width: "auto", maxWidth: "58%" }}>
          <option value="auto">自动适配（推荐）</option>
          <option value="manual">手动参考宽高</option>
        </select>
      </label>
      {settings.layoutMode === "manual" && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>屏幕宽度<input type="number" min={100} max={10000} inputMode="numeric" value={settings.screenWidth || ""} onChange={(event) => update("screenWidth", Number(event.target.value) || 0)} placeholder="例如 1080" style={inputStyle} /></label>
          <label style={{ display: "grid", gap: 6, fontSize: 12 }}>屏幕高度<input type="number" min={200} max={20000} inputMode="numeric" value={settings.screenHeight || ""} onChange={(event) => update("screenHeight", Number(event.target.value) || 0)} placeholder="例如 2400" style={inputStyle} /></label>
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 12 }}>输入单位
          <select value={settings.screenUnit} onChange={(event) => update("screenUnit", event.target.value as DeviceCompatibilitySettings["screenUnit"])} style={inputStyle}>
            <option value="css">逻辑像素（CSS px）</option>
            <option value="physical">物理分辨率（会按 DPR 自动换算）</option>
          </select>
        </label>
        <button type="button" style={buttonStyle} onClick={() => {
          setSettings((current) => ({ ...current, layoutMode: "manual", screenWidth: metrics.screenWidth, screenHeight: metrics.screenHeight, screenUnit: "css" }));
        }}>填入当前逻辑屏幕尺寸</button>
      </>}
      <label style={{ display: "grid", gap: 8, fontSize: 12 }}>
        <span style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><span>整体适配缩放</span><strong>{Math.round(settings.uiScale * 100)}%</strong></span>
        <input type="range" min="0.75" max="1.25" step="0.01" value={settings.uiScale} onChange={(event) => update("uiScale", Number(event.target.value))} />
        <span style={{ opacity: .65 }}>若界面普遍偏大或偏小，先试 95% / 105%；如无异常，保持 100%。</span>
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={{ ...buttonStyle, background: "var(--accent, rgba(128,128,128,.12))" }} onClick={save}><Save size={15} />保存并应用</button>
        <button type="button" style={buttonStyle} onClick={reset}><RotateCcw size={15} />恢复自动适配</button>
      </div>
      <div style={{ fontSize: 11, opacity: .65, lineHeight: 1.6 }}>提示：若手动设置后出现更严重的裁切，点击「恢复自动适配」即可。这里调整的是网页布局，不会修改系统显示分辨率、字体大小或权限。</div>
    </section>

    <section style={panelStyle}>
      <div><strong style={{ fontSize: 14 }}>原生接口兼容性与模块开关</strong><p style={{ fontSize: 12, lineHeight: 1.6, opacity: .72, margin: "6px 0 0" }}>逐项检测当前 APK 是否提供对应接口。可停用不稳定模块；打开开关只代表允许使用，不会自动授予系统权限，也不能给旧 APK 补出缺失接口。</p></div>
      <div style={{ display: "grid", gap: 9 }}>
        {FEATURE_ROWS.map((row) => {
          const supported = row.supported(native);
          const enabled = !settings.disabledFeatures.includes(row.id);
          const probeFailed = Boolean(row.probeKeys?.some(key => (apiSnapshots[key] as { readError?: boolean } | undefined)?.readError) || nativeSnapshot?.diagnosticsError);
          return <article key={row.id} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 12, alignItems: "start", padding: 11, borderRadius: 12, border: "1px solid var(--border, rgba(128,128,128,.16))" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <strong style={{ fontSize: 13 }}>{row.title}</strong>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, color: supported && !probeFailed ? "#16a34a" : "#d97706" }}>{supported && !probeFailed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{supported ? (probeFailed ? "接口存在但调用失败" : "检测到接口") : "未检测到接口"}</span>
              </div>
              <p style={{ fontSize: 11, lineHeight: 1.55, opacity: .72, margin: "5px 0 0" }}>{row.description}</p>
              {!supported && <p style={{ fontSize: 11, lineHeight: 1.5, color: "#d97706", margin: "4px 0 0" }}>此能力在当前环境可能不可用；请检查 APK 版本、系统权限或改用浏览器替代功能。</p>}
              {supported && probeFailed && <p style={{ fontSize: 11, lineHeight: 1.5, color: "#d97706", margin: "4px 0 0" }}>接口存在，但实际读取失败（可能是原生桥 Java exception、权限或服务未启动）。请查看下方原始快照。</p>}
              {!supported && row.id === "notifications" && typeof window !== "undefined" && "Notification" in window && <p style={{ fontSize: 11, lineHeight: 1.5, opacity: .72, margin: "4px 0 0" }}>未检测到 AndroidShell.notify；当前浏览器有 Notification API，可尝试使用浏览器通知作为替代。</p>}
              {supported && row.id === "notifications" && (nativeSnapshot?.permissions as Record<string, unknown> | undefined)?.notifications === false && <p style={{ fontSize: 11, lineHeight: 1.5, color: "#d97706", margin: "4px 0 0" }}>接口存在，但系统通知权限未开启；请到 Android 应用设置中允许通知。</p>}
              {supported && row.id === "callOverlay" && (nativeSnapshot?.permissions as Record<string, unknown> | undefined)?.overlay === false && <p style={{ fontSize: 11, lineHeight: 1.5, color: "#d97706", margin: "4px 0 0" }}>接口存在，但悬浮窗权限未开启；请到 Android 特殊权限设置中允许显示在其他应用上层。</p>}
              {supported && row.id === "perception" && (nativeSnapshot?.permissions as Record<string, unknown> | undefined)?.usageAccess === false && <p style={{ fontSize: 11, lineHeight: 1.5, color: "#d97706", margin: "4px 0 0" }}>接口存在，但应用使用情况访问权限未开启；部分感知数据会不可用。</p>}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, whiteSpace: "nowrap" }}>
              <input type="checkbox" checked={enabled} onChange={(event) => toggleFeature(row.id, event.target.checked)} />
              {enabled ? "启用" : "停用"}
            </label>
          </article>;
        })}
      </div>
      <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={save}><Save size={15} />保存接口开关</button>
    </section>

    <section style={panelStyle}>
      <div><strong style={{ fontSize: 14 }}>导出兼容性报告</strong><p style={{ fontSize: 12, opacity: .7, lineHeight: 1.6, margin: "5px 0 0" }}>报告包括屏幕尺寸、DPR、浏览器/WebView 版本与接口存在性，不包含聊天内容、角色记忆或截图。</p></div>
      <button type="button" style={{ ...buttonStyle, justifySelf: "start" }} onClick={copyReport}><Clipboard size={15} />{reportCopied ? "已复制报告" : "复制报告"}</button>
      {Object.keys(apiSnapshots).length > 0 && <details style={{ fontSize: 12 }}>
        <summary style={{ cursor: "pointer", padding: "6px 0" }}>展开原生接口能力快照（只读检测）</summary>
        <pre style={{ marginTop: 8, padding: 10, borderRadius: 10, overflowX: "auto", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--surface-secondary, rgba(128,128,128,.06))", fontSize: 10, lineHeight: 1.5 }}>{JSON.stringify(apiSnapshots, null, 2)}</pre>
      </details>}
      <textarea readOnly value={report} aria-label="兼容性诊断报告" style={{ ...inputStyle, minHeight: 190, resize: "vertical", fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap" }} />
    </section>
  </div>;
}
