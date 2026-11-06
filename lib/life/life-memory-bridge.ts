import { loadVirtualLifeState, saveVirtualLifeState } from "./life-storage";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow, settleActorTimelineToNow } from "./life-runtime";

function formatLifeDateTime(value?: string | null): string {
  if (!value) return "时间未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function formatLifeRange(startAt?: string | null, endAt?: string | null): string {
  if (!startAt || !endAt) return formatLifeDateTime(startAt || endAt);
  return formatLifeDateTime(startAt) + "—" + formatLifeDateTime(endAt);
}

/** 生活记忆里的玩家统一用 {{user}}；显示时再由页面/宏系统解析成实际称呼。 */
function normalizeLifeMemoryUserReference(text: string): string {
  return text.replace(/你/g, "{{user}}");
}

function loadSettledCharacterLifeState(characterId: string) {
  let state = loadVirtualLifeState();
  if (!state.settings.enabled) return state;
  const settled = settleActorTimelineToNow(state, "character", characterId);
  if (settled !== state) state = saveVirtualLifeState(settled);
  return state;
}

/**
 * Shared fact bridge: only confirmed life-scene facts involving this character
 * are surfaced in their normal chat context. Guesses and interpretations are
 * deliberately excluded so the character cannot acquire fabricated memories.
 */
export function buildLifeMemoryContext(characterId: string, limit = 10): string {
  const state = loadSettledCharacterLifeState(characterId);
  if (!state.settings.enabled) return "";
  // Schedule settlement context is a separate source from confirmed shared memories.
  // Disabling shared-memory writes must not silently remove the character's dated
  // schedule history from chat prompts.
  const facts = (state.settings.saveConfirmedEventsToMemory ? state.memories : [])
    .filter(memory => memory.participants.includes(characterId) && memory.fact.trim())
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, Math.max(0, Math.min(limit, 30)))
    .reverse();
  // Completed schedule slots are synced separately from confirmed shared memories.
  // Keep their planned time range explicit so “that period ended” cannot be mistaken
  // for an untimed event or merged with a different day.
  const completedScheduleEvents = state.events
    .filter(event => event.kind === "activity"
      && event.status === "completed"
      && event.participantIds.includes(characterId)
      && event.settlementKey?.startsWith("schedule:")
      && event.startsAt && event.endsAt)
    .sort((a, b) => (b.endsAt || "").localeCompare(a.endsAt || ""))
    .slice(0, 6)
    .reverse();
  if (!facts.length && !completedScheduleEvents.length) return "";
  return [
    facts.length ? "【虚拟生活共同记忆｜已发生事实】" : "",
    facts.length ? "以下是角色本人参与过的生活场景事件摘要。它们是已记录事实，不是猜测；不要擅自扩写成未发生的细节。" : "",
    ...facts.map(fact => {
      const linkedEvent = state.events.find(event => event.id === fact.eventId);
      const timeRange = linkedEvent?.startsAt && linkedEvent.endsAt
        ? "（活动时间：" + formatLifeRange(linkedEvent.startsAt, linkedEvent.endsAt) + "）"
        : "";
      return `- ${formatLifeDateTime(fact.occurredAt)}${timeRange}：${normalizeLifeMemoryUserReference(fact.fact)}`;
    }),
    completedScheduleEvents.length ? "【近期已结算日程｜含明确时间段】" : "",
    completedScheduleEvents.length ? "以下是已到结束时间的行程计划记录，只能说明日程时段已经结算，不代表计划中的每个细节都已被确认发生。" : "",
    ...completedScheduleEvents.map(event => `- ${formatLifeRange(event.startsAt, event.endsAt)}｜${event.title}${event.locationName ? "｜地点：" + event.locationName : ""}`),
  ].filter(Boolean).join("\n");
}

/**
 * Live presence shared with online chat. This is current character state, not
 * a fabricated memory; the prompt must respect sleep, work and actual location.
 */
export function buildLifePresenceContext(characterId: string): string {
  const state = loadSettledCharacterLifeState(characterId);
  if (!state.settings.enabled) return "";
  const clock = getActorClock(state, "character", characterId);
  const now = resolveActorLifeNow(clock);
  const schedule = getCurrentActorSchedule(state, "character", characterId, now);
  const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === characterId);
  const belongsToCharacter = (item: typeof state.scenes[number]) =>
    item.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId);
  const scene = state.scenes.find(item => item.status === "active" && belongsToCharacter(item))
    ?? state.scenes
      .filter(item => item.status === "paused" && belongsToCharacter(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!schedule && !actor && !scene) return "";
  const activity = actor?.activity || schedule?.title || "暂时没有记录当前活动";
  const sleeping = /睡眠|睡觉|入睡|午休|休息/.test(activity) || /睡眠|睡觉|入睡|午休/.test(schedule?.title || "");
  const lines = [
    "【角色当前虚拟生活状态｜线上聊天必须遵守】",
    "角色虚拟时间：" + now.toLocaleString("zh-CN"),
    "当前活动：" + activity,
    "实际地点：" + (actor?.actualLocationName || "未记录"),
    "日程计划：" + (schedule?.title || "当前时段暂无计划"),
    schedule ? "当前日程的完整时间段：" + formatLifeRange(schedule.startAt, schedule.endAt) : "",
    schedule ? "日程语义：这是角色当前计划时段；请明确区分开始时间、结束时间和当前实际活动。" : "",
    scene ? "关联场景：" + scene.locationName + "（场景已保存；只记得自己参与或实际感知到的内容）" : "",
    sleeping
      ? "当前处于睡眠/休息时段。不要因为玩家发来一条线上消息就默认角色已清醒并立刻完整回复。应根据性格、消息紧急程度、是否开启消息提示和既有关系，表现为继续睡、被通知吵醒、迷迷糊糊查看、醒后再回复或第二天解释；不得把未发生的醒来或对话写成事实。"
      : "线上消息到达不代表角色立刻看见。结合当前活动、注意力和性格决定是马上查看、稍后查看，还是线下见面时再回应；不要让线上回复改变既定地点或直接瞬移。",
    "这份状态用于决定角色此刻能否回应，不要把计划地点当成实际定位，也不要让角色知道其没有观察到的玩家行动。",
  ].filter(Boolean);
  return lines.join("\n");
}
