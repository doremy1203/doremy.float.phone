"use client";

import { bgSetInterval } from "@/lib/bg-timer";
import { sendBrowserNotification } from "@/lib/browser-notification";
import { sendShellNotification } from "@/lib/shell-notify";
import { formatWalletAmount } from "@/lib/wallet-storage";
import { loadChatSessions, resolveSessionCharacterId } from "@/lib/chat-storage";
import { appendTimedWakeSchedule, loadTimedWakeSchedules, makeTimedWakeId } from "@/lib/timed-wake-storage";
import {
    loadJointFundPlans,
    loadJointFunds,
    markJointFundPlanReminded,
    runDueJointFundPlans,
} from "./joint-fund";

const CHECK_INTERVAL_MS = 60_000;
const REMIND_LEAD_MS = 12 * 60 * 60_000;
const MAX_REMINDERS_PER_TICK = 3;

let activeStop: (() => void) | null = null;

function sendNotice(title: string, body: string, kind: "success" | "error" | "info"): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("app-global-notice", { detail: { kind, message: body } }));
    if (typeof document === "undefined" || !document.hidden) return;
    if (!sendShellNotification(`小金库 · ${title}`, body)) {
        sendBrowserNotification(`小金库 · ${title}`, { body });
    }
}

function formatLead(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.round(minutes / 60);
    return `${hours} 小时`;
}

/**
 * 小金库调度器：App 存活期间每分钟检查到期计划，并在到期前 12 小时提醒。
 *
 * WebView 被系统冻结时无法保证准点执行，所以这里同时依赖：
 *  - 启动/回到前台时补跑到期计划（catch-up）；
 *  - 保存计划时 nextRunAt 已写好，用户下次打开 App 仍会补上。
 * 真正需要「杀进程也准点」的场景应交给原生闹钟；本调度器不伪装成那层保证。
 */
export function runJointFundSchedulerTick(now = Date.now()): void {
    const results = runDueJointFundPlans(now);
    for (const result of results) {
        if (result.ok) {
            if (result.alreadyCompleted) {
                sendNotice("目标已完成", `「${result.fundName}」已被提前存满，原定期存款已停止。`, "success");
            } else {
                sendNotice(
                    "自动存入",
                    `「${result.fundName}」已自动存入 ${formatWalletAmount(result.amount)}（${result.memberType === "user" ? "你" : "TA"}）。`,
                    "success",
                );
            }
            if (result.goalReached && result.memberType === "character") {
                const alternatives = result.otherFunds || [];
                if (alternatives.length === 0) {
                    sendNotice("目标已完成", `「${result.fundName}」已达成目标，目前没有其他进行中的共同小金库，${"角色"}的定期存款已自动结束。`, "success");
                } else {
                    const session = loadChatSessions().find(item =>
                        !item.isGroup
                        && item.id === result.sessionId
                        && resolveSessionCharacterId(item) === result.memberId
                    ) || loadChatSessions().find(item =>
                        !item.isGroup && resolveSessionCharacterId(item) === result.memberId
                    );
                    if (session) {
                        const choices = alternatives.map(fund => `「${fund.name}」（小金库 ID：${fund.id}）`).join("、");
                        const createdAt = Date.now();
                        const nearExistingWake = loadTimedWakeSchedules()
                            .filter(item => item.sessionId === session.id && item.fireAt <= createdAt + 60_000)
                            .reduce((latest, item) => Math.max(latest, item.fireAt), 0);
                        const fireAt = Math.max(createdAt + 60_000, nearExistingWake + 60_000);
                        appendTimedWakeSchedule({
                            id: makeTimedWakeId(session.id),
                            sessionId: session.id,
                            characterId: result.memberId,
                            fireAt,
                            createdAt,
                            delayMinutes: Math.max(1, Math.ceil((fireAt - createdAt) / 60_000)),
                            intent: `你刚刚定期存款的「${result.fundName}」已经达到目标，系统已自动停止这个目标的定期存款。你们还有其他正在进行的小金库：${choices}。请像平时聊天一样主动问用户：要不要把之后的定期存款改存到其中一个？不要替用户或自己擅自选择，也不要自动创建新计划；等用户明确同意并选定目标后，再调用「设置小金库定期存款」工具设置频率和金额。如果用户不想继续，就保持停止状态。`,
                            source: "tool",
                            retryIfSleeping: true,
                            retryIfBusy: true,
                        });
                        sendNotice("目标已完成", `「${result.fundName}」已达成目标，原定期存款已停止；我会让角色问问是否要改存其他小金库。`, "success");
                    } else {
                        sendNotice("目标已完成", `「${result.fundName}」已达成目标，但找不到这位角色的私聊会话，定期存款已停止。`, "info");
                    }
                }
            }
        } else {
            sendNotice(
                "自动存入失败",
                `「${result.fundName}」定时存入失败：${result.error || "余额不足"}。明天会自动重试。`,
                "error",
            );
        }
    }

    const plans = loadJointFundPlans().filter(plan => (
        plan.enabled
        && plan.nextRunAt > now
        && plan.nextRunAt - now <= REMIND_LEAD_MS
        && plan.remindedForRunAt !== plan.nextRunAt
    ));
    if (plans.length === 0) return;

    const funds = new Map(loadJointFunds().map(fund => [fund.id, fund]));
    let sent = 0;
    for (const plan of plans) {
        if (sent >= MAX_REMINDERS_PER_TICK) break;
        const fund = funds.get(plan.fundId);
        if (!fund) continue;
        markJointFundPlanReminded(plan.id, plan.nextRunAt);
        sendNotice(
            "即将自动存入",
            `「${fund.name}」将在 ${formatLead(plan.nextRunAt - now)}后自动存入 ${formatWalletAmount(plan.amount)}（${plan.memberType === "user" ? "你" : "TA"}），记得留足余额。`,
            "info",
        );
        sent += 1;
    }
}

export function startJointFundScheduler(): () => void {
    if (typeof window === "undefined") return () => {};
    if (activeStop) return activeStop;

    const tick = () => {
        try {
            runJointFundSchedulerTick();
        } catch (error) {
            console.warn("[JointFund] scheduler tick failed:", error);
        }
    };
    tick();

    const stopTimer = bgSetInterval(tick, CHECK_INTERVAL_MS);
    const handleVisibility = () => {
        if (!document.hidden) tick();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("pageshow", tick);

    const stop = () => {
        stopTimer();
        document.removeEventListener("visibilitychange", handleVisibility);
        window.removeEventListener("pageshow", tick);
        if (activeStop === stop) activeStop = null;
    };
    activeStop = stop;
    return stop;
}

export function stopJointFundScheduler(): void {
    activeStop?.();
}
