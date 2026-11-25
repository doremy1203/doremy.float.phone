import { loadCharacters } from "../character-storage";
import { LIFE_INVITATION_CAPABILITY_ID, LIFE_FOLLOW_CAPABILITY_ID, LIFE_SCHEDULE_CAPABILITY_ID, getInternalCapability } from "../internal-capability-storage";
import { loadChatContacts } from "../chat-storage";
import { appendLifeTimelineEntry, loadVirtualLifeState, saveVirtualLifeState } from "./life-storage";
import {
  applyCharacterLifeScheduleChange,
  getActorClock,
  resolveActorLifeNow,
  makeLifeInvitation,
  reserveCharacterLocationStay,
} from "./life-runtime";

export type LifeToolDefinition = {
  name: string;
  description: string;
  parameterSchema: string;
};

export const LIFE_TOOL_DEFINITIONS: LifeToolDefinition[] = [
  {
    name: "life_view_schedule",
    description: "查询角色本人未来 1 至 7 天的日程。只读，不会修改安排；在答应邀约、调整计划、安排见面或判断自己有没有空闲之前，先调用它确认真实行程。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 7, description: "查询未来几天，1 到 7，默认 7" } },
    }),
  },
  {
    name: "life_propose_invitation",
    description: "角色主动向玩家发起邀约。只要你有具体的时间、地点或想一起做的事，就主动调用，不要只口头问“要不要出来”；邀约会进入玩家的待处理列表，由玩家决定是否接受。",
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
    description: "角色主动申请陪伴并跟随玩家的实际行程。只要你想陪在对方身边、想跟对方一起走接下来的路，就主动调用；申请不会自动生效，玩家可以接受或拒绝。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        durationMinutes: { type: "number", description: "申请陪伴的分钟数，15 到 1440，默认 120" },
        reason: { type: "string", description: "角色想陪伴玩家的简短原因" },
      },
    }),
  },
  {
    name: "life_move_location",
    description: "让角色立刻动身去某个地点，或直接去玩家当前所在地点找人。想见面、临时起意、想送东西、想当面说清楚时，优先直接调用它，不要只在台词里说“我来了”。会保留原有日程、只替换当前正在进行的时段；不覆盖已确认约会和玩家手动安排。省略 locationId 即前往玩家当前所在地点。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        locationId: { type: "string", description: "目标地点 ID 或名称；想去找玩家时省略，或填 player" },
        durationMinutes: { type: "number", description: "在该地点停留的分钟数，15 到 1440，默认 120；到下一个日程边界会自动截断" },
        activity: { type: "string", description: "到达后的活动描述，例如“来找你”“一起吃饭”；省略时自动生成" },
        reason: { type: "string", description: "为什么现在要过去，简短一句" },
      },
    }),
  },
  {
    name: "life_create_schedule",
    description: "为角色本人创建未来 7 天内的新日程。当现有安排里没有你想做的事、或你需要为未来的约定留出时间时，主动创建。先查询已有安排；不得覆盖手动安排、约会或特殊活动。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        startAt: { type: "string", description: "开始时间，ISO-8601 格式" },
        endAt: { type: "string", description: "结束时间，ISO-8601 格式" },
        title: { type: "string", description: "活动名称" },
        locationId: { type: "string", description: "地点库中的规范地点 ID。自己的家使用 home-当前角色ID（若 residents 指向共享住宅则使用该住宅 ID）；去其他角色家吃饭、串门或留宿时，必须使用对方住宅的 home-角色ID，不能把对方家写成自己的 home。省略时默认角色自己的家。" },
      },
      required: ["startAt", "endAt", "title"],
    }),
  },
  {
    name: "life_change_schedule",
    description: "修改角色本人尚未开始的自动生成日程或角色自主创建的未来日程；当计划有变、玩家提出改时间地点、或你想把安排挪到对方所在地点时，主动调用并传入 scheduleId。不得覆盖用户手动安排、约会或特殊活动。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "要修改的自动生成或角色自主创建日程 ID" },
        startAt: { type: "string", description: "新开始时间，ISO-8601 格式" },
        endAt: { type: "string", description: "新结束时间，ISO-8601 格式" },
        title: { type: "string", description: "新的活动名称" },
        locationId: { type: "string", description: "地点库中的规范地点 ID。自己的家使用 home-当前角色ID（若 residents 指向共享住宅则使用该住宅 ID）；去其他角色家吃饭、串门或留宿时，必须使用对方住宅的 home-角色ID，不能把对方家写成自己的 home。省略时默认角色自己的家。" },
      },
      required: ["startAt", "endAt", "title"],
    }),
  },
  {
    name: "life_cancel_schedule",
    description: "取消角色本人尚未开始的自动生成或角色自主创建的未来日程，并将该时段保留为自由时间。当某项安排不再需要、或你想空出时间陪对方时主动调用。不能取消用户手动安排、约会、特殊活动或已经开始的日程。",
    parameterSchema: JSON.stringify({
      type: "object",
      properties: { scheduleId: { type: "string", description: "要取消的自动生成或角色自主创建日程 ID" } },
      required: ["scheduleId"],
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
  if (!state.settings.enabled || (name !== "life_view_schedule" && !state.settings.enableCharacterAutonomy)) {
    return result(name, false, undefined, name === "life_view_schedule"
      ? "生活引擎当前已关闭。"
      : "生活引擎或角色自主行动当前已关闭。");
  }
  const args = asArgs(call.args);
  if (name === "life_view_schedule") {
    const rawDays = Number(args.days);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(7, Math.floor(rawDays))) : 7;
    const now = resolveActorLifeNow(getActorClock(state, "character", characterId));
    const until = new Date(now.getTime() + days * 24 * 60 * 60_000);
    const schedules = state.schedules
      .filter(slot => slot.ownerType === "character" && slot.ownerId === characterId
        && new Date(slot.endAt).getTime() > now.getTime()
        && new Date(slot.startAt).getTime() < until.getTime())
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 100)
      .map(slot => ({
        id: slot.id, startAt: slot.startAt, endAt: slot.endAt, title: slot.title,
        location: slot.plannedLocationName ?? null, kind: slot.kind, source: slot.source,
      }));
    return result(name, true, JSON.stringify({ characterId, from: now.toISOString(), to: until.toISOString(), days, schedules }));
  }
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

  if (name === "life_move_location") {
    if (!state.settings.enableScheduleChangeTool) return result(name, false, undefined, "角色自主调整日程已在自定义设置中关闭。");
    const rawTarget = cleanText(args.locationId, 100);
    const wantsPlayer = !rawTarget || /^(player|me|玩家|你|user)$/i.test(rawTarget);
    const player = state.actorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const location = wantsPlayer
      ? state.locations.find(item => item.id === player?.actualLocationId)
      : state.locations.find(item => item.id === rawTarget)
        ?? state.locations.find(item => item.name === rawTarget)
        ?? state.locations.find(item => (item.aliases ?? []).includes(rawTarget));
    if (!location) {
      return result(name, false, undefined, wantsPlayer
        ? "找不到玩家当前所在地点；请改用具体地点 ID，或先用 life_view_schedule 确认可用地点。"
        : "地点不存在。请使用地点库中的规范地点 ID 或准确名称。");
    }
    const now = resolveActorLifeNow(getActorClock(state, "character", characterId));
    const duration = Math.max(15, Math.min(Number(args.durationMinutes) || 120, 24 * 60));
    const until = new Date(now.getTime() + duration * 60_000);
    const title = cleanText(args.activity, 120) || (wantsPlayer ? "来找你" : "前往" + location.name);
    const reason = cleanText(args.reason, 180);
    const actorName = loadCharacters().find(item => item.id === characterId)?.name ?? "角色";
    let next = reserveCharacterLocationStay(state, {
      characterId, locationId: location.id, locationName: location.name,
      startAt: now, endAt: until, title,
      slotSource: "character-tool", locationSource: "stay",
    });
    const nowIso = now.toISOString();
    next = {
      ...next,
      scenes: next.scenes.map(scene => {
        const hasCharacter = scene.participants.some(participant => participant.ownerType === "character" && participant.ownerId === characterId);
        if (scene.locationId !== location.id) {
          if (!hasCharacter || scene.status !== "active") return scene;
          return { ...scene, participants: scene.participants.filter(participant => !(participant.ownerType === "character" && participant.ownerId === characterId)), updatedAt: nowIso };
        }
        if (scene.status !== "active") return scene;
        if (hasCharacter) {
          return {
            ...scene,
            participants: scene.participants.map(participant => participant.ownerType === "character" && participant.ownerId === characterId
              ? { ...participant, activity: title }
              : participant),
            updatedAt: nowIso,
          };
        }
        return {
          ...scene,
          participants: [
            ...scene.participants,
            { ownerType: "character" as const, ownerId: characterId, activity: title, awarenessByActorId: { player: "aware" as const } },
          ],
          updatedAt: nowIso,
        };
      }),
    };
    const logged = appendLifeTimelineEntry(next, {
      category: "location",
      title: (wantsPlayer ? "角色来找你：" : "角色前往") + location.name,
      details: "停留约 " + duration + " 分钟" + (reason ? "；原因：" + reason : ""),
      actorId: characterId, actorName, locationName: location.name, occurredAt: nowIso,
    });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({
      moved: true,
      locationId: location.id,
      locationName: location.name,
      until: until.toISOString(),
      message: wantsPlayer
        ? "你已经来到玩家所在地点「" + location.name + "」。现在可以直接用一句自然的招呼或说明来意，不要只描述移动过程。"
        : "你已经到达「" + location.name + "」。现在可以自然地做接下来想做的事。",
    }));
  }

  if (name === "life_create_schedule" || name === "life_change_schedule") {
    if (!state.settings.enableScheduleChangeTool) return result(name, false, undefined, "角色自主调整日程已在自定义设置中关闭。");
    const now = resolveActorLifeNow(getActorClock(state, "character", characterId));
    const scheduleId = cleanText(args.scheduleId, 160);
    let baseState = state;
    if (name === "life_change_schedule" && scheduleId) {
      const existing = state.schedules.find(slot => slot.id === scheduleId
        && slot.ownerType === "character" && slot.ownerId === characterId
        && (slot.source === "weekly-generation" || slot.source === "character-tool")
        && slot.kind !== "appointment"
        && new Date(slot.startAt).getTime() > now.getTime());
      if (!existing) return result(name, false, undefined, "只能修改角色本人尚未开始的自动生成或角色自主创建日程；用户手动安排和已确认活动不可修改。");
      baseState = { ...state, schedules: state.schedules.filter(slot => slot.id !== scheduleId) };
    }
    const changed = applyCharacterLifeScheduleChange(baseState, characterId, {
      startAt: cleanText(args.startAt, 80),
      endAt: cleanText(args.endAt, 80),
      title: cleanText(args.title, 120),
      locationId: cleanText(args.locationId, 100),
    }, now);
    if (changed.error) return result(name, false, undefined, changed.error);
    const actorName = loadCharacters().find(item => item.id === characterId)?.name ?? "角色";
    const logged = appendLifeTimelineEntry(changed.state, {
      category: "schedule",
      title: (name === "life_create_schedule" ? "角色创建了日程：" : "角色调整了日程：") + cleanText(args.title, 120),
      details: cleanText(args.startAt, 80) + " – " + cleanText(args.endAt, 80),
      actorId: characterId, actorName,
      locationName: changed.state.locations.find(item => item.id === cleanText(args.locationId, 100))?.name,
      occurredAt: now.toISOString(),
    });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({ createdOrUpdated: true, title: cleanText(args.title, 120), startAt: cleanText(args.startAt, 80), endAt: cleanText(args.endAt, 80), message: "角色日程已保存；用户手动安排和已确认活动未被覆盖。" }));
  }

  if (name === "life_cancel_schedule") {
    if (!state.settings.enableScheduleChangeTool) return result(name, false, undefined, "角色自主调整日程已在自定义设置中关闭。");
    const scheduleId = cleanText(args.scheduleId, 160);
    const now = resolveActorLifeNow(getActorClock(state, "character", characterId));
    const target = state.schedules.find(slot => slot.id === scheduleId
      && slot.ownerType === "character" && slot.ownerId === characterId
      && (slot.source === "weekly-generation" || slot.source === "character-tool")
      && slot.kind !== "appointment"
      && new Date(slot.startAt).getTime() > now.getTime());
    if (!target) return result(name, false, undefined, "只能取消角色本人尚未开始的自动生成或角色自主创建日程；用户手动安排和已确认活动不可取消。");
    if (target.kind === "free-time") return result(name, false, undefined, "该时段已经是自由时间，无需再次取消。");
    // Keep an explicit character-authored free-time placeholder so the weekly
    // generator does not silently recreate the cancelled baseline activity.
    const freeSlot = {
      id: "life-tool-free-" + characterId + "-" + new Date(target.startAt).getTime() + "-" + Math.random().toString(36).slice(2, 9),
      ownerType: "character" as const, ownerId: characterId,
      startAt: target.startAt, endAt: target.endAt,
      title: "自由活动", kind: "free-time" as const, source: "character-tool" as const,
      plannedLocationId: null, plannedLocationName: null, updatedAt: now.toISOString(),
    };
    const next = { ...state, schedules: [...state.schedules.filter(slot => slot.id !== scheduleId), freeSlot] };
    const logged = appendLifeTimelineEntry(next, {
      category: "schedule", title: "角色取消了日程：" + target.title,
      details: target.startAt + " – " + target.endAt + "（已释放为自由时间）",
      actorId: characterId, actorName: loadCharacters().find(item => item.id === characterId)?.name ?? "角色",
      occurredAt: now.toISOString(),
    });
    saveVirtualLifeState(logged);
    return result(name, true, JSON.stringify({ cancelled: true, scheduleId, title: target.title }));
  }

  return result(name, false, undefined, "未知生活工具。");
}
