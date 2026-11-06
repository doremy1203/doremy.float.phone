"use client";

// 设备动作的执行入口与门控。
//
// 这是设备动作的唯一决策点：是否允许这个动作、参数是否合法、如何措辞结果。
// 原生（DeviceActionBridge.kt）只负责真的去做那件事。
//
// 门控（任一不过就不执行，且都给出明确原因）：
//   ① 能力总开关（工具箱 → 内置能力 → 操作TA的设备）
//   ② 逐动作开关（设置 → 操作TA的设备）
//   ③ 动作本身的前置条件（该授权的授权了没）
//
// 设计原则：**失败必须说清楚**。角色以为灯开了其实没开，比拒绝执行更糟——
// 所以每个失败分支都带一句人话原因，绝不静默吞掉。

import {
  findPackageByLabel,
  hasDeviceActionBridge,
  mediaControl,
  openApp,
  openUrl,
  readDeviceActionCapabilities,
  setAlarm,
  setBrightness,
  setDnd,
  setTimer,
  setTorch,
  setVolume,
} from "./bridge";
import { appendPerceptionLog } from "../perception/storage";
import { DEVICE_ACTION_LABEL, isActionEnabled, loadDeviceActionConfig } from "./storage";

/** 一次设备动作的结论。ok=false 时 reason 一定是给人看的整句。 */
export type DeviceActionOutcome = {
  ok: boolean;
  /** 成功时的结果描述（给角色看的） */
  message?: string;
  /** 失败原因 */
  reason?: string;
  /**
   * 实际执行的动作 id（成功时才有）。
   * 调用方据此挑反馈文案——用入参里的 action 字符串不安全：
   * 模型可能拼错大小写或写中文，那样反馈会退化成「调整了你的设备」。
   */
  action?: string;
};

/** 动作是否可用（开关 + 壳支持）。设置面板用它显示三态。 */
export function checkActionAvailability(actionId: string): {
  configEnabled: boolean;
  userEnabled: boolean;
  bridgeAvailable: boolean;
  supported: boolean;
  granted: boolean;
  available: boolean;
} {
  const config = loadDeviceActionConfig();
  const caps = readDeviceActionCapabilities();
  const bridgeAvailable = hasDeviceActionBridge();
  const id = actionId as keyof typeof caps;
  const supported = caps[id] === true;
  // 亮度/勿扰/使用情况访问有独立的授权状态：有能力但没授权，与「根本不支持」是两回事。
  // 全用 `=== true` 而不是 `!== false`：这些授权默认就是没有的，
  // 老壳不上报该字段时（undefined）必须算「未授权」，否则会显示成已授权、
  // 用户点了却发现功能不工作。
  const granted = actionId === "brightness" ? caps.brightnessGranted === true
    : actionId === "dnd" ? caps.dndGranted === true
    : actionId === "usageStats" ? caps.usageStatsGranted === true
    : true;
  const configEnabled = config.enabled;
  const userEnabled = isActionEnabled(config, actionId as never);
  return {
    configEnabled,
    userEnabled,
    bridgeAvailable,
    supported,
    granted,
    available: configEnabled && userEnabled && bridgeAvailable && supported && granted,
  };
}

/** 取壳上报的授权状态（设置面板给「去授权」按钮用，也给感知读取用）。 */
export function readGrantStatus(): { brightness: boolean; dnd: boolean; usageStats: boolean } {
  const caps = readDeviceActionCapabilities();
  return {
    usageStats: caps.usageStatsGranted === true,
    brightness: caps.brightnessGranted === true,
    dnd: caps.dndGranted === true,
  };
}

/**
 * 执行一次设备动作。
 *
 * 参数用宽松解析：模型可能传 `on`、`on_off`、把数字写成字符串，
 * 与其报「参数错误」让它重试，不如尽量理解意图——但**范围一定要夹紧**
 * （亮度 1-100、音量 0-100），不能把奇怪的值直接透传给原生。
 */
export function runDeviceAction(args: Record<string, unknown>): DeviceActionOutcome {
  const config = loadDeviceActionConfig();
  if (!config.enabled) {
    return { ok: false, reason: "TA 还没有开启设备操作功能（设置 → 操作设备）" };
  }
  if (!hasDeviceActionBridge()) {
    return { ok: false, reason: "当前 App 版本不支持设备动作，需要更新安卓壳" };
  }

  const action = String(args.action ?? "").trim();
  if (!action) return { ok: false, reason: "缺少 action 参数" };

  /**
   * 把这次动作记进感知流水。
   *
   * 为什么记：角色能在真实手机上改东西是很有存在感的权限，用户事后
   * 应该能翻到「它动过我什么」——只靠聊天里那句话不够（消息会被刷走）。
   * 诊断面板的信号记录就是这本账。
   *
   * 只记成功的：失败会被角色如实转述，不值得再占一条流水；
   * 而「动作真的发生了」才是用户要回查的。
   */
  const logDeviceAction = (outcome: DeviceActionOutcome, id: string): DeviceActionOutcome => {
    if (outcome.ok) {
      try {
        appendPerceptionLog({
          id: `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          at: new Date().toISOString(),
          capability: "deviceAction",
          type: DEVICE_ACTION_LABEL[id as keyof typeof DEVICE_ACTION_LABEL] ?? "操作设备",
          payload: outcome.message ?? "",
          outcome: "已执行",
        });
      } catch {
        // 记流水失败不该影响动作本身（它已经真的做完了）
      }
    }
    return outcome;
  };

  // 逐动作开关：没开启的动作必须给出明确拒绝——
  // 否则模型会以为「调用了但没反应」，反复重试或干脆谎报成功。
  // 默认状态下全部未开启，所以首次使用时角色几乎一定会撞到这里，
  // 这句提示就是引导它（和用户）去开关里打开需要的那个。
  const allowed = (id: keyof typeof DEVICE_ACTION_LABEL): DeviceActionOutcome | null => {
    if (!isActionEnabled(config, id)) {
      return {
        ok: false,
        reason: `TA 还没有开启「${DEVICE_ACTION_LABEL[id]}」这个动作（设置 → 操作设备）`,
      };
    }
    return null;
  };

  const caps = readDeviceActionCapabilities();

  // 注意：下面的 per-action 检查用的是 isActionEnabled（显式 true 才算开），
  // 所以默认状态下每个动作都会被拦下——这是刻意的，不是 bug。
  switch (action) {
    case "torch": {
      const blocked = allowed("torch");
      if (blocked) return blocked;
      if (caps.torch !== true) return { ok: false, reason: "这台设备没有可用的闪光灯" };
      const on = args.on === true || args.on === "true" || args.on === 1;
      const result = setTorch(on);
      if (!result.ok) return { ok: false, reason: result.reason };
      return logDeviceAction({ ok: true, action: "torch", message: on ? "手电筒已打开" : "手电筒已关闭" }, "torch");
    }

    case "volume": {
      const blocked = allowed("volume");
      if (blocked) return blocked;
      const stream = String(args.stream ?? "media");
      const mode = String(args.mode ?? "up");
      const level = Number(args.level);
      const result = setVolume(stream, mode, Number.isFinite(level) ? level : 0);
      if (!result.ok) return { ok: false, reason: result.reason };
      const pct = result.max && result.current !== undefined
        ? Math.round((result.current / result.max) * 100)
        : undefined;
      return logDeviceAction({ ok: true, action: "volume", message: pct !== undefined ? `音量已调整（当前约 ${pct}%）` : "音量已调整" }, "volume");
    }

    case "brightness": {
      const blocked = allowed("brightness");
      if (blocked) return blocked;
      const level = Number(args.level);
      if (!Number.isFinite(level)) return { ok: false, reason: "缺少 level 参数（屏幕亮度百分比 1-100）" };
      const result = setBrightness(level);
      if (!result.ok) {
        // 需要授权时把原因说清楚，让角色能转告用户去开权限
        return { ok: false, reason: result.needPermission ? "还没有「修改系统设置」权限，需要 TA 去设置里授权" : result.reason };
      }
      // 自动亮度开着时值会被系统改回去：这时**不能**说「调好了」，
      // 否则用户屏幕没变、角色却一口咬定成功（实测反馈的正是这种）。
      const brightnessMessage = result.autoBrightness
        ? `屏幕亮度已调到约 ${Math.round(level)}%，但 TA 开着自动亮度，系统可能很快改回去——需要关掉自动亮度才由你说了算`
        : `屏幕亮度已调到约 ${Math.round(level)}%`;
      return logDeviceAction({ ok: true, action: "brightness", message: brightnessMessage }, "brightness");
    }

    case "dnd": {
      const blocked = allowed("dnd");
      if (blocked) return blocked;
      const on = args.on === true || args.on === "true" || args.on === 1;
      const result = setDnd(on);
      if (!result.ok) {
        return { ok: false, reason: result.needPermission ? "还没有「勿扰模式」访问权限，需要 TA 去设置里授权" : result.reason };
      }
      return logDeviceAction({ ok: true, action: "dnd", message: on ? "已打开勿扰模式" : "已关闭勿扰模式" }, "dnd");
    }

    // 「打开应用」：会把用户的屏幕切走，所以是这批动作里**侵略性最强**的一个，
    // 默认关闭、需要用户主动开。但场景成立（陪它→打开小手机、
    // 学习→专注应用、吃饭→外卖应用），所以开放而不是砍掉。
    //
    // 含小手机自身：规则常配「刷别的 App 太久 → 打开 float 把我叫回去」，
    // 这条路径曾经永远失败（壳侧把自己排除在候选外，见 DeviceActionBridge）。
    case "openApp": {
      const blocked = allowed("openApp");
      if (blocked) return blocked;
      const raw = String(args.app ?? "").trim();
      if (!raw) return { ok: false, reason: "缺少 app 参数（应用名或包名）" };
      // 先当包名试，再当显示名找——角色多半只知道「微信」，不知道 com.tencent.mm
      let pkg = raw;
      const label = raw;
      if (!raw.includes(".")) {
        const found = findPackageByLabel(raw);
        if (!found) {
          // 说清「该填什么」而不是只说「没找到」：模型多半是把包名
          // （com.xxx）或英文名当显示名传来，用户照着这句只会反复试名字。
          // 小手机自身的显示名就是「float」，从壳的 app_name 来。
          return { ok: false, reason: `没找到叫「${raw}」的应用——要填它在桌面上的显示名（中文名通常最准），不是包名；小手机自己叫「float」` };
        }
        pkg = found;
      }
      const result = openApp(pkg);
      if (!result.ok) return { ok: false, reason: result.reason };
      // 提示里用应用真实名字（bridge 回传的 label），拿不到才退回用户输入的词
      const shown = result.label || label;
      return logDeviceAction({ ok: true, action: "openApp", message: `已打开「${shown}」` }, "openApp");
    }

    // ── 闹钟：带系统界面，用户自己确认时间 ──
    case "alarm": {
      const blocked = allowed("alarm");
      if (blocked) return blocked;
      const hour = Number(args.hour);
      const minute = Number(args.minute ?? 0);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        return { ok: false, reason: "需要 hour 参数（0-23）" };
      }
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
        return { ok: false, reason: "minute 需要在 0-59 之间" };
      }
      const note = String(args.message ?? "").trim();
      const result = setAlarm(hour, minute, note);
      if (!result.ok) {
        // needPermission=set_alarm 是「壳没声明时钟要求的调用方权限」——
        // 这种情况只能更新壳，**系统设置里没有对应开关**，所以措辞必须和
        // 亮度/勿扰那种「去设置里授权」区分开，免得角色让用户白找一圈。
        if (result.needPermission === "set_alarm") {
          return { ok: false, reason: "系统时钟拒绝了这次调用（壳缺少声明的闹钟权限），需要更新到最新版安卓壳；这不是能在系统设置里手动开的权限" };
        }
        return { ok: false, reason: result.reason };
      }
      const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      // needsConfirm 时系统界面已弹出，结果以用户确认为准，措辞不能说得太满
      return logDeviceAction({ ok: true, action: "alarm", message: `闹钟 ${hhmm} 已交给系统时钟（请在时钟里确认）` }, "alarm");
    }

    case "timer": {
      const blocked = allowed("timer");
      if (blocked) return blocked;
      // 允许模型传 minutes 或 seconds，优先 minutes（更符合说话的粒度）
      const minutes = Number(args.minutes);
      const secondsArg = Number(args.seconds);
      const seconds = Number.isFinite(minutes) && minutes > 0
        ? Math.round(minutes * 60)
        : Math.round(secondsArg);
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) {
        return { ok: false, reason: "需要 minutes 或 seconds 参数（最长 24 小时）" };
      }
      const note = String(args.message ?? "").trim();
      const result = setTimer(seconds, note);
      if (!result.ok) {
        // 与闹钟同源：时钟拒绝调用方时只能更新壳，不是用户去设置里开权限。
        if (result.needPermission === "set_alarm") {
          return { ok: false, reason: "系统时钟拒绝了这次调用（壳缺少声明的闹钟权限），需要更新到最新版安卓壳；这不是能在系统设置里手动开的权限" };
        }
        return { ok: false, reason: result.reason };
      }
      const human = seconds >= 60 ? `${Math.round(seconds / 60)} 分钟` : `${seconds} 秒`;
      return logDeviceAction({ ok: true, action: "timer", message: `倒计时已开始（${human}）` }, "timer");
    }

    case "media": {
      const blocked = allowed("media");
      if (blocked) return blocked;
      const op = String(args.mode ?? args.op ?? "toggle");
      const result = mediaControl(op);
      if (!result.ok) return { ok: false, reason: result.reason };
      const label: Record<string, string> = {
        play: "已继续播放",
        pause: "已暂停",
        toggle: "已切换播放状态",
        next: "已切到下一首",
        prev: "已切到上一首",
        stop: "已停止播放",
      };
      const where = result.player ? `（控制的是「${result.player}」）` : "";
      // 只有**读回状态核对过**才敢说「已播放」。盲发按键时指令可能被系统直接丢掉
      // （后台没有播放器就是这样），旧文案照样报「已继续播放」，用户等了半天没声音。
      // 措辞按「能不能确认」分档，绝不把「指令发出去了」说成「已经播了」。
      // 四种情形给四种话，让用户和角色都知道下一步该做什么：
      //   ① confirmed         → 读回状态核对过，可以直说；
      //   ② 没授权            → 引导去授「通知使用权」（有这条才有确认能力）；
      //   ③ 会话在但状态读不到 → 播放器进程多半已退出，重开播放器比反复重试有用；
      //   ④ 其余没确认        → 如实说没读到确认，可能没生效。
      const message = result.confirmed
        ? `${label[op] ?? "已发送播放控制"}${where}`
        : result.viaSession === false
          ? `已经把播放指令发出去了，但没法确认是否生效——需要 TA 在设置 → 操作设备里授予「通知使用权」，才能读到播放状态帮你确认${where}`
          : result.readable === false
            ? `播放指令已发给「${result.player ?? "播放器"}」，但读不到它的播放状态——它可能已经不在后台运行了，需要先打开播放器再试${where}`
            : `${label[op] ?? "已发送播放控制"}的指令已下发${result.viaKeys ? "（会话直控和系统媒体键都发了）" : ""}，但没能从播放器读到确认状态，可能没生效${where}`;
      return logDeviceAction({ ok: true, action: "media", message }, "media");
    }

    case "openUrl": {
      const blocked = allowed("openUrl");
      if (blocked) return blocked;
      const url = String(args.url ?? "").trim();
      if (!url) return { ok: false, reason: "缺少 url 参数" };
      const result = openUrl(url);
      if (!result.ok) return { ok: false, reason: result.reason };
      return logDeviceAction({ ok: true, action: "openUrl", message: "已在浏览器里打开" }, "openUrl");
    }

    default:
      return { ok: false, reason: `不认识的动作：${action}` };
  }
}
