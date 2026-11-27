import type { LifeSceneMessage, LifeSceneState } from "./life-types";

/**
 * 生活现场是限时群聊：
 * - sceneId 是房间；
 * - visibleTo 是消息发出时在场成员的快照；
 * - 同一场景内所有在场角色共享对话，不按说话人切分。
 */
export function lifeSceneParticipantIds(scene: LifeSceneState): string[] {
  return [...new Set(
    (scene.participants ?? [])
      .map(participant => participant.ownerId)
      .filter((id): id is string => Boolean(id)),
  )];
}

/** 给新消息写入成员快照；已有快照不覆盖，保证编辑/重生成不会改变可见范围。 */
export function withLifeSceneVisibility(
  message: LifeSceneMessage,
  scene: LifeSceneState | null | undefined,
): LifeSceneMessage {
  if (!scene || (Array.isArray(message.visibleTo) && message.visibleTo.length > 0)) return message;
  const visibleTo = lifeSceneParticipantIds(scene);
  // 说话人即使因为异常数据不在 participants 里，也至少应该记得自己说过的话。
  if (message.speakerId && !visibleTo.includes(message.speakerId)) visibleTo.push(message.speakerId);
  return { ...message, visibleTo };
}

/**
 * 读取时的可见性判断。旧消息没有 visibleTo 时按当前成员兜底；
 * 新消息严格按发送时快照，避免中途加入补看历史、离开后继续知道新对话。
 */
export function canSeeLifeSceneMessage(
  message: LifeSceneMessage,
  scene: LifeSceneState | null | undefined,
  characterId: string,
): boolean {
  if (!characterId) return false;
  if (Array.isArray(message.visibleTo) && message.visibleTo.length > 0) {
    return message.visibleTo.includes(characterId);
  }
  return Boolean(scene?.participants.some(participant =>
    participant.ownerType === "character" && participant.ownerId === characterId
  ));
}
