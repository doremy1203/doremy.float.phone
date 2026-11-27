import { emitBailoutCancel } from "./bailout-cancel";
import { markBailoutDirty } from "./bailout-dirty";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const TIMED_WAKE_SCHEDULES_KEY = "ai_phone_timed_wake_schedules_v1";

registerKvMigration(TIMED_WAKE_SCHEDULES_KEY);

export type TimedWakeSchedule = {
    id: string;
    sessionId: string;
    characterId: string;
    fireAt: number;
    createdAt: number;
    delayMinutes: number;
    intent: string;
    /** 创建来源：tool=角色自己约的（"你当时想着"视角）/ user=用户预约（"TA拜托你"视角）。缺省按 tool。 */
    source?: "tool" | "user";
    /** 角色休息时保留任务，醒来后再询问。 */
    retryIfSleeping?: boolean;
    /** 会话正在进行其他回合时延后执行，避免丢掉必须完成的系统询问。 */
    retryIfBusy?: boolean;
};

export function makeTimedWakeId(sessionId: string): string {
    return `timed_wake_${sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function loadTimedWakeSchedules(): TimedWakeSchedule[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(TIMED_WAKE_SCHEDULES_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isTimedWakeSchedule);
    } catch {
        return [];
    }
}

function saveTimedWakeSchedules(schedules: TimedWakeSchedule[]): void {
    if (typeof window === "undefined") return;
    kvSet(TIMED_WAKE_SCHEDULES_KEY, JSON.stringify(schedules));
    // 排期一变就请监听方立刻把任务挂到服务端——不能等到「启动 20 秒后」或
    // 「切后台」那两个时点才组装上传，否则新建后很快退出/被杀会整单丢失。
    markBailoutDirty();
}

export function saveTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    const next = all.filter(item => item.sessionId !== schedule.sessionId);
    next.push(schedule);
    saveTimedWakeSchedules(next);
}

/** 追加一条后台主动联系，不覆盖用户或角色已经预约的其他定时唤醒。 */
export function appendTimedWakeSchedule(schedule: TimedWakeSchedule): void {
    const all = loadTimedWakeSchedules();
    if (all.some(item => item.id === schedule.id)) return;
    saveTimedWakeSchedules([...all, schedule]);
}

export function clearTimedWakeSchedule(sessionId: string): void {
    // 先取出被清掉的条目，逐个撤销服务端预约——只改本地会让那条已经挂上去的
    // 任务照常在原定时刻触发，用户看到「已经取消了，通知还是弹了」。
    const removing = loadTimedWakeSchedules().filter(item => item.sessionId === sessionId);
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.sessionId !== sessionId));
    for (const item of removing) emitBailoutCancel({ key: `timedwake:${item.id}` });
}

export function removeTimedWakeSchedule(id: string): void {
    saveTimedWakeSchedules(loadTimedWakeSchedules().filter(item => item.id !== id));
    // 同上：本地删除必须同步撤销服务端预约。
    emitBailoutCancel({ key: `timedwake:${id}` });
}

function isTimedWakeSchedule(value: unknown): value is TimedWakeSchedule {
    if (!value || typeof value !== "object") return false;
    const item = value as Partial<TimedWakeSchedule>;
    return typeof item.id === "string"
        && typeof item.sessionId === "string"
        && typeof item.characterId === "string"
        && typeof item.fireAt === "number"
        && typeof item.createdAt === "number"
        && typeof item.delayMinutes === "number"
        && typeof item.intent === "string";
}
