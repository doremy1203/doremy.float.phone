#!/usr/bin/env node
/* 小金库计划 & 调度器逻辑冒烟测试
 *
 * 直接把 TS 源码用 typescript.transpileModule 转成 CommonJS，在受控的
 * kv/wallet/character 桩里跑，重点验证：
 *   1. 到期计划真的加进小金库余额和流水（旧实现用循环开始时的快照回写，
 *      会把 depositToJointFund 刚写入的余额/流水覆盖掉）；
 *   2. 用户/角色两种扣款路径；
 *   3. 扣款失败时第二天重试，不丢计划；
 *   4. 到期前提醒只发一次，下一期重新提醒。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadTs(rel, mocks, globals = {}) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const require = (id) => {
    if (id in mocks) return mocks[id];
    throw new Error(`unexpected require: ${id}`);
  };
  const names = ["require", "module", "exports", "window", "document", "CustomEvent"];
  const values = [require, module, module.exports, globals.window, globals.document, globals.CustomEvent];
  new Function(...names, js)(...values);
  return module.exports;
}

let pass = 0;
let fail = 0;
function T(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ""}`);
  }
}

const store = new Map();
const kv = {
  kvGet: (key) => (store.has(key) ? store.get(key) : null),
  kvSet: (key, value) => { store.set(key, value); },
  registerKvMigration: () => {},
};
const wallet = { balance: 1000 };
const ledger = {};
const walletMock = {
  formatWalletAmount: (amount) => `¥${Number(amount).toFixed(2)}`,
  payWithWalletAccount: (input) => {
    if (wallet.balance < input.amount) return { ok: false, error: "余额不足", state: {} };
    wallet.balance = Math.round((wallet.balance - input.amount) * 100) / 100;
    return { ok: true, state: {}, transaction: { id: `wtx_${Date.now()}`, createdAt: new Date().toISOString() } };
  },
};
const ledgerMock = {
  characterSpend: (characterId, amount) => {
    const balance = ledger[characterId] ?? 1000;
    if (balance < amount) throw new Error("角色余额不足");
    ledger[characterId] = Math.round((balance - amount) * 100) / 100;
    return { characterId, balance: ledger[characterId], transactions: [{ id: `ctx_${Date.now()}` }] };
  },
};

const events = [];
const windowMock = {
  dispatchEvent: (event) => { events.push(event); return true; },
};
const documentMock = { hidden: false };
const CustomEventMock = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};

const jointFund = loadTs("lib/economy/joint-fund.ts", {
  "@/lib/kv-db": kv,
  "@/lib/wallet-storage": walletMock,
  "./character-ledger": ledgerMock,
}, { window: windowMock, document: documentMock, CustomEvent: CustomEventMock });

console.log("== 1. 用户计划到期：余额 + 流水都要落库 ==");
const fund = jointFund.createJointFund({ name: "旅行基金", goalLabel: "机票", goalAmount: 2000, userId: "u1", characterId: "c1" });
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "user", cadence: "weekly", amount: 100 });
let raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans[0].nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
let results = jointFund.runDueJointFundPlans();
let state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("计划执行成功", results.length === 1 && results[0].ok === true, JSON.stringify(results[0]));
T("小金库余额到账", state.funds[0].balance === 100, `balance=${state.funds[0].balance}`);
T("流水已写入", state.transactions.length === 1 && state.transactions[0].kind === "deposit", `tx=${state.transactions.length}`);
T("用户钱包扣款", wallet.balance === 900, `wallet=${wallet.balance}`);
T("下一期已推进", state.plans[0].nextRunAt > Date.now() + 6 * 86400000, new Date(state.plans[0].nextRunAt).toISOString());

console.log("== 2. 角色自己设置定期存款；用户不能代设 ==");
const blockedCharacterPlan = jointFund.setJointFundPlan({ fundId: fund.id, memberType: "character", memberId: "c1", cadence: "weekly", amount: 50 });
T("用户侧 API 拒绝冒充角色设置计划", blockedCharacterPlan === null);
const rolePlan = jointFund.setJointFundPlanForCharacter("c1", { fundId: fund.id, cadence: "weekly", amount: 50 });
T("角色工具可为自己设置计划", Boolean(rolePlan && rolePlan.createdBy === "character_tool"));
const characterDeposit = jointFund.depositToJointFund(fund.id, "character", "c1", 50, "角色主动存入");
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("角色仍可通过自己的身份主动存入", characterDeposit.ok === true, characterDeposit.error || "");
T("角色账本扣款", ledger.c1 === 950, `character=${ledger.c1}`);
T("小金库余额累加", state.funds[0].balance === 150, `balance=${state.funds[0].balance}`);

console.log("== 2.1 达成目标后停止并识别其他小金库 ==");
const almostDone = jointFund.createJointFund({ name: "相机基金", goalLabel: "相机", goalAmount: 20, userId: "u1", characterId: "c1" });
const completionPlan = jointFund.setJointFundPlanForCharacter("c1", { fundId: almostDone.id, cadence: "monthly", amount: 25 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.find(plan => plan.id === completionPlan.id).nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
results = jointFund.runDueJointFundPlans();
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const completion = results.find(item => item.planId === completionPlan.id);
T("目标达成状态回传", completion?.goalReached === true);
T("检测到其他进行中的小金库", completion?.otherFunds?.some(item => item.id === fund.id) === true);
T("达成目标后自动存款计划已移除", !state.plans.some(plan => plan.id === completionPlan.id));

console.log("== 2.2 没有其他小金库时结束计划 ==");
const onlyFund = jointFund.createJointFund({ name: "独立目标", goalLabel: "礼物", goalAmount: 10, userId: "u2", characterId: "c2" });
const onlyPlan = jointFund.setJointFundPlanForCharacter("c2", { fundId: onlyFund.id, cadence: "weekly", amount: 10 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.find(plan => plan.id === onlyPlan.id).nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
results = jointFund.runDueJointFundPlans();
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const onlyCompletion = results.find(item => item.planId === onlyPlan.id);
T("无其他小金库时没有切换候选", onlyCompletion?.goalReached === true && onlyCompletion.otherFunds?.length === 0);
T("无其他目标后计划彻底取消", !state.plans.some(plan => plan.id === onlyPlan.id));

console.log("== 2.2.1 用户提前存满时也清理角色计划 ==");
const userCompletedFund = jointFund.createJointFund({ name: "提前完成目标", goalLabel: "提前", goalAmount: 10, userId: "u4", characterId: "c4" });
const userCompletedPlan = jointFund.setJointFundPlanForCharacter("c4", { fundId: userCompletedFund.id, cadence: "monthly", amount: 5 });
const userFill = jointFund.depositToJointFund(userCompletedFund.id, "user", "user", 10, "用户提前存满");
T("用户存款可以提前达成目标", userFill.ok === true && userFill.fund.status === "completed");
const earlyCompletion = jointFund.runDueJointFundPlans().find(item => item.planId === userCompletedPlan.id);
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("未到计划时间也能识别目标已完成", earlyCompletion?.alreadyCompleted === true);
T("提前达成后角色计划立即清理", !state.plans.some(plan => plan.id === userCompletedPlan.id));
T("已完成的小金库拒绝继续存入", jointFund.depositToJointFund(userCompletedFund.id, "character", "c4", 1, "不应继续存").ok === false);

console.log("== 2.3 目标完成后让角色决定是否更换小金库 ==");
const followUpFund = jointFund.createJointFund({ name: "旅行基金", goalLabel: "旅行", goalAmount: 5, userId: "u1", characterId: "c1" });
const followUpPlan = jointFund.setJointFundPlanForCharacter("c1", { fundId: followUpFund.id, cadence: "weekly", amount: 5 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.find(plan => plan.id === followUpPlan.id).nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
const scheduledPrompts = [];
const completionScheduler = loadTs("lib/economy/joint-fund-scheduler.ts", {
  "@/lib/bg-timer": { bgSetInterval: () => () => {} },
  "@/lib/browser-notification": { sendBrowserNotification: () => {} },
  "@/lib/shell-notify": { sendShellNotification: () => true },
  "@/lib/wallet-storage": walletMock,
  "@/lib/chat-storage": {
    loadChatSessions: () => [{ id: "session-c1", isGroup: false }],
    resolveSessionCharacterId: () => "c1",
  },
  "@/lib/timed-wake-storage": {
    makeTimedWakeId: () => "timed-wake-test",
    loadTimedWakeSchedules: () => [],
    appendTimedWakeSchedule: schedule => scheduledPrompts.push(schedule),
  },
  "./joint-fund": jointFund,
}, { window: windowMock, document: documentMock, CustomEvent: CustomEventMock });
completionScheduler.runJointFundSchedulerTick();
T("有其他小金库时创建角色主动询问", scheduledPrompts.length === 1);
T("询问任务由角色本人触发", scheduledPrompts[0]?.source === "tool" && scheduledPrompts[0]?.characterId === "c1");
T("询问明确要求先征求同意，不擅自切换", scheduledPrompts[0]?.intent.includes("不要替用户或自己擅自选择") === true);

const noOtherFund = jointFund.createJointFund({ name: "单独目标", goalLabel: "单独", goalAmount: 5, userId: "u3", characterId: "c3" });
const noOtherPlan = jointFund.setJointFundPlanForCharacter("c3", { fundId: noOtherFund.id, cadence: "weekly", amount: 5 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.find(plan => plan.id === noOtherPlan.id).nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
completionScheduler.runJointFundSchedulerTick();
T("没有其他小金库时不创建切换询问", scheduledPrompts.length === 1);
T("没有其他目标时定期计划已取消", !jointFund.loadJointFundPlans().some(plan => plan.id === noOtherPlan.id));

console.log("== 3. 扣款失败不吞计划 ==");
wallet.balance = 0;
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "user", cadence: "monthly", amount: 80 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const failedPlan = raw.plans.find((plan) => plan.memberType === "user");
failedPlan.nextRunAt = Date.now() - 1000;
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
results = jointFund.runDueJointFundPlans();
state = JSON.parse(store.get("ai_phone_joint_funds_v1"));
const retryPlan = state.plans.find((plan) => plan.memberType === "user");
T("失败结果可上报", results.length === 1 && results[0].ok === false, results[0]?.error);
T("余额未被改动", state.funds[0].balance === 150, `balance=${state.funds[0].balance}`);
T("失败计划改为次日重试", retryPlan.nextRunAt > Date.now() + 23 * 3600000, new Date(retryPlan.nextRunAt).toISOString());

console.log("== 4. 到期提醒只发一次 ==");
wallet.balance = 1000;
jointFund.setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "user", cadence: "monthly", amount: 20 });
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.forEach((plan) => { if (plan.memberType === "user") plan.nextRunAt = Date.now() + 3600000; });
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
const shellNotices = [];
const scheduler = loadTs("lib/economy/joint-fund-scheduler.ts", {
  "@/lib/bg-timer": { bgSetInterval: () => () => {} },
  "@/lib/browser-notification": { sendBrowserNotification: () => {} },
  "@/lib/shell-notify": { sendShellNotification: () => true },
  "@/lib/wallet-storage": walletMock,
  "@/lib/chat-storage": { loadChatSessions: () => [], resolveSessionCharacterId: () => "" },
  "@/lib/timed-wake-storage": { makeTimedWakeId: () => "unused", loadTimedWakeSchedules: () => [], appendTimedWakeSchedule: () => {} },
  "./joint-fund": jointFund,
}, { window: windowMock, document: { hidden: true }, CustomEvent: CustomEventMock });
// 重置提醒状态，让本测试从干净的“未提醒”开始。
raw = JSON.parse(store.get("ai_phone_joint_funds_v1"));
raw.plans.forEach((plan) => { delete plan.remindedForRunAt; });
store.set("ai_phone_joint_funds_v1", JSON.stringify(raw));
scheduler.runJointFundSchedulerTick();
const afterFirst = JSON.parse(store.get("ai_phone_joint_funds_v1"));
T("第一期提醒已标记", afterFirst.plans.some((plan) => plan.remindedForRunAt === plan.nextRunAt));
const firstReminderEvents = events.filter((event) => event.type === "app-global-notice" && String(event.detail?.message || "").includes("自动存入"));
T("发出提醒横幅", firstReminderEvents.length >= 1, `count=${firstReminderEvents.length}`);
const beforeSecond = events.length;
scheduler.runJointFundSchedulerTick();
const secondReminderEvents = events.slice(beforeSecond).filter((event) => event.type === "app-global-notice" && String(event.detail?.message || "").includes("自动存入"));
T("同一期不重复提醒", secondReminderEvents.length === 0, `count=${secondReminderEvents.length}`);

console.log(`\n${fail === 0 ? "✅" : "❌"} 小金库逻辑测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
