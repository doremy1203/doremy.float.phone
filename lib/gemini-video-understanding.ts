import { analyzeVideoUsingKeyframes } from "@/lib/video-keyframe-analysis";
import { pushApiLog } from "./api-log-store";
/**
 * Gemini Files API video understanding.
 *
 * This intentionally uses the user's existing direct Google/Gemini API binding.
 * The video is uploaded as a file (not reduced to screenshots), then attached to
 * generateContent. The temporary Gemini file is deleted best-effort after analysis.
 */
export type GeminiVideoProgress = (message: string) => void;

type GeminiUploadedFile = {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  error?: { message?: string };
};

function readErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
  }
  return fallback;
}

async function analyzeWholeVideoWithGeminiCore(options: {
  file: File;
  apiKey: string;
  model: string;
  prompt: string;
  provider?: "gemini" | "ark" | "openai-compatible" | "anthropic" | "twelvelabs";
  baseUrl?: string;
  maxFileSizeMb?: number;
  frameCount?: number;
  signal?: AbortSignal;
  onProgress?: GeminiVideoProgress;
}): Promise<string> {
  const { file, apiKey, model, prompt, signal, onProgress } = options;
  if (!model.trim()) throw new Error("请先在系统设置 → 视频分析模型填写模型 ID。");
  const provider = options.provider || "gemini";
  const baseUrl = options.baseUrl?.trim() || "";
  const isLocalEndpoint = /^(https?:\/\/)?(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\]|192\.168\.)/i.test(baseUrl);
  if (!apiKey.trim() && !(provider === "openai-compatible" && isLocalEndpoint)) throw new Error("请先在系统设置 → 视频分析模型填写所选服务的 API Key（本机兼容接口可按服务要求留空）。");
  const extension = file.name.toLowerCase().split(".").pop() || "";
  const inferredMime = ({ mp4: "video/mp4", m4v: "video/x-m4v", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", ogg: "video/ogg", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", mpeg: "video/mpeg", mpg: "video/mpeg", "3gp": "video/3gpp" } as Record<string, string>)[extension];
  const mimeType = file.type.startsWith("video/") ? file.type : inferredMime || file.type || "";
  if (!mimeType.startsWith("video/")) throw new Error("所选文件不是可识别的视频文件。");
  if (file.size <= 0) throw new Error("视频文件为空。");
  // Files API can handle large files, but respect the user-configured client guard.
  const maxFileSizeMb = Math.min(2048, Math.max(50, options.maxFileSizeMb ?? 1024));
  if (file.size > maxFileSizeMb * 1024 * 1024) throw new Error("视频超过当前设置的 " + maxFileSizeMb + " MB 上限。请在系统设置 → 视频分析模型调整上限，或先压缩视频。");

  if (provider === "ark") return analyzeWholeVideoWithArk({ file, apiKey, model, prompt, baseUrl: options.baseUrl, maxFileSizeMb, signal, onProgress });
  if (provider === "twelvelabs") return analyzeWholeVideoWithTwelveLabs({ file, apiKey, model, prompt, baseUrl: options.baseUrl, signal, onProgress });
  if (provider === "openai-compatible" || provider === "anthropic") return analyzeVideoUsingKeyframes({ file, apiKey, model, prompt, provider, baseUrl: options.baseUrl, frameCount: options.frameCount ?? 12, signal, onProgress });

  const apiRoot = "https://generativelanguage.googleapis.com";
  const authHeader = { "x-goog-api-key": apiKey.trim() };
  let uploadedName = "";

  try {
    onProgress?.("正在向 Gemini 上传完整视频…");
    const startResponse = await fetch(apiRoot + "/upload/v1beta/files", {
      method: "POST",
      headers: {
        ...authHeader,
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(file.size),
        "X-Goog-Upload-Header-Content-Type": mimeType,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: file.name.slice(0, 200) } }),
      signal,
    });
    if (!startResponse.ok) {
      const payload = await startResponse.json().catch(() => null);
      throw new Error(readErrorMessage(payload, "无法初始化 Gemini 视频上传（HTTP " + startResponse.status + "）。"));
    }
    const uploadUrl = startResponse.headers.get("x-goog-upload-url");
    if (!uploadUrl) {
      throw new Error("Gemini 没有返回上传地址。当前浏览器或 API 中转站可能不支持 Files API；请使用直连 Google Gemini API。");
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "X-Goog-Upload-Offset": "0",
        "X-Goog-Upload-Command": "upload, finalize",
        "Content-Type": mimeType,
      },
      body: file,
      signal,
    });
    const uploadPayload = await uploadResponse.json().catch(() => null) as { file?: GeminiUploadedFile; error?: { message?: string } } | null;
    if (!uploadResponse.ok) {
      throw new Error(readErrorMessage(uploadPayload, "视频上传失败（HTTP " + uploadResponse.status + "）。"));
    }
    const uploaded = uploadPayload?.file;
    uploadedName = uploaded?.name || "";
    if (!uploadedName || !uploaded?.uri) {
      throw new Error("Gemini 上传完成，但没有返回可供模型读取的视频文件 URI。");
    }

    let activeFile = uploaded;
    // Gemini may need time to process video/audio tracks before it can be analyzed.
    for (let attempt = 0; activeFile.state && activeFile.state !== "ACTIVE"; attempt += 1) {
      if (activeFile.state === "FAILED") throw new Error(activeFile.error?.message || "Gemini 视频预处理失败。");
      if (attempt >= 60) throw new Error("Gemini 视频预处理超时，请稍后重试。");
      onProgress?.("Gemini 正在识别视频与音轨…");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(2000 + attempt * 250, 5000));
        if (signal) {
          const abort = () => { clearTimeout(timer); reject(new DOMException("已取消视频分析。", "AbortError")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      const statusResponse = await fetch(apiRoot + "/v1beta/" + encodeURIComponent(uploadedName).replace(/%2F/g, "/"), { headers: authHeader, signal });
      const statusPayload = await statusResponse.json().catch(() => null) as (GeminiUploadedFile & { error?: { message?: string } }) | { file?: GeminiUploadedFile; error?: { message?: string } } | null;
      const statusFile = statusPayload && "file" in statusPayload ? statusPayload.file : statusPayload as GeminiUploadedFile | null;
      if (!statusResponse.ok || !statusFile?.name) {
        throw new Error(readErrorMessage(statusPayload, "读取 Gemini 视频处理状态失败。"));
      }
      activeFile = statusFile;
    }

    onProgress?.("视频已就绪，角色正在完整观看并组织回应…");
    const normalizedModel = model.trim().replace(/^models\//, "");
    const generateResponse = await fetch(apiRoot + "/v1beta/models/" + encodeURIComponent(normalizedModel) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { fileData: { mimeType: activeFile.mimeType || mimeType, fileUri: activeFile.uri || uploaded.uri } },
            { text: prompt },
          ],
        }],
        generationConfig: { temperature: 0.8, maxOutputTokens: 2048 },
      }),
      signal,
    });
    const generatedPayload = await generateResponse.json().catch(() => null) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
      error?: { message?: string };
    } | null;
    if (!generateResponse.ok) {
      throw new Error(readErrorMessage(generatedPayload, "Gemini 视频理解失败（HTTP " + generateResponse.status + "）。"));
    }
    const text = (generatedPayload?.candidates?.[0]?.content?.parts || [])
      .map(part => typeof part.text === "string" ? part.text : "")
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!text) throw new Error("Gemini 没有返回文字回应。模型可能不支持视频输入，或本次输出被安全策略拦截。");
    return text;
  } finally {
    if (uploadedName) {
      // Files API files are temporary, but delete promptly rather than leaving the
      // user's personal video around until the provider's automatic expiry.
      void fetch(apiRoot + "/v1beta/" + encodeURIComponent(uploadedName).replace(/%2F/g, "/"), {
        method: "DELETE",
        headers: authHeader,
        keepalive: true,
      }).catch(() => {});
    }
  }
}

async function analyzeWholeVideoWithArk(options: {
  file: File; apiKey: string; model: string; prompt: string; baseUrl?: string;
  maxFileSizeMb: number; signal?: AbortSignal; onProgress?: GeminiVideoProgress;
}): Promise<string> {
  const { file, apiKey, model, prompt, signal, onProgress } = options;
  const root = (options.baseUrl || "https://ark.cn-beijing.volces.com/api/v3").trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(root)) throw new Error("方舟 API 地址必须使用 HTTPS。");
  const headers = { Authorization: "Bearer " + apiKey.trim() };
  let fileId = "";
  try {
    onProgress?.("正在向火山方舟上传完整视频…");
    const form = new FormData();
    form.append("file", file, file.name);
    form.append("purpose", "user_data");
    form.append("preprocess_configs[video][model]", model.trim());
    form.append("preprocess_configs[video][fps]", "0.5");
    const upload = await fetch(root + "/files", { method: "POST", headers, body: form, signal });
    const uploadPayload = await upload.json().catch(() => null) as { id?: string; error?: { message?: string }; status?: string } | null;
    if (!upload.ok || !uploadPayload?.id) throw new Error(readErrorMessage(uploadPayload, "火山方舟视频上传失败（HTTP " + upload.status + "）。"));
    fileId = uploadPayload.id;

    let status = uploadPayload.status || "";
    for (let attempt = 0; status && !["active", "succeeded", "completed"].includes(status.toLowerCase()); attempt += 1) {
      if (["failed", "error", "cancelled"].includes(status.toLowerCase())) throw new Error("火山方舟视频预处理失败。");
      if (attempt >= 90) throw new Error("火山方舟视频预处理超时，请稍后重试。");
      onProgress?.("火山方舟正在处理视频…");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, Math.min(1500 + attempt * 150, 5000));
        if (signal) {
          const abort = () => { clearTimeout(timer); reject(new DOMException("已取消视频分析。", "AbortError")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      const poll = await fetch(root + "/files/" + encodeURIComponent(fileId), { headers, signal });
      const payload = await poll.json().catch(() => null) as { status?: string; error?: { message?: string } } | null;
      if (!poll.ok || !payload) throw new Error(readErrorMessage(payload, "读取方舟视频处理状态失败。"));
      status = payload.status || "";
    }

    onProgress?.("视频已就绪，角色正在观看并组织回应…");
    const response = await fetch(root + "/responses", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, signal,
      body: JSON.stringify({
        model: model.trim(),
        input: [{ role: "user", content: [
          { type: "input_video", file_id: fileId },
          { type: "input_text", text: prompt },
        ] }],
      }),
    });
    const result = await response.json().catch(() => null) as {
      output_text?: string;
      output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
      error?: { message?: string };
    } | null;
    if (!response.ok) throw new Error(readErrorMessage(result, "方舟视频理解失败（HTTP " + response.status + "）。"));
    const outputText = result?.output_text || result?.output?.flatMap(item => item.content || []).map(part => part.text || "").filter(Boolean).join("\n") || "";
    if (!outputText.trim()) throw new Error("方舟没有返回文字回应。请检查模型是否支持视频输入及 Responses API。");
    return outputText.trim();
  } finally {
    if (fileId) void fetch(root + "/files/" + encodeURIComponent(fileId), { method: "DELETE", headers, keepalive: true }).catch(() => {});
  }
}


async function analyzeWholeVideoWithTwelveLabs(options: {
  file: File; apiKey: string; model: string; prompt: string; baseUrl?: string;
  signal?: AbortSignal; onProgress?: GeminiVideoProgress;
}): Promise<string> {
  const { file, apiKey, model, prompt, signal, onProgress } = options;
  if (file.size > 200 * 1024 * 1024) throw new Error("TwelveLabs 本地视频上传上限约为 200 MB，请压缩视频或选择 Gemini/豆包。");
  const root = (options.baseUrl || "https://api.twelvelabs.io/v1.3").trim().replace(/\/+$/, "");
  if (!root.toLowerCase().startsWith("https://")) throw new Error("TwelveLabs API 地址必须使用 HTTPS。");
  const headers = { "x-api-key": apiKey.trim() };
  let assetId = "";
  try {
    onProgress?.("正在向 TwelveLabs 上传视频资产…");
    const form = new FormData();
    form.append("method", "direct");
    form.append("file", file, file.name);
    form.append("enable_hls", "false");
    form.append("enable_thumbnail", "false");
    const upload = await fetch(root + "/assets", { method: "POST", headers, body: form, signal });
    const uploadPayload = await upload.json().catch(() => null) as { _id?: string; status?: string; error?: { message?: string } } | null;
    if (!upload.ok || !uploadPayload?._id) throw new Error(readErrorMessage(uploadPayload, "TwelveLabs 视频上传失败（HTTP " + upload.status + "）。"));
    assetId = uploadPayload._id;
    let status = uploadPayload.status || "processing";
    for (let attempt = 0; status !== "ready"; attempt += 1) {
      if (status === "failed") throw new Error("TwelveLabs 视频资产处理失败。请检查格式、时长与模型限制。");
      if (attempt >= 90) throw new Error("TwelveLabs 视频预处理超时，请稍后重试。");
      onProgress?.("TwelveLabs 正在处理视频资产…");
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2000);
        if (signal) {
          const abort = () => { clearTimeout(timer); reject(new DOMException("已取消视频分析。", "AbortError")); };
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }
      });
      const poll = await fetch(root + "/assets/" + encodeURIComponent(assetId), { headers, signal });
      const payload = await poll.json().catch(() => null) as { status?: string; error?: { message?: string } } | null;
      if (!poll.ok || !payload?.status) throw new Error(readErrorMessage(payload, "读取 TwelveLabs 视频状态失败。"));
      status = payload.status;
    }
    onProgress?.("视频已就绪，TwelveLabs 正在分析完整视频…");
    const response = await fetch(root + "/analyze", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ model_name: model.trim() || "pegasus1.6", video: { type: "asset", asset_id: assetId }, prompt, stream: false, max_tokens: 1800, temperature: 0.6 }),
      signal,
    });
    const result = await response.json().catch(() => null) as { data?: string; text?: string; output_text?: string; error?: { message?: string }; event_type?: string } | null;
    if (!response.ok) throw new Error(readErrorMessage(result, "TwelveLabs 视频理解失败（HTTP " + response.status + "）。"));
    const output = result?.data || result?.text || result?.output_text || "";
    if (!output.trim()) throw new Error("TwelveLabs 没有返回文字回应。请检查模型 ID 是否为 pegasus1.5 或 pegasus1.6。");
    return output.trim();
  } finally {
    if (assetId) void fetch(root + "/assets/" + encodeURIComponent(assetId), { method: "DELETE", headers, keepalive: true }).catch(() => {});
  }
}


export async function analyzeWholeVideoWithGemini(
  options: Parameters<typeof analyzeWholeVideoWithGeminiCore>[0],
): Promise<string> {
  try {
    const text = await analyzeWholeVideoWithGeminiCore(options);
    pushApiLog({
      characterName: "视频分析",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[视频]" }],
      rawResponse: text,
    });
    return text;
  } catch (error) {
    pushApiLog({
      characterName: "视频分析",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[视频]" }],
      rawResponse: "[错误] " + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}
