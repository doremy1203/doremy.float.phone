"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, CreditCard, Plus, Trash2, WalletCards, Wifi } from "lucide-react";

import { ConfirmDialog } from "@/components/ui";
import { PageShell } from "@/components/ui/page-shell";
import { WalletHeaderIsolationStyle } from "@/components/wallet-header-isolation-style";
import {
  adjustWalletCardAccount,
  createWalletCard,
  deleteWalletCard,
  formatWalletAmount,
  getWalletBalance,
  loadWalletState,
  transferCardToWalletBalance,
  transferWalletBalanceToCard,
  WALLET_UPDATED_EVENT,
} from "@/lib/wallet-storage";
import type { WalletCard, WalletCardStyle, WalletState } from "@/lib/wallet-types";

type WalletPanelTab = "home" | "accounts" | "family" | "joint" | "ledger" | "budget" | "goals" | "bills" | "calendar" | "insights";
type WalletPanelProps = {
  onBack: () => void;
  onNavigateTab: (tab: WalletPanelTab) => void;
};

const WALLET_NAV_TABS: Array<{ id: WalletPanelTab; label: string }> = [
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

const WALLET_STYLE_OPTIONS: Array<{ id: WalletCardStyle; label: string }> = [
  { id: "obsidian", label: "黑金" },
  { id: "graphite", label: "石墨" },
  { id: "silver", label: "银灰" },
];

function formatWalletTimeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getDisplayCardNumber(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "**** **** **** 0000";
  const tail = normalized.replace(/\D/g, "").slice(-4);
  if (!tail) return normalized;
  return `**** **** **** ${tail}`;
}

function WalletBankCard({
  card,
  active,
}: {
  card: WalletCard;
  active: boolean;
}) {
  return (
    <div
      data-account-id={card.id}
      className={`cp-premium-bank-card cp-premium-bank-card--${card.cardStyle} ${active ? "is-active" : ""}`}
      aria-current={active ? "true" : undefined}
    >
      <div className="cp-card-texture"></div>
      <div className="cp-card-dots"></div>
      <div className="cp-card-overlay-shine"></div>

      <div className="cp-card-top-row">
        <div className="cp-card-bank-header">
          <div className="cp-card-logo-mark">
            <WalletCards size={20} strokeWidth={1.5} />
          </div>
          <div className="cp-card-bank-text">
            <span className="cp-card-bank-name">{card.bankLabel}</span>
            <span className="cp-card-bank-sub">REAL BALANCE</span>
          </div>
        </div>
        <div className="cp-card-top-right">
          <span className="cp-card-custom-label">{card.accentLabel}</span>
        </div>
      </div>

      <div className="cp-card-mid-row">
        <div className="cp-card-chip">
          <div className="cp-chip-line cp-chip-line-1"></div>
          <div className="cp-chip-line cp-chip-line-2"></div>
          <div className="cp-chip-line cp-chip-line-3"></div>
          <div className="cp-chip-line cp-chip-line-4"></div>
          <div className="cp-chip-line-center"></div>
        </div>
        <Wifi size={22} className="cp-card-nfc" />
      </div>

      <div className="cp-card-number">{getDisplayCardNumber(card.maskedNumber)}</div>

      <div className="cp-card-bottom-row">
        <div className="cp-card-holder-group">
          <div className="cp-card-holder">
            <span>CARD NAME</span>
            <strong>{card.title}</strong>
          </div>
          <div className="cp-card-expiry">
            <span>BALANCE</span>
            <strong>{formatWalletAmount(card.balance)}</strong>
          </div>
        </div>
        <div className="cp-card-brand-box">
          <div className="cp-card-brand-label">BANK</div>
          <strong>PAY</strong>
        </div>
      </div>
    </div>
  );
}

export function WalletPanel({ onBack, onNavigateTab }: WalletPanelProps) {
  const [wallet, setWallet] = useState<WalletState>(() => loadWalletState());
  const [activeCardId, setActiveCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [balanceTransferMode, setBalanceTransferMode] = useState<"deposit" | "withdraw" | null>(null);
  const [transferScope, setTransferScope] = useState<"balance" | "card">("balance");
  const [transferCardId, setTransferCardId] = useState(() => wallet.defaultCardId || wallet.cards[0]?.id || "");
  const [transferLockedCardId, setTransferLockedCardId] = useState<string | null>(null);
  const [transferAmount, setTransferAmount] = useState("100");
  const [addOpen, setAddOpen] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState("储蓄卡");
  const [newCardTail, setNewCardTail] = useState("");
  const [newCardBalance, setNewCardBalance] = useState("0");
  const [newCardStyle, setNewCardStyle] = useState<WalletCardStyle>("graphite");
  const [deleteCardId, setDeleteCardId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardStackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncWallet = () => {
      const next = loadWalletState();
      setWallet(next);
      setActiveCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferCardId(current => next.cards.some(card => card.id === current)
        ? current
        : next.defaultCardId || next.cards[0]?.id || "");
      setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
    };
    window.addEventListener(WALLET_UPDATED_EVENT, syncWallet);
    return () => window.removeEventListener(WALLET_UPDATED_EVENT, syncWallet);
  }, []);

  const activeCard = useMemo(
    () => wallet.cards.find(card => card.id === activeCardId) ?? wallet.cards[0],
    [activeCardId, wallet.cards],
  );
  const selectedTransferCard = useMemo(
    () => wallet.cards.find(card => card.id === transferCardId) ?? wallet.cards[0],
    [transferCardId, wallet.cards],
  );
  const walletBalance = useMemo(() => getWalletBalance(wallet), [wallet]);
  const recentTransactions = useMemo(
    () => wallet.transactions.slice(0, 60),
    [wallet.transactions],
  );

  useEffect(() => {
    const container = cardStackRef.current;
    if (!container) return;

    let ticking = false;
    const syncActiveCardFromScroll = () => {
      ticking = false;
      const cards = Array.from(container.querySelectorAll<HTMLElement>(".cp-premium-bank-card"));
      if (cards.length === 0) return;

      const containerCenter = container.scrollLeft + container.clientWidth / 2;
      let nearestId = "";
      let nearestDistance = Number.POSITIVE_INFINITY;

      for (const card of cards) {
        const cardCenter = card.offsetLeft + card.offsetWidth / 2;
        const distance = Math.abs(cardCenter - containerCenter);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestId = card.dataset.accountId ?? "";
        }
      }

      if (nearestId) {
        setActiveCardId(current => current === nearestId ? current : nearestId);
      }
    };

    const handleScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(syncActiveCardFromScroll);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    syncActiveCardFromScroll();
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [wallet.cards.length]);

  function refresh(next: WalletState) {
    setWallet(next);
    setActiveCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferCardId(current => next.cards.some(card => card.id === current)
      ? current
      : next.defaultCardId || next.cards[0]?.id || "");
    setTransferLockedCardId(current => current && next.cards.some(card => card.id === current) ? current : null);
  }

  function openBalanceTransfer(mode: "deposit" | "withdraw", options?: { scope?: "balance" | "card" }) {
    const nextCardId = activeCard?.id || wallet.defaultCardId || wallet.cards[0]?.id || "";
    setTransferCardId(nextCardId);
    setTransferScope(options?.scope ?? "balance");
    setTransferLockedCardId(options?.scope === "card" ? nextCardId : null);
    setTransferAmount("100");
    setError(null);
    setBalanceTransferMode(mode);
  }

  function closeBalanceTransfer() {
    setBalanceTransferMode(null);
    setTransferScope("balance");
    setTransferLockedCardId(null);
  }

  function handleBalanceTransfer() {
    if (!selectedTransferCard || !balanceTransferMode) return;
    const result = transferScope === "card"
      ? adjustWalletCardAccount(selectedTransferCard.id, Number(transferAmount), balanceTransferMode === "deposit" ? "in" : "out")
      : balanceTransferMode === "deposit"
        ? transferCardToWalletBalance(selectedTransferCard.id, Number(transferAmount))
        : transferWalletBalanceToCard(selectedTransferCard.id, Number(transferAmount));
    if (!result.ok) {
      setError(result.error ?? (
        transferScope === "card"
          ? balanceTransferMode === "deposit" ? "转入账户失败。" : "转出账户失败。"
          : balanceTransferMode === "deposit" ? "转入失败。" : "提现失败。"
      ));
      return;
    }
    setError(null);
    refresh(result.state);
    closeBalanceTransfer();
  }

  function handleAddCard() {
    const tail = newCardTail.replace(/\D/g, "").slice(-4);
    const next = createWalletCard({
      title: newCardTitle,
      maskedNumber: tail ? `**** **** **** ${tail}` : undefined,
      balance: Number(newCardBalance),
      cardStyle: newCardStyle,
      bankLabel: "CHAT WALLET",
      accentLabel: "储蓄",
      note: "用户手动添加的银行卡",
    });
    setError(null);
    setWallet(next);
    setActiveCardId(next.cards[0]?.id ?? next.defaultCardId);
    setTransferCardId(next.cards[0]?.id ?? next.defaultCardId);
    setAddOpen(false);
    setNewCardTitle("储蓄卡");
    setNewCardTail("");
    setNewCardBalance("0");
    setNewCardStyle("graphite");
  }

  function handleDeleteCard() {
    if (!deleteCardId) return;
    const result = deleteWalletCard(deleteCardId);
    if (!result.ok) {
      setError(result.error ?? "删除失败。");
      setDeleteCardId(null);
      return;
    }
    setError(null);
    refresh(result.state);
    setDeleteCardId(null);
  }

  const transferCardLocked = transferScope === "card" || Boolean(transferLockedCardId);
  const transferTitle = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "转出账户" : "转入账户"
    : balanceTransferMode === "withdraw" ? "提现到银行卡" : "银行卡转入余额";
  const transferInputLabel = transferScope === "card"
    ? "金额"
    : balanceTransferMode === "withdraw" ? "提现金额" : "转入金额";
  const transferConfirmLabel = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? "确认转出" : "确认转入"
    : balanceTransferMode === "withdraw" ? "确认提现" : "确认转入";
  const transferLimit = transferScope === "card"
    ? balanceTransferMode === "withdraw" ? selectedTransferCard?.balance : undefined
    : balanceTransferMode === "withdraw" ? walletBalance : selectedTransferCard?.balance;

  return (
    <PageShell title="余额管理" onBack={onBack} className="wallet-page-root" headerClassName="wallet-app-header" headerStyle={{ background: "#f7f6f0", backgroundColor: "#f7f6f0", backgroundImage: "none", backdropFilter: "none", WebkitBackdropFilter: "none", zIndex: 50, isolation: "isolate" }}>
      <WalletHeaderIsolationStyle />

      <div className="wallet-private-bank wallet-tab-row flex shrink-0 gap-2 overflow-x-auto px-4 pb-3 pt-1" aria-label="钱包页面导航">
        {WALLET_NAV_TABS.map(item => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigateTab(item.id)}
            aria-current={item.id === "accounts" ? "page" : undefined}
            className={`wallet-tab shrink-0 rounded-full px-4 py-2 text-sm transition-colors`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="p-4 flex flex-col gap-4 pb-24">
        <section className="wallet-balance-hero rounded-2xl p-5 overflow-hidden relative min-h-[156px] flex flex-col justify-between">
          <div className="relative flex items-start justify-between gap-4">
            <div>
              <div className="wallet-luxe-kicker" style={{color:"#c7b78e"}}>PRIVATE WALLET · REAL BALANCE</div>
              <div className="ts-34 font-semibold mt-2" style={{ fontFamily: "Georgia, serif" }}>{formatWalletAmount(walletBalance)}</div>
              <div className="ts-12 opacity-70 mt-1">可用余额 · 红包、转账与付款默认账户</div>
            </div>
            <span className="ts-10 font-semibold opacity-75 tracking-[0.12em] shrink-0 text-right">{wallet.cards.length} ACCOUNTS<br/><span className="text-[9px] opacity-60">账户总额 ¥{(wallet.balance + wallet.cards.reduce((sum, card) => sum + card.balance, 0)).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}</span></span>
          </div>
          <div className="relative flex items-end justify-between gap-3">
            <span className="ts-12 opacity-70">{wallet.transactions.length} 条流水</span>
            <div className="flex items-center gap-2">
              <button type="button" className="wallet-balance-action" onClick={() => openBalanceTransfer("deposit")}>
                <ArrowDownToLine size={14} />
                转入
              </button>
              <button type="button" className="wallet-balance-action" onClick={() => openBalanceTransfer("withdraw")}>
                <ArrowUpFromLine size={14} />
                提现
              </button>
            </div>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <div><div className="wallet-luxe-kicker">YOUR ACCOUNTS</div><h2 className="ts-17 font-semibold text-[#292b25] mt-1">账户与银行卡</h2></div>
            <button type="button" onClick={() => setAddOpen(true)} className="min-h-[36px] px-3 rounded-full flex items-center gap-1.5 ts-12 font-semibold" style={{ background: "var(--c-icon-active)", color: "#fff" }}>
              <Plus size={15} />
              新增卡
            </button>
          </div>

          <div className="cp-premium-card-stack wallet-card-stack" aria-label="银行卡" ref={cardStackRef}>
            {wallet.cards.map(card => (
              <WalletBankCard
                key={card.id}
                card={card}
                active={activeCard?.id === card.id}
              />
            ))}
          </div>

        </section>

        {activeCard ? (
          <section className="wallet-luxe-panel rounded-2xl p-4 flex flex-col gap-4" style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
            <div className="min-w-0">
              <div className="ts-11 text-[var(--c-text)] opacity-60">当前银行卡余额</div>
              <div className="ts-26 font-bold text-[var(--c-text-title)] mt-1">{formatWalletAmount(activeCard.balance)}</div>
              <div className="ts-12 text-[var(--c-text)] opacity-65 mt-1">{activeCard.title} · {getDisplayCardNumber(activeCard.maskedNumber)}</div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => openBalanceTransfer("deposit", { scope: "card" })}
                className="wallet-bank-action text-[var(--c-success)]"
                style={{ background: "color-mix(in srgb, var(--c-success) 10%, var(--c-card))" }}
              >
                <ArrowDownToLine size={15} />
                转入账户
              </button>
              <button
                type="button"
                onClick={() => openBalanceTransfer("withdraw", { scope: "card" })}
                className="wallet-bank-action text-[var(--c-icon-active)]"
                style={{ background: "color-mix(in srgb, var(--c-icon-active) 10%, var(--c-card))" }}
              >
                <ArrowUpFromLine size={15} />
                转出账户
              </button>
              <button
                type="button"
                onClick={() => setDeleteCardId(activeCard.id)}
                className="wallet-bank-action text-[var(--c-danger)]"
                style={{ background: "color-mix(in srgb, var(--c-danger) 10%, var(--c-card))" }}
              >
                <Trash2 size={15} />
                删除
              </button>
            </div>

            {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
          </section>
        ) : null}

        <section className="wallet-luxe-panel rounded-2xl px-4 py-2 flex flex-col" style={{ boxShadow: "0 8px 24px rgba(0,0,0,0.025)" }}>
          <div className="py-3 flex items-center justify-between">
            <h2 className="ts-15 font-bold text-[var(--c-text-title)]">流水</h2>
            <span className="ts-11 text-[var(--c-text)] opacity-55">余额、银行卡与购物付款实时同步</span>
          </div>
          {recentTransactions.length === 0 ? (
            <div className="py-8 text-center ts-12 text-[var(--c-text)] opacity-60">暂无流水</div>
          ) : (
            recentTransactions.map(transaction => {
              const outgoing = transaction.amount < 0;
              const TransactionIcon = transaction.kind === "payment"
                ? CreditCard
                : transaction.kind === "transfer_out"
                  ? ArrowUpFromLine
                  : ArrowDownToLine;
              return (
                <div key={transaction.id} className="py-3 flex items-center gap-3 border-t border-[color-mix(in_srgb,var(--c-card-border)_22%,transparent)]">
                  <div className="w-10 h-10 rounded-2xl flex items-center justify-center shrink-0" style={{ background: outgoing ? "color-mix(in srgb, var(--c-danger) 12%, var(--c-card))" : "color-mix(in srgb, var(--c-success) 12%, var(--c-card))", color: outgoing ? "var(--c-danger)" : "var(--c-success)" }}>
                    <TransactionIcon size={18} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="ts-13 font-semibold text-[var(--c-text-title)] truncate">{transaction.title}</div>
                    <div className="ts-11 text-[var(--c-text)] opacity-60 truncate">{formatWalletTimeLabel(transaction.createdAt)} · {transaction.detail}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className={`ts-13 font-bold ${outgoing ? "text-[var(--c-danger)]" : "text-[var(--c-success)]"}`}>
                      {outgoing ? "-" : "+"}{formatWalletAmount(Math.abs(transaction.amount))}
                    </div>
                    <div className="ts-10 text-[var(--c-text)] opacity-50">余 {formatWalletAmount(transaction.balanceAfter)}</div>
                  </div>
                </div>
              );
            })
          )}
        </section>
      </div>

      {balanceTransferMode && selectedTransferCard ? (
        <div className="absolute inset-0 z-[80] flex items-end" style={{ background: "rgba(0,0,0,0.35)" }} role="presentation" onClick={closeBalanceTransfer}>
          <div className="w-full rounded-t-[24px] bg-[var(--c-page-body-bg)] p-4 flex flex-col gap-4" style={{ paddingBottom: "calc(18px + env(safe-area-inset-bottom, 0px))" }} role="dialog" aria-modal="true" aria-label={transferTitle} onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <strong className="ts-16 text-[var(--c-text-title)]">{transferTitle}</strong>
              <span className="ts-12 text-[var(--c-text)] opacity-60">
                {transferScope === "card" ? `当前卡 ${formatWalletAmount(selectedTransferCard.balance)}` : `余额 ${formatWalletAmount(walletBalance)}`}
              </span>
            </div>
            {transferCardLocked ? (
              <div className="min-h-[58px] rounded-2xl px-3 flex items-center gap-3 text-left border border-[var(--c-card-border)] bg-[var(--c-card)]">
                <WalletCards size={18} className="text-[var(--c-icon)]" />
                <span className="flex-1 min-w-0">
                  <span className="block ts-12 text-[var(--c-text)] opacity-60">当前银行卡</span>
                  <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{selectedTransferCard.title}</span>
                  <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(selectedTransferCard.maskedNumber)} · {formatWalletAmount(selectedTransferCard.balance)}</span>
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">选择银行卡</span>
                <div className="grid gap-2 max-h-[28vh] overflow-y-auto">
                  {wallet.cards.map(card => {
                    const active = selectedTransferCard.id === card.id;
                    return (
                      <button
                        key={card.id}
                        type="button"
                        onClick={() => setTransferCardId(card.id)}
                        className="min-h-[54px] rounded-2xl px-3 flex items-center gap-3 text-left"
                        style={{ border: active ? "1px solid var(--c-icon-active)" : "1px solid var(--c-card-border)", background: active ? "color-mix(in srgb, var(--c-icon-active) 8%, var(--c-card))" : "var(--c-card)" }}
                      >
                        <WalletCards size={18} className="text-[var(--c-icon)]" />
                        <span className="flex-1 min-w-0">
                          <span className="block ts-13 font-semibold text-[var(--c-text-title)] truncate">{card.title}</span>
                          <span className="block ts-11 text-[var(--c-text)] opacity-60 truncate">{getDisplayCardNumber(card.maskedNumber)} · {formatWalletAmount(card.balance)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <label className="flex flex-col gap-2">
              <span className="ts-12 font-semibold text-[var(--c-text-title)]">{transferInputLabel}</span>
              <input className="ui-input" type="number" min={0.01} max={transferLimit} step={0.01} value={transferAmount} onChange={event => setTransferAmount(event.target.value)} />
            </label>
            {error ? <div className="ts-12 text-[var(--c-danger)]">{error}</div> : null}
            <button type="button" onClick={handleBalanceTransfer} className="h-12 rounded-2xl text-white ts-14 font-bold" style={{ background: "var(--c-icon-active)" }}>{transferConfirmLabel}</button>
          </div>
        </div>
      ) : null}

      {addOpen ? (
        <div className="absolute inset-0 z-[80] flex items-end" style={{ background: "rgba(0,0,0,0.35)" }} role="presentation" onClick={() => setAddOpen(false)}>
          <div className="w-full rounded-t-[24px] bg-[var(--c-page-body-bg)] p-4 flex flex-col gap-4" style={{ paddingBottom: "calc(18px + env(safe-area-inset-bottom, 0px))" }} role="dialog" aria-modal="true" aria-label="新增银行卡" onClick={event => event.stopPropagation()}>
            <div className="flex items-center justify-between">
              <strong className="ts-16 text-[var(--c-text-title)]">新增银行卡</strong>
              <span className="ts-12 text-[var(--c-text)] opacity-60">余额不能为负</span>
            </div>
            <label className="flex flex-col gap-2">
              <span className="ts-12 font-semibold text-[var(--c-text-title)]">卡片名称</span>
              <input className="ui-input" value={newCardTitle} onChange={event => setNewCardTitle(event.target.value)} />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="flex flex-col gap-2 min-w-0">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">尾号</span>
                <input className="ui-input" inputMode="numeric" maxLength={4} value={newCardTail} onChange={event => setNewCardTail(event.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="0000" />
              </label>
              <label className="flex flex-col gap-2 min-w-0">
                <span className="ts-12 font-semibold text-[var(--c-text-title)]">初始余额</span>
                <input className="ui-input" type="number" min={0} step={0.01} value={newCardBalance} onChange={event => setNewCardBalance(event.target.value)} />
              </label>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {WALLET_STYLE_OPTIONS.map(option => (
                <button key={option.id} type="button" onClick={() => setNewCardStyle(option.id)} className="h-10 rounded-2xl ts-12 font-semibold" style={{ border: newCardStyle === option.id ? "none" : "1px solid var(--c-card-border)", background: newCardStyle === option.id ? "var(--c-icon-active)" : "var(--c-card)", color: newCardStyle === option.id ? "#fff" : "var(--c-text-title)" }}>
                  {option.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={handleAddCard} className="h-12 rounded-2xl text-white ts-14 font-bold" style={{ background: "var(--c-icon-active)" }}>添加银行卡</button>
          </div>
        </div>
      ) : null}

      {deleteCardId ? (
        <ConfirmDialog
          title="删除这张银行卡？"
          message="删除后该卡余额和流水都会从余额管理中移除。"
          variant="danger"
          confirmLabel="删除"
          cancelLabel="取消"
          onConfirm={handleDeleteCard}
          onCancel={() => setDeleteCardId(null)}
        />
      ) : null}
    </PageShell>
  );
}
