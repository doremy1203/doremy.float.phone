import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StandbyLine = {
  id: string;
  text: string;
  createdAt: string;
};

export type StandbyLineBundle = {
  characterId: string;
  /** 日期 YYYY-MM-DD，用于判断"今日已刷新" */
  date: string;
  lines: StandbyLine[];
  updatedAt: string;
};

export const STANDBY_LINES_STORAGE_KEY = "ai_phone_standby_lines_v1";
registerKvMigration(STANDBY_LINES_STORAGE_KEY);

export const STANDBY_LINES_PER_DAY = 5;
export const STANDBY_MAX_LINE_LENGTH = 60;

function generateId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `id_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function todayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeLine(raw: unknown): StandbyLine | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<StandbyLine>;
  const text = typeof obj.text === "string" ? obj.text.trim() : "";
  if (!text) return null;
  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : generateId(),
    text: text.slice(0, STANDBY_MAX_LINE_LENGTH),
    createdAt: typeof obj.createdAt === "string" ? obj.createdAt : new Date().toISOString(),
  };
}

function normalizeBundle(raw: unknown): StandbyLineBundle | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Partial<StandbyLineBundle>;
  const characterId = typeof obj.characterId === "string" ? obj.characterId.trim() : "";
  const date = typeof obj.date === "string" ? obj.date.trim() : "";
  if (!characterId || !date) return null;
  const rawLines = Array.isArray(obj.lines) ? obj.lines : [];
  const lines = rawLines.map(normalizeLine).filter((l): l is StandbyLine => Boolean(l));
  return {
    characterId,
    date,
    lines: lines.slice(0, STANDBY_LINES_PER_DAY),
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : new Date().toISOString(),
  };
}

function loadAllBundles(): Record<string, StandbyLineBundle> {
  if (typeof window === "undefined") return {};
  try {
    const raw = kvGet(STANDBY_LINES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const result: Record<string, StandbyLineBundle> = {};
    for (const [id, bundleRaw] of Object.entries(parsed)) {
      const normalized = normalizeBundle(bundleRaw);
      if (normalized) result[id] = normalized;
    }
    return result;
  } catch {
    return {};
  }
}

function saveAllBundles(map: Record<string, StandbyLineBundle>): void {
  kvSet(STANDBY_LINES_STORAGE_KEY, JSON.stringify(map));
}

export function loadStandbyLines(characterId: string): StandbyLineBundle | null {
  if (!characterId) return null;
  const map = loadAllBundles();
  return map[characterId] ?? null;
}

export function isStandbyBundleFresh(bundle: StandbyLineBundle | null): boolean {
  if (!bundle) return false;
  if (bundle.lines.length === 0) return false;
  return bundle.date === todayIsoDate();
}

/**
 * 保存或替换某个角色的台词 bundle。
 * 由「每日自动刷新」或用户手动「换一批」调用。
 */
export function saveStandbyLines(characterId: string, texts: string[], date = todayIsoDate()): StandbyLineBundle {
  const cleaned = texts
    .map(t => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .slice(0, STANDBY_LINES_PER_DAY);
  const bundle: StandbyLineBundle = {
    characterId,
    date,
    lines: cleaned.map(text => ({
      id: generateId(),
      text,
      createdAt: new Date().toISOString(),
    })),
    updatedAt: new Date().toISOString(),
  };
  const map = loadAllBundles();
  map[characterId] = bundle;
  saveAllBundles(map);
  return bundle;
}

/** 直接在 bundle 里换一条（用户点"换一句"） */
export function pickRandomLine(bundle: StandbyLineBundle | null): StandbyLine | null {
  if (!bundle || bundle.lines.length === 0) return null;
  return bundle.lines[Math.floor(Math.random() * bundle.lines.length)];
}

/** 没配 API 或请求失败时的本地兜底台词 */
export function buildFallbackStandbyLines(characterName: string): string[] {
  const name = (characterName || "").trim() || "ta";
  const hour = new Date().getHours();
  const greeting =
    hour < 6 ? "熬夜呢？" :
    hour < 11 ? "早安呀。" :
    hour < 14 ? "吃了吗？" :
    hour < 18 ? "下午好。" :
    hour < 22 ? "晚上在忙？" :
    "还没睡？";
  const weather = ["不错", "一般", "有点闷", "挺好"][Math.floor(Math.random() * 4)];
  return [
    `${greeting}我在这儿，想聊几句？`,
    `今天过得怎么样？${name}一直在。`,
    "最近还好吗？有什么事都可以跟我说。",
    `天气${weather}，适合说说话。`,
    `${name}在等你，随时可以开始。`,
  ];
}

