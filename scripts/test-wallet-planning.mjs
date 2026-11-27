#!/usr/bin/env node
/* Wallet planning persistence and money-flow smoke tests. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const source=fs.readFileSync(path.join(ROOT,"lib/wallet-planning.ts"),"utf8");
const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;
const store=new Map();let balance=1000;
const kv={kvGet:key=>store.get(key)||null,kvSet:(key,value)=>store.set(key,value),registerKvMigration:()=>{}};
const wallet={payWithWalletBalance:({amount})=>{if(balance<amount)return{ok:false,error:"余额不足"};balance-=amount;return{ok:true};}};
const module={exports:{}};
const require=id=>id==="./kv-db"?kv:id==="./wallet-storage"?wallet:(()=>{throw new Error("unexpected require "+id)})();
const CustomEventMock=class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail;}};
new Function("require","module","exports","window","CustomEvent",js)(require,module,module.exports,{dispatchEvent:()=>true},CustomEventMock);
const w=module.exports;let pass=0,fail=0;
function T(name,ok){if(ok){pass++;console.log("  ✅ "+name)}else{fail++;console.log("  ❌ "+name)}}
const month="2026-11";
w.addWalletBudget({month,category:"餐饮",limit:500});
w.addWalletBudget({month,category:"餐饮",limit:800});
T("同一月份同一分类预算更新而不是重复",w.loadWalletPlanning().budgets.length===1&&w.loadWalletPlanning().budgets[0].limit===800);
const goal=w.addWalletSavingsGoal({title:"旅行",target:300}).goals[0];
w.contributeToWalletGoal(goal.id,120);
T("储蓄目标入账会同步扣除钱包余额",w.loadWalletPlanning().goals[0].saved===120&&balance===880);
w.addWalletRecurringBill({title:"会员订阅",amount:20,category:"订阅",cadence:"monthly",firstDueAt:"2026-10-01T09:00:00.000Z"});
const result=w.runDueWalletBills(new Date("2026-11-27T00:00:00.000Z"));
const bill=result.state.bills[0];
T("到期周期账单只扣一次并推进到未来日期",result.paid===1&&balance===860&&new Date(bill.nextDueAt)>new Date("2026-11-27T00:00:00.000Z"));
w.addWalletRecurringBill({title:"超额账单",amount:5000,category:"固定支出",cadence:"monthly",firstDueAt:"2026-11-01T09:00:00.000Z"});
const failed=w.runDueWalletBills(new Date("2026-11-27T00:00:00.000Z"));
T("余额不足时账单标记待处理且不扣成负数",failed.overdue===1&&balance===860&&failed.state.bills.some(v=>v.title==="超额账单"&&v.status==="overdue"));
console.log(`\\n${fail===0?"✅":"❌"} Wallet planning: ${pass} passed / ${fail} failed`);
process.exit(fail===0?0:1);
