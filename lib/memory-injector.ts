// lib/memory-injector.ts
// Formats long-term memory entries into injectable prompt text.

import type { MemoryEntry } from "./memory-types";

/**
 * 来源标签：让模型和提示词查看器都能看出这条记忆来自哪个模块。
 * 旧记忆没有 metadata.sourceChannel 时用 sourceApp 兜底。
 */
const SOURCE_LABELS: Record<string, string> = {
    chat: "聊天",
    group_chat: "群聊",
    call: "通话",
    call_end: "通话结尾",
    story: "剧情",
    vn: "视觉小说",
    map: "跑团",
    adventure: "冒险",
    game: "游戏",
    moments: "朋友圈",
    diary: "日记",
    notewall: "便签墙",
    xiaohongshu: "小红书",
    checkphone: "查手机",
    interview_magazine: "访谈",
    cocreate: "共创",
    custom_app: "自定义APP",
    life: "生活",
    life_scene: "生活现场",
    life_autonomy: "生活主动",
    life_offline: "生活离线",
    weixin: "微信",
    reality_bridge: "现实桥",
    offline: "线下",
};

export function memorySourceLabel(entry: MemoryEntry): string {
    const metadata = entry.metadata ?? {};
    const channel = typeof metadata.sourceChannel === "string" ? metadata.sourceChannel : "";
    const sourceModule = typeof metadata.sourceModule === "string" ? metadata.sourceModule : "";
    return SOURCE_LABELS[channel] || SOURCE_LABELS[sourceModule] || SOURCE_LABELS[entry.sourceApp] || entry.sourceApp;
}

function formatMemoryLine(entry: MemoryEntry): string {
    const date = entry.createdAt?.slice(0, 10) || "";
    const label = memorySourceLabel(entry);
    return `- [来源：${label}${date ? `｜${date}` : ""}] ${entry.content}`;
}

/**
 * Format long-term memories for prompt injection.
 * The service layer already handles token-budget filtering,
 * so this just formats the selected entries.
 */
export function formatLongTermMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    return memories.map(formatMemoryLine).join("\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    return memories.map(formatMemoryLine).join("\n");
}
