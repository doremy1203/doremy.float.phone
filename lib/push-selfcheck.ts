// 离线推送自检的客户端封装：把服务端逐段探测的结果取回来并排成可读文本。
//
// 与 push-bailout-diagnostics 的分工：
//   · push-bailout-diagnostics：只看「本机有没有把预约挂上去」，逐条重跑 arm*；
//   · 本模块：看整条链（含服务端配置、订阅、任务表、回传箱、真实广播），
//     用于判断断点究竟在服务端还是客户端。

type StepStatus = "ok" | "warn" | "fail";

type SelfCheckStep = {
    key: string;
    label: string;
    status: StepStatus;
    detail: string;
    hint?: string;
};

export type OfflinePushSelfCheckResult = {
    ok: boolean;
    steps: SelfCheckStep[];
    summary: string;
};

/** 调服务端自检接口。probe=false 时不发测试广播（避免打扰）。 */
export async function runOfflinePushSelfCheck(probe = true): Promise<OfflinePushSelfCheckResult> {
    const response = await fetch(`/api/push/selfcheck${probe ? "" : "?probe=0"}`, {
        credentials: "include",
        cache: "no-store",
    });
    const data = await response.json().catch(() => null) as OfflinePushSelfCheckResult | null;
    if (!data || !Array.isArray(data.steps)) {
        throw new Error(`自检接口没有返回可识别结果（HTTP ${response.status}）。`);
    }
    return data;
}

const STATUS_MARK: Record<StepStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

/** 把自检结果排成一段可直接复制发人的纯文本。 */
export function formatSelfCheckReport(result: OfflinePushSelfCheckResult): string {
    const lines: string[] = ["离线推送链路自检", ""];
    for (const step of result.steps) {
        lines.push(`${STATUS_MARK[step.status]} ${step.label}`);
        lines.push(`    ${step.detail}`);
        if (step.hint) lines.push(`    → ${step.hint}`);
    }
    lines.push("", result.summary);
    return lines.join("\n");
}
