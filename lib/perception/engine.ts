"use client";

/**
 * 感知引擎：采样 → 门控 → 投递。
 *
 * 这是整套感知系统的**唯一决策点**。原生只给原始值，本模块决定
 * 「这个变化算不算一个事件」。把决策放这里而不是原生，是为了让
 * 阈值、开关、限流都能随网页部署即时生效，不必为调一个数字重编 APK。
 *
 * 信号出口只有一个：现实桥 processBridgeItem()。复用它的规则引擎、
 * 冷却与流水，刻意不新建平行系统——否则每加一个能力都要重写一遍投递逻辑。
 *
 * 五道闸（按顺序，任一不过就不产生信号）：
 *   ① 总开关 / 逐能力开关
 *   ② 安静时段（复用推送的安静时段设置）
 *   ③ 变化阈值（电量变动够不够大、停留够不够久）
 *   ④ 去重（同一个值不变不发、同一段停留只发一次）
 *   ⑤ 每小时上限（保护 token 预算）
 */

import { isWithinPushQuietHours } from "../push-client";
import { processBridgeItem } from "../reality-bridge/engine";
import type { BridgeItem } from "../reality-bridge/types";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";
import {
  hasPerceptionBridge,
  readAppLabel,
  readLocation,
  readPerceptionSnapshot,
  readSleep,
  readUsageStats,
  refreshHealth,
  refreshLocation,
  supportsHealth,
  supportsLocation,
  supportsUsageStats,
} from "./bridge";
import { syncPerceptionToCloud } from "./cloud-sync";
import {
  appendPerceptionLog,
  isCapabilityEnabled,
  loadPerceptionConfig,
  loadPerceptionState,
  loadPerceptionStatus,
  savePerceptionState,
  savePerceptionStatus,
  type PerceptionRuntimeState,
} from "./storage";
import type { AppUsageEntry, PerceptionCapability, PerceptionConfig, PerceptionSignal } from "./types";

const HOUR_MS = 60 * 60 * 1000;

let timer: number | null = null;
let unsubscribeForeground: (() => void) | null = null;
let unsubscribeVisibility: (() => void) | null = null;
let running = false;

/** 引擎是否在运行（诊断面板读） */
export function isPerceptionRunning(): boolean {
  return running;
}

// ── 限流窗口 ──

function takeRateLimitSlot(state: PerceptionRuntimeState, limit: number): boolean {
  const now = Date.now();
  if (!state.hourWindowStart || now - state.hourWindowStart >= HOUR_MS) {
    state.hourWindowStart = now;
    state.hourCount = 0;
  }
  if (state.hourCount >= limit) return false;
  state.hourCount += 1;
  return true;
}

// ── 投递 ──

/**
 * 统一的信号投递口。所有门控都在这里，各能力的采样代码只管构造信号。
 *
 * 返回值是「门控结论」或投递结果摘要，写进流水供诊断面板展示——
 * 用户能看到「信号有，但被哪道闸拦下了」，而不是对着没反应的面板猜。
 */
async function emitSignal(
  signal: PerceptionSignal,
  state: PerceptionRuntimeState,
): Promise<boolean> {
  const config = loadPerceptionConfig();

  const record = (outcome: string, skipped?: string) => {
    appendPerceptionLog({
      id: `per_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      at: new Date().toISOString(),
      capability: signal.capability,
      type: signal.type,
      payload: signal.payload,
      outcome,
      skipped,
    });
  };

  // ① 总开关 + 逐能力开关
  if (!config.enabled) return false;
  if (!isCapabilityEnabled(config, signal.capability)) {
    record("未投递", "该能力已关闭");
    return false;
  }
  // ② 安静时段
  if (config.respectQuietHours && isWithinPushQuietHours(Date.now())) {
    record("未投递", "处于安静时段");
    return false;
  }
  // ⑤ 每小时上限
  if (!takeRateLimitSlot(state, config.hourlyLimit)) {
    record("未投递", `已达每小时上限（${config.hourlyLimit} 条）`);
    return false;
  }

  // 投递给现实桥：复用它的规则匹配、加工、动作、冷却与流水。
  // 用 void 而不是 await：规则动作可能触发 LLM 生成（几秒到几十秒），
  // 不能让采样循环被它拖住。
  const item: BridgeItem = {
    id: `perception_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    type: signal.type,
    payload: signal.payload,
    createdAt: new Date().toISOString(),
  };
  void processBridgeItem(item)
    .then(entry => {
      const outcome = entry.actions.length ? entry.actions.join("、") : "已处理";
      // 「仅存档（无匹配规则）」是最常见的困惑来源：信号确实产生了，
      // 只是用户还没在现实桥里配规则。单独计数，面板里给一条引导。
      if (entry.actions.some(action => action.includes("无匹配规则"))) {
        state.unmatchedSignals += 1;
        savePerceptionState(state);
      }
      record(outcome, entry.error);
    })
    .catch(err => {
      record("投递失败", err instanceof Error ? err.message : String(err));
    });
  return true;
}

// ── 采样 ──

async function sampleOnce(): Promise<void> {
  const config = loadPerceptionConfig();
  if (!config.enabled || !hasPerceptionBridge()) return;

  const state = loadPerceptionState();
  const snapshot = readPerceptionSnapshot();
  if (!snapshot) return;

  state.lastSampleAt = new Date().toISOString();
  state.lastSnapshot = JSON.stringify(snapshot);

  // ── 电量 ──
  // 首次只建立基准，不产生信号——否则一装好就报一堆「电量变化」。
  const percent = snapshot.battery.percent;
  const charging = snapshot.battery.charging;
  const batteryReady = state.lastBatteryPercent >= 0;

  if (batteryReady) {
    if (charging !== state.lastCharging) {
      await emitSignal({
        capability: "battery",
        type: charging ? "充电开始" : "充电结束",
        payload: percent >= 0 ? `${percent}%` : "",
      }, state);
    }
    // 电量跌破阈值：只在「往下掉」且跨度够大时报，避免充电时来回跳也发
    if (percent >= 0 && percent < state.lastBatteryPercent) {
      const drop = state.lastBatteryPercent - percent;
      if (drop >= config.batteryStepPercent) {
        await emitSignal({
          capability: "battery",
          // 阈值来自配置（默认 20），不再是硬编码——用户想改成 30% 提前提醒不用重编 APK
          type: percent <= config.batteryLowPercent ? "电量偏低" : "电量变化",
          payload: `${percent}%`,
        }, state);
      }
    }
  }
  if (percent >= 0) state.lastBatteryPercent = percent;
  state.lastCharging = charging;

  // ── 网络 ──
  // 值不变不发。首次静默建立基准。
  const netType = snapshot.network.type;
  if (state.lastNetworkType && netType && netType !== state.lastNetworkType) {
    await emitSignal({
      capability: "network",
      type: netType === "wifi" ? "连接到 WiFi" : `网络切换到${netType === "cellular" ? "移动网络" : netType}`,
      payload: netType === "cellular" && snapshot.network.metered ? "计费网络" : "",
    }, state);
  }
  if (netType) state.lastNetworkType = netType;

  // ── 前台应用停留 ──
  // 事件只更新「当前在用哪个应用」，真正的判断放在采样里：
  // 因为用户可能一直停在同一个应用、不再产生新事件，靠事件驱动会永远等不到。
  await checkDwell(config.appDwellMinutes, state);

  // ── 应用累计使用 ──
  // 每轮采样只读一次使用统计，喂给信号判定，再随状态缓存复用给
  // 「注入 / 主动查询 / 云端同步」。读两次结果是同一份，纯属白花开销。
  const appUsage = supportsUsageStats() && isCapabilityEnabled(config, "usageStats")
    ? readUsageStats(12)
    : ([] as AppUsageEntry[]);
  await checkAppUsageSignal(config, state, appUsage);

  // ── 作息与习惯 ──
  // 纯时钟信号（深夜/首次打开/很久没聊天）与采样间隔无关；
  // 久坐需要步数，所以把这一轮的步数读数传进去。
  await checkLifeRhythm(config, state);
  await checkSitStill(config, state, snapshot.steps);

  // ── 位置 ──
  // 只在开启时才取：位置权限是敏感授权，用户没开就不该有任何定位调用。
  // 取点用 refreshLocation（一次性），再读缓存——「最后已知位置」可能是
  // 几小时前的，拿它说「到了公司」会错。
  let location = null as ReturnType<typeof readLocation>;
  if (supportsLocation() && isCapabilityEnabled(config, "location")) {
    refreshLocation();
    location = readLocation();
    await checkLocationChange(location, state);
  }

  // ── 睡眠 ──
  // 与位置同一套路：先请原生后台取一次（Health Connect 的读取是挂起函数，
  // 同步读不到），再读缓存。只在开启时才调——这是健康数据，
  // 用户没开就不该有任何读取。
  let sleep = null as ReturnType<typeof readSleep>;
  if (supportsHealth() && isCapabilityEnabled(config, "sleep")) {
    refreshHealth();
    sleep = readSleep();
    await checkWakeUp(sleep, state);
  }

  // ── 设备状态缓存 ──
  // 供三处读取：聊天时的按需注入、角色主动调用「查看TA的手机」、云端同步。
  // 存在这里而不是各消费方自己去原生取，是为了让它们读到同一份「此刻一致」的状态，
  // 也避免每个功能各写一遍降级逻辑。
  const dwellLabel = state.dwellPackage
    ? (readAppLabel(state.dwellPackage) || state.dwellPackage)
    : "";
  // 使用统计这一份数据有两个用途：
  //   ① 上面 checkAppUsageSignal 据它判定「应用用太久」信号；
  //   ② 随状态缓存留给「注入 / 主动查询 / 云端同步」，让角色自己去看今天用了多久。
  // 所以它同时是信号源和快照内容，但**只有**累计满阈值那一刻才产生信号——
  // 每分钟都报的话就成了仪表盘，不是「角色察觉到什么」。
  savePerceptionStatus({
    at: new Date().toISOString(),
    batteryPercent: percent,
    charging,
    networkType: netType || "",
    metered: snapshot.network.metered,
    foregroundApp: dwellLabel,
    foregroundMinutes: state.dwellSince > 0
      ? Math.max(0, Math.floor((Date.now() - state.dwellSince) / 60000))
      : 0,
    steps: snapshot.steps,
    appUsage,
    location,
    sleep,
  });

  // ── 云端同步（默认关）──
  // 必须排在状态缓存**之后**：它上传的就是这份刚写好的成品。
  // 放前面会推上一轮的旧值（差一个采样周期）。
  // 用 void 不 await：上传可能耗时，不能让采样循环等它。
  void syncPerceptionToCloud();

  savePerceptionState(state);
}

/** 停留够久且本段未上报过 → 产生信号。 */
async function checkDwell(thresholdMinutes: number, state: PerceptionRuntimeState): Promise<void> {
  const pkg = state.dwellPackage;
  if (!pkg || !state.dwellSince) return;
  if (state.dwellReported === pkg) return;
  const minutes = Math.floor((Date.now() - state.dwellSince) / 60000);
  if (minutes < thresholdMinutes) return;

  const label = readAppLabel(pkg) || pkg;
  const delivered = await emitSignal({
    capability: "foregroundApp",
    type: "长时间使用",
    payload: `${label} 已连续使用 ${minutes} 分钟`,
  }, state);
  // 只有真投递出去才标记本段已上报。被开关/安静时段/限流拦下时保持未标记，
  // 等条件恢复后还能补上——否则用户白天关了、晚上打开，这段停留就永远丢了。
  if (delivered) state.dwellReported = pkg;
}

// ── 应用累计使用 ──
//
// 与「长时间使用」是两件事，别混：
//   · 长时间使用（checkDwell）：看**连续**停留，切走再回来计时归零，一段只报一次。
//   · 应用用太久（下面这个）：看**当天累计**，来回切 App 照样累加，按档位报。
// 用户说的「刷抖音刷了一上午」是后者——他中间一定切出去过。

/** 本机当天日期键（YYYY-MM-DD），用于跨天清零档位。 */
function localDayKey(): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/**
 * 该应用适用哪条阈值。
 *
 * 覆盖表按顺序取**第一条命中**的（用户自己排的优先级，这里不替他重排）。
 * 匹配是「包含、不区分大小写」，显示名和包名都试一遍：
 * 普通人填「抖音」，懂的人填 com.ss.android.ugc.aweme，两边都能用。
 * 返回 0 表示这个应用不报。
 */
function resolveUsageThreshold(config: PerceptionConfig, entry: AppUsageEntry): number {
  const label = (entry.label || readAppLabel(entry.package) || entry.package).toLowerCase();
  const pkg = entry.package.toLowerCase();
  for (const rule of config.appUsageSignalOverrides) {
    const key = (rule.pattern || "").trim().toLowerCase();
    if (!key) continue;
    if (label.includes(key) || pkg.includes(key)) return rule.minutes;
  }
  return config.appUsageSignalMinutes;
}

/**
 * 「某个应用今天用太久」判定。
 *
 * 累积时长每分钟都在涨，不能每轮采样都报一次，所以按**档位**报：
 * 阈值 60 分钟 → 满 60 报一条、满 120 再报一条。已报到第几档记在
 * usageSignalTier（包名 → 档位），跨天由 usageSignalDate 清零。
 *
 * 不用「上次报的时间 + 阈值」那种算法：那样切到别的 App 会让时间基准漂移，
 * 用户看到的就是「明明已经用了两小时，才刚提醒」。档位只看累计值，不会漂。
 */
async function checkAppUsageSignal(
  config: PerceptionConfig,
  state: PerceptionRuntimeState,
  usage: AppUsageEntry[],
): Promise<void> {
  const anyEnabled = config.appUsageSignalMinutes > 0
    || config.appUsageSignalOverrides.some(rule => rule.minutes > 0);
  if (!anyEnabled) return;
  if (!usage.length) return;

  const today = localDayKey();
  if (state.usageSignalDate !== today) {
    state.usageSignalDate = today;
    state.usageSignalTier = {};
  }

  for (const entry of usage) {
    const threshold = resolveUsageThreshold(config, entry);
    if (threshold <= 0) continue;
    const tier = Math.floor(entry.minutes / threshold);
    if (tier <= 0) continue;
    const last = state.usageSignalTier[entry.package] ?? 0;
    if (tier <= last) continue;

    const label = entry.label || readAppLabel(entry.package) || entry.package;
    const delivered = await emitSignal({
      capability: "usageStats",
      type: "应用用太久",
      payload: `${label} 今天已累计使用 ${entry.minutes} 分钟`,
    }, state);
    // 只有真投递出去才推进档位。被开关/安静时段/限流拦下时保持原档，
    // 条件恢复后补一次——与停留上报同一套「被拦下不算发生过」的约定。
    // 代价是安静时段里每轮采样都会留一条「已拦截」流水，这是有意的：
    // 用户能在记录里看见「信号确实产生了，是安静时段拦的」。
    if (delivered) state.usageSignalTier[entry.package] = tier;
  }
}

// ── 作息与习惯 ──
//
// 这一组信号**不读任何传感器**：时间本身就是全部数据来源，所以纯网页也能用。
// 它们回答的是「人是醒着还是睡着、是刚来还是一直在、是热络还是冷着」这种
// 关系层面的问题——前面那些电量、网络、位置信号回答不了。

/** 每天最多报一次的记录键。 */
const DAILY_KEY_LATE_NIGHT = "lateNight";
const DAILY_KEY_FIRST_OPEN = "firstOpen";
const DAILY_KEY_NO_TALK = "noTalk";

/**
 * 深夜还醒着。
 *
 * 判据只有一条：当前小时数落在 [0, lateNightUntilHour)。默认 5，即 0:00–4:59。
 * 每天只报一次——不然采样周期一到就报一条，整夜刷屏。
 *
 * 【重要】夜里正是推送安静时段覆盖的时间，而安静时段默认开着（respectQuietHours）。
 * 所以这条信号在默认设置下会被「处于安静时段」拦下，流水里能看到、但不会投递。
 * 这是刻意的取舍：用户设了夜里别吵，就该是真的别吵，不该为了一个信号偷偷绕过。
 * 想让它生效，把「遵守安静时段」关掉，或把安静时段的结束时间设早一点。
 */
async function checkLateNight(config: PerceptionConfig, state: PerceptionRuntimeState): Promise<void> {
  if (config.lateNightUntilHour <= 0) return;
  const hour = new Date().getHours();
  if (hour >= config.lateNightUntilHour) return;

  const today = localDayKey();
  if (state.dailySignalDate[DAILY_KEY_LATE_NIGHT] === today) return;

  const delivered = await emitSignal({
    capability: "lifeRhythm",
    type: "深夜还醒着",
    payload: `现在是凌晨 ${hour} 点`,
  }, state);
  if (delivered) state.dailySignalDate[DAILY_KEY_LATE_NIGHT] = today;
}

/**
 * 今天第一次打开小手机。
 *
 * 纯本地判断：当天还没记过 firstOpen 就报一条。App 一直开着不关时，
 * 跨过零点后的第一轮采样就会触发——那正是「今天第一次打开」的语义。
 * 每天一条，与「深夜还醒着」互不干扰（两条都可能真实发生，由规则去筛）。
 */
async function checkFirstOpenToday(state: PerceptionRuntimeState): Promise<void> {
  const today = localDayKey();
  if (state.dailySignalDate[DAILY_KEY_FIRST_OPEN] === today) return;

  const delivered = await emitSignal({
    capability: "lifeRhythm",
    type: "今天第一次打开",
    payload: `今天第一次打开小手机（${new Date().getHours()} 点）`,
  }, state);
  if (delivered) state.dailySignalDate[DAILY_KEY_FIRST_OPEN] = today;
}

/** 距上次查「有没有人在说话」的间隔。会话表整表读一次不算便宜，别每分钟读。 */
const NO_TALK_CHECK_INTERVAL_MS = 30 * 60 * 1000;
let lastNoTalkCheckAt = 0;

/**
 * 很久没聊天。
 *
 * 「说话」按**任意一方**最后一条消息算（会话的 updatedAt）：是真正的双向沉默，
 * 而不是只统计用户发了没有——后者会在角色主动说了话之后仍然报警，很怪。
 *
 * 两条闸：
 *   · 每 30 分钟最多查一次会话表（整表读一次不便宜，而判定精度半小时足够）；
 *   · 每天最多报一次，报过就把当天日期记下。人一直不说话，不该每小时被念一次。
 *
 * 用动态 import 取 chatDb：感知属于底层模块，顶层静态 import 聊天库会让
 * 依赖方向变乱，也容易在非聊天场景里多拉一份 Dexie 进包。
 */
async function checkNoTalk(config: PerceptionConfig, state: PerceptionRuntimeState): Promise<void> {
  if (config.noTalkHours <= 0) return;
  const today = localDayKey();
  if (state.dailySignalDate[DAILY_KEY_NO_TALK] === today) return;
  if (Date.now() - lastNoTalkCheckAt < NO_TALK_CHECK_INTERVAL_MS) return;
  lastNoTalkCheckAt = Date.now();

  let lastAt = 0;
  try {
    const { chatDb } = await import("../chat-db");
    const sessions = await chatDb.sessions.toArray();
    for (const session of sessions) {
      if (!session.updatedAt) continue;
      const t = new Date(session.updatedAt).getTime();
      if (Number.isFinite(t) && t > lastAt) lastAt = t;
    }
  } catch {
    // 读不到就跳过这一轮。宁可不说，也不要凭猜测说「你好久没理我了」。
    return;
  }
  // 一条会话都没有 = 还没开始用，谈不上「很久没聊天」
  if (!lastAt) return;

  const gapHours = (Date.now() - lastAt) / 3600000;
  if (gapHours < config.noTalkHours) return;

  const delivered = await emitSignal({
    capability: "lifeRhythm",
    type: "很久没聊天",
    payload: `已经 ${Math.floor(gapHours)} 小时没说话了`,
  }, state);
  if (delivered) state.dailySignalDate[DAILY_KEY_NO_TALK] = today;
}

/** 三个「作息与习惯」信号的统一入口。 */
async function checkLifeRhythm(config: PerceptionConfig, state: PerceptionRuntimeState): Promise<void> {
  await checkLateNight(config, state);
  await checkFirstOpenToday(state);
  await checkNoTalk(config, state);
}

/**
 * 久坐不动。
 *
 * 判据：**步数一直没涨**且已经持续够久。
 *
 * 为什么用步数而不是「前台应用停留」：停留看的是「在用哪个 App」，
 * 而放下手机坐着看电视两小时同样是久坐——只看前台会漏掉一半场景。
 * 代价是「久坐」这个说法有点宽（不含躺着），但对角色说话够用。
 *
 * 起算与重置都挂在步数变化上：
 *   · 首次读到步数 → 起算；
 *   · 步数一变（起身走动）→ 重新起算、清掉已报标记，于是每一段只报一次；
 *   · 步数读不到（-1，未授权/老壳）→ 整体跳过，不留半截状态。
 */
async function checkSitStill(
  config: PerceptionConfig,
  state: PerceptionRuntimeState,
  steps: number,
): Promise<void> {
  if (config.sitStillMinutes <= 0) return;

  if (steps < 0) {
    state.sitSince = 0;
    state.sitSteps = -1;
    state.sitReported = false;
    return;
  }
  if (state.sitSteps !== steps) {
    state.sitSteps = steps;
    state.sitSince = Date.now();
    state.sitReported = false;
    return;
  }
  if (!state.sitSince) {
    state.sitSince = Date.now();
    return;
  }
  if (state.sitReported) return;

  const minutes = Math.floor((Date.now() - state.sitSince) / 60000);
  if (minutes < config.sitStillMinutes) return;

  const delivered = await emitSignal({
    capability: "steps",
    type: "久坐不动",
    payload: `已经 ${minutes} 分钟没怎么动了`,
  }, state);
  if (delivered) state.sitReported = true;
}

/** 两个坐标之间的大致距离（米）。用等距圆柱近似——几百米到几公里量级足够。 */
function roughDistanceMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1) * Math.cos(toRad((lat1 + lat2) / 2));
  return Math.sqrt(dLat * dLat + dLon * dLon) * R;
}

/**
 * 「换了个地方」判定。
 *
 * 只在**移动得足够远**时报一条，不报「现在在 X」这种持续状态——
 * 位置一直不变就一直是同一个值，按采样周期报会在一天里反复触发
 * 同类消息，像仪表盘而不是「角色察觉到什么」。
 *
 * 两个阈值配合：
 *   · 距离阈值（500 米）：小于这个距离的坐标抖动（GPS 漂移、在楼里挪动）
 *     不算换地方。同一栋楼里从客厅走到卧室不该触发。
 *   · 首次只建立基准：装好 App 那一刻不该报「你到了某某区」，那本来
 *     就是用户在的地方，没有信息量。
 *
 * 定居之后地名可能变（比如从「朝阳区」到「海淀区」），文案优先用新地名。
 */
async function checkLocationChange(
  location: ReturnType<typeof readLocation>,
  state: PerceptionRuntimeState,
): Promise<void> {
  if (!location) return;

  const hasBaseline = Number.isFinite(state.lastLat) && Number.isFinite(state.lastLon);
  if (!hasBaseline) {
    state.lastLat = location.lat;
    state.lastLon = location.lon;
    state.lastPlace = location.place;
    return;
  }

  const distance = roughDistanceMeters(state.lastLat, state.lastLon, location.lat, location.lon);
  if (distance < LOCATION_MOVE_METERS) {
    // 没走远，但地名可能刚反查出来（首次为空）：补上，供下次离开时用
    if (!state.lastPlace && location.place) state.lastPlace = location.place;
    return;
  }

  const from = state.lastPlace;
  const to = location.place;
  // 文案：拿到地名就说地名，拿不到就只说「换了个地方」——
  // 编一个地名比不说更糟，角色会把编出来的地名当真。
  const payload = from && to
    ? `从${from}到了${to}`
    : to
      ? `到了${to}`
      : from
        ? `离开了${from}`
        : "";

  // 无论有没有投递成功都更新基准：位置确实变了，下次比较该基于新坐标。
  // 这与停留上报不同（那边被拦下不标记，等条件恢复补上）——位置信号
  // 补发没有意义（人早走了，「到了公司」过两小时再发只会让人困惑）。
  state.lastLat = location.lat;
  state.lastLon = location.lon;
  state.lastPlace = location.place;

  await emitSignal({
    capability: "location",
    type: "到达新位置",
    payload,
  }, state);
}

/** 判定「换了个地方」的最小距离（米）。 */
const LOCATION_MOVE_METERS = 500;

/**
 * 「睡醒了」判定。
 *
 * 只在这一觉**刚结束**时报一条，不是每次采样都报「你睡了 7 小时」——
 * 睡眠时长在一觉之内基本不变，按采样周期反复报会变成一块健康面板。
 *
 * 两道闸：
 *   · 醒来时刻必须落在最近 6 小时内：更早的那一觉是昨天的，现在说
 *     「你醒了」不合时宜（App 关了一整天才打开时会遇到）。
 *   · 与上次报过的醒来时刻不同：同一次醒来只报一次。用醒来时刻（而不是
 *     时长）做标识，因为时长可能因为数据补录而微调。
 */
async function checkWakeUp(
  sleep: ReturnType<typeof readSleep>,
  state: PerceptionRuntimeState,
): Promise<void> {
  if (!sleep) return;

  const hasBaseline = state.lastSleepEndAt > 0;
  // 先记基准、再判断——首次读到只建立基准，不报「你醒了」：
  // 那多半是刚开功能，用户此刻醒着，说这句莫名其妙。
  if (!hasBaseline) {
    state.lastSleepEndAt = sleep.endAt;
    return;
  }
  if (sleep.endAt === state.lastSleepEndAt) return;

  state.lastSleepEndAt = sleep.endAt;

  const hoursSinceWake = (Date.now() - sleep.endAt) / 3600000;
  if (hoursSinceWake > WAKE_RECENT_HOURS || hoursSinceWake < -1) return;

  await emitSignal({
    capability: "sleep",
    type: "睡醒了",
    payload: `睡了 ${Math.floor(sleep.minutes / 60)} 小时 ${sleep.minutes % 60} 分钟`,
  }, state);
}

/** 「刚醒」的有效窗口（小时）。超过就不提了。 */
const WAKE_RECENT_HOURS = 6;

/** 前台应用变化：只更新基准，不在这里上报（判断统一在 checkDwell）。 */
function onForegroundApp(pkg: string): void {
  if (!pkg) return;
  const state = loadPerceptionState();
  if (state.dwellPackage === pkg) return;
  state.dwellPackage = pkg;
  state.dwellSince = Date.now();
  state.dwellReported = "";
  savePerceptionState(state);
}

// ── 回到手机（回归信号）──
//
// 需求：用户离开小手机一段时间再回来，角色应该能察觉到「TA 回来了」。
// 这是纯网页实现（visibilitychange + 计时），不需要任何原生权限，
// 因此普通浏览器、老 APK 上一样能用。
//
// 两道闸，缺一不可：
//   ① 离开够久（returnAwayMinutes）：切一下微信回来不算「离开」。
//   ② 回归信号本身有冷却（returnCooldownMinutes）：反复切前后台不刷屏。
// 最终是否打扰由现实桥规则决定（要不要写进聊天、要不要让角色回应）。

/** 记录「离开小手机」的时刻。重复调用只取最早一次。 */
export function markAwayFromPhone(): void {
  if (typeof window === "undefined") return;
  const state = loadPerceptionState();
  if (state.awaySince > 0) return;
  state.awaySince = Date.now();
  savePerceptionState(state);
}

/**
 * 处理「回到小手机」。
 *
 * @returns 产生的信号类型；没达到阈值或冷却中时为 null。
 */
export async function markReturnedToPhone(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const config = loadPerceptionConfig();
  const state = loadPerceptionState();

  const awaySince = state.awaySince;
  // 归位：不管这次算不算「离开过」，都要清掉离开标记，否则下次判断拿的是旧时间
  state.awaySince = 0;

  if (!config.enabled || !config.returnSignalEnabled) {
    savePerceptionState(state);
    return null;
  }
  if (!isCapabilityEnabled(config, "returnToPhone")) {
    savePerceptionState(state);
    return null;
  }
  if (awaySince <= 0) {
    savePerceptionState(state);
    return null;
  }

  const awayMinutes = Math.floor((Date.now() - awaySince) / 60000);
  if (awayMinutes < config.returnAwayMinutes) {
    savePerceptionState(state);
    return null;
  }

  // 冷却：用独立的 lastReturnSignalAt 而不是现实桥规则的 cooldownMinutes。
  // 规则冷却拦下时信号已经被 markBridgeRuleRun 记过时间，且流水里只留一句「只存档」，
  // 用户看不出是「太频繁」还是「没配规则」；在这里拦，诊断面板能明确写原因。
  const cooldownMs = config.returnCooldownMinutes * 60000;
  if (cooldownMs > 0 && Date.now() - state.lastReturnSignalAt < cooldownMs) {
    savePerceptionState(state);
    return null;
  }

  const type = "回到手机";
  const delivered = await emitSignal({
    capability: "returnToPhone",
    type,
    payload: `离开了 ${awayMinutes} 分钟`,
  }, state);
  // 只有真投递出去才记冷却。被开关/安静时段/限流拦下时保持原值，
  // 下次回来还能补上——与停留上报同一套「被拦下不算发生过」的约定。
  if (delivered) state.lastReturnSignalAt = Date.now();
  savePerceptionState(state);
  return delivered ? type : null;
}

// ── 查询冷却 ──

/**
 * 角色调用「查看TA的手机」前的冷却检查。
 *
 * 同一角色在 queryCooldownMinutes 内重复查询会被拦下（返回剩余秒数），
 * 避免角色一句话里连查三次、既费 token 又显得神经质。
 * 冷却为 0 时视为不限制。
 */
export function checkQueryCooldown(characterId: string): { allowed: boolean; remainingSeconds: number } {
  const config = loadPerceptionConfig();
  if (config.queryCooldownMinutes <= 0) return { allowed: true, remainingSeconds: 0 };
  const state = loadPerceptionState();
  const last = state.lastQueryAt?.[characterId] ?? 0;
  const elapsed = Date.now() - last;
  const limitMs = config.queryCooldownMinutes * 60000;
  if (last > 0 && elapsed < limitMs) {
    return { allowed: false, remainingSeconds: Math.ceil((limitMs - elapsed) / 1000) };
  }
  return { allowed: true, remainingSeconds: 0 };
}

/** 记录某角色刚查询过（查询成功投递后调用）。 */
export function markQueryPerformed(characterId: string): void {
  if (!characterId) return;
  const state = loadPerceptionState();
  state.lastQueryAt = { ...(state.lastQueryAt ?? {}), [characterId]: Date.now() };
  savePerceptionState(state);
}

// ── 生命周期 ──

/** 启动引擎。幂等：重复调用不会起第二个定时器。 */
export async function startPerception(): Promise<void> {
  if (typeof window === "undefined") return;
  if (running) return;
  running = true;

  // 前台应用事件来自无障碍服务，经壳的 shell-call-overlay 通道过来。
  // 与通话浮窗共用同一条通道（ensureShellOverlayListener 幂等）。
  ensureShellOverlayListener();
  unsubscribeForeground = subscribeShellOverlayEvents(event => {
    if (event.action === "foregroundApp" && event.package) onForegroundApp(event.package);
  });

  // 前后台切换 → 「回到手机」信号。与页面可见性绑定而非 focus 事件：
  // 在安卓 WebView 里切走/切回只稳定触发 visibilitychange，focus 不一定来。
  if (typeof document !== "undefined") {
    unsubscribeVisibility = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  const tick = () => { void sampleOnce(); };
  tick();
  timer = window.setInterval(() => {
    const config = loadPerceptionConfig();
    if (!config.enabled) return;
    tick();
  }, Math.max(20, loadPerceptionConfig().sampleSeconds) * 1000);
}

function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    markAwayFromPhone();
  } else {
    void markReturnedToPhone();
  }
}

/** 停止引擎（关掉总开关时调用）。 */
export function stopPerception(): void {
  running = false;
  if (timer != null) {
    window.clearInterval(timer);
    timer = null;
  }
  if (unsubscribeForeground) {
    unsubscribeForeground();
    unsubscribeForeground = null;
  }
  if (unsubscribeVisibility) {
    unsubscribeVisibility();
    unsubscribeVisibility = null;
  }
}

/**
 * 配置变化后重启引擎（采样间隔可能变了，定时器要重建）。
 * 设置页保存时调用。
 */
export async function restartPerception(): Promise<void> {
  stopPerception();
  const config = loadPerceptionConfig();
  if (config.enabled) await startPerception();
}
