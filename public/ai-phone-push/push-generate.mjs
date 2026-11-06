// 离线推送·兜底生成执行器（Supabase Edge Function 版）
// 部署：Dashboard → Edge Functions → 新建函数 push-generate → 粘贴本文件 →
//      关闭 JWT 校验（Enforce JWT verification = off，本函数用 cron_secret 自校验）
// 职责：认领预约 → 解密快照 → 原样重放 LLM 请求 → 原始输出写 push_outbox →
//      分条推送（800ms 节奏）→ 标记完成。逻辑与 netlify 版一致。
// 注意：本文件为自包含移植，若改动 lib/llm-provider-adapter 的解析或
//      lib/push-preview-split 的分条规则，需同步更新这里。

type ProviderKind = "openai-compatible" | "anthropic" | "gemini";

// ── 内嵌：Web Push 协议原生实现（RFC8291 aes128gcm + RFC8292 VAPID）──
// npm:web-push 依赖 Node 加密接口，在 Deno Edge 运行时不可靠，这里用 WebCrypto 手写。

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as unknown as BufferSource, info: info as unknown as BufferSource },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

async function encryptWebPushPayload(p256dhB64: string, authB64: string, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic as unknown as BufferSource, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const ikm = await hkdf(authSecret, ecdh, concatBytes(utf8("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as unknown as BufferSource, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(utf8(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce as unknown as BufferSource },
    aesKey,
    plaintext as unknown as BufferSource,
  ));

  // aes128gcm 头：salt(16) + rs(4, 4096) + idlen(1) + as_public(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concatBytes(header, ciphertext);
}

async function buildVapidAuth(endpoint: string, subject: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
  const pub = b64urlToBytes(publicKeyB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: privateKeyB64,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(utf8(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject,
  })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(signingInput) as unknown as BufferSource,
  ));
  return `vapid t=${signingInput}.${bytesToB64url(signature)}, k=${publicKeyB64}`;
}

/** 发送一条 Web Push；返回 HTTP 状态码（201=成功，404/410=订阅失效）。 */
async function sendWebPushRaw(
  sub: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  vapid: { publicKey: string; privateKey: string; subject: string },
  ttl: number,
): Promise<number> {
  const body = await encryptWebPushPayload(sub.p256dh, sub.auth, payload);
  const authorization = await buildVapidAuth(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateKey);
  const response = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: "high",
    },
    body: body as unknown as BodyInit,
  });
  await response.text().catch(() => "");
  return response.status;
}

// ── 内嵌：lib/llm-provider-adapter 的响应文本提取 ──
function stripHallucinatedTimestamps(text: string): string {
  return text
    .replace(/[（(]\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?(?:\s+[^)）]*)?[)）]\s*/g, "")
    .replace(/\(system\s*time\s*[:：][^)]*\)\s*/gi, "");
}

function textFromUnknownContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const item = part && typeof part === "object" ? part as Record<string, unknown> : {};
      if (typeof item.text === "string") return item.text;
      return "";
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function extractResponseText(providerKind: ProviderKind, data: unknown): string {
  if (providerKind === "anthropic") {
    const blocks = (data as { content?: unknown[] }).content;
    let text = "";
    for (const block of Array.isArray(blocks) ? blocks : []) {
      const item = block as { type?: string; text?: string };
      if (item.type === "text") text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  if (providerKind === "gemini") {
    const parts = (data as { candidates?: Array<{ content?: { parts?: unknown[] } }> }).candidates?.[0]?.content?.parts || [];
    let text = "";
    for (const part of parts) {
      const item = part as { text?: string; thought?: boolean; functionCall?: unknown };
      if (!item.functionCall && !item.thought) text += item.text ?? "";
    }
    return stripHallucinatedTimestamps(text);
  }
  const d = data as { choices?: Array<{ message?: { content?: unknown }; text?: string }>; output?: { text?: string }; response?: string };
  const messageText = textFromUnknownContent(d.choices?.[0]?.message?.content).trim();
  const text = messageText
    || (typeof d.choices?.[0]?.text === "string" ? d.choices[0].text.trim() : "")
    || (typeof d.output?.text === "string" ? d.output.text.trim() : "")
    || (typeof d.response === "string" ? d.response.trim() : "");
  return stripHallucinatedTimestamps(text);
}

// ── 内嵌：lib/push-preview-split 的弹窗预览分条 ──
const RICH_MEDIA_NAMES = new Set(["红包", "转账", "照片", "位置", "表情包", "引用", "语音", "音乐"]);

function stripStateValues(text: string): string {
  const regex = /\[([^\[\]:：]+)[：:](\d+(?:\.\d+)?)\]/g;
  return text.replace(regex, (m, rawName: string) => {
    const name = rawName.trim();
    if (!name || /^\d+$/.test(name) || RICH_MEDIA_NAMES.has(name)) return m;
    return "";
  });
}

function stripBracketBlock(text: string, tag: string): string {
  const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`\\[${escaped}\\]([\\s\\S]*?)\\[\\/${escaped}\\]`, "g"), "");
}

function humanizeSegment(segment: string): string {
  const marker = segment.match(/^\[([^\][：:]{1,12})[：:]([\s\S]*?)\]$/);
  if (!marker) return segment;
  const kind = marker[1];
  if (/表情包/.test(kind)) return "[表情包]";
  if (/图片|照片|图片描述/.test(kind)) return `发了一张照片: ${marker[2].slice(0, 40)}`;
  if (/语音通话/.test(kind)) return "发起了语音通话";
  if (/视频通话/.test(kind)) return "发起了视频通话";
  if (/语音/.test(kind)) return "[语音]";
  if (/红包/.test(kind)) return "[红包]";
  if (/转账/.test(kind)) return "[转账]";
  if (/位置/.test(kind)) return "[位置]";
  if (/拍一拍|拍了拍/.test(kind)) return "拍了拍你";
  return segment;
}

function splitResponseForPushPreview(rawText: string): string[] {
  let text = stripStateValues(rawText);
  text = stripBracketBlock(text, "状态栏");
  text = stripBracketBlock(text, "内心");  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text
    .split(/\n\n+/)
    .map(segment => humanizeSegment(segment.trim()))
    .map(segment => segment.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * 生活现场输出走 JSON 协议（兼容旧 XML/纯文本）。
 * 通知和快捷回复都只认解析后的 action/dialogue，避免把原始 JSON 推给用户。
 */
function parseLifeSceneOutput(rawText: string): { action: string; dialogues: string[] } {
  const text = String(rawText ?? "").replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const action = typeof value.action === "string" ? value.action.trim() : "";
      const rawDialogue = value.dialogue;
      const dialogues = (Array.isArray(rawDialogue) ? rawDialogue : typeof rawDialogue === "string" ? [rawDialogue] : [])
        .map(item => String(item ?? "").trim())
        .filter(Boolean);
      return { action, dialogues };
    } catch { /* fall through to legacy formats */ }
  }
  const action = text.match(/<life_action\b[^>]*>([\s\S]*?)<\/life_action\s*>/i)?.[1]?.trim() ?? "";
  const dialogue = text.match(/<life_dialogue\b[^>]*>([\s\S]*?)<\/life_dialogue\s*>/i)?.[1]?.trim() ?? "";
  const fallback = text.replace(/<[^>]+>/g, "").trim();
  return { action, dialogues: dialogue ? [dialogue] : fallback ? [fallback] : [] };
}

// ── 内嵌：lib/server/push-job-crypto 的解密（Web Crypto 实现，格式兼容） ──
function appendLifeScheduleContext(body: Record<string, unknown>, providerKind: ProviderKind, context: string): void {
  const appendToMessage = (message: Record<string, unknown>) => {
    const content = message.content;
    if (typeof content === "string") {
      message.content = content + "\n\n" + context;
    } else if (Array.isArray(content)) {
      content.push(providerKind === "gemini" ? { text: context } : { type: "text", text: context });
    }
  };
  const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : null;
  if (messages) {
    const target = [...messages].reverse().find(message => message.role === "user");
    if (target) appendToMessage(target);
    return;
  }
  const contents = Array.isArray(body.contents) ? body.contents as Record<string, unknown>[] : null;
  if (contents) {
    const target = [...contents].reverse().find(message => message.role === "user");
    if (target && Array.isArray(target.parts)) {
      (target.parts as unknown[]).push({ text: context });
    }
  }
}

function isLifeSleepActivity(value: string): boolean {
  return /睡眠|睡觉|入睡|午休/.test(value);
}

type EncryptedPayload = { v: 1; iv: string; tag: string; ct: string };

function base64ToBytes(value: string): Uint8Array {
  const raw = atob(value);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function encryptPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  const ct = combined.slice(0, combined.length - 16);
  const tag = combined.slice(combined.length - 16);
  const toB64 = (bytes: Uint8Array) => {
    let raw = "";
    for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw);
  };
  return { v: 1, iv: toB64(iv), tag: toB64(tag), ct: toB64(ct) };
}

async function decryptPayload(payload: EncryptedPayload, serviceKey: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serviceKey}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const ct = base64ToBytes(payload.ct);
  const tag = base64ToBytes(payload.tag);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(payload.iv) as unknown as BufferSource },
    key,
    combined as unknown as BufferSource,
  );
  return new TextDecoder().decode(plain);
}

// ── 主流程 ──
type JobRow = { id: string; user_id: string; trigger_key: string; kind: string; payload: EncryptedPayload };
type SubscriptionRow = { endpoint: string; p256dh: string; auth: string };
type JobPayload = {
  request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
  shortcut?: {
    commandId: string;
    actionName: string;
    resultMode: "none" | "text" | "image";
    resultMarker: string;
    imageMarker?: string;
    style: "text" | "native";
  };
  notify?: { title?: string; url?: string };
  /** 角色绑定的微信 bot：force 用于真实微信快捷动作结果续跑，保证第二轮仍回到微信。 */
  weixin?: { botId?: string; force?: boolean };
  /** 离线快捷动作的结果续跑快照：客户端预挂，AI 调用需回传的动作时武装 shortcut_resume */
  shortcutContinuation?: {
    request: { url: string; headers: Record<string, string>; body: Record<string, unknown>; providerKind: ProviderKind };
    replyMarker: string;
    resultMarker: string;
    imageMarker?: string;
    /** 角色 API 的图像识别开关（客户端挂快照时写入）；缺省视为开，兼容老快照 */
    visionEnabled?: boolean;
  };
  merge?: Record<string, unknown> & { sessionId?: string };
};

type ShortcutCommandRow = {
  id: string;
  status: "pending" | "claimed" | "succeeded" | "failed" | "expired" | "cancelled";
  action_name: string;
  result_mode: "none" | "text" | "image";
  result: Record<string, unknown> | null;
  error: string | null;
  expires_at: string;
};

// 【快捷动作：名称】与带参数的【快捷动作：名称({...})】都要认。参数允许换行
// （模型爱把 JSON 展开写），所以参数段用 [\s\S] 而不是 [^\n]。
/** 识图关着时代替截图进上下文的说明：不留这句话，模型面对的是空白，
 *  既不知道图回没回来，也不知道自己为什么看不见。 */
const SHORTCUT_VISION_OFF_NOTE = "（系统记录：未配置或未启用图像识别，本轮回传的图片没有交给你；请结合上一条的文字内容回应。）";

const SHORTCUT_MARKER_RE = /【快捷动作[：:]\s*([^(（）)】\n]{1,60}?)\s*(?:[(（]([\s\S]{0,2000}?)[)）])?\s*】/;
const SHORTCUT_MARKER_STRIP_RE = new RegExp(SHORTCUT_MARKER_RE.source, "g");

/** 标记括号里的 JSON 参数。写坏了就当没带参数——宁可少传，也不要整条动作失败。 */
function parseShortcutMarkerArgs(raw: string | undefined): Record<string, unknown> {
  const text = (raw ?? "").trim();
  if (!text) return {};
  // 模型爱用全角标点（中文引号/冒号/逗号），原文解析失败就按归一化后的再试一次
  const candidates = [text, text.replace(/[\u201c\u201d\u201e\u201f]/g, '"').replace(/\uff1a/g, ":").replace(/\uff0c/g, ",")];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try next */ }
  }
  console.warn(`[push-generate] 快捷动作参数解析失败 raw=${text.slice(0, 200)}`);
  return {};
}

function shortcutResultText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const text = record.text ?? record.message ?? record.value;
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  try { return JSON.stringify(value ?? {}); } catch { return String(value ?? ""); }
}

function formatShortcutResult(command: ShortcutCommandRow, style: "text" | "native"): string {
  const actionName = String(command.action_name || "快捷动作").replace(/"/g, "&quot;");
  const success = command.status === "succeeded";
  const detail = success
    ? shortcutResultText(command.result) || "快捷指令已执行成功。"
    : command.error || (command.status === "expired" ? "等待手机执行超时。" : `命令状态：${command.status}`);
  if (style === "native") {
    return [
      `<action_result name="${actionName}" success="${success ? "true" : "false"}">`,
      detail,
      "</action_result>",
      "工具结果已经返回给你，不要重复你之前已经说过的内容，不要再次执行相同的动作。",
    ].join("\n");
  }
  const resultTag = success
    ? `<action_result name="${actionName}">${detail}</action_result>`
    : `<action_result name="${actionName}" error="${detail.replace(/"/g, "&quot;")}"></action_result>`;
  return `以下是系统处理结果：\n${resultTag}\n请基于以上结果，继续以角色身份回复用户。不要重复你之前已经说过的内容，不要再次执行相同的动作。`;
}

function replaceMarker(value: unknown, marker: string, replacement: string): boolean {
  if (!value || typeof value !== "object") return false;
  let replaced = false;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === marker) {
        value[index] = replacement;
        replaced = true;
      } else if (replaceMarker(value[index], marker, replacement)) {
        replaced = true;
      }
    }
    return replaced;
  }
  const record = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(record)) {
    if (item === marker) {
      record[key] = replacement;
      replaced = true;
    } else if (replaceMarker(item, marker, replacement)) {
      replaced = true;
    }
  }
  return replaced;
}

function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    raw += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(raw);
}

/** 与网关 encryptPayload 同格式：武装续跑任务时给快照加密落库。 */
async function encryptJobPayload(plain: string, secret: string): Promise<EncryptedPayload> {
  const keyBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:push-job-v1`));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const combined = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    new TextEncoder().encode(plain) as unknown as BufferSource,
  ));
  return {
    v: 1,
    iv: bytesToBase64(iv),
    tag: bytesToBase64(combined.slice(combined.length - 16)),
    ct: bytesToBase64(combined.slice(0, combined.length - 16)),
  };
}

function injectShortcutImage(
  body: Record<string, unknown>,
  providerKind: ProviderKind,
  marker: string,
  image: { mimeType: string; base64: string } | null,
): void {
  const text = image ? "系统记录：这是快捷指令刚刚回传的截图。" : "系统记录：快捷指令截图读取失败。";
  if (providerKind === "anthropic") {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const content = (message as { content?: unknown[] }).content;
      if (!Array.isArray(content)) continue;
      const index = content.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      content.splice(index, 1,
        { type: "text", text },
        ...(image ? [{ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else if (providerKind === "gemini") {
    for (const message of Array.isArray(body.contents) ? body.contents : []) {
      const parts = (message as { parts?: unknown[] }).parts;
      if (!Array.isArray(parts)) continue;
      const index = parts.findIndex(part => (part as { text?: unknown })?.text === marker);
      if (index < 0) continue;
      parts.splice(index, 1,
        { text },
        ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.base64 } }] : []),
      );
      return;
    }
  } else {
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const record = message as { content?: unknown };
      if (record.content !== marker) continue;
      record.content = image ? [
        { type: "text", text },
        { type: "image_url", image_url: { url: `data:${image.mimeType};base64,${image.base64}`, detail: "low" } },
      ] : text;
      return;
    }
  }
  replaceMarker(body, marker, text);
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const DAILY_GENERATION_CAP = 50;

Deno.serve(async (req: Request) => {
  const supabaseUrl = (Deno.env.get("SUPABASE_URL") || "").replace(/\/$/, "");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) return new Response("missing env", { status: 200 });

  const { jobId, token } = await req.json().catch(() => ({})) as { jobId?: string; token?: string };
  if (!jobId || !token) return new Response("bad request", { status: 400 });

  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" };
  const rest = (path: string, init?: RequestInit) => fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { ...restHeaders, ...(init?.headers ?? {}) },
  });

  const secretResponse = await rest("push_server_config?id=eq.main&select=cron_secret,payload_key,site_origin&limit=1");
  const secretRows = secretResponse.ok ? await secretResponse.json() as { cron_secret?: string | null; payload_key?: string | null; site_origin?: string | null }[] : [];
  const cronSecret = secretRows[0]?.cron_secret || "";
  const payloadKey = secretRows[0]?.payload_key || "";
  const siteOrigin = secretRows[0]?.site_origin || "";
  if (!cronSecret || String(token) !== cronSecret) {
    return new Response("forbidden", { status: 403 });
  }

  const claim = await rest(`push_jobs?id=eq.${encodeURIComponent(jobId)}&status=eq.pending&kind=neq.bridge_scan`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ status: "running", updated_at: new Date().toISOString() }),
  });
  const claimed = claim.ok ? await claim.json() as JobRow[] : [];
  const job = claimed[0];
  if (!job) return new Response("already claimed", { status: 200 });

  let isLifeSceneJob = false;
  const finish = async (status: "done" | "failed", note: string) => {
    await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status, result_note: note.slice(0, 300), updated_at: new Date().toISOString() }),
    }).catch(() => undefined);
    if (isLifeSceneJob) {
      await rest("life_schedule_diagnostic_events", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          id: `life-trace-${crypto.randomUUID()}`, trace_id: job.id, user_id: job.user_id,
          stage: "任务最终结果", severity: status === "failed" ? "error" : "info",
          code: status === "failed" ? "life_job_final_failed" : "life_job_final_done",
          detail: note.slice(0, 500), job_id: job.id,
        }]),
      }).catch(() => undefined);
    }
  };

  const deferUntil = (executeAtMs: number, note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "pending",
      execute_at: new Date(executeAtMs).toISOString(),
      result_note: note.slice(0, 300),
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => null);

  /**
   * 这一单是否已被客户端撤销。
   *
   * 用户关掉/删掉主动消息时，站点接口会把该规则相关的任务改成 cancelled（pending
   * 的直接删除）。但本函数往往已经把它领取成 running 并在跑 LLM——那时它自己这份
   * 快照不受影响。不查一次的话，规则删了它照样生成、照样弹通知，还会继续续排下一发，
   * 用户看到的就是「根本没关上」。
   * 查不到（网络抖动等）按「未被撤销」处理，宁可多发一次也不误杀正常消息。
   */
  let isLifeSceneJob = false;
  const isCancelled = async (): Promise<boolean> => {
    const response = await rest(
      `push_jobs?id=eq.${encodeURIComponent(job.id)}&select=status&limit=1`,
    ).catch(() => null);
    if (!response || !response.ok) return false;
    const rows = await response.json().catch(() => []) as { status?: string }[];
    // A deleted life-scene row means the scene/participant was removed. Do not let
    // an already-running model call send a stale action after the user cancelled it.
    if (!rows.length) return isLifeSceneJob;
    return rows[0]?.status === "cancelled";
  };

  // 分段进度：卡死时 result_note 会停在最后完成的一步，精确定位死点
  const startedAt = Date.now();
  const progress = (note: string) => rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ result_note: `[${Math.round((Date.now() - startedAt) / 1000)}s] ${note}`.slice(0, 300), updated_at: new Date().toISOString() }),
  }).catch(() => undefined);

  // pg_net 的请求超时只有几秒：必须立即响应，重活放进 waitUntil 后台继续。
  const runJob = async (): Promise<void> => {
  try {
    if (!payloadKey) {
      await finish("failed", "payload_key missing (open push settings once to bootstrap)");
      return;
    }
    const payload = JSON.parse(await decryptPayload(job.payload, payloadKey)) as JobPayload;
    isLifeSceneJob = Boolean(payload.merge?.lifeScene);
    // 生活主动消息必须通过最新可用快照验证；缺失、损坏或位置不一致一律 fail closed。
    const lifeSceneMeta = payload.merge?.lifeScene as { sceneId?: string; characterId?: string; traceId?: string } | undefined;
    let lifeScheduleVersionAtStart: string | null = null;
    let lifeRuntimeStateVersionAtStart: number | null = null;
    let lifePlayerLocationAtStart: string | null = null;
    let lifeCharacterLocationAtStart: string | null = null;
    let lifePlayerActivityAtStart = "";
    let lifeCharacterActivityAtStart = "";
    const writeLifeDiagnostic = async (code: string, detail: string, repairHint: string) => {
      const diagnosticId = code === "life_schedule_snapshot_stale" || code === "life_schedule_runtime_unavailable" || code === "life_schedule_runtime_changed_during_generation" || code === "life_schedule_snapshot_missing"
        ? `life-scheduler:${job.user_id}:stale`
        : `life-scheduler:${job.user_id}:${code}`;
      const existingResponse = await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(diagnosticId)}&select=id,resolved_at&limit=1`);
      const existingRows = existingResponse.ok ? await existingResponse.json() as Array<{ resolved_at?: string | null }> : [];
      const shouldNotify = !existingRows[0] || Boolean(existingRows[0].resolved_at);
      await rest("life_schedule_diagnostics?on_conflict=id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify([{
          id: diagnosticId, user_id: job.user_id, severity: "error", code,
          detail: detail.slice(0, 500), repair_hint: repairHint.slice(0, 500),
          updated_at: new Date().toISOString(), resolved_at: null,
        }]),
      });
      await rest("life_schedule_diagnostic_events", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          id: `life-trace-${crypto.randomUUID()}`, trace_id: lifeSceneMeta?.traceId || job.id,
          user_id: job.user_id, stage: "业务链路异常", severity: "error", code,
          detail: detail.slice(0, 500), actor_id: lifeSceneMeta?.characterId || null,
          session_id: typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : null,
          job_id: job.id,
        }]),
      }).catch(() => undefined);
      if (!shouldNotify) return;
      const subscriptionsResponse = await rest(`push_subscriptions?user_id=eq.${encodeURIComponent(job.user_id)}&select=endpoint,p256dh,auth&limit=50`);
      const subscriptions = subscriptionsResponse.ok
        ? await subscriptionsResponse.json() as SubscriptionRow[]
        : [];
      const topics = subscriptions.filter(item => item.endpoint.startsWith("shell:"))
        .map(item => item.endpoint.slice("shell:".length).trim()).filter(Boolean)
        .map(owner => `shellpush:${owner}`);
      const notificationBody = (code + "：" + detail + "；修复：" + repairHint).slice(0, 180);
      if (topics.length) {
        await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
          method: "POST", headers: restHeaders,
          body: JSON.stringify({ messages: topics.map(topic => ({
            topic, event: "notify",
            payload: { title: "生活系统 · 云端诊断", body: notificationBody, url: "/life", kind: "life_diagnostic" },
          })) }),
        }).catch(() => undefined);
      }
      const webSubscriptions = subscriptions.filter(item => !item.endpoint.startsWith("shell:"));
      if (webSubscriptions.length) {
        const configResponse = await rest("push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key,site_origin&limit=1");
        const configRows = configResponse.ok ? await configResponse.json() as Array<{
          vapid_public_key?: string; vapid_private_key?: string; site_origin?: string;
        }> : [];
        const config = configRows[0];
        if (config?.vapid_public_key && config.vapid_private_key) {
          for (const subscription of webSubscriptions) {
            try {
              const status = await sendWebPushRaw(subscription, JSON.stringify({
                title: "生活系统 · 云端诊断", body: notificationBody, url: "/life", kind: "life_diagnostic",
              }), {
                publicKey: config.vapid_public_key,
                privateKey: config.vapid_private_key,
                subject: config.site_origin || "mailto:admin@localhost",
              });
              if (status === 404 || status === 410) {
                await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(subscription.endpoint)}`, { method: "DELETE" });
              }
            } catch { /* cloud diagnostic remains visible in the app */ }
          }
        }
      }
    };
    const writeLifeTraceEvent = async (
      stage: string, code: string, detail: string, severity: "info" | "warning" | "error" = "info",
    ) => {
      if (!isLifeSceneJob) return;
      await rest("life_schedule_diagnostic_events", {
        method: "POST", headers: { Prefer: "return=minimal" },
        body: JSON.stringify([{
          id: `life-trace-${crypto.randomUUID()}`,
          trace_id: lifeSceneMeta?.traceId || job.id,
          user_id: job.user_id, stage, severity, code, detail: detail.slice(0, 500),
          actor_id: lifeSceneMeta?.characterId || null,
          session_id: typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : null,
          job_id: job.id,
        }]),
      }).catch(() => undefined);
    };
    await writeLifeTraceEvent("生成任务启动", "life_generation_started", "云端生成器已领取生活任务，开始验证最新快照和角色运行态。");

    if (payload.merge?.lifeScene) {
      if (!lifeSceneMeta?.sceneId || !lifeSceneMeta.characterId) {
        await finish("done", "life schedule: incomplete scene metadata; rejected safely");
        return;
      }
      const snapResponse = await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(job.user_id)}`
        + `&rule_id=eq.life-schedule&select=payload,updated_at&limit=1`,
      );
      if (!snapResponse.ok) {
        await finish("done", "life schedule: snapshot lookup failed; rejected safely");
        return;
      }
      const snapRows = await snapResponse.json() as { payload?: EncryptedPayload; updated_at?: string }[];
      if (!snapRows[0]?.payload) {
        await finish("done", "life schedule: snapshot missing; rejected safely");
        return;
      }
      try {
        const snapshot = JSON.parse(await decryptPayload(snapRows[0].payload, payloadKey)) as {
          updatedAt?: string;
          scheduleVersion?: string;
          enabled?: boolean;
          autonomyEnabled?: boolean;
          proactiveEnabled?: boolean;
          playerLocationId?: string;
          foregroundSceneId?: string;
          foregroundLeaseUntil?: string;
          scenes?: { id?: string; locationId?: string; characterIds?: string[] }[];
          characterLocations?: Record<string, string>;
          scheduleSlots?: { ownerType?: string; ownerId?: string; startAt?: string; endAt?: string; title?: string; kind?: string; source?: string; plannedLocationName?: string }[];
          actorStates?: { ownerType?: string; ownerId?: string; activity?: string; currentLocationName?: string }[];
          onlineChatCharacterId?: string;
          onlineChatSessionId?: string;
          onlineChatLeaseUntil?: string;
        };
        const now = Date.now();
        lifeScheduleVersionAtStart = snapshot.scheduleVersion || null;
        const snapshotAt = Date.parse(snapRows[0].updated_at || snapshot.updatedAt || "");
        if (!Number.isFinite(snapshotAt) || now - snapshotAt > 3 * 60_000) {
          await writeLifeDiagnostic(
            "life_schedule_snapshot_stale",
            "云端日程快照超过 3 分钟未更新，已暂停主动生成，避免角色依据过期地点行动。",
            "检查 Supabase life-scheduler Cron 是否启用、life_schedule_runtime 表是否可读；恢复后任务会自动续跑。",
          ).catch(() => undefined);
          const deferAt = now + 60_000;
          const deferred = await deferUntil(deferAt, "life schedule: cloud schedule state is stale; waiting for the next server evaluation");
          if (!deferred?.ok) await finish("done", "life schedule: stale cloud state; defer failed safely");
          return;
        }
        // Read the per-character authoritative runtime row immediately before generation.
        // Only apply it when it was computed from the same schedule version as the snapshot.
        const runtimeResponse = await rest(
          `life_schedule_runtime?user_id=eq.${encodeURIComponent(job.user_id)}`
          + `&scene_id=eq.${encodeURIComponent(lifeSceneMeta.sceneId)}`
          + `&character_id=eq.${encodeURIComponent(lifeSceneMeta.characterId)}`
          + "&select=schedule_version,state_version,activity,location_id,location_name,player_activity,player_location_id,player_location_name,updated_at&limit=1",
        ).catch(() => null);
        const runtimeRows = runtimeResponse?.ok
          ? await runtimeResponse.json().catch(() => []) as Array<{
            schedule_version?: string; state_version?: number; activity?: string; location_id?: string;
            location_name?: string; player_activity?: string; player_location_id?: string;
            player_location_name?: string; updated_at?: string;
          }>
          : [];
        const runtime = runtimeRows[0];
        const runtimeAt = Date.parse(runtime?.updated_at || "");
        const runtimeReady = Boolean(runtime
          && runtime.schedule_version === snapshot.scheduleVersion
          && Number.isFinite(Number(runtime.state_version))
          && Number.isFinite(runtimeAt) && now - runtimeAt <= 2 * 60_000
          && runtime.location_id && runtime.player_location_id);
        if (!runtimeReady || !runtime) {
          await writeLifeDiagnostic(
            "life_schedule_runtime_unavailable",
            "角色最新云端运行态不存在、版本不匹配或超过 2 分钟未更新，已阻止使用旧快照生成主动消息。",
            "等待 life-scheduler 下一分钟完成运行态计算；若持续发生，检查 life_schedule_runtime 表、Cron 和 life-scheduler 日志。",
          ).catch(() => undefined);
          const deferred = await deferUntil(now + 60_000, "life schedule: authoritative runtime unavailable; waiting for cloud evaluation");
          if (!deferred?.ok) await finish("done", "life schedule: runtime unavailable; defer failed safely");
          return;
        }
        lifeRuntimeStateVersionAtStart = Number(runtime.state_version);
        await writeLifeTraceEvent("运行态校验通过", "life_runtime_validated", "角色运行态版本、日程版本、更新时间和当前位置均通过校验。");
        snapshot.playerLocationId = runtime.player_location_id || snapshot.playerLocationId;
        snapshot.characterLocations = {
          ...(snapshot.characterLocations || {}),
          [lifeSceneMeta.characterId]: runtime.location_id || "",
        };
        snapshot.actorStates = (snapshot.actorStates || []).map(item => {
          if (item.ownerType === "player" && item.ownerId === "player") {
            return { ...item, activity: runtime.player_activity || item.activity, currentLocationName: runtime.player_location_name || item.currentLocationName };
          }
          if (item.ownerType === "character" && item.ownerId === lifeSceneMeta.characterId) {
            return { ...item, activity: runtime.activity || item.activity, currentLocationName: runtime.location_name || item.currentLocationName };
          }
          return item;
        });
        if (snapshot.enabled === false || snapshot.autonomyEnabled === false || snapshot.proactiveEnabled === false) {
          await finish("done", "life schedule: autonomous life actions disabled by latest cloud settings");
          return;
        }
        await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent("life-scheduler:" + job.user_id + ":stale")}`, {
          method: "PATCH",
          body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
        lifePlayerLocationAtStart = snapshot.playerLocationId || null;
        lifeCharacterLocationAtStart = snapshot.characterLocations?.[lifeSceneMeta.characterId] || null;
        lifePlayerActivityAtStart = snapshot.actorStates?.find(item => item.ownerType === "player" && item.ownerId === "player")?.activity || "";
        lifeCharacterActivityAtStart = snapshot.actorStates?.find(item => item.ownerType === "character" && item.ownerId === lifeSceneMeta.characterId)?.activity || "";
        const scene = (snapshot.scenes ?? []).find(item => item.id === lifeSceneMeta.sceneId);
        const characterLocation = snapshot.characterLocations?.[lifeSceneMeta.characterId];
        const hasPlayerLocation = typeof snapshot.playerLocationId === "string" && snapshot.playerLocationId.length > 0;
        const hasCharacterLocation = typeof characterLocation === "string" && characterLocation.length > 0;
        const isParticipant = scene?.characterIds?.includes(lifeSceneMeta.characterId) === true;
        const sameScene = Boolean(scene && hasPlayerLocation && hasCharacterLocation && isParticipant)
          && scene?.locationId === snapshot.playerLocationId
          && characterLocation === snapshot.playerLocationId;
        if (!sameScene) {
          await finish("done", "life schedule: player/character no longer share the exact scene location");
          return;
        }
        const slots = snapshot.scheduleSlots ?? [];
        const actors = snapshot.actorStates ?? [];
        const activeSlot = (ownerType: string, ownerId: string) => slots.find(slot => {
          if (slot.ownerType !== ownerType || slot.ownerId !== ownerId) return false;
          const start = Date.parse(slot.startAt || "");
          const end = Date.parse(slot.endAt || "");
          return Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end;
        });
        const actorIsSleeping = (ownerType: string, ownerId: string): boolean => {
          const slot = activeSlot(ownerType, ownerId);
          const actor = actors.find(item => item.ownerType === ownerType && item.ownerId === ownerId);
          return isLifeSleepActivity(slot?.title || actor?.activity || "");
        };
        const nextAwakeAt = (ownerType: string, ownerId: string): number => {
          const future = slots
            .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId
              && Number.isFinite(Date.parse(slot.startAt || ""))
              && Date.parse(slot.startAt || "") > now
              && !isLifeSleepActivity(slot.title || ""))
            .map(slot => Date.parse(slot.startAt || ""));
          const weekMs = 7 * 24 * 60 * 60_000;
          for (const slot of slots.filter(item => item.ownerType === ownerType && item.ownerId === ownerId
            && item.source === "weekly-generation" && !["special", "appointment"].includes(item.kind || "")
            && !isLifeSleepActivity(item.title || ""))) {
            const start = Date.parse(slot.startAt || ""), end = Date.parse(slot.endAt || "");
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
            const offset = Math.max(0, Math.floor((now - start) / weekMs));
            for (let week = offset; week <= offset + 2; week += 1) {
              const projected = start + week * weekMs;
              if (projected > now) future.push(projected);
            }
          }
          return future.length ? Math.min(...future) : now + 30 * 60_000;
        };
        const playerSleeping = actorIsSleeping("player", "player");
        const characterSleeping = actorIsSleeping("character", lifeSceneMeta.characterId);
        if (playerSleeping || characterSleeping) {
          // Keep the same durable job pending until both participants' next awake slot.
          // Do not spend a repeat turn or send a notification during sleep.
          const wakeTimes = [
            ...(playerSleeping ? [nextAwakeAt("player", "player")] : []),
            ...(characterSleeping ? [nextAwakeAt("character", lifeSceneMeta.characterId)] : []),
          ];
          const deferAt = Math.max(now + 60_000, ...wakeTimes);
          const deferred = await deferUntil(deferAt, "life schedule: sleep window; deferred until " + new Date(deferAt).toISOString());
          if (!deferred?.ok) await finish("done", "life schedule: sleep window; defer failed safely");
          return;
        }
        const onlineChatLeaseUntil = Date.parse(snapshot.onlineChatLeaseUntil || "");
        if (snapshot.onlineChatCharacterId === lifeSceneMeta.characterId
          && Number.isFinite(onlineChatLeaseUntil)
          && onlineChatLeaseUntil > now) {
          // User's active direct conversation wins over a proactive life dialogue.
          // The life event remains durable and is retried after the conversation lease.
          const deferAt = Math.max(now + 60_000, onlineChatLeaseUntil + 15_000);
          const deferred = await deferUntil(deferAt, "life schedule: direct chat is active; deferred until " + new Date(deferAt).toISOString());
          if (!deferred?.ok) await finish("done", "life schedule: direct chat active; defer failed safely");
          return;
        }

        const playerSlot = activeSlot("player", "player");
        const characterSlot = activeSlot("character", lifeSceneMeta.characterId);
        const playerActor = actors.find(item => item.ownerType === "player" && item.ownerId === "player");
        const characterActor = actors.find(item => item.ownerType === "character" && item.ownerId === lifeSceneMeta.characterId);
        const playerActivity = playerSlot?.title || playerActor?.activity || "";
        const characterActivity = characterSlot?.title || characterActor?.activity || "";
        const playerLocationName = playerSlot?.plannedLocationName || playerActor?.currentLocationName || "";
        const characterLocationName = characterSlot?.plannedLocationName || characterActor?.currentLocationName || "";
        const scheduleContext = [
          "【云端当前生活状态：本段为本轮生成前重新计算的权威状态，优先级高于旧聊天、旧预约提示和历史地点】",
          "玩家当前活动：" + (playerActivity || "没有明确日程") + (playerLocationName ? "；当前地点：" + playerLocationName : ""),
          "角色当前活动：" + (characterActivity || "自由活动") + (characterLocationName ? "；当前地点：" + characterLocationName : ""),
          "不要沿用旧地点或旧活动；行动必须符合当前活动、地点和睡眠状态。玩家专注时只做轻量陪伴，不替玩家决定行动。",
        ].join("\n");
        appendLifeScheduleContext(payload.request.body, payload.request.providerKind, scheduleContext);

        const foregroundLeaseUntil = Date.parse(snapshot.foregroundLeaseUntil || "");
        if (snapshot.foregroundSceneId === lifeSceneMeta.sceneId
          && Number.isFinite(foregroundLeaseUntil)
          && foregroundLeaseUntil > now) {
          // A visible life scene owns its local turn. Defer the durable background job;
          // it is not discarded, so it resumes if the app is hidden or terminated.
          const deferAt = Math.max(now + 60_000, foregroundLeaseUntil + 90_000);
          const deferred = await deferUntil(deferAt, "life schedule: foreground scene lease active; deferred until " + new Date(deferAt).toISOString());
          if (!deferred?.ok) await finish("done", "life schedule: foreground scene lease active; defer failed safely");
          return;
        }
      } catch {
        await finish("done", "life schedule: snapshot invalid; rejected safely");
        return;
      }
    }
    let shortcutStoragePath = "";

    if (job.kind === "shortcut_resume" && payload.shortcut) {
      const commandResponse = await rest(
        `push_shortcut_commands?id=eq.${encodeURIComponent(payload.shortcut.commandId)}`
        + `&user_id=eq.${encodeURIComponent(job.user_id)}`
        + "&select=id,status,action_name,result_mode,result,error,expires_at&limit=1",
      );
      const commandRows = commandResponse.ok ? await commandResponse.json() as ShortcutCommandRow[] : [];
      const command = commandRows[0];
      if (!command) {
        await finish("failed", "shortcut command missing");
        return;
      }

      if (command.status === "pending" || command.status === "claimed") {
        const expiresAt = Date.parse(command.expires_at);
        if (Number.isFinite(expiresAt) && expiresAt > Date.now()) {
          const retryAt = new Date(Math.min(expiresAt + 5_000, Date.now() + 15_000)).toISOString();
          await rest(`push_jobs?id=eq.${encodeURIComponent(job.id)}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: "pending",
              execute_at: retryAt,
              result_note: "waiting for shortcut result",
              updated_at: new Date().toISOString(),
            }),
          });
          return;
        }
        command.status = "expired";
        command.error = "等待手机执行超时。";
        await rest(`push_shortcut_commands?id=eq.${encodeURIComponent(command.id)}&status=in.(pending,claimed)`, {
          method: "PATCH",
          body: JSON.stringify({ status: "expired", error: command.error, updated_at: new Date().toISOString() }),
        }).catch(() => undefined);
      }

      const resultContent = formatShortcutResult(command, payload.shortcut.style);
      if (!replaceMarker(payload.request.body, payload.shortcut.resultMarker, resultContent)) {
        await finish("failed", "shortcut result marker missing");
        return;
      }

      if (payload.shortcut.imageMarker) {
        let image: { mimeType: string; base64: string } | null = null;
        const result = command.result && typeof command.result === "object" ? command.result : {};
        const rawPath = typeof result.storagePath === "string" ? result.storagePath : "";
        const expectedPrefix = `${job.user_id}/${command.id}.`;
        if (command.status === "succeeded" && rawPath.startsWith(expectedPrefix) && /\.(?:jpg|png|webp)$/.test(rawPath)) {
          const storagePath = rawPath.split("/").map(encodeURIComponent).join("/");
          const file = await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${storagePath}`, {
            headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
          });
          if (file.ok) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (bytes.length > 0 && bytes.length <= 8 * 1024 * 1024) {
              image = {
                mimeType: file.headers.get("content-type") || String(result.mimeType || "image/jpeg"),
                base64: bytesToBase64(bytes),
              };
              shortcutStoragePath = storagePath;
            }
          }
        }
        injectShortcutImage(payload.request.body, payload.request.providerKind, payload.shortcut.imageMarker, image);
      }
    }

    // 订阅有两个来源、两套 user_id：壳合成订阅由站点以自身账号 id 注册
    // （单机自部署下是 local_user），而任务一律挂在 OWNER_ID(owner) 下。
    // 按 job.user_id 过滤会把壳订阅整个漏掉，于是生成阶段就误判「没有订阅」
    // 直接放弃（result_note 记 no_subscription），用户永远等不到主动消息——
    // 连 LLM 都不会被调用。个人云只服务本项目唯一的主人，这里取全部订阅；
    // 是否为壳订阅由 endpoint 前缀在投递阶段分流（见下方 webSubs / shellTopics）。
    const subsResponse = await rest("push_subscriptions?select=endpoint,p256dh,auth");
    const subs = subsResponse.ok ? await subsResponse.json() as SubscriptionRow[] : [];
    if (subs.length === 0 && payload.weixin?.force !== true) {
      await finish("done", "no_subscription");
      return;
    }

    // 硬闸：每账号每天最多 50 条服务端兜底生成，超出只存任务记录不烧 token。
    // 只统计 push-generate 真正生成的回箱行，不让现实桥的纯存档行占用额度。
    const dayStart = `${new Date().toISOString().slice(0, 10)}T00:00:00Z`;
    const capResponse = await rest(
      `push_outbox?user_id=eq.${encodeURIComponent(job.user_id)}&created_at=gte.${encodeURIComponent(dayStart)}&meta->>pushGenerated=eq.true&select=id&limit=${DAILY_GENERATION_CAP + 1}`,
    );
    const todayRows = capResponse.ok ? await capResponse.json() as unknown[] : [];
    if (todayRows.length >= DAILY_GENERATION_CAP) {
      if (payload.merge?.lifeScene) {
        // Life autonomy is a durable schedule, not a disposable one-shot. Preserve
        // its current turn until the daily token budget resets instead of silently
        // terminating the background chain at the cap.
        const tomorrowUtc = new Date();
        tomorrowUtc.setUTCHours(24, 0, 30, 0);
        const deferred = await deferUntil(tomorrowUtc.getTime(), `life schedule: daily generation cap reached; retry after ${tomorrowUtc.toISOString()}`);
        if (!deferred?.ok) await finish("done", "life schedule: daily generation cap reached; retry deferral failed");
      } else {
        await finish("done", `daily cap (${DAILY_GENERATION_CAP}) reached`);
      }
      return;
    }

    // 动模型之前先确认这一单还没被用户撤销——生成一次要烧 token，
    // 撤了就不该再花这个成本，也不该再弹一条用户已经不要的通知。
    if (await isCancelled()) {
      await finish("done", "cancelled before generate");
      return;
    }

    await progress("llm request started");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000);
    let llmResponse: Response;
    try {
      llmResponse = await fetch(payload.request.url, {
        method: "POST",
        headers: payload.request.headers,
        body: JSON.stringify(payload.request.body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!llmResponse.ok) {
      const errorText = await llmResponse.text().catch(() => "");
      await finish("failed", `api ${llmResponse.status}: ${errorText.slice(0, 200)}`);
      return;
    }
    const data = await llmResponse.json();
    let rawText = extractResponseText(payload.request.providerKind, data).trim();
    if (!rawText) {
      await finish("failed", "empty response");
      return;
    }

    // A user can cancel a running job while the provider request is in flight.
    // Re-check after generation; otherwise the stale snapshot still writes an outbox
    // row and sends a push after the user has already started a newer turn.
    if (await isCancelled()) {
      // Keep the cancelled status intact for diagnostics; do not overwrite it with done.
      return;
    }

    // Revalidate after the provider call. A chat can open or the schedule/location can
    // change while the model is thinking; discard/defer rather than deliver stale context.
    if (isLifeSceneJob && lifeSceneMeta?.sceneId && lifeSceneMeta.characterId) {
      const latestResponse = await rest(
        `push_bridge_snapshots?user_id=eq.${encodeURIComponent(job.user_id)}&rule_id=eq.life-schedule&select=payload,updated_at&limit=1`,
      ).catch(() => null);
      const latestRows = latestResponse?.ok
        ? await latestResponse.json().catch(() => []) as Array<{ payload: EncryptedPayload; updated_at?: string }>
        : [];
      const latestRow = latestRows[0];
      if (!latestRow) {
        await writeLifeDiagnostic("life_schedule_snapshot_missing", "生成期间无法重新读取最新生活日程快照，已暂停发送。", "检查 push_bridge_snapshots 表、个人云 service-role 权限和 life-scheduler 部署。").catch(() => undefined);
        await deferUntil(Date.now() + 60_000, "life schedule: latest snapshot missing during generation");
        return;
      }
      const latestSnapshot = JSON.parse(await decryptPayload(latestRow.payload, payloadKey)) as {
        updatedAt?: string; scheduleVersion?: string; enabled?: boolean; autonomyEnabled?: boolean; proactiveEnabled?: boolean;
        playerLocationId?: string; characterLocations?: Record<string, string>;
        scenes?: Array<{ id?: string; status?: string; locationId?: string; characterIds?: string[] }>;
        onlineChatCharacterId?: string; onlineChatLeaseUntil?: string;
        foregroundSceneId?: string; foregroundLeaseUntil?: string;
        actorStates?: Array<{ ownerType?: string; ownerId?: string; activity?: string }>;
      };
      const latestNow = Date.now();
      const latestAt = Date.parse(latestRow.updated_at || latestSnapshot.updatedAt || "");
      if (!Number.isFinite(latestAt) || latestNow - latestAt > 3 * 60_000) {
        await writeLifeDiagnostic("life_schedule_snapshot_stale", "生成期间发现生活日程快照已过期，已暂停发送。", "检查 life-scheduler Cron 和 life_schedule_runtime；恢复后任务会自动续跑。").catch(() => undefined);
        await deferUntil(latestNow + 60_000, "life schedule: latest snapshot stale during generation");
        return;
      }
      if (latestSnapshot.enabled === false || latestSnapshot.autonomyEnabled === false || latestSnapshot.proactiveEnabled === false) {
        await finish("done", "life schedule: autonomy disabled while generation was running");
        return;
      }
      const latestScene = (latestSnapshot.scenes || []).find(item => item.id === lifeSceneMeta.sceneId);
      const latestCharacterLocation = latestSnapshot.characterLocations?.[lifeSceneMeta.characterId] || "";
      if (!latestScene || latestScene.status !== "active"
        || !latestScene.characterIds?.includes(lifeSceneMeta.characterId)
        || !latestSnapshot.playerLocationId
        || latestScene.locationId !== latestSnapshot.playerLocationId
        || latestCharacterLocation !== latestSnapshot.playerLocationId) {
        await finish("done", "life schedule: scene or co-location changed during generation; stale turn discarded");
        return;
      }
      if (lifeScheduleVersionAtStart && latestSnapshot.scheduleVersion !== lifeScheduleVersionAtStart) {
        await deferUntil(latestNow + 60_000, "life schedule: schedule changed during generation; retry with latest state");
        return;
      }
      const latestPlayerActivity = latestSnapshot.actorStates?.find(item => item.ownerType === "player" && item.ownerId === "player")?.activity || "";
      const latestCharacterActivity = latestSnapshot.actorStates?.find(item => item.ownerType === "character" && item.ownerId === lifeSceneMeta.characterId)?.activity || "";
      if ((lifePlayerLocationAtStart && latestSnapshot.playerLocationId !== lifePlayerLocationAtStart)
        || (lifeCharacterLocationAtStart && latestCharacterLocation !== lifeCharacterLocationAtStart)
        || latestPlayerActivity !== lifePlayerActivityAtStart
        || latestCharacterActivity !== lifeCharacterActivityAtStart) {
        await deferUntil(latestNow + 60_000, "life schedule: actor activity/location changed during generation; retry with latest state");
        return;
      }
      const chatLeaseUntil = Date.parse(latestSnapshot.onlineChatLeaseUntil || "");
      if (latestSnapshot.onlineChatCharacterId === lifeSceneMeta.characterId && Number.isFinite(chatLeaseUntil) && chatLeaseUntil > latestNow) {
        await deferUntil(chatLeaseUntil + 15_000, "life schedule: direct chat opened during generation; defer life action");
        return;
      }
      const foregroundLeaseUntil = Date.parse(latestSnapshot.foregroundLeaseUntil || "");
      if (latestSnapshot.foregroundSceneId === lifeSceneMeta.sceneId && Number.isFinite(foregroundLeaseUntil) && foregroundLeaseUntil > latestNow) {
        await deferUntil(foregroundLeaseUntil + 15_000, "life schedule: foreground scene active during generation; defer background action");
        return;
      }
      if (lifeRuntimeStateVersionAtStart !== null) {
        const latestRuntimeResponse = await rest(
          `life_schedule_runtime?user_id=eq.${encodeURIComponent(job.user_id)}&scene_id=eq.${encodeURIComponent(lifeSceneMeta.sceneId)}&character_id=eq.${encodeURIComponent(lifeSceneMeta.characterId)}&select=schedule_version,state_version,updated_at&limit=1`,
        ).catch(() => null);
        const latestRuntimeRows = latestRuntimeResponse?.ok
          ? await latestRuntimeResponse.json().catch(() => []) as Array<{ schedule_version?: string; state_version?: number; updated_at?: string }>
          : [];
        const latestRuntime = latestRuntimeRows[0];
        const latestRuntimeAt = Date.parse(latestRuntime?.updated_at || "");
        if (!latestRuntime || !latestRuntimeResponse?.ok
          || latestRuntime.schedule_version !== latestSnapshot.scheduleVersion
          || !Number.isFinite(latestRuntimeAt) || latestNow - latestRuntimeAt > 2 * 60_000
          || Number(latestRuntime.state_version) !== lifeRuntimeStateVersionAtStart) {
          await writeLifeDiagnostic(
            "life_schedule_runtime_changed_during_generation",
            "生成期间无法确认角色最新云端运行态，或活动/地点版本已变化；本次生成结果已丢弃。",
            "等待下一轮 life-scheduler 更新运行态后自动重试；若持续发生，检查 Cron 和 life_schedule_runtime 表权限。",
          ).catch(() => undefined);
          await deferUntil(latestNow + 60_000, "life schedule: latest authoritative runtime changed or unavailable during generation");
          return;
        }
      }
    }

    // ── 离线来电：复用小手机既有的通话协议，并兼容已经预约的旧任务 ──
    // 仅在回复开头 200 字内识别严格的「我（向某人）发起了语音通话」标签，
    // 普通叙述中的“某人发起了通话”不会误触发。标签从正文剥离，不进聊天记录。
    const callMarkers = [
      /\[我向[^\]\r\n]{1,80}发起了语音通话\]/,
      /【我向[^】\r\n]{1,80}发起了语音通话】/,
      /\[我发起了语音通话\]/,
      /【我发起了语音通话】/,
      /【拨打电话】/,
    ];
    let deliverAsCall = false;
    {
      const head = rawText.slice(0, 200);
      const matched = callMarkers
        .map(pattern => {
          const match = pattern.exec(head);
          return match ? { marker: match[0], index: match.index } : null;
        })
        .filter((item): item is { marker: string; index: number } => item !== null)
        .sort((a, b) => a.index - b.index)[0];
      if (matched) {
        deliverAsCall = true;
        rawText = (rawText.slice(0, matched.index) + rawText.slice(matched.index + matched.marker.length)).trim();
        if (!rawText) rawText = "……";
      }
    }
    // A life-scene turn must remain a scene interaction, never turn into an online-chat call.
    if (payload.merge?.lifeScene) deliverAsCall = false;

    // ── 离线快捷动作：AI 输出【快捷动作：名称】则经本项目网关创建命令并推送运行通知 ──
    // 动作目录在 push_bridge_config.shortcut_actions（个人云由客户端同步；
    // 老库/站点库无此列时查询失败即视为无目录，不执行）。标记一律从正文剥离。
    let shortcutActionNote = "";
    // 实际执行过的快捷动作标记（原文+在剥离后正文中的位置）：随 outbox 带回
    // 小手机，在原始位置落一对 tool_call/tool_notice——上下文里是标记原文，
    // 角色下一轮才知道自己传过什么参数（否则「换一首歌」会换出同一首）
    let executedShortcutMarker: { text: string; insertAt: number; name: string } | null = null;
    let deferredShortcutCommandId = "";
    let deferredShortcutActionName = "";
    type DeferredShortcutEmail = {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    };
    let deferredShortcutEmail: DeferredShortcutEmail | null = null;
    // 送达失败要让用户看得见：shortcutActionNote 只进任务日志（result_note），
    // 而角色已经说了"我去看一眼"。把失败摘要挂进 outbox meta 带回客户端，
    // 由客户端写进现实桥动态。成功则保持空串，不打扰。
    let shortcutDeliveryError = "";
    const noteShortcutDelivery = (actionName: string, note: string): string => {
      // 按「成功」反向判断，别去枚举失败关键词——投递路径的文案有中有英，
      // 加一句新的失败文案就会从关键词表里漏出去，静默丢掉本该给用户的提示。
      // 这里只在真正投递出去时收到含 delivered 的 note。
      if (!/delivered/.test(note)) {
        shortcutDeliveryError = `快捷动作「${actionName}」未能送达：${note.replace(/^, /, "")}`.slice(0, 300);
      }
      return note;
    };
    /**
     * 邮件模式的触发信请站点代发。个人云自己发不了信——RESEND_API_KEY 和
     * REALITY_BRIDGE_EMAIL_FROM 是站点的环境变量，用户的 Supabase 边缘函数里
     * 没有也不该有。命令行、结果回传、续跑快照全部留在本项目，站点只发那封信。
     * 失败一律只回一句 note：邮件没发出去不该让整个生成任务失败。
     */
    const deliverShortcutEmailViaSite = async (input: {
      userId: string;
      commandId: string;
      resultUrl: string;
      actionId: string;
      actionName: string;
      args: Record<string, unknown>;
    }): Promise<string> => {
      if (!siteOrigin) return ", shortcut email skipped: site origin unknown";
      if (!input.commandId || !input.resultUrl) return ", shortcut email skipped: command incomplete";
      try {
        const tokenResponse = await rest(
          `push_bridge_config?user_id=eq.${encodeURIComponent(input.userId)}&select=site_bridge_token&limit=1`,
        );
        const tokenRows = tokenResponse.ok
          ? await tokenResponse.json() as { site_bridge_token?: string | null }[]
          : [];
        const siteBridgeToken = String(tokenRows[0]?.site_bridge_token || "");
        // 令牌没同步上来，绝大多数是个人云还没跑过新版 schema（site_bridge_token
        // 是后加的列）。这句会经 outbox meta 显示给用户，所以要写成可操作的。
        if (!siteBridgeToken) {
          return ", 站点代发未启用：请到「设置 → 云服务部署」重新部署个人云";
        }

        const response = await fetch(`${siteOrigin}/api/push/shortcut-commands/deliver-email`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            token: siteBridgeToken,
            actionId: input.actionId,
            actionName: input.actionName,
            commandId: input.commandId,
            resultUrl: input.resultUrl,
            arguments: input.args,
          }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
        return response.ok && data.ok === true
          ? ", shortcut email delivered by site"
          : `, shortcut email failed: ${String(data.error || response.status).slice(0, 80)}`;
      } catch (error) {
        return `, shortcut email failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`;
      }
    };
    /**
     * 快捷动作投递失败时单独落一条诊断行，而不是往角色那条消息的 meta 上补写。
     *
     * 补写会输给一个竞态：消息行落库并推送之后，用户点开通知，客户端可能在服务端
     * PATCH 之前就把那行读走并 ACK 掉——恰好在"投递失败 + 用户立刻点通知"这种
     * 情况下丢掉错误。诊断行是在投递之后才创建的，不存在赶不上的问题。
     *
     * trigger_key 必须留空：客户端按 trigger_key 去重，跟消息行同键会被当成重复
     * 直接消费掉，根本走不到写动态那段。raw_text 只是占位（列是 NOT NULL），
     * 客户端认 meta.kind 后就短路了，不会生成聊天消息。
     */
    const writeShortcutDeliveryDiagnostic = async () => {
      if (!shortcutDeliveryError) return;
      await rest("push_outbox", {
        method: "POST",
        body: JSON.stringify([{
          id: `out_${crypto.randomUUID()}`,
          user_id: job.user_id,
          job_id: job.id,
          session_id: payload.merge?.sessionId ?? null,
          trigger_key: null,
          raw_text: shortcutDeliveryError,
          meta: { kind: "shortcut_delivery_error", shortcutDeliveryError },
        }]),
      }).catch(() => undefined);
    };

    const deliverDeferredShortcut = async () => {
      // 邮件命令绝不能落到下面的 shortcut-deliver：本网关只发 Web Push，
      // 邮件模式在那边是 409。这里改请站点代发。
      if (deferredShortcutEmail) {
        const pending = deferredShortcutEmail;
        deferredShortcutEmail = null;
        shortcutActionNote += noteShortcutDelivery(pending.actionName, await deliverShortcutEmailViaSite(pending));
        await progress(shortcutActionNote);
        return;
      }
      if (!deferredShortcutCommandId) return;
      const commandId = deferredShortcutCommandId;
      const actionName = deferredShortcutActionName || "快捷动作";
      deferredShortcutCommandId = "";
      deferredShortcutActionName = "";
      try {
        const response = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-deliver`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-ai-phone-service-key": serviceKey,
            "x-ai-phone-origin": siteOrigin,
          },
          body: JSON.stringify({ commandId }),
        });
        const data = await response.json().catch(() => ({})) as { ok?: boolean; delivered?: boolean; error?: string };
        const delivered = response.ok && data.ok === true && data.delivered === true;
        shortcutActionNote += delivered
          ? ", shortcut delivered after first reply"
          : noteShortcutDelivery(actionName, `, shortcut delivery failed: ${String(data.error || response.status).slice(0, 80)}`);
        await progress(shortcutActionNote);
      } catch (error) {
        shortcutActionNote += noteShortcutDelivery(actionName, `, shortcut delivery failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 80)}`);
        await progress(shortcutActionNote);
      }
    };
    // shortcut_resume 已经是一次动作结果后的第二轮，禁止它再次解析动作标记，
    // 避免模型不守“不要重复执行”提示时形成递归快捷动作。
    if (!payload.shortcut) {
      const markerMatch = rawText.match(SHORTCUT_MARKER_RE);
      if (markerMatch) {
        const markerText = markerMatch[0];
        // 标记在剥离后正文中的原始位置：对前缀做同一套清洗后取长度（尾部 trim 不影响前缀）
        const cleanedPrefix = rawText.slice(0, markerMatch.index ?? 0)
          .replace(SHORTCUT_MARKER_STRIP_RE, "")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/^\s+/, "");
        rawText = rawText.replace(SHORTCUT_MARKER_STRIP_RE, "").replace(/\n{3,}/g, "\n\n").trim();
        if (!rawText) rawText = "……";
        const markerInsertAt = Math.min(cleanedPrefix.length, rawText.length);
        const wanted = markerMatch[1].trim();
        const wantedArgs = parseShortcutMarkerArgs(markerMatch[2]);
        try {
          const catalogResponse = await rest(
            `push_bridge_config?user_id=eq.${encodeURIComponent(job.user_id)}&select=shortcut_actions&limit=1`,
          );
          const catalogRows = catalogResponse.ok ? await catalogResponse.json() as { shortcut_actions?: unknown }[] : [];
          const catalog = Array.isArray(catalogRows[0]?.shortcut_actions)
            ? catalogRows[0].shortcut_actions as Array<Record<string, unknown>>
            : [];
          const action = catalog.find(entry => String(entry.name ?? "") === wanted);
          if (action) {
            const resultMode = String(action.resultMode ?? "none");
            // 目录里没有 deliveryMode 的是同步过来的老快照（该字段是后加的）。
            // 退回推送仍然能用（只是要对方点一下通知，而不是自动执行），比不投递好；
            // 但要在任务日志里留痕，否则「提示词说自动执行、实际弹了通知」查不出原因。
            // 用户改动作或下一轮桥同步时目录会补上这个字段，属自愈。
            const catalogHasDeliveryMode = typeof action.deliveryMode === "string";
            const deliveryMode = String(action.deliveryMode ?? "push") === "email" ? "email" : "push";
            if (!catalogHasDeliveryMode) shortcutActionNote += ", catalog missing deliveryMode (fell back to push)";
            const continuation = payload.shortcutContinuation;
            const canContinue = resultMode !== "none"
              && Boolean(continuation?.request && continuation.replyMarker && continuation.resultMarker);
            const createResponse = await fetch(`${supabaseUrl}/functions/v1/ai-phone-push?action=shortcut-create`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-ai-phone-service-key": serviceKey,
                "x-ai-phone-origin": siteOrigin,
              },
              body: JSON.stringify({
                actionId: String(action.actionId ?? ""),
                actionName: String(action.name ?? ""),
                shortcutName: String(action.shortcutName ?? ""),
                arguments: wantedArgs,
                resultMode,
                deliveryMode,
                expiresInSeconds: Number(action.expiresInSeconds) || undefined,
                deferDelivery: canContinue,
              }),
            });
            const createData = await createResponse.json().catch(() => ({})) as {
              ok?: boolean;
              command?: { id?: string };
              resultUrl?: string;
            };
            shortcutActionNote = createResponse.ok && createData.ok
              ? `shortcut sent: ${wanted}`
              : `shortcut failed: http ${createResponse.status}`;
            if (createResponse.ok && createData.ok) {
              executedShortcutMarker = { text: markerText, insertAt: markerInsertAt, name: wanted };
            }

            // 邮件模式：个人云没有发信服务（RESEND_API_KEY 是站点的环境变量），
            // 请站点凭 site_bridge_token 代发那封信。命令行与结果回传仍留在本项目。
            // 有续跑的动作等续跑任务挂稳、首条回复送达之后再发（与推送模式同序），
            // 见下方 armed.ok 分支；这里只处理不回传结果、可以立刻触发的动作。
            const emailDelivery: DeferredShortcutEmail = {
              userId: job.user_id,
              commandId: String(createData.command?.id || ""),
              resultUrl: String(createData.resultUrl || ""),
              actionId: String(action.actionId ?? ""),
              actionName: String(action.name ?? ""),
              args: wantedArgs,
            };
            if (createResponse.ok && createData.ok && deliveryMode === "email" && !canContinue) {
              shortcutActionNote += noteShortcutDelivery(
                emailDelivery.actionName,
                await deliverShortcutEmailViaSite(emailDelivery),
              );
            }

            // 需回传结果的动作：武装 shortcut_resume 续跑任务——把刚生成的
            // 回复代入续跑快照的回复占位；结果回传后由本函数把结果代入生成下一轮。
            const commandId = String(createData.command?.id || "");
            if (createResponse.ok && createData.ok && canContinue && commandId && continuation) {
              try {
                const contRequest = JSON.parse(JSON.stringify(continuation.request)) as JobPayload["request"];
                replaceMarker(contRequest.body, continuation.replyMarker, rawText);
                const isImage = resultMode === "image";
                // 识图关着就不送图：送了轻则被模型忽略，重则接口直接 400 让整个
                // 第二轮失败（角色说了"我去看一眼"然后没有下文）。图片位改放一句
                // 说明，OCR 之类的附带文字仍照常经 resultMarker 抵达。
                const canSendImage = isImage && continuation.visionEnabled !== false;
                if (!canSendImage && continuation.imageMarker) {
                  replaceMarker(
                    contRequest.body,
                    continuation.imageMarker,
                    isImage ? SHORTCUT_VISION_OFF_NOTE : "（该动作没有图片回传）",
                  );
                }
                const expiresIn = Math.max(30, Math.min(900, Number(action.expiresInSeconds) || 120));
                const contPayload = {
                  request: contRequest,
                  shortcut: {
                    commandId,
                    actionName: String(action.name ?? "快捷动作"),
                    resultMode,
                    resultMarker: continuation.resultMarker,
                    ...(canSendImage && continuation.imageMarker ? { imageMarker: continuation.imageMarker } : {}),
                    style: "text",
                  },
                  notify: payload.notify,
                  merge: { ...(payload.merge ?? {}), shortcutCommandId: commandId },
                };
                const triggerKey = `shortcut:${commandId}`;
                await rest(
                  `push_jobs?user_id=eq.${encodeURIComponent(job.user_id)}&trigger_key=eq.${encodeURIComponent(triggerKey)}`,
                  { method: "DELETE" },
                ).catch(() => undefined);
                const armed = await rest("push_jobs", {
                  method: "POST",
                  body: JSON.stringify([{
                    id: `job_${crypto.randomUUID()}`,
                    user_id: job.user_id,
                    trigger_key: triggerKey,
                    kind: "shortcut_resume",
                    execute_at: new Date(Date.now() + (expiresIn + 90) * 1000).toISOString(),
                    status: "pending",
                    result_note: "cloud_shortcut_resume",
                    payload: await encryptJobPayload(JSON.stringify(contPayload), payloadKey),
                  }]),
                });
                await armed.text().catch(() => "");
                // 挂载成功与否都要把命令投递出去——命令已经以 deferDelivery 建好，
                // 不投递它就只会静默过期：角色说了"我去看一下"，用户手机什么都收不到。
                // 挂载失败时降级为"没有第二轮"，动作照跑，只是结果不会自动交回角色。
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += armed.ok
                  ? ", continuation armed"
                  : ", continuation arm failed (degraded to one-shot)";
              } catch {
                if (deliveryMode === "email") {
                  deferredShortcutEmail = emailDelivery;
                } else {
                  deferredShortcutCommandId = commandId;
                  deferredShortcutActionName = emailDelivery.actionName;
                }
                shortcutActionNote += ", continuation arm failed (degraded to one-shot)";
              }
            }
          } else {
            shortcutActionNote = `shortcut unknown: ${wanted}`;
          }
        } catch {
          shortcutActionNote = "shortcut catalog unavailable";
        }
      }
    } else {
      // 结果续跑即使被模型诱导再次输出动作标记，也只剥离控制文本，不执行。
      rawText = rawText.replace(/【快捷动作[：:][^】\n]{1,60}】/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!rawText) rawText = "……";
    }
    if (shortcutActionNote) await progress(shortcutActionNote);

    // ── 离线改送微信：普通任务由 AI 首行【发到微信】选择；真实微信快捷动作
    // 的结果续跑使用 force，保证第二轮无需模型再次决定渠道也回到同一 bot。 ──
    const WEIXIN_MARKER = "【发到微信】";
    let deliveredViaWeixin = false;
    {
      const head = rawText.slice(0, 200);
      const markerAt = head.indexOf(WEIXIN_MARKER);
      const forceWeixin = payload.weixin?.force === true;
      if (markerAt >= 0 || forceWeixin) {
        if (markerAt >= 0) {
          rawText = (rawText.slice(0, markerAt) + rawText.slice(markerAt + WEIXIN_MARKER.length)).trim();
          if (!rawText) rawText = "……";
          // 微信标记被剥掉后，快捷动作标记的还原位置要跟着前移（消费端还会钳位兜底）
          if (executedShortcutMarker && markerAt < executedShortcutMarker.insertAt) {
            executedShortcutMarker.insertAt = Math.max(0, executedShortcutMarker.insertAt - WEIXIN_MARKER.length);
          }
        }
        const weixinBotId = typeof payload.weixin?.botId === "string" ? payload.weixin.botId : "";
        if (!weixinBotId) await progress(`${forceWeixin ? "forced weixin" : "weixin marker"} but no bot in snapshot`);
        if (weixinBotId) {
          try {
            const secretResponse = await fetch(
              `${supabaseUrl}/storage/v1/object/ai-phone-backup/weixin-cloud/cron-secret.json`,
              { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } },
            );
            const secret = secretResponse.ok
              ? String(((await secretResponse.json().catch(() => ({}))) as { token?: unknown }).token || "")
              : "";
            if (secret) {
              const sendResponse = await fetch(`${supabaseUrl}/functions/v1/weixin-assistant`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "send-text",
                  token: secret,
                  bot: weixinBotId,
                  text: rawText,
                  ...(typeof payload.merge?.replyAfterLocalMessageId === "string"
                    && typeof payload.merge?.replyAfterCreatedAt === "string"
                    ? {
                        replyAfterLocalMessageId: payload.merge.replyAfterLocalMessageId,
                        replyAfterCreatedAt: payload.merge.replyAfterCreatedAt,
                      }
                    : {}),
                }),
              });
              const sendData = await sendResponse.json().catch(() => ({})) as { ok?: boolean; error?: string };
              deliveredViaWeixin = sendResponse.ok && sendData.ok === true;
              await progress(deliveredViaWeixin
                ? "delivered via weixin"
                : `weixin send failed: ${String(sendData.error || sendResponse.status).slice(0, 120)}`);
            } else {
              await progress("weixin secret missing");
            }
          } catch (err) {
            await progress(`weixin send failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);
          }
        }
      }
    }
    if (deliveredViaWeixin) {
      if (shortcutStoragePath) {
        await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
          method: "DELETE",
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        }).catch(() => undefined);
      }
      await deliverDeferredShortcut();
      await writeShortcutDeliveryDiagnostic();
      await finish("done", `sent via weixin${shortcutActionNote ? `, ${shortcutActionNote}` : ""}`);
      return;
    }

    await progress(`llm ok, ${rawText.length} chars${deliverAsCall ? ", call" : ""}`);
    const outboxResponse = await rest("push_outbox", {
      method: "POST",
      body: JSON.stringify([{
        id: `out_${crypto.randomUUID()}`,
        user_id: job.user_id,
        job_id: job.id,
        session_id: payload.merge?.sessionId ?? null,
        trigger_key: job.trigger_key,
        raw_text: rawText,
        meta: {
          ...(payload.merge ?? {}),
          pushGenerated: true,
          ...(executedShortcutMarker ? { shortcutMarker: executedShortcutMarker } : {}),
        },
      }]),
    });
    if (!outboxResponse.ok) {
      const detail = await outboxResponse.text().catch(() => "");
      if (isLifeSceneJob) await writeLifeDiagnostic(
        "life_outbox_write_failed",
        `AI 已生成内容，但生活消息写入 push_outbox 失败：${detail.slice(0, 220) || outboxResponse.status}`,
        "检查 push_outbox 表结构、service-role 权限和 Supabase 日志；修复后等待云端任务重试。",
      ).catch(() => undefined);
      await finish("failed", `outbox write failed: ${detail.slice(0, 180) || outboxResponse.status}`);
      return;
    }
    await writeLifeTraceEvent("消息已写入回传箱", "life_outbox_committed", "AI 结果已成功持久化到 push_outbox，开始通知投递。");
    await progress("outbox written, pushing");

    // Close the remaining cancellation window between outbox persistence and delivery.
    // If the job was cancelled after the row was written, remove the undelivered row
    // before returning so the client cannot merge a superseded reply later.
    if (await isCancelled()) {
      await rest(`push_outbox?job_id=eq.${encodeURIComponent(job.id)}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }

    if (shortcutStoragePath) {
      await fetch(`${supabaseUrl}/storage/v1/object/shortcut-command-media/${shortcutStoragePath}`, {
        method: "DELETE",
        headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
      }).catch(() => undefined);
    }

    const vapidResponse = await rest("push_server_config?id=eq.main&select=vapid_public_key,vapid_private_key&limit=1");
    const vapidRows = vapidResponse.ok ? await vapidResponse.json() as { vapid_public_key: string; vapid_private_key: string }[] : [];
    const vapidRow = vapidRows[0];
    let pushed = 0;
    const pushErrors: string[] = [];
    // 安卓壳（FloatShell App）的合成订阅（endpoint 以 shell: 开头）不走 Web Push，
    // 改由 Supabase Realtime 广播送达壳内长连接。
    const webSubs = subs.filter(sub => !sub.endpoint.startsWith("shell:"));
    // 壳订阅由站点按站点账号 id 注册（单机自部署下是 local_user），而个人云的任务
    // 一律挂在 OWNER_ID(owner) 下——按 job.user_id 过滤永远取不到壳那行，
    // hasShellSub 恒为 false，下面的广播整段被跳过：消息生成成功、写得进 outbox，
    // 却永远弹不出通知。壳订阅本就只属于本项目唯一的主人，按 endpoint 前缀单独取，
    // 不掺 user_id；topic 也改用 endpoint 里带的站点 id，与壳实际订阅的频道一致。
    const shellSubsResponse = await rest("push_subscriptions?endpoint=like.shell:*&select=endpoint&limit=50");
    const shellTopics = (shellSubsResponse.ok
      ? await shellSubsResponse.json() as { endpoint: string }[]
      : [])
      .map(sub => String(sub.endpoint || "").slice("shell:".length).trim())
      .filter(Boolean)
      .map(userId => `shellpush:${userId}`);
    const hasShellSub = shellTopics.length > 0;
    const vapid = vapidRow
      ? { publicKey: vapidRow.vapid_public_key, privateKey: vapidRow.vapid_private_key, subject: siteOrigin || "mailto:push@ai-phone.local" }
      : null;
    if (!vapid && webSubs.length > 0) pushErrors.push("no vapid config");
    const title = payload.notify?.title || "小手机";
    const isLifeSceneNotification = Boolean(payload.merge?.lifeScene);
    const callSessionId = !isLifeSceneNotification && typeof payload.merge?.sessionId === "string" ? payload.merge.sessionId : "";
    // Life-scene notifications return to the life page, not the underlying online chat session.
    const targetUrl = deliverAsCall && callSessionId
      ? `/?ring=${encodeURIComponent(callSessionId)}&rt=${Date.now()}`
      : (isLifeSceneNotification ? "/life" : (payload.notify?.url || "/"));
    const lifeSceneOutput = isLifeSceneNotification ? parseLifeSceneOutput(rawText) : null;
    const lifeScenePreview = lifeSceneOutput
      ? [lifeSceneOutput.action, ...lifeSceneOutput.dialogues].filter(Boolean).join("\n\n")
      : rawText;
    // 生活现场一轮就是一条通知；不能把 JSON 或长文本按句子拆成多条推送。
    let parts = deliverAsCall
      ? ["来电话了…"]
      : isLifeSceneNotification && lifeScenePreview.trim()
        ? [lifeScenePreview.trim()]
        : splitResponseForPushPreview(lifeScenePreview).slice(0, 6);
    if (parts.length === 0) parts = ["发来一条消息"];

    // Notification setup may take additional time after outbox persistence. Check once
    // more immediately before the first push to narrow the stale-notification race.
    if (await isCancelled()) {
      await rest(`push_outbox?job_id=eq.${encodeURIComponent(job.id)}`, { method: "DELETE" }).catch(() => undefined);
      return;
    }

    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) await sleep(500);
      // 单条截断从 80 放宽到 200：分条规则与聊天记录同口径（都按双空行拆），
      // 一一对应才是「同步」；真正让两处看起来不一致的是截断——过去稍长的消息
      // 在通知里只剩开头一句，聊天里却是完整的。正常聊天单条远不到 200 字，
      // 几乎不会触发截断。
      const partBody = parts[index].slice(0, 200);
      const message = JSON.stringify({
        type: deliverAsCall ? "incoming_call" : "chat_outbox",
        title: deliverAsCall ? `📞 ${title}` : title,
        body: partBody,
        tag: `${job.id}-${index}`,
        url: targetUrl,
        ...(deliverAsCall ? { sessionId: callSessionId, callTs: Date.now() } : {}),
      });
      if (vapid) {
        for (const sub of webSubs) {
          try {
            const status = await sendWebPushRaw(sub, message, vapid, 3600);
            if (status === 404 || status === 410) {
              await rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(sub.endpoint)}`, { method: "DELETE" }).catch(() => undefined);
            } else if (status >= 400) {
              pushErrors.push(`http ${status}`);
            } else {
              pushed += 1;
            }
          } catch (err) {
            pushErrors.push((err instanceof Error ? err.message : String(err)).slice(0, 80));
          }
        }
      }
      if (hasShellSub) {
        try {
          const response = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
            method: "POST",
            headers: restHeaders,
            body: JSON.stringify({
              messages: shellTopics.map(topic => ({
                topic,
                event: "notify",
                payload: {
                  title: deliverAsCall ? `📞 ${title}` : title,
                  body: partBody,
                  url: targetUrl,
                  // 老壳不认识这些字段 → 照常显示普通通知，自然向下兼容。
                  // sessionId 让壳点击通知直达对应会话（普通消息原先没有，点开只回桌面）；
                  // avatar 是角色头像（data URL 或直链），有就当通知大图标，没有壳用默认图。
                  // Life-scene notifications need the chat session ID only for the native quick-reply action; taps still open /life.
                  ...(isLifeSceneJob && typeof payload.merge?.sessionId === "string"
                    ? { sessionId: payload.merge.sessionId }
                    : callSessionId ? { sessionId: callSessionId } : {}),
                  ...(typeof payload.notify?.avatar === "string" && payload.notify.avatar
                    ? { avatar: payload.notify.avatar }
                    : {}),
                  ...(isLifeSceneJob ? {
                    kind: "life_scene",
                    sceneId: String(payload.merge?.lifeScene?.sceneId ?? ""),
                    characterId: String(payload.merge?.lifeScene?.characterId ?? ""),
                    characterName: String(payload.merge?.lifeScene?.characterName ?? title),
                    actionText: lifeSceneOutput?.action ?? "",
                    dialogueText: lifeSceneOutput?.dialogues[0] ?? "",
                  } : {}),
                  ...(deliverAsCall ? { kind: "call", characterName: title, callTs: Date.now() } : {}),
                },
              })),
            }),
          });
          await response.text().catch(() => undefined);
          if (response.ok) pushed += 1;
          else pushErrors.push(`shell http ${response.status}`);
        } catch (err) {
          pushErrors.push(`shell ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
        }
      }
      await progress(`pushed ${index + 1}/${parts.length}${pushErrors.length ? `, errors: ${pushErrors[0]}` : ""}`);
    }

    if (isLifeSceneJob && pushErrors.length) {
      await writeLifeDiagnostic(
        "life_notification_delivery_failed",
        `生活消息已写入云端，但有通知通道投递失败：${pushErrors.slice(0, 3).join(" | ")}`,
        "检查 Web Push 订阅是否过期、VAPID 配置及 Android Realtime 广播权限；消息仍保留在 push_outbox，可在客户端同步时取回。",
      ).catch(() => undefined);
    } else if (isLifeSceneJob && pushed > 0) {
      await rest(`life_schedule_diagnostics?id=eq.${encodeURIComponent(`life-scheduler:${job.user_id}:life_notification_delivery_failed`)}`, {
        method: "PATCH", body: JSON.stringify({ resolved_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      }).catch(() => undefined);
    }

    // 第一轮正文已经落库并完成推送后，再发“运行快捷指令”通知。用户看到的
    // 顺序稳定为：角色先说话 → 运行动作 → 结果回来后角色再说话。
    await deliverDeferredShortcut();

    await writeShortcutDeliveryDiagnostic();

    // 冷场重连的下一发：连发上限内自动排队（用户回来后客户端会撤销并按新周期重挂）
    // 用户已撤销这条链时绝不再续排——否则规则删了，新单还会源源不断地冒出来。
    if (await isCancelled()) {
      await finish("done", `generated, pushed ${pushed}, cancelled before repeat`);
      return;
    }
    const idleRepeat = payload.merge?.idleRepeat as
      | { intervalMs?: number; remaining?: number; quietWin?: { startMin: number; endMin: number; tzOffsetMin: number } | null }
      | undefined;
    if (!payload.merge?.lifeScene && idleRepeat && Number(idleRepeat.remaining) > 0 && Number(idleRepeat.intervalMs) > 0) {
      const intervalMs = Number(idleRepeat.intervalMs);
      let nextFire = Date.now() + intervalMs;
      // 落在安静时段内则顺延到时段结束
      const quiet = idleRepeat.quietWin;
      if (quiet && Number.isFinite(quiet.startMin) && Number.isFinite(quiet.endMin)) {
        const localMinutes = (Math.floor(nextFire / 60000) + quiet.tzOffsetMin) % 1440;
        const inQuiet = quiet.startMin < quiet.endMin
          ? localMinutes >= quiet.startMin && localMinutes < quiet.endMin
          : localMinutes >= quiet.startMin || localMinutes < quiet.endMin;
        if (inQuiet) {
          const untilEnd = (quiet.endMin - localMinutes + 1440) % 1440;
          nextFire += untilEnd * 60000;
        }
      }
      const nextMerge = {
        ...payload.merge,
        armAt: new Date(nextFire).toISOString(),
        idleReconnect: { ...(payload.merge?.idleReconnect as Record<string, unknown> ?? {}), firedAt: nextFire },
        idleRepeat: Number(idleRepeat.remaining) - 1 > 0
          ? { ...idleRepeat, remaining: Number(idleRepeat.remaining) - 1 }
          : undefined,
      };
      const nextPayload = { ...payload, merge: nextMerge };
      const nextTriggerKey = `${job.trigger_key}+`;
      await rest("push_jobs", {
        method: "POST",
        body: JSON.stringify([{
          id: `job_${crypto.randomUUID()}`,
          user_id: job.user_id,
          trigger_key: nextTriggerKey,
          kind: "timed_task",
          execute_at: new Date(nextFire + 15_000).toISOString(),
          status: "pending",
          payload: await encryptPayload(JSON.stringify(nextPayload), payloadKey),
        }]),
      }).catch(() => undefined);
      // 同规则去重（服务端兜底）：冷场重连的下一发既可能由这里续排，也可能由
      // 客户端重挂（切后台/回前台都会重新挂单）。两边并行时旧链不会消失——
      // 曾出现同一条「长时间没消息」规则 2 分半内跑出 6 单（:0 / :0+ / :0++ /
      // :1 / :1+ / :2），用户被连弹好几条通知。客户端虽有延迟清理，但依赖
      // 页面还活着，App 被杀或长时间后台时根本不执行。
      // 这里以规则为界清掉其它还挂着的 pending，只留刚挂上的这一单。
      // 仅在本链还会继续（nextMerge.idleRepeat 仍在）时清理：若是最后一发，
      // 服务端链到此结束，此时再删客户端的单会让这条规则彻底没有后续。
      // trigger_key 形如 idle:<ruleId>:<n>，ruleId 内不含冒号，取最后一个冒号及之前即前缀。
      if (nextMerge.idleRepeat && job.trigger_key.startsWith("idle:")) {
        const rulePrefix = job.trigger_key.slice(0, job.trigger_key.lastIndexOf(":") + 1);
        if (rulePrefix.length > "idle:".length) {
          await rest(
            `push_jobs?user_id=eq.${encodeURIComponent(job.user_id)}`
            + `&trigger_key=like.${encodeURIComponent(`${rulePrefix}%`)}`
            + `&trigger_key=neq.${encodeURIComponent(nextTriggerKey)}`
            + "&status=eq.pending",
            { method: "DELETE" },
          ).catch(() => undefined);
        }
      }
    }

    await writeLifeTraceEvent("通知投递结束", pushErrors.length ? "life_delivery_partial_or_failed" : "life_delivery_completed", `通知通道成功计数 ${pushed}；失败数 ${pushErrors.length}；${pushErrors.slice(0, 3).join(" | ") || "无投递错误"}`, pushErrors.length ? "warning" : "info");
    await finish("done", `generated, pushed ${pushed}${shortcutActionNote ? `, ${shortcutActionNote}` : ""}${pushErrors.length ? `, errors: ${pushErrors.slice(0, 3).join(" | ")}` : ""}`);
  } catch (err) {
    await finish("failed", err instanceof Error ? err.message : String(err));
  }
  };

  const work = runJob();
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(work);
  else await work;
  return new Response("accepted", { status: 200 });
});
