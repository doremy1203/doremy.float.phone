import { loadChatMessages, loadChatSessions } from "./chat-storage";
import { loadInstalledCustomApps } from "./custom-app-storage";
import { hydrateKvDb, isKvHydrated, kvEntries } from "./kv-db";
import { hydrateMomentsStorage, loadAllMomentComments, loadMomentPosts } from "./moments-storage";
import { loadPhotoWallState } from "./photo-wall-storage";

/** A single media-store:// id can be referenced by many features. */
export type MediaReferenceUsage = Map<string, Set<string>>;

export type MediaGenerationOrigin = {
  appId: string;
  label: string;
  prompt: string;
};

type ImageGenerationCallRecord = {
  startedAt?: string;
  durationMs?: number;
  appId?: string;
  status?: string;
  prompt?: string;
};

const IMAGE_GENERATION_CALLS_KEY = "ai_phone_image_generation_calls_v1";
const IMAGE_GENERATION_MATCH_WINDOW_MS = 5_000;

const MEDIA_REF_RE = /media-store:\/\/([A-Za-z0-9_-]+)/g;

function addMediaRef(usage: MediaReferenceUsage, raw: unknown, source: string): void {
  if (typeof raw !== "string" || !raw.trim()) return;
  const value = raw.trim();
  const candidates = value.startsWith("media-store://")
    ? [value.slice("media-store://".length)]
    : [value];
  for (const id of candidates) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    if (!usage.has(id)) usage.set(id, new Set());
    usage.get(id)!.add(source);
  }
}

function scanStrings(
  value: unknown,
  source: string,
  usage: MediaReferenceUsage,
  seen = new WeakSet<object>(),
): void {
  if (typeof value === "string") {
    MEDIA_REF_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MEDIA_REF_RE.exec(value)) !== null) addMediaRef(usage, `media-store://${match[1]}`, source);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) scanStrings(item, source, usage, seen);
    return;
  }
  for (const nested of Object.values(value as Record<string, unknown>)) scanStrings(nested, source, usage, seen);
}

function appNameFor(appId: string, names: Map<string, string>): string {
  return names.get(appId) || "旧自定义 APP 数据";
}

function sourceLabelForKvKey(key: string, appNames: Map<string, string>): string {
  if (key.startsWith("ai_phone_custom_app_data_v1:")) {
    const suffix = key.slice("ai_phone_custom_app_data_v1:".length);
    const appId = suffix.split("/")[0] || "";
    return `自定义 APP：${appNameFor(appId, appNames)}`;
  }
  if (key.startsWith("ai_phone_custom_app_timeline_v1:")) {
    const appId = key.slice("ai_phone_custom_app_timeline_v1:".length);
    return `自定义 APP：${appNameFor(appId, appNames)}`;
  }
  if (key.startsWith("ai_phone_photo_wall_")) return "照片墙";
  if (key.startsWith("ai_phone_moments_")) return "朋友圈";
  if (key.startsWith("ai_phone_life") || key.startsWith("life:")) return "生活";
  if (key.startsWith("ai_phone_diary") || key.startsWith("diary")) return "日记";
  return "其他持久数据";
}

function generationAppLabel(appId: string): string {
  if (appId === "moments") return "朋友圈";
  if (appId === "photo_wall") return "照片墙";
  if (appId === "chat") return "聊天";
  if (appId === "custom_app:heartcraft.doris") return "心意手作";
  if (appId.startsWith("custom_app:")) return `自定义 APP：${appId.slice("custom_app:".length)}`;
  return appId || "生图";
}

/**
 * Generated-image cache entries do not carry an app reference, but the local
 * generation diagnostics record the exact completion time and feature. Match
 * the two so the archive can say "朋友圈生成缓存" instead of "未引用".
 */
export function loadMediaGenerationOrigins(): Array<MediaGenerationOrigin & { completedAt: number }> {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(IMAGE_GENERATION_CALLS_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      const record = item as ImageGenerationCallRecord;
      if (record.status !== "success" || !record.startedAt) return [];
      const startedAt = Date.parse(record.startedAt);
      const durationMs = Number(record.durationMs);
      if (!Number.isFinite(startedAt) || !Number.isFinite(durationMs)) return [];
      const appId = String(record.appId || "");
      return [{
        completedAt: startedAt + durationMs,
        appId,
        label: generationAppLabel(appId),
        prompt: String(record.prompt || "").slice(0, 300),
      }];
    });
  } catch {
    return [];
  }
}

export function findMediaGenerationOrigin(
  createdAt: number,
  origins: Array<MediaGenerationOrigin & { completedAt: number }>,
): MediaGenerationOrigin | null {
  let best: (MediaGenerationOrigin & { completedAt: number }) | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const origin of origins) {
    const distance = Math.abs(origin.completedAt - createdAt);
    if (distance > IMAGE_GENERATION_MATCH_WINDOW_MS || distance >= bestDistance) continue;
    best = origin;
    bestDistance = distance;
  }
  return best ? { appId: best.appId, label: best.label, prompt: best.prompt } : null;
}

function chatSessionLabel(session: ReturnType<typeof loadChatSessions>[number]): string {
  const name = session.groupName || session.alias || session.contactId || session.id;
  return `聊天：${name}`;
}

/**
 * Collect every media-store:// reference that a durable feature can still use.
 *
 * The old archive only looked at chat messages and the photo wall, which made
 * custom-app albums, old app data, Life, diary, Moments and other KV-backed
 * features look unreferenced. Deletion must be based on this full picture.
 */
export async function collectMediaReferenceUsage(): Promise<MediaReferenceUsage> {
  const usage: MediaReferenceUsage = new Map();
  await hydrateKvDb().catch(() => undefined);
  await hydrateMomentsStorage().catch(() => undefined);
  const appNames = new Map(loadInstalledCustomApps().map(app => [app.id, app.name]));

  // Chat messages (including imageRefs and generated-image refs).
  for (const session of loadChatSessions()) {
    const source = chatSessionLabel(session);
    for (const message of loadChatMessages(session.id)) {
      scanStrings(message, source, usage);
    }
  }

  // Photo wall photos and its background are first-class media owners.
  try {
    const wall = loadPhotoWallState();
    for (const photo of wall.photos) {
      addMediaRef(usage, photo.mediaRef, `照片墙：${photo.title || "未命名照片"}`);
    }
    addMediaRef(usage, wall.wallBackgroundRef, "照片墙：背景");
  } catch {
    // A damaged photo-wall record must not hide other references.
  }

  // Moments photos are usually theme assets (asset://), but old/imported data
  // can still contain media-store:// refs; include them when present.
  for (const post of loadMomentPosts()) {
    const label = `朋友圈：${String(post.content || post.photoDescription || post.id).slice(0, 32)}`;
    scanStrings(post, label, usage);
  }
  for (const comment of loadAllMomentComments()) {
    scanStrings(comment, "朋友圈：评论", usage);
  }

  // Custom-app __media_refs stores IDs directly (without the media-store://
  // prefix). Those rows are the authoritative per-app ownership records.
  if (isKvHydrated()) {
    for (const { key, value } of kvEntries()) {
      let parsed: unknown = null;
      try { parsed = JSON.parse(value); } catch { parsed = null; }

      if (key.startsWith("ai_phone_custom_app_data_v1:") && key.endsWith("/__media_refs")) {
        const appId = key.slice("ai_phone_custom_app_data_v1:".length, -"/__media_refs".length);
        const source = `自定义 APP：${appNameFor(appId, appNames)}`;
        const rows = Array.isArray(parsed) ? parsed : [];
        for (const row of rows) {
          if (!row || typeof row !== "object") continue;
          addMediaRef(usage, (row as Record<string, unknown>).id, source);
        }
      }

      scanStrings(parsed ?? value, sourceLabelForKvKey(key, appNames), usage);
    }
  }

  // retainedBy is attached to media-cache rows, not custom-app collections.
  // The archive adds those owner labels itself when it reads each summary.

  return usage;
}
