"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { loadCharacters } from "@/lib/character-storage";
import { characterEarn, characterSpend, ensureCharacterLedger, loadCharacterLedger } from "./character-ledger";
import { sendBrowserNotification } from "@/lib/browser-notification";
import { sendShellNotification } from "@/lib/shell-notify";
import { bgSetInterval } from "@/lib/bg-timer";

export type CharacterIncomeCadence = "weekly" | "monthly";

export type CharacterEconomyProfile = {
    characterId: string;
    /** 一次性初始存款；只在第一次建档时自动入账，之后修改走差额补/扣。 */
    initialDeposit: number;
    initialAppliedAt?: number;
    /** 固定收入金额；0 = 不发。 */
    incomeAmount: number;
    cadence: CharacterIncomeCadence;
    nextIncomeAt: number;
    enabled: boolean;
    /** 档案来源：llm=按角色卡让模型判断；fallback=人设关键词兜底。 */
    source?: "llm" | "fallback";
    /** 模型给出的判断依据，或兜底说明。 */
    basis?: string;
    updatedAt: number;
};

type CharacterEconomyState = { profiles: Record<string, CharacterEconomyProfile> };
const KEY = "ai_phone_character_economy_v1";
registerKvMigration(KEY);
export const CHARACTER_ECONOMY_UPDATED_EVENT = "character-economy-updated";

const CHECK_INTERVAL_MS = 60_000;
let activeStop: (() => void) | null = null;

function money(value: number): number { return Math.round(value * 100) / 100; }
function load(): CharacterEconomyState {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<CharacterEconomyState> : {};
        return { profiles: parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles as Record<string, CharacterEconomyProfile> : {} };
    } catch { return { profiles: {} }; }
}
function save(state: CharacterEconomyState): void {
    kvSet(KEY, JSON.stringify(state));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHARACTER_ECONOMY_UPDATED_EVENT, { detail: state }));
}

export function advanceIncomeAt(from: number, cadence: CharacterIncomeCadence): number {
    return from + (cadence === "weekly" ? 7 : 30) * 86400000;
}

/** 按人设给一个不突兀的初始存款/固定收入；用户可在钱包里改。 */
function personaDefaults(persona: string, personality = "", tags: string[] = []): { initialDeposit: number; incomeAmount: number; cadence: CharacterIncomeCadence; basis: string } {
    const text = [persona, personality, ...(tags || [])].join(" ").toLowerCase();
    if (/(总裁|老板|董事长|ceo|富二代|豪门|继承人)/.test(text)) {
        return { initialDeposit: 200000, incomeAmount: 50000, cadence: "monthly", basis: "人设关键词：高收入/富裕背景" };
    }
    if (/(医生|律师|程序员|工程师|经理|主管|教师|老师|公务员|上班|职员|社畜|设计师)/.test(text)) {
        return { initialDeposit: 30000, incomeAmount: 12000, cadence: "monthly", basis: "人设关键词：稳定职业" };
    }
    if (/(大学生|学生|高中生|考研|读研|留学)/.test(text)) {
        return { initialDeposit: 3000, incomeAmount: 1500, cadence: "monthly", basis: "人设关键词：学生/生活费" };
    }
    if (/(自由职业|画师|作家|摄影师|主播|音乐人|演员|模特)/.test(text)) {
        return { initialDeposit: 10000, incomeAmount: 6000, cadence: "monthly", basis: "人设关键词：自由职业收入" };
    }
    return { initialDeposit: 10000, incomeAmount: 6000, cadence: "monthly", basis: "没有明显职业/身份线索，按普通城市生活兜底" };
}

function applyInitialDeposit(profile: CharacterEconomyProfile): CharacterEconomyProfile {
    if (profile.initialAppliedAt) return profile;
    ensureCharacterLedger(profile.characterId);
    if (profile.initialDeposit > 0) {
        characterEarn(profile.characterId, profile.initialDeposit, "初始存款", "根据角色人设的初始存款", "initial_deposit");
    }
    return { ...profile, initialAppliedAt: Date.now(), updatedAt: Date.now() };
}

/** 新角色第一次进账本：按人设建档并发放初始存款。 */
export function ensureCharacterEconomyProfile(character: { id: string; persona?: string; personality?: string; tags?: string[] }): CharacterEconomyProfile {
    const state = load();
    let profile = state.profiles[character.id];
    if (!profile) {
        const defaults = personaDefaults(character.persona || "", character.personality || "", character.tags || []);
        profile = {
            characterId: character.id,
            initialDeposit: defaults.initialDeposit,
            incomeAmount: defaults.incomeAmount,
            cadence: defaults.cadence,
            nextIncomeAt: advanceIncomeAt(Date.now(), defaults.cadence),
            enabled: true,
            source: "fallback",
            basis: defaults.basis,
            updatedAt: Date.now(),
        };
    }
    const next = applyInitialDeposit(profile);
    if (JSON.stringify(next) !== JSON.stringify(profile) || !state.profiles[character.id]) {
        state.profiles[character.id] = next;
        save(state);
    }
    return next;
}

const inferenceInflight = new Map<string, Promise<CharacterEconomyProfile>>();

/**
 * 第一次建档优先让大模型读完整角色卡判断；失败/模型不可用时退回关键词兜底。
 * 并发调用会复用同一个 promise，避免同角色被重复发初始存款。
 */
export function ensureCharacterEconomyProfileAsync(character: {
    id: string;
    name: string;
    persona?: string;
    personality?: string;
    tags?: string[];
    briefPersona?: string;
}): Promise<CharacterEconomyProfile> {
    const existing = load().profiles[character.id];
    if (existing) {
        const next = applyInitialDeposit(existing);
        if (next.initialAppliedAt !== existing.initialAppliedAt) {
            const state = load();
            state.profiles[character.id] = next;
            save(state);
        }
        return Promise.resolve(next);
    }
    const running = inferenceInflight.get(character.id);
    if (running) return running;
    const task = (async () => {
        let inferred: { initialDeposit: number; incomeAmount: number; cadence: CharacterIncomeCadence; basis: string; source: "llm" | "fallback" };
        try {
            const { inferCharacterEconomy } = await import("./character-income-ai");
            const result = await inferCharacterEconomy(character);
            inferred = { ...result, source: "llm" };
        } catch {
            const fallback = personaDefaults(character.persona || "", character.personality || "", character.tags || []);
            inferred = { ...fallback, source: "fallback" };
        }
        const state = load();
        // 等待模型期间可能有别的入口先建了档，直接复用。
        const raced = state.profiles[character.id];
        if (raced) return applyInitialDeposit(raced);
        let profile: CharacterEconomyProfile = {
            characterId: character.id,
            initialDeposit: inferred.initialDeposit,
            incomeAmount: inferred.incomeAmount,
            cadence: inferred.cadence,
            nextIncomeAt: advanceIncomeAt(Date.now(), inferred.cadence),
            enabled: true,
            source: inferred.source,
            basis: inferred.basis,
            updatedAt: Date.now(),
        };
        profile = applyInitialDeposit(profile);
        state.profiles[character.id] = profile;
        save(state);
        return profile;
    })().finally(() => {
        inferenceInflight.delete(character.id);
    });
    inferenceInflight.set(character.id, task);
    return task;
}

export function loadCharacterEconomyProfile(characterId: string): CharacterEconomyProfile | null {
    return load().profiles[characterId] || null;
}

export function loadCharacterEconomyProfiles(): CharacterEconomyProfile[] {
    return Object.values(load().profiles);
}

export function updateCharacterIncomePlan(characterId: string, patch: {
    incomeAmount?: number;
    cadence?: CharacterIncomeCadence;
    enabled?: boolean;
}): CharacterEconomyProfile {
    const character = loadCharacters().find(item => item.id === characterId);
    if (!character) throw new Error("找不到角色");
    const state = load();
    const base = ensureCharacterEconomyProfile(character);
    const next: CharacterEconomyProfile = {
        ...base,
        ...(patch.incomeAmount !== undefined ? { incomeAmount: Math.max(0, money(patch.incomeAmount)) } : {}),
        ...(patch.cadence ? { cadence: patch.cadence } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        updatedAt: Date.now(),
    };
    // 金额/频率真的变了才从现在重新起算，单纯开关自动收入不推迟下一期。
    const planChanged = next.incomeAmount !== base.incomeAmount || next.cadence !== base.cadence;
    if (planChanged) {
        next.nextIncomeAt = advanceIncomeAt(Date.now(), next.cadence);
    }
    state.profiles[characterId] = next;
    save(state);
    return next;
}

/** 用户改初始存款：已入账的只补/扣差额，不会重复发整笔。 */
export function setCharacterInitialDeposit(characterId: string, amount: number): CharacterEconomyProfile {
    const character = loadCharacters().find(item => item.id === characterId);
    if (!character) throw new Error("找不到角色");
    const state = load();
    const base = ensureCharacterEconomyProfile(character);
    const nextAmount = Math.max(0, money(amount));
    const delta = money(nextAmount - base.initialDeposit);
    if (base.initialAppliedAt && delta !== 0) {
        if (delta > 0) {
            characterEarn(characterId, delta, "初始存款调整", "用户调整了初始存款", "initial_deposit_adjust");
        } else {
            characterSpend(characterId, Math.abs(delta), "初始存款调整", "用户调低了初始存款", "initial_deposit_adjust");
        }
    }
    const next: CharacterEconomyProfile = {
        ...base,
        initialDeposit: nextAmount,
        updatedAt: Date.now(),
    };
    state.profiles[characterId] = next;
    save(state);
    return next;
}

export function runDueCharacterIncomes(now = Date.now()): Array<{ characterId: string; name: string; amount: number; ok: boolean; error?: string }> {
    const state = load();
    const names = new Map(loadCharacters().map(character => [character.id, character.name]));
    const results: Array<{ characterId: string; name: string; amount: number; ok: boolean; error?: string }> = [];
    for (const profile of Object.values(state.profiles)) {
        if (!profile.enabled || profile.incomeAmount <= 0 || profile.nextIncomeAt > now) continue;
        try {
            characterEarn(
                profile.characterId,
                profile.incomeAmount,
                "固定收入",
                profile.cadence === "weekly" ? "每周固定收入（自动入账）" : "每月固定收入（自动入账）",
                "auto_income",
            );
            profile.nextIncomeAt = advanceIncomeAt(now, profile.cadence);
            profile.updatedAt = Date.now();
            results.push({ characterId: profile.characterId, name: names.get(profile.characterId) || "角色", amount: profile.incomeAmount, ok: true });
        } catch (error) {
            profile.nextIncomeAt = now + 86400000;
            results.push({
                characterId: profile.characterId,
                name: names.get(profile.characterId) || "角色",
                amount: profile.incomeAmount,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    save(state);
    return results;
}

function notify(message: string, kind: "success" | "error" | "info"): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message } }));
    if (typeof document === "undefined" || !document.hidden) return;
    if (!sendShellNotification("角色收入", message)) {
        sendBrowserNotification("角色收入", { body: message });
    }
}

async function tick(): Promise<void> {
    try {
        for (const character of loadCharacters()) {
            try {
                await ensureCharacterEconomyProfileAsync(character);
            } catch (error) {
                console.warn("[CharacterIncome] ensure profile failed:", character.id, error);
            }
        }
        for (const result of runDueCharacterIncomes()) {
            if (result.ok) {
                notify(`${result.name} 的固定收入到账 ¥${result.amount.toFixed(2)}`, "success");
            } else {
                notify(`${result.name} 的固定收入发放失败：${result.error || "未知原因"}`, "error");
            }
        }
    } catch (error) {
        console.warn("[CharacterIncome] scheduler tick failed:", error);
    }
}

export function startCharacterIncomeScheduler(): () => void {
    if (typeof window === "undefined") return () => {};
    if (activeStop) return activeStop;
    void tick();
    const stopTimer = bgSetInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
    const handleVisibility = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", tick);
    const stop = () => {
        stopTimer();
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("pageshow", tick);
        if (activeStop === stop) activeStop = null;
    };
    activeStop = stop;
    return stop;
}

export function stopCharacterIncomeScheduler(): void {
    activeStop?.();
}

/** 供 UI 显示：当前余额与最近一笔固定收入。 */
export function characterIncomeSnapshot(characterId: string): { balance: number; lastIncomeAt?: number } {
    const ledger = loadCharacterLedger(characterId);
    const tx = (ledger?.transactions || []).slice().reverse().find(item => item.ref === "auto_income" || item.category === "固定收入");
    return { balance: ledger?.balance || 0, lastIncomeAt: tx?.at };
}

/** 注入聊天提示词：让角色知道自己的真实余额与固定收入，别凭空编钱。 */
export function buildCharacterEconomyContext(characterId: string): string {
    const profile = loadCharacterEconomyProfile(characterId);
    const ledger = loadCharacterLedger(characterId);
    if (!profile || !ledger) return "";
    const cadence = profile.cadence === "weekly" ? "每周" : "每月";
    const income = profile.enabled && profile.incomeAmount > 0
        ? `${cadence}固定收入 ¥${profile.incomeAmount.toFixed(2)}（系统自动入账）`
        : "当前没有开启固定收入";
    return [
        "【你的经济状况】",
        `你的账本余额：¥${ledger.balance.toFixed(2)}。${income}。`,
        "额外收入（项目款、兼职、红包、退款等）和支出必须用「记录角色收入/记录角色支出」记账，不能只在聊天里说数字。",
        "不要主动报余额，除非用户问起或消费/存钱需要。",
    ].join("\n");
}
