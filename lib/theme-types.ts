import type { DesktopIconId } from "@/lib/desktop-config";

/* ═══════════════════════════════════════════
   Asset types (wallpaper + icon skin + font)
   ═══════════════════════════════════════════ */
export type ThemeAssetType =
  | "wallpaper"
  | "icon_skin"
  | "dock_skin"
  | "font"
  | "bg"
  | "chat_bg"
  | "sticker"
  | "vn_scene"
  | "vn_sprite";

/* ═══════════════════════════════════════════
   Icon skin scheme (multi-scheme preserved)
   ═══════════════════════════════════════════ */
export type IconSkinScheme = {
  id: string;
  name: string;
  iconSkins: Partial<Record<DesktopIconId, string>>;
  updatedAt: string;
};

/* ═══════════════════════════════════════════
   ThemeProfile v2
   ═══════════════════════════════════════════ */
export type ThemeProfile = {
  version: 2;
  name: string;
  // 壁纸
  wallpaperAssetId: string | null;
  wallpaperBlur: number;
  wallpaperOpacity: number;
  wallpaperScale: number;
  wallpaperX: number;
  wallpaperY: number;
  wallpaperLibrary: string[];
  // 图标皮肤（扁平化）
  iconSkins: Partial<Record<DesktopIconId, string>>;
  iconSchemes: IconSkinScheme[];
  activeIconSchemeId: string;
  // DOCK 栏背景皮肤
  dockSkinAssetId: string | null;
  // 排版
  fontAssetId: string | null;
  fontFamily: string;
  // 手机外观
  hideTopBar: boolean;
  // 移动端：手机画面整体上移的像素数，用于裁掉顶部状态栏占位、把底部栏顶回可视区。
  // 0 = 不上移（iOS 等能全屏的浏览器保持 0）；安卓按真实状态栏高度调到刚好铺满。
  statusBarDropPx: number;
  // CSS 变量覆盖
  cssOverrides: Record<string, string>;
  // 自定义 CSS
  globalCustomCSS: string;
  // 桌面特效开关
  enableGlobalShadows: boolean;
  enableGlobalBorder: boolean;
  globalBorderColor: string;
  updatedAt: string;
};


/* ═══════════════════════════════════════════
   Chat Session CSS API
   ═══════════════════════════════════════════
   Per-session custom CSS (session.customCSS) is auto-scoped
   to `.session-{id}` to prevent leaking. The following class
   names and CSS variables are the official contract:

   ── Layout classes ──
   .chat-header          — top bar (bg, border, color inherited)
   .chat-input-bar       — bottom input area
   .chat-bubble-role-user     — user message bubble
   .chat-bubble-role-assistant — AI message bubble
   .chat-msg-content-wrap[data-html="true"] — HTML message outer width
   .chat-html-inline     — inline HTML iframe container
   .chat-html-inline-frame — inline HTML iframe
   .chat-html-inline-expand — fullscreen button for inline HTML

   ── 核心 16 色（通过 cssOverrides 或 globalCustomCSS 覆盖） ──
   --c-header-bg     : 标题栏底色 (#FFFFFF)
   --c-page-body-bg  : 页面内容区底色 (#F1F2F6)
   --c-card          : 选项卡片底色 (rgba(255, 255, 255, 0.7))
   --c-card-border   : 选项卡片边框 (#E0E0E0)
   --c-polaroid      : 拍立得正面 (#FEFEFE)
   --c-polaroid-back : 拍立得背面 (#F0F0F0)
   --c-panel         : 操作面板底色 (#FFFFFF)
   --c-panel-border  : 操作面板边框 (#D9DADB)
   --c-text-title    : 强调文字 (#2C3440)
   --c-text          : 普通文字 (#797E85)
   --c-icon-active   : 强调图标/品牌色 (#5B8FB9)
   --c-icon          : 普通图标/占位符 (#A0A3A8)
   --c-input         : 输入框底色 (#F2F3F5)
   --c-input-border  : 输入框边框 (rgba(224, 226, 229, 0))
   --c-bubble-self   : 己方消息气泡 (#95EC69)
   --c-bubble-other  : 对方消息气泡 (#FFFFFF)
   --c-success       : 成功/确认 (#34C759)
   --c-danger        : 警示/删除 (#FF3B30)
   --c-warning       : 警告 (#FF9500)
   --ctx-menu-bg     : 右键菜单背景 (#2c2c2c)

   ── Context menu classes ──
   .ctx-menu              — popup action menu container
   .ctx-menu-btn          — menu button (white text)
   .ctx-menu-btn-danger   — danger-colored menu button
   .ctx-menu-triangle     — CSS triangle indicator

   ── data-ui 语义属性（稳定选择器，用于 globalCustomCSS） ──
   [data-ui="phone-screen"]  — 手机屏幕容器
   [data-ui="header"]        — 所有页面头部（PageShell / chat header）
   [data-ui="body"]          — 滚动内容区
   [data-ui="nav"]           — 底部导航栏
   [data-ui="input"]         — 聊天输入区
   [data-ui="bubble-user"]   — 用户消息气泡
   [data-ui="bubble-bot"]    — AI 消息气泡
   [data-ui="card"]          — 毛玻璃卡片（GlassCard）
   [data-ui="menu"]          — 菜单组（MenuGroup）
   [data-ui="modal"]         — 模态框遮罩
   [data-ui="slider"]        — 滑块控件
   [data-ui="toggle"]        — 开关控件
   [data-ui="progress"]      — 进度条

   ── 用户自定义变量钩子 ──
   --user-glass-tint     : transparent  — 混入毛玻璃背景色
   --user-border-width   : 0.5px        — 毛玻璃边框宽度
   --user-shadow         : none         — 额外全局阴影

   Note: `body`, `html`, `:root` selectors in session CSS
   are rewritten to the scope selector by css-scoper.ts.
   ═══════════════════════════════════════════ */

/* ═══════════════════════════════════════════
   Default font family
   ═══════════════════════════════════════════ */
export const DEFAULT_FONT_FAMILY =
  '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "SF Pro Text", "Inter", "Segoe UI", sans-serif';

/* ═══════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════ */
function makeSchemeId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${random}`;
}

export function createDefaultIconScheme(): IconSkinScheme {
  return {
    id: "icon_scheme_default",
    name: "默认图标方案",
    iconSkins: {},
    updatedAt: new Date().toISOString()
  };
}

/* ═══════════════════════════════════════════
   Default profile
   ═══════════════════════════════════════════ */
export const DEFAULT_THEME_PROFILE: ThemeProfile = {
  version: 2,
  name: "默认主题",
  wallpaperAssetId: null,
  wallpaperBlur: 0,
  wallpaperOpacity: 0.9,
  wallpaperScale: 100,
  wallpaperX: 50,
  wallpaperY: 50,
  wallpaperLibrary: [],
  iconSkins: {},
  iconSchemes: [createDefaultIconScheme()],
  activeIconSchemeId: "icon_scheme_default",
  dockSkinAssetId: null,
  fontAssetId: null,
  fontFamily: DEFAULT_FONT_FAMILY,
  hideTopBar: true,
  statusBarDropPx: 0,
  cssOverrides: {},
  globalCustomCSS: "",
  enableGlobalShadows: true,
  enableGlobalBorder: false,
  globalBorderColor: "#000000",
  updatedAt: new Date().toISOString()
};

/* ═══════════════════════════════════════════
   Normalizer (with v1 → v2 migration)
   ═══════════════════════════════════════════ */

function normalizeStringMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.startsWith("--")) continue;
    if (typeof value !== "string") continue;
    const normalized = value.trim();
    if (!normalized) continue;
    result[key] = normalized;
  }
  return result;
}

function decodeEscapedUnicode(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  );
}

function normalizeIconSkins(raw: unknown): Partial<Record<DesktopIconId, string>> {
  if (!raw || typeof raw !== "object") return {};
  const result: Partial<Record<DesktopIconId, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || !value.trim()) continue;
    const iconId = key === "weibo" ? "game" : key;
    if (key === "weibo" && iconId in result) continue;
    result[iconId as DesktopIconId] = value;
  }
  return result;
}

function normalizeWallpaperLibrary(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) continue;
    const id = item.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function normalizeIconScheme(raw: unknown): IconSkinScheme | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<IconSkinScheme>;
  return {
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : makeSchemeId("icon_scheme"),
    name: typeof source.name === "string" && source.name.trim()
      ? decodeEscapedUnicode(source.name.trim())
      : "图标方案",
    iconSkins: normalizeIconSkins(source.iconSkins),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString()
  };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const result: T[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function normalizeThemeProfile(raw: unknown): ThemeProfile {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};

  const base: ThemeProfile = {
    ...DEFAULT_THEME_PROFILE,
    iconSchemes: [createDefaultIconScheme()],
    wallpaperLibrary: [],
    iconSkins: {}
  };

  // ── Name ──
  base.name = typeof source.name === "string" && (source.name as string).trim()
    ? decodeEscapedUnicode((source.name as string).trim())
    : base.name;

  // ── Wallpaper ──
  base.wallpaperAssetId = typeof source.wallpaperAssetId === "string" ? source.wallpaperAssetId : null;
  base.wallpaperLibrary = normalizeWallpaperLibrary(source.wallpaperLibrary);
  if (base.wallpaperAssetId && !base.wallpaperLibrary.includes(base.wallpaperAssetId)) {
    base.wallpaperLibrary = [base.wallpaperAssetId, ...base.wallpaperLibrary];
  }
  base.wallpaperBlur = typeof source.wallpaperBlur === "number"
    ? Math.min(24, Math.max(0, source.wallpaperBlur as number)) : 0;
  base.wallpaperOpacity = typeof source.wallpaperOpacity === "number"
    ? Math.min(1, Math.max(0, Number((source.wallpaperOpacity as number).toFixed(3)))) : 0.9;
  base.wallpaperScale = typeof source.wallpaperScale === "number"
    ? Math.min(200, Math.max(10, source.wallpaperScale as number)) : 100;
  base.wallpaperX = typeof source.wallpaperX === "number"
    ? Math.min(100, Math.max(0, source.wallpaperX as number)) : 50;
  base.wallpaperY = typeof source.wallpaperY === "number"
    ? Math.min(100, Math.max(0, source.wallpaperY as number)) : 50;

  // ── Icon schemes ──
  const legacyIconSkins = normalizeIconSkins(source.iconSkins);
  const sourceIconSchemes = Array.isArray(source.iconSchemes)
    ? dedupeById(
        (source.iconSchemes as unknown[])
          .map((item) => normalizeIconScheme(item))
          .filter((item): item is IconSkinScheme => Boolean(item))
      )
    : [];
  const resolvedIconSchemes = sourceIconSchemes.length > 0
    ? sourceIconSchemes
    : [{ ...createDefaultIconScheme(), iconSkins: legacyIconSkins }];
  const activeIconScheme =
    resolvedIconSchemes.find((item) => item.id === source.activeIconSchemeId) ?? resolvedIconSchemes[0];
  base.iconSchemes = resolvedIconSchemes;
  base.activeIconSchemeId = activeIconScheme.id;
  base.iconSkins = activeIconScheme.iconSkins;

  // ── Dock skin ──
  base.dockSkinAssetId = typeof source.dockSkinAssetId === "string" ? source.dockSkinAssetId : null;

  // ── Typography ──
  base.fontAssetId = typeof source.fontAssetId === "string" ? source.fontAssetId : null;

  base.fontFamily = typeof source.fontFamily === "string" && (source.fontFamily as string).trim()
    ? (source.fontFamily as string).trim()
    : DEFAULT_FONT_FAMILY;

  // ── Display ──
  base.hideTopBar = typeof source.hideTopBar === "boolean" ? source.hideTopBar : base.hideTopBar;
  base.statusBarDropPx = typeof source.statusBarDropPx === "number" && isFinite(source.statusBarDropPx as number)
    ? Math.min(120, Math.max(0, Math.round(source.statusBarDropPx as number))) : 0;

  // ── CSS Overrides ──
  base.cssOverrides = normalizeStringMap(source.cssOverrides);

  // ── Migrate old variable names → new names ──
  // Only renames variables that NO LONGER exist in the new system.
  // --c-card and --c-text exist in both old & new (with different semantics),
  // so they are NOT migrated — their values stay on the same key.
  const CSS_KEY_MIGRATION: Record<string, string> = {
    "--c-text-sub": "--c-text",
    "--c-text-hint": "--c-icon",
    "--c-accent": "--c-icon-active",
    "--c-border": "--c-input-border",
    "--c-border-sub": "--c-panel-border",
    "--c-fill": "--c-page-body-bg",
    "--c-glass": "--c-card",
    "--c-glass-elevated": "--c-card",
    "--c-glass-border": "--c-card-border",
    "--c-link": "--c-icon-active",
    "--ui-input-bg": "--c-input",
    "--ui-input-border": "--c-input-border",
  };
  for (const [oldKey, newKey] of Object.entries(CSS_KEY_MIGRATION)) {
    if (base.cssOverrides[oldKey] && !base.cssOverrides[newKey]) {
      base.cssOverrides[newKey] = base.cssOverrides[oldKey];
    }
    delete base.cssOverrides[oldKey];
  }

  // ── Custom CSS ──
  base.globalCustomCSS = typeof source.globalCustomCSS === "string" ? source.globalCustomCSS as string : "";
  
  // ── Desktop Effects ──
  base.enableGlobalShadows = typeof source.enableGlobalShadows === "boolean" ? source.enableGlobalShadows : true;
  base.enableGlobalBorder = typeof source.enableGlobalBorder === "boolean" ? source.enableGlobalBorder : false;
  base.globalBorderColor = typeof source.globalBorderColor === "string" ? source.globalBorderColor as string : "#000000";

  // ── Migrate enableGlobalShadows → cssOverrides["--desktop-global-shadow"] ──
  if (!base.cssOverrides["--desktop-global-shadow"]) {
    base.cssOverrides["--desktop-global-shadow"] = base.enableGlobalShadows ? "0.5" : "0";
  }

  base.updatedAt = typeof source.updatedAt === "string" ? source.updatedAt as string : new Date().toISOString();

  return base;
}

/* ═══════════════════════════════════════════
   Icon scheme resolvers
   ═══════════════════════════════════════════ */
function resolveActiveIconScheme(profile: ThemeProfile): IconSkinScheme {
  return profile.iconSchemes.find((item) => item.id === profile.activeIconSchemeId)
    ?? profile.iconSchemes[0]
    ?? createDefaultIconScheme();
}

export function resolveActiveIconSkins(profile: ThemeProfile): Partial<Record<DesktopIconId, string>> {
  return resolveActiveIconScheme(profile).iconSkins;
}
