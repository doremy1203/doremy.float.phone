export type PendingLifeSceneTurn = {
  sceneId: string;
  userText: string;
  userAction: string;
  createdAt: string;
  messageId: string;
};

type PersistedQueue = {
  active: PendingLifeSceneTurn | null;
  queued: PendingLifeSceneTurn[];
};

const STORAGE_KEY = "life-scene-turn-queue-v1";
const LIMIT = 100;

function isTurn(value: unknown): value is PendingLifeSceneTurn {
  if (!value || typeof value !== "object") return false;
  const turn = value as Partial<PendingLifeSceneTurn>;
  return typeof turn.sceneId === "string"
    && typeof turn.userText === "string"
    && typeof turn.userAction === "string"
    && typeof turn.createdAt === "string"
    && typeof turn.messageId === "string";
}

function readQueue(): PersistedQueue {
  if (typeof window === "undefined") return { active: null, queued: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { active: null, queued: [] };
    const value = JSON.parse(raw) as { active?: unknown; queued?: unknown };
    return {
      active: isTurn(value.active) ? value.active : null,
      queued: Array.isArray(value.queued) ? value.queued.filter(isTurn).slice(-LIMIT) : [],
    };
  } catch {
    return { active: null, queued: [] };
  }
}

function writeQueue(value: PersistedQueue): void {
  if (typeof window === "undefined") return;
  try {
    const unique = new Map<string, PendingLifeSceneTurn>();
    for (const turn of value.queued.slice(-LIMIT)) unique.set(turn.messageId, turn);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
      active: value.active,
      queued: [...unique.values()].slice(-LIMIT),
    }));
  } catch {
    // A storage quota error must not interrupt the current chat turn.
  }
}

export function savePendingLifeSceneTurns(queued: PendingLifeSceneTurn[]): void {
  writeQueue({ ...readQueue(), queued });
}

export function setActiveLifeSceneTurn(active: PendingLifeSceneTurn): void {
  writeQueue({ ...readQueue(), active });
}

export function clearActiveLifeSceneTurn(messageId?: string): void {
  const current = readQueue();
  if (messageId && current.active?.messageId !== messageId) return;
  writeQueue({ ...current, active: null });
}

export function recoverPendingLifeSceneTurns(): PendingLifeSceneTurn[] {
  const current = readQueue();
  const recovered = [...(current.active ? [current.active] : []), ...current.queued];
  const unique = new Map<string, PendingLifeSceneTurn>();
  for (const turn of recovered) unique.set(turn.messageId, turn);
  const turns = [...unique.values()].slice(-LIMIT);
  writeQueue({ active: null, queued: turns });
  return turns;
}
