// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];
    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    /** 独立控制哪些来源参与长期记忆总结；不影响短期提示词注入。 */
    longTermAllowedSources?: {
        chat?: boolean; group_chat?: boolean; moments?: boolean; checkphone?: boolean; diary?: boolean;
        xiaohongshu?: boolean; interview_magazine?: boolean; cocreate?: boolean; game?: boolean;
        story?: boolean; vn?: boolean; adventure?: boolean; custom_app?: boolean; photo_wall?: boolean;
        life?: boolean; phone_widget?: boolean; watch?: boolean; global_watch?: boolean;
    };
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
        photo_wall?: boolean;
        life?: boolean;
        phone_widget?: boolean;
        watch?: boolean;
        global_watch?: boolean;
    };
    /** 每个消费 APP 从所有已允许来源合并读取的短期记忆总条数上限；0=不限制。最终仍受 shortTermTokenBudget 约束。 */
    /** Internal one-time settings migration marker; does not affect stored memories. */
    shortTermLimitVersion?: number;
    shortTermAppLimits?: {
        chat?: number; group_chat?: number; life?: number; photo_wall?: number; watch?: number;
        global_watch?: number; phone_widget?: number; story?: number; vn?: number; adventure?: number;
        interview_magazine?: number; cocreate?: number; diary?: number; moments?: number;
        checkphone?: number; xiaohongshu?: number; game?: number; map?: number; custom_app?: number;
    };
    /** @deprecated 旧版按来源裁剪；保留读取兼容，不再作为注入上限。 */
    shortTermSourceLimits?: {
        chat?: number;
        group_chat?: number;
        moments?: number;
        checkphone?: number;
        photo_wall?: number;
        life?: number;
        phone_widget?: number;
        watch?: number;
        global_watch?: number;
        story?: number;
        vn?: number;
        map?: number;
        game?: number;
        diary?: number;
        xiaohongshu?: number;
        interview_magazine?: number;
        cocreate?: number;
        custom_app?: number;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 用第三人称描述{{char}}和用户之间的互动
- 保留关键事实：提到的名字、做出的承诺、情感变化、关系里程碑
- 保留用户分享的具体信息（生日、偏好、习惯）
- 保留朋友圈等非聊天事件中的关键信息
- 100-200字
- 不要包含格式标记

总结：`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    longTermAllowedSources: {
        chat: true, group_chat: true, moments: true, checkphone: true, diary: true,
        xiaohongshu: true, interview_magazine: true, cocreate: true, game: true,
        story: true, vn: true, adventure: true, custom_app: true, photo_wall: true,
        life: true, phone_widget: true, watch: true, global_watch: true,
    },
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
        photo_wall: true,
        life: true,
        phone_widget: true,
        watch: true,
        global_watch: true,
    },
    shortTermAppLimits: {
        chat: 0, group_chat: 0, life: 0, photo_wall: 8, watch: 8, global_watch: 5,
        phone_widget: 50, story: 12, vn: 12, adventure: 8, interview_magazine: 8,
        cocreate: 8, diary: 8, moments: 10, checkphone: 6, xiaohongshu: 8,
        game: 8, map: 8, custom_app: 10,
    },
    shortTermSourceLimits: {
        chat: 30, group_chat: 20, moments: 10, checkphone: 6,
        photo_wall: 8, life: 10, phone_widget: 4, watch: 5, global_watch: 4,
        story: 10, vn: 10, map: 8, game: 8, diary: 8, xiaohongshu: 8,
        interview_magazine: 8, cocreate: 8, custom_app: 10,
    },
};
