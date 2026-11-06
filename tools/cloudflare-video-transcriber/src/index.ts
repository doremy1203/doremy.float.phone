export interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<{
    text?: string;
    vtt?: string;
    segments?: Array<{ start?: number; end?: number; text?: string }>;
    language?: string;
  }> };
  TRANSCRIBE_TOKEN: string;
  ALLOWED_ORIGINS: string;
  ALLOWED_MEDIA_HOSTS: string;
}

const MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|webm)$/i;

function json(payload: unknown, status = 200, origin?: string): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Vary": "Origin" });
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return new Response(JSON.stringify(payload), { status, headers });
}
function list(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}
function parseVtt(vtt: string): Array<{ start: number; end: number; text: string }> {
  const blocks = vtt.replace(/^\uFEFF/, "").replace(/\r/g, "").split(/\n\s*\n/);
  const segments: Array<{ start: number; end: number; text: string }> = [];
  const seconds = (value: string): number | null => {
    const input = value.trim();
    let m = input.match(/^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{3})$/);
    if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
    m = input.match(/^(\d{1,2}):(\d{2})[.,](\d{3})$/);
    if (m) return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 1000;
    m = input.match(/^(\d{1,2})[.,](\d{3})$/);
    if (m) return Number(m[1]) + Number(m[2]) / 1000;
    return null;
  };
  for (const block of blocks) {
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) continue;
    const times = lines[index].split("-->");
    const start = seconds(times[0] || "");
    const end = seconds((times[1] || "").trim().split(/\s+/)[0] || "");
    if (start === null || end === null) continue;
    const text = lines.slice(index + 1).join(" ").replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
    if (text) segments.push({ start, end: Math.max(start, end), text });
  }
  return segments;
}
function isPublicHostname(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "");
  if (!lower || lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal") || lower.endsWith(".lan") || /^(\d{1,3}\.){3}\d{1,3}$/.test(lower) || lower.includes(":")) return false;
  return true;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const origins = list(env.ALLOWED_ORIGINS);
    if (request.method === "OPTIONS") {
      if (origin && !origins.includes(origin)) return json({ ok: false, error: "Origin is not allowed." }, 403);
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600", "Vary": "Origin",
      }});
    }
    if (origin && !origins.includes(origin)) return json({ ok: false, error: "Origin is not allowed. Set ALLOWED_ORIGINS to the exact web-app origin." }, 403);
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "momo-cloudflare-transcriber", model: MODEL, accepts: "direct audio URLs only" }, 200, origin || undefined);
    if (request.method !== "POST" || url.pathname !== "/transcribe") return json({ ok: false, error: "Use POST /transcribe or GET /health." }, 404, origin || undefined);
    if (!env.TRANSCRIBE_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.TRANSCRIBE_TOKEN) return json({ ok: false, error: "Missing or invalid service token." }, 401, origin || undefined);

    let body: { url?: unknown; language?: unknown };
    try { body = await request.json() as typeof body; }
    catch { return json({ ok: false, error: "Request body must be JSON." }, 400, origin || undefined); }
    if (typeof body.url !== "string" || body.url.length > 4096) return json({ ok: false, error: "Provide a direct audio-file URL." }, 400, origin || undefined);
    let media: URL;
    try { media = new URL(body.url); }
    catch { return json({ ok: false, error: "Invalid audio URL." }, 400, origin || undefined); }
    const allowedHosts = list(env.ALLOWED_MEDIA_HOSTS).map((host) => host.toLowerCase());
    if (media.protocol !== "https:" || media.username || media.password || !isPublicHostname(media.hostname) || !AUDIO_EXT.test(media.pathname) || !allowedHosts.includes(media.hostname.toLowerCase())) {
      return json({ ok: false, error: "Use an HTTPS direct audio URL from a hostname listed in ALLOWED_MEDIA_HOSTS. Arbitrary platform video pages are not supported." }, 400, origin || undefined);
    }
    try {
      const audioResponse = await fetch(media.toString(), { redirect: "manual" });
      if (audioResponse.status >= 300 && audioResponse.status < 400) return json({ ok: false, error: "Audio host redirected. Use a final direct HTTPS audio URL on an allowed host." }, 400, origin || undefined);
      if (!audioResponse.ok) return json({ ok: false, error: "Audio host returned HTTP " + audioResponse.status + "." }, 502, origin || undefined);
      const declaredLength = Number(audioResponse.headers.get("Content-Length") || 0);
      if (declaredLength > MAX_AUDIO_BYTES) return json({ ok: false, error: "Audio exceeds the 8 MB per-request limit. Use a shorter clip or the local transcription fallback." }, 413, origin || undefined);
      const bytes = await audioResponse.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_AUDIO_BYTES) return json({ ok: false, error: "Audio is empty or exceeds the 8 MB per-request limit." }, 413, origin || undefined);
      const result = await env.AI.run(MODEL, { audio: Array.from(new Uint8Array(bytes)), task: "transcribe", ...(typeof body.language === "string" && /^[A-Za-z-]{2,12}$/.test(body.language) ? { language: body.language } : {}) });
      const segments = Array.isArray(result.segments)
        ? result.segments.filter((item) => typeof item.text === "string").map((item) => ({ start: Math.max(0, Number(item.start) || 0), end: Math.max(0, Number(item.end) || Number(item.start) || 0), text: String(item.text).trim() })).filter((item) => item.text)
        : parseVtt(result.vtt || "");
      if (!segments.length && result.text?.trim()) segments.push({ start: 0, end: 86400, text: result.text.trim() });
      if (!segments.length) return json({ ok: false, error: "The model returned no usable transcript. Try a shorter supported audio clip." }, 502, origin || undefined);
      const transcript = JSON.stringify({ source: media.toString(), model: MODEL, language: result.language || body.language || null, segments, text: segments.map((item) => item.text).join(" ") });
      return json({ ok: true, title: media.pathname.split("/").pop() || "audio transcript", transcript, segmentCount: segments.length }, 200, origin || undefined);
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : "Transcription failed." }, 502, origin || undefined);
    }
  },
};
