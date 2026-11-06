"use client";

/**
 * 小组件的自动生成：让角色隔段时间自己换一句留在桌面上。
 *
 * 与「角色用工具写」的关系：
 *   工具写入 = 角色在聊天中主动想到「我想在 TA 桌面留句话」；
 *   自动生成 = 角色没跟用户说话时，也偶尔在桌面换个状态。
 * 两者写的是同一份数据，后者只是多一个触发源。
 *
 * 默认关闭：这是角色**主动往用户桌面上放东西**，与「等它说话」不同，
 * 该由用户明确开启。
 */

import { loadCharacters } from "../character-storage";
import { type ChatMessage, type ChatSession } from "../chat-storage";
import { buildChatPromptMessages, sendLLMRequest } from "../chat-engine";
import { resolveUserIdentity } from "../settings-storage";
import { appendCustomAppTimelineEntry } from "../custom-app-storage";
import { loadWidgetAutoLastRun, loadWidgetConfig, loadWidgetData, markWidgetAutoRun, saveWidgetData } from "./storage";

/**
 * 小组件自己的时间线来源标识。
 *
 * 用来把「我在桌面留了句话」写进角色的短期记忆。
 */
const WIDGET_SOURCE = { id: "phone_widget", name: "桌面小组件" };
import { canGenerateAvatar, generateWidgetAvatar } from "./avatar";
import { parseWidgetLineOutput } from "./output";
import type { WidgetData } from "./types";

/**
 * 让角色生成一句适合放在桌面上的话。
 *
 * 提示词刻意约束得很短：这是桌面小组件，不是聊天——
 * 长了显示不下，也太「表演」。要的是一句像随手写下的状态。
 */
async function generateLine(
  character: ReturnType<typeof loadCharacters>[number],
  userName: string,
  previous: WidgetData | null,
): Promise<{ text: string; status: string } | null> {
  // Widget 现在走统一预设管线：角色卡、世界书、记忆和提示词都从该 APP 的绑定/预设读取，
  // 提示词本身不再硬编码在代码里（预设条目 tags: ["phone_widget","status"]）。
  const session: ChatSession = {
    id: `phone-widget-${character.id}`,
    contactId: character.id,
    unreadCount: 0,
    updatedAt: new Date().toISOString(),
    isPinned: false,
    isGroup: false,
  };
  const trigger = previous?.text
    ? `请留下一句今天的桌面状态。不要重复上次留在桌面上的话：「${previous.text}」，换一个自然的角度。`
    : "请留下一句今天的桌面状态。";
  const userMessage: ChatMessage = {
    id: `widget-${Date.now()}`,
    sessionId: session.id,
    role: "user",
    content: trigger,
    status: "sent",
    createdAt: new Date().toISOString(),
  };

  let built: Awaited<ReturnType<typeof buildChatPromptMessages>>;
  try {
    built = await buildChatPromptMessages(session, [userMessage], {
      appId: "phone_widget",
      appTags: ["phone_widget", "status"],
      // This is a one-shot JSON content generator, not a chat turn. Tool calls
      // cannot be executed here and must never be emitted into the widget.
      toolsAllowed: false,
      forceEnableTools: false,
    });
  } catch {
    return null;
  }

  const raw = (await sendLLMRequest(
    built.config,
    built.preset,
    built.llmMessages,
    built.regexes,
    { characterName: character.name, userName },
    { appId: "phone_widget", appTags: ["phone_widget", "status"] },
  )).trim();
  if (!raw) return null;
  // Strict JSON only. Malformed output is discarded rather than displayed as
  // a message; this prevents leaked prompts and unexecuted tool directives.
  return parseWidgetLineOutput(raw);
}

/**
 * 跑一次自动生成（如果到了间隔）。
 *
 * @returns 是否真的换了内容
 */
export async function runWidgetAutoGenerate(): Promise<boolean> {
  const config = loadWidgetConfig();
  if (!config.enabled || !config.autoEnabled) return false;
  if (!config.characterId) return false;

  const intervalMs = Math.max(1, config.autoIntervalHours) * 3600_000;
  const last = loadWidgetAutoLastRun();
  if (last > 0 && Date.now() - last < intervalMs) return false;

  const character = loadCharacters().find(item => item.id === config.characterId);
  if (!character) return false;

  const userName = resolveUserIdentity(config.characterId)?.name || "用户";
  try {
    const line = await generateLine(character, userName, loadWidgetData());
    if (!line) return false;
    // 先记号，再写数据：生成可能要十几秒，期间不能被重复触发
    markWidgetAutoRun();

    // 配了生图且用户开了开关时，顺手换一张配当前状态的头像。
    // 失败/没配都静默沿用旧头像——头像只是锦上添花，
    // 绝不能因为它让「换一句话」这件事整体失败。
    // 头像优先级：已生成/上次留下的 > 角色卡头像。
    // 以前只带上一轮的 avatar，没开「状态头像」时永远是空 → 桌面只剩首字，
    // 与角色卡里设的头像完全脱节（用户实报）。
    let avatar = loadWidgetData()?.avatar || (character.avatar ?? "");
    if (config.useGeneratedAvatar && canGenerateAvatar()) {
      const generated = await generateWidgetAvatar(character, line.status, line.text);
      if (generated) avatar = generated;
    }

    saveWidgetData({
      characterId: character.id,
      text: line.text,
      status: line.status,
      avatar,
      updatedAt: new Date().toISOString(),
      source: "auto",
    });

    // 同步进角色的短期记忆（时间线）：这件事花的是**同一次**生成，只是多记一笔。
    //
    // 为什么必须记：这句话是角色自己写的，它下次聊天时该记得。不记的话，
    // 用户说「你昨天在桌面写的那句」，角色会一脸茫然——而那句话明明是它写的（实测反馈）。
    // 写完不触发任何回复：时间线只是上下文，什么时候开口由对话本身决定。
    try {
      appendCustomAppTimelineEntry(WIDGET_SOURCE, {
        characterId: character.id,
        summary: `我在 TA 手机桌面留了一句：${line.text}`,
        detail: line.status ? `当时的状态标签：${line.status}` : undefined,
      });
    } catch {
      // 记时间线失败不该影响留话本身——话已经写进桌面了
    }
    return true;
  } catch (err) {
    console.warn("[Widget] 自动生成失败", err);
    return false;
  }
}

