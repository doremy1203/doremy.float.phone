export type PendingLifeSceneNotificationReply = {
  replyId: string;
  sceneId: string;
  characterId: string;
  replyMode: "action" | "dialogue";
  status?: "pending" | "processing" | "failed";
  attempts?: number;
  processingAt?: number;
  nextAttemptAt?: number;
  lastError?: string;
};

const KEY = "life-scene-notification-reply-queue-v2";
const LEGACY_KEY = "life-scene-notification-reply-queue-v1";
const LIMIT = 100;
const PROCESSING_LEASE_MS = 90_000;
const MAX_ATTEMPTS = 5;

function readQueue(): PendingLifeSceneNotificationReply[] {
  if (typeof window === "undefined") return [];
  const parse = (raw: string | null): unknown => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  };
  try {
    const currentRaw = localStorage.getItem(KEY);
    const current = parse(currentRaw);
    // Only fall back to v1 when v2 is absent or corrupted; an intentional empty v2
    // queue must never resurrect already-acknowledged legacy replies.
    const raw = Array.isArray(current) ? current : parse(localStorage.getItem(LEGACY_KEY));
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(item => {
      if (!item || typeof item.replyId !== "string" || typeof item.sceneId !== "string"
        || typeof item.characterId !== "string" || (item.replyMode !== "action" && item.replyMode !== "dialogue")) return [];
      const status = item.status === "processing" || item.status === "failed" ? item.status : "pending";
      const attempts = Number(item.attempts);
      const processingAt = Number(item.processingAt);
      const nextAttemptAt = Number(item.nextAttemptAt);
      return [{
        replyId: item.replyId,
        sceneId: item.sceneId,
        characterId: item.characterId,
        replyMode: item.replyMode,
        status: status === "processing" && Number.isFinite(processingAt) && processingAt > 0 ? "processing" : status === "failed" ? "failed" : "pending",
        attempts: Number.isFinite(attempts) && attempts >= 0 ? Math.floor(attempts) : 0,
        processingAt: Number.isFinite(processingAt) && processingAt > 0 ? processingAt : undefined,
        nextAttemptAt: Number.isFinite(nextAttemptAt) && nextAttemptAt > 0 ? nextAttemptAt : undefined,
        lastError: typeof item.lastError === "string" ? item.lastError.slice(0, 500) : undefined,
      }];
    });
  } catch {
    return [];
  }
}

function writeQueue(queue: PendingLifeSceneNotificationReply[]): void {
  if (typeof window === "undefined") return;
  // Existing queues may be larger than the current limit after migration. Let them drain;
  // enqueuePendingLifeSceneReply alone enforces the cap for new work.
  localStorage.setItem(KEY, JSON.stringify(queue));
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* migration cleanup is best effort */ }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("life-scene-notification-queue-updated"));
    window.dispatchEvent(new Event("life-diagnostics-updated"));
  }
}

export function enqueuePendingLifeSceneReply(item: PendingLifeSceneNotificationReply): boolean {
  if (typeof window === "undefined" || !item.replyId || !item.sceneId || !item.characterId) return false;
  const queue = readQueue();
  if (queue.some(existing => existing.replyId === item.replyId)) return true;
  if (queue.length >= LIMIT) return false;
  try {
    writeQueue([...queue, { ...item, status: "pending", attempts: 0 }]);
    return true;
  } catch {
    // The native queue remains unacknowledged and will retry the web-side write.
    return false;
  }
}
/** Return the oldest unfinished reply; expired processing leases become retryable. */
export function peekPendingLifeSceneReply(now = Date.now()): PendingLifeSceneNotificationReply | null {
  const queue = readQueue();
  let changed = false;
  const recovered = queue.map(item => {
    if (item.status === "processing" && now - (item.processingAt || 0) >= PROCESSING_LEASE_MS) {
      changed = true;
      return { ...item, status: "pending" as const, processingAt: undefined, nextAttemptAt: now, lastError: "上次处理被中断，已恢复重试。" };
    }
    return item;
  });
  if (changed) writeQueue(recovered);
  return recovered.find(item => item.status !== "failed") ?? null;
}

/** Claim before invoking the model so multiple page effects cannot run the same reply. */
export function claimPendingLifeSceneReply(replyId: string, now = Date.now()): PendingLifeSceneNotificationReply | null {
  const queue = readQueue();
  const index = queue.findIndex(item => item.replyId === replyId && item.status === "pending" && (item.nextAttemptAt || 0) <= now);
  if (index < 0) return null;
  const claimed = { ...queue[index], status: "processing" as const, processingAt: now, attempts: (queue[index].attempts || 0) + 1 };
  queue[index] = claimed;
  writeQueue(queue);
  return claimed;
}

/** Extend the processing lease while a model request is still actively running. */
export function renewPendingLifeSceneReply(replyId: string, now = Date.now()): void {
  const queue = readQueue();
  const index = queue.findIndex(item => item.replyId === replyId && item.status === "processing");
  if (index < 0) return;
  queue[index] = { ...queue[index], processingAt: now };
  writeQueue(queue);
}
/** Keep failed/deferred work durable; retry with bounded exponential backoff. */
export function retryPendingLifeSceneReply(replyId: string, error: string, now = Date.now(), countAttempt = true): void {
  const queue = readQueue();
  const index = queue.findIndex(item => item.replyId === replyId);
  if (index < 0) return;
  const attempts = Math.max(0, (queue[index].attempts || 0) - (countAttempt ? 0 : 1));
  const exhausted = attempts >= MAX_ATTEMPTS;
  const delay = Math.min(5 * 60_000, 5_000 * Math.pow(2, Math.max(0, attempts - 1)));
  queue[index] = {
    ...queue[index],
    attempts,
    status: exhausted ? "failed" : "pending",
    processingAt: undefined,
    nextAttemptAt: exhausted ? undefined : now + delay,
    lastError: error.slice(0, 500),
  };
  writeQueue(queue);
}

/** Mark a reply terminal when its scene or participant no longer exists. Keep it visible for manual inspection. */
export function failPendingLifeSceneReply(replyId: string, error: string): void {
  const queue = readQueue();
  const index = queue.findIndex(item => item.replyId === replyId);
  if (index < 0) return;
  queue[index] = {
    ...queue[index],
    status: "failed",
    processingAt: undefined,
    nextAttemptAt: undefined,
    lastError: error.slice(0, 500),
  };
  writeQueue(queue);
}

/** Acknowledge only after the character response has been persisted to the scene. */
export function acknowledgePendingLifeSceneReply(replyId: string): void {
  if (typeof window === "undefined" || !replyId) return;
  try { writeQueue(readQueue().filter(item => item.replyId !== replyId)); } catch { /* stable reply ID prevents duplicate user-message writes */ }
}

/** List exhausted replies so the diagnostics UI can offer an explicit manual retry. */
export function readFailedLifeSceneReplies(): PendingLifeSceneNotificationReply[] {
  return readQueue().filter(item => item.status === "failed");
}
/** Explicit recovery hook for a user retry action or a fresh manual retry flow. */
export function resetFailedLifeSceneReply(replyId: string): void {
  const queue = readQueue();
  const index = queue.findIndex(item => item.replyId === replyId && item.status === "failed");
  if (index < 0) return;
  queue[index] = { ...queue[index], status: "pending", attempts: 0, processingAt: undefined, nextAttemptAt: Date.now(), lastError: undefined };
  writeQueue(queue);
  if (typeof window !== "undefined") window.dispatchEvent(new Event("life-scene-notification-reply"));
}


/** Remove only the life-scene notification reply queue (current and legacy formats). */
export function clearLifeSceneNotificationQueue(): void {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem(KEY); } catch { /* best effort */ }
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* best effort */ }
  window.dispatchEvent(new Event("life-scene-notification-queue-updated"));
  window.dispatchEvent(new Event("life-diagnostics-updated"));
}
