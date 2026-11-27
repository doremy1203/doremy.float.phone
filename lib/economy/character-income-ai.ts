"use client";

import { createOrGetSession, type ChatMessage } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { generateOfflineChatCompletion } from "@/lib/chat-engine";

export type InferredCharacterEconomy = {
    initialDeposit: number;
    incomeAmount: number;
    cadence: "weekly" | "monthly";
    basis: string;
};

type CharacterCardLike = {
    id: string;
    name: string;
    persona?: string;
    personality?: string;
    tags?: string[];
    briefPersona?: string;
};

function parseObject(raw: string): Record<string, unknown> | null {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first < 0 || last <= first) return null;
    try {
        const parsed = JSON.parse(raw.slice(first, last + 1)) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/**
 * 第一次建档时让模型读完整角色卡判断经济状况。
 *
 * 这里只借用某个角色的会话拿 API 配置，不让模型扮演该角色；返回的仍是普通数据，
 * 由 character-income 负责落库和发初始存款。
 */
export async function inferCharacterEconomy(character: CharacterCardLike): Promise<InferredCharacterEconomy> {
    const characters = loadCharacters();
    const generator = characters.find(item => item.id !== character.id) || characters.find(item => item.id === character.id);
    if (!generator) throw new Error("没有可用于调用模型的角色");
    const session = createOrGetSession(generator.id);
    const card = {
        name: character.name,
        persona: String(character.persona || "").slice(0, 3000),
        personality: String(character.personality || "").slice(0, 1000),
        tags: (character.tags || []).slice(0, 20),
        briefPersona: String(character.briefPersona || "").slice(0, 1000),
    };
    const prompt = [
        "你是角色经济系统分析器，不是在扮演角色。",
        "请根据下面的角色卡，判断这个角色合理的初始存款、固定收入金额和发放频率。",
        "要考虑职业/学生身份、年龄感、生活方式、家庭条件和人设，不要给所有人都套同一个数。",
        "只输出 JSON 对象，不要解释、不要 markdown 代码块。",
        '格式：{"initialDeposit":数字,"incomeAmount":数字,"cadence":"weekly"或"monthly","basis":"一句判断依据"}',
        "金额单位是元；初始存款 0-10000000，固定收入 0-1000000。",
        "角色卡：",
        JSON.stringify(card, null, 2),
    ].join("\n");
    const history = [{
        id: `economy_profile_${Date.now()}`,
        sessionId: session.id,
        role: "user",
        content: prompt,
        status: "sent",
        createdAt: new Date().toISOString(),
    } as ChatMessage];
    const result = await generateOfflineChatCompletion(session, history, {
        appId: "chat",
        appTags: ["chat", "text"],
        includeDirectChatEntries: false,
    });
    const parsed = parseObject(String(result.content || ""));
    if (!parsed) throw new Error("模型没有返回有效的经济档案 JSON");
    const initialDeposit = Number(parsed.initialDeposit);
    const incomeAmount = Number(parsed.incomeAmount);
    if (!Number.isFinite(initialDeposit) || !Number.isFinite(incomeAmount)) throw new Error("模型返回的金额不合法");
    return {
        initialDeposit: Math.max(0, Math.min(10_000_000, Math.round(initialDeposit * 100) / 100)),
        incomeAmount: Math.max(0, Math.min(1_000_000, Math.round(incomeAmount * 100) / 100)),
        cadence: parsed.cadence === "weekly" ? "weekly" : "monthly",
        basis: String(parsed.basis || "").trim().slice(0, 200) || "按角色卡综合判断",
    };
}
