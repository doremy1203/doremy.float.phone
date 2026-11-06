"use client";

// 设备动作的配置存储。
// 与感知一致走 kv-db（IndexedDB），不落服务端。
//
// 与感知（只读）的关键差异：这里是**写**操作，会真的改变用户手机状态。
// 所以默认值一律为「关」——总开关关、每个动作也关，全部要用户主动开。
// 感知那边「缺失视为开启」的约定绝不能抄过来：只读抄了没事，
// 写操作抄了等于默认允许角色动用户的设备。
//
// 为什么每个动作都要独立开关：用户可能想让角色帮忙开灯，但绝不接受
// 它半夜把屏幕调暗或改勿扰。一个「总开关」管不住这种差异，
// 所以粒度到单个动作。

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import type { DeviceActionId } from "./types";

const CONFIG_KEY = "ai_phone_device_action_config_v1";
registerKvMigration(CONFIG_KEY);

/**
 * 可在设置里单独开关的动作（授权状态类的不算）。
 *
 * 每一项都必须能回答「角色为什么需要做这个」——答不上来的不接。
 * 「打开应用」一度被剔除（担心把用户踢出小手机），但用户给出了三个
 * 成立的场景后恢复：想让人陪 → 打开小手机自己；想让人学习 → 打开专注类
 * 应用；提醒吃饭 → 打开外卖应用。**它的价值恰恰是「把用户带走去做正事」**，
 * 所以单列一条说明，并默认关闭。
 */
export const TOGGLEABLE_ACTIONS: DeviceActionId[] = [
  "torch",
  "volume",
  "brightness",
  "dnd",
  "openApp",
  "alarm",
  "timer",
  "media",
  "openUrl",
];

export const DEVICE_ACTION_LABEL: Record<DeviceActionId, string> = {
  torch: "手电筒",
  volume: "音量",
  brightness: "屏幕亮度",
  brightnessAuto: "自动亮度状态",
  brightnessGranted: "屏幕亮度授权",
  dnd: "勿扰模式",
  dndGranted: "勿扰模式授权",
  openApp: "打开应用",
  alarm: "设闹钟",
  timer: "设倒计时",
  media: "音乐播放控制",
  mediaSessionGranted: "媒体会话授权",
  openUrl: "打开网页",
  usageStats: "使用情况访问",
  usageStatsGranted: "使用情况访问授权",
};

/**
 * 每个动作的说明。括号里写了「典型场景」——这是取舍的依据，不是装饰：
 * 答不上场景的动作就不该接。
 */
export const DEVICE_ACTION_DESC: Record<DeviceActionId, string> = {
  torch: "开关手电筒。场景：起夜、找东西时角色顺手替你开一下。",
  volume: "调节媒体/铃声/闹钟/通知的音量。场景：替你调小外放声音。注意它改的是系统音量，不会自己变回来。",
  brightness: "调节屏幕亮度。场景：夜里替你调暗。需要「修改系统设置」权限，且改动是持久的、不会自动恢复。",
  brightnessAuto: "读取系统是否启用了自动亮度，避免角色调节后被系统自动亮度覆盖。",
  brightnessGranted: "是否已授予「修改系统设置」权限。",
  dnd: "开关勿扰模式。场景：陪你睡时帮你静音。需要勿扰访问权限；开着的时候你会漏接电话，所以请留意角色有没有帮你关回来。",
  dndGranted: "是否已授予勿扰模式访问权限。",
  openApp: "打开某个应用。场景：想让你陪它就打开小手机、想让你学习就打开专注应用、提醒你吃饭就打开外卖。注意它会把你的屏幕切走，所以默认关闭——要用请自己打开。",
  alarm: "设一个闹钟。会打开系统时钟 App 让你确认时间，不会静默设置。",
  timer: "设一个倒计时，到点由系统时钟提醒。适合「20 分钟后叫你休息」这类。",
  media: "控制正在播放的音乐：暂停、继续、上一首、下一首。对任何支持媒体按键的播放器都有效。",
  mediaSessionGranted: "媒体会话通知访问权限状态，用于判断能否准确控制并读取播放器状态。",
  openUrl: "用系统浏览器打开一个链接。只支持 http/https，会离开小手机。",
  usageStats: "读取各应用的使用时长（屏幕使用时间）。需要在系统设置里单独授权「使用情况访问」——这是特殊权限，不能弹窗申请。",
  usageStatsGranted: "是否已授予「使用情况访问」权限。",
};

export type DeviceActionConfig = {
  /** 总开关：关掉后角色完全看不到这个能力。默认关（写操作必须主动开）。 */
  enabled: boolean;
  /**
   * 逐动作开关。**只有显式 true 才算开启**（缺失 = 关）。
   * 与感知相反——那边只读，缺省开；这边会改用户设备，缺省必须关。
   */
  actions: Partial<Record<DeviceActionId, boolean>>;
  /**
   * 角色动了你的手机后，是否发一条系统通知告诉你。
   *
   * 默认开，因为这是**反馈**不是**动作**——动作会真的改变设备状态，
   * 用户不在聊天室里时若毫无提示，就成了「神戳戳」：灯自己亮了、
   * 手机自己静音了，却不知道是谁干的。反馈必须默认可感知，
   * 与该功能「动作默认全关」的保守取向不矛盾。
   */
  notifyOnAction: boolean;
};

export const DEVICE_ACTION_DEFAULTS: DeviceActionConfig = {
  enabled: false,
  actions: {},
  notifyOnAction: true,
};

/** 读配置。 */
export function loadDeviceActionConfig(): DeviceActionConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...DEVICE_ACTION_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<DeviceActionConfig>;
    return {
      enabled: parsed.enabled === true,
      actions: (parsed.actions && typeof parsed.actions === "object") ? parsed.actions : {},
      // 反馈默认开：仅显式 false 才关（与动作开关的取向相反，见类型注释）
      notifyOnAction: parsed.notifyOnAction !== false,
    };
  } catch {
    return { ...DEVICE_ACTION_DEFAULTS };
  }
}

export function saveDeviceActionConfig(config: DeviceActionConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("device-action-config-changed"));
  }
}

/** 某个动作是否被允许。必须显式开启过才算允许（缺失 = 关）。 */
export function isActionEnabled(config: DeviceActionConfig, id: DeviceActionId): boolean {
  return config.actions[id] === true;
}
