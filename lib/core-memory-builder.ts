import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { loadStorySessions, resolveStoryMemorySettings } from "./story-storage";

const coreBuildingSet = new Set<string>();

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean; additionalSummary?: { content: string; createdAt: string; sourceApp: MemoryEntry["sourceApp"]; sourceSessionIds: string[] } },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    const storedLongTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    const storySessionsById = new Map(loadStorySessions().map((session) => [session.id, session]));
    // 长期记忆可能汇总多个来源；若一条摘要包含明确禁止写入核心记忆的分线，
    // 保守地整条排除，避免聚合摘要绕过分线的核心记忆权限。
    const allLongTermEntries = storedLongTermEntries.filter((entry) => {
        const sourceIds = Array.isArray(entry.metadata?.sourceSessionIds)
            ? entry.metadata.sourceSessionIds.map(String)
            : [];
        return !sourceIds.some((id) => {
            const session = storySessionsById.get(id);
            return Boolean(session && !resolveStoryMemorySettings(session).writeCoreMemory);
        });
    });

    if (allLongTermEntries.length === 0 && !options?.additionalSummary?.content.trim()) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = allLongTermEntries
        .filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp)
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }));
    if (options?.additionalSummary?.content.trim()) {
        entries.push({
            id: `mem_core_ephemeral_${options.additionalSummary.createdAt}`,
            timestamp: options.additionalSummary.createdAt,
            content: options.additionalSummary.content,
            sourceApp: options.additionalSummary.sourceApp,
            sourceSessionIds: [...options.additionalSummary.sourceSessionIds],
        });
    }
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    const { eventsText, earliest, latest } = formatted;
    const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    const prompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText)
        .replace(/\{\{longTermMemories\}\}/gi, eventsText);

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) {
        return { success: false, error: "核心记忆总结结果为空" };
    }

    const now = new Date().toISOString();
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));

    const coreEntry: MemoryEntry = {
        id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSource,
        type: "core",
        content: summary,
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    return { success: true, rebuiltCount: 1 };
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
