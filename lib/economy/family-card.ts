"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { payWithWalletAccount } from "@/lib/wallet-storage";
import { characterSpend } from "./character-ledger";

export type FamilyCardMemberType = "user" | "character";

export type FamilyCardTransaction = {
    id: string;
    cardId: string;
    at: number;
    amount: number;
    title: string;
    detail: string;
    category: string;
    usedAfter: number;
};

export type FamilyCard = {
    id: string;
    issuerType: FamilyCardMemberType;
    issuerId: string;
    beneficiaryType: FamilyCardMemberType;
    beneficiaryId: string;
    label: string;
    monthlyLimit: number;
    usedThisPeriod: number;
    periodStart: string;
    resetDay: number;
    status: "active" | "paused";
    color: string;
    createdAt: number;
    updatedAt: number;
};

type FamilyCardState = { cards: FamilyCard[]; transactions: FamilyCardTransaction[] };
const KEY = "ai_phone_family_cards_v1";
registerKvMigration(KEY);
export const FAMILY_CARD_UPDATED_EVENT = "family-card-updated";
const MAX_TX = 500;

function uid(): string { return `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function money(value: number): number { return Math.round(value * 100) / 100; }
function periodKey(date = new Date()): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`; }

function load(): FamilyCardState {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<FamilyCardState> : {};
        return { cards: Array.isArray(parsed.cards) ? parsed.cards : [], transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [] };
    } catch { return { cards: [], transactions: [] }; }
}
function save(state: FamilyCardState): FamilyCardState {
    kvSet(KEY, JSON.stringify({ cards: state.cards, transactions: state.transactions.slice(0, MAX_TX) }));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(FAMILY_CARD_UPDATED_EVENT, { detail: state }));
    return state;
}
function refreshPeriods(state: FamilyCardState): boolean {
    const key = periodKey();
    let changed = false;
    for (const card of state.cards) {
        if (card.periodStart !== key) { card.periodStart = key; card.usedThisPeriod = 0; card.updatedAt = Date.now(); changed = true; }
    }
    return changed;
}
export function loadFamilyCards(): FamilyCard[] {
    const state = load();
    if (refreshPeriods(state)) save(state);
    return state.cards.slice().sort((a, b) => b.createdAt - a.createdAt);
}
export function loadFamilyCardTransactions(cardId?: string): FamilyCardTransaction[] {
    const rows = load().transactions;
    return (cardId ? rows.filter(t => t.cardId === cardId) : rows).slice().sort((a, b) => b.at - a.at);
}
function createFamilyCardRecord(input: {
    issuerType: FamilyCardMemberType; issuerId: string;
    beneficiaryType: FamilyCardMemberType; beneficiaryId: string;
    label: string; monthlyLimit: number; resetDay?: number; color?: string;
}): FamilyCard {
    const state = load();
    const card: FamilyCard = {
        id: uid(),
        issuerType: input.issuerType, issuerId: input.issuerId,
        beneficiaryType: input.beneficiaryType, beneficiaryId: input.beneficiaryId,
        label: String(input.label || "亲属卡").slice(0, 40),
        monthlyLimit: Math.max(1, money(input.monthlyLimit)),
        usedThisPeriod: 0, periodStart: periodKey(),
        resetDay: Math.max(1, Math.min(28, Math.round(input.resetDay || 1))),
        status: "active", color: input.color || "#d8b4a0",
        createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.cards.push(card);
    save(state);
    return card;
}

/** 用户只能给角色发卡；角色给用户发卡必须由角色工具在角色身份上下文中创建。 */
export function createFamilyCard(input: {
    beneficiaryId: string;
    label: string;
    monthlyLimit: number;
    resetDay?: number;
    color?: string;
}): FamilyCard {
    if (!input.beneficiaryId || input.beneficiaryId === "user") {
        throw new Error("亲属卡必须由用户发放给指定角色");
    }
    return createFamilyCardRecord({
        ...input,
        issuerType: "user",
        issuerId: "user",
        beneficiaryType: "character",
    });
}

/** 仅供当前角色的工具执行器调用，不能由用户界面代替角色发卡。 */
export function createFamilyCardForCharacter(characterId: string, input: {
    label: string;
    monthlyLimit: number;
    resetDay?: number;
    color?: string;
}): FamilyCard {
    if (!characterId || characterId === "user") throw new Error("缺少有效的角色身份");
    return createFamilyCardRecord({
        ...input,
        issuerType: "character",
        issuerId: characterId,
        beneficiaryType: "user",
        beneficiaryId: "user",
    });
}
export function updateFamilyCard(cardId: string, patch: Partial<Pick<FamilyCard, "label" | "monthlyLimit" | "status" | "color">>): FamilyCard | null {
    const state = load();
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return null;
    if (patch.label !== undefined) card.label = String(patch.label).slice(0, 40);
    if (patch.monthlyLimit !== undefined) card.monthlyLimit = Math.max(1, money(patch.monthlyLimit));
    if (patch.status) card.status = patch.status;
    if (patch.color) card.color = patch.color;
    card.updatedAt = Date.now();
    save(state);
    return card;
}
export function spendWithFamilyCard(cardId: string, amount: number, title: string, detail: string, category = "消费"): { ok: boolean; card?: FamilyCard; transactionId?: string; error?: string } {
    const state = load();
    refreshPeriods(state);
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { ok: false, error: "找不到这张亲属卡" };
    if (card.status !== "active") return { ok: false, error: "亲属卡已暂停" };
    const spend = money(amount);
    if (spend <= 0) return { ok: false, error: "金额无效" };
    if (money(card.usedThisPeriod + spend) > card.monthlyLimit) return { ok: false, error: "超过本月额度" };
    let transactionId: string | undefined;
    if (card.issuerType === "user") {
        const paid = payWithWalletAccount({ amount: spend, title, detail, category });
        if (!paid.ok) return { ok: false, error: paid.error || "用户钱包扣款失败" };
        transactionId = paid.transaction?.id;
    } else {
        try {
            const ledger = characterSpend(card.issuerId, spend, category, `亲属卡：${detail}`, card.id);
            transactionId = ledger.transactions[ledger.transactions.length - 1]?.id;
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : "角色余额不足" };
        }
    }
    card.usedThisPeriod = money(card.usedThisPeriod + spend);
    card.updatedAt = Date.now();
    state.transactions.unshift({
        id: uid(), cardId: card.id, at: Date.now(), amount: spend,
        title: String(title).slice(0, 80), detail: String(detail).slice(0, 200),
        category, usedAfter: card.usedThisPeriod,
    });
    save(state);
    return { ok: true, card, transactionId };
}
