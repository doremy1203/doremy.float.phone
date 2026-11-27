import { loadVirtualLifeState } from "./life-storage";
import { findCurrentLifeScene } from "./life-engine";
import { getActorClock, getCurrentActorSchedule, resolveActorLifeNow } from "./life-runtime";

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

/**
 * Live presence shared with online chat. This is current character state, not
 * a fabricated memory; the prompt must respect sleep, work and actual location.
 */
export function buildLifePresenceContext(characterId: string): string {
  const state = loadVirtualLifeState();
  if (!state.settings.enabled) return "";
  const clock = getActorClock(state, "character", characterId);
  const now = resolveActorLifeNow(clock);
  const schedule = getCurrentActorSchedule(state, "character", characterId, now);
  const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === characterId);
  const belongsToCharacter = (item: typeof state.scenes[number]) =>
    item.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId);
  const scene = findCurrentLifeScene(state.scenes.filter(belongsToCharacter));
  if (!schedule && !actor && !scene) return "";
  const activity = actor?.activity || schedule?.title || "暂时没有记录当前活动";
  const scheduledSleeping = /睡眠|睡觉|入睡|午休|休息/.test(activity) || /睡眠|睡觉|入睡|午休/.test(schedule?.title || "");
  const storedAwakeUntil = actor?.onlineChatAwakeUntil ? Date.parse(actor.onlineChatAwakeUntil) : Number.NaN;
  const storedAwakeGraceActive = Number.isFinite(storedAwakeUntil) && storedAwakeUntil > now.getTime();
  const wakeForThisReply = scheduledSleeping && state.settings.allowOnlineChatDuringSleep && !storedAwakeGraceActive;
  const awakeGraceActive = state.settings.allowOnlineChatDuringSleep && (storedAwakeGraceActive || wakeForThisReply);
  const displayActivity = awakeGraceActive ? "被线上消息唤醒，暂时保持清醒" : activity;
  const sleeping = scheduledSleeping && !awakeGraceActive;
  // Inject only the remaining entries for this local calendar day. The current
  // slot is already described above, so exclude it to avoid duplicate context.
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const nextDay = new Date(dayStart);
  nextDay.setDate(nextDay.getDate() + 1);
  const remainingToday = state.schedules
    .filter(item => item.ownerType === "character" && item.ownerId === characterId
      && item.id !== schedule?.id
      && new Date(item.endAt).getTime() > now.getTime()
      && new Date(item.startAt).getTime() < nextDay.getTime())
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 8);
  const lines = [
    "【角色当前虚拟生活状态｜线上聊天必须遵守】",
    "角色虚拟时间：" + now.toLocaleString("zh-CN"),
    "当前活动：" + displayActivity,
    "实际地点：" + (actor?.actualLocationName || "未记录"),
    "日程计划：" + (schedule?.title || "当前时段暂无计划"),
    schedule ? "当前日程的完整时间段：" + formatLifeRange(schedule.startAt, schedule.endAt) : "",
    schedule ? "日程语义：这是角色当前计划时段；请明确区分开始时间、结束时间和当前实际活动。" : "",
    remainingToday.length ? "【今天接下来的安排｜包含尚未结束的日程】" : "",
    ...remainingToday.map(item => "- " + formatLifeRange(item.startAt, item.endAt) + "｜" + item.title + (item.plannedLocationName ? "｜计划地点：" + item.plannedLocationName : "")),
    scene ? "关联场景：" + scene.locationName + "（场景已保存；只记得自己参与或实际感知到的内容）" : "",
    awakeGraceActive
      ? "本次线上消息可唤醒角色；按角色状态自然回应，连续聊天时保持清醒，不改写原睡眠日程。"
      : sleeping
        ? "当前处于睡眠/休息时段。不要因为玩家发来一条线上消息就默认角色已清醒并立刻完整回复。应根据性格、消息紧急程度、是否开启消息提示和既有关系，表现为继续睡、被通知吵醒、迷迷糊糊查看、醒后再回复或第二天解释；不得把未发生的醒来或对话写成事实。"
        : "线上消息到达不代表角色立刻看见。结合当前活动、注意力和性格决定是马上查看、稍后查看，还是线下见面时再回应；不要让线上回复改变既定地点或直接瞬移。",
    "这份状态用于决定角色此刻能否回应，不要把计划地点当成实际定位，也不要让角色知道其没有观察到的玩家行动。",
  ].filter(Boolean);
  return lines.join("\n");
}
