import type { ImageGenerationSettings, NovelAiPreset } from "./settings-types";
import { loadBindingConfig, loadImageGenerationSettings, resolveBinding, DEFAULT_NOVELAI_PRESET } from "./settings-storage";
import { applyImageGenerationBinding } from "./image-generation-binding";
import JSZip from "jszip";
import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import { loadCharacters } from "./character-storage";
import { storeMediaBlob } from "./media-cache-storage";
import { throwIfAborted } from "./abort-utils";
import {
  NOVELAI_COMMON_MODELS,
  getNovelAiResolution,
  normalizeNovelAiModel,
  normalizeNovelAiNoiseSchedule,
  normalizeNovelAiSampler,
  normalizeNovelAiScale,
  normalizeNovelAiSteps,
} from "./novelai-image-config";

export type ImageGenerationResult = {
  mediaRef: string;
  dataUrl: string;
  blob: Blob;
  mimeType: string;
  prompt: string;
  usedReferenceImage: boolean;
  /** Actual identity-reference images passed to the provider after loading/collage/limits. */
  referenceImageCount?: number;
  referenceImageLabels?: string[];
  revisedPrompt?: string;
};

type ExtractedImage =
  | { kind: "b64"; b64: string; mimeType?: string; revisedPrompt?: string }
  | { kind: "url"; url: string; revisedPrompt?: string };

type ImageGenerationApiResponse = {
  b64: string;
  mimeType?: string;
  revisedPrompt?: string;
};

const IMAGE_MODEL_HINTS = [
  "image",
  "img",
  "dall",
  "flux",
  "stable",
  "sd",
  "midjourney",
  "mj",
  "ideogram",
  "imagen",
  "qwen-image",
  "kolors",
  "wan",
];

function mergePrompt(description: string, extraPrompt: string): string {
  const main = description.trim();
  const extra = extraPrompt.trim();
  return extra ? `${main}\n\n${extra}` : main;
}

function base64ToBlob(b64: string, mimeType: string): Blob {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType });
}

function dataUrlMimeType(dataUrl: string): string {
  const match = /^data:([^;]+);base64,/.exec(dataUrl);
  return match?.[1]?.toLowerCase() || "";
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; mimeType: string } | null {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(dataUrl);
  if (!match) return null;
  return { blob: base64ToBlob(match[2], match[1] || "image/png"), mimeType: match[1] || "image/png" };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

function loadDataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("参考图解码失败"));
    image.src = dataUrl;
  });
}

type ReferenceSource = { label: string; dataUrl: string; crop?: { x: number; y: number; size: number } };

/**
 * 兼容“只接受一张参考图”的 OpenAI 兼容服务：把本次出镜人物拼成一张带编号的
 * 身份参考图。多图仍优先；拼图只在用户显式选择时启用。
 */
async function buildReferenceCollage(sources: ReferenceSource[]): Promise<{ dataUrl: string; legend: string } | null> {
  if (typeof document === "undefined" || sources.length < 2) return null;
  const cell = 512;
  const labelHeight = 46;
  const cols = Math.ceil(Math.sqrt(sources.length));
  const rows = Math.ceil(sources.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * (cell + labelHeight);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = "#111111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const legend: string[] = [];
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    const image = await loadDataUrlImage(source.dataUrl).catch(() => null);
    if (!image) continue;
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = col * cell;
    const y = row * (cell + labelHeight);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    const crop = source.crop;
    const sourceSize = crop ? Math.max(1, Math.round(Math.min(width, height) * Math.max(0.18, Math.min(1, crop.size)))) : Math.min(width, height);
    const sourceX = crop ? Math.round(Math.max(0, Math.min(width - sourceSize, crop.x * width))) : Math.max(0, Math.floor((width - sourceSize) / 2));
    const sourceY = crop ? Math.round(Math.max(0, Math.min(height - sourceSize, crop.y * height))) : Math.max(0, Math.floor((height - sourceSize) / 2));
    context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, x, y, cell, cell);
    context.fillStyle = "rgba(0,0,0,.72)";
    context.fillRect(x, y + cell, cell, labelHeight);
    context.fillStyle = "#ffffff";
    context.font = "28px sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(`${index + 1}. ${source.label}`, x + cell / 2, y + cell + labelHeight / 2);
    legend.push(`${index + 1}=${source.label}`);
  }
  if (!legend.length) return null;
  return { dataUrl: canvas.toDataURL("image/png"), legend: legend.join("、") };
}

async function normalizeReferenceImageForEdit(
  dataUrl: string,
  crop?: { x: number; y: number; size: number },
): Promise<string> {
  if (!crop && dataUrlMimeType(dataUrl) === "image/png") return dataUrl;
  if (typeof document === "undefined") return dataUrl;

  try {
    const image = await loadDataUrlImage(dataUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return dataUrl;

    const canvas = document.createElement("canvas");
    const normalizedSize = crop ? Math.max(0.18, Math.min(1, crop.size)) : 1;
    const sourceSize = Math.max(1, Math.round(Math.min(width, height) * normalizedSize));
    const sourceX = crop
      ? Math.round(Math.max(0, Math.min(width - sourceSize, crop.x * width)))
      : 0;
    const sourceY = crop
      ? Math.round(Math.max(0, Math.min(height - sourceSize, crop.y * height)))
      : 0;
    canvas.width = crop ? sourceSize : width;
    canvas.height = crop ? sourceSize : height;
    const context = canvas.getContext("2d");
    if (!context) return dataUrl;
    if (crop) {
      context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, sourceSize, sourceSize);
    } else {
      context.drawImage(image, 0, 0, width, height);
    }
    return canvas.toDataURL("image/png");
  } catch {
    return dataUrl;
  }
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1] || "png";
  return subtype.replace("jpeg", "jpg");
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/images\/(?:generations|edits)$/i, "")
    .replace(/\/images$/i, "");
}

function buildImageUrl(baseUrl: string, mode: "generations" | "edits"): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/images\/(?:generations|edits)$/i.test(trimmed)) {
    return trimmed.replace(/\/images\/(?:generations|edits)$/i, `/images/${mode}`);
  }
  if (/\/images$/i.test(trimmed)) return `${trimmed}/${mode}`;
  return `${normalizeBaseUrl(trimmed)}/images/${mode}`;
}

function buildModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

function cleanBase64(value: string): { b64: string; mimeType?: string } {
  const match = /^data:([^;]+);base64,([\s\S]+)$/.exec(value.trim());
  if (match) return { mimeType: match[1], b64: match[2] };
  return { b64: value.trim() };
}

function extractFromObject(data: unknown): ExtractedImage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const revisedPrompt = typeof record.revised_prompt === "string" ? record.revised_prompt : undefined;

  for (const key of ["b64_json", "base64", "b64", "image", "result"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      if (/^https?:\/\//i.test(value.trim())) return { kind: "url", url: value.trim(), revisedPrompt };
      const cleaned = cleanBase64(value);
      return { kind: "b64", ...cleaned, revisedPrompt };
    }
  }

  for (const key of ["url", "image_url"]) {
    const value = record[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
      return { kind: "url", url: value.trim(), revisedPrompt };
    }
    if (value && typeof value === "object") {
      const nested = (value as Record<string, unknown>).url;
      if (typeof nested === "string" && /^https?:\/\//i.test(nested.trim())) {
        return { kind: "url", url: nested.trim(), revisedPrompt };
      }
    }
  }

  for (const key of ["data", "images", "output", "content"]) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim()) {
          if (/^https?:\/\//i.test(item.trim())) return { kind: "url", url: item.trim(), revisedPrompt };
          const cleaned = cleanBase64(item);
          return { kind: "b64", ...cleaned, revisedPrompt };
        }
        const nested = extractFromObject(item);
        if (nested) return { ...nested, revisedPrompt: nested.revisedPrompt || revisedPrompt };
      }
    }
  }

  return null;
}

function extractModels(data: unknown): string[] {
  const results: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string") return;
    const normalized = value.replace(/^models\//, "").trim();
    if (normalized) results.push(normalized);
  };

  if (Array.isArray(data)) {
    data.forEach(item => {
      if (typeof item === "string") push(item);
      else if (item && typeof item === "object") {
        const row = item as Record<string, unknown>;
        push(row.id ?? row.name ?? row.model);
      }
    });
  } else if (data && typeof data === "object") {
    const row = data as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const value = row[key];
      if (Array.isArray(value)) results.push(...extractModels(value));
    }
    push(row.id ?? row.name ?? row.model);
  }

  return Array.from(new Set(results));
}

async function fetchImageUrlAsBase64(url: string, signal?: AbortSignal): Promise<{ b64: string; mimeType: string }> {
  throwIfAborted(signal);
  const res = await fetch(url, { signal });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`图片 URL 下载失败 ${res.status}: ${text.slice(0, 160)}`);
  }
  const blob = await res.blob();
  const dataUrl = await blobToDataUrl(blob);
  const cleaned = cleanBase64(dataUrl);
  return { b64: cleaned.b64, mimeType: cleaned.mimeType || blob.type || "image/png" };
}

async function parseImageGenerationResponse(res: Response, signal?: AbortSignal): Promise<ImageGenerationApiResponse> {
  throwIfAborted(signal);
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`生图 API 错误 ${res.status}: ${text.slice(0, 600)}`);
  }

  if (contentType.startsWith("image/")) {
    const blob = await res.blob();
    throwIfAborted(signal);
    const dataUrl = await blobToDataUrl(blob);
    const cleaned = cleanBase64(dataUrl);
    return { b64: cleaned.b64, mimeType: cleaned.mimeType || contentType };
  }

  const json = await res.json();
  throwIfAborted(signal);
  const extracted = extractFromObject(json);
  if (!extracted) {
    throw new Error(`生图 API 返回中没有找到图片字段：${JSON.stringify(Object.keys(json || {})).slice(0, 200)}`);
  }

  if (extracted.kind === "url") {
    const downloaded = await fetchImageUrlAsBase64(extracted.url, signal);
    return { ...downloaded, revisedPrompt: extracted.revisedPrompt };
  }

  return {
    b64: extracted.b64,
    mimeType: extracted.mimeType || "image/png",
    revisedPrompt: extracted.revisedPrompt,
  };
}

export function filterLikelyImageModels(models: string[]): string[] {
  const filtered = models.filter(model => {
    const lower = model.toLowerCase();
    return IMAGE_MODEL_HINTS.some(hint => lower.includes(hint));
  });
  return filtered.length > 0 ? filtered : models;
}

export async function fetchImageGenerationModels(settings: Pick<ImageGenerationSettings, "apiKey" | "baseUrl" | "requestMode">): Promise<string[]> {
  if (settings.requestMode === "direct") {
    try {
      const res = await fetch(buildModelsUrl(settings.baseUrl), {
        method: "GET",
        headers: { Authorization: `Bearer ${settings.apiKey}` },
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`模型列表 API 错误 ${res.status}: ${text.slice(0, 400)}`);
      }
      return extractModels(JSON.parse(text));
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error("浏览器直连失败：该 API 可能未允许跨域请求。");
      }
      throw error;
    }
  }

  const res = await fetch("/api/image-generation/models", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
    }),
  });
  const data = await res.json().catch(() => ({})) as { models?: string[]; error?: string };
  if (!res.ok || data.error) {
    throw new Error(data.error || `模型列表请求失败 ${res.status}`);
  }
  return Array.isArray(data.models) ? data.models : [];
}

// 通用生图代理(Cloudflare Worker)。配置后,「服务端中转」模式改为:
// 浏览器 → 本代理(带CORS、等待无时长限制) → 用户自己的生图API,
// 不再经过 Netlify 函数(其流式响应有 60s 硬上限,慢生图必死且中转站照样计费)。
// 留空 = 关闭,沿用 Netlify 心跳流式路由。自部署请配置自己的代理地址。
export const IMAGE_GEN_PROXY_URL = (process.env.NEXT_PUBLIC_IMAGE_GEN_PROXY_URL || "").trim().replace(/\/+$/, "");

async function generateImageDirect(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrls: string[];
  signal?: AbortSignal;
  /** 走通用代理:请求发往代理地址,真实上游放进 x-upstream-base-url 头 */
  proxyBaseUrl?: string;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrls, signal, proxyBaseUrl } = params;
  throwIfAborted(signal);
  const hasReference = referenceImageDataUrls.length > 0;
  const url = buildImageUrl(proxyBaseUrl || settings.baseUrl, hasReference ? "edits" : "generations");
  const headers: Record<string, string> = { Authorization: `Bearer ${settings.apiKey}` };
  if (proxyBaseUrl) headers["x-upstream-base-url"] = normalizeBaseUrl(settings.baseUrl);
  let body: BodyInit;

  if (hasReference) {
    const convertedReferences = referenceImageDataUrls.map(dataUrl => dataUrlToBlob(dataUrl));
    const invalidIndex = convertedReferences.findIndex(reference => !reference);
    if (invalidIndex >= 0) throw new Error(`第 ${invalidIndex + 1} 张参考图格式无效`);
    const form = new FormData();
    form.set("model", settings.model);
    form.set("prompt", prompt);
    if (settings.size && settings.size !== "auto") form.set("size", settings.size);
    if (settings.quality && settings.quality !== "auto") form.set("quality", settings.quality);
    convertedReferences.forEach((converted, index) => {
      if (!converted) return;
      // OpenAI Images edits accepts repeated image[] inputs. Keep the legacy single-image
      // field for providers that only understand the older OpenAI-compatible shape.
      const fieldName = convertedReferences.length > 1 ? "image[]" : "image";
      form.append(fieldName, converted.blob, `reference-${index + 1}.${imageExtension(converted.mimeType)}`);
    });
    body = form;
  } else {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({
      model: settings.model,
      prompt,
      ...(settings.size && settings.size !== "auto" ? { size: settings.size } : {}),
      ...(settings.quality && settings.quality !== "auto" ? { quality: settings.quality } : {}),
    });
  }

  // 总超时 360s,外部 signal 联动;防止上游悬挂导致界面永久转圈。
  // 部分中转的按次生图（如 gpt-image 系）单张实测 3~5 分钟,180s 会在完成前掐断(钱照扣图丢失)。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 360_000);
  try {
    return await parseImageGenerationResponse(await fetch(url, { method: "POST", headers, body, signal: controller.signal }), signal);
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error(proxyBaseUrl ? "生图代理超时（360 秒未返回）" : "生图请求超时（360 秒未返回）");
    }
    if (error instanceof TypeError) {
      throw new Error(proxyBaseUrl ? "生图代理连接失败" : "浏览器直连失败：该 API 可能未允许跨域请求。");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

// 「代理中转」模式:配置了通用代理(CF Worker)就只走它——用户选择什么模式就走什么链路,
// 不做隐藏回落(不再兜底到 Netlify 函数,那会消耗站点额度且有 60s 上限)。
// 常量未配置时保留旧的 Netlify 心跳流式路由(自部署无 Worker 的场景)。
//
// Netlify 心跳路由是站点额度的最大计算开销之一(每张图占用函数 30~120s),而不少
// 选了「服务端转发」的用户,其生图 API 其实允许跨域。因此走 Netlify 前先试一次
// 浏览器直连:直连因 CORS 失败(预检被拒,真实请求未发出,上游不会计费)才回落
// 到服务端,并按 baseUrl 记住失败结果,本次会话内不再重复探测。
const directCorsFailedBaseUrls = new Set<string>();

async function generateImageViaServerOrProxy(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrls: string[];
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  if (IMAGE_GEN_PROXY_URL) {
    try {
      return await generateImageDirect({ ...params, proxyBaseUrl: IMAGE_GEN_PROXY_URL });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("生图代理连接失败")) {
        throw new Error("生图代理连接失败:当前网络可能无法访问代理服务器(部分地区需开启代理),或稍后重试。");
      }
      throw error;
    }
  }
  const baseUrlKey = normalizeBaseUrl(params.settings.baseUrl);
  if (!directCorsFailedBaseUrls.has(baseUrlKey)) {
    try {
      return await generateImageDirect(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 只有连接层失败(CORS/断网)才回落;API 自身的错误(密钥无效、余额不足等)
      // 说明直连是通的,换服务端转发也会得到同样错误,直接抛出避免重复计费。
      if (!message.includes("浏览器直连失败")) throw error;
      throwIfAborted(params.signal);
      directCorsFailedBaseUrls.add(baseUrlKey);
    }
  }
  return generateImageViaServer(params);
}

async function generateImageViaServer(params: {
  settings: ImageGenerationSettings;
  prompt: string;
  referenceImageDataUrls: string[];
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { settings, prompt, referenceImageDataUrls, signal } = params;
  throwIfAborted(signal);
  // 防"无限卡住":函数被平台中途击杀时流可能既不关闭也不报错。
  // 总超时 180s + 断流检测(心跳每 3s 一个字节,超过 25s 没有任何字节视为断流)。
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);
  try {
    // x-stream-heartbeat:服务端以心跳流响应,真正的结果附在流末尾的 @@RESULT@@ 标记后。
    // 避免托管平台对缓冲响应的 10~26s 超时把慢生图(30~120s)掐成 504。
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        model: settings.model,
        prompt,
        size: settings.size,
        quality: settings.quality,
        referenceImageDataUrls: referenceImageDataUrls.length ? referenceImageDataUrls : undefined,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;
    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("生图请求失败（服务器连接中断,超过 25 秒没有响应）");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`生图请求失败 ${res.status}（流式响应中断,未收到结果）`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("生图请求失败（流式结果解析出错）");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `生图请求失败 ${data.httpStatus ?? res.status}`);
      }
    } else {
      // 非流式回退(旧服务端等)
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `生图请求失败 ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiDirect(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const { width, height } = getNovelAiResolution(preset.resolution);

  const url = "https://image.novelai.net/ai/generate-image";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  const body = JSON.stringify({
    input: prompt,
    model: normalizeNovelAiModel(preset.model),
    action: "generate",
    parameters: {
      width,
      height,
      scale: normalizeNovelAiScale(preset.scale),
      sampler: normalizeNovelAiSampler(preset.sampler),
      steps: normalizeNovelAiSteps(preset.steps),
      n_samples: 1,
      ucPreset: 0,
      qualityToggle: preset.qualityToggle !== false,
      sm: preset.smea === true,
      sm_dyn: preset.smeaDyn === true,
      dynamic_thresholding: false,
      controlnet_strength: 1,
      legacy: false,
      add_original_image: false,
      uncond_scale: 1,
      cfg_rescale: 0,
      noise_schedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
      negative_prompt: preset.negativePrompt || "",
    },
  });

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const res = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`NovelAI 接口报错 ${res.status}: ${errText.slice(0, 200)}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    const isZip = (uint8[0] === 0x50 && uint8[1] === 0x4b && uint8[2] === 0x03 && uint8[3] === 0x04)
      || (res.headers.get("content-type") || "").toLowerCase().includes("zip");

    if (isZip) {
      const zip = await JSZip.loadAsync(arrayBuf);
      const files = Object.keys(zip.files);
      const pngFile = files.find(f => f.endsWith(".png")) || files[0];
      if (!pngFile) throw new Error("NovelAI 返回的压缩包内未找到图片");
      const b64 = await zip.files[pngFile].async("base64");
      return { b64, mimeType: "image/png" };
    }

    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return { b64: btoa(binary), mimeType: res.headers.get("content-type") || "image/png" };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new Error("NovelAI 直连请求超时（180 秒未返回）");
    }
    if (error instanceof TypeError) {
      throw new Error("NovelAI 浏览器直连失败：可能受到浏览器跨域 (CORS) 限制，请在生图设置中将请求方式切换为「服务端转发」。");
    }
    throw error;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

async function generateNovelAiViaServer(params: {
  apiKey: string;
  preset: NovelAiPreset;
  prompt: string;
  signal?: AbortSignal;
}): Promise<ImageGenerationApiResponse> {
  const { apiKey, preset, prompt, signal } = params;
  throwIfAborted(signal);

  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onOuterAbort, { once: true });
  const totalTimer = setTimeout(() => controller.abort(), 180_000);

  try {
    const resolution = getNovelAiResolution(preset.resolution);
    const res = await fetch("/api/image-generation", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-stream-heartbeat": "1" },
      signal: controller.signal,
      body: JSON.stringify({
        provider: "novelai",
        apiKey,
        model: normalizeNovelAiModel(preset.model),
        prompt,
        size: resolution.value,
        negativePrompt: preset.negativePrompt || "",
        steps: normalizeNovelAiSteps(preset.steps),
        scale: normalizeNovelAiScale(preset.scale),
        sampler: normalizeNovelAiSampler(preset.sampler),
        noiseSchedule: normalizeNovelAiNoiseSchedule(preset.noiseSchedule),
        qualityToggle: preset.qualityToggle,
        smea: preset.smea,
        smeaDyn: preset.smeaDyn,
      }),
    });
    throwIfAborted(signal);

    type ServerImagePayload = { httpStatus?: number; b64?: string; mimeType?: string; revisedPrompt?: string; error?: string };
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    let data: ServerImagePayload;

    if (contentType.includes("text/plain")) {
      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          for (;;) {
            idleTimer = setTimeout(() => controller.abort(), 25_000);
            const { done, value } = await reader.read();
            clearTimeout(idleTimer);
            if (done) break;
            text += decoder.decode(value, { stream: true });
          }
          text += decoder.decode();
        } catch (err) {
          clearTimeout(idleTimer);
          if (controller.signal.aborted && !signal?.aborted) {
            throw new Error("NovelAI 请求失败（服务器连接中断，超过 25 秒没有响应）");
          }
          throw err;
        }
      } else {
        text = await res.text();
      }
      const marker = "@@RESULT@@";
      const idx = text.lastIndexOf(marker);
      if (idx < 0) throw new Error(`NovelAI 请求失败 ${res.status}（流式响应中断，未收到结果）`);
      try {
        data = JSON.parse(text.slice(idx + marker.length)) as ServerImagePayload;
      } catch {
        throw new Error("NovelAI 请求失败（流式结果解析出错）");
      }
      throwIfAborted(signal);
      if (data.error || !data.b64) {
        throw new Error(data.error || `NovelAI 请求失败 ${data.httpStatus ?? res.status}`);
      }
    } else {
      data = await res.json().catch(() => ({})) as ServerImagePayload;
      throwIfAborted(signal);
      if (!res.ok || data.error || !data.b64) {
        throw new Error(data.error || `NovelAI 请求失败 ${res.status}`);
      }
    }
    return { b64: data.b64, mimeType: data.mimeType, revisedPrompt: data.revisedPrompt };
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }
}

export async function fetchNovelAiModels(apiKey: string): Promise<string[]> {
  const token = apiKey.trim();
  if (!token) throw new Error("请先填写 NovelAI API Token。");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch("https://image.novelai.net/user/data", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("NovelAI API Token 无效或已失效，请重新获取后再试。");
      }
      throw new Error(`NovelAI Token 验证失败 ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`);
    }
    return [...NOVELAI_COMMON_MODELS];
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("NovelAI Token 验证超时，请检查网络后重试。");
    }
    if (error instanceof TypeError) {
      throw new Error("无法连接 NovelAI，请检查网络后重试。");
    }
    if (error instanceof Error) throw error;
    throw new Error("NovelAI Token 验证失败，请检查网络后重试。");
  } finally {
    clearTimeout(timeout);
  }
}

function descriptionExplicitlyIncludesPlayer(description: string): boolean {
  return /(?:玩家本人|玩家入镜|玩家出镜|用户本人|用户形象|用户入镜|用户出镜|我的形象|我的照片|我入镜|我出镜|我在画面|我也在画面|本人入镜|本人出镜|主人本人|主人入镜|主人出镜|主人的形象|我和.{0,24}(?:一起|合照|合影|同框|在画面)|和我.{0,24}(?:一起|合照|合影|同框)|与我.{0,24}(?:一起|合照|合影|同框)|跟我.{0,24}(?:一起|合照|合影|同框)|你和.{0,24}(?:一起|合照|合影|同框|入镜|出镜)|和你.{0,24}(?:一起|合照|合影|同框|入镜|出镜)|与主人.{0,24}(?:一起|合照|合影|同框|入镜|出镜)|和主人.{0,24}(?:一起|合照|合影|同框|入镜|出镜)|我们(?:一起|合照|合影|同框|出镜|入镜)|with me|me in (?:the|this) (?:image|picture)|my appearance|I am (?:in|pictured in)|the user(?: appears| is in the image)?|player character)/i.test(description);
}

const DEFAULT_IDENTITY_FACE_CROP = { x: 0.27, y: 0.12, size: 0.46 };

async function generateImageFromConfiguredApiInternal(params: {
  description: string;
  characterId?: string;
  /** 画面中实际出镜的角色 ID；多角色图片会逐个附加身份参考，而不是拼成固定合照。 */
  characterIds?: string[];
  /** 本次场景的明确出镜人员 ID；用户本人使用保留 ID "__user__"。 */
  participantIds?: string[];
  /** 兼容旧调用方；新调用方应使用 participantIds。 */
  includeUserAppearance?: boolean;
  /** 内容所属 APP；用于按“角色 > APP > 全局”解析生图方案。 */
  appId?: string;
  useReferenceImage?: boolean;
  /** Optional supplemental scene reference, retained for older callers. */
  referenceImageDataUrl?: string;
  settings?: ImageGenerationSettings;
  signal?: AbortSignal;
}): Promise<ImageGenerationResult | null> {
  const storedSettings = params.settings ?? loadImageGenerationSettings();
  // 显式传入 settings 的配置测试/工具调用保持原样；正常业务调用才读取绑定。
  const settings = params.settings
    ? storedSettings
    : applyImageGenerationBinding(
        storedSettings,
        resolveBinding(loadBindingConfig(), params.characterId, params.appId).imageConfigId,
      );
  if (!settings.enabled) return null;

  const description = params.description.trim();
  if (!description) return null;

  const allCharacters = loadCharacters();
  const characterById = new Map(allCharacters.map(character => [character.id, character]));
  const matchedIds = allCharacters
    .filter(character => character.id !== params.characterId && Boolean(character.name?.trim()) && description.includes(character.name.trim()))
    .map(character => character.id);
  const inferredCharacterIds = Array.from(new Set([
    ...(params.characterId ? [params.characterId] : []),
    ...(params.characterIds ?? []),
    ...matchedIds,
  ])).filter(characterId => characterById.has(characterId)).slice(0, 16);
  // 所有生图调用最终都归一化为一份明确的出镜名单；调用方名单优先，旧调用方才回退到描述识别。
  const resolvedParticipantIds = params.participantIds
    ? Array.from(new Set(params.participantIds)).filter(id => id === "__user__" || characterById.has(id))
    : [...inferredCharacterIds, ...((params.includeUserAppearance ?? descriptionExplicitlyIncludesPlayer(description)) ? ["__user__"] : [])];
  const involvedCharacterIds = resolvedParticipantIds.filter(id => id !== "__user__" && characterById.has(id)).slice(0, 16);
  const includeUserAppearance = resolvedParticipantIds.includes("__user__");

  const characterIdentityPrompt = involvedCharacterIds.map(characterId => {
    const character = characterById.get(characterId);
    const characterReference = settings.characterReferences?.[characterId];
    const featurePrompt = characterReference?.featurePrompt?.trim();
    if (!character || !featurePrompt || (settings.provider === "novelai" && characterReference?.novelAiFeaturePromptEnabled === false)) return "";
    return `${character.name}的稳定身份特征（不固定临时服装和姿态）：${featurePrompt}`;
  }).filter(Boolean);
  const userReference = settings.characterReferences?.["__user__"];
  const userAppearancePrompt = includeUserAppearance && userReference?.featurePrompt?.trim()
    ? `玩家本人稳定外观（只用于识别本人；服装、姿势、表情和场景以本次提示词为准）：${userReference.featurePrompt.trim()}`
    : "";
  const identityPolicy = (involvedCharacterIds.length || includeUserAppearance)
    ? "身份参考规则：只保持每个人可识别的身份特征，例如面部、五官、发色、发型及明显识别标记。不要照搬参考图的服装、姿势、表情、站位、镜头、构图、背景或光线；这些内容必须服从本次场景描述，可以每次变化。"
    : "";
  const identityPrompt = [identityPolicy, ...characterIdentityPrompt, userAppearancePrompt].filter(Boolean).join("\n");

  // NovelAI 当前生成接口不接收多张身份参考图。仍传入每位出镜角色的文字身份锚点，
  // 不把多张脸图混成一张参考图，避免模型将多位角色的身份融合。
  if (settings.provider === "novelai") {
    const naiApiKey = settings.novelai?.apiKey?.trim();
    if (!naiApiKey) return null;

    const presets = settings.novelai?.presets && settings.novelai.presets.length > 0
      ? settings.novelai.presets
      : [DEFAULT_NOVELAI_PRESET];
    const activePreset = presets.find(p => p.id === settings.novelai?.activePresetId) || presets[0];

    const positiveParts: string[] = [];
    if (activePreset.positivePrompt?.trim()) positiveParts.push(activePreset.positivePrompt.trim());
    if (identityPrompt) positiveParts.push(identityPrompt);
    if (description) positiveParts.push(description);
    const fullPrompt = positiveParts.join(", ");

    const novelAiRequestMode = settings.novelai?.requestMode || settings.requestMode;
    const data = novelAiRequestMode === "direct"
      ? await generateNovelAiDirect({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal })
      : await generateNovelAiViaServer({ apiKey: naiApiKey, preset: activePreset, prompt: fullPrompt, signal: params.signal });

    throwIfAborted(params.signal);
    const mimeType = data.mimeType || "image/png";
    const blob = base64ToBlob(data.b64, mimeType);
    throwIfAborted(params.signal);
    const mediaRef = await storeMediaBlob(blob, mimeType, "image");
    throwIfAborted(params.signal);
    return {
      mediaRef,
      dataUrl: `data:${mimeType};base64,${data.b64}`,
      blob,
      mimeType,
      prompt: fullPrompt,
      usedReferenceImage: false,
      referenceImageCount: 0,
      referenceImageLabels: [],
      revisedPrompt: data.revisedPrompt,
    };
  }

  // OpenAI 兼容模式：按真实出镜人物分别读取脸部裁切图，让接口知道每张图对应哪位角色。
  const openaiPreset = settings.openaiPresets?.find(preset => preset.id === settings.activeOpenAiPresetId)
    || settings.openaiPresets?.[0];
  const openaiSettings = openaiPreset ? { ...settings, ...openaiPreset } : settings;
  if (!openaiSettings.apiKey.trim() || !openaiSettings.baseUrl.trim() || !openaiSettings.model.trim()) return null;

  let referenceSources: ReferenceSource[] = [];
  const suppliedReferenceImageDataUrl = params.referenceImageDataUrl?.trim() || null;
  if (suppliedReferenceImageDataUrl) {
    referenceSources.push({ label: "补充场景参考", dataUrl: suppliedReferenceImageDataUrl });
  }

  const appendCharacterReference = async (characterId: string) => {
    const reference = settings.characterReferences?.[characterId];
    if (!reference?.assetId) return;
    const dataUrl = await getChatImageFromIndexedDB(reference.assetId);
    if (dataUrl) {
      const character = characterById.get(characterId);
      referenceSources.push({
        label: character?.name || "角色",
        dataUrl,
        crop: reference.faceCrop || DEFAULT_IDENTITY_FACE_CROP,
      });
    }
  };

  {
    // Identity references are automatic by default; only an explicit per-image opt-out disables them.
    // Primary character is first. This ensures the current chat speaker's identity remains the anchor.
    // "current" is a single-speaker shortcut only for one-person images.
    // Explicit multi-character scenes must retain every participant's identity reference.
    const referenceCharacterIds = settings.referenceImageMode === "current" && involvedCharacterIds.length <= 1
      ? involvedCharacterIds.slice(0, 1)
      : involvedCharacterIds;
    for (const characterId of referenceCharacterIds) {
      await appendCharacterReference(characterId);
      throwIfAborted(params.signal);
    }

  }

  // 用户本人使用与普通角色相同的身份参考结构，只有明确列入本次出镜名单时才加入。
  if (includeUserAppearance) {
    const user = settings.characterReferences?.["__user__"];
    if (user?.assetId) {
      const dataUrl = await getChatImageFromIndexedDB(user.assetId);
      if (dataUrl) referenceSources.splice(suppliedReferenceImageDataUrl ? 1 : 0, 0, {
        label: "用户本人", dataUrl, crop: user.faceCrop || DEFAULT_IDENTITY_FACE_CROP,
      });
    }
  }

  let collageLegend = "";
  if (settings.referenceImageMode === "collage" && referenceSources.length > 1) {
    const collage = await buildReferenceCollage(referenceSources);
    if (collage) {
      collageLegend = collage.legend;
      referenceSources = [{ label: `多人身份参考拼图（${collage.legend}）`, dataUrl: collage.dataUrl }];
    }
  }

  const limitedSources = referenceSources.slice(0, 16);
  const referenceImageDataUrls: string[] = [];
  const referenceLabels: string[] = [];
  for (const source of limitedSources) {
    throwIfAborted(params.signal);
    const normalized = await normalizeReferenceImageForEdit(source.dataUrl, source.crop);
    referenceImageDataUrls.push(normalized);
    referenceLabels.push(source.label);
  }

  const referenceMapPrompt = referenceLabels.length
    ? [
        "【身份参考图对应关系】",
        ...(collageLegend
          ? [`参考图1是多人身份参考拼图，编号对应：${collageLegend}。只按编号参考对应人物的脸，不要互换、复制或融合不同角色的身份。`]
          : referenceLabels.map((label, index) => `参考图${index + 1}对应：${label}。只参考该人物的身份特征，不代表固定服装或固定构图。`)),
        "每位出镜人物都必须对应自己的参考图，不要互换、复制或融合不同角色的脸。"
      ].join("\n")
    : "";
  const prompt = mergePrompt(
    mergePrompt(description, [identityPrompt, referenceMapPrompt].filter(Boolean).join("\n")),
    openaiSettings.extraPrompt,
  );

  const data = openaiSettings.requestMode === "direct"
    ? await generateImageDirect({ settings: openaiSettings, prompt, referenceImageDataUrls, signal: params.signal })
    : await generateImageViaServerOrProxy({ settings: openaiSettings, prompt, referenceImageDataUrls, signal: params.signal });

  throwIfAborted(params.signal);
  const mimeType = data.mimeType || "image/png";
  const blob = base64ToBlob(data.b64, mimeType);
  throwIfAborted(params.signal);
  const mediaRef = await storeMediaBlob(blob, mimeType, "image");
  throwIfAborted(params.signal);
  return {
    mediaRef,
    dataUrl: `data:${mimeType};base64,${data.b64}`,
    blob,
    mimeType,
    prompt,
    usedReferenceImage: referenceImageDataUrls.length > 0,
    referenceImageCount: referenceImageDataUrls.length,
    referenceImageLabels: referenceLabels,
    revisedPrompt: data.revisedPrompt,
  };
}


type ImageGenerationCallRecord = {
  id: string;
  startedAt: string;
  durationMs: number;
  appId?: string;
  provider: string;
  model: string;
  participantIds: string[];
  participantNames: string[];
  referenceImageMode: string;
  usedReferenceImage: boolean;
  referenceImageCount?: number;
  referenceImageLabels?: string[];
  prompt: string;
  status: "success" | "failed" | "skipped";
  error?: string;
};

const IMAGE_GENERATION_CALLS_KEY = "ai_phone_image_generation_calls_v1";

/** Local, bounded diagnostics for image requests. API credentials and request headers are never stored. */
export function loadImageGenerationCallRecords(): ImageGenerationCallRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const value = JSON.parse(window.localStorage.getItem(IMAGE_GENERATION_CALLS_KEY) || "[]");
    return Array.isArray(value) ? value.slice(0, 80) as ImageGenerationCallRecord[] : [];
  } catch {
    return [];
  }
}

export function clearImageGenerationCallRecords(): void {
  if (typeof window !== "undefined") window.localStorage.removeItem(IMAGE_GENERATION_CALLS_KEY);
}

function saveImageGenerationCallRecord(record: ImageGenerationCallRecord): void {
  if (typeof window === "undefined") return;
  try {
    const next = [record, ...loadImageGenerationCallRecords()].slice(0, 80);
    window.localStorage.setItem(IMAGE_GENERATION_CALLS_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event("image-generation-diagnostics-updated"));
  } catch (error) {
    console.warn("[ImageGeneration] diagnostics write failed", error);
  }
}

export async function generateImageFromConfiguredApi(params: Parameters<typeof generateImageFromConfiguredApiInternal>[0]): Promise<ImageGenerationResult | null> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const settings = params.settings ?? loadImageGenerationSettings();
  const characters = loadCharacters();
  const ids = Array.from(new Set([
    ...(params.participantIds ?? []),
    ...(params.characterIds ?? []),
    ...(params.characterId ? [params.characterId] : []),
  ]));
  const participantIds = ids.slice(0, 16);
  const participantNames = participantIds.map(id => id === "__user__" ? "用户本人" : characters.find(item => item.id === id)?.name || id);
  const baseRecord: Omit<ImageGenerationCallRecord, "durationMs" | "status" | "prompt" | "usedReferenceImage"> = {
    id: "image-call-" + started.toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    startedAt,
    appId: params.appId,
    provider: settings.provider || "unknown",
    model: settings.provider === "novelai"
      ? settings.novelai?.presets?.find(item => item.id === settings.novelai?.activePresetId)?.model || settings.novelai?.presets?.[0]?.model || "unknown"
      : settings.openaiPresets?.find(item => item.id === settings.activeOpenAiPresetId)?.model || settings.openaiPresets?.[0]?.model || settings.model || "unknown",
    participantIds,
    participantNames,
    referenceImageMode: settings.referenceImageMode || "automatic",
  };
  try {
    const result = await generateImageFromConfiguredApiInternal(params);
    saveImageGenerationCallRecord({
      ...baseRecord,
      durationMs: Date.now() - started,
      status: result ? "success" : "skipped",
      prompt: result?.prompt?.slice(0, 6000) || params.description.slice(0, 6000),
      usedReferenceImage: result?.usedReferenceImage === true,
      referenceImageCount: result?.referenceImageCount,
      referenceImageLabels: result?.referenceImageLabels,
    });
    return result;
  } catch (error) {
    saveImageGenerationCallRecord({
      ...baseRecord,
      durationMs: Date.now() - started,
      status: "failed",
      prompt: params.description.slice(0, 6000),
      usedReferenceImage: Boolean(params.referenceImageDataUrl || params.useReferenceImage),
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    });
    throw error;
  }
}

export function generatedImageFilename(description: string, mimeType = "image/png"): string {
  const safe = description
    .replace(/\s+/g, "-")
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, "")
    .slice(0, 28) || "generated-image";
  return `${safe}.${imageExtension(mimeType)}`;
}

export function hasCharacterReferenceImage(characterId?: string): boolean {
  if (!characterId) return false;
  const settings = loadImageGenerationSettings();
  const ref = settings.characterReferences?.[characterId];
  return Boolean(ref?.assetId);
}
