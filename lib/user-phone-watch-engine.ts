import type { Character } from "./character-types";
import type { ApiConfig } from "./settings-types";
import type { ChatSession } from "./chat-storage";
import { loadChatSessions, pushChatMessage, resolveSessionCharacterId, saveChatSessions } from "./chat-storage";
import { addMomentComment, addMomentPost } from "./moments-storage";
import { saveMemoryEntry } from "./memory-storage";
import { formatClock } from "./inspection-storage";
import { resolveInspectionApiConfig } from "./inspection-engine";
import { simpleLLMCall } from "./api-helpers";

/** 角色查岗时生成的一整段"操作台词"，内容全部由角色的口吻驱动 */
export type UserPhoneWatchScript = {
  /** 以用户身份发给好友的私聊 */
  friendMessage: string;
  /** 好友的回复（一次生成，避免执行时再等一次接口） */
  friendReply: string;
  /** 角色把用户手机里自己的备注改成什么 */
  remark: string;
  /** 以用户身份发的动态 */
  momentText: string;
  /** 以用户身份留下的评论 */
  comment: string;
  /** 五个阶段的实时发言 */
  bubbles: string[];
  generatedByAI: boolean;
};

type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

const WATCH_LLM_TIMEOUT_MS = 20000;

async function callWatchLLM(config: ApiConfig, messages: ChatTurn[]): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCH_LLM_TIMEOUT_MS);
  try {
    const result = await simpleLLMCall(config, messages, {
      temperature: 0.9,
      max_tokens: 600,
      label: "查岗-用户手机",
      signal: controller.signal,
    });
    return result.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function pickText(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  if (!text) return fallback;
  return text.slice(0, maxLength);
}

function parseScript(raw: string | null, fallback: UserPhoneWatchScript): UserPhoneWatchScript | null {
  if (!raw) return null;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const bubbles = Array.isArray(parsed.bubbles)
      ? parsed.bubbles
          .map(item => (typeof item === "string" ? item.trim().slice(0, 80) : ""))
          .filter(Boolean)
      : [];
    return {
      friendMessage: pickText(parsed.friendMessage, fallback.friendMessage, 120),
      friendReply: pickText(parsed.friendReply, fallback.friendReply, 120),
      remark: pickText(parsed.remark, fallback.remark, 16),
      momentText: pickText(parsed.momentText, fallback.momentText, 140),
      comment: pickText(parsed.comment, fallback.comment, 80),
      bubbles: Array.from({ length: 5 }, (_, index) => bubbles[index] ?? fallback.bubbles[index]),
      generatedByAI: true,
    };
  } catch {
    return null;
  }
}

/** 无 API / 生成失败时的兜底脚本：仍然完整走一遍所有操作 */
export function buildFallbackWatchScript(character: Character, friendName: string): UserPhoneWatchScript {
  const remark = `我的${character.name}`.slice(0, 16);
  return {
    friendMessage: "在吗？今天突然想起你。",
    friendReply: `${character.name}？你怎么突然说这个。`,
    remark,
    momentText: "今天心情莫名不错，出来走走。",
    comment: "这张拍得挺好。",
    bubbles: [
      "……先看看你都在跟谁聊天。",
      `原来你平时是这么跟${friendName}说话的。`,
      `备注我改一下，就写「${remark}」。`,
      "动态也翻翻……这条我挺喜欢。",
      "好了，看完了。手机还你。",
    ],
    generatedByAI: false,
  };
}

/** 由被查岗的角色（检查者）人设驱动，生成一段完整的操作内容 */
export async function generateUserPhoneWatchScript(
  character: Character,
  friendName: string,
): Promise<UserPhoneWatchScript> {
  const fallback = buildFallbackWatchScript(character, friendName);
  const config = resolveInspectionApiConfig(character.id);
  if (!config) return fallback;

  const prompt = [
    `你在扮演「${character.name}」。人设：${(character.persona || character.briefPersona || "沉默、观察力强").slice(0, 320)}`,
    `此刻你已经获得对方许可，正在翻看对方的手机，你只能看和做下面这些事，不能删东西。`,
    `对方有一个好友叫「${friendName}」。请生成一段符合你性格的操作内容，严格输出 JSON：`,
    `{`,
    `  "friendMessage": "你以对方身份发给「${friendName}」的一条私聊，1 句，像对方会说的话",`,
    `  "friendReply": "「${friendName}」看到后可能的回复，1 句",`,
    `  "remark": "你把对方手机里自己的备注改成什么，2-6 个字，可带占有欲或亲昵感",`,
    `  "momentText": "你以对方身份发的一条动态，1-2 句",`,
    `  "comment": "你在对方一条动态下以对方身份留的评论，1 句",`,
    `  "bubbles": ["翻聊天列表时的一句话", "看到私聊时的一句话", "改备注时的一句话", "翻动态时的一句话", "结束时的收尾话"]`,
    `}`,
    `要求：全部内容用中文，符合你的人设，不要解释，只输出 JSON。`,
  ].join("\n");

  const raw = await callWatchLLM(config, [{ role: "user", content: prompt }]);
  return parseScript(raw, fallback) ?? fallback;
}

/** 以用户身份给好友发消息 */
export function sendUserMessage(sessionId: string, text: string): boolean {
  const content = text.trim();
  if (!sessionId || !content) return false;
  pushChatMessage({ sessionId, role: "user", content: content.slice(0, 200), status: "sent" });
  return true;
}

/** 好友的回复落库（角色在查岗时替好友"代回"） */
export function sendFriendReply(sessionId: string, text: string): boolean {
  const content = text.trim();
  if (!sessionId || !content) return false;
  pushChatMessage({ sessionId, role: "assistant", content: content.slice(0, 200), status: "sent" });
  return true;
}

/** 修改用户手机里某个会话的备注 */
export function applyUserPhoneAlias(sessionId: string, alias: string): boolean {
  const nextAlias = alias.trim().slice(0, 16);
  if (!sessionId || !nextAlias) return false;
  const sessions = loadChatSessions();
  const target = sessions.find(session => session.id === sessionId);
  if (!target) return false;
  target.alias = nextAlias;
  saveChatSessions(sessions);
  return true;
}

/** 以用户身份发一条动态 */
export function postMomentAsUser(text: string, visibleTo: string[]): boolean {
  const content = text.trim();
  if (!content) return false;
  return !!addMomentPost({
    authorType: "user",
    authorId: "user",
    content: content.slice(0, 200),
    visibility: visibleTo,
  });
}

/** 以用户身份评论一条动态 */
export function commentAsUser(postId: string, text: string): boolean {
  const content = text.trim();
  if (!postId || !content) return false;
  return !!addMomentComment({
    postId,
    authorType: "user",
    authorId: "user",
    content: content.slice(0, 120),
  });
}

/** 查岗期间发生的事写入长期记忆，参与后续检索与「他对你的看法」更新 */
export async function saveUserPhoneWatchMemory(
  characterId: string,
  content: string,
  importance = 0.55,
): Promise<void> {
  const text = content.trim();
  if (!characterId || !text) return;
  const now = new Date().toISOString();
  try {
    await saveMemoryEntry({
      id: `mem_watch_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      characterId,
      sourceApp: "checkphone",
      type: "long_term",
      content: text.slice(0, 400),
      importance,
      createdAt: now,
      updatedAt: now,
      metadata: { origin: "user-phone-watch", time: formatClock(new Date()) },
    });
  } catch {
    /* 记忆写入失败不影响查岗流程 */
  }
}

/** 供组件挑选可被翻看的真实会话（排除群聊与检查者自己） */
export function pickFriendSession(sessions: ChatSession[], characterId: string): ChatSession | null {
  return (
    sessions
      .filter(session => !session.isGroup && resolveSessionCharacterId(session) !== characterId)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0] ?? null
  );
}
