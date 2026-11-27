"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CreditCard, Target } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import { loadWalletState, formatWalletAmount, WALLET_UPDATED_EVENT, creditWalletBalance, payWithWalletBalance } from "@/lib/wallet-storage";
import { runDueWalletBills } from "@/lib/wallet-planning";
import { WalletPlanningTabs, type WalletPlanningTab } from "@/components/wallet-planning-tabs";
import { WalletPanel } from "@/components/chat/wallet-panel";
import { WalletHeaderIsolationStyle } from "@/components/wallet-header-isolation-style";
import { CHARACTER_LEDGER_UPDATED_EVENT, loadCharacterLedger } from "@/lib/economy/character-ledger";
import {
  createFamilyCard, loadFamilyCardTransactions, loadFamilyCards, spendWithFamilyCard,
  updateFamilyCard, FAMILY_CARD_UPDATED_EVENT, type FamilyCard,
} from "@/lib/economy/family-card";
import {
  createJointFund, depositToJointFund, loadJointFundPlans, loadJointFunds,
  loadJointFundTransactions, removeJointFundPlan, runDueJointFundPlans,
  setJointFundPlan, JOINT_FUND_UPDATED_EVENT, type JointFund,
} from "@/lib/economy/joint-fund";
import {
  CHARACTER_ECONOMY_UPDATED_EVENT, ensureCharacterEconomyProfileAsync,
  setCharacterInitialDeposit, updateCharacterIncomePlan,
  type CharacterEconomyProfile, type CharacterIncomeCadence,
} from "@/lib/economy/character-income";

type WalletTab = "home" | "accounts" | "family" | "joint" | "ledger" | WalletPlanningTab;
type Props = { onClose: () => void; initialTab?: WalletTab };

const TABS: Array<{ id: WalletTab; label: string }> = [
  { id: "home", label: "总览" },
  { id: "accounts", label: "银行卡" },
  { id: "family", label: "亲属卡" },
  { id: "joint", label: "小金库" },
  { id: "ledger", label: "角色账本" },
  { id: "budget", label: "预算" },
  { id: "goals", label: "储蓄目标" },
  { id: "bills", label: "周期账单" },
  { id: "calendar", label: "财务日历" },
  { id: "insights", label: "财务报告" },
];

function money(value: number): string { return formatWalletAmount(value); }
function notify(message: string, kind: "success" | "error" | "info" = "success") {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message } }));
}
/** 账户互转不是收入/支出：银行卡↔余额、卡内转入转出都要从报表里剔除。 */
function isInternalWalletTransfer(tx: { category?: string; detail?: string }): boolean {
  const category = String(tx.category || "");
  const detail = String(tx.detail || "");
  if (["转入", "提现", "银行卡账户"].includes(category)) return true;
  return /转入余额|提现到银行卡|转入账户|转出账户/.test(detail);
}

function time(value: number | string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function WalletApp({ onClose, initialTab = "home" }: Props) {
  const [tab, setTab] = useState<WalletTab>(initialTab);
  const [wallet, setWallet] = useState(() => loadWalletState());
  const [characters, setCharacters] = useState(() => loadCharacters());
  const [familyCards, setFamilyCards] = useState<FamilyCard[]>(() => loadFamilyCards());
  const [jointFunds, setJointFunds] = useState<JointFund[]>(() => loadJointFunds());
  const [selectedCharacterId, setSelectedCharacterId] = useState(() => loadCharacters()[0]?.id || "");
  const [tick, setTick] = useState(0);
  const [quickEntry, setQuickEntry] = useState<"income" | "expense" | null>(null);
  const [quickAmount, setQuickAmount] = useState("");
  const [quickTitle, setQuickTitle] = useState("");
  const [quickCategory, setQuickCategory] = useState("其他");
  const refresh = useCallback(() => {
    setWallet(loadWalletState());
    setCharacters(loadCharacters());
    setFamilyCards(loadFamilyCards());
    setJointFunds(loadJointFunds());
    setTick(v => v + 1);
  }, []);

  useEffect(() => {
    runDueJointFundPlans();
    const due = runDueWalletBills();
    if (due.paid) notify(`已自动处理 ${due.paid} 笔周期账单`);
    if (due.overdue) notify(`${due.overdue} 笔周期账单扣款失败，请检查余额`, "error");
    refresh();
    const events = [WALLET_UPDATED_EVENT, FAMILY_CARD_UPDATED_EVENT, JOINT_FUND_UPDATED_EVENT, CHARACTER_ECONOMY_UPDATED_EVENT, CHARACTER_LEDGER_UPDATED_EVENT, "characters-updated"];
    for (const name of events) window.addEventListener(name, refresh);
    return () => { for (const name of events) window.removeEventListener(name, refresh); };
  }, [refresh]);

  const saveQuickEntry = () => {
    const amount = Number(quickAmount);
    if (!Number.isFinite(amount) || amount <= 0 || !quickTitle.trim()) { notify("请填写有效金额和用途。", "error"); return; }
    const result = quickEntry === "income"
      ? creditWalletBalance(amount, quickTitle.trim(), "钱包手动收入", quickCategory)
      : payWithWalletBalance({ amount, title: quickTitle.trim(), detail: "钱包手动支出", category: quickCategory });
    if (!result.ok) { notify(result.error || "记账失败", "error"); return; }
    notify(quickEntry === "income" ? "收入已记账" : "支出已记账");
    setQuickEntry(null); setQuickAmount(""); setQuickTitle(""); refresh();
  };

  const activeCharacterId = characters.some(character => character.id === selectedCharacterId)
    ? selectedCharacterId
    : characters[0]?.id || "";
  const selectedCharacterLedger = useMemo(() => {
    void tick;
    return activeCharacterId ? loadCharacterLedger(activeCharacterId) : null;
  }, [activeCharacterId, tick]);
  const currentMonthFlow = useMemo(() => {
    const now = new Date();
    const rows = wallet.transactions.filter(tx => {
      const date = new Date(tx.createdAt);
      return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
    });
    return {
      income: rows.filter(tx => tx.amount > 0 && !isInternalWalletTransfer(tx)).reduce((sum, tx) => sum + tx.amount, 0),
      expense: rows.filter(tx => tx.amount < 0 && tx.kind === "payment").reduce((sum, tx) => sum + Math.abs(tx.amount), 0),
    };
  }, [wallet.transactions]);

  if (tab === "accounts") return <WalletPanel onBack={() => setTab("home")} onNavigateTab={nextTab => setTab(nextTab)} />;

  return (
    <PageShell title="钱包" onBack={onClose} className="wallet-private-bank wallet-private-bank-shell" headerClassName="wallet-app-header" headerStyle={{ background: "#f7f6f0", backgroundColor: "#f7f6f0", backgroundImage: "none", backdropFilter: "none", WebkitBackdropFilter: "none", zIndex: 50, isolation: "isolate" }}>
      <WalletHeaderIsolationStyle />
      <div className="wallet-private-bank wallet-tab-row flex shrink-0 gap-2 overflow-x-auto px-1 pb-3">
        {TABS.map(item => (
          <button key={item.id} onClick={() => setTab(item.id)} aria-pressed={tab === item.id} className={`wallet-tab shrink-0 rounded-full px-4 py-2 text-sm transition-colors ${tab === item.id ? "" : ""}`}>{item.label}</button>
        ))}
      </div>

      {tab === "home" && (
        <div className="wallet-private-bank flex flex-col gap-3">
          <div className="wallet-hero rounded-3xl p-5 shadow-sm">
            <div className="wallet-kicker" style={{color:"#c7b78e"}}>PRIVATE WALLET · AVAILABLE BALANCE</div><div className="mt-2 text-[10px] tracking-[.12em] opacity-65">我的可用余额</div>
            <div className="mt-1 text-3xl font-semibold" style={{color:"#f5f0e4",fontFamily:"Georgia,serif"}}>{money(wallet.balance)}</div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--c-icon)]">
              <button type="button" onClick={() => setTab("accounts")} className="underline underline-offset-4">银行卡 {wallet.cards.length} 张 · 管理</button>
              <span>可用亲属卡：{familyCards.filter(card => card.issuerType === "character" && card.status === "active" && card.usedThisPeriod < card.monthlyLimit).length} 张</span>
              <span>发放亲属卡：{familyCards.filter(card => card.issuerType === "user").length} 张</span>
              <span>小金库 {jointFunds.length} 个</span>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button type="button" onClick={() => setTab("insights")} className="wallet-section rounded-2xl p-3 text-left">
              <div className="wallet-kicker">THIS MONTH · INCOME</div>
              <div className="mt-1 text-base font-semibold text-[#426b4a]">+{money(currentMonthFlow.income)}</div>
              <div className="mt-1 text-[10px] text-[#8a8579]">查看月度报告 →</div>
            </button>
            <button type="button" onClick={() => setTab("insights")} className="wallet-section rounded-2xl p-3 text-left">
              <div className="wallet-kicker">THIS MONTH · SPENDING</div>
              <div className="mt-1 text-base font-semibold text-[#986455]">−{money(currentMonthFlow.expense)}</div>
              <div className="mt-1 text-[10px] text-[#8a8579]">查看支出分类 →</div>
            </button>
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="mb-3 flex items-center justify-between"><div><div className="wallet-kicker mb-1">QUICK ENTRY</div><div className="text-sm font-medium text-[var(--c-text)]">快速记账</div></div><div className="flex gap-2"><button type="button" onClick={() => setQuickEntry("income")} className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700">＋ 收入</button><button type="button" onClick={() => setQuickEntry("expense")} className="rounded-full bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700">－ 支出</button></div></div>
            {quickEntry && <div className="grid grid-cols-2 gap-2">
              <input value={quickTitle} onChange={event => setQuickTitle(event.target.value)} placeholder="用途 / 来源" className="ui-input col-span-2" />
              <input value={quickAmount} onChange={event => setQuickAmount(event.target.value)} type="number" inputMode="decimal" min="0" step="0.01" placeholder="金额" className="ui-input" />
              <select value={quickCategory} onChange={event => setQuickCategory(event.target.value)} className="ui-select">{["其他","餐饮","交通","购物","居住","娱乐","医疗","订阅","学习","工资","退款"].map(value => <option key={value}>{value}</option>)}</select>
              <button type="button" onClick={() => { setQuickEntry(null); setQuickAmount(""); setQuickTitle(""); }} className="ui-btn ui-btn-ghost">取消</button>
              <button type="button" onClick={saveQuickEntry} className="ui-btn ui-btn-primary">确认记账</button>
            </div>}
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="wallet-character-ledger-head mb-3">
              <div className="min-w-0 flex-1"><div className="wallet-kicker mb-1">CHARACTER ASSETS</div><div className="wallet-character-ledger-title text-sm font-medium text-[var(--c-text)]">角色账本余额</div></div>
              {characters.length > 0 && <select aria-label="切换角色账本" value={activeCharacterId} onChange={event => setSelectedCharacterId(event.target.value)} className="ui-select wallet-character-picker">{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select>}
            </div>
            <div className="text-xl font-semibold text-[var(--c-text)]">{money(selectedCharacterLedger?.balance || 0)}</div>
            <button type="button" onClick={() => setTab("ledger")} className="mt-2 self-start text-xs font-medium text-[var(--c-primary)]">查看账本设置 →</button>
          </div>
          <div className="wallet-section rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between"><span className="text-sm font-medium text-[var(--c-text)]">最近流水</span><span className="text-xs text-[var(--c-icon)]">共 {wallet.transactions.length} 条</span></div>
            <div className="flex flex-col gap-2">
              {wallet.transactions.slice(0, 6).map(tx => (
                <div key={tx.id} className="flex items-center justify-between text-sm">
                  <div className="min-w-0"><div className="truncate text-[var(--c-text)]">{tx.title}</div><div className="text-[11px] text-[var(--c-icon)]">{time(tx.createdAt)} · {tx.category}</div></div>
                  <span className={tx.amount < 0 ? "text-rose-500" : "text-emerald-600"}>{tx.amount < 0 ? "-" : "+"}{money(Math.abs(tx.amount))}</span>
                </div>
              ))}
              {wallet.transactions.length === 0 && <div className="text-xs text-[var(--c-icon)]">还没有流水</div>}
            </div>
          </div>
        </div>
      )}

      {tab === "family" && <FamilyTab characters={characters} cards={familyCards} onChange={refresh} />}
      {tab === "joint" && <JointTab characters={characters} funds={jointFunds} onChange={refresh} />}
      {tab === "ledger" && <LedgerTab characters={characters} selectedCharacterId={activeCharacterId} onSelectCharacter={setSelectedCharacterId} />}
      {(["budget","goals","bills","calendar","insights"] as WalletPlanningTab[]).includes(tab as WalletPlanningTab) && <WalletPlanningTabs tab={tab as WalletPlanningTab} onChange={refresh} />}
    </PageShell>
  );
}

function FamilyTab({ characters, cards, onChange }: { characters: ReturnType<typeof loadCharacters>; cards: FamilyCard[]; onChange: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.id || "");
  const [label, setLabel] = useState("随便花卡");
  const [limit, setLimit] = useState("500");
  const [spendAmount, setSpendAmount] = useState("10");
  const [message, setMessage] = useState("");

  const create = () => {
    if (!characterId) { setMessage("请先创建一个角色，再为 TA 开卡。"); return; }
    if (!label.trim()) { setMessage("给这张卡起个名字吧。"); return; }
    const value = Number(limit);
    if (!Number.isFinite(value) || value <= 0) { setMessage("请输入有效的每月额度。"); return; }
    try {
      createFamilyCard({ beneficiaryId: characterId, label: label.trim(), monthlyLimit: value });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "创建亲属卡失败");
      return;
    }
    setMessage("亲属卡已创建，可以开始使用了。");
    notify("已创建亲属卡");
    onChange();
  };

  return (
    <div className="wallet-private-bank wallet-family-tab flex flex-col gap-3">
      <div className="wallet-subpage-heading px-1 pb-1">
        <div className="wallet-kicker mb-1">FAMILY BANKING</div>
        <div className="text-xl font-semibold text-[#292b25]">亲属卡</div>
        <p className="mt-1 text-[11px] text-[#898579]">为彼此准备一份日常额度，消费记录和可用金额都会清楚显示。</p>
      </div>

      <section className="wallet-form-card wallet-family-create">
        <div className="wallet-form-card-heading">
          <div>
            <div className="wallet-form-eyebrow">CREATE A FAMILY CARD</div>
            <h3>开一张亲属卡</h3>
            <p>由你发放给角色使用，消费从你的钱包扣除。</p>
          </div>
          <span className="wallet-form-mark">¥</span>
        </div>

        <label className="wallet-family-recipient-row flex items-center gap-3 rounded-2xl border border-[var(--c-card-border)] bg-[var(--c-card)] px-3 py-2.5">
          <span className="shrink-0 text-xs font-medium text-[var(--c-icon)]">发给</span>
          <select aria-label="选择亲属卡使用者" value={characterId} onChange={event => setCharacterId(event.target.value)} disabled={!characters.length} className="min-w-0 flex-1 border-0 bg-transparent text-sm font-semibold text-[var(--c-text)] outline-none">
            {characters.length ? characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>) : <option value="">暂无可选角色</option>}
          </select>
        </label>

        <div className="wallet-form-grid">
          <label className="wallet-form-field">
            <span className="wallet-form-label">卡片名称</span>
            <input type="text" value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：日常零花卡" maxLength={24} className="wallet-form-control" />
          </label>
          <label className="wallet-form-field">
            <span className="wallet-form-label">每月额度</span>
            <span className="wallet-form-currency">
              <span>¥</span>
              <input type="number" min="0.01" step="0.01" inputMode="decimal" value={limit} onChange={event => setLimit(event.target.value)} placeholder="500" />
            </span>
          </label>
        </div>

        <div className="wallet-form-submit-row">
          <p>额度按自然月重置，可随时暂停或恢复。</p>
          <button type="button" onClick={create} disabled={!characters.length} className="wallet-form-primary disabled:cursor-not-allowed disabled:opacity-45">创建亲属卡</button>
        </div>
        {message && <div role="status" className="wallet-form-message">{message}</div>}
      </section>

      {[...cards].sort((a, b) => Number(a.issuerType === "character") - Number(b.issuerType === "character")).map((card, index, orderedCards) => {
        const character = characters.find(c => c.id === (card.issuerType === "character" ? card.issuerId : card.beneficiaryId));
        const txs = loadFamilyCardTransactions(card.id);
        return (
          <div key={card.id} className="contents">
            {(index === 0 || orderedCards[index - 1].issuerType !== card.issuerType) && (
              <div className="px-1 pb-1 pt-2">
                <div className="text-sm font-semibold text-[var(--c-text)]">{card.issuerType === "user" ? "我给角色的亲属卡" : "角色给我的亲属卡"}</div>
                <div className="mt-0.5 text-[11px] text-[var(--c-icon)]">{card.issuerType === "user" ? "由我的钱包承担消费" : "由角色账本承担消费"} · {orderedCards.filter(item => item.issuerType === card.issuerType).length} 张</div>
              </div>
            )}
          <div className="wallet-section rounded-2xl p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-[var(--c-text)]">{card.label}</div>
                <div className="text-[11px] text-[var(--c-icon)]">{card.issuerType === "user" ? "我 → " + (character?.name || "角色") : (character?.name || "角色") + " → 我"} · 每月 {money(card.monthlyLimit)}</div>
              </div>
              <span className={`rounded-full px-2 py-1 text-[10px] ${card.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{card.status === "active" ? "生效中" : "已暂停"}</span>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--c-input)]"><div className="h-full rounded-full bg-[var(--c-primary)]" style={{ width: Math.min(100, card.usedThisPeriod / card.monthlyLimit * 100) + "%" }} /></div>
            <div className="mt-1 flex justify-between text-[11px] text-[var(--c-icon)]"><span>本周期已用 {money(card.usedThisPeriod)}</span><span>可用额度 {money(Math.max(0, card.monthlyLimit - card.usedThisPeriod))}</span></div>
            <div className="wallet-family-card-actions">
              <label className="wallet-form-field">
                <span className="wallet-form-label">记录一笔消费</span>
                <span className="wallet-form-currency">
                  <span>¥</span>
                  <input aria-label={card.label + "消费金额"} type="number" min="0.01" step="0.01" inputMode="decimal" value={spendAmount} onChange={event => setSpendAmount(event.target.value)} />
                </span>
              </label>
              <div className="wallet-family-card-buttons">
                <button type="button" disabled={card.status !== "active"} onClick={() => {
                  const value = Number(spendAmount);
                  if (!Number.isFinite(value) || value <= 0) { notify("请输入有效的消费金额。", "error"); return; }
                  const result = spendWithFamilyCard(card.id, value, "亲属卡消费", "亲属卡日常消费");
                  if (!result.ok) notify(result.error || "操作失败", "error"); else notify("消费已记录");
                  onChange();
                }} className="wallet-form-primary flex-1 disabled:opacity-45">确认消费</button>
                <button type="button" onClick={() => { updateFamilyCard(card.id, { status: card.status === "active" ? "paused" : "active" }); onChange(); }} className="wallet-form-secondary">{card.status === "active" ? "暂停使用" : "恢复使用"}</button>
              </div>
            </div>
            {txs.slice(0, 3).map(tx => <div key={tx.id} className="mt-2 flex justify-between text-[11px] text-[var(--c-icon)]"><span>{time(tx.at)} · {tx.title}</span><span>{money(tx.amount)}</span></div>)}
          </div>
          </div>
        );
      })}
      {!cards.length && <div className="wallet-empty-state rounded-2xl p-6 text-center"><div className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-2xl bg-[#e9eee5] text-[#71806b]"><CreditCard size={20}/></div><div className="text-sm font-medium text-[#4d5148]">还没有亲属卡</div><p className="mt-1 text-xs text-[#8a8579]">创建后即可设置每月额度、记录消费并查看剩余额度。</p></div>}
    </div>
  );
}

function JointTab({ characters, funds, onChange }: { characters: ReturnType<typeof loadCharacters>; funds: JointFund[]; onChange: () => void }) {
  const [characterId, setCharacterId] = useState(characters[0]?.id || "");
  const [name, setName] = useState("旅行基金");
  const [goal, setGoal] = useState("5000");
  const [amount, setAmount] = useState("100");
  const [message, setMessage] = useState("");

  const create = () => {
    if (!characterId) { setMessage("请先创建一个角色，再建立共同目标。"); return; }
    if (!name.trim()) { setMessage("给这个目标起个名字吧。"); return; }
    const value = Number(goal);
    if (!Number.isFinite(value) || value <= 0) { setMessage("请输入有效的目标金额。"); return; }
    createJointFund({ name: name.trim(), goalLabel: name.trim(), goalAmount: value, userId: "user", characterId });
    setMessage("共同目标已创建。");
    notify("已创建小金库");
    onChange();
  };

  const deposit = (fund: JointFund) => {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { notify("请输入有效的存入金额。", "error"); return; }
    const result = depositToJointFund(fund.id, "user", "user", value, "手动存入");
    if (!result.ok) notify(result.error || "操作失败", "error"); else notify("存入成功");
    onChange();
  };

  const createPlan = (fund: JointFund) => {
    if (fund.status !== "active") { notify("这个小金库已经达成目标，不能再设置定期存入。", "error"); return; }
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) { notify("请输入有效的自动存入金额。", "error"); return; }
    setJointFundPlan({ fundId: fund.id, memberType: "user", memberId: "user", cadence: "weekly", amount: value });
    onChange();
    notify("已设置你每周自动存入");
  };

  return (
    <div className="wallet-private-bank wallet-joint-tab flex flex-col gap-3">
      <div className="wallet-subpage-heading px-1 pb-1">
        <div className="wallet-kicker mb-1">SHARED SAVINGS</div>
        <div className="text-xl font-semibold text-[#292b25]">共同小金库</div>
        <p className="mt-1 text-[11px] text-[#898579]">为旅行、礼物或共同计划设一个目标，一起慢慢积累。</p>
      </div>

      <section className="wallet-form-card wallet-joint-create">
        <div className="wallet-form-card-heading">
          <div>
            <div className="wallet-form-eyebrow">A PLAN TOGETHER</div>
            <h3>新建共同目标</h3>
            <p>选一位共同参与的角色，再设定想攒下的金额。</p>
          </div>
          <span className="wallet-form-mark">✧</span>
        </div>

        <label className="wallet-form-field">
          <span className="wallet-form-label">目标名称</span>
          <input type="text" value={name} onChange={event => setName(event.target.value)} maxLength={28} placeholder="例如：下一次旅行" className="wallet-form-control" />
        </label>
        <div className="wallet-form-grid">
          <label className="wallet-form-field">
            <span className="wallet-form-label">目标金额</span>
            <span className="wallet-form-currency">
              <span>¥</span>
              <input type="number" min="0.01" step="0.01" inputMode="decimal" value={goal} onChange={event => setGoal(event.target.value)} placeholder="5000" />
            </span>
          </label>
          <label className="wallet-form-field">
            <span className="wallet-form-label">共同参与者</span>
            <select value={characterId} onChange={event => setCharacterId(event.target.value)} disabled={!characters.length} className="wallet-form-control">
              {characters.length ? characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>) : <option value="">暂无可选角色</option>}
            </select>
          </label>
        </div>
        <button type="button" onClick={create} disabled={!characters.length} className="wallet-form-primary wallet-form-primary-full disabled:cursor-not-allowed disabled:opacity-45">创建共同小金库</button>
        {message && <div role="status" className="wallet-form-message">{message}</div>}
      </section>

      {funds.map(fund => {
        const character = characters.find(c => c.id === fund.characterId);
        const plans = loadJointFundPlans(fund.id);
        const txs = loadJointFundTransactions(fund.id);
        return (
          <div key={fund.id} className="wallet-section rounded-2xl p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0"><div className="text-sm font-semibold text-[var(--c-text)]">{fund.name}</div><div className="mt-1 text-[11px] text-[var(--c-icon)]">和 {character?.name || "角色"} 一起 · 目标 {money(fund.goalAmount)}</div></div>
              <div className="shrink-0 text-right"><div className="text-base font-semibold text-[#476c4e]">{money(fund.balance)}</div><div className="text-[10px] text-[var(--c-icon)]">已存入</div></div>
            </div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--c-input)]"><div className="h-full rounded-full bg-[var(--c-primary)]" style={{ width: Math.min(100, fund.balance / fund.goalAmount * 100) + "%" }} /></div>
            <div className="mt-1 flex justify-between text-[10px] text-[var(--c-icon)]"><span>{Math.min(100, Math.round(fund.balance / fund.goalAmount * 100))}% 已完成</span><span>{fund.balance >= fund.goalAmount ? "目标已达成" : `还差 ${money(fund.goalAmount - fund.balance)}`}</span></div>

            <div className="wallet-joint-deposit">
              <label className="wallet-joint-deposit-label" htmlFor={`joint-deposit-${fund.id}`}>存入金额</label>
              <div className="wallet-joint-deposit-row">
                <span className="wallet-form-currency">
                  <span>¥</span>
                  <input id={`joint-deposit-${fund.id}`} type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0.00" />
                </span>
                <button type="button" onClick={() => deposit(fund)} className="wallet-form-primary wallet-joint-deposit-submit">存入</button>
              </div>
            </div>

            <div className="wallet-joint-plan-row">
              <button type="button" onClick={() => createPlan(fund)} className="wallet-form-secondary">为我设置每周自动存入</button>
              {plans.map(plan => plan.memberType === "user"
                ? <button type="button" key={plan.id} onClick={() => { removeJointFundPlan(plan.id); onChange(); }} className="wallet-form-plan-chip">我 · {plan.cadence === "weekly" ? "每周" : plan.cadence === "daily" ? "每日" : "每月"} {money(plan.amount)} · 取消</button>
                : <span key={plan.id} className="wallet-form-plan-chip" aria-label="角色自行设置的定期存款计划">TA · {plan.cadence === "weekly" ? "每周" : plan.cadence === "daily" ? "每日" : "每月"} {money(plan.amount)} · 角色设置</span>)}
            </div>
            {txs.slice(0, 3).map(tx => <div key={tx.id} className="mt-2 flex justify-between text-[11px] text-[var(--c-icon)]"><span>{time(tx.at)} · {tx.note}</span><span>{money(tx.amount)}</span></div>)}
          </div>
        );
      })}
      {!funds.length && <div className="wallet-empty-state rounded-2xl p-6 text-center"><div className="mx-auto mb-2 grid h-11 w-11 place-items-center rounded-2xl bg-[#eee9dc] text-[#8a7955]"><Target size={20}/></div><div className="text-sm font-medium text-[#4d5148]">还没有共同小金库</div><p className="mt-1 text-xs text-[#8a8579]">为旅行、礼物或共同计划创建一个目标，一起积累进度。</p></div>}
    </div>
  );
}

function LedgerTab({ characters, selectedCharacterId, onSelectCharacter }: {
  characters: ReturnType<typeof loadCharacters>;
  selectedCharacterId: string;
  onSelectCharacter: (id: string) => void;
}) {
  const selected = characters.find(character => character.id === selectedCharacterId) || characters[0];
  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 pb-1"><div className="wallet-kicker mb-1">CHARACTER FINANCE</div><div className="text-xl font-semibold text-[#292b25]">角色账本</div><p className="mt-1 text-[11px] text-[#898579]">切换角色查看对应余额、流水和固定收入设置；每位角色的账目彼此独立。</p></div>
      {characters.length > 0 && <label className="wallet-section flex items-center gap-3 rounded-2xl p-3"><span className="shrink-0 text-xs text-[var(--c-icon)]">当前角色</span><select value={selected?.id || ""} onChange={event => onSelectCharacter(event.target.value)} className="ui-select min-w-0 flex-1">{characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}</select></label>}
      {selected && <CharacterLedgerCard key={selected.id} character={selected} />}
      {characters.length === 0 && <div className="rounded-2xl bg-[var(--c-card)] p-6 text-center text-sm text-[var(--c-icon)]">还没有角色</div>}
    </div>
  );
}

function CharacterLedgerCard({ character }: { character: ReturnType<typeof loadCharacters>[number] }) {
  const [profile, setProfile] = useState<CharacterEconomyProfile | null>(null);
  const [initial, setInitial] = useState("");
  const [amount, setAmount] = useState("");
  const [cadence, setCadence] = useState<CharacterIncomeCadence>("monthly");
  const [enabled, setEnabled] = useState(true);
  const [revision, setRevision] = useState(0);
  const [loadingProfile, setLoadingProfile] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoadingProfile(true);
    void ensureCharacterEconomyProfileAsync(character).then(next => {
      if (!alive) return;
      setProfile(next);
      setInitial(String(next.initialDeposit));
      setAmount(String(next.incomeAmount));
      setCadence(next.cadence);
      setEnabled(next.enabled);
    }).catch(error => {
      if (alive) notify(error instanceof Error ? error.message : "经济档案生成失败", "error");
    }).finally(() => {
      if (alive) setLoadingProfile(false);
    });
    return () => { alive = false; };  }, [character]);

  useEffect(() => {
    const sync = () => setRevision(value => value + 1);
    window.addEventListener(CHARACTER_ECONOMY_UPDATED_EVENT, sync);
    return () => window.removeEventListener(CHARACTER_ECONOMY_UPDATED_EVENT, sync);
  }, []);

  const ledger = loadCharacterLedger(character.id);
  const latest = ledger?.statements?.[0];
  const now = new Date();
  const monthRows = (ledger?.transactions || []).filter(tx => { const date = new Date(tx.at); return !Number.isNaN(date.getTime()) && date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth(); });
  const monthIncome = monthRows.filter(tx => tx.amount > 0).reduce((sum, tx) => sum + tx.amount, 0);
  const monthExpense = monthRows.filter(tx => tx.amount < 0).reduce((sum, tx) => sum + Math.abs(tx.amount), 0);
  const expenseCategories = monthRows.filter(tx => tx.amount < 0).reduce<Record<string, number>>((acc, tx) => { acc[tx.category] = (acc[tx.category] || 0) + Math.abs(tx.amount); return acc; }, {});
  const topExpense = Object.entries(expenseCategories).sort((a,b) => b[1] - a[1]).slice(0,3);
  const save = () => {
    try {
      setCharacterInitialDeposit(character.id, Number(initial) || 0);
      const next = updateCharacterIncomePlan(character.id, {
        incomeAmount: Number(amount) || 0,
        cadence,
        enabled,
      });
      setProfile(next);
      setRevision(value => value + 1);
      notify(`${character.name} 的账本设置已保存`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "保存失败", "error");
    }
  };

  return (
    <div className="wallet-section rounded-2xl p-4" data-revision={revision}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-[var(--c-text)]">{character.name} 的账本</div>
        <div className="text-lg font-semibold">{money(ledger?.balance || 0)}</div>
      </div>
      <div className="mt-1 text-[11px] text-[var(--c-icon)]">
        {latest ? `本周收入 ${money(latest.income)} · 支出 ${money(latest.expense)} · 结余 ${money(latest.closing)}` : "还没有收支记录"}
        {profile?.initialAppliedAt ? " · 初始存款已入账" : ""}
        {profile?.enabled && profile.incomeAmount > 0 ? ` · 下次固定收入 ${time(profile.nextIncomeAt)}` : ""}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-[#e9eee5] p-3"><div className="text-[10px] text-[#6c8068]">本月收入</div><div className="mt-1 text-sm font-semibold text-[#3f6547]">{money(monthIncome)}</div></div>
        <div className="rounded-xl bg-[#eee9e2] p-3"><div className="text-[10px] text-[#8d7165]">本月支出</div><div className="mt-1 text-sm font-semibold text-[#80594d]">{money(monthExpense)}</div></div>
      </div>
      {topExpense.length > 0 && <div className="mt-2 rounded-xl bg-[var(--c-input)] p-3"><div className="mb-2 text-[10px] text-[var(--c-icon)]">本月消费去向</div><div className="flex flex-wrap gap-2">{topExpense.map(([name,value])=><span key={name} className="rounded-full bg-white/70 px-2 py-1 text-[10px] text-[#777]">{name} {money(value)}</span>)}</div></div>}
            {loadingProfile && <div className="mt-2 text-[11px] text-[var(--c-icon)]">正在根据角色卡分析经济档案…</div>}
      {!loadingProfile && profile?.basis && (
        <div className="mt-2 rounded-xl bg-[var(--c-input)] px-3 py-2 text-[10px] text-[var(--c-icon)]">
          {profile.source === "llm" ? "大模型按角色卡判断" : "人设关键词兜底"}：{profile.basis}
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="text-[11px] text-[var(--c-icon)]">初始存款
          <input type="number" inputMode="decimal" value={initial} disabled={loadingProfile} onChange={event => setInitial(event.target.value)} className="ui-input mt-1 w-full" />
        </label>
        <label className="text-[11px] text-[var(--c-icon)]">固定收入
          <input type="number" inputMode="decimal" value={amount} disabled={loadingProfile} onChange={event => setAmount(event.target.value)} className="ui-input mt-1 w-full" />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <select value={cadence} disabled={loadingProfile} onChange={event => setCadence(event.target.value === "weekly" ? "weekly" : "monthly")} className="ui-select flex-1">
          <option value="monthly">每月发一次（30 天）</option>
          <option value="weekly">每周发一次（7 天）</option>
        </select>
        <button type="button" disabled={loadingProfile} onClick={() => setEnabled(value => !value)} className={`shrink-0 rounded-full px-3 py-2 text-xs ${enabled ? "bg-[var(--c-primary)] text-white" : "bg-[var(--c-input)] text-[var(--c-text)]"}`}>
          {enabled ? "自动收入开" : "自动收入关"}
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="text-[10px] text-[var(--c-icon)]">固定收入由系统自动入账；额外收入/支出仍由角色用收支工具记账。</div>
        <button type="button" disabled={loadingProfile} onClick={save} className="ui-btn ui-btn-primary shrink-0 px-4">保存</button>
      </div>
      <div className="mt-3 flex flex-col gap-1">
        {(ledger?.transactions || []).slice(-4).reverse().map(tx => (
          <div key={tx.id} className="flex justify-between text-[11px] text-[var(--c-icon)]">
            <span>{time(tx.at)} · {tx.note || tx.category}</span>
            <span className={tx.amount < 0 ? "text-rose-500" : "text-emerald-600"}>{tx.amount < 0 ? "-" : "+"}{money(Math.abs(tx.amount))}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
