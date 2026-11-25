import { kvGet, kvSet, registerKvMigration } from "./kv-db";

/** 每个角色的待机素材（立绘、背景） */
export type StandbyCharacterAsset = {
  characterId: string;
  /** 透明立绘 URL（data URL 或 http(s)）；空字符串表示未上传 */
  sprite: string;
  /** 说话时临时切换的配套立绘；空字符串表示沿用 sprite */
  speakingSprite: string;
  /** 背景图片 URL；空字符串表示跟随桌面壁纸 */
  background: string;
  updatedAt: string;
};

/** 待机首页配置 */
export type StandbyHomeConfig = {
  /** 每个角色的素材 */
  characters: Record<string, StandbyCharacterAsset>;
  /** App 启动时是否自动进入待机首页 */
  showOnLaunch: boolean;
  /** 上次停留在待机首页的角色 id（可空） */
  lastCharacterId: string;
  updatedAt: string;
};

export const STANDBY_HOME_STORAGE_KEY = "ai_phone_standby_home_v1";
export const STANDBY_HOME_UPDATED_EVENT = "ai-phone-standby-home-updated";
registerKvMigration(STANDBY_HOME_STORAGE_KEY);

export const STANDBY_ASSET_MAX_BYTES = 10 * 1024 * 1024; // 10MB per file

export const DEFAULT_STANDBY_HOME_CONFIG: StandbyHomeConfig = {
  characters: {},
  showOnLaunch: true,
  lastCharacterId: "",
  updatedAt: "",
};

function normalizeAssetUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(data:image\/|https?:|blob:)/i.test(trimmed)) return trimmed;
  return "";
}

function normalizeAsset(value: unknown): StandbyCharacterAsset | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<StandbyCharacterAsset>;
  const characterId = typeof source.characterId === "string" ? source.characterId.trim() : "";
  if (!characterId) return null;
  return {
    characterId,
    sprite: normalizeAssetUrl(source.sprite),
    speakingSprite: normalizeAssetUrl(source.speakingSprite),
    background: normalizeAssetUrl(source.background),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : new Date().toISOString(),
  };
}

export function normalizeStandbyHomeConfig(value: unknown): StandbyHomeConfig {
  const source = (value && typeof value === "object" ? value : {}) as Partial<StandbyHomeConfig>;
  const characters: Record<string, StandbyCharacterAsset> = {};
  if (source.characters && typeof source.characters === "object") {
    for (const [id, asset] of Object.entries(source.characters)) {
      const normalized = normalizeAsset({ characterId: id, ...(asset as object) });
      if (normalized) characters[id] = normalized;
    }
  }
  return {
    characters,
    showOnLaunch: source.showOnLaunch !== false,
    lastCharacterId: typeof source.lastCharacterId === "string" ? source.lastCharacterId : "",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
  };
}

export function loadStandbyHomeConfig(): StandbyHomeConfig {
  if (typeof window === "undefined") return { ...DEFAULT_STANDBY_HOME_CONFIG };
  try {
    const raw = kvGet(STANDBY_HOME_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STANDBY_HOME_CONFIG };
    return normalizeStandbyHomeConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STANDBY_HOME_CONFIG };
  }
}

export function saveStandbyHomeConfig(patch: Partial<StandbyHomeConfig>): StandbyHomeConfig {
  const current = loadStandbyHomeConfig();
  const next = normalizeStandbyHomeConfig({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  kvSet(STANDBY_HOME_STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(STANDBY_HOME_UPDATED_EVENT));
  }
  return next;
}

/** 更新单个角色的立绘/背景 */
export function saveStandbyCharacterAsset(
  characterId: string,
  patch: Partial<Pick<StandbyCharacterAsset, "sprite" | "speakingSprite" | "background">>,
): StandbyHomeConfig {
  if (!characterId) return loadStandbyHomeConfig();
  const current = loadStandbyHomeConfig();
  const prev = current.characters[characterId] ?? {
    characterId,
    sprite: "",
    speakingSprite: "",
    background: "",
    updatedAt: "",
  };
  const nextAsset: StandbyCharacterAsset = {
    ...prev,
    sprite: "sprite" in patch ? normalizeAssetUrl(patch.sprite) : prev.sprite,
    speakingSprite: "speakingSprite" in patch
      ? normalizeAssetUrl(patch.speakingSprite)
      : (prev.speakingSprite ?? ""),
    background: "background" in patch ? normalizeAssetUrl(patch.background) : prev.background,
    updatedAt: new Date().toISOString(),
  };
  return saveStandbyHomeConfig({
    characters: { ...current.characters, [characterId]: nextAsset },
  });
}

export function getStandbyCharacterAsset(config: StandbyHomeConfig, characterId: string): StandbyCharacterAsset {
  return (
    config.characters[characterId] ?? {
      characterId,
      sprite: "",
      speakingSprite: "",
      background: "",
      updatedAt: "",
    }
  );
}

/** 请求待机首页立即锁屏（供设置页/按钮触发） */
export const STANDBY_LOCK_NOW_EVENT = "ai-phone-standby-lock-now";
export function requestStandbyNow(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(STANDBY_LOCK_NOW_EVENT));
}

/** 设置页请求重新生成某个角色的待机台词（待机首页挂载时会响应） */
export const STANDBY_REGENERATE_LINES_EVENT = "ai-phone-standby-regenerate-lines";

/** 文件 → data URL（限大小） */
export function readFileAsDataUrl(file: File, maxBytes = STANDBY_ASSET_MAX_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file) {
      reject(new Error("未选择文件"));
      return;
    }
    if (!file.type.startsWith("image/")) {
      reject(new Error("请选择图片文件"));
      return;
    }
    if (file.size > maxBytes) {
      reject(new Error(`图片过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("读取图片失败"));
    };
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}
