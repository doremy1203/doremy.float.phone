import type { LifeSceneState, LifeSceneMessage } from "./life-types";

export const LIFE_AUTONOMY_TICK_MS = 30_000;
export const LIFE_AUTONOMY_MIN_GAP_MS = 4 * 60_000;
export const LIFE_AUTONOMY_MAX_GAP_MS = 9 * 60_000;
export const LIFE_AUTONOMY_SCENE_COOLDOWN_MS = 2 * 60_000;
export const LIFE_AUTONOMY_DAILY_LIMIT = 12;

export type LifeAutonomyDecision = {
  eligible: boolean;
  reason: string;
  characterIds: string[];
};

/**
 * Deterministic guardrails for proactive life-scene turns.
 * The model decides what to say; this layer decides whether a turn is allowed.
 */
export function evaluateLifeAutonomyWindow(input: {
  scene: LifeSceneState | null;
  playerId: string;
  messages: LifeSceneMessage[];
  now?: number;
  lastAttemptAt?: number;
  intervalMinutes?: number;
  /** Require this much silence from the player before a character may initiate. */
  silenceMinutes?: number;
  busy: boolean;
  visible: boolean;
  enabled: boolean;
}): LifeAutonomyDecision {
  const now = input.now ?? Date.now();
  const scene = input.scene;
  if (!input.enabled) return { eligible: false, reason: "disabled", characterIds: [] };
  if (!scene || scene.status !== "active") return { eligible: false, reason: "no-active-scene", characterIds: [] };
  if (!input.visible) return { eligible: false, reason: "app-not-visible", characterIds: [] };
  if (input.busy) return { eligible: false, reason: "another-turn-running", characterIds: [] };

  const playerPresent = scene.participants.some(p => p.ownerType === "player" && p.ownerId === input.playerId);
  if (!playerPresent) return { eligible: false, reason: "player-not-present", characterIds: [] };

  const characterIds = [...new Set(scene.participants
    .filter(p => p.ownerType === "character" && p.ownerId && p.activity !== "离开")
    .map(p => p.ownerId))];
  if (!characterIds.length) return { eligible: false, reason: "no-character-present", characterIds: [] };

  const sceneMessages = input.messages.filter(m => m.sceneId === scene.id);
  const lastMessage = sceneMessages[sceneMessages.length - 1];
  if (lastMessage && now - new Date(lastMessage.createdAt).getTime() < LIFE_AUTONOMY_SCENE_COOLDOWN_MS) {
    return { eligible: false, reason: "recent-scene-message", characterIds };
  }
  // Silence is measured from the player's latest action/dialogue, not from
  // the latest character message; otherwise a character can keep resetting
  // its own inactivity timer and never follow the user's configured threshold.
  const lastPlayerMessage = [...sceneMessages].reverse().find(m => m.role === "player");
  const silenceMinutes = Math.max(0, Math.min(24 * 60, input.silenceMinutes ?? 5));
  const lastPlayerContactAt = lastPlayerMessage
    ? new Date(lastPlayerMessage.createdAt).getTime()
    : new Date(scene.startedAt).getTime();
  if (Number.isFinite(lastPlayerContactAt) && now - lastPlayerContactAt < silenceMinutes * 60_000) {
    return { eligible: false, reason: "player-still-active", characterIds };
  }

  const minimumGap = Math.max(2, input.intervalMinutes ?? 5) * 60_000;
  if (input.lastAttemptAt && now - input.lastAttemptAt < minimumGap) {
    return { eligible: false, reason: "cooldown", characterIds };
  }

  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const countToday = input.messages.filter(m =>
    m.sceneId === scene.id && m.role === "character" && new Date(m.createdAt).getTime() >= dayStart.getTime()
  ).length;
  if (countToday >= LIFE_AUTONOMY_DAILY_LIMIT) {
    return { eligible: false, reason: "daily-limit", characterIds };
  }

  return { eligible: true, reason: "eligible", characterIds };
}

export function chooseLifeAutonomyCharacter(
  characterIds: string[],
  lastSpeakerId?: string,
  messages: LifeSceneMessage[] = [],
  sceneId?: string,
): string | null {
  if (!characterIds.length) return null;

  // Avoid letting random selection repeatedly favor whichever character happens
  // to be first in the participant list. Prefer the character who has been
  // quiet the longest; characters who have not spoken yet get their first turn
  // before a recently active character. Randomness is used only to break ties.
  const alternatives = characterIds.filter(id => id !== lastSpeakerId);
  const pool = alternatives.length ? alternatives : characterIds;
  const lastSpokeAt = new Map<string, number>();
  for (const message of messages) {
    if (message.role !== "character" || !pool.includes(message.speakerId)) continue;
    if (sceneId && message.sceneId !== sceneId) continue;
    const at = Date.parse(message.createdAt);
    if (!Number.isFinite(at)) continue;
    lastSpokeAt.set(message.speakerId, Math.max(lastSpokeAt.get(message.speakerId) ?? 0, at));
  }

  const oldestAt = Math.min(...pool.map(id => lastSpokeAt.get(id) ?? 0));
  const leastRecentlyHeard = pool.filter(id => (lastSpokeAt.get(id) ?? 0) === oldestAt);
  return leastRecentlyHeard[Math.floor(Math.random() * leastRecentlyHeard.length)] ?? null;
}

export async function notifyLifeSceneMessage(title: string, body: string, onClick?: () => void): Promise<void> {
  if (typeof window === "undefined") return;
  const safeBody = body.trim().slice(0, 180);
  window.dispatchEvent(new CustomEvent("life-scene-proactive-message", {
    detail: { title, body: safeBody, at: Date.now() },
  }));
  // Android 壳：走原生通知横幅（应用切后台/被关时也能送达）。浏览器壳桥不存在时返回 false，静默跳过。
  try {
    const { sendShellNotification } = await import("../shell-notify");
    if (sendShellNotification(title, safeBody, null, null)) return;
  } catch { /* 非壳环境 */ }
  if (document.visibilityState === "visible" || !("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const notification = new Notification(title, { body: safeBody, tag: "life-scene-proactive" });
    notification.onclick = () => {
      window.focus();
      onClick?.();
      notification.close();
    };
  } catch {
    // Notification permissions are optional; the in-app event remains available.
  }
}

/** Resolve a contact ID to its linked character ID; the two IDs are not interchangeable. */
export function resolveLifeCharacterIdForContact(contactId: string, contacts: Array<{ id: string; characterId: string }>): string | null {
  if (!contactId) return null;
  return contacts.find(contact => contact.id === contactId)?.characterId ?? null;
}
