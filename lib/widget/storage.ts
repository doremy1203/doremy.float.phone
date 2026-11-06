"use client";

/**
 * 桌面小组件的本地存储。
 *
 * 与便签墙（公开、走 Supabase）刻意区分：这里存的是角色私下给你的话，
 * 只在本机 IndexedDB，不上云、不进任何公开墙。
 */

import { kvGet, kvSet, registerKvMigration } from "../kv-db";
import { WIDGET_DEFAULTS, WIDGET_LIMITS, WIDGET_UPDATED_EVENT, type WidgetConfig, type WidgetData, type WidgetProfile } from "./types";

const CONFIG_KEY = "ai_phone_widget_config_v1";
const DATA_KEY = "ai_phone_widget_data_v1";
const DATA_BY_CHARACTER_KEY = "ai_phone_widget_data_by_character_v1";
const DATA_BY_PROFILE_KEY = "ai_phone_widget_data_by_profile_v1";
const PROFILES_KEY = "ai_phone_widget_profiles_v1";

registerKvMigration(CONFIG_KEY);
registerKvMigration(DATA_KEY);
registerKvMigration(DATA_BY_CHARACTER_KEY);
registerKvMigration(DATA_BY_PROFILE_KEY);
registerKvMigration(PROFILES_KEY);

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function notifyUpdated(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WIDGET_UPDATED_EVENT));
  }
}

export function loadWidgetConfig(): WidgetConfig {
  try {
    const raw = kvGet(CONFIG_KEY);
    if (!raw) return { ...WIDGET_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
    return {
      enabled: parsed.enabled === true,
      characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
      useCustomTemplate: parsed.useCustomTemplate === true,
      customTemplate: typeof parsed.customTemplate === "string" ? parsed.customTemplate.slice(0, 20000) : "",
      widthDp: clamp(parsed.widthDp, WIDGET_LIMITS.widthDp.min, WIDGET_LIMITS.widthDp.max, WIDGET_DEFAULTS.widthDp),
      heightDp: clamp(parsed.heightDp, WIDGET_LIMITS.heightDp.min, WIDGET_LIMITS.heightDp.max, WIDGET_DEFAULTS.heightDp),
      autoEnabled: parsed.autoEnabled === true,
      autoIntervalHours: clamp(parsed.autoIntervalHours, WIDGET_LIMITS.autoIntervalHours.min, WIDGET_LIMITS.autoIntervalHours.max, WIDGET_DEFAULTS.autoIntervalHours),
      useGeneratedAvatar: parsed.useGeneratedAvatar === true,
      scale: clamp(parsed.scale, WIDGET_LIMITS.scale.min, WIDGET_LIMITS.scale.max, WIDGET_DEFAULTS.scale),
    };
  } catch {
    return { ...WIDGET_DEFAULTS };
  }
}

export function saveWidgetConfig(config: WidgetConfig): void {
  kvSet(CONFIG_KEY, JSON.stringify(config));
  notifyUpdated();
}

function normalizeWidgetData(parsed: Partial<WidgetData> | null | undefined): WidgetData | null {
  if (!parsed || typeof parsed.text !== "string") return null;
  return {
    characterId: typeof parsed.characterId === "string" ? parsed.characterId : "",
    text: parsed.text.slice(0, 300),
    status: typeof parsed.status === "string" ? parsed.status.slice(0, 30) : "",
    avatar: typeof parsed.avatar === "string" ? parsed.avatar.slice(0, 400000) : "",
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    source: parsed.source === "tool" || parsed.source === "auto" ? parsed.source : "manual",
  };
}

/** No argument = currently active widget content; characterId = that character's latest content. */
export function loadWidgetData(characterId?: string): WidgetData | null {
  try {
    if (characterId) {
      const byCharacter = JSON.parse(kvGet(DATA_BY_CHARACTER_KEY) || "{}") as Record<string, Partial<WidgetData>>;
      const specific = normalizeWidgetData(byCharacter[characterId]);
      if (specific) return specific;
      const current = normalizeWidgetData(JSON.parse(kvGet(DATA_KEY) || "null") as Partial<WidgetData> | null);
      return current?.characterId === characterId ? current : null;
    }
    return normalizeWidgetData(JSON.parse(kvGet(DATA_KEY) || "null") as Partial<WidgetData> | null);
  } catch {
    return null;
  }
}

export function saveWidgetData(data: WidgetData): void {
  kvSet(DATA_KEY, JSON.stringify(data));
  if (data.characterId) {
    try {
      const byCharacter = JSON.parse(kvGet(DATA_BY_CHARACTER_KEY) || "{}") as Record<string, WidgetData>;
      byCharacter[data.characterId] = data;
      kvSet(DATA_BY_CHARACTER_KEY, JSON.stringify(byCharacter));
    } catch {
      kvSet(DATA_BY_CHARACTER_KEY, JSON.stringify({ [data.characterId]: data }));
    }
  }
  notifyUpdated();
}

/** 每个独立小组件实例（profile）自己的内容：角色对某个实例「留句话」时写到这。 */
export function saveWidgetProfileData(profileId: string, data: WidgetData): void {
  try {
    const byProfile = JSON.parse(kvGet(DATA_BY_PROFILE_KEY) || "{}") as Record<string, WidgetData>;
    byProfile[profileId] = data;
    kvSet(DATA_BY_PROFILE_KEY, JSON.stringify(byProfile));
  } catch {
    kvSet(DATA_BY_PROFILE_KEY, JSON.stringify({ [profileId]: data }));
  }
  notifyUpdated();
}

export function loadWidgetProfileData(profileId: string): WidgetData | null {
  try {
    const byProfile = JSON.parse(kvGet(DATA_BY_PROFILE_KEY) || "{}") as Record<string, WidgetData>;
    return normalizeWidgetData(byProfile[profileId]);
  } catch { return null; }
}

/** Custom widget profiles are local-only and have no app-imposed count limit. */
export function loadWidgetProfiles(): WidgetProfile[] {
  try {
    const parsed = JSON.parse(kvGet(PROFILES_KEY) || "[]") as Partial<WidgetProfile>[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is WidgetProfile => !!item && typeof item.id === "string" && item.id.length > 0)
      .map(item => ({
        id: item.id.slice(0, 100),
        name: typeof item.name === "string" ? item.name.slice(0, 60) : "自定义小组件",
        characterId: typeof item.characterId === "string" ? item.characterId : "",
        template: typeof item.template === "string" ? item.template.slice(0, 30000) : "",
        customCss: typeof item.customCss === "string" ? item.customCss.slice(0, 20000) : "",
        widthDp: clamp(item.widthDp, WIDGET_LIMITS.widthDp.min, WIDGET_LIMITS.widthDp.max, WIDGET_DEFAULTS.widthDp),
        heightDp: clamp(item.heightDp, WIDGET_LIMITS.heightDp.min, WIDGET_LIMITS.heightDp.max, WIDGET_DEFAULTS.heightDp),
        scale: clamp(item.scale, WIDGET_LIMITS.scale.min, WIDGET_LIMITS.scale.max, WIDGET_DEFAULTS.scale),
        createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString(),
      }));
  } catch {
    return [];
  }
}

export function saveWidgetProfiles(profiles: WidgetProfile[]): void {
  const now = new Date().toISOString();
  const safe = profiles.filter(profile => profile.id.trim()).map(profile => ({
    ...profile,
    id: profile.id.slice(0, 100),
    name: profile.name.trim().slice(0, 60) || "自定义小组件",
    template: profile.template.slice(0, 30000),
    customCss: profile.customCss.slice(0, 20000),
    updatedAt: now,
  }));
  kvSet(PROFILES_KEY, JSON.stringify(safe));
  notifyUpdated();
}

export function saveWidgetProfile(profile: WidgetProfile): void {
  const current = loadWidgetProfiles();
  const exists = current.some(item => item.id === profile.id);
  saveWidgetProfiles(exists ? current.map(item => item.id === profile.id ? profile : item) : [...current, profile]);
}

export function deleteWidgetProfile(profileId: string): void {
  saveWidgetProfiles(loadWidgetProfiles().filter(item => item.id !== profileId));
}

export function clearWidgetData(): void {
  kvSet(DATA_KEY, "");
  notifyUpdated();
}

/** 记录角色上次主动换话的时间（自动生成调度用）。 */
const AUTO_LAST_RUN_KEY = "ai_phone_widget_auto_last_run_v1";
registerKvMigration(AUTO_LAST_RUN_KEY);

export function loadWidgetAutoLastRun(): number {
  const value = Number(kvGet(AUTO_LAST_RUN_KEY));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function markWidgetAutoRun(): void {
  kvSet(AUTO_LAST_RUN_KEY, String(Date.now()));
}
