/**
 * 把内置预设里「新增但当前预设没有」的条目补进去。
 *
 * 规则（按用户要求）：
 *  · 只补缺失的 identifier，已有条目一律不覆盖（用户的改动不动）
 *  · 新增条目追加到末尾，不重排已有条目
 *  · prompt_order 同步追加，默认启用
 */
import { BUILTIN_PRESET_VERSION, createBuiltinPreset } from "./builtin-preset";
import { loadPresets, savePresets } from "./settings-storage";
import type { PresetConfig, Prompt } from "./settings-types";
import { kvGet, kvSet } from "./kv-db";

export type PresetSyncResult = {
    presetId: string;
    name: string;
    added: number;
};

export function syncBuiltinEntriesIntoPreset(preset: PresetConfig): { preset: PresetConfig; added: string[] } {
    const builtin = createBuiltinPreset();
    const have = new Set((preset.prompts || []).map((p) => p.identifier));
    const missing = (builtin.prompts || []).filter((p) => p && p.identifier && !have.has(p.identifier));
    if (!missing.length) return { preset, added: [] };
    const cloned = missing.map((p) => JSON.parse(JSON.stringify(p)) as Prompt);
    const orderIds = new Set((preset.prompt_order || []).map((o) => o.identifier));
    const nextOrder = [...(preset.prompt_order || [])];
    for (const p of cloned) {
        if (!orderIds.has(p.identifier)) {
            orderIds.add(p.identifier);
            nextOrder.push({ identifier: p.identifier, enabled: true });
        }
    }
    return {
        preset: {
            ...preset,
            prompts: [...(preset.prompts || []), ...cloned],
            prompt_order: nextOrder,
            updatedAt: Date.now(),
        },
        added: cloned.map((p) => p.name || p.identifier),
    };
}

/** 对所有预设执行补全（内置那份也会补，但不会覆盖已有内容）。 */
export function syncBuiltinEntriesIntoAllPresets(): PresetSyncResult[] {
    const presets = loadPresets();
    const results: PresetSyncResult[] = [];
    const next = presets.map((preset) => {
        const { preset: merged, added } = syncBuiltinEntriesIntoPreset(preset);
        if (added.length) results.push({ presetId: preset.id, name: preset.name, added: added.length });
        return merged;
    });
    if (results.length) savePresets(next);
    return results;
}

/* ── 批量补全与版本提示 ───────────────────────────────────── */

/** 所有预设的缺失情况（用于「全部补全」按钮和角标提示）。 */
export type PresetSyncStatus = {
    missing: number;
    affected: Array<{ id: string; name: string; missing: number }>;
    version: number;
    dismissed: boolean;
};

const HINT_DISMISS_KEY = "ai_phone_preset_sync_hint_dismissed_v1";

export function presetSyncStatus(): PresetSyncStatus {
    const builtin = createBuiltinPreset();
    const builtinIds = new Set((builtin.prompts || []).map((p) => p.identifier));
    const affected: PresetSyncStatus["affected"] = [];
    let missing = 0;
    for (const preset of loadPresets()) {
        const have = new Set((preset.prompts || []).map((p) => p.identifier));
        const count = Array.from(builtinIds).filter((id) => !have.has(id)).length;
        if (count > 0) {
            affected.push({ id: preset.id, name: preset.name, missing: count });
            missing += count;
        }
    }
    let dismissed = false;
    try {
        dismissed = kvGet(HINT_DISMISS_KEY) === String(BUILTIN_PRESET_VERSION);
    } catch { /* 读不到就当没忽略 */ }
    return { missing, affected, version: BUILTIN_PRESET_VERSION, dismissed };
}

export function dismissPresetSyncHint(): void {
    try {
        kvSet(HINT_DISMISS_KEY, String(BUILTIN_PRESET_VERSION));
    } catch { /* 忽略 */ }
}
