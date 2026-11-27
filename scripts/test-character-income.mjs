#!/usr/bin/env node
/* 角色初始存款 / 固定收入逻辑冒烟测试。
 * 直接转译 lib/economy/character-income.ts，在内存 KV + 假账本里验证：
 *   1. 按人设建档，只发一次初始存款；
 *   2. 到期固定收入自动入账并推进下一期；
 *   3. 改初始存款只补/扣差额，不重复发整笔；
 *   4. 改收入计划会从当前时间重新起算。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function loadTs(rel, mocks, globals = {}) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
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
  if (cond) { pass += 1; console.log(`  ✅ ${name}${detail ? `  → ${detail}` : ""}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? `  → ${detail}` : ""}`); }
}

const store = new Map();
const kv = {
  kvGet: key => (store.has(key) ? store.get(key) : null),
  kvSet: (key, value) => { store.set(key, value); },
  registerKvMigration: () => {},
};
const characters = [
  { id: "c_student", name: "小林", persona: "大学生，正在准备考研" },
  { id: "c_boss", name: "顾总", persona: "公司总裁，工作很忙" },
];
const ledgers = {};
const walletEvents = [];
function ensureLedger(id) {
  if (!ledgers[id]) ledgers[id] = { characterId: id, balance: 0, transactions: [], statements: [], updatedAt: Date.now() };
  return ledgers[id];
}
const ledgerMock = {
  ensureCharacterLedger: ensureLedger,
  loadCharacterLedger: id => ledgers[id] || null,
  characterEarn: (id, amount, category, note, ref) => {
    const ledger = ensureLedger(id);
    ledger.balance = Math.round((ledger.balance + amount) * 100) / 100;
    ledger.transactions.push({ id: `tx_${ledger.transactions.length + 1}`, at: Date.now(), amount, category, note, ref, balanceAfter: ledger.balance });
    return ledger;
  },
  characterSpend: (id, amount, category, note, ref) => {
    const ledger = ensureLedger(id);
    if (ledger.balance < amount) throw new Error("角色余额不足");
    ledger.balance = Math.round((ledger.balance - amount) * 100) / 100;
    ledger.transactions.push({ id: `tx_${ledger.transactions.length + 1}`, at: Date.now(), amount: -amount, category, note, ref, balanceAfter: ledger.balance });
    return ledger;
  },
};
const windowMock = { dispatchEvent: event => { walletEvents.push(event); return true; }, addEventListener: () => {}, removeEventListener: () => {} };
const documentMock = { hidden: false, addEventListener: () => {}, removeEventListener: () => {} };
const CustomEventMock = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };

const income = loadTs("lib/economy/character-income.ts", {
  "@/lib/kv-db": kv,
  "@/lib/character-storage": { loadCharacters: () => characters },
  "./character-ledger": ledgerMock,
  "@/lib/browser-notification": { sendBrowserNotification: () => {} },
  "@/lib/shell-notify": { sendShellNotification: () => true },
  "@/lib/bg-timer": { bgSetInterval: () => () => {} },
}, { window: windowMock, document: documentMock, CustomEvent: CustomEventMock });

console.log("== 1. 按人设建档 + 初始存款只发一次 ==");
const student = income.ensureCharacterEconomyProfile(characters[0]);
T("学生人设初始存款", student.initialDeposit === 3000, `initial=${student.initialDeposit}`);
T("固定收入按人设", student.incomeAmount === 1500 && student.cadence === "monthly", `${student.incomeAmount}/${student.cadence}`);
T("初始存款已入账", ledgers.c_student.balance === 3000, `balance=${ledgers.c_student.balance}`);
income.ensureCharacterEconomyProfile(characters[0]);
T("再次 ensure 不重复发", ledgers.c_student.balance === 3000, `balance=${ledgers.c_student.balance}`);

console.log("== 2. 到期固定收入自动入账 ==");
let raw = JSON.parse(store.get("ai_phone_character_economy_v1"));
raw.profiles.c_student.nextIncomeAt = Date.now() - 1000;
store.set("ai_phone_character_economy_v1", JSON.stringify(raw));
const results = income.runDueCharacterIncomes();
T("收入执行成功", results.length === 1 && results[0].ok, JSON.stringify(results[0]));
T("余额增加固定收入", ledgers.c_student.balance === 4500, `balance=${ledgers.c_student.balance}`);
raw = JSON.parse(store.get("ai_phone_character_economy_v1"));
T("下一期已推进", raw.profiles.c_student.nextIncomeAt > Date.now() + 29 * 86400000, new Date(raw.profiles.c_student.nextIncomeAt).toISOString());

console.log("== 3. 改初始存款只补差额 ==");
income.setCharacterInitialDeposit("c_student", 5000);
T("差额补入账本", ledgers.c_student.balance === 6500, `balance=${ledgers.c_student.balance}`);
const profile = income.loadCharacterEconomyProfile("c_student");
T("profile 初始值更新", profile.initialDeposit === 5000, `initial=${profile.initialDeposit}`);

console.log("== 4. 改收入计划重新起算 ==");
const before = profile.nextIncomeAt;
const next = income.updateCharacterIncomePlan("c_student", { incomeAmount: 2000, cadence: "weekly", enabled: true });
T("新金额/频率生效", next.incomeAmount === 2000 && next.cadence === "weekly");
T("下一期从当前时间重算", next.nextIncomeAt !== before && next.nextIncomeAt > Date.now() + 6 * 86400000, new Date(next.nextIncomeAt).toISOString());

console.log("== 5. 提示词经济上下文 ==");
const context = income.buildCharacterEconomyContext("c_student");
T("包含真实余额", context.includes("¥6500.00"), context.split("\n")[1] || "");
T("包含固定收入说明", context.includes("每周固定收入") && context.includes("自动入账"));

console.log(`\n${fail === 0 ? "✅" : "❌"} 角色收入逻辑测试：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
