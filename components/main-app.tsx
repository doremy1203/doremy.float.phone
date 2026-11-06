"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight } from "lucide-react";

import { AccountGate } from "@/components/auth/account-gate";
import { CloudBackupScheduler } from "@/components/cloud-backup-scheduler";
import { RealityBridgeScheduler } from "@/components/reality-bridge-scheduler";
import { WidgetScheduler } from "@/components/widget/widget-scheduler";
import { CheckInScheduler } from "@/components/screenshot/checkin-scheduler";
import { installLifeScheduleProactiveScheduler } from "@/lib/life/life-proactive-scheduler";
import { MediaMaintenanceScheduler } from "@/components/media-maintenance-scheduler";
import { ShellPushRegistrar } from "@/components/shell-push-registrar";
import { DesktopShell } from "./desktop-shell";
import { OfflinePushRevampAnnouncement } from "./offline-push-revamp-announcement";
import { SplashAnimation } from "./splash-animation";
import { MusicProvider } from "@/lib/music-context";
import { hydrateKvDb, isKvHydrated } from "@/lib/kv-db";
import { getThemeAssetMap, readThemeProfile } from "@/lib/theme-storage";
import { resolveActiveIconSkins, type ThemeProfile } from "@/lib/theme-types";
import { hasPendingMcpOAuthCallback } from "@/lib/tool-executor";
import { shouldRequestPwaFullscreen } from "@/lib/pwa-display-mode";
import { installPerformanceDiagnostics } from "@/lib/performance-diagnostics";

const TEXT = {
  loading: "\u52A0\u8F7D\u4E2D...",
};

const BUILTIN_FONT_URLS = [
  "/fonts/huiwen.woff2",
  "/fonts/huiwen.woff2",
  "/fonts/special-elite.woff2",
  "/fonts/splash/instrument-serif-regular-400.woff2",
  "/fonts/splash/instrument-serif-italic-400.woff2",
  "/fonts/splash/inter-300.woff2",
  "/fonts/splash/inter-400.woff2",
  "/fonts/splash/inter-500.woff2",
  "/fonts/splash/major-mono-display-400.woff2",
  "/fonts/splash/jetbrains-mono-300.woff2",
  "/fonts/splash/jetbrains-mono-400.woff2",
  "/fonts/interview/noto-serif-sc.woff2",
  "/fonts/interview/bodoni-moda.woff2",
  "/fonts/interview/bodoni-moda-italic.woff2",
  "/fonts/interview/eb-garamond.woff2",
  "/fonts/interview/eb-garamond-italic.woff2",
  "/fonts/interview/long-cang.woff2",
  "/fonts/interview/cinzel.woff2",
  "/fonts/interview/press-start-2p.woff2",
  "/fonts/notewall/ximai.woff2",
  "/fonts/notewall/xiaozhitiao.woff2",
  "/fonts/notewall/huiwen-upload.woff2",
  "/fonts/notewall/chen-yuluoyan-thin.woff2",
  "/fonts/game-hall/fredoka-400.woff2",
  "/fonts/game-hall/fredoka-500.woff2",
  "/fonts/game-hall/fredoka-600.woff2",
  "/fonts/game-hall/fredoka-700.woff2",
  "/fonts/game-hall/caveat-500.woff2",
  "/fonts/game-hall/caveat-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-500.woff2",
  "/fonts/game-hall/zen-maru-gothic-700.woff2",
  "/fonts/game-hall/zen-maru-gothic-900.woff2",
  "/fonts/\u5B57\u4F53/MISANS-REGULAR.woff2",
  "/fonts/\u5B57\u4F53/MISANS-MEDIUM.woff2",
  "/fonts/\u5B57\u4F53/MISANS-SEMIBOLD.woff2",
] as const;

const BUILTIN_FONT_LOAD_SPECS = [
  '400 1em "Instrument Serif"',
  'italic 400 1em "Instrument Serif"',
  '300 1em "Inter"',
  '400 1em "Inter"',
  '500 1em "Inter"',
  '400 1em "Major Mono Display"',
  '300 1em "JetBrains Mono"',
  '400 1em "JetBrains Mono"',
  '400 1em "Huiwen"',
  '400 1em "Noto Serif SC"',
  '400 1em "Source Han Serif SC"',
  '400 1em "Bodoni Moda"',
  'italic 400 1em "Bodoni Moda"',
  '400 1em "EB Garamond"',
  'italic 400 1em "EB Garamond"',
  '400 1em "Long Cang"',
  '400 1em "Cinzel"',
  '400 1em "Press Start 2P"',
  '400 1em "Special Elite"',
  '400 1em "NoteWall Ximai"',
  '400 1em "NoteWall Xiaozhitiao"',
  '400 1em "NoteWall Huiwen"',
  '400 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Fredoka"',
  '600 1em "Game Hall Fredoka"',
  '700 1em "Game Hall Fredoka"',
  '500 1em "Game Hall Caveat"',
  '700 1em "Game Hall Caveat"',
  '500 1em "Game Hall Zen Maru Gothic"',
  '700 1em "Game Hall Zen Maru Gothic"',
  '900 1em "Game Hall Zen Maru Gothic"',
  '400 1em "MiSans"',
  '500 1em "MiSans"',
  '600 1em "MiSans"',
] as const;

const FONT_CACHE_BATCH_SIZE = 3;
const FONT_CACHE_BATCH_DELAY_MS = 80;

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleIdleTask(callback: () => void): () => void {
  if (typeof window === "undefined") {
    return () => { };
  }

  const idleWindow = window as WindowWithIdleCallback;
  if (typeof idleWindow.requestIdleCallback === "function") {
    const handle = idleWindow.requestIdleCallback(() => callback(), { timeout: 2400 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }

  const handle = window.setTimeout(callback, 600);
  return () => window.clearTimeout(handle);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function cacheFontUrl(url: string): Promise<void> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) return;
  await response.arrayBuffer();
}

async function warmBuiltinFonts(shouldStop: () => boolean): Promise<void> {
  if (typeof window === "undefined") return;

  for (let index = 0; index < BUILTIN_FONT_URLS.length; index += FONT_CACHE_BATCH_SIZE) {
    if (shouldStop()) return;
    const batch = BUILTIN_FONT_URLS.slice(index, index + FONT_CACHE_BATCH_SIZE);
    await Promise.all(batch.map((url) => cacheFontUrl(url).catch(() => undefined)));
    if (shouldStop()) return;
    await wait(FONT_CACHE_BATCH_DELAY_MS);
  }

  if (shouldStop() || !document.fonts) return;
  await Promise.all(BUILTIN_FONT_LOAD_SPECS.map((spec) => document.fonts.load(spec).catch(() => [])));
}

function SplashScreen({ ready = false, onEnter }: { ready?: boolean; onEnter?: () => void }) {
  return (
    <main className="app-root splash-root" onClick={ready ? onEnter : undefined}>
      <section
        className="phone-shell-wrap splash-shell-wrap"
        aria-label={TEXT.loading}
      >
        <div className="phone-case">
          <div className="phone-frame">
            <div className="phone-shell splash-phone-screen">
              <SplashAnimation />
              <button
                type="button"
                className={ready ? "splash-enter-button splash-enter-button-show" : "splash-enter-button"}
                disabled={!ready}
                aria-label="Enter"
              >
                <ArrowRight size={18} strokeWidth={1.8} />
              </button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

type PreparedDesktopTheme = {
  profile: ThemeProfile;
  assets: Record<string, string>;
};

function collectFirstPaintThemeAssetIds(profile: ThemeProfile): string[] {
  const ids = [
    profile.wallpaperAssetId,
    profile.fontAssetId,
    profile.dockSkinAssetId,
    ...Object.values(resolveActiveIconSkins(profile))
  ].filter((value): value is string => Boolean(value));
  return Array.from(new Set(ids));
}

function preloadImageDataUrl(url: string): Promise<void> {
  if (typeof window === "undefined" || !url.startsWith("data:image/")) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const image = new Image();
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (typeof image.decode === "function") {
        void image.decode().catch(() => undefined).finally(resolve);
        return;
      }
      resolve();
    };
    image.onload = finish;
    image.onerror = finish;
    image.src = url;
    if (image.complete) {
      finish();
    }
  });
}

async function prepareDesktopThemeForFirstPaint(): Promise<PreparedDesktopTheme> {
  const profile = readThemeProfile();
  const assetIds = collectFirstPaintThemeAssetIds(profile);
  const assets = assetIds.length ? await getThemeAssetMap(assetIds) : {};
  await Promise.all(Object.values(assets).map(preloadImageDataUrl));
  return { profile, assets };
}

function LifeScheduleScheduler() {
  useEffect(() => installLifeScheduleProactiveScheduler(), []);
  return null;
}

export function MainApp() {
  const [preparedDesktopTheme, setPreparedDesktopTheme] = useState<PreparedDesktopTheme | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [splashDismissed, setSplashDismissed] = useState(false);
  const [kvHydrateFailed, setKvHydrateFailed] = useState(false);
  const [initAttempt, setInitAttempt] = useState(0);
  const [downloadNotice, setDownloadNotice] = useState<{ kind: "success" | "error" | "info"; message: string } | null>(null);

  useEffect(() => installPerformanceDiagnostics(), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onDownloadNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; message?: string }>).detail;
      if (!detail?.message) return;
      const kind = detail.kind === "error" || detail.kind === "info" ? detail.kind : "success";
      setDownloadNotice({ kind, message: detail.message });
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setDownloadNotice(null), kind === "error" ? 6500 : 4200);
    };
    window.addEventListener("app-global-notice", onDownloadNotice);
    return () => {
      window.removeEventListener("app-global-notice", onDownloadNotice);
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    // 申请持久化存储：批准后 iOS/安卓不会再因存储压力擅自回收 IndexedDB
    // （摊主钥匙、聊天记录等都存在里面）。静默尽力而为，被拒也无碍。
    void navigator.storage?.persist?.().catch(() => {});

    void (async () => {
      await hydrateKvDb();
      if (cancelled) return;
      // 水合失败绝不放行：此时所有 KV 数据（设置/绑定/线下记录等）在内存里都是
      // 空的，进入后任何一次保存都会拿空数据整包覆盖 IndexedDB 里的真实历史。
      if (!isKvHydrated()) {
        setKvHydrateFailed(true);
        return;
      }
      setKvHydrateFailed(false);

      let nextPreparedTheme: PreparedDesktopTheme | null = null;
      try {
        nextPreparedTheme = await prepareDesktopThemeForFirstPaint();
      } catch (error) {
        console.warn("[MainApp] desktop theme preload failed:", error);
      }

      if (cancelled) return;
      setPreparedDesktopTheme(nextPreparedTheme);
      setHydrated(true);
      if (hasPendingMcpOAuthCallback()) {
        setSplashDismissed(true);
      }
    })();

    // 网页端与移动端统一尝试浏览器全屏；只能在用户手势中请求，失败时给出明确提示。
    // 是否请求仍由「全屏/显示系统状态栏」偏好决定，切换设置后无需重载。
    let fullscreenNoticeShown = false;
    const showFullscreenNoticeOnce = (message: string) => {
      if (fullscreenNoticeShown) return;
      fullscreenNoticeShown = true;
      window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind: "info", message } }));
    };
    function tryFullscreen() {
      if (!shouldRequestPwaFullscreen()) return;
      // A document-wide fullscreen request can stall Android WebView media surfaces
      // (both local <video> and third-party iframe players). The watch app must keep
      // its own viewport stable; use the player's native fullscreen control instead.
      const watchApp = document.querySelector<HTMLElement>(".watch-together-app");
      if (watchApp && watchApp.getClientRects().length > 0) return;
      const doc = document.documentElement;
      if (document.fullscreenElement) return;
      if (typeof doc.requestFullscreen !== "function") {
        showFullscreenNoticeOnce("当前浏览器不支持网页强制全屏。普通网页仍会显示浏览器地址栏；如需更沉浸的显示，可将网站添加到主屏幕后打开。");
        return;
      }
      void doc.requestFullscreen().catch(() => {
        showFullscreenNoticeOnce("浏览器没有允许网页进入全屏。普通网页无法强行隐藏浏览器地址栏；可尝试添加到主屏幕运行。");
      });
    }
    document.addEventListener("click", tryFullscreen);
    return () => {
      cancelled = true;
      document.removeEventListener("click", tryFullscreen);
    };
  }, [initAttempt]);

  if (kvHydrateFailed) {
    return (
      <main className="app-root" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100dvh", padding: "0 28px", background: "#0c0c12", color: "#e8e8ef" }}>
        <div style={{ maxWidth: 340, textAlign: "center" }}>
          <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 12 }}>本机数据暂时读取失败</div>
          <div style={{ fontSize: 13, lineHeight: 1.8, opacity: 0.75, marginBottom: 20 }}>
            浏览器的本地数据库（IndexedDB）没能打开。数据本身还在，为了避免在读不到数据的状态下继续使用把历史记录覆盖掉，应用先暂停进入。
            <br />可以先重试；仍然不行的话，试试关掉本站的其他标签页、重启浏览器，或确认没有开无痕/隐私模式。
          </div>
          <button
            type="button"
            onClick={() => { setKvHydrateFailed(false); setInitAttempt((n) => n + 1); }}
            style={{ padding: "10px 32px", borderRadius: 20, border: "1px solid rgba(255,255,255,0.2)", background: "rgba(255,255,255,0.08)", color: "#fff", fontSize: 14, cursor: "pointer" }}
          >
            重试
          </button>
        </div>
      </main>
    );
  }

  return (
    <AccountGate>
      {!splashDismissed ? (
        <SplashScreen ready={hydrated} onEnter={() => setSplashDismissed(true)} />
      ) : (
        <main className="app-root">
          <MusicProvider>
            <DesktopShell
              initialThemeProfile={preparedDesktopTheme?.profile}
              initialThemeAssets={preparedDesktopTheme?.assets}
            />
            <OfflinePushRevampAnnouncement />
            <CloudBackupScheduler />
            <RealityBridgeScheduler />
            <WidgetScheduler />
            {/* 查岗轮询 + 主动截屏接收端。必须挂在桌面壳这种「一直在跑」的地方：
                角色查岗时用户多半正在别的 App 里，设置页根本没开着。 */}
            <CheckInScheduler />
            {/* 云端生活日程/离线主动消息调度必须挂在全局壳层，不能依赖生活页面保持打开。 */}
            <LifeScheduleScheduler />
            <MediaMaintenanceScheduler />
            {/* 壳推送订阅的兜底注册：壳原生那次失败是静默的，这里可验证地补一次 */}
            <ShellPushRegistrar />
          </MusicProvider>
          {downloadNotice && typeof document !== "undefined" && createPortal(
            <div
            role={downloadNotice.kind === "error" ? "alert" : "status"}
            aria-live={downloadNotice.kind === "error" ? "assertive" : "polite"}
            className="fixed left-1/2 z-[99999] max-w-[min(92vw,440px)] -translate-x-1/2 rounded-2xl px-4 py-3 text-sm shadow-xl backdrop-blur-xl"
            style={{
            bottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)",
            color: downloadNotice.kind === "error" ? "#7f1d1d" : "#24352b",
            background: downloadNotice.kind === "error" ? "rgba(254,226,226,.97)" : downloadNotice.kind === "info" ? "rgba(255,251,235,.97)" : "rgba(236,253,245,.97)",
            border: "1px solid " + (downloadNotice.kind === "error" ? "rgba(220,38,38,.24)" : "rgba(22,101,52,.16)"),
            overflowWrap: "anywhere",
            }}
            >
            {downloadNotice.message}
            </div>
            , document.body
          )}
        </main>
      )}
    </AccountGate>
  );
}
