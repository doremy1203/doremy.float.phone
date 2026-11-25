/**
 * 场景归并：同一地点只保留一个聊天室。
 *
 * 背景：历史数据（重置/市场版迁移）里可能出现同一地点多份 scene。
 * 而 findLifeSceneForLocation 按 updatedAt 排序取第一个，只要旧场景被 touch
 * 就会翻转 → 同一个地点每次点进去是不同的聊天室。
 *
 * 规则：
 *  · 同一 locationId（没有 id 时按地点名）合并成一个
 *  · 保留优先级：active > paused > completed，同级取最近更新
 *  · 参与者、已结算事件 id、图片按 id 去重合并；旧场景的消息与时间线重挂到保留房间
 *  · 全局最多一个 active：优先玩家当前所在地点的那个，否则最近更新的那个
 *
 * 幂等：没有重复时原样返回（对象引用不变）。
 */
import type { LifeSceneState, LifeSceneParticipant, VirtualLifeState } from "./life-types";

function participantKey(participant: LifeSceneParticipant): string {
  return participant.ownerType + ":" + participant.ownerId;
}

export function consolidateLifeScenes(state: VirtualLifeState): VirtualLifeState {
  const scenes = state.scenes;
  if (!Array.isArray(scenes) || scenes.length <= 1) return state;

  const groups = new Map<string, LifeSceneState[]>();
  for (const scene of scenes) {
    const key = scene.locationId || "name:" + scene.locationName;
    const list = groups.get(key);
    if (list) list.push(scene);
    else groups.set(key, [scene]);
  }

  const keepers: LifeSceneState[] = [];
  const dropped = new Map<string, string>();
  const rank = (scene: LifeSceneState) => (scene.status === "active" ? 0 : scene.status === "paused" ? 1 : 2);

  for (const group of groups.values()) {
    if (group.length === 1) {
      keepers.push(group[0]);
      continue;
    }
    const ordered = group.slice().sort((left, right) =>
      rank(left) - rank(right) || right.updatedAt.localeCompare(left.updatedAt)
    );
    const keeper: LifeSceneState = { ...ordered[0] };
    for (const other of ordered.slice(1)) dropped.set(other.id, keeper.id);

    const participants: LifeSceneParticipant[] = [];
    const seenParticipants = new Set<string>();
    for (const scene of ordered) {
      for (const participant of scene.participants ?? []) {
        const key = participantKey(participant);
        if (seenParticipants.has(key)) continue;
        seenParticipants.add(key);
        participants.push(participant);
      }
    }
    keeper.participants = participants;
    keeper.lastSettledEventIds = Array.from(new Set(ordered.flatMap(scene => scene.lastSettledEventIds ?? [])));
    const images: NonNullable<LifeSceneState["images"]> = [];
    const seenImages = new Set<string>();
    for (const scene of ordered) {
      for (const image of scene.images ?? []) {
        if (seenImages.has(image.id)) continue;
        seenImages.add(image.id);
        images.push(image);
      }
    }
    if (images.length) keeper.images = images;
    if (!keeper.currentDescription) {
      keeper.currentDescription = ordered.map(scene => scene.currentDescription).find(Boolean);
    }
    keepers.push(keeper);
  }

  let changed = dropped.size > 0;

  const actives = keepers.filter(scene => scene.status === "active");
  if (actives.length > 1) {
    const playerLocation = state.actorStates.find(actor => actor.ownerType === "player")?.actualLocationId;
    const preferred = keepers.find(scene => scene.status === "active" && scene.locationId === playerLocation)
      ?? actives.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    for (const scene of keepers) {
      if (scene.status === "active" && scene !== preferred) {
        scene.status = "paused";
        changed = true;
      }
    }
  }

  if (!changed) return state;

  const remap = (id: string | undefined) => (id && dropped.get(id)) || id;
  const sceneMessages = state.sceneMessages.map(message => {
    const nextId = remap(message.sceneId);
    return nextId === message.sceneId ? message : { ...message, sceneId: nextId as string };
  });
  const timeline = state.timeline.map(entry => {
    if (!entry.sceneId) return entry;
    const nextId = remap(entry.sceneId);
    return nextId === entry.sceneId ? entry : { ...entry, sceneId: nextId as string };
  });

  return { ...state, scenes: keepers, sceneMessages, timeline };
}
