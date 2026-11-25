import type { Character } from "./character-types";
import type { ApiConfig } from "./settings-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { STANDBY_LINES_PER_DAY, STANDBY_MAX_LINE_LENGTH } from "./standby-lines";

/**
 * 待机台词用哪个 API：优先跟随该角色「聊天」绑定的 API，没配绑定就用第一条可用 API。
 * 都找不到时返回 null，由调用方走本地兜底台词。
 */
export function resolveStandbyApiConfig(characterId: string): ApiConfig | null {
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "chat");
    if (slot?.apiConfigId) {
      const bound = loadApiConfigs().find(c => c.id === slot.apiConfigId);
      if (bound) return bound;
    }
  } catch {
    /* 绑定缺失时继续找全局 API */
  }
  return loadApiConfigs()[0] ?? null;
}

function buildMessages(character: Character, existing: string[]): { role: string; content: string }[] {
  const persona = (character.persona || "").trim().slice(0, 600);
  const personality = (character.personality || "").trim().slice(0, 200);
  const avoid = existing.filter(Boolean).slice(0, 10);
  return [
    {
      role: "system",
      content: [
        "你在为一个手机 App 的「待机首页」写角色台词。",
        "待机台词是角色在用户没有打开聊天时，看到用户经过时随口说的一句话。",
        "要求：",
        `1. 只输出 JSON 字符串数组，不要任何解释、不要 markdown 代码块。`,
        `2. 数组长度必须是 ${STANDBY_LINES_PER_DAY}。`,
        `3. 每条不超过 ${STANDBY_MAX_LINE_LENGTH} 个字，口语化、生活化，像真的在说话。`,
        "4. 不要出现「待机」「台词」「设定」等元词汇，不要替用户说话，不要写动作旁白。",
        "5. 五条之间语气要有差异：问候、关心、日常闲聊、轻微撒娇或抱怨、随口一提。",
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `角色名：${character.name}`,
        personality ? `性格：${personality}` : "",
        persona ? `人设：${persona}` : "",
        avoid.length > 0 ? `不要重复这些已有的句子：\n${avoid.map(t => `- ${t}`).join("\n")}` : "",
        "请输出 JSON 字符串数组。",
      ].filter(Boolean).join("\n\n"),
    },
  ];
}

function cleanupLine(raw: string): string {
  return raw
    .replace(/^[\s\-*•·\d.、)）"'"'“”]+/, "")
    .replace(/["'"'“”]+$/, "")
    .trim()
    .slice(0, STANDBY_MAX_LINE_LENGTH);
}

/** 从模型输出里解析出台词：优先 JSON 数组，其次按行兜底 */
export function parseStandbyLines(raw: string): string[] {
  const text = (raw || "").trim();
  if (!text) return [];

  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map(cleanupLine)
          .filter(Boolean)
          .slice(0, STANDBY_LINES_PER_DAY);
      }
    } catch {
      /* 落到按行解析 */
    }
  }

  return text
    .split(/\r?\n/)
    .map(cleanupLine)
    .filter(line => line.length > 0 && !line.startsWith("```"))
    .slice(0, STANDBY_LINES_PER_DAY);
}

/**
 * 调 API 生成一批待机台词。
 * 返回 null 表示不可用（没配 API / 请求失败 / 解析为空），调用方应使用本地兜底。
 */
export async function generateStandbyLinesForCharacter(
  character: Character,
  existing: string[] = [],
): Promise<string[] | null> {
  const config = resolveStandbyApiConfig(character.id);
  if (!config) return null;

  try {
    const result = await simpleLLMCall(config, buildMessages(character, existing), {
      temperature: 0.9,
      max_tokens: 400,
      label: "standby-lines",
    });
    if (!result.content) return null;
    const lines = parseStandbyLines(result.content);
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}
