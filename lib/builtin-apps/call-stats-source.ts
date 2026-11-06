/**
 * 内置「通话统计」App 的入口 HTML（1:1 保留 call.stats 2.1.0 的原始实现）。
 *
 * 为什么内嵌而不是重写：原版是按小手机自定义 App SDK（window.AiPhone）写的完整应用，
 * 主题、图表、日历、逐通回看、AI 总结与语音复听全部就绪。由 CustomAppRunner 挂载后
 * 复用宿主的 AiPhone 桥（chat.readHistory / characters.list / db / ui.toast / voice / ai.generate），
 * 功能与装到应用市场的版本完全一致，但不需要用户手动安装。
 *
 * 源文件：桌面 Project/call.stats-2.1.0/index.html（manifest id: call.stats）。
 */
export const CALL_STATS_APP_ID = "callstats";
export const CALL_STATS_ENTRY_HTML = String.raw`<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>通话统计</title>
<style>
  /* ── 主题：多套配色，html[data-theme] 切换（深色 / 浅色 / 马卡龙 / 莫兰迪…） ── */
  /* 星夜（深色星空紫） */
  html[data-theme="galaxy"] {
    --bg: #0a0d1c;          --bg2: #101530;
    --card: #151b34;        --card2: #1c2242;
    --line: rgba(150,170,255,.13);
    --text: #e9edff;        --muted: #8d95c4;
    --accent: #7b8cff;      --accent-soft: rgba(123,140,255,.18);
    --voice: #45d0c0;       --voice-soft: rgba(69,208,192,.16);
    --video: #b98cff;       --video-soft: rgba(185,140,255,.18);
    --warn: #ffc857;        --warn-soft: rgba(255,200,87,.14);
    --shadow: 0 6px 24px rgba(0,0,0,.42);
  }
  /* 海盐（清爽蓝青） */
  html[data-theme="ocean"] {
    --bg: #f0f7fa;          --bg2: #e4f0f6;
    --card: #ffffff;        --card2: #edf5f9;
    --line: rgba(20,70,95,.11);
    --text: #143243;        --muted: #6b8794;
    --accent: #2e8fc0;      --accent-soft: rgba(46,143,192,.13);
    --voice: #2fa48b;       --voice-soft: rgba(47,164,139,.14);
    --video: #6a7fd6;       --video-soft: rgba(106,127,214,.14);
    --warn: #c98a2e;        --warn-soft: rgba(201,138,46,.13);
    --shadow: 0 4px 18px rgba(20,70,95,.09);
  }
  /* 马卡龙（粉紫奶糖） */
  html[data-theme="macaron"] {
    --bg: #fdf7fb;          --bg2: #f7eef6;
    --card: #ffffff;        --card2: #f8f0f7;
    --line: rgba(150,90,140,.14);
    --text: #43303f;        --muted: #93839a;
    --accent: #d974a4;      --accent-soft: rgba(217,116,164,.14);
    --voice: #6fbfa5;       --voice-soft: rgba(111,191,165,.16);
    --video: #9b8ee8;       --video-soft: rgba(155,142,232,.16);
    --warn: #d99a3c;        --warn-soft: rgba(217,154,60,.14);
    --shadow: 0 4px 18px rgba(150,90,140,.10);
  }
  /* 莫兰迪（低饱和灰调） */
  html[data-theme="morandi"] {
    --bg: #eef0ec;          --bg2: #e6e9e4;
    --card: #fbfcfa;        --card2: #ecefea;
    --line: rgba(70,80,72,.13);
    --text: #39413b;        --muted: #7e887f;
    --accent: #7f9c84;      --accent-soft: rgba(127,156,132,.16);
    --voice: #8fb1a2;       --voice-soft: rgba(143,177,162,.18);
    --video: #949cc0;       --video-soft: rgba(148,156,192,.18);
    --warn: #c0a068;        --warn-soft: rgba(192,160,104,.16);
    --shadow: 0 4px 18px rgba(70,80,72,.09);
  }
  /* 蜜桃（暖橙奶油） */
  html[data-theme="peach"] {
    --bg: #fff7f1;          --bg2: #fdeee4;
    --card: #ffffff;        --card2: #fdf1e9;
    --line: rgba(140,80,50,.12);
    --text: #45312a;        --muted: #9c8275;
    --accent: #e57f4b;      --accent-soft: rgba(229,127,75,.14);
    --voice: #3f9f86;       --voice-soft: rgba(63,159,134,.14);
    --video: #b585d6;       --video-soft: rgba(181,133,214,.15);
    --warn: #cf9426;        --warn-soft: rgba(207,148,38,.13);
    --shadow: 0 4px 18px rgba(140,80,50,.09);
  }
  /* 抹茶（淡雅青绿） */
  html[data-theme="matcha"] {
    --bg: #f3f8f1;          --bg2: #e8f2e5;
    --card: #ffffff;        --card2: #eef6eb;
    --line: rgba(50,90,50,.11);
    --text: #26361f;        --muted: #75846f;
    --accent: #4f9d5d;      --accent-soft: rgba(79,157,93,.14);
    --voice: #2f9a8a;       --voice-soft: rgba(47,154,138,.14);
    --video: #7d86c9;       --video-soft: rgba(125,134,201,.14);
    --warn: #c08c22;        --warn-soft: rgba(192,140,34,.12);
    --shadow: 0 4px 18px rgba(50,90,50,.09);
  }
  html[data-theme="dark"] {
    --bg: #0d0f14;          --bg2: #12151c;
    --card: #171a22;        --card2: #1e222c;
    --line: rgba(255,255,255,.085);
    --text: #eef1f7;        --muted: #8a93a5;
    --accent: #5b8cff;      --accent-soft: rgba(91,140,255,.16);
    --voice: #34d399;       --voice-soft: rgba(52,211,153,.16);
    --video: #a78bfa;       --video-soft: rgba(167,139,250,.16);
    --warn: #fbbf24;        --warn-soft: rgba(251,191,36,.13);
    --shadow: 0 6px 22px rgba(0,0,0,.32);
  }
  html[data-theme="light"] {
    --bg: #f4f6fa;          --bg2: #eef1f7;
    --card: #ffffff;        --card2: #f2f4f9;
    --line: rgba(16,24,40,.09);
    --text: #141a24;        --muted: #6b7486;
    --accent: #3b74f0;      --accent-soft: rgba(59,116,240,.12);
    --voice: #10a37f;       --voice-soft: rgba(16,163,127,.13);
    --video: #7c5cf0;       --video-soft: rgba(124,92,240,.13);
    --warn: #d18b00;        --warn-soft: rgba(209,139,0,.12);
    --shadow: 0 4px 16px rgba(16,24,40,.08);
  }

  html, body { width: 100%; min-height: 100%; margin: 0; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    transition: background .2s ease, color .2s ease;
  }
  button, textarea, input { font: inherit; color: inherit; }
  button { background: none; border: none; padding: 0; cursor: pointer; }
  button:active { opacity: .65; }

  /* ── 顶栏（方案 A：与宿主胶囊同排） ── */
  .topbar {
    position: fixed; z-index: 20;
    top: var(--ai-phone-app-bar-top, 56px);
    left: 16px; right: var(--ai-phone-app-bar-clear-right, 96px);
    min-height: var(--ai-phone-app-bar-height, 30px);
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
  }
  .topbar h1 { margin: 0; font-size: 19px; font-weight: 700; letter-spacing: .2px; }
  .tb-actions { display: flex; gap: 8px; }
  .icon-btn {
    height: 34px; min-width: 34px; padding: 0 12px; border-radius: 17px;
    background: var(--card2); border: 1px solid var(--line);
    font-size: 13px; color: var(--muted);
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .icon-btn[disabled] { opacity: .45; }

  .app {
    min-height: 100dvh;
    padding: calc(var(--ai-phone-app-bar-top, 56px) + 48px) 16px var(--ai-phone-app-safe-bottom, 24px);
  }

  /* ── 顶部角色条 ── */
  .tabs { display: flex; gap: 8px; overflow-x: auto; padding: 2px 0 12px; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    flex: 0 0 auto; height: 34px; padding: 0 13px; border-radius: 17px;
    background: var(--card); border: 1px solid var(--line);
    font-size: 13px; color: var(--muted); white-space: nowrap;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .tab.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 600; }
  .tab .cnt { font-size: 11px; opacity: .75; }

  /* ── 视图切换 ── */
  .views { display: flex; gap: 4px; padding: 3px; background: var(--card2); border-radius: 12px; margin-bottom: 14px; }
  .views button {
    flex: 1; height: 32px; border-radius: 9px; font-size: 13px; color: var(--muted);
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  }
  .views button.on { background: var(--card); color: var(--text); font-weight: 600; box-shadow: var(--shadow); }

  /* ── 卡片 ── */
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 15px; padding: 14px; margin-bottom: 12px; }
  .card-title { font-size: 12.5px; color: var(--muted); letter-spacing: .3px; margin: 0 0 12px; display: flex; align-items: center; justify-content: space-between; }
  .card-title b { color: var(--text); font-size: 13.5px; font-weight: 650; }

  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .stat { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px 13px; }
  .stat .k { font-size: 11.5px; color: var(--muted); margin-bottom: 5px; }
  .stat .v { font-size: 20px; font-weight: 700; letter-spacing: .1px; line-height: 1.2; }
  .stat .v small { font-size: 11.5px; font-weight: 500; color: var(--muted); margin-left: 3px; }
  .stat .sub { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* ── 柱状图 ── */
  .bars { display: flex; align-items: flex-end; gap: 3px; height: 96px; margin-top: 4px; }
  .bars .col { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; height: 100%; }
  .bars .bar { width: 100%; border-radius: 4px 4px 2px 2px; background: var(--accent); min-height: 3px; transition: height .3s ease; }
  .bars .bar.video { background: var(--video); }
  .bars .lab { font-size: 9px; color: var(--muted); white-space: nowrap; }
  .bars .col.today .lab { color: var(--accent); font-weight: 700; }

  /* ── 环形图 ── */
  .donut-wrap { display: flex; align-items: center; gap: 16px; }
  .donut { flex: 0 0 auto; position: relative; width: 104px; height: 104px; }
  .donut .center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .donut .center b { font-size: 16px; font-weight: 700; }
  .donut .center span { font-size: 10px; color: var(--muted); }
  .legend { flex: 1 1 auto; display: flex; flex-direction: column; gap: 9px; }
  .legend .li { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
  .legend .sw { width: 9px; height: 9px; border-radius: 3px; flex: 0 0 auto; }
  .legend .li .nm { flex: 1 1 auto; color: var(--muted); }
  .legend .li .vl { font-weight: 650; }

  /* ── 排行 ── */
  .rank { display: flex; flex-direction: column; gap: 10px; }
  .rank .r { display: flex; align-items: center; gap: 10px; }
  .rank .av { width: 30px; height: 30px; border-radius: 10px; flex: 0 0 auto; object-fit: cover; background: var(--card2); display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--muted); }
  .rank .info { flex: 1 1 auto; min-width: 0; }
  .rank .nm { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rank .track { height: 5px; border-radius: 3px; background: var(--card2); margin-top: 6px; overflow: hidden; }
  .rank .fill { height: 100%; border-radius: 3px; background: var(--accent); }
  .rank .dd { font-size: 12px; color: var(--muted); flex: 0 0 auto; text-align: right; }

  /* ── 日历 ── */
  .cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .cal-head .ym { font-size: 15px; font-weight: 700; }
  .cal-head .nav { display: flex; gap: 6px; }
  .cal-head .nav button { width: 30px; height: 30px; border-radius: 10px; background: var(--card2); border: 1px solid var(--line); color: var(--muted); display: flex; align-items: center; justify-content: center; }
  .cal-week { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; margin-bottom: 6px; }
  .cal-week span { text-align: center; font-size: 11px; color: var(--muted); }
  .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
  .cal-cell {
    aspect-ratio: 1; border-radius: 10px; background: var(--card2); border: 1px solid transparent;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    font-size: 12.5px; color: var(--muted); position: relative;
  }
  .cal-cell.blank { background: transparent; }
  .cal-cell.has { color: var(--text); font-weight: 650; background: var(--accent-soft); }
  .cal-cell.today { border-color: var(--accent); }
  .cal-cell.sel { outline: 2px solid var(--accent); outline-offset: -2px; }
  .cal-cell .dot { width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
  .cal-cell .dot.v { background: var(--video); }

  /* ── 通话列表 ── */
  .list { display: flex; flex-direction: column; gap: 8px; }
  .row { background: var(--card); border: 1px solid var(--line); border-radius: 13px; padding: 11px 13px; display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; }
  .dot-ico { width: 34px; height: 34px; border-radius: 11px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; font-size: 15px; }
  .dot-ico.voice { background: var(--voice-soft); }
  .dot-ico.video { background: var(--video-soft); }
  .row .mid { flex: 1 1 auto; min-width: 0; }
  .row .l1 { display: flex; align-items: center; gap: 6px; }
  .row .who { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .l2 { font-size: 11.5px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .dur { flex: 0 0 auto; text-align: right; font-size: 14.5px; font-weight: 650; }
  .row .dur span { display: block; font-size: 10.5px; font-weight: 500; color: var(--muted); margin-top: 3px; }
  .tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; flex: 0 0 auto; background: var(--warn-soft); color: var(--warn); border: 1px solid transparent; }
  .tag.gray { background: var(--card2); color: var(--muted); }
  .tag.ai { background: var(--accent-soft); color: var(--accent); }

  /* ── 详情页 ── */
  .detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .detail-head .av { width: 46px; height: 46px; border-radius: 16px; object-fit: cover; background: var(--card2); display: flex; align-items: center; justify-content: center; font-size: 18px; flex: 0 0 auto; }
  .detail-head .meta { flex: 1 1 auto; min-width: 0; }
  .detail-head .nm { font-size: 16px; font-weight: 700; }
  .detail-head .sm { font-size: 12px; color: var(--muted); margin-top: 3px; }
  .back-btn { width: 34px; height: 34px; border-radius: 17px; background: var(--card2); border: 1px solid var(--line); color: var(--muted); display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }

  .transcript { display: flex; flex-direction: column; gap: 10px; }
  .tr { display: flex; flex-direction: column; max-width: 82%; }
  .tr.r-user { align-self: flex-end; align-items: flex-end; }
  .tr.r-assistant { align-self: flex-start; align-items: flex-start; }
  .tr .bub { padding: 8px 11px; border-radius: 13px; font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; word-break: break-word; }
  .tr.r-user .bub { background: var(--accent); color: #fff; border-bottom-right-radius: 5px; }
  .tr.r-assistant .bub { background: var(--card2); border: 1px solid var(--line); border-bottom-left-radius: 5px; }
  .tr .tm { font-size: 10.5px; color: var(--muted); margin-top: 3px; padding: 0 3px; display: flex; align-items: center; gap: 6px; }
  .tr.sys { align-self: center; align-items: center; max-width: 100%; }
  .tr.sys .bub { background: transparent; border: 1px solid var(--line); color: var(--muted); font-size: 11.5px; border-radius: 999px; padding: 4px 11px; }
  /* 复听小喇叭：贴在角色话右下角 */
  .speak-btn {
    width: 22px; height: 22px; border-radius: 11px; flex: 0 0 auto;
    background: var(--card); border: 1px solid var(--line); color: var(--muted);
    display: inline-flex; align-items: center; justify-content: center; font-size: 11px; line-height: 1;
    transition: opacity .15s ease;
  }
  .speak-btn.on { background: var(--accent); border-color: var(--accent); color: #fff; }
  .speak-btn[disabled] { opacity: .5; }
  .speak-hint { font-size: 11px; color: var(--muted); margin-top: 8px; line-height: 1.6; }

  .note-area { width: 100%; min-height: 76px; resize: vertical; border-radius: 12px; border: 1px solid var(--line); background: var(--bg2); color: var(--text); padding: 10px 12px; font-size: 13.5px; line-height: 1.55; }
  .note-area:focus { outline: none; border-color: var(--accent); }
  .btn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .btn { height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13px; border: 1px solid var(--line); background: var(--card2); color: var(--text); display: inline-flex; align-items: center; gap: 6px; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
  .btn[disabled] { opacity: .5; }
  .ai-out { margin-top: 12px; padding: 11px 13px; border-radius: 12px; background: var(--accent-soft); border: 1px solid transparent; font-size: 13.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .ai-out .hd { font-size: 11px; color: var(--accent); font-weight: 700; margin-bottom: 6px; letter-spacing: .3px; }

  .hint { background: var(--warn-soft); color: var(--warn); font-size: 12px; line-height: 1.6; border-radius: 12px; padding: 10px 12px; margin-bottom: 12px; }
  .empty { text-align: center; color: var(--muted); font-size: 13px; padding: 44px 20px; line-height: 1.8; }
  .empty .big { font-size: 32px; display: block; margin-bottom: 10px; opacity: .5; }
  .sk { background: linear-gradient(90deg, var(--card) 25%, var(--card2) 37%, var(--card) 63%); background-size: 400% 100%; animation: sk 1.3s ease infinite; border-radius: 14px; height: 70px; margin-bottom: 10px; }
  @keyframes sk { 0% { background-position: 100% 50% } 100% { background-position: 0 50% } }
</style>
</head>
<body>

<div class="topbar">
  <h1 id="pageTitle">通话统计</h1>
  <div class="tb-actions">
    <button class="icon-btn" id="themeBtn" title="切换主题">◐ 配色</button>
    <button class="icon-btn" id="stopBtn" style="display:none" title="停止播放">■ 停止</button>
    <button class="icon-btn" id="refreshBtn">刷新</button>
  </div>
</div>

<div class="app" id="app"></div>

<script>
(function () {
  "use strict";

  var api = window.AiPhone || window.AiPhoneApp;
  var $ = function (id) { return document.getElementById(id); };

  /* 与聊天室折叠逻辑保持同一套常量，保证数字对得上 */
  var MAX_GAP_SYS = 60 * 60 * 1000;
  var MAX_GAP_CHAT = 10 * 60 * 1000;
  var PAGE_SIZE = 200;
  var MAX_PAGES = 60;
  var NOTE_COLLECTION = "call_notes";

  var state = {
    characters: [],
    callsByChar: {},
    messagesByChar: {},
    notes: {},          /* callKey -> {note, aiSummary, aiFeeling, updatedAt} */
    selected: "__all__",
    view: "overview",   /* overview | calendar | list | detail */
    loading: true,
    sawOrigin: false,
    calMonth: null,     /* {y, m} */
    calDay: null,       /* "YYYY-MM-DD" 选中日期 */
    detail: null,       /* 当前查看的通话 */
    busy: false,
    playingId: null,    /* 正在复听的消息 id */
    speakingId: null,   /* 正在重新合成的消息 id */
  };

  /* ────────────────────────── 工具 ────────────────────────── */

  function parseTs(v) { if (!v) return 0; var t = Date.parse(v); return isFinite(t) ? t : 0; }

  function durationToSeconds(text) {
    if (!text) return 0;
    var m = String(text).trim().match(/(\d+(?::\d+){0,2})/);
    if (!m) return 0;
    var parts = m[1].split(":").map(function (s) { return parseInt(s, 10); });
    if (!parts.length || parts.some(function (n) { return !isFinite(n) || n < 0; })) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
  }

  function formatDuration(sec) {
    var s = Math.max(0, Math.round(sec || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h > 0) return h + "小时" + m + "分";
    if (m > 0) return m + "分" + ss + "秒";
    return ss + "秒";
  }

  /** 紧凑时长：用于图表轴标签 */
  function shortDuration(sec) {
    var s = Math.max(0, Math.round(sec || 0));
    if (s >= 3600) return (Math.round(s / 360) / 10) + "h";
    if (s >= 60) return Math.round(s / 60) + "m";
    return s ? s + "s" : "";
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function dayKeyOf(ms) { var d = new Date(ms); return isNaN(d.getTime()) ? "" : ymd(d); }

  function formatWhen(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var now = new Date();
    var hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    var y = new Date(now.getTime()); y.setDate(y.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "昨天 " + hm;
    var sameYear = d.getFullYear() === now.getFullYear();
    return (sameYear ? "" : (d.getFullYear() + "年")) + (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
  }

  function formatClock(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[c];
    });
  }

  function toast(msg) {
    try { if (api && api.ui && api.ui.toast) api.ui.toast(msg); } catch (e) {}
  }

  function avatarHtml(ch, cls) {
    if (!ch) return '<div class="' + cls + '">?</div>';
    if (ch.avatar) return '<img class="' + cls + '" src="' + esc(ch.avatar) + '" alt="" />';
    return '<div class="' + cls + '">' + esc((ch.name || "?").slice(0, 1)) + '</div>';
  }

  /* ────────────────── 消息读取（分页拉全量） ────────────────── */

  function readAllMessages(characterId) {
    var collected = [], seen = Object.create(null), before = null, pages = 0;
    function step() {
      var req = { characterId: characterId, limit: PAGE_SIZE };
      if (before) req.before = before;
      return api.chat.readHistory(req).then(function (res) {
        var msgs = (res && res.messages) || [];
        if (!msgs.length) return { messages: collected, truncated: false };
        var fresh = [];
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          if (!m || !m.id || seen[m.id]) continue;
          seen[m.id] = 1; fresh.push(m);
        }
        if (!fresh.length) return { messages: collected, truncated: false };
        collected = fresh.concat(collected);
        pages += 1;
        before = msgs[0].id;
        if (msgs.length < PAGE_SIZE) return { messages: collected, truncated: false };
        if (pages >= MAX_PAGES) return { messages: collected, truncated: true };
        return step();
      });
    }
    return step();
  }

  /* ────────────────── 通话区间识别 ────────────────── */

  var CALL_SYS_RE = /\[我(?:向.+)?(?:发起了|挂断了|拒绝了|取消了)(?:群?(?:语音|视频)通话)/;
  function isCallSysMsg(m) { return !!m && CALL_SYS_RE.test(m.content || ""); }
  function isCallStartSys(m) {
    if (!m) return false;
    var c = m.content || "";
    return c.indexOf("发起了语音通话") >= 0 || c.indexOf("发起了视频通话") >= 0
      || c.indexOf("发起了群语音通话") >= 0 || c.indexOf("发起了群视频通话") >= 0;
  }
  function isManualCallStart(m) { return !!(m && m.mediaData && m.mediaData.callStartMarker === true); }
  function isManualCallEnd(m) { return !!(m && m.mediaData && m.mediaData.callEndMarker === true); }
  /** 起点：系统留痕，或用户在聊天室手动标的「通话开头」。 */
  function isCallStart(m) {
    if (!m) return false;
    return isCallStartSys(m) || isManualCallStart(m);
  }
  function isCallEnd(m) { return !!m && /(挂断了|拒绝了|取消了)(群)?(语音|视频)通话/.test(m.content || ""); }
  function callTypeOf(m) { return ((m.content || "").indexOf("视频通话") >= 0) ? "video" : "voice"; }

  /** 把一条存储消息转成回看用的精简结构 */
  function toTranscriptMsg(m) {
    var content = m.content || "";
    if (m.mediaType === "image") content = content ? "[图片] " + content : "[图片]";
    else if (m.mediaType === "sticker") content = "[表情] " + (m.mediaData && m.mediaData.label || "");
    else if (m.mediaType === "audio") content = "[语音] " + ((m.mediaData && m.mediaData.label) || content);
    else if (m.mediaType === "red_packet") content = "[红包] " + ((m.mediaData && m.mediaData.label) || "");
    else if (m.mediaType === "transfer") content = "[转账] " + ((m.mediaData && m.mediaData.label) || "");
    if (m.statusPanel) content += (content ? "\n" : "") + m.statusPanel;
    var role = (m.role === "user") ? "user" : (m.role === "assistant" ? "assistant" : "sys");
    if (isCallSysMsg(m)) role = "sys";
    return {
      id: m.id,
      role: role,
      content: content,
      at: m.createdAt,
      sys: isCallSysMsg(m),
      mediaType: m.mediaType,
      /* 通话原音留档引用（media-store://…）。有它就直接放原声，
       * 没它才退回重新合成。老记录没有这个字段。 */
      audioRef: m.mediaData && typeof m.mediaData.callAudioRef === "string" ? m.mediaData.callAudioRef : "",
    };
  }

  /**
   * 从整段消息里切出所有通话。
   * 结束时刻只认两个来源：挂断留痕、用户手动标记的结尾；两者都没有则标
   * unresolved（不猜区间、不圈消息）。
   */
  function extractCalls(msgs, charId) {
    var out = [], i = 0;

    while (i < msgs.length) {
      var msg = msgs[i];
      if (!isCallStart(msg)) { i += 1; continue; }

      /* 类型：系统起点正文里有「视频通话」；手动开头没有类型信息，往后探一条。 */
      var type = isCallStartSys(msg) ? callTypeOf(msg) : "voice";
      if (!isCallStartSys(msg)) {
        for (var t = i + 1; t < msgs.length; t += 1) {
          var probe = msgs[t].content || "";
          if (probe.indexOf("发起了语音通话") >= 0) break;
          if (probe.indexOf("发起了视频通话") >= 0 || probe.indexOf("视频通话") >= 0) { type = "video"; break; }
        }
      }

      /* 终点：手动标记优先，其次挂断/拒绝/取消留痕。
       * 早先只把手动标记当「没有挂断留痕时的兜底」，于是用户标了也不生效（用户实报）。
       * 手动标记是明确意图，优先级应当更高。 */
      var endIdx = -1, durationText = "", connected = true;
      var hookEndIdx = -1, hookDuration = "", hookConnected = true;

      for (var j = i + 1; j < msgs.length; j += 1) {
        var c = msgs[j];
        if (isCallStart(c)) break;
        if (isCallSysMsg(c) && isCallEnd(c)) {
          if (hookEndIdx === -1) {
            hookEndIdx = j;
            hookConnected = (c.content || "").indexOf("挂断了") >= 0;
            var m1 = (c.content || "").match(/时长\s*(\d+:\d+)/);
            var fromMedia = c.mediaData && typeof c.mediaData.callDuration === "string" ? c.mediaData.callDuration : "";
            hookDuration = m1 ? m1[1] : fromMedia;
          }
        }
        if (isManualCallEnd(c)) { endIdx = j; break; }
      }

      if (endIdx === -1 && hookEndIdx !== -1) {
        endIdx = hookEndIdx;
        durationText = hookDuration;
        connected = hookConnected;
      } else if (endIdx !== -1) {
        /* 手动收尾时，时长仍取区间内那条挂断留痕写下的值 */
        durationText = hookDuration;
        connected = hookEndIdx === -1 ? true : hookConnected;
      }

      var interrupted = endIdx === -1;

      var startTs = parseTs(msg.createdAt);
      var callKey = charId + "|" + msg.id;

      if (endIdx > i) {
        /* 逐条判定来源（与聊天室折叠逻辑保持一致）：
         *   · origin === "call" —— 通话屏里产生的
         *   · origin 不存在       —— 老版本记录（origin 是后加字段）
         * 只有明确是聊天室等其它来源的才排除。
         *
         * 原先是「整段判定」：区间里出现任意一条带标记的消息就整段切严格模式，
         * 于是老通话那些无标记的消息被连坐排除，整通折成 0 条（用户实报）。 */
        var transcript = [], chatCount = 0, lastTs = startTs;
        for (var q = i; q <= endIdx; q += 1) {
          var cur = msgs[q];
          var qt = parseTs(cur.createdAt);
          if (qt) lastTs = qt;
          if (cur.role === "system" || isCallSysMsg(cur)) continue;
          var isMember = cur.origin === "call" || cur.origin === undefined || cur.origin === null;
          if (!isMember) continue;
          chatCount += 1;
          transcript.push(toTranscriptMsg(cur));
        }

        var seconds = durationToSeconds(durationText);
        var approximate = false;
        if (!seconds && !durationText) {
          if (lastTs > startTs) { seconds = (lastTs - startTs) / 1000; approximate = true; }
        }

        out.push({
          key: callKey, charId: charId, type: type,
          startMs: startTs, startedAt: msg.createdAt,
          endMs: lastTs, endedAt: new Date(lastTs).toISOString(),
          seconds: seconds, approximate: approximate,
          connected: connected, interrupted: interrupted,
          chatCount: chatCount, transcript: transcript,
        });
        i = endIdx + 1;
        continue;
      }

      /* 没有终点信息：只登记发生过，不计时长与条数 */
      out.push({
        key: callKey, charId: charId, type: type,
        startMs: startTs, startedAt: msg.createdAt,
        endMs: startTs, endedAt: msg.createdAt,
        seconds: 0, approximate: false,
        connected: true, interrupted: true,
        unresolved: true, chatCount: 0, transcript: [],
      });
      i += 1;
    }

    return out;
  }

  /* ────────────────────────── 数据加载 ────────────────────────── */

  function loadNotes() {
    return api.db.list(NOTE_COLLECTION, { limit: 500 }).then(function (rows) {
      var map = {};
      (rows || []).forEach(function (r) { if (r && r.callKey) map[r.callKey] = r; });
      state.notes = map;
    }).catch(function () { state.notes = {}; });
  }

  function loadAll() {
    state.loading = true;
    state.sawOrigin = false;
    render();

    return Promise.all([
      api.characters.list(),
      loadNotes().catch(function () {}),
    ]).then(function (res) {
      state.characters = (res[0] || []).slice();
      if (!state.characters.length) {
        state.callsByChar = {}; state.messagesByChar = {};
        state.loading = false; render(); return;
      }
      return state.characters.reduce(function (chain, ch) {
        return chain.then(function () {
          return readAllMessages(ch.id).then(function (r) {
            var msgs = r.messages || [];
            state.messagesByChar[ch.id] = msgs;
            var hasOrigin = false;
            for (var i = 0; i < msgs.length; i += 1) {
              if (msgs[i].origin !== undefined && msgs[i].origin !== null) { hasOrigin = true; break; }
            }
            if (hasOrigin) state.sawOrigin = true;
            state.callsByChar[ch.id] = { calls: extractCalls(msgs, ch.id), truncated: !!r.truncated };
            render();
          }).catch(function () {
            state.callsByChar[ch.id] = { calls: [], truncated: false, failed: true };
            render();
          });
        });
      }, Promise.resolve());
    }).then(function () {
      state.loading = false; render();
    }).catch(function (err) {
      state.loading = false; render();
      toast("读取失败：" + (err && err.message ? err.message : err));
    });
  }

  /** 当前角色筛选下的全部通话（带角色信息，按时间倒序） */
  function allCalls() {
    var list = [];
    state.characters.forEach(function (ch) {
      var box = state.callsByChar[ch.id];
      if (!box) return;
      box.calls.forEach(function (c) {
        list.push(Object.assign({}, c, {
          charName: ch.name, charAvatar: ch.avatar, char: ch,
        }));
      });
    });
    list.sort(function (a, b) { return b.startMs - a.startMs; });
    return list;
  }

  function callsInScope() {
    var list = allCalls();
    if (state.selected === "__all__") return list;
    return list.filter(function (c) { return c.charId === state.selected; });
  }

  /* ────────────────────────── 统计计算 ────────────────────────── */

  function computeStats(calls) {
    var s = {
      total: calls.length, connected: 0, totalSec: 0, longest: 0, longestCall: null,
      msgTotal: 0, voice: 0, video: 0, voiceSec: 0, videoSec: 0,
      missed: 0, unresolved: 0,
      byDay: {},          /* YYYY-MM-DD -> {sec, count, video} */
      byHour: new Array(24).fill(0),
      byWeekday: new Array(7).fill(0),
      avgSec: 0, avgMsg: 0, streakDays: 0, firstAt: 0, lastAt: 0,
    };
    calls.forEach(function (c) {
      if (c.type === "video") s.video += 1; else s.voice += 1;
      if (!c.connected) s.missed += 1;
      if (c.unresolved) s.unresolved += 1;
      if (!c.connected || c.unresolved) return;
      s.connected += 1;
      s.totalSec += c.seconds || 0;
      s.msgTotal += c.chatCount || 0;
      if (c.type === "video") s.videoSec += c.seconds || 0; else s.voiceSec += c.seconds || 0;
      if ((c.seconds || 0) > s.longest) { s.longest = c.seconds; s.longestCall = c; }
      var dk = dayKeyOf(c.startMs);
      if (dk) {
        if (!s.byDay[dk]) s.byDay[dk] = { sec: 0, count: 0, video: 0 };
        s.byDay[dk].sec += c.seconds || 0;
        s.byDay[dk].count += 1;
        if (c.type === "video") s.byDay[dk].video += 1;
      }
      var d = new Date(c.startMs);
      if (!isNaN(d.getTime())) {
        s.byHour[d.getHours()] += 1;
        s.byWeekday[d.getDay()] += 1;
      }
      if (!s.firstAt || c.startMs < s.firstAt) s.firstAt = c.startMs;
      if (c.startMs > s.lastAt) s.lastAt = c.startMs;
    });
    if (s.connected > 0) {
      s.avgSec = s.totalSec / s.connected;
      s.avgMsg = s.msgTotal / s.connected;
    }
    /* 连续通话天数：从最近有通话的一天往回数 */
    var days = Object.keys(s.byDay).sort().reverse();
    if (days.length) {
      var streak = 1;
      for (var i = 1; i < days.length; i += 1) {
        var prev = new Date(days[i - 1] + "T00:00:00");
        var cur = new Date(days[i] + "T00:00:00");
        var diff = Math.round((prev - cur) / 86400000);
        if (diff === 1) streak += 1; else break;
      }
      s.streakDays = streak;
    }
    return s;
  }

  /** 按角色汇总（当前范围内），用于排行榜 */
  function statsByCharacter(calls) {
    var map = {};
    calls.forEach(function (c) {
      if (!map[c.charId]) map[c.charId] = { charId: c.charId, name: c.charName, avatar: c.charAvatar, sec: 0, count: 0, msg: 0 };
      if (!c.connected || c.unresolved) return;
      map[c.charId].sec += c.seconds || 0;
      map[c.charId].count += 1;
      map[c.charId].msg += c.chatCount || 0;
    });
    var arr = Object.keys(map).map(function (k) { return map[k]; });
    arr.sort(function (a, b) { return b.sec - a.sec; });
    return arr;
  }

  /* ────────────────────────── 视图路由 ────────────────────────── */

  function render() {
    var app = $("app");
    $("pageTitle").textContent = state.view === "detail" ? "通话详情" : "通话统计";

    if (state.view === "detail") { app.innerHTML = renderDetail(); bindDetail(); return; }

    var body = "";
    if (state.loading && !allCalls().length) {
      body = '<div class="sk"></div><div class="sk"></div><div class="sk"></div>';
    } else if (!state.characters.length) {
      body = '<div class="empty"><span class="big">👤</span>还没有角色，先创建一个角色再来看看。</div>';
    } else {
      var calls = callsInScope();
      if (state.view === "overview") body = renderOverview(calls);
      else if (state.view === "calendar") body = renderCalendar(calls);
      else body = renderListView(calls);
    }

    app.innerHTML = renderTabsHtml() + renderViewsHtml() + body;
    bindCommon();
    if (state.view === "calendar") bindCalendar();
  }

  function renderTabsHtml() {
    var total = allCalls().length;
    var html = '<div class="tabs">';
    html += tabHtml("__all__", "全部", total);
    state.characters.forEach(function (ch) {
      var box = state.callsByChar[ch.id];
      var n = box ? box.calls.length : 0;
      if (!state.loading && n === 0 && ch.id !== state.selected) return;
      html += tabHtml(ch.id, ch.name || "未命名", n);
    });
    return html + '</div>';
  }

  function tabHtml(id, label, count) {
    var on = state.selected === id ? " on" : "";
    return '<button class="tab' + on + '" data-tab="' + esc(id) + '">' + esc(label)
      + (count ? '<span class="cnt">' + count + '</span>' : '') + '</button>';
  }

  function renderViewsHtml() {
    function v(key, label) {
      return '<button class="' + (state.view === key ? "on" : "") + '" data-view="' + key + '">' + label + '</button>';
    }
    return '<div class="views">' + v("overview", "总览") + v("calendar", "日历") + v("list", "明细") + '</div>';
  }

  function bindCommon() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-tab]"), function (el) {
      el.addEventListener("click", function () {
        state.selected = el.getAttribute("data-tab");
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-view]"), function (el) {
      el.addEventListener("click", function () {
        state.view = el.getAttribute("data-view");
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-call]"), function (el) {
      el.addEventListener("click", function () { openDetail(el.getAttribute("data-call")); });
    });
  }

  /* ────────────────────────── 总览 ────────────────────────── */

  function renderOverview(calls) {
    if (!calls.length) {
      return '<div class="empty"><span class="big">📞</span>还没有通话记录。<br />打过电话之后，这里会给出统计、图表与回看。</div>';
    }
    var s = computeStats(calls);
    var html = '';

    if (!state.sawOrigin) {
      html += '<div class="hint">当前记录都还没有「消息来源」标记（新版本才写入）：通话条数按区间内的全部对话统计，可能略多于实际。新打的电话不受影响。</div>';
    } else if (calls.some(function (c) { return c.unresolved; })) {
      html += '<div class="hint">有 ' + calls.filter(function (c) { return c.unresolved; }).length + ' 通电话没有结束记录，未计入时长统计。到聊天室里长按一条消息选「设为通话结尾」即可补齐；如果连「发起了通话」那条留痕都不在了，再给它标一个「设为通话开头」就能整段圈出来。</div>';
    }

    /* 四宫格核心指标 */
    html += '<div class="grid2">'
      + statCard("通话次数", String(s.total), "次", s.missed ? (s.missed + " 次未接通") : (s.video + " 视频 · " + s.voice + " 语音"))
      + statCard("总时长", s.totalSec ? formatDuration(s.totalSec) : "0", s.totalSec ? "" : "秒", s.connected ? ("平均 " + formatDuration(s.avgSec)) : "")
      + statCard("最长一通", s.longest ? formatDuration(s.longest) : "0", s.longest ? "" : "秒", s.longestCall ? esc(s.longestCall.charName || "") : "")
      + statCard("通话内消息", String(s.msgTotal), "条", s.connected ? ("平均 " + Math.round(s.avgMsg) + " 条/通") : "")
      + '</div>';

    /* 近 14 天时长柱状图 */
    html += '<div class="card"><div class="card-title"><b>近 14 天</b><span>每日通话时长</span></div>'
      + renderBars(s.byDay, 14) + '</div>';

    /* 语音/视频占比环形 */
    html += renderTypeDonut(s);

    /* 时段偏好 */
    html += '<div class="card"><div class="card-title"><b>通话时段</b><span>按开始时间</span></div>'
      + renderHourHeat(s.byHour) + '</div>';

    /* 角色排行 */
    var ranks = statsByCharacter(calls);
    if (ranks.length > 1) {
      html += '<div class="card"><div class="card-title"><b>通话最多的人</b><span>按累计时长</span></div>'
        + renderRanking(ranks) + '</div>';
    }

    return html;
  }

  function statCard(k, v, unit, sub) {
    return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(v)
      + (unit ? '<small>' + esc(unit) + '</small>' : '') + '</div>'
      + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  /** 近 N 天的每日时长柱状图 */
  function renderBars(byDay, days) {
    var cols = [], max = 0;
    var today = new Date();
    for (var i = days - 1; i >= 0; i -= 1) {
      var d = new Date(today.getTime());
      d.setDate(d.getDate() - i);
      var key = ymd(d);
      var rec = byDay[key] || { sec: 0, count: 0, video: 0 };
      if (rec.sec > max) max = rec.sec;
      cols.push({ key: key, d: d, sec: rec.sec, count: rec.count, isToday: i === 0 });
    }
    if (!max) max = 1;
    var html = '<div class="bars">';
    cols.forEach(function (c) {
      var h = c.sec ? Math.max(4, Math.round((c.sec / max) * 82)) : 0;
      html += '<div class="col' + (c.isToday ? ' today' : '') + '" title="' + c.key + ' · ' + (c.sec ? formatDuration(c.sec) : '未接通') + '">'
        + '<div class="bar" style="height:' + h + 'px"></div>'
        + '<div class="lab">' + (c.d.getDate()) + '</div>'
        + '</div>';
    });
    return html + '</div>';
  }

  /** 语音 / 视频 占比环形图（纯 SVG，无依赖）：中心显示语音占比 */
  function renderTypeDonut(s) {
    var totalSec = s.voiceSec + s.videoSec;
    var vPct = totalSec ? (s.voiceSec / totalSec) : 0;
    var R = 42, C = 2 * Math.PI * R;
    var dash = (C * vPct).toFixed(2);
    var pctText = totalSec ? Math.round(vPct * 100) + "%" : "—";
    var html = '<div class="card"><div class="card-title"><b>通话类型</b><span>按时长占比</span></div>'
      + '<div class="donut-wrap">'
      + '<div class="donut">'
      + '<svg viewBox="0 0 104 104" style="width:100%;height:100%;display:block">'
      + '<circle cx="52" cy="52" r="' + R + '" fill="none" stroke="var(--video)" stroke-width="10" />'
      + (totalSec
          ? '<circle cx="52" cy="52" r="' + R + '" fill="none" stroke="var(--voice)" stroke-width="10" '
            + 'stroke-dasharray="' + dash + ' ' + (C - dash) + '" stroke-linecap="butt" transform="rotate(-90 52 52)" />'
          : '')
      + '</svg>'
      + '<div class="center"><b>' + pctText + '</b><span>' + (totalSec ? '语音占比' : '暂无数据') + '</span></div>'
      + '</div>'
      + '<div class="legend">'
      + '<div class="li"><span class="sw" style="background:var(--voice)"></span><span class="nm">语音通话</span><span class="vl">' + (s.voiceSec ? formatDuration(s.voiceSec) : "0") + '</span></div>'
      + '<div class="li"><span class="sw" style="background:var(--video)"></span><span class="nm">视频通话</span><span class="vl">' + (s.videoSec ? formatDuration(s.videoSec) : "0") + '</span></div>'
      + '<div class="li"><span class="sw" style="background:var(--muted);opacity:.35"></span><span class="nm">合计</span><span class="vl">' + (totalSec ? formatDuration(totalSec) : "0") + '</span></div>'
      + '</div></div></div>';
    return html;
  }

  /** 24 小时热度条：一眼看出你们习惯什么时候打电话 */
  function renderHourHeat(byHour) {
    var max = Math.max.apply(null, byHour.concat([1]));
    var html = '<div style="display:flex;gap:2px;align-items:flex-end;height:52px;margin-bottom:6px">';
    for (var h = 0; h < 24; h += 1) {
      var v = byHour[h];
      var ht = v ? Math.max(3, Math.round((v / max) * 44)) : 2;
      html += '<div style="flex:1;height:' + ht + 'px;border-radius:2px;background:' + (v ? 'var(--accent)' : 'var(--card2)') + '" title="' + h + ':00 附近 ' + v + ' 通"></div>';
    }
    html += '</div><div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted)">'
      + '<span>0点</span><span>6点</span><span>12点</span><span>18点</span><span>23点</span></div>';
    var best = 0;
    for (var i = 1; i < 24; i += 1) if (byHour[i] > byHour[best]) best = i;
    if (byHour[best] > 0) {
      html += '<div style="font-size:12px;color:var(--muted);margin-top:8px">最常在 <b style="color:var(--text)">' + best + ':00–' + ((best + 1) % 24) + ':00</b> 通话（' + byHour[best] + ' 通）</div>';
    }
    return html;
  }

  function renderRanking(ranks) {
    var max = ranks.length ? ranks[0].sec : 1;
    if (!max) max = 1;
    var html = '<div class="rank">';
    ranks.slice(0, 6).forEach(function (r) {
      html += '<div class="r">'
        + avatarHtml({ name: r.name, avatar: r.avatar }, 'av')
        + '<div class="info"><div class="nm">' + esc(r.name || "未命名") + '</div>'
        + '<div class="track"><div class="fill" style="width:' + Math.round((r.sec / max) * 100) + '%"></div></div></div>'
        + '<div class="dd">' + formatDuration(r.sec) + '<br><span style="font-size:10.5px">' + r.count + ' 通</span></div>'
        + '</div>';
    });
    return html + '</div>';
  }

  /* ────────────────────────── 日历视图 ────────────────────────── */

  function renderCalendar(calls) {
    var now = new Date();
    if (!state.calMonth) state.calMonth = { y: now.getFullYear(), m: now.getMonth() };
    var y = state.calMonth.y, m = state.calMonth.m;

    var byDay = {};
    calls.forEach(function (c) {
      var k = dayKeyOf(c.startMs);
      if (!k) return;
      if (!byDay[k]) byDay[k] = [];
      byDay[k].push(c);
    });

    var first = new Date(y, m, 1);
    var startWeekday = first.getDay();
    var daysInMonth = new Date(y, m + 1, 0).getDate();
    var todayKey = ymd(now);
    var monthTotal = 0, monthCount = 0;

    var cells = '';
    for (var b = 0; b < startWeekday; b += 1) cells += '<div class="cal-cell blank"></div>';
    for (var d = 1; d <= daysInMonth; d += 1) {
      var dt = new Date(y, m, d);
      var key = ymd(dt);
      var recs = byDay[key] || [];
      var daySec = 0, hasVideo = false;
      recs.forEach(function (c) {
        if (c.connected && !c.unresolved) daySec += c.seconds || 0;
        if (c.type === "video") hasVideo = true;
      });
      monthTotal += daySec; monthCount += recs.length;
      var cls = "cal-cell";
      if (recs.length) cls += " has";
      if (key === todayKey) cls += " today";
      if (state.calDay === key) cls += " sel";
      cells += '<button class="' + cls + '" data-cal-day="' + key + '">'
        + '<span>' + d + '</span>'
        + (recs.length ? '<span class="dot' + (hasVideo ? " v" : "") + '"></span>' : '')
        + (daySec ? '<span style="font-size:8.5px;opacity:.8">' + shortDuration(daySec) + '</span>' : '')
        + '</button>';
    }

    var head = '<div class="card">'
      + '<div class="cal-head">'
      + '<div class="ym">' + y + " 年 " + (m + 1) + ' 月</div>'
      + '<div class="nav">'
      + '<button data-cal-nav="prev">‹</button>'
      + '<button data-cal-nav="today">今</button>'
      + '<button data-cal-nav="next">›</button>'
      + '</div></div>'
      + '<div class="cal-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>'
      + '<div class="cal-grid">' + cells + '</div>'
      + '<div style="font-size:12px;color:var(--muted);margin-top:12px;text-align:center">本月 ' + monthCount + ' 通'
      + (monthTotal ? ' · 共 ' + formatDuration(monthTotal) : '') + '</div>'
      + '</div>';

    var dayList = "";
    if (state.calDay) {
      var dayCalls = byDay[state.calDay] || [];
      dayList = '<div class="card"><div class="card-title"><b>' + esc(prettyDay(state.calDay)) + '</b><span>'
        + dayCalls.length + ' 通</span></div>'
        + (dayCalls.length ? '<div class="list">' + dayCalls.map(rowHtml).join("") + '</div>'
          : '<div class="empty" style="padding:24px">这天没有通话</div>')
        + '</div>';
    } else {
      dayList = '<div class="card"><div class="card-title"><b>最近通话</b><span>点日期看当天</span></div>'
        + '<div class="list">' + calls.slice(0, 5).map(rowHtml).join("") + '</div></div>';
    }

    return head + dayList;
  }

  function prettyDay(key) {
    var d = new Date(key + "T00:00:00");
    if (isNaN(d.getTime())) return key;
    var now = new Date();
    if (key === ymd(now)) return "今天 · " + (d.getMonth() + 1) + "月" + d.getDate() + "日";
    var wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
    return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + wd;
  }

  /* ────────────────────────── 明细列表 ────────────────────────── */

  function renderListView(calls) {
    if (!calls.length) {
      return '<div class="empty"><span class="big">📞</span>还没有通话记录。<br />打过电话之后，这里会列出每一通。</div>';
    }
    var groups = [], curKey = null, cur = null;
    calls.forEach(function (c) {
      var k = dayKeyOf(c.startMs);
      if (k !== curKey) { cur = { key: k, items: [] }; groups.push(cur); curKey = k; }
      cur.items.push(c);
    });
    var html = '';
    groups.forEach(function (g) {
      var sec = 0;
      g.items.forEach(function (c) { if (c.connected && !c.unresolved) sec += c.seconds || 0; });
      html += '<div class="card"><div class="card-title"><b>' + esc(prettyDay(g.key)) + '</b><span>'
        + g.items.length + ' 通' + (sec ? ' · ' + formatDuration(sec) : '') + '</span></div>'
        + '<div class="list">' + g.items.map(rowHtml).join("") + '</div></div>';
    });
    return html;
  }

  function rowHtml(call) {
    var isVideo = call.type === "video";
    var icon = isVideo ? "🎥" : "📞";
    var name = call.charName || "未知角色";
    var label = isVideo ? "视频通话" : "语音通话";

    var tags = [];
    var note = state.notes[call.key];
    if (note && (note.note || note.aiSummary)) tags.push('<span class="tag ai">有总结</span>');
    if (call.unresolved) tags.push('<span class="tag">待标记结尾</span>');
    else if (!call.connected) tags.push('<span class="tag gray">未接来电</span>');

    var durText = call.unresolved ? "—"
      : call.seconds ? ((call.approximate ? "≈" : "") + formatDuration(call.seconds))
      : (call.connected ? "未知" : "—");
    var subText = call.unresolved ? "未计入" : (call.chatCount + " 条消息");

    return '<button class="row" data-call="' + esc(call.key) + '">'
      + '<div class="dot-ico ' + (isVideo ? "video" : "voice") + '">' + icon + '</div>'
      + '<div class="mid">'
      + '<div class="l1"><span class="who">' + esc(name) + '</span>' + tags.join("") + '</div>'
      + '<div class="l2">' + esc(label) + " · " + esc(formatWhen(call.startedAt)) + '</div>'
      + '</div>'
      + '<div class="dur">' + esc(durText) + '<span>' + esc(subText) + '</span></div>'
      + '</button>';
  }

  /* ────────────────────────── 详情页 ────────────────────────── */

  function findCall(key) {
    var found = null;
    allCalls().forEach(function (c) { if (c.key === key) found = c; });
    return found;
  }

  function openDetail(key) {
    var call = findCall(key);
    if (!call) { toast("找不到这条通话"); return; }
    state.detail = call;
    state.view = "detail";
    window.scrollTo(0, 0);
    render();
  }

  function renderDetail() {
    var c = state.detail;
    if (!c) return '<div class="empty">通话不存在</div>';
    var note = state.notes[c.key] || {};
    var isVideo = c.type === "video";

    var html = '<button class="btn" id="detailBack" style="margin-bottom:12px">‹ 返回统计</button>';

    html += '<div class="detail-head">'
      + avatarHtml(c.char, 'av')
      + '<div class="meta"><div class="nm">' + esc(c.charName || "未知角色") + '</div>'
      + '<div class="sm">' + (isVideo ? "视频通话" : "语音通话") + " · " + esc(formatWhen(c.startedAt)) + '</div></div>'
      + '</div>';

    var durText = c.unresolved ? "无结束记录"
      : c.seconds ? ((c.approximate ? "≈" : "") + formatDuration(c.seconds))
      : (c.connected ? "未知" : "未接通");
    html += '<div class="grid2">'
      + statCard("时长", durText, "", c.connected && c.endMs > c.startMs ? (formatClock(c.startedAt) + " – " + formatClock(c.endedAt)) : "")
      + statCard("对话", String(c.chatCount), "条", c.seconds && c.chatCount ? ("约 " + Math.round(c.seconds / c.chatCount) + " 秒/条") : "")
      + '</div>';

    /* 完整对话回看（角色的话可点小喇叭复听） */
    var speakable = c.transcript.filter(function (t) { return !t.sys && t.role === "assistant"; }).length;
    html += '<div class="card"><div class="card-title"><b>通话内容</b><span>共 ' + c.transcript.length + ' 条</span></div>';
    if (!c.transcript.length) {
      html += '<div class="empty" style="padding:22px">这段通话没有可回看的对话内容。' + (c.unresolved ? '<br>（没有结束记录，未纳入统计）' : '') + '</div>';
    } else {
      html += '<div class="transcript">' + c.transcript.map(function (t) {
        return transcriptHtml(t, c);
      }).join("") + '</div>';
      if (speakable) {
        var withOrigin = c.transcript.filter(function (t) { return t.audioRef; }).length;
        html += '<div class="speak-hint">角色的话点右下角 🔈 复听。' + (withOrigin === speakable
          ? '这些都是通话当时的原音留档，点开即放。'
          : (withOrigin === 0
            ? '这些记录没有原音留档（旧版本打的电话），会按原句重新合成，音色语气可能略有出入。'
            : '其中 ' + withOrigin + ' 条是通话原音，其余没有留档、会重新合成。'))
          + '留档默认保留最近 30 天，超期自动清理。</div>';
      }
    }
    html += '</div>';

    /* 我的总结 */
    html += '<div class="card"><div class="card-title"><b>我的总结</b><span>随时可写</span></div>'
      + '<textarea class="note-area" id="myNote" placeholder="这通电话聊了什么、你想记住什么…">' + esc(note.note || "") + '</textarea>'
      + '<div class="btn-row"><button class="btn primary" id="saveNote">保存总结</button>'
      + (note.note ? '<button class="btn" id="clearNote">清空</button>' : '')
      + '</div></div>';

    /* AI 总结 */
    html += '<div class="card"><div class="card-title"><b>AI 总结</b><span>基于本通对话</span></div>';
    if (note.aiSummary) {
      html += '<div class="ai-out"><div class="hd">通话内容概要</div>' + esc(note.aiSummary) + '</div>';
    }
    html += '<div class="btn-row"><button class="btn ' + (note.aiSummary ? "" : "primary") + '" id="genSummary"' + (c.transcript.length ? "" : " disabled") + '>'
      + (state.busy ? "生成中…" : (note.aiSummary ? "重新生成" : "生成通话总结")) + '</button></div>';
    html += '</div>';

    /* 角色感受 */
    html += '<div class="card"><div class="card-title"><b>' + esc(c.charName || "角色") + ' 的感受</b><span>以角色口吻</span></div>';
    if (note.aiFeeling) {
      html += '<div class="ai-out"><div class="hd">' + esc(c.charName || "角色") + ' 说</div>' + esc(note.aiFeeling) + '</div>';
    }
    html += '<div class="btn-row"><button class="btn ' + (note.aiFeeling ? "" : "primary") + '" id="genFeeling"'
      + (c.transcript.length ? "" : " disabled") + '>' + (state.busy ? "生成中…" : (note.aiFeeling ? "重新生成" : "让TA说点感受")) + '</button></div>';
    html += '</div>';

    return html;
  }

  function transcriptHtml(t, call) {
    if (t.sys) {
      return '<div class="tr sys"><div class="bub">' + esc(t.content) + '</div></div>';
    }
    var cls = t.role === "user" ? "r-user" : "r-assistant";
    var isCharacter = t.role === "assistant";
    var speaking = state.playingId === t.id;
    var loading = state.speakingId === t.id;
    var btn = isCharacter
      ? '<button class="speak-btn' + (speaking || loading ? ' on' : '') + '" data-speak="' + esc(t.id) + '"'
        + (loading ? ' disabled' : '') + ' title="复听">' + (loading ? '…' : (speaking ? '❚❚' : '🔈')) + '</button>'
      : '';
    return '<div class="tr ' + cls + '"><div class="bub">' + esc(t.content) + '</div>'
      + '<div class="tm"><span>' + esc(formatClock(t.at)) + '</span>' + btn + '</div></div>';
  }

  function bindDetail() {
    var back = $("detailBack");
    if (back) back.addEventListener("click", function () {
      stopSpeech();
      state.view = "list"; state.detail = null; render();
    });

    var saveBtn = $("saveNote");
    if (saveBtn) saveBtn.addEventListener("click", function () {
      var v = ($("myNote") || {}).value || "";
      saveNoteField("note", v.trim());
    });

    var clearBtn = $("clearNote");
    if (clearBtn) clearBtn.addEventListener("click", function () {
      var ta = $("myNote"); if (ta) ta.value = "";
      saveNoteField("note", "");
    });

    var gs = $("genSummary");
    if (gs) gs.addEventListener("click", function () { void generateSummary(false); });
    var gf = $("genFeeling");
    if (gf) gf.addEventListener("click", function () { void generateSummary(true); });

    Array.prototype.forEach.call(document.querySelectorAll("[data-speak]"), function (el) {
      el.addEventListener("click", function () { void replayMessage(el.getAttribute("data-speak")); });
    });
  }

  /* ────────────────────── 复听（按原句重新合成） ────────────────────── */

  var speechCache = {};   /* messageId -> dataUrl，本次打开 APP 内复用 */
  var currentAudio = null;

  function stopSpeech() {
    state.playingId = null;
    state.speakingId = null;
    if (currentAudio && currentAudio.audio) {
      try { currentAudio.audio.pause(); } catch (e) {}
      currentAudio = null;
    }
    if (api && api.voice && api.voice.stopPlayback) {
      try { api.voice.stopPlayback({}); } catch (e) {}
    }
    var btn = $("stopBtn");
    if (btn) btn.style.display = "none";
  }

  function replayMessage(id) {
    var c = state.detail;
    if (!c) return;

    /* 再点一次正在播的那条 → 停止 */
    if (state.playingId === id) {
      stopSpeech();
      render();
      return;
    }
    stopSpeech();

    var item = null;
    for (var i = 0; i < c.transcript.length; i += 1) {
      if (c.transcript[i].id === id) { item = c.transcript[i]; break; }
    }
    if (!item || !item.content) return;

    /* 已是「[图片] xxx」这类占位文本的，读出来没意义 */
    var text = String(item.content).replace(/^\[(图片|表情|红包|转账|语音)\]\s*/, "").trim();
    if (!text) { toast("这条没有可朗读的文字"); return; }

    /* 优先放原音：通话屏把当时合成的音频存进媒体库，引用挂在这条消息上。
     * 宿主代播 voice.play 支持 media-store:// 引用（音频不过通信桥），听到的
     * 就是当时那一句——音色、语速、情绪完全一致，也不重复烧语音额度。 */
    if (item.audioRef) {
      playDataUrl(item.audioRef, id, true);
      return;
    }

    /* 老记录没有留档（或留档已被保留策略清理），退回现场重新合成。 */
    var cached = speechCache[id];
    if (cached) { playDataUrl(cached, id); return; }

    if (!api || !api.voice || !api.voice.tts) { toast("这条没有原音留档，当前环境也不支持重新合成"); return; }
    state.speakingId = id;
    render();

    api.voice.tts({ characterId: c.charId, text: text }).then(function (res) {
      if (state.speakingId !== id) return;
      state.speakingId = null;
      var dataUrl = res && res.dataUrl;
      if (!dataUrl) { render(); toast("合成失败，请检查语音配置"); return; }
      speechCache[id] = dataUrl;
      playDataUrl(dataUrl, id);
    }).catch(function (e) {
      state.speakingId = null;
      render();
      var msg = e && e.message ? e.message : String(e || "");
      toast(/voice|tts|profile|config/i.test(msg) ? "没有可用的语音配置，先去设置里绑定音色" : ("合成失败：" + msg));
    });
  }

  function playDataUrl(dataUrl, id, isOrigin) {
    state.playingId = id;
    state.speakingId = null;
    state.playingOrigin = !!isOrigin;
    render();
    var btn = $("stopBtn");
    if (btn) btn.style.display = "";

    /* 宿主代播：iOS 上自建 <audio> 会踩媒体会话的坑，统一走 voice.play */
    if (api && api.voice && api.voice.play) {
      Promise.resolve(api.voice.play({ dataUrl: dataUrl })).then(function () {
        if (state.playingId === id) { state.playingId = null; render(); }
        var b = $("stopBtn"); if (b) b.style.display = "none";
      }).catch(function (e) {
        state.playingId = null;
        render();
        var b = $("stopBtn"); if (b) b.style.display = "none";
        toast("播放失败：" + (e && e.message ? e.message : e));
      });
      currentAudio = { id: id, audio: null };
      return;
    }

    /* 兜底：环境没提供宿主代播时用普通 Audio */
    try {
      var audio = new Audio(dataUrl);
      currentAudio = { id: id, audio: audio };
      audio.onended = function () {
        if (state.playingId === id) { state.playingId = null; render(); }
        var b = $("stopBtn"); if (b) b.style.display = "none";
      };
      audio.onerror = function () {
        state.playingId = null; render();
        var b = $("stopBtn"); if (b) b.style.display = "none";
        toast("播放失败");
      };
      void audio.play();
    } catch (e) {
      state.playingId = null;
      render();
      toast("播放失败");
    }
  }

  /* ────────────────────────── 备注 / AI 总结持久化 ────────────────────────── */

  function saveNoteField(field, value) {
    var c = state.detail;
    if (!c) return Promise.resolve();
    var existing = state.notes[c.key];
    var next = Object.assign({}, existing, { callKey: c.key, charId: c.charId });
    if (value) next[field] = value; else delete next[field];
    next.updatedAt = new Date().toISOString();

    function done() {
      state.notes[c.key] = next;
      toast(value ? "已保存" : "已清空");
      render();
    }

    if (existing && existing.id) {
      return api.db.update(NOTE_COLLECTION, existing.id, next).then(done).catch(function (e) {
        toast("保存失败：" + (e && e.message ? e.message : e));
      });
    }
    return api.db.create(NOTE_COLLECTION, next).then(function (created) {
      next.id = created && created.id;
      done();
    }).catch(function (e) {
      toast("保存失败：" + (e && e.message ? e.message : e));
    });
  }

  /** 把本通对话拼成给 AI 的文本（控制长度，太长只保留首尾） */
  function buildTranscriptText(c) {
    var lines = [];
    var who = c.charName || "对方";
    var arr = c.transcript;
    var MAX = 80;
    var picked = arr;
    if (arr.length > MAX) {
      var head = arr.slice(0, 40);
      var tail = arr.slice(arr.length - 40);
      picked = head.concat([{ role: "sys", content: "（中间省略 " + (arr.length - MAX) + " 条）", sys: true }], tail);
    }
    picked.forEach(function (t) {
      if (t.sys) { lines.push(t.content); return; }
      lines.push((t.role === "user" ? "我" : who) + "：" + t.content);
    });
    return lines.join("\n");
  }

  function generateSummary(asFeeling) {
    var c = state.detail;
    if (!c || state.busy) return;
    if (!c.transcript.length) { toast("这通电话没有可总结的对话"); return; }
    state.busy = true;
    render();

    var transcript = buildTranscriptText(c);
    var name = c.charName || "对方";
    var instruction = asFeeling
      ? "以上是你（" + name + "）刚刚和对方结束的一通电话记录。请以「" + name + "」的第一人称，写下你对这通电话的真实感受：聊得怎么样、心里什么感觉、有什么想说的。2-4 句，语气自然口语化，不要复述对话、不要写成总结报告，直接输出你要说的话。"
      : "以上是一通电话的完整记录。请把它概括成一段简洁的通话小结：主要聊了什么、气氛如何、有没有值得记住的事。2-3 句，客观平实，不要复述原话。";

    api.ai.generate({
      characterId: c.charId,
      appTags: ["chat", "text"],
      instruction: instruction + "\n\n【通话记录】\n" + transcript,
    }).then(function (res) {
      var text = (res && res.text || "").trim();
      state.busy = false;
      if (!text) { render(); toast("AI 没有返回内容"); return; }
      saveNoteField(asFeeling ? "aiFeeling" : "aiSummary", text);
    }).catch(function (e) {
      state.busy = false;
      render();
      toast("生成失败：" + (e && e.message ? e.message : e));
    });
  }

  /* ── 日历的补充绑定 ── */
  function bindCalendar() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-cal-nav]"), function (el) {
      el.addEventListener("click", function () {
        var act = el.getAttribute("data-cal-nav");
        var now = new Date();
        if (act === "today") {
          state.calMonth = { y: now.getFullYear(), m: now.getMonth() };
          state.calDay = ymd(now);
        } else {
          var y = state.calMonth.y, m = state.calMonth.m + (act === "next" ? 1 : -1);
          if (m < 0) { m = 11; y -= 1; }
          if (m > 11) { m = 0; y += 1; }
          state.calMonth = { y: y, m: m };
        }
        render();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-cal-day]"), function (el) {
      el.addEventListener("click", function () {
        var key = el.getAttribute("data-cal-day");
        state.calDay = state.calDay === key ? null : key;
        render();
      });
    });
  }
  /* ────────────────────────── 主题 ────────────────────────── */

  var THEME_KEY = "call-stats-theme";

  /* 可选主题：id 对应 html[data-theme]，sw 是选择面板里的色板预览 */
  var THEMES = [
    { id: "dark",    name: "默认深色", desc: "纯黑蓝", sw: ["#0d0f14", "#5b8cff", "#34d399", "#a78bfa"] },
    { id: "light",   name: "默认浅色", desc: "清爽白", sw: ["#f4f6fa", "#3b74f0", "#10a37f", "#7c5cf0"] },
    { id: "galaxy",  name: "星夜",     desc: "深空紫", sw: ["#0a0d1c", "#7b8cff", "#45d0c0", "#b98cff"] },
    { id: "ocean",   name: "海盐",     desc: "蓝青",   sw: ["#f0f7fa", "#2e8fc0", "#2fa48b", "#6a7fd6"] },
    { id: "macaron", name: "马卡龙",   desc: "粉紫奶糖", sw: ["#fdf7fb", "#d974a4", "#6fbfa5", "#9b8ee8"] },
    { id: "morandi", name: "莫兰迪",   desc: "低饱和灰", sw: ["#eef0ec", "#7f9c84", "#8fb1a2", "#949cc0"] },
    { id: "peach",   name: "蜜桃",     desc: "暖橙奶", sw: ["#fff7f1", "#e57f4b", "#3f9f86", "#b585d6"] },
    { id: "matcha",  name: "抹茶",     desc: "淡雅青绿", sw: ["#f3f8f1", "#4f9d5d", "#2f9a8a", "#7d86c9"] }
  ];
  var THEME_IDS = THEMES.map(function (t) { return t.id; });

  function currentTheme() {
    var v = document.documentElement.getAttribute("data-theme");
    return THEME_IDS.indexOf(v) >= 0 ? v : "dark";
  }

  /* 主题选择的持久化。
   *
   * 不能用 localStorage：APP 跑在 sandbox="allow-scripts" 的 iframe 里（不透明源），
   * 浏览器会直接拒绝访问 localStorage 并抛 SecurityError。过去外面套了 try/catch，
   * 异常被吞掉——看着没报错，其实一次都没存上，于是每次进 APP 都要重选配色。
   * 正确的做法是存进宿主给 APP 的私有数据库（api.db），它跨会话保留。 */
  var THEME_COLLECTION = "app_settings";
  var themeRowId = null;   /* 已存记录的 id，用于后续 update */

  function persistTheme(mode) {
    var row = { key: "theme", mode: mode, updatedAt: new Date().toISOString() };
    if (!api || !api.db) return;
    if (themeRowId) {
      api.db.update(THEME_COLLECTION, themeRowId, row).catch(function () { themeRowId = null; });
      return;
    }
    api.db.create(THEME_COLLECTION, row).then(function (created) {
      themeRowId = created && created.id;
    }).catch(function () {
      /* 可能已存在同名记录：列出来认领 */
      api.db.list(THEME_COLLECTION, { limit: 20 }).then(function (rows) {
        var found = null;
        (rows || []).forEach(function (r) { if (r && r.key === "theme") found = r; });
        if (found && found.id) themeRowId = found.id;
      }).catch(function () {});
    });
  }

  /** 设色。skipPersist=true 用于「从存储读回来后上色」，避免又写一遍。 */
  function applyTheme(mode, skipPersist) {
    if (THEME_IDS.indexOf(mode) < 0) mode = "dark";
    document.documentElement.setAttribute("data-theme", mode);
    if (!skipPersist) persistTheme(mode);
  }

  function initTheme() {
    var saved = null;
    if (!saved || THEME_IDS.indexOf(saved) < 0) {
      saved = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "light" : "dark";
    }
    applyTheme(saved, true);   /* 先用默认快速上色，读到存储后再换 */

    if (!api || !api.db) return;
    api.db.list(THEME_COLLECTION, { limit: 20 }).then(function (rows) {
      var found = null;
      (rows || []).forEach(function (r) { if (r && r.key === "theme") found = r; });
      if (!found || THEME_IDS.indexOf(found.mode) < 0) return;
      themeRowId = found.id;
      applyTheme(found.mode, true);
      render();
    }).catch(function () {});
  }

  /* ── 主题选择面板 ── */
  function openThemePicker() {
    var old = $("themePicker");
    if (old) { old.remove(); return; }
    var cur = currentTheme();
    var panel = document.createElement("div");
    panel.id = "themePicker";
    panel.style.cssText = "position:fixed;z-index:40;top:calc(var(--ai-phone-app-bar-top,56px) + 42px);right:14px;"
      + "width:238px;max-height:62vh;overflow:auto;background:var(--card);border:1px solid var(--line);"
      + "border-radius:16px;box-shadow:var(--shadow);padding:8px;";
    var html = '<div style="font-size:11.5px;color:var(--muted);padding:4px 8px 8px;letter-spacing:.3px">选择配色</div>';
    THEMES.forEach(function (t) {
      var on = t.id === cur;
      var sw = t.sw.map(function (c) {
        return '<span style="display:block;width:11px;height:11px;border-radius:4px;background:' + c + ';border:1px solid rgba(128,128,128,.25)"></span>';
      }).join("");
      html += '<button data-theme-pick="' + t.id + '" style="width:100%;display:flex;align-items:center;gap:10px;padding:8px 9px;'
        + 'border-radius:11px;text-align:left;' + (on ? 'background:var(--accent-soft);' : '') + '">'
        + '<span style="display:flex;gap:3px;flex:0 0 auto">' + sw + '</span>'
        + '<span style="flex:1 1 auto;min-width:0">'
        + '<span style="display:block;font-size:13px;font-weight:650;color:' + (on ? 'var(--accent)' : 'var(--text)') + '">' + t.name + '</span>'
        + '<span style="display:block;font-size:10.5px;color:var(--muted)">' + t.desc + '</span>'
        + '</span>'
        + (on ? '<span style="font-size:12px;color:var(--accent)">✓</span>' : '')
        + '</button>';
    });
    panel.innerHTML = html;
    document.body.appendChild(panel);

    panel.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest("[data-theme-pick]") : null;
      if (!btn) return;
      applyTheme(btn.getAttribute("data-theme-pick"));   /* 会写进 APP 私有数据库 */
      panel.remove();
      render();   /* 图表用 CSS 变量取色，重绘一次保证取到新色 */
    });

    setTimeout(function () {
      function away(ev) {
        if (!panel.contains(ev.target) && ev.target !== $("themeBtn")) {
          panel.remove();
          document.removeEventListener("pointerdown", away, true);
        }
      }
      document.addEventListener("pointerdown", away, true);
    }, 0);
  }

  /* ────────────────────────── 启动 ────────────────────────── */

  function boot() {
    if (!api || !api.chat || !api.characters) {
      $("app").innerHTML = '<div class="empty">当前环境不支持所需接口。</div>';
      return;
    }
    initTheme();

    $("themeBtn").addEventListener("click", function () { openThemePicker(); });

    var stopBtn = $("stopBtn");
    if (stopBtn) stopBtn.addEventListener("click", function () { stopSpeech(); render(); });

    $("refreshBtn").addEventListener("click", function () {
      var btn = $("refreshBtn");
      btn.disabled = true;
      btn.textContent = "读取中";
      stopSpeech();
      state.view = state.view === "detail" ? "list" : state.view;
      state.detail = null;
      loadAll().then(function () {
        btn.disabled = false;
        btn.textContent = "刷新";
      });
    });

    Promise.resolve()
      .then(function () { return api.app && api.app.getLaunchContext ? api.app.getLaunchContext() : null; })
      .catch(function () { return null; })
      .then(function (ctx) {
        if (ctx && ctx.characterId) state.selected = ctx.characterId;
        return loadAll();
      });
  }

  boot();
})();
</script>
</body>
</html>`;
