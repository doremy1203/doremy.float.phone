import type { ParsedMessagePart } from "./rich-message-parser";
import { loadChatMessages } from "./chat-storage";

const FOCUS_APP_ID = "doris.focus.companion";
const FOCUS_APP_NAME = "角色陪伴专注";
const FOCUS_DIRECTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;

function isFocusDirectivePart(part: ParsedMessagePart): boolean {
  if (part.mediaType !== "app_card") return false;
  const appId = String(part.mediaData?.appId || "");
  const appName = String(part.mediaData?.appName || "");
  return appId === FOCUS_APP_ID
    || appId.startsWith(`app_${FOCUS_APP_ID}`)
    || appName === FOCUS_APP_NAME;
}

/** 从整段 raw/args 里抓第一个 HH:MM（兼容中文逗号 13，00）。 */
function extractTime(value: string): string {
  const match = String(value || "").match(/(?:^|[^\d])(\d{1,2})\s*[:：，,、]\s*(\d{1,2})(?!\d)/);
  if (!match) return "";
  const hour = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minute = Math.max(0, Math.min(59, Number(match[2]) || 0));
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 把 HH:MM 解释成“从 baseMs 起下一次出现的时间”，用来判断两次邀请是不是同一场。 */
function nextOccurrence(time: string, baseMs: number): number {
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(baseMs);
  date.setSeconds(0, 0);
  date.setHours(hour, minute, 0, 0);
  if (date.getTime() <= baseMs) date.setDate(date.getDate() + 1);
  return date.getTime();
}

function directiveKey(part: ParsedMessagePart, baseMs: number): string {
  if (!isFocusDirectivePart(part)) return "";
  const directiveId = String(part.mediaData?.appDirectiveId || "").toLowerCase();
  const label = String(part.mediaData?.appDirectiveLabel || "").toLowerCase();
  const args = Array.isArray(part.mediaData?.appDirectiveArgs)
    ? part.mediaData!.appDirectiveArgs.map(value => String(value))
    : [];
  const raw = [
    ...args,
    String(part.mediaData?.appDirectiveRaw || ""),
    String(part.mediaData?.appCardSummary || ""),
    String(part.content || ""),
  ].join(" ");

  if (directiveId.includes("appt") || label.includes("约专注") || /约专注/.test(raw)) {
    const time = extractTime(raw);
    if (!time) return "";
    return `focus-appt:${nextOccurrence(time, baseMs)}`;
  }

  if (directiveId.includes("sleep") || label.includes("陪睡") || /陪睡/.test(raw)) {
    const mode = args.find(value => /小憩|午睡|长睡眠/.test(value))
      || (raw.match(/小憩|午睡|长睡眠/)?.[0])
      || "午睡";
    const minutes = args.find(value => /^\d{1,4}$/.test(value)) || "";
    return `focus-sleep:${mode}:${minutes}`;
  }

  return "";
}

function messageKey(part: ParsedMessagePart, createdAt: string): string {
  const time = Date.parse(createdAt);
  if (!Number.isFinite(time)) return "";
  const key = directiveKey(part, time);
  if (!key) return "";
  if (key.startsWith("focus-sleep:")) {
    return Date.now() - time <= FOCUS_DIRECTIVE_WINDOW_MS ? key : "";
  }
  return key;
}

/**
 * 同一段对话里，角色可能先在上一轮发了「约专注」卡，后来又提到同一件事并再一次
 * 输出 [约专注:同一时间:...]。模型本身没有“已经发过”的记忆，所以必须在落库前拦。
 *
 * 只处理专注 APP 的两类邀请卡：
 * - 约专注：同一角色、同一开始时间只保留第一张；
 * - 陪睡：同一模式/时长在 24 小时内只保留第一张。
 *
 * 不按任务文案判断——用户要的是“同一时段不要再建一张”，文案换了也算重复。
 */
export function filterDuplicateFocusDirectiveParts(
  sessionId: string,
  parts: ParsedMessagePart[],
): ParsedMessagePart[] {
  if (!parts.some(isFocusDirectivePart)) return parts;

  const existingKeys = new Set<string>();
  for (const message of loadChatMessages(sessionId).slice(-200)) {
    if (message.mediaType !== "app_card") continue;
    const key = messageKey({
      content: message.content,
      mediaType: message.mediaType,
      mediaData: message.mediaData,
    }, message.createdAt);
    if (key) existingKeys.add(key);
  }

  const kept: ParsedMessagePart[] = [];
  let dropped = 0;
  for (const part of parts) {
    const key = directiveKey(part, Date.now());
    if (key && existingKeys.has(key)) {
      dropped += 1;
      continue;
    }
    if (key) existingKeys.add(key);
    kept.push(part);
  }
  if (dropped > 0) {
    console.log(`[FocusDirective] 已跳过 ${dropped} 张重复的专注邀请卡（同期已有卡片）`);
  }
  return kept;
}
