"use client";

// 查岗引擎：决定「该不该查」→ 请原生弹浮层 → 按用户的选择推进。
//
// 三条路径：
//   ① 用户同意 → 这张图以「你发的图片」进聊天，触发角色点评；
//   ② 用户拒绝 → 只写一条系统事件（图根本没产生），让角色知道这次没给看；
//   ③ 截屏失败/超时 → 同上，但原因不同，角色不会以为「你拒绝了」。
//
// 关键边界：
//  - **没同意就没有图**：图片数据只在原生内存里；拒绝路径上网页侧从头到尾
//    没拿到过 base64，所以这里不需要「清理」什么，也就不会漏删。
//  - **不做隐蔽触发**：只有 shouldFireCheckIn 判定该触发时才调用，且
//    每次都会弹浮层让用户当场决定——不存在「悄悄截了存起来」的路径。
//  - **失败如实说**：没能截图时写的是「截屏失败」而不是「对方没给看」，
//    免得角色误以为用户拒绝、做出委屈的反应。

import { pushChatMessage, loadChatSessions } from "../chat-storage";
import { loadCharacters } from "../character-storage";
import { recordUserShot } from "./engine";
import { requestBackgroundChatReply } from "../follow-up-service";
import { storeMediaBase64 } from "../media-cache-storage";
import {
  loadCharacterCheckIn,
  loadCheckInConfig,
  markCheckInFired,
  readCharacterRuntime,
  shouldFireCheckIn,
  type CheckInCharacterConfig,
} from "./checkin-config";
import { consumePendingUserShot, hasCheckInBridge, notifyCheckInUnavailable, readCheckInCapabilities, requestCheckIn } from "./checkin";
import type { CheckInOutcome } from "./types";
import { resolveCheckInGuidance } from "./checkin-guidance";
import { ensureShellOverlayListener, subscribeShellOverlayEvents } from "../shell-call-overlay";

/** 一次查岗尝试的结论（给调用方/设置页做记录用）。 */
export type CheckInAttempt =
  | { ok: true; accepted: true }
  | { ok: true; accepted: false; reason: string }
  | { ok: false; reason: string };

/** 查岗是否具备条件（不开浮层也点不动）。 */
export function checkInReadiness(): {
  bridgeAvailable: boolean;
  supported: boolean;
  accessibilityOn: boolean;
  overlayReady: boolean;
  ready: boolean;
} {
  const caps = readCheckInCapabilities();
  const bridgeAvailable = hasCheckInBridge();
  const supported = caps.supported === true;
  const accessibilityOn = caps.accessibilityOn === true;
  const overlayReady = caps.canDraw === true;
  return {
    bridgeAvailable,
    supported,
    accessibilityOn,
    overlayReady,
    ready: bridgeAvailable && supported && accessibilityOn && overlayReady,
  };
}

/** 找一个角色的最新私聊会话（查岗只发生在私聊里）。 */
export function findLatestPrivateSession(characterId: string): string | null {
  const sessions = loadChatSessions()
    .filter(session => !session.isGroup && session.contactId === characterId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions[0]?.id ?? null;
}

/**
 * 对某个角色跑一次查岗（该不该触发要先由调用方判定）。
 *
 * @param config 该角色的查岗配置（调用方已读过，这里不再读一次，避免
 *               判定与执行之间配置被改动造成不一致）
 */
export async function runCheckIn(
  characterId: string,
  config?: CheckInCharacterConfig,
): Promise<CheckInAttempt> {
  const cfg = config ?? loadCharacterCheckIn(characterId);
  if (!cfg.enabled) return { ok: false, reason: "这个角色没有开启查岗" };

  const sessionId = findLatestPrivateSession(characterId);
  if (!sessionId) return { ok: false, reason: "还没有和这个角色的聊天" };

  const readiness = checkInReadiness();
  if (!readiness.bridgeAvailable) return { ok: false, reason: "当前 App 版本不支持查岗" };
  if (!readiness.supported) return { ok: false, reason: "系统版本太低，查岗需要 Android 11 及以上" };
  if (!readiness.accessibilityOn) {
    const characterName = loadCharacters().find(c => c.id === characterId)?.name?.trim() || "角色";
    notifyCheckInUnavailable(characterName);
    return { ok: false, reason: "无障碍服务当前未连接，已尝试发送修复通知" };
  }
  if (!readiness.overlayReady) return { ok: false, reason: "浮窗权限没有授予，弹不出确认浮层" };

  const character = loadCharacters().find(c => c.id === characterId);
  const name = character?.name?.trim() || "TA";
  const avatar = character?.avatar || "";

  // 先记一次触发：无论用户最终给不给看，这次查岗都已经发生过，
  // 都该计入当日上限——否则用户一直点「不给」就等于没有上限。
  markCheckInFired(characterId);

  const outcome = await requestCheckIn(characterId, name, avatar);

  if (outcome.accepted) {
    try {
      // 用户在浮层里顺手说的话，先作为普通发言发出去——
      // 这样角色看到的是「你说了一句话 + 一张图」，而不是一张没头没尾的截图。
      if (outcome.reply) {
        pushChatMessage({ sessionId, role: "user", content: outcome.reply });
      }
      // 关键：留一条系统事件说明「这张图是它自己查岗看到的」。
      // 否则角色只见到一张以用户身份发出的图，会当成用户主动分享截图，
      // 完全意识不到是自己在查岗——与拒绝路径那条说明正好不对称。
      pushChatMessage({
        sessionId,
        role: "system",
        content: `[${name}想看看你现在在做什么，你把屏幕给它看了]`,
      });
      const stored = await storeMediaBase64(outcome.base64, "image/png");
      pushChatMessage({
        sessionId,
        role: "user",
        content: "",
        mediaType: "image",
        mediaUrl: stored.ref,
        mediaData: { label: "给你看我现在的屏幕" },
      });
      // 用户可给这次结果写一句反应指导语（设置 → 截屏 → 主动查岗）。
      // 只随本轮请求送出、不落库——否则后面每一轮都会重新看到它。
      const acceptedGuidance = resolveCheckInGuidance("accepted", name);
      void requestBackgroundChatReply(
        sessionId,
        acceptedGuidance ? { ephemeralSystemNote: acceptedGuidance } : undefined,
      ).catch(() => undefined);
      return { ok: true, accepted: true };
    } catch {
      return { ok: false, reason: "图片没能保存，这次没发出去" };
    }
  }

  // 拒绝时如果用户留了话，那句话是主动说的，照常作为发言送出。
  // 顺序很关键：先发送言、再写「没给看」的事件，读起来才是因果正确的。
  if (outcome.reply) {
    pushChatMessage({ sessionId, role: "user", content: outcome.reply });
  }

  // 拒绝 / 超时 / 截屏失败：写一条只有角色看得见来源的系统事件，
  // 让它能自然反应——但措辞要能区分「你不想给我看」和「没截成」。
  const declined = outcome.reason === "user_rejected";
  const timedOut = outcome.reason === "timeout";
  const note = declined
    ? `[${name}想看看你现在在做什么，你没有给它看${outcome.reply ? "，但回了一句话" : ""}]`
    : timedOut
      ? `[${name}想看看你现在在做什么，你没有回应]`
      : `[${name}想看看你现在在做什么，但没能截到屏幕（${outcome.reason}）]`;
  pushChatMessage({ sessionId, role: "system", content: note });
  // 拒绝也让它有反应（用户明确要的）——被拒时该失落还是说没关系，交给角色自己决定。
  // 三种失败结果各自可配指导语，同样只随本轮请求送出。
  const guidanceKind = declined ? "declined" : timedOut ? "timeout" : "failed";
  const guidance = resolveCheckInGuidance(guidanceKind, name);
  void requestBackgroundChatReply(
    sessionId,
    guidance ? { ephemeralSystemNote: guidance } : undefined,
  ).catch(() => undefined);
  return { ok: true, accepted: false, reason: outcome.reason };
}

/**
 * 处理一次「用户主动截屏」（悬浮球发起）。
 *
 * 与查岗的区别：没有指定角色——用户点球时只是想分享，发给谁是**现在**决定的。
 * 取最近聊过的私聊会话作为目标：那是他此刻最可能想发的人。
 *
 * @param outcome 原生回传的结果（已确认用户点了「发给它」）
 */
export async function deliverUserShot(outcome: CheckInOutcome): Promise<{ ok: boolean; reason?: string }> {
  if (!outcome.accepted) return { ok: false, reason: outcome.reason || "没有可发送的内容" };

  // 目标优先用浮层里当场选定的那个（或设了默认角色时的默认值）。
  // 老壳不带 characterId → 退回「最近聊过的私聊会话」，与加选择之前一致；
  // 那也正是当时唯一可能发出去的人，不算猜错。
  // 没有会话就没法发——如实失败，不硬造一个。
  const sessionId = outcome.characterId
    ? findLatestPrivateSession(outcome.characterId)
    : loadChatSessions()
        .filter(session => !session.isGroup)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
  if (!sessionId) {
    return {
      ok: false,
      reason: outcome.characterId
        ? "和这个角色还没有聊天，不知道该往哪发"
        : "还没有任何聊天，不知道发给谁",
    };
  }

  try {
    // 顺手说的话先发，图后发——读起来是「说了一句 + 配张图」。
    if (outcome.reply) {
      pushChatMessage({ sessionId, role: "user", content: outcome.reply });
    }
    // 存图 + 记进「最近截屏」列表：用户想回查刚才截了什么时，那张图必须
    // 和查岗截的一视同仁地出现在列表里。两件事共用一次存储，拿回 ref 直接发消息。
    //
    // 这里曾经是 `void recordUserShot(...)` 顺手记一笔、再单独 storeMediaBase64——
    // 而 recordUserShot 在 engine 里根本不存在，同步抛出的 TypeError 被外层
    // catch 吞掉，于是「话发出去了、图和角色回应都没有」（用户实报）。
    const record = await recordUserShot({
      base64: outcome.base64,
      width: outcome.width,
      height: outcome.height,
      bytes: outcome.bytes,
    });
    if (!record) {
      return { ok: false, reason: "图片没能保存，这次没发出去" };
    }
    pushChatMessage({
      sessionId,
      role: "user",
      content: "",
      mediaType: "image",
      mediaUrl: record.ref,
      mediaData: { label: "给你看看我现在这边" },
    });
    void requestBackgroundChatReply(sessionId).catch(() => undefined);
    return { ok: true };
  } catch {
    return { ok: false, reason: "图片没能保存，这次没发出去" };
  }
}

/**
 * 拉一次「用户主动截屏」的结果并送出去。
 *
 * 页面挂载时、以及收到 checkIn 事件时各调一次：
 *   · 挂载时补发「点球那一刻页面已被系统回收」的那张；
 *   · 事件时处理当场送达的。
 * 原生侧是「读到即清空」，所以重复调用不会把同一张图发两遍。
 *
 * @returns 真正送出的一张图；没有待取或发送失败时返回 null。
 */
export async function flushPendingUserShot(): Promise<boolean> {
  const pending = consumePendingUserShot();
  if (!pending) return false;
  const result = await deliverUserShot(pending);
  return result.ok;
}

/**
 * 启动「用户主动截屏」的接收端：页面挂载时补发一次，之后收到 checkIn 事件再拉一次。
 *
 * 必须挂在桌面壳这种「一直在跑」的地方，而不是设置页——用户点球时
 * 多半正在别的 App 里，设置页根本没开。
 *
 * 重复调用无害：原生侧是「读到即清空」，拉两次不会把同一张图发两遍。
 * 角色查岗也会触发同一个事件，但那条路上原生不写 pendingUserShot，
 * 所以这里会拿到空、直接返回，不影响查岗自己的 Promise 流程。
 */
export function startUserShotBridge(): () => void {
  if (typeof window === "undefined") return () => { /* noop */ };
  if (!hasCheckInBridge()) return () => { /* noop */ };

  // 挂载时补发：点球那一刻页面若已被系统回收，事件是丢的，只能靠这里捞回来
  void flushPendingUserShot().catch(() => undefined);

  ensureShellOverlayListener();
  return subscribeShellOverlayEvents((event) => {
    if (event.action !== "checkIn") return;
    void flushPendingUserShot().catch(() => undefined);
  });
}

/**
 * 角色在聊天里主动请求看一眼屏幕（工具箱 → 内置能力「想看看你的屏幕」）。
 *
 * 与定时查岗（runCheckIn）共用同一套审批与额度，但落地方式必须不同：
 *   · 定时查岗发生在**没有对话**的时候，看完得自己另起一轮回复
 *     （所以那边要调 requestBackgroundChatReply）；
 *   · 这个发生在**对话进行中**，结果直接交回给模型、在同一轮里点评——
 *     这里若也去起背景回复，就会变成「回两条」。
 *
 * 相同的是：一样弹浮层、一样要用户点「给它看」，拒绝路径一样不产生图片、
 * 一样记一次额度（否则角色一直点「不给」就等于没有上限）。
 */
export type CheckInToolOutcome = {
  /** 动作本身是否正常走完（含「用户没给看」这种正常结果） */
  ok: boolean;
  /** 用户是否真的给了图 */
  accepted?: boolean;
  /** 给模型看的说明：ok=true 时是所见/被拒的交代，ok=false 时是失败原因 */
  message: string;
};

export async function requestCheckInForTool(characterId: string): Promise<CheckInToolOutcome> {
  const cfg = loadCharacterCheckIn(characterId);
  if (!cfg.enabled) {
    return {
      ok: false,
      message: "TA 还没有为你开启查岗（设置 → 截屏 → 主动查岗），所以现在不能要求看屏幕。",
    };
  }

  const runtime = readCharacterRuntime(characterId);
  if (runtime.countToday >= cfg.dailyLimit) {
    return {
      ok: false,
      message: `今天已经看过 ${runtime.countToday} 次了（上限 ${cfg.dailyLimit} 次），今天别再要求了。`,
    };
  }

  const readiness = checkInReadiness();
  if (!readiness.bridgeAvailable) return { ok: false, message: "当前 App 版本不支持这个动作，需要更新安卓壳。" };
  if (!readiness.supported) return { ok: false, message: "TA 的系统版本太低（需要 Android 11 及以上），暂时做不到。" };
  if (!readiness.accessibilityOn) {
    const characterName = loadCharacters().find(c => c.id === characterId)?.name?.trim() || "角色";
    notifyCheckInUnavailable(characterName);
    return { ok: false, message: "无障碍服务当前未连接，已提示用户重新开启服务。" };
  }
  if (!readiness.overlayReady) return { ok: false, message: "TA 还没有授予浮窗权限，弹不出确认框。" };

  const sessionId = findLatestPrivateSession(characterId);
  const character = loadCharacters().find(c => c.id === characterId);
  const name = character?.name?.trim() || "TA";
  const avatar = character?.avatar || "";

  // 先记一次：请求已经发出去了，无论用户最终给不给看。
  markCheckInFired(characterId);

  const outcome = await requestCheckIn(characterId, name, avatar);

  if (outcome.accepted) {
    try {
      if (outcome.reply && sessionId) {
        pushChatMessage({ sessionId, role: "user", content: outcome.reply });
      }
      if (sessionId) {
        // 这条系统事件是给角色看的：否则它只见到一张「用户发的图」，
        // 会当成对方主动分享，误以为和自己这个请求无关。
        pushChatMessage({
          sessionId,
          role: "system",
          content: `[${name}想看看你现在在做什么，你把屏幕给它看了]`,
        });
        const stored = await storeMediaBase64(outcome.base64, "image/png");
        pushChatMessage({
          sessionId,
          role: "user",
          content: "",
          mediaType: "image",
          mediaUrl: stored.ref,
          mediaData: { label: "给你看我现在的屏幕" },
        });
      }
      return {
        ok: true,
        accepted: true,
        message: "TA 把屏幕给你看了，画面已经作为一条消息出现在聊天里。"
          + "结合你看到的内容自然地回应一句就好，不要逐项列举你看到了什么——那很像在汇报监控。",
      };
    } catch {
      return { ok: false, message: "图拿到手了但没能存下来，这次没看成。" };
    }
  }

  // 拒绝时如果用户留了话，那句话是主动说的，照常作为发言送出。
  if (outcome.reply && sessionId) {
    pushChatMessage({ sessionId, role: "user", content: outcome.reply });
  }

  const declined = outcome.reason === "user_rejected";
  const timedOut = outcome.reason === "timeout";
  if (sessionId) {
    const note = declined
      ? `[${name}想看看你现在在做什么，你没有给它看${outcome.reply ? "，但回了一句话" : ""}]`
      : timedOut
        ? `[${name}想看看你现在在做什么，你没有回应]`
        : `[${name}想看看你在做什么，但没能截到屏幕（${outcome.reason}）]`;
    pushChatMessage({ sessionId, role: "system", content: note });
  }

  return {
    ok: true,
    accepted: false,
    message: declined
      ? "TA 这次没有给你看。不要追问、不要闹脾气、不要反复请求，自然地把话题接下去就好。"
      : timedOut
        ? "TA 没有回应你的请求（可能不在手机前）。不要在同一个点上再试一次。"
        : `这次没能截到屏幕（${outcome.reason}）。不要再重复尝试。`,
  };
}

/**
 * 扫一遍所有角色，把到点的查岗跑一遍。
 *
 * 挂进桌面壳的轮询（与定时主动联系同一处）。刻意串行执行：
 * 同一时刻只弹一个浮层——两个浮层叠在一起，用户根本没法处理。
 */
let checkInPollInFlight: Promise<number> | null = null;

/** 多个 focus/pageshow/visibility/timer 事件可能同时触发扫描；合并成同一轮，
 * 避免两个扫描循环交错，导致同一时刻弹出多个角色的查岗浮层。 */
export function pollDueCheckIns(): Promise<number> {
  if (checkInPollInFlight) return checkInPollInFlight;

  const run = (async () => {
    const all = loadCheckInConfig();
    let fired = 0;
    for (const [characterId, config] of Object.entries(all)) {
      if (!shouldFireCheckIn(characterId, config)) continue;
      const result = await runCheckIn(characterId, config);
      if (result.ok) fired += 1;
    }
    return fired;
  })();

  checkInPollInFlight = run.finally(() => {
    checkInPollInFlight = null;
  });
  return checkInPollInFlight;
}
