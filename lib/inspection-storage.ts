import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** 备忘录分类：计划 / 说不出口的话 */
export type InspectionMemoCategory = "plan" | "unsaid";

export type InspectionMemo = {
  id: string;
  category: InspectionMemoCategory;
  title: string;
  body: string;
};

export type InspectionPhotoTone = "silver" | "graphite" | "mist" | "shadow";

export type InspectionPhoto = {
  id: string;
  title: string;
  caption: string;
  timeLabel: string;
  location: string;
  tone: InspectionPhotoTone;
};

export type InspectionChatMessage = {
  id: string;
  direction: "incoming" | "outgoing";
  text: string;
  timeLabel: string;
};

/** 根据人设 / 记忆生成出来的手机好友（不属于全局角色） */
export type InspectionNpc = {
  id: string;
  name: string;
  relation: string;
};

/** 某个角色手机里持久化的内容（真实聊天 / 动态不在这里，展示时实时读取） */
export type InspectionPhoneState = {
  characterId: string;
  /** 用户在该角色通讯录里的备注 */
  remarkForUser: string;
  /** 与该角色好友（其他 NPC）的聊天记录，key = 好友 characterId 或 npc id */
  conversations: Record<string, InspectionChatMessage[]>;
  memos: InspectionMemo[];
  photos: InspectionPhoto[];
  /** 人设 / 记忆衍生出的手机好友 */
  npcs: InspectionNpc[];
  generatedAt: string;
  updatedAt: string;
};

type InspectionStore = {
  phones: Record<string, InspectionPhoneState>;
};

export const INSPECTION_STORAGE_KEY = "ai_phone_inspection_v1";
export const INSPECTION_UPDATED_EVENT = "ai-phone-inspection-updated";
registerKvMigration(INSPECTION_STORAGE_KEY);

export const INSPECTION_MAX_MEMOS = 8;
export const INSPECTION_MAX_PHOTOS = 9;
export const INSPECTION_MAX_MESSAGES_PER_FRIEND = 60;

const PHOTO_TONES: InspectionPhotoTone[] = ["silver", "graphite", "mist", "shadow"];

function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function cleanText(value: unknown, maxLength: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 由名字推导稳定的 NPC id，刷新时同名 NPC 不会重复 */
export function inspectionNpcId(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return `npc_${Math.abs(hash).toString(36)}`;
}

function normalizeNpc(raw: unknown): InspectionNpc | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<InspectionNpc>;
  const name = cleanText(source.name, 20);
  if (!name) return null;
  return {
    id: typeof source.id === "string" && source.id ? source.id : inspectionNpcId(name),
    name,
    relation: cleanText(source.relation, 40),
  };
}

function normalizeMemo(raw: unknown): InspectionMemo | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<InspectionMemo>;
  const category: InspectionMemoCategory = source.category === "unsaid" ? "unsaid" : "plan";
  const title = cleanText(source.title, 40);
  const body = cleanText(source.body, 300);
  if (!title && !body) return null;
  return {
    id: typeof source.id === "string" && source.id ? source.id : createId("memo"),
    category,
    title: title || "未命名",
    body,
  };
}

function normalizePhoto(raw: unknown): InspectionPhoto | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<InspectionPhoto>;
  const title = cleanText(source.title, 40);
  const caption = cleanText(source.caption, 200);
  if (!title && !caption) return null;
  const tone = PHOTO_TONES.includes(source.tone as InspectionPhotoTone)
    ? source.tone as InspectionPhotoTone
    : "silver";
  return {
    id: typeof source.id === "string" && source.id ? source.id : createId("photo"),
    title: title || "无题",
    caption,
    timeLabel: cleanText(source.timeLabel, 24),
    location: cleanText(source.location, 40),
    tone,
  };
}

function normalizeMessage(raw: unknown): InspectionChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<InspectionChatMessage>;
  const text = cleanText(source.text, 500);
  if (!text) return null;
  return {
    id: typeof source.id === "string" && source.id ? source.id : createId("msg"),
    direction: source.direction === "outgoing" ? "outgoing" : "incoming",
    text,
    timeLabel: cleanText(source.timeLabel, 24) || formatClock(new Date()),
  };
}

export function formatClock(date: Date): string {
  const pad = (value: number) => (value < 10 ? `0${value}` : String(value));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function normalizeState(raw: unknown, characterId: string): InspectionPhoneState | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Partial<InspectionPhoneState>;
  const conversations: Record<string, InspectionChatMessage[]> = {};
  if (source.conversations && typeof source.conversations === "object") {
    for (const [friendId, list] of Object.entries(source.conversations)) {
      if (!friendId || !Array.isArray(list)) continue;
      const messages = list
        .map(normalizeMessage)
        .filter((item): item is InspectionChatMessage => !!item)
        .slice(-INSPECTION_MAX_MESSAGES_PER_FRIEND);
      if (messages.length > 0) conversations[friendId] = messages;
    }
  }
  return {
    characterId,
    remarkForUser: cleanText(source.remarkForUser, 30),
    conversations,
    memos: Array.isArray(source.memos)
      ? source.memos.map(normalizeMemo).filter((item): item is InspectionMemo => !!item).slice(0, INSPECTION_MAX_MEMOS)
      : [],
    photos: Array.isArray(source.photos)
      ? source.photos.map(normalizePhoto).filter((item): item is InspectionPhoto => !!item).slice(0, INSPECTION_MAX_PHOTOS)
      : [],
    npcs: Array.isArray(source.npcs)
      ? source.npcs.map(normalizeNpc).filter((item): item is InspectionNpc => !!item).slice(0, 4)
      : [],
    generatedAt: typeof source.generatedAt === "string" ? source.generatedAt : "",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
  };
}

function loadStore(): InspectionStore {
  if (typeof window === "undefined") return { phones: {} };
  try {
    const raw = kvGet(INSPECTION_STORAGE_KEY);
    if (!raw) return { phones: {} };
    const parsed = JSON.parse(raw) as Partial<InspectionStore>;
    const phones: Record<string, InspectionPhoneState> = {};
    if (parsed.phones && typeof parsed.phones === "object") {
      for (const [characterId, state] of Object.entries(parsed.phones)) {
        const normalized = normalizeState(state, characterId);
        if (normalized) phones[characterId] = normalized;
      }
    }
    return { phones };
  } catch {
    return { phones: {} };
  }
}

function saveStore(store: InspectionStore): void {
  if (typeof window === "undefined") return;
  kvSet(INSPECTION_STORAGE_KEY, JSON.stringify(store));
  window.dispatchEvent(new CustomEvent(INSPECTION_UPDATED_EVENT));
}

export function createEmptyInspectionPhone(characterId: string): InspectionPhoneState {
  return {
    characterId,
    remarkForUser: "",
    conversations: {},
    memos: [],
    photos: [],
    npcs: [],
    generatedAt: "",
    updatedAt: new Date().toISOString(),
  };
}

export function loadInspectionPhone(characterId: string): InspectionPhoneState | null {
  if (!characterId) return null;
  return loadStore().phones[characterId] ?? null;
}

export function saveInspectionPhone(state: InspectionPhoneState): InspectionPhoneState {
  const store = loadStore();
  const next = {
    ...state,
    updatedAt: new Date().toISOString(),
  };
  store.phones[state.characterId] = next;
  saveStore(store);
  return next;
}

function mutatePhone(
  characterId: string,
  mutate: (state: InspectionPhoneState) => InspectionPhoneState,
): InspectionPhoneState {
  const current = loadInspectionPhone(characterId) ?? createEmptyInspectionPhone(characterId);
  return saveInspectionPhone(mutate(current));
}

export function updateInspectionRemark(characterId: string, remark: string): InspectionPhoneState {
  return mutatePhone(characterId, state => ({
    ...state,
    remarkForUser: cleanText(remark, 30),
  }));
}

export function appendInspectionChatMessage(
  characterId: string,
  friendId: string,
  message: Omit<InspectionChatMessage, "id" | "timeLabel"> & { timeLabel?: string },
): InspectionPhoneState {
  const normalized = normalizeMessage({ ...message, id: createId("msg") });
  if (!normalized || !friendId) return loadInspectionPhone(characterId) ?? createEmptyInspectionPhone(characterId);
  return mutatePhone(characterId, state => {
    const thread = [...(state.conversations[friendId] ?? []), normalized]
      .slice(-INSPECTION_MAX_MESSAGES_PER_FRIEND);
    return {
      ...state,
      conversations: { ...state.conversations, [friendId]: thread },
    };
  });
}

/** 把一次生成结果整体写入（刷新用），备忘录 / 相册 / 好友聊天全部替换 */
export function applyInspectionGeneratedContent(
  characterId: string,
  payload: {
    conversations?: Record<string, Omit<InspectionChatMessage, "id" | "timeLabel">[]>;
    memos?: unknown[];
    photos?: unknown[];
    npcs?: unknown[];
  },
): InspectionPhoneState {
  return mutatePhone(characterId, state => {
    const conversations: Record<string, InspectionChatMessage[]> = {};
    if (payload.conversations) {
      for (const [friendId, list] of Object.entries(payload.conversations)) {
        if (!Array.isArray(list)) continue;
        const messages = list
          .map(item => normalizeMessage({ ...item, id: createId("msg") }))
          .filter((item): item is InspectionChatMessage => !!item)
          .slice(-INSPECTION_MAX_MESSAGES_PER_FRIEND);
        if (messages.length > 0) conversations[friendId] = messages;
      }
    }
    const memos = (payload.memos ?? [])
      .map(normalizeMemo)
      .filter((item): item is InspectionMemo => !!item)
      .slice(0, INSPECTION_MAX_MEMOS);
    const photos = (payload.photos ?? [])
      .map(normalizePhoto)
      .filter((item): item is InspectionPhoto => !!item)
      .slice(0, INSPECTION_MAX_PHOTOS);
    const npcs = (payload.npcs ?? [])
      .map(normalizeNpc)
      .filter((item): item is InspectionNpc => !!item)
      .slice(0, 4);
    return {
      ...state,
      conversations,
      memos,
      photos,
      npcs,
      generatedAt: new Date().toISOString(),
    };
  });
}

export function clearInspectionPhone(characterId: string): void {
  if (typeof window === "undefined") return;
  const store = loadStore();
  delete store.phones[characterId];
  saveStore(store);
}
