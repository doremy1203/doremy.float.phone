import type { Prompt, PresetConfig, PromptOrderEntry } from "./settings-types";

/**
 * 预设「单条目」的解析与落位。
 *
 * 顺序这件事在这个应用里有两份真相：`prompts` 数组和 `prompt_order`。
 * 界面显示、以及组装 prompt 时的先后，都以 `prompt_order` 为准、把不在其中的
 * 条目（孤儿）接在后面（见 preset-manager 的渲染与 llm-prompt-assembler 的
 * buildProcessingOrder）。所以插入/覆盖必须在"显示顺序"这份列表上做，
 * 再由它重建两份数据，否则用户看到的位置和实际生效的位置会对不上。
 */

/** 还原成与界面一致的显示顺序：prompt_order 的次序 + 不在其中的孤儿条目。 */
export function displayOrderPrompts(preset: PresetConfig): Prompt[] {
    const ordered = preset.prompt_order && preset.prompt_order.length > 0
        ? preset.prompt_order
            .map(entry => preset.prompts.find(p => p.identifier === entry.identifier))
            .filter((p): p is Prompt => !!p)
        : [...(preset.prompts || [])];
    const seen = new Set(ordered.map(p => p.identifier));
    return [...ordered, ...(preset.prompts || []).filter(p => !seen.has(p.identifier))];
}

/** 按显示顺序重建两份数据，逐条沿用原有的启用状态。 */
function rebuild(preset: PresetConfig, displayed: Prompt[]): PresetConfig {
    return {
        ...preset,
        prompts: displayed,
        prompt_order: displayed.map(p => ({
            identifier: p.identifier,
            enabled: preset.prompt_order?.find(o => o.identifier === p.identifier)?.enabled ?? p.enabled,
        })),
    };
}

/** 单条 prompt 的消毒（与预设管理页的条目导入同一套规则）。 */
export function sanitizePromptEntry(raw: unknown, fallbackIdentifier: string): Prompt | null {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const obj = raw as Record<string, unknown>;
    if (typeof obj.name !== "string" && typeof obj.content !== "string" && typeof obj.identifier !== "string") return null;
    const role = obj.role === "user" || obj.role === "assistant" || obj.role === "system" ? obj.role : "system";
    const prompt: Prompt = {
        identifier: typeof obj.identifier === "string" && obj.identifier ? obj.identifier : fallbackIdentifier,
        name: typeof obj.name === "string" ? obj.name : "",
        role,
        content: typeof obj.content === "string" ? obj.content : "",
        injection_depth: typeof obj.injection_depth === "number" ? obj.injection_depth : 0,
        injection_position: typeof obj.injection_position === "number" ? obj.injection_position : 0,
        enabled: obj.enabled !== false,
        marker: !!obj.marker,
        system_prompt: !!obj.system_prompt,
        forbid_overrides: !!obj.forbid_overrides,
    };
    if (Array.isArray(obj.tags)) prompt.tags = obj.tags.filter((t): t is string => typeof t === "string");
    if (typeof obj.featureTag === "string") prompt.featureTag = obj.featureTag;
    if (typeof obj.followUpOnly === "boolean") prompt.followUpOnly = obj.followUpOnly;
    return prompt;
}

export type ParsedEntryFile =
    | { ok: true; prompt: Prompt }
    /** 整份预设或多条条目：这条路只处理单条，让调用方去引导用户改用「预设」目的地 */
    | { ok: false; reason: "multiple"; count: number }
    | { ok: false; reason: "invalid" };

/**
 * 把文件解析成"一条"预设条目。
 * 接受：单条 prompt 对象、只含一条的数组。
 * 拒绝：整份预设、多条数组——那是「预设」目的地该干的事。
 */
export function parseSinglePromptEntry(text: string): ParsedEntryFile {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, reason: "invalid" };
    }
    if (Array.isArray(raw)) {
        if (raw.length !== 1) return { ok: false, reason: "multiple", count: raw.length };
        const prompt = sanitizePromptEntry(raw[0], `prompt-${Date.now()}`);
        return prompt ? { ok: true, prompt } : { ok: false, reason: "invalid" };
    }
    if (raw && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        // 整份预设有 prompts 数组：它有 name 字段，直接当条目消毒会得到一条空垃圾
        if (Array.isArray(obj.prompts)) {
            return obj.prompts.length === 1
                ? (() => {
                    const prompt = sanitizePromptEntry(obj.prompts[0], `prompt-${Date.now()}`);
                    return prompt ? { ok: true as const, prompt } : { ok: false as const, reason: "invalid" as const };
                })()
                : { ok: false, reason: "multiple", count: obj.prompts.length };
        }
        const prompt = sanitizePromptEntry(raw, `prompt-${Date.now()}`);
        return prompt ? { ok: true, prompt } : { ok: false, reason: "invalid" };
    }
    return { ok: false, reason: "invalid" };
}

/** identifier 撞车时加后缀，避免顶掉预设里已有的条目。 */
function uniqueIdentifier(preset: PresetConfig, wanted: string): string {
    const used = new Set((preset.prompts || []).map(p => p.identifier));
    if (!used.has(wanted)) return wanted;
    let n = 1;
    let id = `${wanted}_${n}`;
    while (used.has(id)) id = `${wanted}_${++n}`;
    return id;
}

/**
 * 插到 afterIdentifier 那一条之后；afterIdentifier 为 null 表示放到最前面。
 * 返回新的预设对象（不落盘，由调用方保存）。
 */
export function insertPromptAfter(preset: PresetConfig, afterIdentifier: string | null, prompt: Prompt): PresetConfig {
    const entry = { ...prompt, identifier: uniqueIdentifier(preset, prompt.identifier) };
    const displayed = displayOrderPrompts(preset);
    if (afterIdentifier === null) {
        displayed.unshift(entry);
    } else {
        const idx = displayed.findIndex(p => p.identifier === afterIdentifier);
        if (idx >= 0) displayed.splice(idx + 1, 0, entry);
        else displayed.push(entry);
    }
    return rebuild(preset, displayed);
}

/**
 * 覆盖 targetIdentifier 那一条，位置不变。
 * 新条目的 identifier 若与预设里"别的"条目撞车，保留被覆盖条目的 identifier，
 * 否则会连带顶掉另一条。
 */
export function replacePromptEntry(preset: PresetConfig, targetIdentifier: string, prompt: Prompt): PresetConfig {
    const clashesElsewhere = prompt.identifier !== targetIdentifier
        && (preset.prompts || []).some(p => p.identifier === prompt.identifier);
    const finalId = clashesElsewhere ? targetIdentifier : prompt.identifier;
    const entry = { ...prompt, identifier: finalId };
    const displayed = displayOrderPrompts(preset).map(p => p.identifier === targetIdentifier ? entry : p);
    return rebuild(preset, displayed);
}

/** 与界面一致的显示顺序，并按 identifier 去重（重复 entry 只保留首个）。 */
function displayOrderPromptsUnique(preset: PresetConfig): Prompt[] {
    const seen = new Set<string>();
    const out: Prompt[] = [];
    for (const prompt of displayOrderPrompts(preset)) {
        if (seen.has(prompt.identifier)) continue;
        seen.add(prompt.identifier);
        out.push(prompt);
    }
    return out;
}

/* ── 选中条目的批量上移 / 下移 ───────────────────────────── */

/**
 * 在显示顺序里把选中的条目朝 direction 方向各挪一格。
 * 选中集内部相对顺序保持不变；返回 null 表示已经到顶/到底，无需改动。
 * 只重建 prompt_order，与单条拖拽保持一致（不重排底层的 prompts 数组）。
 */
export function movePromptEntriesWithinPreset(
    preset: PresetConfig,
    identifiers: ReadonlySet<string>,
    direction: -1 | 1,
): PromptOrderEntry[] | null {
    const displayed = displayOrderPromptsUnique(preset);
    const selected = displayed.filter(p => identifiers.has(p.identifier));
    if (selected.length === 0 || selected.length >= displayed.length) return null;

    const ids = displayed.map(p => p.identifier);
    if (direction < 0) {
        for (let i = 1; i < ids.length; i++) {
            if (identifiers.has(ids[i]) && !identifiers.has(ids[i - 1])) {
                [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
            }
        }
    } else {
        for (let i = ids.length - 2; i >= 0; i--) {
            if (identifiers.has(ids[i]) && !identifiers.has(ids[i + 1])) {
                [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
            }
        }
    }
    if (ids.every((id, index) => id === displayed[index].identifier)) return null;

    const byId = new Map(displayed.map(p => [p.identifier, p]));
    return ids.map(id => {
        const prompt = byId.get(id)!;
        return {
            identifier: id,
            enabled: preset.prompt_order?.find(o => o.identifier === id)?.enabled ?? prompt.enabled,
        };
    });
}

/* ── 跨预设复制 / 移动 ───────────────────────────────────── */

export type PromptTransferMode = "copy" | "move";
export type PromptTransferConflictStrategy = "rename" | "overwrite" | "skip";

export type PromptTransferEntry = {
    prompt: Prompt;
    /** 实际生效的启用状态（prompt_order 优先于 prompt.enabled）。 */
    enabled: boolean;
};

export type PromptTransferResult = {
    source: PresetConfig;
    target: PresetConfig;
    transferred: number;
    skipped: number;
    renamed: number;
};

/** 按显示顺序取出选中的条目，并带上实际生效的启用状态。 */
export function getPromptTransferEntries(
    preset: PresetConfig,
    identifiers: ReadonlySet<string>,
): PromptTransferEntry[] {
    return displayOrderPromptsUnique(preset)
        .filter(prompt => identifiers.has(prompt.identifier))
        .map(prompt => ({
            prompt,
            enabled: preset.prompt_order?.find(o => o.identifier === prompt.identifier)?.enabled ?? prompt.enabled,
        }));
}

/** 目标预设里已经存在的同名条目数量（Marker 单列，便于 UI 提前提示）。 */
export function countPromptTransferConflicts(
    target: PresetConfig,
    entries: PromptTransferEntry[],
): { total: number; markers: number } {
    const used = new Set((target.prompts || []).map(p => p.identifier));
    let total = 0;
    let markers = 0;
    for (const entry of entries) {
        if (!used.has(entry.prompt.identifier)) continue;
        total += 1;
        if (entry.prompt.marker) markers += 1;
    }
    return { total, markers };
}

function clonePrompt(prompt: Prompt): Prompt {
    return {
        ...prompt,
        ...(prompt.tags ? { tags: [...prompt.tags] } : {}),
    };
}

function makeUniqueIdentifier(wanted: string, used: Set<string>): string {
    const base = wanted || "prompt";
    if (!used.has(base)) return base;
    let n = 2;
    let id = `${base}_${n}`;
    while (used.has(id)) id = `${base}_${++n}`;
    return id;
}

/** 复制总是生成新 id（Marker 除外——它的 identifier 是注入定位标记）。 */
function makeCopiedIdentifier(wanted: string, used: Set<string>): string {
    const base = `${wanted || "prompt"}_copy`;
    if (!used.has(base)) return base;
    let n = 2;
    let id = `${base}${n}`;
    while (used.has(id)) id = `${base}${++n}`;
    return id;
}

/**
 * 把 source 里选中的条目复制/移动到 target。
 *
 * - 选中的条目按 source 的显示顺序成组追加到 target 末尾，保持相邻与相对顺序；
 * - tags / marker / role / depth 等字段原样保留（分组、启用状态不丢）；
 * - 复制出的普通条目换新 identifier；移动尽量沿用原 identifier；
 * - 同名冲突按 strategy 处理：skip 原样跳过、overwrite 原位替换、rename 生成新 id
 *   （Marker 改名会失去标记作用，因此 rename 策略下 Marker 同名一律跳过）；
 * - 移动会从 source 的 prompts 与 prompt_order 中移除这些条目。
 *
 * 纯函数：不落盘，由调用方决定是否保存。
 */
export function transferPromptsBetweenPresets(
    source: PresetConfig,
    target: PresetConfig,
    identifiers: ReadonlySet<string>,
    mode: PromptTransferMode,
    strategy: PromptTransferConflictStrategy,
): PromptTransferResult {
    const entries = getPromptTransferEntries(source, identifiers);
    const targetDisplayed = displayOrderPromptsUnique(target);
    const used = new Set(targetDisplayed.map(p => p.identifier));
    const transferredEnabled = new Map<string, boolean>();
    let transferred = 0;
    let skipped = 0;
    let renamed = 0;

    for (const entry of entries) {
        const prompt = entry.prompt;
        const conflictIndex = targetDisplayed.findIndex(p => p.identifier === prompt.identifier);
        let identifier = prompt.identifier;
        let overwriteIndex = -1;

        if (conflictIndex >= 0) {
            if (strategy === "skip") {
                skipped++;
                continue;
            }
            if (strategy === "overwrite") {
                overwriteIndex = conflictIndex;
            } else if (prompt.marker) {
                skipped++;
                continue;
            } else {
                identifier = makeUniqueIdentifier(prompt.identifier, used);
                renamed++;
            }
        } else if (mode === "copy" && !prompt.marker) {
            identifier = makeCopiedIdentifier(prompt.identifier, used);
            renamed++;
        }

        const nextPrompt: Prompt = {
            ...clonePrompt(prompt),
            identifier,
            enabled: entry.enabled,
        };
        used.add(identifier);
        transferredEnabled.set(identifier, entry.enabled);

        if (overwriteIndex >= 0) targetDisplayed[overwriteIndex] = nextPrompt;
        else targetDisplayed.push(nextPrompt);
        transferred++;
    }

    const hadOrder = (target.prompt_order?.length ?? 0) > 0;
    const existingEnabled = new Map((target.prompt_order ?? []).map(o => [o.identifier, o.enabled]));
    const targetOrder: PromptOrderEntry[] | undefined = hadOrder
        ? targetDisplayed.map(p => ({
            identifier: p.identifier,
            enabled: transferredEnabled.get(p.identifier)
                ?? existingEnabled.get(p.identifier)
                ?? p.enabled,
        }))
        : target.prompt_order;

    const now = Date.now();
    const nextTarget: PresetConfig = {
        ...target,
        prompts: targetDisplayed,
        updatedAt: now,
        ...(targetOrder !== undefined ? { prompt_order: targetOrder } : {}),
    };

    let nextSource = source;
    if (mode === "move") {
        nextSource = {
            ...source,
            prompts: (source.prompts || []).filter(p => !identifiers.has(p.identifier)),
            updatedAt: now,
            ...(source.prompt_order
                ? { prompt_order: source.prompt_order.filter(o => !identifiers.has(o.identifier)) }
                : {}),
        };
    }

    return { source: nextSource, target: nextTarget, transferred, skipped, renamed };
}
