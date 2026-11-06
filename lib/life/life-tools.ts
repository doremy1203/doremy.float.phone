import { loadCharacters } from "../character-storage";
import { LIFE_INVITATION_CAPABILITY_ID, LIFE_FOLLOW_CAPABILITY_ID, LIFE_SCHEDULE_CAPABILITY_ID, getInternalCapability } from "../internal-capability-storage";
import { loadChatContacts } from "../chat-storage";
import { appendLifeTimelineEntry, loadVirtualLifeState, saveVirtualLifeState } from "./life-storage";
import {
  applyCharacterLifeScheduleChange,
  getActorClock,
  resolveActorLifeNow,
  makeLifeInvitation,
} from "./life-runtime";

export type LifeToolDefinition = {
  name: string;
  description: string;
  parameterSchema: string;
};

export const LIFE_TOOL_DEFINITIONS: LifeToolDefinition[] = [
  {
    name: "life_propose_invitation",
    description: "角色主动向玩家发起邀约。只有角色本人有真实动机时调用；邀约会进入玩家的待处理列表，由玩家决定是否接受。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        time: { type: "string", description: "邀约开始时间，ISO-8601 格式，必须晚于双方当前现实时间" },
        locationId: { type: "string", description: "地点 ID，例如 cafe、home、park" },
        activity: { type: "string", description: "邀约活动内容" },
        durationMinutes: { type: "number", description: "持续分钟数，15 到 1440，默认 60" },
      },
      required: ["time", "activity"],
    }),
  },
  {
    name: "life_request_follow",
    description: "角色主动申请陪伴并跟随玩家的实际行程。申请不会自动生效，玩家可以接受或拒绝。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        durationMinutes: { type: "number", description: "申请陪伴的分钟数，15 到 1440，默认 120" },
        reason: { type: "string", description: "角色想陪伴玩家的简短原因" },
      },
    }),
  },
  {
    name: "life_change_schedule",
    description: "角色主动调整自己今天尚未开始的普通日程。不得覆盖已确认约会，不得修改玩家日程或过去的时段。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        startAt: { type: "string", description: "新安排开始时间，ISO-8601 格式" },
        endAt: { type: "string", description: "新安排结束时间，ISO-8601 格式" },
        title: { type: "string", description: "新的活动名称" },
        locationId: { type: "string", description: "地点 ID，例如 home、cafe、park" },
      },
      required: ["startAt", "endAt", "title"],
    }),
  },
];

function asArgs(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* invalid args are handled below */ }
  }
  return {};
}

function cleanText(value: unknown, max = 240): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function resolveInvokingCharacterId(rawId?: string): string | null {
  if (!rawId) return null;
  if (loadCharacters().some(character => character.id === rawId)) return rawId;
  const contact = loadChatContacts().find(item => item.id === rawId || item.characterId === rawId);
  const characterId = contact?.characterId;
  return characterId && loadCharacters().some(character => character.id === characterId) ? characterId : null;
}

function result(name: string, success: boolean, data?: string, error?: string) {
  return { name, success, ...(data ? { data } : {}), ...(error ? { error } : {}) };
}

export async function executeLifeToolCall(
  call: { name: string; args: unknown },
  context?: { appId?: string; characterId?: string },
) {
  if (!LIFE_TOOL_DEFINITIONS.some(tool => tool.name === call.name)) return null;
  const capabilityId = call.name === "life_propose_invitation"
    ? LIFE_INVITATION_CAPABILITY_ID
    : call.name === "life_request_follow"
      ? LIFE_FOLLOW_CAPABILITY_ID
      : LIFE_SCHEDULE_CAPABILITY_ID;
  const capability = getInternalCapability(capabilityId);
  if (!capability || !capability.enabled || capability.mode === "off") {
    return result(call.name, false, undefined, "此生活工具能力未启用，请在系统设置 → 聊天工具箱 → Internal Capabilities 中开启对应项目。");
  }
  const name = call.name;
  // The calling surface is not restricted: any chat/tool-enabled app may use life actions
  // as long as the invoking character can be resolved and the global life settings allow it.
  const characterId = resolveInvokingCharacterId(context?.characterId);
  if (!characterId) return result(name, false, undefined, "无法确定正在调用工具的角色身份。");
  const state = loadVirtualLifeState();
  if (!state.settings.enabled || !state.settings.enableCharacterAutonomy) {
    return result(name, false, undefined, "生活引擎或角色自主行动当前已关闭。");
  }
  const args = asArgs(call.args);
  if (name === "life_propose_invitation") {
    if (!state.settings.enableInvitations) return result(name, false, undefined, "角色主动邀约已在自定义设置中关闭。");
    const time = new Date(cleanText(args.time, 80));
    const activity = cleanText(args.activity, 160);
    if (!activity || !Number.isFinite(time.getTime())) return result(name, false, undefined, "需要有效的活动内容和 ISO-8601 时间。");
    const playerNow = resolveActorLifeNow(getActorClock(state, "player", "player"));
    const characterNow = resolveActorLifeNow(getActorClock(state, "character", characterId));
    if (time <= playerNow || time <= characterNow) return result(name, false, undefined, "邀约时间必须晚于玩家和角色各自的当前现实时间。");
    const locationId = cleanText(args.locationId, 100);
    const location = state.locations.find(item => item.id === locationId) ?? state.locations.find(item => item.id === "cafe");
    const duration = Math.max(15, Math.min(Number(args.durationMinutes) || 60, 24 * 60));
    const next = makeLifeInvitation(state, {
      proposedBy: "character",
      characterId, playerId: "player", proposedAt: time.toISOString(),
      locationId: location?.id, locationName: location?.name, activity,
      kind: "appointment", durationMinutes: duration,
    });
    const logged = appendLifeTimelineEntry(next, { category: "tool", title: "角色发起邀约：" + activity, details: "时间：" + time.toLocaleString("zh-CN") + "；地点：" + (location?.name ?? "地点待定"), actorId: characterId, actorName: loadCharacters().find(item => item.id === characterId)?.name ?? "角色", locationName: location?.name, sourceId: next.invitations[0]?.id, occurredAt: characterNow.toISOString() });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({ created: true, activity, time: time.toISOString(), location: location?.name ?? "地点待定", status: "proposed", message: "邀约已提交给玩家，等待玩家接受或拒绝。" }));
  }

  if (name === "life_request_follow") {
    if (!state.settings.enableFollowRequestTool) return result(name, false, undefined, "角色陪伴申请已在自定义设置中关闭。");
    const playerNow = resolveActorLifeNow(getActorClock(state, "player", "player"));
    const characterNow = resolveActorLifeNow(getActorClock(state, "character", characterId));
    const player = state.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const duration = Math.max(15, Math.min(Number(args.durationMinutes) || 120, 24 * 60));
    const reason = cleanText(args.reason, 180);
    const next = makeLifeInvitation(state, {
      proposedBy: "character",
      characterId, playerId: "player",
      proposedAt: new Date(Math.max(playerNow.getTime(), characterNow.getTime()) + 60_000).toISOString(),
      locationId: player?.actualLocationId ?? undefined,
      locationName: player?.actualLocationName ?? undefined,
      activity: "申请陪伴并跟随你的行程" + (reason ? "（" + reason + "）" : ""),
      kind: "follow-request", durationMinutes: duration,
    });
    const logged = appendLifeTimelineEntry(next, { category: "tool", title: "角色申请陪伴", details: (reason ? "原因：" + reason + "；" : "") + "申请时长：" + duration + " 分钟", actorId: characterId, actorName: loadCharacters().find(item => item.id === characterId)?.name ?? "角色", sourceId: next.invitations[0]?.id, occurredAt: characterNow.toISOString() });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({ created: true, durationMinutes: duration, reason, status: "proposed", message: "陪伴申请已提交给玩家，等待玩家接受或拒绝。" }));
  }

  if (name === "life_change_schedule") {
    if (!state.settings.enableScheduleChangeTool) return result(name, false, undefined, "角色自主调整日程已在自定义设置中关闭。");
    const changed = applyCharacterLifeScheduleChange(state, characterId, {
      startAt: cleanText(args.startAt, 80),
      endAt: cleanText(args.endAt, 80),
      title: cleanText(args.title, 120),
      locationId: cleanText(args.locationId, 100),
    });
    if (changed.error) return result(name, false, undefined, changed.error);
    const logged = appendLifeTimelineEntry(changed.state, { category: "schedule", title: "角色调整了日程：" + cleanText(args.title, 120), details: cleanText(args.startAt, 80) + " – " + cleanText(args.endAt, 80), actorId: characterId, actorName: loadCharacters().find(item => item.id === characterId)?.name ?? "角色", locationName: changed.state.locations.find(item => item.id === cleanText(args.locationId, 100))?.name, occurredAt: resolveActorLifeNow(getActorClock(changed.state, "character", characterId)).toISOString() });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({ updated: true, title: cleanText(args.title, 120), startAt: cleanText(args.startAt, 80), endAt: cleanText(args.endAt, 80), message: "角色日程已调整，已确认约会和其他人的日程保持不变。" }));
  }

  return result(name, false, undefined, "未知生活工具。");
}
