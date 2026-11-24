import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const LOCK_SCREEN_STORAGE_KEY = "ai_phone_lock_screen_v1";
export const LOCK_SCREEN_CONFIG_UPDATED_EVENT = "ai-phone-lock-screen-updated";
export const LOCK_SCREEN_LOCK_NOW_EVENT = "ai-phone-lock-now";
registerKvMigration(LOCK_SCREEN_STORAGE_KEY);

export const LOCK_SCREEN_PASSWORD_MAX_LENGTH = 8;

export type LockScreenConfig = {
  /** 是否启用锁屏（启用后进入 App / 回到前台时显示锁屏） */
  enabled: boolean;
  /** 数字密码，空字符串表示无需密码，上滑即可解锁 */
  password: string;
  /** 锁屏壁纸 data URL，空字符串表示使用默认渐变 */
  wallpaper: string;
  updatedAt: string;
};

export const DEFAULT_LOCK_SCREEN_CONFIG: LockScreenConfig = {
  enabled: false,
  password: "",
  wallpaper: "",
  updatedAt: "",
};

function normalizePassword(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\D/g, "").slice(0, LOCK_SCREEN_PASSWORD_MAX_LENGTH);
}

export function normalizeLockScreenConfig(value: unknown): LockScreenConfig {
  const source = (value && typeof value === "object" ? value : {}) as Partial<LockScreenConfig>;
  return {
    enabled: source.enabled === true,
    password: normalizePassword(source.password),
    wallpaper: typeof source.wallpaper === "string" && /^(?:data:image\/|https?:|blob:)/i.test(source.wallpaper) ? source.wallpaper : "",
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : "",
  };
}

export function loadLockScreenConfig(): LockScreenConfig {
  const raw = kvGet(LOCK_SCREEN_STORAGE_KEY);
  if (!raw) return { ...DEFAULT_LOCK_SCREEN_CONFIG };
  try {
    return normalizeLockScreenConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LOCK_SCREEN_CONFIG };
  }
}

export function saveLockScreenConfig(patch: Partial<LockScreenConfig>): LockScreenConfig {
  const current = loadLockScreenConfig();
  const next = normalizeLockScreenConfig({
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
  kvSet(LOCK_SCREEN_STORAGE_KEY, JSON.stringify(next));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(LOCK_SCREEN_CONFIG_UPDATED_EVENT));
  }
  return next;
}

export function isLockScreenActive(config: LockScreenConfig): boolean {
  return config.enabled;
}

/** 请求立即锁屏（供设置页“立即锁屏”按钮触发） */
export function requestLockScreenNow(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LOCK_SCREEN_LOCK_NOW_EVENT));
}
