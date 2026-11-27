#!/usr/bin/env node
/* 钱包角色记账、亲属卡身份隔离与用户小金库入口回归测试。 */
import assert from "node:assert/strict";
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
  const require = id => {
    if (id in mocks) return mocks[id];
    throw new Error(`unexpected require: ${id}`);
  };
  new Function("require", "module", "exports", "window", "CustomEvent", js)(
    require, module, module.exports, globals.window, globals.CustomEvent,
  );
  return module.exports;
}

const store = new Map();
const events = [];
const windowMock = { dispatchEvent: event => { events.push(event); return true; } };
const CustomEventMock = class CustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
};
const kv = {
  kvGet: key => store.has(key) ? store.get(key) : null,
  kvSet: (key, value) => store.set(key, value),
  registerKvMigration: () => {},
};
const wallet = loadTs("lib/wallet-storage.ts", { "./kv-db": kv }, { window: windowMock, CustomEvent: CustomEventMock });

console.log("== 1. 角色替用户记录钱包收支 ==");
let result = wallet.recordWalletBookkeeping({
  direction: "income", amount: 200, title: "工资到账", category: "工资",
  note: "本月工资", reference: "salary-2026-11",
});
assert.equal(result.ok, true);
assert.equal(result.state.balance, 10200);
assert.equal(result.transaction.amount, 200);
assert.equal(result.transaction.category, "工资");
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(wallet.recordWalletBookkeeping({
  direction: "income", amount: 200, title: "工资到账", category: "工资",
  note: "本月工资", reference: "salary-2026-11",
}).ok, false, "同一 reference 必须阻止重复记账");
console.log("  ✅ 收入入账、分类与唯一引用去重");

result = wallet.recordWalletBookkeeping({
  direction: "expense", amount: 35.5, title: "午餐", category: "餐饮", note: "工作日午餐",
});
assert.equal(result.ok, true);
assert.equal(result.state.balance, 10164.5);
assert.equal(result.transaction.amount, -35.5);
console.log("  ✅ 支出扣减余额并生成负数流水");

await new Promise(resolve => setTimeout(resolve, 10));
const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
result = wallet.recordWalletBookkeeping({
  direction: "income", amount: 50, title: "旧项目尾款", category: "项目", occurredAt: oldDate,
});
assert.equal(result.ok, true);
assert.equal(result.transaction.createdAt, oldDate);
assert.equal(result.transaction.balanceAfter, 50);
assert.equal(result.state.balance, 10214.5);
assert.equal(result.state.transactions.find(tx => tx.title === "工资到账").balanceAfter, 10250);
console.log("  ✅ 补记历史流水保留发生时间并同步后续余额");

result = wallet.recordWalletBookkeeping({
  direction: "expense", amount: 999999, title: "超额支出", category: "其他",
});
assert.equal(result.ok, false);
assert.equal(wallet.recordWalletBookkeeping({
  direction: "transfer", amount: 1, title: "非法方向",
}).ok, false);
console.log("  ✅ 余额不足与无效收支方向均拒绝写入");

console.log("== 2. 亲属卡只能由对应身份发放 ==");
const family = loadTs("lib/economy/family-card.ts", {
  "@/lib/kv-db": kv,
  "@/lib/wallet-storage": { payWithWalletAccount: () => ({ ok: true, transaction: { id: "wallet-tx" } }) },
  "./character-ledger": { characterSpend: () => ({ transactions: [{ id: "character-tx" }] }) },
}, { window: windowMock, CustomEvent: CustomEventMock });
const userCard = family.createFamilyCard({ beneficiaryId: "character-1", label: "日常卡", monthlyLimit: 300 });
assert.equal(userCard.issuerType, "user");
assert.equal(userCard.issuerId, "user");
assert.equal(userCard.beneficiaryType, "character");
assert.throws(() => family.createFamilyCard({ beneficiaryId: "user", label: "冒充角色开卡", monthlyLimit: 300 }), /用户发放给指定角色/);
const roleCard = family.createFamilyCardForCharacter("character-1", { label: "给你的卡", monthlyLimit: 500 });
assert.equal(roleCard.issuerType, "character");
assert.equal(roleCard.issuerId, "character-1");
assert.equal(roleCard.beneficiaryId, "user");
assert.throws(() => family.createFamilyCardForCharacter("", { label: "无身份卡", monthlyLimit: 100 }), /有效的角色身份/);
console.log("  ✅ 用户发卡与角色发卡走独立身份入口");

console.log("== 3. 角色工具与钱包 UI 接线检查 ==");
const capability = fs.readFileSync(path.join(ROOT, "lib/internal-capability-storage.ts"), "utf8");
const executor = fs.readFileSync(path.join(ROOT, "lib/tool-executor.ts"), "utf8");
const walletUi = fs.readFileSync(path.join(ROOT, "components/wallet-app.tsx"), "utf8");
assert.match(capability, /name: "帮我记账"/);
assert.match(capability, /direction: \{ type: "string", enum: \["income", "expense"\]/);
assert.match(executor, /name === "帮我记账"/);
assert.match(executor, /recordWalletBookkeeping\(/);
assert.match(executor, /createFamilyCardForCharacter\(characterId/);
assert.match(capability, /name: "设置小金库定期存款"/);
assert.match(capability, /"设置小金库定期存款"/);
assert.match(executor, /setJointFundPlanForCharacter\(characterId/);
assert.match(executor, /name === "设置小金库定期存款"/);
assert.doesNotMatch(walletUi.slice(walletUi.indexOf("function FamilyTab"), walletUi.indexOf("function JointTab")), /角色开给我/);
assert.doesNotMatch(walletUi.slice(walletUi.indexOf("function JointTab"), walletUi.indexOf("function LedgerTab")), /TA 来存|memberType: "character"/);
assert.match(walletUi, /可用亲属卡：/);
assert.match(walletUi, /发放亲属卡：/);
assert.match(walletUi, /角色账本余额/);
assert.doesNotMatch(walletUi, /当前查看：/);
const overviewLedgerCard = walletUi.slice(walletUi.indexOf("CHARACTER ASSETS"), walletUi.indexOf("wallet-section rounded-2xl p-4", walletUi.indexOf("CHARACTER ASSETS")));
assert.doesNotMatch(overviewLedgerCard, /selectedCharacterLedger\?\.transactions|最近流水|这位角色还没有收支记录/);
console.log("  ✅ 中文工具已接入；用户页面不再提供代角色发卡/存款入口");

console.log("\n✅ 钱包改造回归测试全部通过");
