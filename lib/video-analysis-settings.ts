import { kvGet, kvSet } from "@/lib/kv-db";

export type VideoAnalysisProvider = "gemini" | "ark" | "openai-compatible" | "anthropic" | "twelvelabs";

export type VideoAnalysisSettings = {
  provider: VideoAnalysisProvider;
  apiKey: string;
  model: string;
  baseUrl: string;
  maxFileSizeMb: number;
  frameCount: number;
};

const STORAGE_KEY = "video_analysis_settings_v1";

export const DEFAULT_VIDEO_ANALYSIS_SETTINGS: VideoAnalysisSettings = {
  provider: "gemini",
  apiKey: "",
  model: "gemini-2.5-flash",
  baseUrl: "https://generativelanguage.googleapis.com",
  maxFileSizeMb: 1024,
  frameCount: 12,
};

export function loadVideoAnalysisSettings(): VideoAnalysisSettings {
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VIDEO_ANALYSIS_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<VideoAnalysisSettings>;
    return {
      provider: parsed.provider === "ark" || parsed.provider === "openai-compatible" || parsed.provider === "anthropic" || parsed.provider === "twelvelabs" ? parsed.provider : "gemini",
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : (parsed.provider === "ark" ? "https://ark.cn-beijing.volces.com/api/v3" : parsed.provider === "anthropic" ? "https://api.anthropic.com" : parsed.provider === "twelvelabs" ? "https://api.twelvelabs.io/v1.3" : parsed.provider === "openai-compatible" ? "https://api.openai.com/v1" : DEFAULT_VIDEO_ANALYSIS_SETTINGS.baseUrl),
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_VIDEO_ANALYSIS_SETTINGS.model,
      maxFileSizeMb: Number.isFinite(parsed.maxFileSizeMb) ? Math.min(2048, Math.max(50, Number(parsed.maxFileSizeMb))) : DEFAULT_VIDEO_ANALYSIS_SETTINGS.maxFileSizeMb,
      frameCount: Number.isFinite(parsed.frameCount) ? Math.min(24, Math.max(4, Number(parsed.frameCount))) : DEFAULT_VIDEO_ANALYSIS_SETTINGS.frameCount,
    };
  } catch {
    return { ...DEFAULT_VIDEO_ANALYSIS_SETTINGS };
  }
}

export function saveVideoAnalysisSettings(settings: VideoAnalysisSettings): void {
  kvSet(STORAGE_KEY, JSON.stringify({
    ...settings,
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim() || DEFAULT_VIDEO_ANALYSIS_SETTINGS.model,
    maxFileSizeMb: Math.min(2048, Math.max(50, Number(settings.maxFileSizeMb) || DEFAULT_VIDEO_ANALYSIS_SETTINGS.maxFileSizeMb)),
    frameCount: Math.min(24, Math.max(4, Number(settings.frameCount) || DEFAULT_VIDEO_ANALYSIS_SETTINGS.frameCount)),
  }));
}
