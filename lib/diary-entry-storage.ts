import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";
import { appendLifeTimelineEntry, loadVirtualLifeState, saveVirtualLifeState } from "./life/life-storage";
import {
  DEFAULT_DIARY_ENTRY_TIMER_SETTINGS,
  type DiaryEntry,
  type DiaryEntryBlock,
  type DiaryEntryInput,
  type DiaryEntryTimerSettings,
  type DiaryEntryTodoItem,
  type DiaryEntryTrigger,
} from "./diary-entry-types";

const ENTRIES_KEY = "ai_phone_diary_entries_v1";
const TIMER_KEY = "ai_phone_diary_entry_timer_settings_v1";
export const DIARY_ENTRY_FONT_ASSET_KEY = "ai_phone_diary_entry_font_asset_v1";
export const DIARY_ENTRY_FONT_SCALE_KEY = "ai_phone_diary_entry_font_scale_v1";

registerKvMigration(ENTRIES_KEY);
registerKvMigration(TIMER_KEY);
registerKvMigration(DIARY_ENTRY_FONT_ASSET_KEY);
registerKvMigration(DIARY_ENTRY_FONT_SCALE_KEY);

function generateId(prefix: string): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanMultilineText(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/\r\n?/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n");
}

function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return Array.from(new Set(raw.map(item => cleanText(item, 16)).filter(Boolean))).slice(0, 5);
}

function normalizeTodoItems(value: unknown): DiaryEntryTodoItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): DiaryEntryTodoItem | null => {
      if (typeof item === "string") {
        const text = cleanText(item, 120);
        return text ? { text, done: false } : null;
      }
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const text = cleanText(record.text ?? record.content ?? record.title, 120);
      if (!text) return null;
      return { text, done: Boolean(record.done ?? record.completed ?? record.checked) };
    })
    .filter((item): item is DiaryEntryTodoItem => Boolean(item))
    .slice(0, 10);
}

function normalizeBlocks(value: unknown, fallbackBody = ""): DiaryEntryBlock[] {
  const raw = Array.isArray(value) ? value : [];
  const blocks = raw
    .map((block): DiaryEntryBlock | null => {
      if (typeof block === "string") {
        const text = cleanMultilineText(block, 900);
        return text ? { type: "paragraph", text } : null;
      }
      if (!block || typeof block !== "object") return null;
      const record = block as Record<string, unknown>;
      const type = cleanText(record.type, 32);
      if (type === "todo" || type === "todos" || type === "list") {
        const items = normalizeTodoItems(record.items ?? record.todos ?? record.list);
        if (items.length === 0) return null;
        return {
          type: "todo",
          title: cleanText(record.title ?? record.heading, 40),
          items,
        };
      }
      if (type === "correction" || type === "strike" || type === "redaction") {
        const text = cleanText(record.text ?? record.from ?? record.old, 220);
        const replacement = cleanText(record.replacement ?? record.to ?? record.new, 220);
        if (!text && !replacement) return null;
        return {
          type: "correction",
          text: text || replacement,
          replacement: replacement || undefined,
        };
      }
      if (type === "image" || type === "picture" || type === "photo") {
        const description = cleanMultilineText(record.description ?? record.prompt ?? record.text ?? record.alt, 420);
        if (!description) return null;
        return {
          type: "image",
          caption: cleanText(record.caption ?? record.title, 80),
          description,
        };
      }
      if (type === "quote") {
        const text = cleanMultilineText(record.text ?? record.content ?? record.body, 500);
        return text ? { type: "quote", text } : null;
      }
      const text = cleanMultilineText(record.text ?? record.content ?? record.body, 900);
      return text ? { type: "paragraph", text } : null;
    })
    .filter((block): block is DiaryEntryBlock => Boolean(block))
    .slice(0, 18);

  if (blocks.length > 0) return blocks;

  const paragraphs = cleanMultilineText(fallbackBody, 3000)
    .split(/\n{2,}|\n/)
    .map(text => text.trim())
    .filter(Boolean)
    .slice(0, 10);
  return paragraphs.map(text => ({ type: "paragraph", text }));
}

function formatDateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeTrigger(value: unknown): DiaryEntryTrigger {
  return value === "timer" ? "timer" : "manual";
}

export function loadDiaryEntryFontAssetId(): string | null {
  const raw = kvGet(DIARY_ENTRY_FONT_ASSET_KEY);
  const id = typeof raw === "string" ? raw.trim() : "";
  return id || null;
}

export function saveDiaryEntryFontAssetId(assetId: string | null): void {
  const id = typeof assetId === "string" ? assetId.trim() : "";
  if (id) {
    kvSet(DIARY_ENTRY_FONT_ASSET_KEY, id);
  } else {
    kvRemove(DIARY_ENTRY_FONT_ASSET_KEY);
  }
}

export function loadDiaryEntryFontScale(): number {
  const raw = Number(kvGet(DIARY_ENTRY_FONT_SCALE_KEY));
  if (!Number.isFinite(raw)) return 1;
  return Math.min(1.25, Math.max(0.85, Number(raw.toFixed(2))));
}

export function saveDiaryEntryFontScale(scale: number): void {
  const normalized = Math.min(1.25, Math.max(0.85, Number(scale.toFixed(2))));
  if (Math.abs(normalized - 1) < 0.001) {
    kvRemove(DIARY_ENTRY_FONT_SCALE_KEY);
    return;
  }
  kvSet(DIARY_ENTRY_FONT_SCALE_KEY, String(normalized));
}

export function normalizeDiaryEntry(raw: unknown): DiaryEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = cleanText(record.id, 120);
  const characterId = cleanText(record.characterId ?? record.character_id, 120);
  if (!id || !characterId) return null;

  const createdAt = typeof record.createdAt === "string"
    ? record.createdAt
    : typeof record.created_at === "string"
      ? record.created_at
      : new Date().toISOString();
  const body = cleanMultilineText(record.body ?? record.content ?? record.text, 6000);
  const blocks = normalizeBlocks(record.blocks, body);
  const title = cleanText(record.title, 80) || body.slice(0, 20) || "未命名日记";

  return {
    id,
    characterId,
    characterName: cleanText(record.characterName ?? record.character_name, 80) || "角色",
    title,
    dateLabel: cleanText(record.dateLabel ?? record.date_label, 40) || formatDateLabel(createdAt),
    mood: cleanText(record.mood, 60),
    weather: cleanText(record.weather, 60),
    tags: normalizeTags(record.tags ?? record.labels),
    body: body || blocks.map(block => block.type === "paragraph" || block.type === "quote" ? block.text : "").filter(Boolean).join("\n\n"),
    blocks,
    trigger: normalizeTrigger(record.trigger),
    createdAt,
    updatedAt: typeof record.updatedAt === "string"
      ? record.updatedAt
      : typeof record.updated_at === "string"
        ? record.updated_at
        : createdAt,
  };
}

export function loadDiaryEntries(): DiaryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(ENTRIES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeDiaryEntry)
      .filter((entry): entry is DiaryEntry => Boolean(entry))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

export function saveDiaryEntries(entries: DiaryEntry[]): void {
  if (typeof window === "undefined") return;
  const normalized = entries
    .map(normalizeDiaryEntry)
    .filter((entry): entry is DiaryEntry => Boolean(entry))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 500);
  kvSet(ENTRIES_KEY, JSON.stringify(normalized));
}

export function createDiaryEntry(input: DiaryEntryInput): DiaryEntry {
  const now = new Date().toISOString();
  const body = cleanMultilineText(input.body, 6000);
  const entry: DiaryEntry = {
    id: generateId("diary_entry"),
    characterId: cleanText(input.characterId, 120),
    characterName: cleanText(input.characterName, 80) || "角色",
    title: cleanText(input.title, 80) || body.slice(0, 20) || "未命名日记",
    dateLabel: cleanText(input.dateLabel, 40) || formatDateLabel(now),
    mood: cleanText(input.mood, 60),
    weather: cleanText(input.weather, 60),
    tags: normalizeTags(input.tags),
    body,
    blocks: normalizeBlocks(input.blocks, body),
    trigger: input.trigger ?? "manual",
    createdAt: now,
    updatedAt: now,
  };
  saveDiaryEntries([entry, ...loadDiaryEntries()]);
  try {
    const life = loadVirtualLifeState();
    if (life.settings.enabled) {
      const isCharacter = !!entry.characterId && entry.characterId !== "player" && entry.characterId !== "self";
      const logged = appendLifeTimelineEntry(life, {
        category: "diary",
        title: isCharacter ? entry.characterName + "写了日记" : "你写了一篇日记",
        details: entry.title + (entry.body ? " · " + entry.body.slice(0, 140) : ""),
        actorId: isCharacter ? entry.characterId : "player",
        actorName: isCharacter ? entry.characterName : "我",
        sourceId: entry.id,
      });
      saveVirtualLifeState(logged);
    }
  } catch {
    // Diary writing must not fail because the Life timeline is unavailable.
  }
  return entry;
}

export function deleteDiaryEntry(id: string): void {
  if (!id) return;
  saveDiaryEntries(loadDiaryEntries().filter(entry => entry.id !== id));
}

export function loadDiaryEntryTimerSettings(): DiaryEntryTimerSettings {
  if (typeof window === "undefined") return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
  try {
    const raw = kvGet(TIMER_KEY);
    if (!raw) return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<DiaryEntryTimerSettings>;
    const lastRunAtByCharacter = parsed.lastRunAtByCharacter && typeof parsed.lastRunAtByCharacter === "object"
      ? Object.fromEntries(Object.entries(parsed.lastRunAtByCharacter).map(([key, value]) => [key, String(value)]))
      : {};
    return {
      enabled: Boolean(parsed.enabled),
      intervalHours: Math.max(1, Math.min(720, Number(parsed.intervalHours) || 24)),
      characterIds: Array.isArray(parsed.characterIds) ? parsed.characterIds.map(String).filter(Boolean) : [],
      lastRunAtByCharacter,
    };
  } catch {
    return DEFAULT_DIARY_ENTRY_TIMER_SETTINGS;
  }
}

export function saveDiaryEntryTimerSettings(settings: DiaryEntryTimerSettings): void {
  if (typeof window === "undefined") return;
  kvSet(TIMER_KEY, JSON.stringify({
    enabled: Boolean(settings.enabled),
    intervalHours: Math.max(1, Math.min(720, Number(settings.intervalHours) || 24)),
    characterIds: settings.characterIds,
    lastRunAtByCharacter: settings.lastRunAtByCharacter,
  }));
}
