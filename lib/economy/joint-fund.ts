"use client";

import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";
import { payWithWalletAccount } from "@/lib/wallet-storage";
import { characterSpend } from "./character-ledger";

export type JointFundMemberType = "user" | "character";

export type JointFundTransaction = {
    id: string;
    fundId: string;
    at: number;
    memberType: JointFundMemberType;
    memberId: string;
    kind: "deposit" | "withdraw" | "adjust";
    amount: number;
    note: string;
    balanceAfter: number;
};

export type JointFundPlan = {
    id: string;
    fundId: string;
    memberType: JointFundMemberType;
    memberId: string;
    cadence: "daily" | "weekly" | "monthly";
    amount: number;
    nextRunAt: number;
    enabled: boolean;
    /** 最近一次已提醒的 nextRunAt；用于避免同一期重复弹提醒。 */
    remindedForRunAt?: number;
    /** 创建来源：用户本人或角色通过工具设置。 */
    createdBy?: "user" | "character_tool";
    /** 角色设置计划时的私聊会话，用于目标完成后回到正确的聊天室询问。 */
    sessionId?: string;
};

export type JointFundPlanRunResult = {
    planId: string;
    fundId: string;
    fundName: string;
    memberType: JointFundMemberType;
    memberId: string;
    sessionId?: string;
    amount: number;
    ok: boolean;
    goalReached?: boolean;
    alreadyCompleted?: boolean;
    otherFunds?: Array<{ id: string; name: string }>;
    error?: string;
};

export type JointFund = {
    id: string;
    name: string;
    goalLabel: string;
    goalAmount: number;
    balance: number;
    userId: string;
    characterId: string;
    status: "active" | "completed" | "paused";
    createdAt: number;
    updatedAt: number;
};

type JointFundState = { funds: JointFund[]; transactions: JointFundTransaction[]; plans: JointFundPlan[] };
const KEY = "ai_phone_joint_funds_v1";
registerKvMigration(KEY);
export const JOINT_FUND_UPDATED_EVENT = "joint-fund-updated";
const MAX_TX = 1000;

function uid(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
function money(value: number): number { return Math.round(value * 100) / 100; }
function load(): JointFundState {
    try {
        const raw = kvGet(KEY);
        const parsed = raw ? JSON.parse(raw) as Partial<JointFundState> : {};
        return {
            funds: Array.isArray(parsed.funds) ? parsed.funds : [],
            transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
            // 旧版界面允许用户代角色创建自动存款计划；迁移时清理这类计划，避免继续替角色扣款。
            plans: Array.isArray(parsed.plans) ? parsed.plans.filter(plan =>
                (plan?.memberType === "user" && plan?.memberId === "user")
                || (plan?.memberType === "character" && plan?.createdBy === "character_tool")
            ) : [],
        };
    } catch { return { funds: [], transactions: [], plans: [] }; }
}
function save(state: JointFundState): void {
    kvSet(KEY, JSON.stringify({ ...state, transactions: state.transactions.slice(0, MAX_TX) }));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(JOINT_FUND_UPDATED_EVENT, { detail: state }));
}

export function loadJointFunds(): JointFund[] { return load().funds.slice().sort((a, b) => b.createdAt - a.createdAt); }
export function loadJointFundTransactions(fundId?: string): JointFundTransaction[] {
    const rows = load().transactions;
    return (fundId ? rows.filter(t => t.fundId === fundId) : rows).slice().sort((a, b) => b.at - a.at);
}
export function loadJointFundPlans(fundId?: string): JointFundPlan[] {
    const rows = load().plans;
    return (fundId ? rows.filter(p => p.fundId === fundId) : rows).slice().sort((a, b) => a.nextRunAt - b.nextRunAt);
}
export function createJointFund(input: { name: string; goalLabel?: string; goalAmount: number; userId: string; characterId: string }): JointFund {
    const state = load();
    const fund: JointFund = {
        id: uid("jf"),
        name: String(input.name || "共同小金库").slice(0, 40),
        goalLabel: String(input.goalLabel || "目标").slice(0, 40),
        goalAmount: Math.max(1, money(input.goalAmount)),
        balance: 0,
        userId: input.userId, characterId: input.characterId,
        status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    };
    state.funds.push(fund);
    save(state);
    return fund;
}
export function depositToJointFund(fundId: string, memberType: JointFundMemberType, memberId: string, amount: number, note: string): { ok: boolean; fund?: JointFund; error?: string } {
    const state = load();
    const fund = state.funds.find(f => f.id === fundId);
    if (!fund) return { ok: false, error: "找不到小金库" };
    if (fund.status === "paused") return { ok: false, error: "小金库已暂停" };
    if (fund.status === "completed") return { ok: false, error: "这个小金库已经达成目标，不能继续存入" };
    const value = money(amount);
    if (value <= 0) return { ok: false, error: "金额无效" };
    if (memberType === "user") {
        const paid = payWithWalletAccount({ amount: value, title: `存入「${fund.name}」`, detail: note || "共同小金库存入", category: "小金库" });
        if (!paid.ok) return { ok: false, error: paid.error || "用户余额不足" };
    } else {
        try { characterSpend(memberId, value, "小金库", note || "共同小金库存入", fund.id); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : "角色余额不足" }; }
    }
    fund.balance = money(fund.balance + value);
    fund.updatedAt = Date.now();
    if (fund.balance >= fund.goalAmount) fund.status = "completed";
    state.transactions.unshift({ id: uid("jft"), fundId, at: Date.now(), memberType, memberId, kind: "deposit", amount: value, note: String(note || "").slice(0, 200), balanceAfter: fund.balance });
    save(state);
    return { ok: true, fund };
}
export function withdrawFromJointFund(fundId: string, memberType: JointFundMemberType, memberId: string, amount: number, note: string): { ok: boolean; fund?: JointFund; error?: string } {
    const state = load();
    const fund = state.funds.find(f => f.id === fundId);
    if (!fund) return { ok: false, error: "找不到小金库" };
    const value = money(amount);
    if (value <= 0 || value > fund.balance) return { ok: false, error: "取出金额无效或超过余额" };
    fund.balance = money(fund.balance - value);
    fund.status = "active";
    fund.updatedAt = Date.now();
    state.transactions.unshift({ id: uid("jft"), fundId, at: Date.now(), memberType, memberId, kind: "withdraw", amount: value, note: String(note || "").slice(0, 200), balanceAfter: fund.balance });
    save(state);
    return { ok: true, fund };
}
function saveJointFundPlan(input: { fundId: string; memberType: JointFundMemberType; memberId: string; cadence: "daily" | "weekly" | "monthly"; amount: number; createdBy: "user" | "character_tool"; sessionId?: string }): JointFundPlan | null {
    const state = load();
    const fund = state.funds.find(f => f.id === input.fundId && f.status === "active");
    if (!fund) return null;
    if (input.memberType === "user" && (input.memberId !== "user" || input.createdBy !== "user")) return null;
    if (input.memberType === "character" && (input.createdBy !== "character_tool" || input.memberId !== fund.characterId)) return null;
    const amount = money(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const now = Date.now();
    const plan: JointFundPlan = {
        id: uid("jfp"), fundId: input.fundId, memberType: input.memberType, memberId: input.memberId,
        cadence: input.cadence, amount, nextRunAt: advanceJointFundRunAt(now, input.cadence), enabled: true,
        createdBy: input.createdBy,
        sessionId: input.sessionId,
    };
    state.plans = state.plans.filter(p => !(p.fundId === input.fundId && p.memberType === input.memberType && p.memberId === input.memberId));
    state.plans.push(plan);
    save(state);
    return plan;
}

/** 用户侧只允许为自己设置计划；不能冒充角色设置。 */
export function setJointFundPlan(input: { fundId: string; memberType: JointFundMemberType; memberId: string; cadence: "daily" | "weekly" | "monthly"; amount: number }): JointFundPlan | null {
    if (input.memberType !== "user" || input.memberId !== "user") return null;
    return saveJointFundPlan({ ...input, createdBy: "user" });
}

/** 角色只能通过自己的工具为自己设置计划，且目标小金库必须属于当前角色。 */
export function setJointFundPlanForCharacter(characterId: string, input: { fundId: string; cadence: "daily" | "weekly" | "monthly"; amount: number; sessionId?: string }): JointFundPlan | null {
    if (!characterId) return null;
    return saveJointFundPlan({ ...input, memberType: "character", memberId: characterId, createdBy: "character_tool" });
}
export function removeJointFundPlan(planId: string): void {
    const state = load();
    state.plans = state.plans.filter(p => p.id !== planId);
    save(state);
}
export function advanceJointFundRunAt(from: number, cadence: JointFundPlan["cadence"]): number {
    return cadence === "daily" ? from + 86400000 : cadence === "weekly" ? from + 7 * 86400000 : from + 30 * 86400000;
}
/** 记录某一期已经提醒过，避免调度器每分钟重复弹。 */
export function markJointFundPlanReminded(planId: string, runAt: number): void {
    const state = load();
    const plan = state.plans.find(p => p.id === planId);
    if (!plan || plan.nextRunAt !== runAt || plan.remindedForRunAt === runAt) return;
    plan.remindedForRunAt = runAt;
    save(state);
}
/**
 * 执行所有到期计划，返回每个计划的结果。
 *
 * 注意：这里不能拿循环开始时的整份快照最后统一 save——depositToJointFund 会自己
 * load/save 并写入余额和流水，用旧快照回写会把刚存入的钱和流水一起抹掉。
 * 每笔之后重新 load，只更新该计划的 nextRunAt。
 */
export function runDueJointFundPlans(now = Date.now()): JointFundPlanRunResult[] {
    const results: JointFundPlanRunResult[] = [];
    const dueState = load();
    const duePlans = dueState.plans.filter(plan => {
        const fund = dueState.funds.find(item => item.id === plan.fundId);
        return plan.enabled && (plan.nextRunAt <= now || fund?.status === "completed");
    });
    for (const plan of duePlans) {
        const fundBefore = load().funds.find(f => f.id === plan.fundId);
        if (!fundBefore) continue;
        // 用户手动存款也可能先一步达成目标；下一次调度检查时应直接结束角色计划，
        // 而不是再向已完成的小金库扣一次钱。
        const alreadyCompleted = fundBefore.status === "completed";
        const result = alreadyCompleted
            ? { ok: true, fund: fundBefore, error: undefined as string | undefined }
            : depositToJointFund(plan.fundId, plan.memberType, plan.memberId, plan.amount, "定时存入");
        // 失败（余额不足等）第二天重试，不要把整期直接跳过去。
        const state = load();
        const completedFund = state.funds.find(f => f.id === plan.fundId);
        const goalReached = Boolean(result.ok && completedFund?.status === "completed");
        const otherFunds = goalReached
            ? state.funds.filter(f => f.characterId === plan.memberId && f.id !== plan.fundId && f.status === "active").map(f => ({ id: f.id, name: f.name }))
            : [];
        const current = state.plans.find(p => p.id === plan.id);
        if (current) {
            if (goalReached) {
                // 目标达成后绝不继续向已完成的小金库存款；有其他目标时交给角色决定是否切换。
                state.plans = state.plans.filter(p => p.id !== plan.id);
            } else {
                current.nextRunAt = result.ok ? advanceJointFundRunAt(now, plan.cadence) : now + 86400000;
                current.remindedForRunAt = undefined;
            }
            save(state);
        }
        results.push({
            planId: plan.id,
            fundId: plan.fundId,
            fundName: fundBefore.name,
            memberType: plan.memberType,
            memberId: plan.memberId,
            sessionId: plan.sessionId,
            amount: plan.amount,
            ok: result.ok,
            goalReached,
            alreadyCompleted,
            otherFunds,
            error: result.error,
        });
    }
    return results;
}
