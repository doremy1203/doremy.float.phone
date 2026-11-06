/**
 * Shared lease for foreground life-scene autonomy and server-side offline scheduling.
 * The foreground owns the scene only while the life page is visible; offline jobs defer
 * against this lease and remain queued for abrupt WebView termination.
 */
export const LIFE_SCENE_FOREGROUND_LEASE_KEY = "life-scene-foreground-lease-v1";
export const LIFE_PRESENCE_LEASE_UPDATED_EVENT = "life-presence-lease-updated";

function notifyPresenceLeaseUpdated(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LIFE_PRESENCE_LEASE_UPDATED_EVENT));
}

export type LifeSceneForegroundLease = {
  sceneId: string;
  expiresAt: number;
};

export function setLifeSceneForegroundLease(sceneId: string, active: boolean): void {
  if (typeof window === "undefined") return;
  try {
    const current = JSON.parse(localStorage.getItem(LIFE_SCENE_FOREGROUND_LEASE_KEY) || "null") as { sceneId?: string } | null;
    if (active && sceneId) {
      localStorage.setItem(LIFE_SCENE_FOREGROUND_LEASE_KEY, JSON.stringify({ sceneId, expiresAt: Date.now() + 120_000 }));
    } else if (!sceneId || current?.sceneId === sceneId) {
      localStorage.removeItem(LIFE_SCENE_FOREGROUND_LEASE_KEY);
    }
  } catch {
    // Storage can be unavailable in restricted WebViews; in that case foreground arbitration degrades.
  } finally {
    notifyPresenceLeaseUpdated();
  }
}

export function readLifeSceneForegroundLease(now = Date.now()): LifeSceneForegroundLease | null {
  if (typeof window === "undefined") return null;
  try {
    const lease = JSON.parse(localStorage.getItem(LIFE_SCENE_FOREGROUND_LEASE_KEY) || "null") as { sceneId?: string; expiresAt?: number } | null;
    if (!lease?.sceneId || !Number.isFinite(lease.expiresAt) || Number(lease.expiresAt) <= now) return null;
    return { sceneId: lease.sceneId, expiresAt: Number(lease.expiresAt) };
  } catch {
    return null;
  }
}


/** A visible direct-chat lease temporarily protects the user's active conversation.
 * Life schedule jobs remain queued and resume after the chat is hidden or closed. */
export const ONLINE_CHAT_FOREGROUND_LEASE_KEY = "online-chat-foreground-lease-v1";
export type OnlineChatForegroundLease = {
  characterId: string;
  sessionId: string;
  expiresAt: number;
};

export function setOnlineChatForegroundLease(characterId: string, sessionId: string, active: boolean): void {
  if (typeof window === "undefined" || !characterId || !sessionId) return;
  try {
    if (active) {
      localStorage.setItem(ONLINE_CHAT_FOREGROUND_LEASE_KEY, JSON.stringify({
        characterId,
        sessionId,
        expiresAt: Date.now() + 90_000,
      }));
    } else {
      const current = JSON.parse(localStorage.getItem(ONLINE_CHAT_FOREGROUND_LEASE_KEY) || "null") as { sessionId?: string } | null;
      if (!current?.sessionId || current.sessionId === sessionId) localStorage.removeItem(ONLINE_CHAT_FOREGROUND_LEASE_KEY);
    }
  } catch {
    // The lease is advisory; character-wide local turn arbitration still protects live replies.
  } finally {
    notifyPresenceLeaseUpdated();
  }
}

export function readOnlineChatForegroundLease(now = Date.now()): OnlineChatForegroundLease | null {
  if (typeof window === "undefined") return null;
  try {
    const lease = JSON.parse(localStorage.getItem(ONLINE_CHAT_FOREGROUND_LEASE_KEY) || "null") as Partial<OnlineChatForegroundLease> | null;
    if (!lease?.characterId || !lease.sessionId || !Number.isFinite(lease.expiresAt) || Number(lease.expiresAt) <= now) return null;
    return { characterId: lease.characterId, sessionId: lease.sessionId, expiresAt: Number(lease.expiresAt) };
  } catch {
    return null;
  }
}
