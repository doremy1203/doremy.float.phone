import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { payWithWalletBalance } from "./wallet-storage";

const KEY = "ai_phone_wallet_planning_v1";
registerKvMigration(KEY);

export type WalletBudget = { id: string; month: string; category: string; limit: number; createdAt: string };
export type WalletSavingsGoal = { id: string; title: string; target: number; saved: number; deadline?: string; createdAt: string };
export type WalletRecurringBill = {
  id: string; title: string; amount: number; category: string;
  cadence: "weekly" | "monthly"; nextDueAt: string;
  status: "active" | "paused" | "overdue"; lastPaidAt?: string; lastError?: string;
};
export type WalletPlanningState = {
  budgets: WalletBudget[];
  goals: WalletSavingsGoal[];
  bills: WalletRecurringBill[];
  updatedAt: string;
};

const id = (prefix: string) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const money = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.round(n * 100) / 100) : 0;
};
function normalize(raw: unknown): WalletPlanningState {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const asRecord = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" ? value as Record<string, unknown> : {};
  const budgets = Array.isArray(data.budgets) ? data.budgets.filter(Boolean).map(entry => {
    const v = asRecord(entry);
    return {
      id: String(v.id || id("budget")),
      month: /^\\d{4}-\\d{2}$/.test(String(v.month)) ? String(v.month) : new Date().toISOString().slice(0, 7),
      category: String(v.category || "其他").slice(0, 32),
      limit: money(v.limit),
      createdAt: String(v.createdAt || new Date().toISOString()),
    };
  }) : [];
  const goals = Array.isArray(data.goals) ? data.goals.filter(Boolean).map(entry => {
    const v = asRecord(entry);
    return {
      id: String(v.id || id("goal")),
      title: String(v.title || "储蓄目标").slice(0, 60),
      target: money(v.target),
      saved: money(v.saved),
      deadline: v.deadline ? String(v.deadline) : undefined,
      createdAt: String(v.createdAt || new Date().toISOString()),
    };
  }) : [];
  const bills = Array.isArray(data.bills) ? data.bills.filter(Boolean).map(entry => {
    const v = asRecord(entry);
    return {
      id: String(v.id || id("bill")),
      title: String(v.title || "周期账单").slice(0, 60),
      amount: money(v.amount),
      category: String(v.category || "固定支出").slice(0, 32),
      cadence: v.cadence === "weekly" ? "weekly" as const : "monthly" as const,
      nextDueAt: String(v.nextDueAt || new Date().toISOString()),
      status: (v.status === "paused" || v.status === "overdue" ? v.status : "active") as WalletRecurringBill["status"],
      lastPaidAt: v.lastPaidAt ? String(v.lastPaidAt) : undefined,
      lastError: v.lastError ? String(v.lastError).slice(0, 160) : undefined,
    };
  }) : [];
  return { budgets, goals, bills, updatedAt: String(data.updatedAt || new Date().toISOString()) };
}
export function loadWalletPlanning(): WalletPlanningState {
  if (typeof window === "undefined") return normalize(null);
  try { return normalize(JSON.parse(kvGet(KEY) || "{}")); } catch { return normalize(null); }
}
export function saveWalletPlanning(state: WalletPlanningState): WalletPlanningState {
  const next = { ...normalize(state), updatedAt: new Date().toISOString() };
  kvSet(KEY, JSON.stringify(next));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("wallet-planning-updated", { detail: next }));
  return next;
}
export function addWalletBudget(input: { month: string; category: string; limit: number }): WalletPlanningState {
  const state = loadWalletPlanning();
  const category = input.category.trim().slice(0,32);
  const limit = money(input.limit);
  if (!category || !/^\d{4}-\d{2}$/.test(input.month) || limit <= 0) throw new Error("请填写有效的分类、月份和预算金额。");
  const existing = state.budgets.find(v => v.month === input.month && v.category === category);
  if (existing) return saveWalletPlanning({ ...state, budgets: state.budgets.map(v => v.id === existing.id ? { ...v, limit } : v) });
  return saveWalletPlanning({ ...state, budgets: [{ id: id("budget"), month: input.month, category, limit, createdAt: new Date().toISOString() }, ...state.budgets] });
}
export function removeWalletBudget(budgetId: string): WalletPlanningState {
  const state = loadWalletPlanning();
  return saveWalletPlanning({ ...state, budgets: state.budgets.filter(v => v.id !== budgetId) });
}
export function addWalletSavingsGoal(input: { title: string; target: number; deadline?: string }): WalletPlanningState {
  const state = loadWalletPlanning();
  const title = input.title.trim().slice(0,60), target = money(input.target);
  if (!title || target <= 0) throw new Error("请填写目标名称和有效金额。");
  return saveWalletPlanning({ ...state, goals: [{ id: id("goal"), title, target, saved: 0, deadline: input.deadline || undefined, createdAt: new Date().toISOString() }, ...state.goals] });
}
export function contributeToWalletGoal(goalId: string, amount: number): WalletPlanningState {
  const value = money(amount);
  if (value <= 0) throw new Error("存入金额必须大于 0。");
  const state = loadWalletPlanning();
  const goal = state.goals.find(v => v.id === goalId);
  if (!goal) throw new Error("找不到这个储蓄目标。");
  if (goal.saved >= goal.target) throw new Error("这个目标已经完成。");
  const payment = payWithWalletBalance({ amount: value, title: `储蓄目标：${goal.title}`, detail: "从钱包余额转入储蓄目标", category: "储蓄" });
  if (!payment.ok) throw new Error(payment.error || "钱包余额不足。");
  return saveWalletPlanning({ ...state, goals: state.goals.map(v => v.id === goalId ? { ...v, saved: money(v.saved + value) } : v) });
}
export function removeWalletGoal(goalId: string): WalletPlanningState {
  const state = loadWalletPlanning();
  return saveWalletPlanning({ ...state, goals: state.goals.filter(v => v.id !== goalId) });
}
function nextDue(date: Date, cadence: "weekly" | "monthly"): Date {
  const next = new Date(date);
  if (cadence === "weekly") next.setDate(next.getDate() + 7);
  else {
    const day = next.getDate();
    next.setDate(1); next.setMonth(next.getMonth() + 1);
    const lastDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
    next.setDate(Math.min(day, lastDay));
  }
  return next;
}
export function addWalletRecurringBill(input: { title: string; amount: number; category: string; cadence: "weekly" | "monthly"; firstDueAt: string }): WalletPlanningState {
  const state = loadWalletPlanning();
  const title = input.title.trim().slice(0,60), amount = money(input.amount), due = new Date(input.firstDueAt);
  if (!title || amount <= 0 || Number.isNaN(due.getTime())) throw new Error("请检查账单名称、金额和首次扣款日期。");
  return saveWalletPlanning({ ...state, bills: [{ id: id("bill"), title, amount, category: input.category.trim().slice(0,32) || "固定支出", cadence: input.cadence, nextDueAt: due.toISOString(), status: "active" }, ...state.bills] });
}
export function updateWalletBill(idValue: string, patch: Partial<Pick<WalletRecurringBill, "status" | "nextDueAt">>): WalletPlanningState {
  const state = loadWalletPlanning();
  return saveWalletPlanning({ ...state, bills: state.bills.map(v => v.id === idValue ? { ...v, ...patch } : v) });
}
export function removeWalletBill(idValue: string): WalletPlanningState {
  const state = loadWalletPlanning();
  return saveWalletPlanning({ ...state, bills: state.bills.filter(v => v.id !== idValue) });
}
/** Runs due virtual bills once per due date. Insufficient balance marks a bill overdue instead of retrying on every render. */
export function runDueWalletBills(now = new Date()): { paid: number; overdue: number; state: WalletPlanningState } {
  let state = loadWalletPlanning(), paid = 0, overdue = 0;
  const nowMs = now.getTime();
  for (const bill of state.bills) {
    if (bill.status !== "active" || new Date(bill.nextDueAt).getTime() > nowMs) continue;
    const result = payWithWalletBalance({ amount: bill.amount, title: bill.title, detail: "周期账单自动扣款", category: bill.category, relatedOrderId: bill.id });
    if (!result.ok) {
      state = saveWalletPlanning({ ...state, bills: state.bills.map(v => v.id === bill.id ? { ...v, status: "overdue", lastError: result.error || "扣款失败" } : v) });
      overdue += 1;
      continue;
    }
    let next = nextDue(new Date(bill.nextDueAt), bill.cadence);
    let catchUpGuard = 0;
    while (next.getTime() <= nowMs && catchUpGuard < 240) { next = nextDue(next, bill.cadence); catchUpGuard += 1; }
    state = saveWalletPlanning({ ...state, bills: state.bills.map(v => v.id === bill.id ? { ...v, nextDueAt: next.toISOString(), lastPaidAt: now.toISOString(), lastError: undefined } : v) });
    paid += 1;
  }
  return { paid, overdue, state };
}
