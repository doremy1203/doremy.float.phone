"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import type { CheckPhoneAssetActivity, CheckPhoneAssetsPayload } from "@/lib/checkphone-config";

export type CharacterTransactionKind = "income" | "expense" | "transfer" | "card" | "joint" | "investment";
export type CharacterIncomeCategory = "工资" | "项目" | "兼职" | "投资" | "捡到钱" | "红包" | "退款" | "其他";
export type CharacterExpenseCategory = "餐饮" | "购物" | "交通" | "送礼" | "生活" | "娱乐" | "投资" | "其他";

export type CharacterLedgerTransaction = {
    id: string;
    characterId: string;
    at: number;
    kind: CharacterTransactionKind;
    amount: number;
    category: string;
    note: string;
    ref?: string;
    balanceAfter: number;
};

export type CharacterWeeklyStatement = {
    id: string;
    characterId: string;
    weekKey: string;
    weekStart: string;
    weekEnd: string;
    opening: number;
    income: number;
    expense: number;
    closing: number;
    categories: Record<string, number>;
    transactionCount: number;
    generatedAt: number;
};

export type CharacterLedger = {
    version: 1;
    characterId: string;
    balance: number;
    transactions: CharacterLedgerTransaction[];
    statements: CharacterWeeklyStatement[];
    updatedAt: number;
};

const KEY = "ai_phone_character_ledgers_v1";
registerKvMigration(KEY);
export const CHARACTER_LEDGER_UPDATED_EVENT = "character-ledger-updated";
const MAX_TRANSACTIONS = 500;
const MAX_STATEMENTS = 26;

function uid(prefix: string): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}_${crypto.randomUUID()}`;
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadMap(): Record<string, CharacterLedger> {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, CharacterLedger>
            : {};
    } catch {
        return {};
    }
}

function saveMap(map: Record<string, CharacterLedger>): void {
    kvSet(KEY, JSON.stringify(map));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHARACTER_LEDGER_UPDATED_EVENT));
}

export function loadCharacterLedger(characterId: string): CharacterLedger | null {
    if (!characterId) return null;
    return loadMap()[characterId] ?? null;
}

export function ensureCharacterLedger(characterId: string): CharacterLedger {
    const map = loadMap();
    const existing = map[characterId];
    if (existing) return existing;
    const ledger: CharacterLedger = {
        version: 1,
        characterId,
        balance: 0,
        transactions: [],
        statements: [],
        updatedAt: Date.now(),
    };
    map[characterId] = ledger;
    saveMap(map);
    return ledger;
}

function weekBounds(at: number): { weekKey: string; weekStart: string; weekEnd: string } {
    const date = new Date(at);
    const day = (date.getDay() + 6) % 7; // Monday = 0
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - day);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const weekStart = iso(start);
    return { weekKey: weekStart, weekStart, weekEnd: iso(end) };
}

function rebuildStatements(ledger: CharacterLedger): void {
    const groups = new Map<string, CharacterLedgerTransaction[]>();
    for (const tx of ledger.transactions) {
        const { weekKey } = weekBounds(tx.at);
        const list = groups.get(weekKey) || [];
        list.push(tx);
        groups.set(weekKey, list);
    }
    const statements: CharacterWeeklyStatement[] = [];
    for (const [weekKey, txs] of groups) {
        const sorted = txs.slice().sort((a, b) => a.at - b.at);
        const income = sorted.filter(t => t.amount > 0).reduce((n, t) => n + t.amount, 0);
        const expense = sorted.filter(t => t.amount < 0).reduce((n, t) => n - t.amount, 0);
        const first = sorted[0];
        const opening = Math.max(0, Math.round((first.balanceAfter - first.amount) * 100) / 100);
        const last = sorted[sorted.length - 1];
        const categories: Record<string, number> = {};
        for (const tx of sorted) categories[tx.category] = Math.round(((categories[tx.category] || 0) + Math.abs(tx.amount)) * 100) / 100;
        const bounds = weekBounds(first.at);
        statements.push({
            id: `cws_${ledger.characterId}_${weekKey}`,
            characterId: ledger.characterId,
            weekKey,
            weekStart: bounds.weekStart,
            weekEnd: bounds.weekEnd,
            opening: Math.round(opening * 100) / 100,
            income: Math.round(income * 100) / 100,
            expense: Math.round(expense * 100) / 100,
            closing: Math.round(last.balanceAfter * 100) / 100,
            categories,
            transactionCount: sorted.length,
            generatedAt: Date.now(),
        });
    }
    ledger.statements = statements.sort((a, b) => b.weekKey.localeCompare(a.weekKey)).slice(0, MAX_STATEMENTS);
}

export function characterEarn(characterId: string, amount: number, category: string, note: string, ref?: string): CharacterLedger {
    return recordCharacterTransaction(characterId, Math.abs(amount), "income", category, note, ref);
}

export function characterSpend(characterId: string, amount: number, category: string, note: string, ref?: string): CharacterLedger {
    return recordCharacterTransaction(characterId, -Math.abs(amount), "expense", category, note, ref);
}

export function recordCharacterTransaction(
    characterId: string,
    signedAmount: number,
    kind: CharacterTransactionKind,
    category: string,
    note: string,
    ref?: string,
): CharacterLedger {
    if (!characterId) throw new Error("缺少角色");
    if (!Number.isFinite(signedAmount) || signedAmount === 0) throw new Error("金额必须是非零数字");
    const map = loadMap();
    const ledger = map[characterId] || {
        version: 1, characterId, balance: 0, transactions: [], statements: [], updatedAt: Date.now(),
    };
    const rounded = Math.round(signedAmount * 100) / 100;
    const nextBalance = Math.round((ledger.balance + rounded) * 100) / 100;
    if (nextBalance < 0) throw new Error("角色余额不足");
    const tx: CharacterLedgerTransaction = {
        id: uid("ctx"),
        characterId,
        at: Date.now(),
        kind,
        amount: rounded,
        category: String(category || "其他").slice(0, 20),
        note: String(note || "").slice(0, 200),
        ref: ref ? String(ref).slice(0, 200) : undefined,
        balanceAfter: nextBalance,
    };
    ledger.balance = nextBalance;
    ledger.transactions = [...ledger.transactions, tx].slice(-MAX_TRANSACTIONS);
    ledger.updatedAt = Date.now();
    rebuildStatements(ledger);
    map[characterId] = ledger;
    saveMap(map);
    return ledger;
}

export function latestCharacterStatement(characterId: string): CharacterWeeklyStatement | null {
    const ledger = loadCharacterLedger(characterId);
    if (!ledger) return null;
    rebuildStatements(ledger);
    return ledger.statements[0] ?? null;
}

function money(value: number): string {
    return `¥${Math.round(value * 100) / 100}`;
}

/** 把真实角色账本映射成查手机“资产”页的数据，不再交给 LLM 编造。 */
export function buildCharacterLedgerAssetsPayload(characterId: string, characterName: string): CheckPhoneAssetsPayload {
    const ledger = ensureCharacterLedger(characterId);
    rebuildStatements(ledger);
    const map = loadMap();
    map[characterId] = ledger;
    saveMap(map);
    const latest = ledger.statements[0];
    const activities: CheckPhoneAssetActivity[] = ledger.transactions.slice(-30).reverse().map(tx => ({
        id: tx.id,
        title: tx.note || tx.category,
        amount: `${tx.amount > 0 ? "+" : "-"}${money(Math.abs(tx.amount))}`,
        category: tx.category,
        createdAt: new Date(tx.at).toISOString(),
        accountId: "ledger_cash",
        detail: `${tx.kind === "income" ? "收入" : tx.kind === "expense" ? "支出" : tx.kind} · 余额 ${money(tx.balanceAfter)}${tx.ref ? ` · ${tx.ref}` : ""}`,
    }));
    return {
        headerTitle: `${characterName} 的资产`,
        headerSubtitle: latest
            ? `真实账本 · 本周收入 ${money(latest.income)} · 支出 ${money(latest.expense)} · 结余 ${money(latest.closing)}`
            : "真实账本 · 还没有收支记录",
        headline: { totalLabel: "账户余额", periodLabel: "真实流水与每周账单" },
        accounts: [{
            id: "ledger_cash",
            title: "现金账户",
            kind: "cash",
            bankLabel: "角色账本",
            maskedNumber: "",
            cardStyle: "obsidian",
            balance: money(ledger.balance),
            note: latest ? `本周结余 ${money(latest.closing)}` : "等待第一笔收入或支出",
            accentLabel: "常用",
        }],
        activities,
    };
}
