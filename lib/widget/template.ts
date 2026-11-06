"use client";

/**
 * 小组件模板：把数据填进用户写的 HTML/CSS，交给原生离屏渲染成图。
 *
 * 为什么开放「整段 HTML+CSS」而不是给几个开关：
 *   给开关永远不够用——总有人想要渐变、想要斜着放、想要不同的字体组合。
 *   而渲染本来就经过 WebView，CSS 能做的都能做，没理由拦着。
 *   所以内置模板只是**起点示例**，用户想改哪就改哪。
 *
 * 安全：渲染发生在原生离屏 WebView 里，加载的是本地字符串（loadDataWithBaseURL），
 * 不联网、不执行脚本（javaScriptEnabled=false）。模板里的 <script> 不会运行。
 */

import type { WidgetData } from "./types";
import { loadVirtualLifeState } from "../life/life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "../life/life-runtime";

/** 模板可用的占位符（写文档时同步更新这里）。 */
export const WIDGET_PLACEHOLDERS = [
  { token: "{{text}}", desc: "那句话本身" },
  { token: "{{status}}", desc: "状态标签，如「在想你」；没有时整个元素建议隐藏" },
  { token: "{{signature}}", desc: "落款（角色名）" },
  { token: "{{avatar}}", desc: "头像地址（data URL）；没图时是空串" },
  { token: "{{avatarFallback}}", desc: "头像降级色（#RRGGBB），可直接当背景色用" },
  { token: "{{initial}}", desc: "角色名首字，做文字头像用" },
  { token: "{{time}}", desc: "更新时间，如「今天 14:30」" },
  { token: "{{charName}}", desc: "角色名（同 signature，语义更明确）" },
  { token: "{{userName}}", desc: "你的名字" },
  { token: "{{hasStatus}}", desc: "有状态时是 1，否则 0（配合 CSS 用）" },
  { token: "{{hasAvatar}}", desc: "有头像时是 1，否则 0" },
  { token: "{{hasText}}", desc: "正文非空时为 1，否则 0" },
  { token: "{{textLength}}", desc: "正文字符数量" },
  { token: "{{textLines}}", desc: "正文非空行数" },
  { token: "{{statusLength}}", desc: "状态标签字符数量" },
  { token: "{{source}}", desc: "内容来源标识：manual、auto 或 tool" },
  { token: "{{sourceLabel}}", desc: "内容来源中文标签" },
  { token: "{{charInitial}}", desc: "角色名首字" },
  { token: "{{year}}", desc: "设备当前年份" },
  { token: "{{month}}", desc: "设备当前月份（两位数）" },
  { token: "{{day}}", desc: "设备当前日期（两位数）" },
  { token: "{{weekday}}", desc: "设备当前星期几" },
  { token: "{{date}}", desc: "设备当前日期，如 2026-10-20" },
  { token: "{{dateTime}}", desc: "设备当前日期和时间" },
  { token: "{{hour}}", desc: "设备当前小时（24 小时制，两位数）" },
  { token: "{{minute}}", desc: "设备当前分钟（两位数）" },
  { token: "{{greeting}}", desc: "按设备时间生成的问候：早上好 / 下午好 / 晚上好" },
  { token: "{{updatedAt}}", desc: "这条桌面内容的完整更新时间" },
  { token: "{{updatedDate}}", desc: "这条内容更新时间的日期" },
  { token: "{{updatedTime}}", desc: "这条内容更新时间的时分" },
  { token: "{{lifeDate}}", desc: "生活引擎当前虚拟日期" },
  { token: "{{lifeWeekday}}", desc: "生活引擎当前虚拟星期" },
  { token: "{{lifeDayPart}}", desc: "虚拟时钟对应的时段" },
  { token: "{{lifeHasNext}}", desc: "存在下一项日程时为 1，否则 0" },
  { token: "{{lifeHasActivity}}", desc: "存在当前活动时为 1，否则 0" },
  { token: "{{lifeHasLocation}}", desc: "存在当前地点时为 1，否则 0" },
  { token: "{{lifeScheduleCountToday}}", desc: "虚拟当天的日程数量" },
  { token: "{{lifeNextLocation}}", desc: "下一项日程的计划地点" },
  { token: "{{lifeTime}}", desc: "玩家当前虚拟时间；生活引擎关闭时为空" },
  { token: "{{lifeActivity}}", desc: "玩家当前活动或正在进行的日程" },
  { token: "{{lifeLocation}}", desc: "玩家当前实际地点；没有记录时为空" },
  { token: "{{lifeNext}}", desc: "下一段生活日程的时间和名称" },
  { token: "{{lifeLine}}", desc: "适合直接放在桌面组件底部的一行生活状态" },
] as const;

/**
 * 内置模板。
 *
 * 排版意图：头像在左上，话是主角（字号最大），状态是一个小胶囊，落款压右下。
 * 用 CSS 变量集中管配色，方便用户直接改一处换整张的色调。
 */
export const DEFAULT_WIDGET_TEMPLATE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  /* ── 配色：改这几行就能换整张卡片的调子 ── */
  :root {
    --bg: #ffffff;
    --bg-accent: #f4f1ff;
    --ink: #1a1a20;
    --sub: #8a8a95;
    --accent: #7a5af8;
    --radius: 22px;
    --pad: 16px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; }
  body {
    font-family: -apple-system, "PingFang SC", "Noto Sans SC", sans-serif;
    background: transparent;
    display: flex;
  }
  .card {
    flex: 1;
    position: relative;
    overflow: hidden;
    border-radius: var(--radius);
    padding: var(--pad);
    background:
      radial-gradient(120% 90% at 100% 0%, var(--bg-accent), transparent 60%),
      var(--bg);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .head { display: flex; align-items: center; gap: 10px; }
  .avatar {
    width: 38px; height: 38px;
    flex: 0 0 auto;
    border-radius: 50%;
    overflow: hidden;
    background: var(--avatar-fallback, var(--accent));
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 16px; font-weight: 700;
  }
  .avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sig { font-size: 12px; font-weight: 700; color: var(--ink); }
  .time { font-size: 10px; color: var(--sub); }
  .status {
    margin-left: auto;
    flex: 0 0 auto;
    font-size: 10.5px;
    font-weight: 700;
    padding: 3px 9px;
    border-radius: 999px;
    color: var(--accent);
    background: var(--bg-accent);
  }
  .life-line { margin-top: auto; padding-top: 2px; font-size: 9px; line-height: 1.3; color: var(--sub); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .text {
    font-size: 15px;
    line-height: 1.55;
    color: var(--ink);
    font-weight: 500;
    /* 给底部生活状态留出空间，留言最多两行 */
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    word-break: break-word;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <div class="avatar" style="--avatar-fallback: {{avatarFallback}}">
        {{avatarInner}}
      </div>
      <div class="who">
        <div class="sig">{{signature}}</div>
        <div class="time">{{time}}</div>
      </div>
      {{statusChip}}
    </div>
    <div class="text">{{text}}</div>
    <div class="life-line">{{lifeLine}}</div>
  </div>
</body>
</html>`;

/** HTML 转义：数据来自角色/用户，进 HTML 前必须转义，否则一个 < 就把结构冲坏。 */
function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 由角色名稳定地推一个颜色，让每个角色的降级头像有区分度。 */
export function fallbackColorFor(name: string): string {
  const palette = [
    "#7A5AF8", "#4C86F5", "#2FA46A", "#E8A33D", "#E86A8D", "#5FBFD9", "#B47AD6", "#D9744E",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return palette[hash % palette.length];
}

/** 时间说成人话：今天只给时分，昨天前天点名，更早给日期。 */
function describeTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
  if (diffDays <= 0) return hm;
  if (diffDays === 1) return `昨天 ${hm}`;
  if (diffDays === 2) return `前天 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * 把数据套进模板，产出可直接交给 WebView 的完整 HTML。
 *
 * @param template 用户模板；空串时用内置模板
 * @param data 要显示的内容
 * @param charName 角色名（落款）
 * @param userName 用户名
 */
/** Inject custom CSS without requiring users to edit the HTML structure. */
export function injectWidgetCss(html: string, css: string): string {
  const customCss = css.trim();
  if (!customCss) return html;
  const style = "<style data-custom-widget-css>\n" + customCss + "\n</style>";
  const headEnd = html.toLowerCase().indexOf("</head>");
  if (headEnd >= 0) return html.slice(0, headEnd) + style + html.slice(headEnd);
  return style + html;
}

export function renderWidgetHtml(
  template: string,
  data: WidgetData,
  charName: string,
  userName: string,
): string {
  const name = charName || "角色";
  const hasAvatar = Boolean(data.avatar);
  const hasStatus = Boolean(data.status && data.status.trim());
  const avatarFallback = fallbackColorFor(name);
  const initial = esc(name.trim().slice(0, 1) || "?");
  const hasText = Boolean(data.text && data.text.trim());
  const textLength = Array.from(data.text || "").length;
  const textLines = (data.text || "").split(/\r?\n/).filter(line => line.trim()).length;
  const statusLength = Array.from(data.status || "").length;
  const sourceLabel = data.source === "auto" ? "自动生成" : data.source === "tool" ? "工具写入" : "手动编辑";
  const now = new Date();
  const dateKey = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  const weekdayNames = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const weekday = weekdayNames[now.getDay()];
  const greeting = now.getHours() < 6 ? "夜深了" : now.getHours() < 12 ? "早上好" : now.getHours() < 18 ? "下午好" : "晚上好";
  const updated = new Date(data.updatedAt);
  const validUpdated = Number.isFinite(updated.getTime());
  const updatedDate = validUpdated ? dateKey(updated) : "";
  const updatedTime = validUpdated ? updated.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "";
  const updatedAtText = validUpdated ? updated.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "";

  // 头像块：有图放图，没图用「降级色 + 首字」。拼成一段供 {{avatarInner}} 用。
  const avatarInner = hasAvatar
    ? `<img src="${esc(data.avatar)}" alt="">`
    : initial;
  const statusChip = hasStatus
    ? `<div class="status">${esc(data.status)}</div>`
    : "";

  const lifeState = loadVirtualLifeState();
  let lifeTime = "", lifeActivity = "", lifeLocation = "", lifeNext = "", lifeLine = "";
  let lifeDate = "", lifeWeekday = "", lifeDayPart = "", lifeNextLocation = "";
  let lifeHasNext = "0", lifeHasActivity = "0", lifeHasLocation = "0", lifeScheduleCountToday = "0";
  if (lifeState.settings.enabled) {
    const lifeNow = resolveActorLifeNow(getActorClock(lifeState, "player", "player"));
    const timeLabel = lifeNow.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
    const current = getCurrentActorSchedule(lifeState, "player", "player", lifeNow);
    const actual = lifeState.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const next = lifeState.schedules
      .filter(slot => slot.ownerType === "player" && slot.ownerId === "player" && new Date(slot.startAt).getTime() > lifeNow.getTime())
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    const dayStart = new Date(lifeNow); dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
    lifeScheduleCountToday = String(lifeState.schedules.filter(slot => slot.ownerType === "player" && slot.ownerId === "player" && new Date(slot.startAt).getTime() >= dayStart.getTime() && new Date(slot.startAt).getTime() < dayEnd.getTime()).length);
    lifeDate = dateKey(lifeNow);
    lifeWeekday = weekdayNames[lifeNow.getDay()];
    lifeDayPart = lifeNow.getHours() < 6 ? "深夜" : lifeNow.getHours() < 9 ? "清晨" : lifeNow.getHours() < 12 ? "上午" : lifeNow.getHours() < 14 ? "中午" : lifeNow.getHours() < 18 ? "下午" : lifeNow.getHours() < 22 ? "晚上" : "深夜";
    lifeTime = timeLabel;
    lifeActivity = actual?.activity || current?.title || "";
    lifeLocation = actual?.actualLocationName || (lifeState.settings.showLocationHints ? current?.plannedLocationName || "" : "");
    lifeNext = next ? new Date(next.startAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) + " · " + next.title : "";
    lifeNextLocation = next?.plannedLocationName || "";
    lifeHasNext = next ? "1" : "0";
    lifeHasActivity = lifeActivity ? "1" : "0";
    lifeHasLocation = lifeLocation ? "1" : "0";
    lifeLine = [ "生活 " + timeLabel, lifeActivity, lifeLocation ].filter(Boolean).map(esc).join(" · ");
  }
  const base = template.trim() || DEFAULT_WIDGET_TEMPLATE;
  return base
    .replace(/\{\{year\}\}/g, String(now.getFullYear()))
    .replace(/\{\{month\}\}/g, String(now.getMonth() + 1).padStart(2, "0"))
    .replace(/\{\{day\}\}/g, String(now.getDate()).padStart(2, "0"))
    .replace(/\{\{weekday\}\}/g, weekday)
    .replace(/\{\{date\}\}/g, dateKey(now))
    .replace(/\{\{dateTime\}\}/g, now.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }))
    .replace(/\{\{hour\}\}/g, String(now.getHours()).padStart(2, "0"))
    .replace(/\{\{minute\}\}/g, String(now.getMinutes()).padStart(2, "0"))
    .replace(/\{\{greeting\}\}/g, greeting)
    .replace(/\{\{charInitial\}\}/g, initial)
    .replace(/\{\{hasText\}\}/g, hasText ? "1" : "0")
    .replace(/\{\{textLength\}\}/g, String(textLength))
    .replace(/\{\{textLines\}\}/g, String(textLines))
    .replace(/\{\{statusLength\}\}/g, String(statusLength))
    .replace(/\{\{source\}\}/g, data.source)
    .replace(/\{\{sourceLabel\}\}/g, sourceLabel)
    .replace(/\{\{updatedAt\}\}/g, esc(updatedAtText))
    .replace(/\{\{updatedDate\}\}/g, esc(updatedDate))
    .replace(/\{\{updatedTime\}\}/g, esc(updatedTime))
    .replace(/\{\{lifeDate\}\}/g, esc(lifeDate))
    .replace(/\{\{lifeWeekday\}\}/g, esc(lifeWeekday))
    .replace(/\{\{lifeDayPart\}\}/g, esc(lifeDayPart))
    .replace(/\{\{lifeHasNext\}\}/g, lifeHasNext)
    .replace(/\{\{lifeHasActivity\}\}/g, lifeHasActivity)
    .replace(/\{\{lifeHasLocation\}\}/g, lifeHasLocation)
    .replace(/\{\{lifeScheduleCountToday\}\}/g, lifeScheduleCountToday)
    .replace(/\{\{lifeNextLocation\}\}/g, esc(lifeNextLocation))
    .replace(/\{\{lifeTime\}\}/g, esc(lifeTime))
    .replace(/\{\{lifeActivity\}\}/g, esc(lifeActivity))
    .replace(/\{\{lifeLocation\}\}/g, esc(lifeLocation))
    .replace(/\{\{lifeNext\}\}/g, esc(lifeNext))
    .replace(/\{\{lifeLine\}\}/g, lifeLine)
    .replace(/\{\{text\}\}/g, esc(data.text))
    .replace(/\{\{status\}\}/g, esc(data.status))
    .replace(/\{\{statusChip\}\}/g, statusChip)
    .replace(/\{\{avatarInner\}\}/g, avatarInner)
    .replace(/\{\{signature\}\}/g, esc(name))
    .replace(/\{\{charName\}\}/g, esc(name))
    .replace(/\{\{userName\}\}/g, esc(userName))
    .replace(/\{\{avatar\}\}/g, esc(data.avatar))
    .replace(/\{\{avatarFallback\}\}/g, avatarFallback)
    .replace(/\{\{initial\}\}/g, initial)
    .replace(/\{\{time\}\}/g, esc(describeTime(data.updatedAt)))
    .replace(/\{\{hasStatus\}\}/g, hasStatus ? "1" : "0")
    .replace(/\{\{hasAvatar\}\}/g, hasAvatar ? "1" : "0");
}
