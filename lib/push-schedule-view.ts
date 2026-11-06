// 排期可视化：把服务端的加密任务清单翻译成「哪个角色、排了什么、什么时候发」。
//
// 为什么要这一层：用户遇到的困惑是「规则删了消息还在发」，而任务表里只有一串
// trigger_key。直接把它摊给用户没有意义，得反解回角色与来源——尤其是服务端
// 自己续排的 `+` 后缀链（idleRepeat 在 push-generate 里排队），那些任务本地
// 根本不知道存在，只有列出来才看得见。

import { loadChatSessions, resolveSessionCharacterId } from "./chat-storage";
import { loadCharacters } from "./character-storage";
import { loadIdleReconnectRules } from "./idle-reconnect-storage";
import { loadTimedWakeSchedules } from "./timed-wake-storage";

/** 服务端返回的一条原始任务。 */
export type RawScheduledJob = {
  trigger_key: string;
  kind: string;
  execute_at: string;
  status: string;
};

/** 反解后的一条排期，供面板直接渲染。 */
export type ScheduledJobRow = {
  triggerKey: string;
  /** 触发时刻（毫秒），用于排序与显示 */
  executeAtMs: number;
  executeAt: string;
  status: string;
  /** 归属角色 id；空串 = 归属不明（系统任务，或规则/排期已被删掉） */
  characterId: string;
  /** 归属的会话 id（追问/回复兜底才有），供「按角色整体停止」用 */
  sessionId: string;
  /** 归属角色显示名；空串 = 归属不明 */
  characterName: string;
  /** 用途的人话说明 */
  label: string;
  /** 系统任务（现实桥扫描等）：不建议用户手动删，删了只会被重新挂上 */
  system: boolean;
};

/** 取角色显示名。 */
function characterNameFor(characterId: string): string {
  if (!characterId) return "";
  return loadCharacters().find(character => character.id === characterId)?.name?.trim() || "";
}

/** 从会话反解出「显示名 + 角色 id」。群聊没有单一角色，角色 id 返回空串。 */
function resolveSession(sessionId: string): { name: string; characterId: string } {
  const session = loadChatSessions().find(item => item.id === sessionId);
  if (!session) return { name: "", characterId: "" };
  if (session.isGroup) return { name: session.groupName?.trim() || "群聊", characterId: "" };
  const characterId = resolveSessionCharacterId(session) || "";
  const alias = session.alias?.trim();
  return {
    name: alias || characterNameFor(characterId) || "（会话已删除）",
    characterId,
  };
}

/** 解析结果的内部形态。 */
type Described = {
  characterId: string;
  sessionId: string;
  characterName: string;
  label: string;
  system: boolean;
};

/**
 * 一条 trigger_key 的归属解析。
 *
 * 键的形态由各 arm* 决定（见 push-bailout-client）：
 *   followup:<sessionId>:<第几次>   追问
 *   reply:<sessionId>               回复兜底（发消息时挂的）
 *   idle:<ruleId>:<第几次>[+]       冷场重连，`+` 是服务端续排的那一发
 *   timedwake:<排期id>              定时主动联系
 *   periodcare:<角色id>:<周期键>    经期关怀
 *   bridge:scan:<用户id>            现实桥扫描（系统）
 * 认不出的一律按「未识别」展示原文，绝不猜——猜错会让用户删掉不该删的东西。
 */
function describeTriggerKey(triggerKey: string): Described {
  // 服务端续排的链会在键尾加 `+`（idle:<rule>:<n>+），解析前先剥掉，
  // 但要记下来——那正是「本地不知道、却在发消息」的那一批。
  const continued = triggerKey.endsWith("+");
  const key = continued ? triggerKey.slice(0, -1) : triggerKey;
  const suffix = continued ? "（服务端续排）" : "";
  const none = { characterId: "", sessionId: "" };

  if (key.startsWith("followup:")) {
    const rest = key.slice("followup:".length);
    const sep = rest.lastIndexOf(":");
    const sessionId = sep > 0 ? rest.slice(0, sep) : rest;
    const nth = sep > 0 ? rest.slice(sep + 1) : "";
    const resolved = resolveSession(sessionId);
    return {
      characterId: resolved.characterId,
      sessionId,
      characterName: resolved.name,
      label: `追问${nth ? `（第 ${nth} 次）` : ""}`,
      system: false,
    };
  }
  if (key.startsWith("reply:")) {
    const sessionId = key.slice("reply:".length);
    const resolved = resolveSession(sessionId);
    return {
      characterId: resolved.characterId,
      sessionId,
      characterName: resolved.name,
      label: "回复兜底（你发消息时挂的备用生成）",
      system: false,
    };
  }
  if (key.startsWith("idle:")) {
    const rest = key.slice("idle:".length);
    const sep = rest.lastIndexOf(":");
    const ruleId = sep > 0 ? rest.slice(0, sep) : rest;
    const rule = loadIdleReconnectRules().find(item => item.id === ruleId);
    // 规则已被删掉但任务还在服务端：这正是用户最需要看见的一种情况，
    // 显示成「规则已删除」而不是空白，否则会以为面板坏了。
    return {
      characterId: rule?.characterId ?? "",
      sessionId: rule?.sessionId ?? "",
      characterName: rule ? characterNameFor(rule.characterId) : (ruleId ? "（规则已删除）" : ""),
      label: `冷场重连${suffix}`,
      system: false,
    };
  }
  if (key.startsWith("timedwake:")) {
    const id = key.slice("timedwake:".length);
    const schedule = loadTimedWakeSchedules().find(item => item.id === id);
    return {
      characterId: schedule?.characterId ?? "",
      sessionId: schedule?.sessionId ?? "",
      characterName: schedule ? characterNameFor(schedule.characterId) : "（排期已取消）",
      label: "定时主动联系",
      system: false,
    };
  }
  if (key.startsWith("periodcare:")) {
    const rest = key.slice("periodcare:".length);
    const sep = rest.indexOf(":");
    const characterId = sep > 0 ? rest.slice(0, sep) : rest;
    return {
      characterId,
      sessionId: "",
      characterName: characterNameFor(characterId),
      label: "经期关怀",
      system: false,
    };
  }
  if (key.startsWith("life-scene:")) {
    // life-scene:<sceneId>:<characterId>
    const rest = key.slice("life-scene:".length);
    const sep = rest.lastIndexOf(":");
    const sceneId = sep > 0 ? rest.slice(0, sep) : "";
    const characterId = sep > 0 ? rest.slice(sep + 1) : rest;
    return {
      characterId,
      sessionId: "",
      characterName: characterNameFor(characterId),
      label: "生活现场主动" + (sceneId ? "" : "（场景未知）"),
      system: false,
    };
  }
  if (key.startsWith("bridge:")) {
    return { ...none, characterName: "", label: "现实桥扫描（系统任务）", system: true };
  }
  return { ...none, characterName: "", label: `未识别的任务：${triggerKey}`, system: true };
}

/** 把服务端任务清单翻译成可渲染的行，按触发时刻升序。 */
export function describeScheduledJobs(jobs: RawScheduledJob[]): ScheduledJobRow[] {
  return jobs
    .map(job => {
      const triggerKey = String(job.trigger_key || "");
      const described = describeTriggerKey(triggerKey);
      const executeAtMs = Date.parse(job.execute_at);
      return {
        triggerKey,
        executeAtMs: Number.isFinite(executeAtMs) ? executeAtMs : 0,
        executeAt: job.execute_at,
        status: job.status,
        characterId: described.characterId,
        sessionId: described.sessionId,
        characterName: described.characterName,
        label: described.label,
        system: described.system,
      };
    })
    .sort((a, b) => a.executeAtMs - b.executeAtMs);
}
