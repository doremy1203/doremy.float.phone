"use client";

// 截屏设置面板：总开关 + 无障碍引导 + 测试截屏 + 最近记录回查。
//
// 设计要点（这是全项目**最敏感**的一项能力，比设备动作更需要用户掌控）：
//  · 它读到的是你**整个屏幕**——银行余额、私聊、密码框都可能在画面里。
//    所以默认关，且界面上必须把这句话说在前面，不能藏在说明里。
//  · 状态分三层显示：系统支不支持 / 无障碍开没开 / 你开了没。
//    卡在哪一环要一眼可见——「不支持」和「没授权」是两回事。
//  · 最近记录可回查：让用户能亲眼看到「它到底截了什么」，
//    而不是只能凭信任。这也是记录列表存在的全部理由。
//
// 挂载方式与 PerceptionSettings / SystemCalendarSettings 一致：
// 直接渲染内容，不套 PageShell、不收 onBack。

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { Camera, CircleDot, Loader2, ShieldCheck, Smartphone, Trash2 } from "lucide-react";

import { Toggle } from "@/components/ui/form";
import { loadCharacters } from "@/lib/character-storage";
import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { isShellEnvironment as isShell, openAccessibilitySettings } from "@/lib/shell-call-overlay";
import {
  captureAndStoreScreenshot,
  clearAllScreenshots,
  removeScreenshotRecord,
  flushPendingUserShot,
  hasScreenshotBallBridge,
  hasScreenshotBridge,
  loadScreenshotConfig,
  loadScreenshotRecords,
  prepareScreenshotBall,
  readBallHasImage,
  readScreenshotCapabilities,
  saveScreenshotConfig,
  setScreenshotBallStyle,
  stopScreenshotBall,
  supportsBallStyle,
  syncScreenshotShareTargets,
  type ScreenshotConfig,
  type ScreenshotRecord,
} from "@/lib/screenshot";
import { CheckInSettings } from "./checkin-settings";
import { CheckInThemeSettings } from "./checkin-theme-settings";
import { ScreenshotDiagnosticsPanel } from "./diagnostics-panel";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 透明度百分比（10~100）→ 两位十六进制。原生球色是 #AARRGGBB，alpha 在最前两位。 */
function alphaFromPercent(percent: number): string {
    const clamped = Math.max(0, Math.min(100, percent));
    return Math.round((clamped / 100) * 255).toString(16).padStart(2, "0").toUpperCase();
}

/**
 * Android 的 #AARRGGBB → CSS 的 rgba()。
 *
 * 必须转：色板存的是原生格式（透明度在最前两位），而 CSS 认的是 #RRGGBBAA。
 * 直接当 background 用，颜色和透明度会一起错位——「蓝」#E65B7CFA 会被
 * 浏览器读成 R=E6/G=5B/B=7C/A=FA，画出来是个暗红点（用户实报）。
 */
function toCssColor(argb: string): string {
  const hex = argb.replace(/^#/, "");
  if (hex.length !== 8) return argb;
  const a = parseInt(hex.slice(0, 2), 16);
  const r = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const b = parseInt(hex.slice(6, 8), 16);
  if (![a, r, g, b].every(Number.isFinite)) return argb;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}

/** 悬浮球可选颜色（都带透明度，与原生默认值同一格式）。 */
const BALL_COLORS = [
  { label: "蓝", value: "#E65B7CFA" },
  { label: "深灰", value: "#E633333D" },
  { label: "绿", value: "#E634C759" },
  { label: "橙", value: "#E6FF9F0A" },
  { label: "红", value: "#E6FF453A" },
  { label: "粉", value: "#E6FF6B9D" },
] as const;

function formatTime(at: number): string {
  try {
    const d = new Date(at);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return "";
  }
}

export function ScreenshotSettings({ onNotice }: { onNotice?: (msg: string) => void }) {
  const [config, setConfig] = useState<ScreenshotConfig>(() => loadScreenshotConfig());
  const [caps, setCaps] = useState(() => readScreenshotCapabilities());
  const [records, setRecords] = useState<ScreenshotRecord[]>(() => loadScreenshotRecords());
  const [busy, setBusy] = useState(false);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // 球外观的自定义输入。色号与透明度分开持有：改透明度不该让用户重填色号。
  const [colorInput, setColorInput] = useState(() => {
    const hex = loadScreenshotConfig().ballColor.replace(/^#/, "");
    return `#${hex.slice(-6).toUpperCase()}`;
  });
  const [alphaPercent, setAlphaPercent] = useState(() => {
    const hex = loadScreenshotConfig().ballColor.replace(/^#/, "");
    return hex.length === 8 ? Math.round((parseInt(hex.slice(0, 2), 16) / 255) * 100) : 90;
  });
  const [ballHasImage, setBallHasImage] = useState(() => readBallHasImage());
  const imageInputRef = useRef<HTMLInputElement | null>(null);

  // 直径用「草稿字符串」而不是直接绑 config：
  // 直接绑的话每敲一个字符都会走一次 32~96 的夹取，想输 45 时敲下 4 的瞬间
  // 就被夹成 32，后面的 5 接不上去——表现就是「说能输入，其实根本写不了」。
  const [diameterInput, setDiameterInput] = useState(() => String(loadScreenshotConfig().ballDiameter));

  const refresh = useCallback(() => {
    setConfig(loadScreenshotConfig());
    setCaps(readScreenshotCapabilities());
    setRecords(loadScreenshotRecords());
  }, []);

  // 无障碍与系统权限都是「去系统设置改完、回来才变」的，切回前台时刷一次
  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener("screenshot-config-changed", onChange);
    window.addEventListener("screenshot-records-changed", onChange);
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("screenshot-config-changed", onChange);
      window.removeEventListener("screenshot-records-changed", onChange);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // 缩略图：媒体库里存的是 Blob，这里换成 object URL 显示。
  // 记录变化或卸载时逐个撤销，否则每刷新一次就泄漏一批。
  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];
    void (async () => {
      const next: Record<string, string> = {};
      for (const item of records) {
        const url = await loadMediaObjectUrl(item.ref);
        if (!url) continue;
        urls.push(url);
        next[item.id] = url;
      }
      if (cancelled) {
        urls.forEach((u) => URL.revokeObjectURL(u));
        return;
      }
      setThumbs(next);
    })();
    return () => {
      cancelled = true;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [records]);

  // 角色清单：给「默认接收角色」那一栏用。跟着 config 一起刷新，
  // 这样用户刚在别处加了角色、回到这一页就能看到。
  const characters = useMemo(() => {
    try {
      return loadCharacters().filter(item => !!item.id && !!item.name?.trim());
    } catch {
      return [];
    }
  }, [config]);

  const inShell = useMemo(() => isShell(), []);
  const bridgeOk = useMemo(() => hasScreenshotBridge(), []);
  const supported = caps.supported === true;
  const accessibilityOn = caps.accessibilityOn === true;
  const ready = supported && accessibilityOn && bridgeOk;

  const update = useCallback((patch: Partial<ScreenshotConfig>) => {
    const next = { ...loadScreenshotConfig(), ...patch };
    saveScreenshotConfig(next);
    setConfig(next);
  }, []);

  const toggleEnabled = useCallback((on: boolean) => {
    update({ enabled: on });
    if (!on) return;
    if (!bridgeOk) {
      onNotice?.("当前 App 版本不支持截屏，需要更新安卓壳");
      return;
    }
    if (!supported) {
      onNotice?.("系统版本太低，截屏需要 Android 11 及以上");
      return;
    }
    if (!accessibilityOn) {
      onNotice?.("还需要开启无障碍服务，截屏才能真正工作");
    }
  }, [update, onNotice, bridgeOk, supported, accessibilityOn]);

  const doTest = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      // silent：用户正盯着这个页面看结果，再弹一条系统通知纯属打扰
      const result = await captureAndStoreScreenshot({ silent: true });
      if (result.ok) {
        onNotice?.(`截到了 ${result.record.width}×${result.record.height}（${formatBytes(result.record.bytes)}）`);
        refresh();
      } else {
        onNotice?.(result.reason);
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onNotice, refresh]);

  const doClear = useCallback(async () => {
    await clearAllScreenshots();
    setThumbs({});
    refresh();
    onNotice?.("已清空全部截屏记录");
  }, [onNotice, refresh]);

  /** 删单张：连同媒体库里的图一起删，不留下无人引用的图片占存储。 */
  const doDeleteOne = useCallback(async (id: string) => {
    await removeScreenshotRecord(id);
    refresh();
    onNotice?.("已删除这张截屏");
  }, [onNotice, refresh]);

  /**
   * 开关桌面悬浮球。
   *
   * 开启时必须**当场**把服务拉起来：Android 12+ 只允许 App 在前台时启动
   * 前台服务，而用户点这个开关的那一刻正是唯一合法的时机。
   */
  const toggleBall = useCallback((on: boolean) => {
    update({ ballEnabled: on });
    if (!on) {
      stopScreenshotBall();
      return;
    }
    if (!inShell || !hasScreenshotBallBridge()) {
      onNotice?.("当前 App 版本还不支持悬浮球，需要更新安卓壳");
      return;
    }
    if (!ready) {
      onNotice?.("先把上面的截屏与无障碍打开，悬浮球才有意义");
      return;
    }
    if (!prepareScreenshotBall()) {
      onNotice?.("没能拉起悬浮球，请先授予「显示在其他应用上层」权限");
      return;
    }
    // 开启的那一刻顺手把收件人清单推给原生：点球时网页多半已经不在，
    // 浮层只能读之前存下的那份。
    syncScreenshotShareTargets();
    onNotice?.("悬浮球已开启。轻点它截屏，拖到边缘会自动吸附");
  }, [update, inShell, ready, onNotice]);

  /**
   * 改「默认接收角色」。
   *
   * 每改一次就重推清单：原生那份是浮层真正读的，改完不推等于没改。
   */
  const setDefaultShareTarget = useCallback((characterId: string) => {
    update({ defaultShareCharacterId: characterId });
    // 等 update 落盘后再推（saveScreenshotConfig 是同步写 KV 的，这里安全）
    const synced = syncScreenshotShareTargets();
    if (characterId && !synced) {
      onNotice?.("当前 App 版本还不支持指定收件人，需要更新安卓壳");
      return;
    }
    const name = characters.find(item => item.id === characterId)?.name;
    onNotice?.(name
      ? `之后点悬浮球截屏会直接发给${name}，不再弹选择`
      : "已改为每次截屏都让你选发给谁");
  }, [update, characters, onNotice]);

  /**
   * 改悬浮球外观并即时下发。
   *
   * 本地存一份（下次打开设置页回显），同时推给原生——球是原生画的，
   * 只存在网页这一侧改了也看不见。球正显示着时原生会当场重画。
   *
   * 老壳没有这个接口时静默跳过：本地配置仍然存着，等壳更新后自然生效。
   */
  const updateBallStyle = useCallback((
    patch: Partial<Pick<ScreenshotConfig, "ballText" | "ballColor" | "ballDiameter">>,
    image?: string,
  ) => {
    const next = { ...loadScreenshotConfig(), ...patch };
    saveScreenshotConfig(next);
    setConfig(next);
    if (!supportsBallStyle()) return;
    setScreenshotBallStyle({
      text: next.ballText,
      color: next.ballColor,
      diameter: next.ballDiameter,
      // 只有显式传了 image 才带上：undefined 表示「这次不动图片」，
      // 否则改个颜色就会把用户上传的图弄丢。
      ...(image !== undefined ? { image } : {}),
    });
  }, []);

  /**
   * 读用户选的图片 → 压到 512px 以内 → 下发原生当球面。
   *
   * 压尺寸的原因：球最大也就 96dp（约两三百像素），原图动辄几 MB，
   * 过 JS 桥又慢又可能撑爆 Binder 传输；512 足够清晰、通常只有几十 KB。
   */
  const handleImagePick = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 先清掉 input 的值，否则连续选同一张图不会再次触发 onChange
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onNotice?.("请选一张图片");
      return;
    }
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("read_failed"));
        reader.readAsDataURL(file);
      });
      if (!dataUrl) throw new Error("empty");

      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error("decode_failed"));
        img.src = dataUrl;
      });

      const MAX = 512;
      const ratio = Math.min(1, MAX / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * ratio));
      const height = Math.max(1, Math.round(image.height * ratio));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no_ctx");
      ctx.drawImage(image, 0, 0, width, height);
      const base64 = canvas.toDataURL("image/png").split(",")[1] ?? "";
      if (!base64) throw new Error("encode_failed");

      updateBallStyle({}, base64);
      setBallHasImage(true);
      onNotice?.("已换成上传的图片当球面");
    } catch {
      onNotice?.("这张图没能读取，换一张试试");
    }
  }, [onNotice, updateBallStyle]);

  // 开启悬浮球时把外观一并下发：用户可能在上次会话里改过颜色，
  // 而原生读的是它自己那份盘上配置，两边要在这个时机对齐。
  useEffect(() => {
    if (!config.ballEnabled || !supportsBallStyle()) return;
    setScreenshotBallStyle({
      text: config.ballText,
      color: config.ballColor,
      diameter: config.ballDiameter,
    });
  }, [config.ballEnabled, config.ballText, config.ballColor, config.ballDiameter]);

  // 页面挂载时补发「点球那一刻网页已被回收」的那张截图。
  // 原生侧是「读到即清空」，所以重复调用不会重复发送。
  useEffect(() => {
    void flushPendingUserShot().catch(() => undefined);
  }, []);

  return (
    <div className="per-shell">
      <div className="per-hero">
        <div className="per-hero-head">
          <span className="per-hero-title">看一眼我的屏幕</span>
          <span className="per-state" data-tone={config.enabled && ready ? "on" : ""}>
            <i className="per-dot is-pulse" />
            {config.enabled && ready ? "可用" : "未启用"}
          </span>
        </div>

        {!inShell && (
          <div className="per-note is-warn">
            当前不在小手机 App 内（浏览器/PWA）。截屏需要安卓壳，这里只能预览界面。
          </div>
        )}
        {inShell && !bridgeOk && (
          <div className="per-note is-warn">
            当前 App 版本还没有截屏桥，请更新到最新版安卓壳后使用。
          </div>
        )}

        <div className="per-note is-warn">
          <div style={{ fontWeight: 600 }}>这一项看到的是你整个屏幕</div>
          <div style={{ marginTop: 6, lineHeight: 1.65 }}>
            截下来的画面里可能有银行余额、私聊、密码框——比调音量敏感得多，所以默认关闭，
            而且要你<b>点一下才截一张</b>。没有定时截屏、没有后台截屏、没有监听屏幕，
            图片只存在本机，不会自己上传任何地方。
          </div>
        </div>
      </div>

      <div className="page-menu" style={{ paddingBottom: 40, gap: 16 }}>
        {/* 总开关 */}
        <div>
          <div className="settings-menu-section-title">总开关</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <Camera size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">允许截屏</span>
                <span className="menu-desc">默认关闭。打开后仍然是你手动触发才会截，角色不会自己乱截</span>
              </div>
              <Toggle checked={config.enabled} onChange={toggleEnabled} />
            </div>
          </div>
        </div>

        {/* 截屏悬浮球：你自己点一下就能截 */}
        <div>
          <div className="settings-menu-section-title">截屏悬浮球</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <CircleDot size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">显示悬浮球</span>
                <span className="menu-desc">
                  {config.ballEnabled
                    ? "桌面上有个小圆点，点一下就截屏发给角色；拖到边缘会自动吸附"
                    : "桌面常驻一个小圆点，随手点一下截屏——不用先打开小手机（默认关）"}
                </span>
              </div>
              <Toggle checked={config.ballEnabled} onChange={toggleBall} />
            </div>
          </div>
          <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
            截出来的图仍然会先弹预览让你确认，你点「发给它」才发得出去——
            和角色查岗走的是同一套审批。
          </div>

          {config.ballEnabled && (
            <div className="menu-group" style={{ marginTop: 10 }}>
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">球上显示的字</span>
                  <span className="menu-desc">最多 4 个字；留空就只画一个圆点，不写字</span>
                </div>
                <input
                  className="per-field-input"
                  style={{ maxWidth: 92 }}
                  value={config.ballText}
                  maxLength={4}
                  placeholder="留空"
                  onChange={e => updateBallStyle({ ballText: e.target.value.slice(0, 4) })}
                />
              </div>
              {/* 颜色：快捷色板 + 自己填色号 + 透明度。
                  只给色板满足不了「我要 #3A7BD5 的 60%」这种需求。 */}
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">颜色</span>
                  <span className="menu-desc">点色板立刻换，或自己填色号</span>
                </div>
                <div className="menu-right" style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                  {BALL_COLORS.map(item => {
                    const selected = config.ballColor.toUpperCase() === item.value.toUpperCase();
                    return (
                      <button
                        key={item.value}
                        type="button"
                        aria-label={`${item.label}色`}
                        onClick={() => {
                          updateBallStyle({ ballColor: item.value });
                          // 同步「色号」「透明度」两行：它们各自持有 state，不跟着走的话
                          // 点完色板下面还显示旧值，看着像「选的和显示的不一样」。
                          setColorInput(`#${item.value.slice(-6).toUpperCase()}`);
                          setAlphaPercent(Math.round((parseInt(item.value.slice(1, 3), 16) / 255) * 100));
                        }}
                        style={{
                          width: 30,
                          height: 30,
                          padding: 0,
                          borderRadius: 999,
                          background: toCssColor(item.value),
                          opacity: selected ? 1 : 0.45,
                          border: selected ? "2px solid var(--c-text-title)" : "1px solid rgba(0,0,0,.14)",
                          cursor: "pointer",
                        }}
                      />
                    );
                  })}
                </div>
              </div>

              {/* 色号输入：填满 6 位才下发，避免敲到一半球乱跳色。 */}
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">色号</span>
                  <span className="menu-desc">十六进制，可带 #。透明度用下面的滑条调</span>
                </div>
                <input
                  className="per-field-input"
                  style={{ maxWidth: 110, fontFamily: "ui-monospace, monospace" }}
                  value={colorInput}
                  placeholder="#5B7CFA"
                  maxLength={7}
                  spellCheck={false}
                  aria-label="悬浮球色号"
                  onChange={e => {
                    const next = e.target.value;
                    setColorInput(next);
                    // 只在填满 6 位十六进制时才下发：否则每敲一个字符都换一次色，
                    // 球会在屏幕上乱跳
                    const hex = next.replace(/^#/, "");
                    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
                      updateBallStyle({ ballColor: `#${alphaFromPercent(alphaPercent)}${hex.toUpperCase()}` });
                    }
                  }}
                />
              </div>

              {/* 透明度：与色号分开，改透明度不必重填色号。 */}
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">透明度</span>
                  <span className="menu-desc">当前 {alphaPercent}%</span>
                </div>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={alphaPercent}
                  style={{ maxWidth: 140, width: 140 }}
                  aria-label="悬浮球透明度"
                  onChange={e => {
                    const pct = Number(e.target.value);
                    setAlphaPercent(pct);
                    const rgb = config.ballColor.replace(/^#/, "").slice(-6).toUpperCase();
                    updateBallStyle({ ballColor: `#${alphaFromPercent(pct)}${rgb}` });
                  }}
                />
              </div>

              {/* 上传图片：球面直接用自己的图，不再叠字。 */}
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">自定义图片</span>
                  <span className="menu-desc">
                    {ballHasImage ? "已用上传的图片当球面" : "不设就用上面的纯色圆点"}
                  </span>
                </div>
                <div className="menu-right" style={{ display: "flex", gap: 6 }}>
                  <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    onClick={() => imageInputRef.current?.click()}
                  >
                    上传
                  </button>
                  {ballHasImage ? (
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      onClick={() => { updateBallStyle({}, ""); setBallHasImage(false); onNotice?.("已清除自定义图片"); }}
                    >
                      清除
                    </button>
                  ) : null}
                </div>
                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={e => void handleImagePick(e)}
                />
              </div>
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">大小</span>
                  <span className="menu-desc">桌面那个点多粗；字会跟着一起缩放</span>
                </div>
                {/* 直接填数值，不再给死档位：32~96 dp 之间任意整数 */}
                <input
                  className="per-field-input"
                  style={{ maxWidth: 92 }}
                  type="number"
                  inputMode="numeric"
                  min={32}
                  max={96}
                  value={diameterInput}
                  aria-label="悬浮球直径（dp）"
                  onChange={e => {
                    // 只留数字，允许中途是空串或没填完，不在打字过程中夹取
                    setDiameterInput(e.target.value.replace(/[^0-9]/g, ""));
                  }}
                  onBlur={() => {
                    const n = Number(diameterInput);
                    const safe = Number.isFinite(n) && n > 0
                      ? Math.max(32, Math.min(96, Math.round(n)))
                      : config.ballDiameter;
                    setDiameterInput(String(safe));
                    if (safe !== config.ballDiameter) updateBallStyle({ ballDiameter: safe });
                  }}
                  onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
              </div>
              {!supportsBallStyle() && (
                <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px) 10px" }}>
                  当前 App 版本还不支持自定义外观，需要更新安卓壳；设置会先存着，更新后自动生效。
                </div>
              )}
            </div>
          )}

          {config.ballEnabled && (
            <div className="menu-group" style={{ marginTop: 10 }}>
              <div className="menu-item" style={{ cursor: "default", alignItems: "flex-start" }}>
                <div className="menu-label-group">
                  <span className="menu-label">默认发给谁</span>
                  <span className="menu-desc">
                    {characters.length === 0
                      ? "还没有角色。先创建角色，再回来指定收件人。"
                      : config.defaultShareCharacterId
                        ? "点球截屏后直接发给这位，不再弹选择"
                        : "还没指定。每次点球后会在浮层里让你选一次"}
                  </span>
                </div>
              </div>
              {characters.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 6,
                    padding: "0 var(--ui-padding, 16px) 10px",
                  }}
                >
                  {characters.map(character => {
                    const selected = config.defaultShareCharacterId === character.id;
                    return (
                      <button
                        key={character.id}
                        type="button"
                        className="ui-btn ui-btn-outline"
                        style={{ opacity: selected ? 1 : 0.55, maxWidth: "46%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                        onClick={() => setDefaultShareTarget(selected ? "" : character.id)}
                      >
                        {character.name}
                      </button>
                    );
                  })}
                  {config.defaultShareCharacterId && (
                    <button
                      type="button"
                      className="ui-btn ui-btn-outline"
                      onClick={() => setDefaultShareTarget("")}
                    >
                      每次让我选
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 无障碍：截屏的真正前提 */}
        <div>
          <div className="settings-menu-section-title">无障碍服务</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <ShieldCheck size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">截屏权限来源</span>
                <span className="menu-desc">
                  {accessibilityOn
                    ? "无障碍服务已开启，截屏可以工作"
                    : "需要开启无障碍服务。截屏用的是系统给无障碍的能力，不会因此多要一个录屏授权框"}
                </span>
              </div>
              {!accessibilityOn && (
                <button
                  type="button"
                  className="ui-btn ui-btn-outline"
                  onClick={() => {
                    openAccessibilitySettings();
                    onNotice?.("在系统页面里找到「小手机」并开启无障碍，回来即可生效");
                  }}
                >
                  去开启
                </button>
              )}
            </div>
          </div>
        </div>

        {/* 反馈 */}
        <div>
          <div className="settings-menu-section-title">反馈</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">截屏后通知我</span>
                <span className="menu-desc">
                  默认开启。你不在这个页面时，截屏后系统通知栏会留一条记录，
                  免得你不知道它刚看过你的屏幕。
                </span>
              </div>
              <Toggle
                checked={config.notifyOnCapture !== false}
                onChange={(v: boolean) => update({ notifyOnCapture: v })}
              />
            </div>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-label-group">
                <span className="menu-label">保留最近 {config.keepRecent} 张</span>
                <span className="menu-desc">
                  超出后最旧的会被删掉（图片一起删除，不会悄悄占满存储）
                </span>
              </div>
              {/* 直接填数值：1~50 张之间任意整数，不再给死档位 */}
              <input
                className="per-field-input"
                style={{ maxWidth: 82 }}
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                value={config.keepRecent}
                aria-label="保留最近截屏张数"
                onChange={e => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  update({ keepRecent: Math.max(1, Math.min(50, Math.round(n))) });
                }}
              />
            </div>
          </div>
        </div>

        {/* 本机实测 */}
        <div>
          <div className="settings-menu-section-title">本机实测</div>
          <div className="menu-group" style={{ marginTop: 10 }}>
            <div className="menu-item" style={{ cursor: "default" }}>
              <div className="menu-icon" style={{ background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}>
                <Smartphone size={17} strokeWidth={1.8} />
              </div>
              <div className="menu-label-group">
                <span className="menu-label">系统支持</span>
                <span className="menu-desc">
                  {supported ? "系统版本支持截屏（Android 11+）" : "系统版本太低，截屏需要 Android 11 及以上"}
                </span>
              </div>
            </div>
          </div>
          <div className="per-actions">
            <button
              type="button"
              className="ui-btn ui-btn-outline"
              onClick={() => void doTest()}
              disabled={busy}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : "测试截屏"}
            </button>
            <button type="button" className="ui-btn ui-btn-outline" onClick={refresh} disabled={busy}>
              重新检测
            </button>
          </div>
        </div>

        {/* 最近记录：让用户能亲眼回查 */}
        <div>
          <div className="settings-menu-section-title">最近截屏</div>
          {records.length === 0 ? (
            <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
              还没有截屏记录。截过的图会出现在这里，方便你回头核对它到底看到了什么。
            </div>
          ) : (
            <div className="page-menu" style={{ gap: 10, marginTop: 10 }}>
              {records.map((item) => (
                <div className="menu-item" key={item.id} style={{ cursor: "default", alignItems: "center" }}>
                  <div
                    className="menu-icon"
                    style={{ overflow: "hidden", padding: 0, background: "color-mix(in srgb, var(--per-accent, #6f5bd6) 14%, transparent)" }}
                  >
                    {thumbs[item.id] ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={thumbs[item.id]} alt="截屏缩略图" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    ) : (
                      <Camera size={17} strokeWidth={1.8} />
                    )}
                  </div>
                  <div className="menu-label-group">
                    <span className="menu-label">{formatTime(item.at)}</span>
                    <span className="menu-desc">
                      {item.width}×{item.height} · {formatBytes(item.bytes)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="ui-btn ui-btn-outline"
                    style={{ flex: "0 0 auto", padding: "6px 10px" }}
                    aria-label="删除这张截屏"
                    onClick={() => void doDeleteOne(item.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
              <div className="per-actions">
                <button type="button" className="ui-btn ui-btn-outline" onClick={() => void doClear()}>
                  <Trash2 size={16} />
                  清空全部
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 主动查岗：每个角色单独设 */}
        <CheckInSettings onNotice={onNotice} />

        {/* 确认浮层的外观：查岗与主动截屏共用同一条浮层，故配色也共用一份 */}
        <CheckInThemeSettings />

        <div className="per-note" style={{ padding: "0 var(--ui-padding, 16px)" }}>
          角色要用截屏能力，还要单独开能力：工具箱 → 内置能力。
        </div>
      </div>
    </div>
  );
}
