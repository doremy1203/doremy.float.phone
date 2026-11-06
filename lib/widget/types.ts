"use client";

/**
 * 桌面小组件：角色在你手机桌面上留的一块地方。
 *
 * 设计取舍（改之前先读）：
 *  · **小组件显示的是「网页渲染好的一张图」**，不是原生控件。
 *    Android 的 RemoteViews 只认 LinearLayout/TextView/ImageView 这类基础件，
 *    写不了 CSS——而用户要的正是「自己排版、自己写样式」。
 *    所以把 HTML/CSS 交给离屏 WebView 画成 Bitmap，小组件只负责贴这张图。
 *    代价：图里不能有独立可点的按钮，整块点一下是打开小手机。
 *  · **数据是私密的**，只存本机 IndexedDB（与朋友圈/便签墙的公开性质刻意区分）。
 *    角色在这里写的是「给你看的话」，不该出现在任何公开墙上。
 */

/** 独立的桌面小组件配置。应用不设配置数量上限；实际桌面实例数由 Android 启动器决定。 */
export type WidgetProfile = {
  id: string;
  name: string;
  characterId: string;
  template: string;
  customCss: string;
  widthDp: number;
  heightDp: number;
  scale: number;
  createdAt: string;
  updatedAt: string;
};

/** 小组件当前显示的内容。 */
export type WidgetData = {
  /** 以哪个角色的身份留的话 */
  characterId: string;
  /** 正文，那句话本身 */
  text: string;
  /** 状态标签，如「在想你」；可空 */
  status: string;
  /** 头像：data URL（推荐，自包含）或 http(s) 地址；可空则用降级头像 */
  avatar: string;
  updatedAt: string;
  /** 这轮内容是角色自己随机生成的，还是工具写入的（仅用于展示与排查） */
  source: "tool" | "auto" | "manual";
};

/** 排版配置。 */
export type WidgetConfig = {
  enabled: boolean;
  /** 显示哪个角色（小组件一次只显示一个） */
  characterId: string;
  /** 是否用自定义模板；关掉则用内置模板 */
  useCustomTemplate: boolean;
  /** 自定义 HTML+CSS 模板，可用占位符见 lib/widget/template.ts */
  customTemplate: string;
  /** 小组件尺寸（dp）。桌面按它申请空间，也决定渲染分辨率 */
  widthDp: number;
  heightDp: number;
  /** 是否让角色自己隔段时间换一句（主动随机生成） */
  autoEnabled: boolean;
  autoIntervalHours: number;
  /** 是否尝试用生图 API 给头像配图（没配生图 API 时自动降级） */
  useGeneratedAvatar: boolean;
  /** 渲染缩放倍率：2 = 更清晰但图更大（Binder 传输有 1MB 上限） */
  scale: number;
};

export const WIDGET_DEFAULTS: WidgetConfig = {
  enabled: false,
  characterId: "",
  useCustomTemplate: false,
  customTemplate: "",
  widthDp: 300,
  heightDp: 150,
  autoEnabled: false,
  autoIntervalHours: 12,
  useGeneratedAvatar: false,
  scale: 2,
};

export const WIDGET_LIMITS = {
  widthDp: { min: 180, max: 420 },
  heightDp: { min: 80, max: 400 },
  autoIntervalHours: { min: 1, max: 168 },
  scale: { min: 1, max: 3 },
} as const;

export const WIDGET_UPDATED_EVENT = "phone-widget-updated";
