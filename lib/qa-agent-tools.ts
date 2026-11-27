import { buildProviderRequest, parseProviderResponse } from "./llm-provider-adapter";
import { loadApiConfigs } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import type { ToolCall } from "./tool-executor";
import { getQaErrorEntries } from "./qa-error-log";
import { getDebugPromptSnapshot } from "./debug-store";
import {
    loadQaGithubConfig,
    getQaGithubTree,
    readQaGithubFile,
    searchQaGithubCode,
    listQaGithubCommits,
    getQaGithubCommit,
    listQaGithubBranches,
    listQaGithubPulls,
    getQaGithubPull,
    listQaGithubIssues,
    getQaGithubIssue,
} from "./qa-github";
import {
    createQaBranch,
    createQaIssue,
    createQaPullRequest,
    deleteQaBranch,
    mergeQaPullRequest,
    syncQaForkWithUpstream,
    updateQaIssue,
    type QaCommitFile,
} from "./qa-github-write";
import {
    saveQaFeedbackTicket,
    updateQaFeedbackTicket,
    captureQaEnvironment,
    formatQaFeedbackMarkdown,
    type QaFeedbackTicket,
} from "./qa-feedback";
import { QA_COMPUTER_TOOLS, QA_COMPUTER_ALIAS_TOOLS } from "./qa-computer-tools";
import { isWorkshopComputerEnabled } from "./agent-computer";
import {
    QA_CONTENT_TOOLS,
    workbenchWriteLocal,
    workbenchEditLocal,
    workbenchPublishLocal,
    getAppStagingNote,
    readStagedAppFile,
    type QaCreatedContent,
} from "./qa-content-tools";
import { searchQaFaq, readQaFaqPage } from "./qa-faq";
import { kvGet, kvSet } from "./kv-db";
import { getQaPageChars } from "./qa-prefs";

export type { QaCreatedContent } from "./qa-content-tools";

// ── 工坊诊断工具集（P1）──────────────────────────────
// 文本协议与全项目一致：[执行动作:工具名({"参数":"值"})]，解析复用 tool-executor.parseToolCalls。

export type QaProposedCommit = {
    message: string;
    branch?: string;
    files: QaCommitFile[];
    /** 本次提交要删除的文件路径 */
    deletes?: string[];
};

export type QaToolContext = {
    signal?: AbortSignal;
    /** 确认模式下，写工具通过它把提案交给 UI，返回 true 表示已暂存等待确认。 */
    onStageCommit?: (proposal: QaProposedCommit) => void;
    /** true=全自动模式，写工具直接提交。 */
    autoCommit?: boolean;
    /**
     * 全自动模式下立即提交并返回结果。必须在工具内同步完成，
     * 否则同一轮里后续工具（如「创建PR」）会跑在提交之前。
     */
    commitNow?: (proposal: QaProposedCommit) => Promise<{ ok: boolean; htmlUrl?: string; error?: string }>;
    /** 内容工具安装/更新本机内容后回调（store 记到会话上，供工坊内预览）。 */
    onContentCreated?: (item: QaCreatedContent) => void;
};

export type QaToolRunResult = {
    name: string;
    success: boolean;
    resultForModel: string;
};

type QaTool = {
    name: string;
    /** 原生工具协议的稳定英文名（function 名仅允许 ASCII） */
    nativeName: string;
    description: string;
    schemaLines: string[];
    /** 原生工具协议的 JSON Schema 参数定义 */
    parameters: Record<string, unknown>;
    run: (args: Record<string, unknown>, context?: QaToolContext) => Promise<string>;
};

/** 空参数工具的兜底 schema：带一个无意义可选字段，避免部分 provider（如 Gemini）拒绝空 properties */
const NOOP_PARAMS: Record<string, unknown> = {
    type: "object",
    properties: { noop: { type: "string", description: "无需参数，忽略" } },
};

const RESULT_CHAR_LIMIT = 2000;

function clip(text: string): string {
    return text.length > RESULT_CHAR_LIMIT ? `${text.slice(0, RESULT_CHAR_LIMIT)}\n…（已截断）` : text;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
}

// ── 工具 1：检测 API 连通性 ──

async function pingApiConfig(config: ApiConfig, signal?: AbortSignal): Promise<string> {
    const started = Date.now();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 20_000);
    const onOuterAbort = () => abort.abort();
    signal?.addEventListener("abort", onOuterAbort);
    try {
        const request = buildProviderRequest(config, null, [{ role: "user", content: "连通性测试，只回复：ok" }]);
        const response = await fetch(request.url, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: abort.signal,
        });
        const ms = Date.now() - started;
        if (!response.ok) {
            const bodyText = (await response.text()).slice(0, 300);
            return `✗ 「${config.name || config.provider}」HTTP ${response.status}（${ms}ms）：${bodyText}`;
        }
        const parsed = parseProviderResponse(request.providerKind, await response.json());
        if (!parsed.content) return `⚠ 「${config.name || config.provider}」请求成功但返回空内容（${ms}ms），检查模型名 ${config.defaultModel} 是否正确`;
        return `✓ 「${config.name || config.provider}」正常，模型 ${config.defaultModel}，耗时 ${ms}ms`;
    } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? error.message : String(error);
        if (abort.signal.aborted && !signal?.aborted) return `✗ 「${config.name || config.provider}」超时（>${ms}ms）`;
        return `✗ 「${config.name || config.provider}」连接失败（${ms}ms）：${message.slice(0, 200)}（常见原因：Base URL 写错、网络不通、CORS 被服务商拦截）`;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onOuterAbort);
    }
}

const apiCheckTool: QaTool = {
    name: "检测API",
    nativeName: "check_api",
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "只测指定名称的 API 配置；不填测全部" } },
    },
    description: "逐个测试用户已配置的 LLM API 是否可用（真实发送一条极短请求），返回连通状态、耗时与错误详情。",
    schemaLines: [
        "  参数：",
        "    · name (可选) — 只测指定名称的 API 配置；不填测全部",
        '  调用：[执行动作:检测API({})] 或 [执行动作:检测API({"name":"DeepSeek"})]',
    ],
    async run(args, options) {
        const all = loadApiConfigs();
        if (all.length === 0) return "用户还没有配置任何 API。请引导用户到「设置 → API 设置」添加。";
        const filter = typeof args.name === "string" ? args.name.trim() : "";
        const targets = filter ? all.filter((c) => (c.name || "").includes(filter)) : all;
        if (targets.length === 0) return `找不到名称包含「${filter}」的 API 配置。现有配置：${all.map((c) => c.name || c.provider).join("、")}`;
        const results: string[] = [];
        for (const config of targets) {
            results.push(await pingApiConfig(config, options?.signal));
        }
        return clip(results.join("\n"));
    },
};

// ── 工具 2：存储体检 ──

const storageReportTool: QaTool = {
    name: "存储体检",
    nativeName: "storage_report",
    parameters: NOOP_PARAMS,
    description: "查看浏览器存储占用（配额、已用空间、各数据库清单），用于排查存储不足或数据异常。",
    schemaLines: ["  参数：无", "  调用：[执行动作:存储体检({})]"],
    async run() {
        const lines: string[] = [];
        try {
            const estimate = await navigator.storage?.estimate?.();
            if (estimate) {
                const usage = estimate.usage ?? 0;
                const quota = estimate.quota ?? 0;
                lines.push(`存储占用：${formatBytes(usage)} / 配额 ${formatBytes(quota)}（${quota ? ((usage / quota) * 100).toFixed(1) : "?"}%）`);
            }
            const persisted = await navigator.storage?.persisted?.();
            lines.push(`持久化存储：${persisted ? "已开启（浏览器不会自动清理）" : "未开启（存储紧张时浏览器可能清数据，建议提醒用户定期备份）"}`);
        } catch {
            lines.push("无法读取存储估算（浏览器不支持）。");
        }
        try {
            const dbs = await indexedDB.databases?.();
            if (dbs?.length) lines.push(`IndexedDB 数据库（${dbs.length} 个）：${dbs.map((d) => d.name).filter(Boolean).join("、")}`);
        } catch {
            // Safari 不支持 databases()
        }
        try {
            lines.push(`localStorage 键数量：${localStorage.length}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 3：最近报错 ──

const errorLogTool: QaTool = {
    name: "最近报错",
    nativeName: "recent_errors",
    parameters: NOOP_PARAMS,
    description: "读取本次会话内页面捕获到的 JS 报错和未处理异常（最多 50 条），以及最近一次 LLM 请求的调试快照信息。",
    schemaLines: ["  参数：无", "  调用：[执行动作:最近报错({})]"],
    async run() {
        const lines: string[] = [];
        const errors = getQaErrorEntries();
        if (errors.length === 0) {
            lines.push("本次会话没有捕获到运行时报错。（收集范围：宿主页面与本机测试游戏/剧场 iframe；自定义 APP 内部报错不在此列，「没有报错」不代表你写的代码没问题——排查代码问题请用「读取」看源码。）");
        } else {
            lines.push(`捕获到 ${errors.length} 条报错（最近 10 条）：`);
            for (const entry of errors.slice(-10)) {
                const time = new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false });
                lines.push(`[${time}] ${entry.kind === "error" ? "JS错误" : "未处理异常"} ${entry.source ? `(${entry.source}) ` : ""}${entry.message}`);
            }
        }
        const snapshot = getDebugPromptSnapshot();
        if (snapshot) {
            lines.push("", "最近一次 LLM 请求快照存在（用户可在调试面板查看完整提示词）。");
        }
        return clip(lines.join("\n"));
    },
};

// ── 工具 4：设备环境 ──

const deviceInfoTool: QaTool = {
    name: "设备环境",
    nativeName: "device_info",
    parameters: NOOP_PARAMS,
    description: "读取设备与运行环境信息（浏览器、视口、PWA 状态、网络状态、通知权限），用于排查显示异常和兼容问题。",
    schemaLines: ["  参数：无", "  调用：[执行动作:设备环境({})]"],
    async run() {
        const lines: string[] = [];
        lines.push(`UA：${navigator.userAgent.slice(0, 160)}`);
        lines.push(`视口：${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`);
        lines.push(`语言：${navigator.language}；在线：${navigator.onLine ? "是" : "否"}`);
        try {
            const standalone = window.matchMedia("(display-mode: standalone)").matches;
            lines.push(`PWA 独立窗口：${standalone ? "是（已安装到桌面）" : "否（浏览器内打开）"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`Service Worker：${navigator.serviceWorker?.controller ? "已激活" : "未激活"}`);
        } catch {
            // ignore
        }
        try {
            lines.push(`通知权限：${typeof Notification !== "undefined" ? Notification.permission : "不支持"}`);
        } catch {
            // ignore
        }
        return clip(lines.join("\n"));
    },
};

// ── 答疑文档（可检索、可翻页的持续补充 FAQ）──────────

const faqTool: QaTool = {
    name: "答疑文档",
    nativeName: "read_faq_doc",
    parameters: {
        type: "object",
        properties: {
            find: { type: "string", description: "关键词（可空格分隔多个，任一命中即返回该问答条目）" },
            page: { type: "number", description: "不带 find 时按页顺序阅读全文，默认第 1 页" },
        },
    },
    description:
        "检索产品答疑文档（FAQ）——只用于回答用户的产品使用问题：功能怎么用、设置在哪、故障怎么排查。回答没把握的产品问题前先查这里；查不到再读源码求证。注意：开发 APP/小游戏/剧场所需的运行时协议、宿主 API、manifest/权限/工具声明等资料全部在「创作指南」里，创作任务不要来这里查资料。",
    schemaLines: [
        "  参数：",
        "    · find (可选) — 关键词，任一命中即返回对应问答条目",
        "    · page (可选) — 不带 find 时分页通读，默认第 1 页",
        '  调用：[执行动作:答疑文档({"find":"备份 迁移"})]',
    ],
    async run(args) {
        const find = typeof args.find === "string" ? args.find.trim() : "";
        if (find) {
            const hits = searchQaFaq(find);
            if (hits.length === 0) {
                return `答疑文档里没有找到与「${find}」相关的条目。可换关键词再查，或（已连接仓库时）用「搜索仓库代码」「读取仓库文件」从源码求证；仍无结论就如实告诉用户并用「记录反馈」登记。`;
            }
            return `【答疑文档命中 ${hits.length} 条】\n\n${hits.join("\n\n")}`;
        }
        return readQaFaqPage(args.page);
    },
};

// ── GitHub 只读工具（仅在配置了仓库时启用）──────────

const githubTreeTool: QaTool = {
    name: "仓库文件树",
    nativeName: "repo_file_tree",
    parameters: {
        type: "object",
        properties: { filter: { type: "string", description: "只返回路径包含该关键词的文件" } },
    },
    description: "列出已连接 GitHub 仓库的文件路径（可按关键词过滤），用于了解代码结构、定位文件。",
    schemaLines: [
        "  参数：",
        "    · filter (可选) — 只返回路径包含该关键词的文件/目录",
        '  调用：[执行动作:仓库文件树({})] 或 [执行动作:仓库文件树({"filter":"chat"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。请引导用户在工坊右上角「仓库」里配置。";
        const { entries, truncated } = await getQaGithubTree(config, options?.signal);
        const filter = typeof args.filter === "string" ? args.filter.trim().toLowerCase() : "";
        let files = entries.filter((e) => e.type === "blob");
        if (filter) files = files.filter((e) => e.path.toLowerCase().includes(filter));
        const shown = files.slice(0, 200);
        const head = `仓库 ${config.owner}/${config.repo}${config.branch ? `@${config.branch}` : ""} 共 ${entries.filter((e) => e.type === "blob").length} 个文件${filter ? `，匹配「${filter}」${files.length} 个` : ""}${truncated ? "（文件树被 GitHub 截断，仅部分）" : ""}：`;
        return clip(`${head}\n${shown.map((e) => e.path).join("\n")}${files.length > shown.length ? `\n…还有 ${files.length - shown.length} 个` : ""}`);
    },
};

const githubReadTool: QaTool = {
    name: "读取仓库文件",
    nativeName: "read_repo_file",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "文件路径，如 lib/chat-engine.ts" },
            start: { type: "number", description: "起始行" },
            end: { type: "number", description: "结束行" },
        },
        required: ["path"],
    },
    description: "读取已连接 GitHub 仓库中某个文件的内容，可指定行范围。用于查看具体实现回答代码问题。",
    schemaLines: [
        "  参数：",
        "    · path (必填) — 文件路径，如 lib/chat-engine.ts",
        "    · start (可选) / end (可选) — 只看第 start 到 end 行",
        '  调用：[执行动作:读取仓库文件({"path":"package.json"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return "缺少 path 参数。";
        const file = await readQaGithubFile(config, path, options?.signal);
        const lines = file.text.split("\n");
        const start = typeof args.start === "number" ? Math.max(1, args.start) : 1;
        const end = typeof args.end === "number" ? Math.min(lines.length, args.end) : lines.length;
        const slice = lines.slice(start - 1, end);
        const numbered = slice.map((line, i) => `${start + i}\t${line}`).join("\n");
        const body = `${file.path}（${lines.length} 行，显示 ${start}-${Math.min(end, lines.length)}）：\n${numbered}`;
        // 读源码按「单页读取字符数」截断（工坊配置可调），截断时提示用行号范围续读
        const limit = getQaPageChars();
        return body.length > limit
            ? `${body.slice(0, limit)}\n…（已截断，用 start/end 行号范围继续读）`
            : body;
    },
};

const githubSearchTool: QaTool = {
    name: "搜索仓库代码",
    nativeName: "search_repo_code",
    parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"],
    },
    description: "在已连接 GitHub 仓库里搜索代码或文件。有 PAT 时用 GitHub 代码搜索（搜内容），否则按文件路径匹配。",
    schemaLines: [
        "  参数：",
        "    · query (必填) — 搜索关键词",
        '  调用：[执行动作:搜索仓库代码({"query":"sendLLMRequest"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) return "缺少 query 参数。";
        const { hits, mode } = await searchQaGithubCode(config, query, options?.signal);
        if (hits.length === 0) return `没搜到「${query}」（${mode === "path-fallback" ? "按路径匹配，未配 PAT 无法搜文件内容" : "代码搜索"}）。`;
        const modeNote = mode === "path-fallback" ? "（按文件路径匹配，如需搜文件内容请配置 PAT）" : "（GitHub 代码搜索）";
        return clip(`搜到 ${hits.length} 个结果${modeNote}：\n${hits.map((h) => h.path).join("\n")}`);
    },
};

const githubHistoryTool: QaTool = {
    name: "提交历史",
    nativeName: "commit_history",
    parameters: {
        type: "object",
        properties: {
            sha: { type: "string", description: "看这个提交改了什么（含 diff）" },
            branch: { type: "string" },
            path: { type: "string", description: "只看该文件的历史" },
            limit: { type: "number", description: "默认 10" },
        },
    },
    description:
        "查看仓库提交历史；给 sha 时显示该次提交的改动详情（每个文件的 diff）。排查「什么时候改坏的」时先列历史再看具体提交。",
    schemaLines: [
        "  参数：",
        "    · sha (可选) — 看这个提交改了什么（含 diff）",
        "    · branch (可选) / path (可选) / limit (可选，默认 10) — 列历史时过滤",
        '  调用：[执行动作:提交历史({})] 或 [执行动作:提交历史({"sha":"abc123"})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const sha = typeof args.sha === "string" ? args.sha.trim() : "";
        if (sha) {
            const detail = await getQaGithubCommit(config, sha, options?.signal);
            const lines = [`提交 ${detail.sha.slice(0, 10)}：${detail.message.split("\n")[0]}`, `改动 ${detail.files.length} 个文件：`];
            for (const f of detail.files.slice(0, 10)) {
                lines.push(`--- ${f.filename}（${f.status}，+${f.additions}/-${f.deletions}）`);
                if (f.patch) lines.push(f.patch.slice(0, 600));
            }
            if (detail.files.length > 10) lines.push(`…还有 ${detail.files.length - 10} 个文件`);
            return clip(lines.join("\n"));
        }
        const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
        const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        const limit = typeof args.limit === "number" ? args.limit : 10;
        const commits = await listQaGithubCommits(config, { branch, path, limit }, options?.signal);
        if (commits.length === 0) return "没有提交记录。";
        return clip(
            `最近 ${commits.length} 次提交${branch ? `（${branch}）` : ""}${path ? `（${path}）` : ""}：\n` +
            commits.map((c) => `${c.sha.slice(0, 10)}  ${c.date.slice(0, 10)}  ${c.author}  ${c.message}`).join("\n") +
            "\n\n想看某次改了什么，用 sha 参数再调一次。",
        );
    },
};

const githubBranchListTool: QaTool = {
    name: "分支列表",
    nativeName: "list_branches",
    parameters: NOOP_PARAMS,
    description: "列出仓库所有分支（标注默认分支与工坊当前工作分支）。",
    schemaLines: ["  参数：无", "  调用：[执行动作:分支列表({})]"],
    async run(_args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const { branches, defaultBranch } = await listQaGithubBranches(config, options?.signal);
        return clip(
            `共 ${branches.length} 个分支：\n` +
            branches
                .map((b) => {
                    const marks = [b.name === defaultBranch ? "默认" : "", b.name === config.branch ? "工坊工作分支" : ""].filter(Boolean);
                    return `${b.name}${marks.length ? `（${marks.join("、")}）` : ""}  ${b.sha.slice(0, 10)}`;
                })
                .join("\n"),
        );
    },
};

const githubPullReadTool: QaTool = {
    name: "查看PR",
    nativeName: "view_pull_request",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "PR 编号；不填列出 PR 列表" },
            state: { type: "string", enum: ["open", "closed", "all"], description: "列表时的状态过滤，默认 open" },
        },
    },
    description: "不带 number 时列出 PR（默认 open）；带 number 时看该 PR 的详情与改动文件。",
    schemaLines: [
        "  参数：",
        "    · number (可选) — PR 编号",
        "    · state (可选) — open（默认）/ closed / all，仅列表时有效",
        '  调用：[执行动作:查看PR({})] 或 [执行动作:查看PR({"number":12})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const number = typeof args.number === "number" ? args.number : 0;
        if (number > 0) {
            const p = await getQaGithubPull(config, number, options?.signal);
            const lines = [
                `PR #${p.number}「${p.title}」（${p.merged ? "已合并" : p.state}）`,
                `${p.head} → ${p.base}${p.mergeable === false ? "（有冲突，不可自动合并）" : ""}`,
                p.body ? `说明：${p.body.slice(0, 300)}` : "",
                `改动 ${p.files.length} 个文件：`,
                ...p.files.slice(0, 20).map((f) => `  ${f.filename}（${f.status}，+${f.additions}/-${f.deletions}）`),
                p.htmlUrl,
            ].filter(Boolean);
            return clip(lines.join("\n"));
        }
        const state = args.state === "closed" || args.state === "all" ? args.state : "open";
        const pulls = await listQaGithubPulls(config, state, options?.signal);
        if (pulls.length === 0) return `没有 ${state} 状态的 PR。`;
        return clip(
            `${state} PR 共 ${pulls.length} 个：\n` +
            pulls.map((p) => `#${p.number}  ${p.title}（${p.head} → ${p.base}）`).join("\n"),
        );
    },
};

const githubIssueReadTool: QaTool = {
    name: "查看Issue",
    nativeName: "view_issue",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "issue 编号；不填列出 issue 列表" },
            state: { type: "string", enum: ["open", "closed", "all"], description: "列表时的状态过滤，默认 open" },
        },
    },
    description: "不带 number 时列出 issue（默认 open，不含 PR）；带 number 时看详情与评论。",
    schemaLines: [
        "  参数：",
        "    · number (可选) — issue 编号",
        "    · state (可选) — open（默认）/ closed / all，仅列表时有效",
        '  调用：[执行动作:查看Issue({})] 或 [执行动作:查看Issue({"number":41})]',
    ],
    async run(args, options) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        const number = typeof args.number === "number" ? args.number : 0;
        if (number > 0) {
            const issue = await getQaGithubIssue(config, number, options?.signal);
            const lines = [
                `Issue #${issue.number}「${issue.title}」（${issue.state}）`,
                issue.body ? `正文：${issue.body.slice(0, 400)}` : "（无正文）",
                issue.comments.length ? `评论 ${issue.comments.length} 条：` : "（无评论）",
                ...issue.comments.slice(-5).map((c) => `  @${c.author}：${c.body.slice(0, 150)}`),
                issue.htmlUrl,
            ].filter(Boolean);
            return clip(lines.join("\n"));
        }
        const state = args.state === "closed" || args.state === "all" ? args.state : "open";
        const issues = await listQaGithubIssues(config, state, options?.signal);
        if (issues.length === 0) return `没有 ${state} 状态的 issue。`;
        return clip(`${state} issue 共 ${issues.length} 个：\n` + issues.map((i) => `#${i.number}  ${i.title}`).join("\n"));
    },
};

const githubBranchTool: QaTool = {
    name: "新建分支",
    nativeName: "create_branch",
    parameters: {
        type: "object",
        properties: {
            name: { type: "string", description: "新分支名，如 feature/dark-mode" },
            from: { type: "string", description: "从哪个分支切出，默认仓库配置分支/默认分支" },
        },
        required: ["name"],
    },
    description:
        "在已连接仓库创建新分支（从指定分支或默认分支切出）。建完后可用「提交修改」的 branch 参数往新分支提交。分支已存在时不报错、直接可用。",
    schemaLines: [
        "  参数：",
        "    · name (必填) — 新分支名，如 feature/dark-mode",
        "    · from (可选) — 从哪个分支切出，默认仓库配置分支/默认分支",
        '  调用：[执行动作:新建分支({"name":"feature/dark-mode"})]',
    ],
    async run(args, context) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        if (!config.token) return "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。";
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return "缺少 name（分支名）。";
        const from = typeof args.from === "string" && args.from.trim() ? args.from.trim() : undefined;
        const result = await createQaBranch(config, { name, from }, context?.signal);
        if (!result.created) return `分支「${name}」已存在，可直接往它提交。`;
        return `✓ 已从「${result.from}」创建分支「${name}」。之后「发布」type=repo 时用 branch 参数即可提交到该分支。`;
    },
};

// ── 提交暂存区（分段写入 → 提交引用）────────────────
// 与应用包暂存区同思路：往仓库新写大文件时，单次输出可能被 max_tokens 截断——
// 先分多轮 append 到内存暂存区，再在「提交修改」里用 {path, fromStaged:true} 引用。
// 改已有文件不需要它：走「提交修改」的 find/replace 片段替换。

// 与应用暂存区同理：持久化到 kv，页面重载后分段写入/编辑的内容不丢
const COMMIT_STAGING_KEY = "ai_phone_qa_commit_staging_v1";
const COMMIT_STAGING_MEM = new Map<string, string>();
let commitStagingLoaded = false;

function commitStaging(): Map<string, string> {
    if (!commitStagingLoaded) {
        commitStagingLoaded = true;
        try {
            const parsed = JSON.parse(kvGet(COMMIT_STAGING_KEY) || "[]") as Array<[string, string]>;
            if (Array.isArray(parsed)) {
                for (const [key, value] of parsed) {
                    if (typeof key === "string" && typeof value === "string") COMMIT_STAGING_MEM.set(key, value);
                }
            }
        } catch {
            // ignore
        }
    }
    return COMMIT_STAGING_MEM;
}

function persistCommitStaging(): void {
    kvSet(COMMIT_STAGING_KEY, JSON.stringify([...commitStaging()]));
}
const COMMIT_STAGE_MAX_FILES = 40;
const COMMIT_STAGE_MAX_FILE_CHARS = 2_000_000;
const COMMIT_STAGE_MAX_TOTAL_CHARS = 10_000_000;

function commitStagingSummary(): string {
    if (commitStaging().size === 0) return "（提交暂存区为空）";
    return [...commitStaging().entries()].map(([path, c]) => `${path}(${c.length})`).join("、");
}

const githubStageFileTool: QaTool = {
    name: "暂存提交文件",
    nativeName: "stage_commit_file",
    parameters: {
        type: "object",
        properties: {
            path: { type: "string", description: "仓库内路径，如 src/app.js" },
            content: { type: "string", description: "文件内容（文本）" },
            append: { type: "boolean", description: "true=追加到该路径已暂存内容末尾（大文件分多轮写）" },
            clear: { type: "boolean", description: "true=清空整个提交暂存区（重来），此时可不传 path/content" },
        },
    },
    description:
        "把要提交到仓库的文件内容写入暂存区（只在本机内存，不动仓库）。新写大文件超过单次输出上限时分多轮：首轮写骨架，后续轮 append=true 追加，绝不会被 max_tokens 截断。写完后在「提交修改」的 files 里用 {path, fromStaged:true} 引用即可提交。改已有文件优先用「提交修改」的 find/replace 片段替换，不必走暂存。",
    schemaLines: [
        "  参数：",
        "    · path (必填) — 仓库内路径",
        "    · content (必填) — 文件内容（文本）",
        "    · append (可选) — true=追加到该路径已暂存内容末尾（大文件分轮写）",
        "    · clear (可选) — true=清空提交暂存区",
        '  调用：[执行动作:暂存提交文件({"path":"src/app.js","content":"…","append":true})]',
    ],
    async run(args) {
        if (args.clear === true) {
            commitStaging().clear();
            persistCommitStaging();
            return "✓ 提交暂存区已清空。";
        }
        const path = typeof args.path === "string" ? args.path.trim().replace(/^\.?\//, "") : "";
        if (!path || path.includes("..") || path.length > 200) return "path 无效（仓库内相对路径，不允许 ..）。";
        const content = typeof args.content === "string" ? args.content : "";
        if (!content) return "缺少 content。";
        if (commitStaging().size >= COMMIT_STAGE_MAX_FILES && !commitStaging().has(path)) return `暂存文件数已达上限 ${COMMIT_STAGE_MAX_FILES}。`;
        const next = args.append === true ? (commitStaging().get(path) ?? "") + content : content;
        if (next.length > COMMIT_STAGE_MAX_FILE_CHARS) return `单文件暂存超限（${next.length} > ${COMMIT_STAGE_MAX_FILE_CHARS} 字符）。`;
        let total = next.length;
        for (const [k, c] of commitStaging()) { if (k !== path) total += c.length; }
        if (total > COMMIT_STAGE_MAX_TOTAL_CHARS) return `暂存区总量超限（${total} > ${COMMIT_STAGE_MAX_TOTAL_CHARS} 字符）。`;
        commitStaging().set(path, next);
        persistCommitStaging();
        return `✓ 已暂存 ${path}（当前 ${next.length.toLocaleString()} 字符${args.append === true ? "，本次为追加" : ""}）。暂存区：${commitStagingSummary()}。继续追加或暂存其他文件；全部写完后用「发布」type=repo 提交（需 message）。`;
    },
};

const githubCommitTool: QaTool = {
    name: "提交修改",
    nativeName: "commit_changes",
    parameters: {
        type: "object",
        properties: {
            message: { type: "string", description: "提交说明（一句话，中文）" },
            files: {
                type: "array",
                description: "要修改的文件。三种形态：整写 {path, content}；片段替换 {path, find, replace}（改大文件用，只输出改动片段）；引用暂存 {path, fromStaged:true}（新写大文件先用「暂存提交文件」分轮写完）",
                items: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        content: { type: "string", description: "整写：该文件完整新内容" },
                        find: { type: "string", description: "片段替换：要被替换的原文片段（须在文件中唯一，含足够上下文）" },
                        replace: { type: "string", description: "片段替换：替换后的新片段" },
                        all: { type: "boolean", description: "片段替换：true=替换全部匹配处（默认要求唯一匹配）" },
                        fromStaged: { type: "boolean", description: "true=内容取自「暂存提交文件」暂存区的同路径文件（大文件分段写完后用）" },
                    },
                    required: ["path"],
                },
            },
            deletes: { type: "array", items: { type: "string" }, description: "要删除的文件路径" },
            branch: { type: "string", description: "目标分支，默认仓库默认分支；不存在会自动创建" },
        },
        required: ["message"],
    },
    description:
        "把对仓库文件的修改（新增/覆盖/删除）提交上去。三种改法：新建/整写用 {path, content}；改已有大文件优先用片段替换 {path, find, replace}——只输出改动片段，省 token 且不会被输出上限截断；新写大文件先用「暂存提交文件」分轮写完，再用 {path, fromStaged:true} 引用。确认模式下会先展示给用户确认再提交；全自动模式下直接提交。片段替换前先用「读取仓库文件」确认原文。",
    schemaLines: [
        "  参数：",
        "    · message (必填) — 提交说明（一句话，中文）",
        "    · files (可选) — 数组。整写：{path, content}；片段替换：{path, find, replace[, all]}——改大文件优先用它，find 须是文件中唯一的原文片段（带足够上下文），all=true 替换全部匹配；引用暂存：{path, fromStaged:true}——新写大文件先「暂存提交文件」分轮写完再引用",
        "    · deletes (可选) — 要删除的文件路径数组；重命名 = 新路径写入 files + 旧路径放 deletes",
        "    · branch (可选) — 目标分支，默认仓库默认分支；分支不存在会自动从默认分支创建",
        "    · files 与 deletes 至少给一个",
        '  调用：[执行动作:提交修改({"message":"更新标题","files":[{"path":"README.md","find":"# 旧标题","replace":"# 新标题"}]})]',
    ],
    async run(args, context) {
        const config = loadQaGithubConfig();
        if (!config) return "尚未连接 GitHub 仓库。";
        if (!config.token) return "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。";
        const message = typeof args.message === "string" ? args.message.trim() : "";
        const rawFiles = Array.isArray(args.files) ? args.files : [];
        // 两种形态：整写 {path, content}；片段替换 {path, find, replace[, all]}——
        // 替换在此处解析成完整内容（读当前文件→替换→交给原提交管线），确认面板展示的即最终内容
        const files: QaCommitFile[] = [];
        const resolved = new Map<string, string>(); // 同文件多条编辑按顺序叠加
        const consumedStaged: string[] = []; // 引用了暂存区的路径：提案落地后才清空（提交失败可重试）
        for (const raw of rawFiles) {
            if (!raw || typeof raw !== "object") continue;
            const entry = raw as { path?: unknown; content?: unknown; find?: unknown; replace?: unknown; all?: unknown; fromStaged?: unknown };
            const path = typeof entry.path === "string" ? entry.path.trim() : "";
            if (!path) continue;
            if (entry.fromStaged === true) {
                const stagedKey = commitStaging().has(path) ? path : path.replace(/^\.?\//, "");
                const staged = commitStaging().get(stagedKey);
                if (staged == null) return `文件 ${path}：提交暂存区里没有它。先用「暂存提交文件」写入。当前暂存区：${commitStagingSummary()}`;
                resolved.set(path, staged);
                consumedStaged.push(stagedKey);
                continue;
            }
            if (typeof entry.content === "string") {
                resolved.set(path, entry.content);
                continue;
            }
            if (typeof entry.find === "string" && typeof entry.replace === "string") {
                if (!entry.find) return `文件 ${path}：find 不能为空。`;
                let base = resolved.get(path);
                if (base == null) {
                    try {
                        base = (await readQaGithubFile(config, path, context?.signal)).text;
                    } catch (error) {
                        return `片段替换失败：读取 ${path} 出错——${error instanceof Error ? error.message : String(error)}。新文件请用 {path, content} 整写。`;
                    }
                }
                const count = base.split(entry.find).length - 1;
                if (count === 0) return `文件 ${path}：找不到 find 片段。先用「读取仓库文件」核对原文（注意空格与换行须完全一致）。`;
                if (count > 1 && entry.all !== true) return `文件 ${path}：find 片段匹配了 ${count} 处。加长片段使其唯一，或加 all:true 替换全部。`;
                base = entry.all === true ? base.split(entry.find).join(entry.replace) : base.replace(entry.find, entry.replace);
                resolved.set(path, base);
                continue;
            }
            return `文件 ${path}：需给 content（整写）或 find+replace（片段替换）。`;
        }
        for (const [path, content] of resolved) files.push({ path, content });
        const deletes = (Array.isArray(args.deletes) ? args.deletes : [])
            .map((p) => (typeof p === "string" ? p.trim() : ""))
            .filter(Boolean);
        if (!message) return "缺少 message（提交说明）。";
        if (files.length === 0 && deletes.length === 0) return "files 与 deletes 至少给一个（要提交的文件或要删除的路径）。";
        const branch = typeof args.branch === "string" && args.branch.trim() ? args.branch.trim() : undefined;
        const proposal: QaProposedCommit = { message, branch, files, deletes: deletes.length ? deletes : undefined };
        context?.onStageCommit?.(proposal);
        const summary = [
            files.length ? `改 ${files.length} 个：${files.map((f) => f.path).join("、")}` : "",
            deletes.length ? `删 ${deletes.length} 个：${deletes.join("、")}` : "",
        ].filter(Boolean).join("；");
        const releaseStaged = () => {
            for (const key of consumedStaged) commitStaging().delete(key);
            if (consumedStaged.length) persistCommitStaging();
        };
        if (context?.autoCommit) {
            // 立即提交：后续工具（创建PR 等）依赖提交已经落到分支上
            if (context.commitNow) {
                const result = await context.commitNow(proposal);
                if (!result.ok) return `提交失败：${result.error ?? "未知错误"}${consumedStaged.length ? "（暂存文件已保留，可修正后重试）" : ""}。请把失败原因告诉用户，不要假装已提交。`;
                releaseStaged();
                return `✓ 已提交（${summary}）到 ${branch || "默认分支"}：${result.htmlUrl ?? ""}。请向用户简述你做的修改和影响。`;
            }
            releaseStaged();
            return `修改提案已生成（${summary}），当前是全自动模式，系统会直接提交。请向用户简述你做的修改和影响。`;
        }
        // 确认模式：内容已复制进提案（用户点「应用」时用提案里的内容），暂存区可释放
        releaseStaged();
        return `已生成修改提案（${summary}），已在界面展示给用户，等待用户点「应用」确认。请告诉用户你准备做的修改和影响，让他确认。不要假装已经提交成功。`;
    },
};

function requireWritableConfig(): { config: NonNullable<ReturnType<typeof loadQaGithubConfig>> } | { error: string } {
    const config = loadQaGithubConfig();
    if (!config) return { error: "尚未连接 GitHub 仓库。" };
    if (!config.token) return { error: "写操作需要 PAT。请引导用户在工坊「仓库」里填入有写权限的 fine-grained PAT。" };
    return { config };
}

const githubBranchDeleteTool: QaTool = {
    name: "删除分支",
    nativeName: "delete_branch",
    parameters: {
        type: "object",
        properties: { name: { type: "string", description: "要删除的分支名" } },
        required: ["name"],
    },
    description: "删除仓库分支。默认分支与工坊当前工作分支受保护，不能删。",
    schemaLines: [
        "  参数：",
        "    · name (必填) — 要删除的分支名",
        '  调用：[执行动作:删除分支({"name":"feature/old"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const name = typeof args.name === "string" ? args.name.trim() : "";
        if (!name) return "缺少 name（分支名）。";
        await deleteQaBranch(gate.config, name, context?.signal);
        return `✓ 已删除分支「${name}」。`;
    },
};

const githubPullCreateTool: QaTool = {
    name: "创建PR",
    nativeName: "create_pull_request",
    parameters: {
        type: "object",
        properties: {
            title: { type: "string", description: "PR 标题" },
            head: { type: "string", description: "源分支（改动所在分支）" },
            base: { type: "string", description: "目标分支，默认仓库默认分支" },
            body: { type: "string", description: "PR 描述" },
        },
        required: ["title", "head"],
    },
    description:
        "从某个分支向目标分支发起 Pull Request（仅限当前已连接的这个仓库内部）。典型流程：新建分支 → 提交修改到该分支 → 创建PR → 用户审阅或让你合并。"
        + "注意：用户想「把改动贡献给官方/上游仓库」时不要用本动作——那要走「对比官方版本 → 提交共同建设贡献」流程。",
    schemaLines: [
        "  参数：",
        "    · title (必填) — PR 标题",
        "    · head (必填) — 源分支（改动所在分支）",
        "    · base (可选) — 目标分支，默认仓库默认分支",
        "    · body (可选) — PR 描述",
        '  调用：[执行动作:创建PR({"title":"深色模式","head":"feature/dark-mode"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const head = typeof args.head === "string" ? args.head.trim() : "";
        if (!title || !head) return "缺少 title 或 head（源分支）。";
        const base = typeof args.base === "string" && args.base.trim() ? args.base.trim() : undefined;
        const body = typeof args.body === "string" ? args.body : undefined;
        const result = await createQaPullRequest(gate.config, { title, head, base, body }, context?.signal);
        return `✓ 已创建 PR #${result.number}：${result.htmlUrl}。请把链接给用户。`;
    },
};

const githubPullMergeTool: QaTool = {
    name: "合并PR",
    nativeName: "merge_pull_request",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "PR 编号" },
            method: { type: "string", enum: ["merge", "squash", "rebase"], description: "合并方式，默认 merge" },
        },
        required: ["number"],
    },
    description: "合并一个 Pull Request。合并前建议先用「查看PR」确认无冲突；用户没明确要求时先询问再合并。",
    schemaLines: [
        "  参数：",
        "    · number (必填) — PR 编号",
        "    · method (可选) — merge（默认）/ squash / rebase",
        '  调用：[执行动作:合并PR({"number":12})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const number = typeof args.number === "number" ? args.number : 0;
        if (number <= 0) return "缺少 number（PR 编号）。";
        const method = args.method === "squash" || args.method === "rebase" ? args.method : "merge";
        const result = await mergeQaPullRequest(gate.config, { number, method }, context?.signal);
        if (!result.merged) return `合并失败：${result.message || "PR 可能有冲突或已关闭"}。可用「查看PR」检查状态。`;
        return `✓ PR #${number} 已合并（${method}），合并提交 ${result.sha?.slice(0, 10) ?? ""}。`;
    },
};

const githubSyncUpstreamTool: QaTool = {
    name: "同步官方更新",
    nativeName: "sync_fork_with_upstream",
    parameters: {
        type: "object",
        properties: {
            branch: { type: "string", description: "要同步的分支，缺省用连接仓库的默认分支" },
        },
    },
    description:
        "把官方（上游）仓库的最新提交合并进当前连接的 fork（等同 GitHub 网页的 Sync fork）。"
        + "无冲突时一键完成，用户自己的改动原样保留；与官方改动冲突时 GitHub 会拒绝、fork 原样不动，此时按返回的指引处理。"
        + "仅当连接的仓库是官方项目的 fork 时有效。",
    schemaLines: [
        "  参数：",
        "    · branch (可选) — 要同步的分支，缺省用默认分支",
        '  调用：[执行动作:同步官方更新({})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const branch = typeof args.branch === "string" && args.branch.trim()
            ? args.branch.trim()
            : (gate.config.branch || "main");
        const result = await syncQaForkWithUpstream(gate.config, branch, context?.signal);
        if (result.ok) {
            const how = result.mergeType === "fast-forward" ? "快进" : result.mergeType === "merge" ? "合并提交" : (result.mergeType || "已是最新");
            return `✓ 已同步官方更新到 ${branch}（${how}${result.baseBranch ? `，上游 ${result.baseBranch}` : ""}）。用户自己的改动原样保留；部署平台会自动重新构建。`;
        }
        if (result.conflict) {
            return [
                `同步被 GitHub 拒绝：${branch} 上的改动与官方新改动存在冲突，fork 保持原样、没有被改动。`,
                "推荐的处理顺序：",
                "1. 先把用户的有效改动贡献给官方——「对比官方版本」→「提交共同建设贡献」（拼合路径不受冲突影响）；",
                "2. 官方采纳合并后，改动进入主线，用户的 fork 可直接重置为官方版本（在 GitHub 网页 Sync fork 里选 discard commits），冲突自然消失；",
                "3. 若改动只想自用不贡献，需要在本地手工解决冲突，超出小坊的能力范围，如实告知用户。",
            ].join("\n");
        }
        return `同步失败：${result.message}。常见原因：连接的仓库不是官方项目的 fork、分支名不存在、或 token 权限不足。`;
    },
};

const githubIssueUpdateTool: QaTool = {
    name: "更新Issue",
    nativeName: "update_issue",
    parameters: {
        type: "object",
        properties: {
            number: { type: "number", description: "issue 编号" },
            comment: { type: "string", description: "追加的评论内容" },
            state: { type: "string", enum: ["closed", "open"], description: "closed=关闭，open=重开" },
        },
        required: ["number"],
    },
    description: "给 issue 追加评论、关闭或重新打开。comment / state 至少给一个。",
    schemaLines: [
        "  参数：",
        "    · number (必填) — issue 编号",
        "    · comment (可选) — 追加的评论内容",
        "    · state (可选) — closed（关闭）/ open（重开）",
        '  调用：[执行动作:更新Issue({"number":41,"comment":"已在 v2 修复","state":"closed"})]',
    ],
    async run(args, context) {
        const gate = requireWritableConfig();
        if ("error" in gate) return gate.error;
        const number = typeof args.number === "number" ? args.number : 0;
        if (number <= 0) return "缺少 number（issue 编号）。";
        const comment = typeof args.comment === "string" && args.comment.trim() ? args.comment.trim() : undefined;
        const state = args.state === "closed" || args.state === "open" ? args.state : undefined;
        if (!comment && !state) return "comment 与 state 至少给一个。";
        await updateQaIssue(gate.config, { number, comment, state }, context?.signal);
        const did = [comment ? "已评论" : "", state === "closed" ? "已关闭" : state === "open" ? "已重开" : ""].filter(Boolean).join("、");
        return `✓ Issue #${number} ${did}。`;
    },
};

const GITHUB_TOOLS: QaTool[] = [
    githubTreeTool,
    githubReadTool,
    githubSearchTool,
    githubHistoryTool,
    githubBranchListTool,
    githubPullReadTool,
    githubIssueReadTool,
];
const GITHUB_WRITE_TOOLS: QaTool[] = [
    githubBranchTool,
    githubBranchDeleteTool,
    githubStageFileTool,
    githubCommitTool,
    githubPullCreateTool,
    githubPullMergeTool,
    githubIssueUpdateTool,
];

// ── 注册表与执行入口 ──────────────────────────────────

// ── 反馈闭环工具 ──

let feedbackSeq = 0;

const feedbackTool: QaTool = {
    name: "记录反馈",
    nativeName: "record_feedback",
    parameters: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["feature", "bug", "other"], description: "反馈类型" },
            title: { type: "string", description: "一句话标题" },
            detail: { type: "string", description: "详细描述；bug 请含复现步骤与期望行为" },
        },
        required: ["kind", "title", "detail"],
    },
    description:
        "当用户提出你无法直接处理的核心功能需求或产品级 bug（需要改动应用本体代码、而非用户自己的仓库或本地设置）时，把它整理成结构化反馈单留存；若已连接 GitHub 仓库并有写权限，会同时创建一个 issue。",
    schemaLines: [
        "  参数：",
        "    · kind (必填) — feature（功能建议）/ bug（问题反馈）/ other",
        "    · title (必填) — 一句话标题",
        "    · detail (必填) — 详细描述；bug 请含复现步骤与期望行为",
        '  调用：[执行动作:记录反馈({"kind":"feature","title":"希望群聊支持消息撤回","detail":"…"})]',
    ],
    async run(args, context) {
        const kind = args.kind === "bug" || args.kind === "other" ? args.kind : "feature";
        const title = typeof args.title === "string" ? args.title.trim() : "";
        const detail = typeof args.detail === "string" ? args.detail.trim() : "";
        if (!title || !detail) return "缺少 title 或 detail。";
        feedbackSeq += 1;
        const ticket: QaFeedbackTicket = {
            id: `fb-${Date.now().toString(36)}-${feedbackSeq}`,
            ts: Date.now(),
            kind: kind as QaFeedbackTicket["kind"],
            title,
            detail,
            environment: captureQaEnvironment(),
        };
        saveQaFeedbackTicket(ticket);

        // 优雅降级：连了 GitHub 且有写权限就开 issue；否则仅本地留存
        const config = loadQaGithubConfig();
        if (config?.token) {
            try {
                const issue = await createQaIssue(
                    config,
                    { title: `[${ticket.kind}] ${title}`, body: formatQaFeedbackMarkdown(ticket), labels: ["工坊反馈"] },
                    context?.signal,
                );
                updateQaFeedbackTicket(ticket.id, { issueUrl: issue.htmlUrl });
                return `✓ 已记录反馈并创建 issue #${issue.number}：${issue.htmlUrl}。请告诉用户已提交，附上 issue 链接。`;
            } catch (error) {
                return `已在本地记录反馈「${title}」。尝试创建 GitHub issue 失败：${error instanceof Error ? error.message : String(error)}。可让用户稍后在「仓库」检查 PAT 的 Issues 写权限。`;
            }
        }
        return `✓ 已在本地记录反馈「${title}」。当前未连接可写的 GitHub 仓库，反馈暂存在本机（用户可在需要时复制反馈内容发给开发者）。请告知用户已记录。`;
    },
};

// ── 统一 CRUD 工具集 ─────────────────────────────────
// 主流 agent 形态：内容与仓库统一寻址（type + name/path + field），每个动作只有
// 一个入口——清单 / 读取 / 写入(append 分段) / 编辑(find/replace) / 发布，再加
// 归类后的辅助工具。旧工具全部保留为隐藏别名（仍可执行，兼容旧会话回放与弱模型
// 记忆里的旧指令），但不再出现在系统提示里。

function contentToolByNative(native: string): QaTool {
    const tool = QA_CONTENT_TOOLS.find((t) => t.nativeName === native);
    if (!tool) throw new Error(`内容工具缺失：${native}`);
    return tool;
}

const listTool: QaTool = {
    name: "清单",
    nativeName: "list_items",
    parameters: {
        type: "object",
        properties: {
            scope: { type: "string", enum: ["local", "repo"], description: "local=本机内容（默认）；repo=已连接仓库的文件树" },
            filter: { type: "string", description: "scope=repo 时按路径关键词过滤" },
        },
    },
    description:
        "看看有什么。scope=local（默认）：本机自定义 APP、游戏/剧场草稿箱、本机测试内容、两个暂存区的状态；scope=repo：已连接 GitHub 仓库的文件树（可 filter 过滤路径）。",
    schemaLines: [
        "  参数：",
        "    · scope (可选) — local（默认，本机内容与暂存区）/ repo（仓库文件树）",
        "    · filter (可选) — repo 文件树按路径关键词过滤",
        '  调用：[执行动作:清单({})] 或 [执行动作:清单({"scope":"repo","filter":"chat"})]',
    ],
    async run(args, context) {
        if (args.scope === "repo") return githubTreeTool.run({ filter: args.filter }, context);
        const local = await contentToolByNative("list_local_content").run({}, context);
        return `${local}\n${getAppStagingNote()}\n提交暂存区：${commitStaging().size === 0 ? "（空）" : commitStagingSummary()}`;
    },
};

const readTool: QaTool = {
    name: "读取",
    nativeName: "read_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater", "repo"], description: "内容类型" },
            name: { type: "string", description: "app/game/theater：APP 名 / 游戏标题 / 剧场档案名" },
            path: { type: "string", description: "repo：仓库文件路径；app：读应用暂存区的包文件（分段写入时核实进度用）" },
            page: { type: "number", description: "本机内容/暂存文件较长时分页，默认第 1 页（最后一页可看结尾）" },
            start: { type: "number", description: "repo：起始行" },
            end: { type: "number", description: "repo：结束行" },
        },
        required: ["type"],
    },
    description:
        "读取一条内容的完整源码与字段：本机 APP/游戏/剧场用 type+name（可分页）；仓库文件用 type=repo + path（可 start/end 行号范围，暂存区有未提交修改时读到的是暂存版本）；应用暂存区的包文件用 type=app + path。修改前/续写前先读，基于真实内容再动手。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater / repo",
        "    · name — 本机内容的名称（type=app/game/theater 已装内容用）",
        "    · path — 仓库文件路径（type=repo）/ 应用暂存区包文件路径（type=app，分段写入时核实进度）",
        "    · page (可选) — 本机内容/暂存文件分页；start/end (可选) — 仓库文件行号范围",
        '  调用：[执行动作:读取({"type":"game","name":"五子棋"})] 或 [执行动作:读取({"type":"app","path":"index.html","page":2})]',
    ],
    async run(args, context) {
        if (args.type === "repo") {
            // 提交暂存区的工作副本优先：分段写入/编辑过的文件，续写要基于暂存版本而不是仓库旧版
            const path = typeof args.path === "string" ? args.path.trim().replace(/^\.?\//, "") : "";
            const staged = path ? commitStaging().get(path) : undefined;
            if (staged != null) {
                const lines = staged.split("\n");
                const start = typeof args.start === "number" ? Math.max(1, args.start) : 1;
                const end = typeof args.end === "number" ? Math.min(lines.length, args.end) : lines.length;
                const numbered = lines.slice(start - 1, end).map((line, i) => `${start + i}\t${line}`).join("\n");
                const body = `${path}（提交暂存区的未提交版本，共 ${lines.length} 行，显示 ${start}-${Math.min(end, lines.length)}）：\n${numbered}`;
                const limit = getQaPageChars();
                return body.length > limit ? `${body.slice(0, limit)}\n…（已截断，用 start/end 行号范围继续读）` : body;
            }
            return githubReadTool.run({ path: args.path, start: args.start, end: args.end }, context);
        }
        if (args.type === "app" && typeof args.path === "string" && args.path.trim()) {
            return readStagedAppFile(args.path, args.page, args.start, args.end);
        }
        const result = await contentToolByNative("read_local_content").run({ type: args.type, name: args.name, page: args.page }, context);
        if (args.type === "app" && result.startsWith("没有找到名为") && !getAppStagingNote().includes("（暂存区为空）")) {
            return `${result}\n${getAppStagingNote()}——暂存区文件还没安装，读它们要用 path 参数（如 {"type":"app","path":"index.html"}）。`;
        }
        return result;
    },
};

const writeTool: QaTool = {
    name: "写入",
    nativeName: "write_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater", "repo"], description: "写入目标" },
            name: { type: "string", description: "game/theater：草稿标题（没有会新建）" },
            path: { type: "string", description: "app：包内路径（如 index.html / manifest.json）；repo：仓库文件路径" },
            field: { type: "string", description: "game/theater：字段名。game 默认 gameHtml（还有 pickerHtml/roleSlots/subtitle/synopsis/playNote/tags）；theater 默认 openingHtml（还有 aiInstruction/outputContract/renderRules/renderCss/memorySummaryPrompt/subtitle/synopsis/storyText/tags）" },
            content: { type: "string", description: "内容（roleSlots/renderRules 传 JSON 数组文本）" },
            append: { type: "boolean", description: "true=追加到已有内容末尾——大文件分多轮写，每段自然收尾，绝不会被输出上限截断" },
            base64: { type: "boolean", description: "仅 app：content 是 base64 二进制（如图标）" },
        },
        required: ["type", "content"],
    },
    description:
        "写内容（新建或整体覆盖，append=true 则分段追加）：app 按包内 path 写应用暂存区（单文件应用只需 index.html；完整包加 manifest.json）；game/theater 按 name+field 写草稿（可逐字段分多轮写）；repo 按 path 写提交暂存区。大文件必须分段 append，写完用「发布」。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app（暂存区，配 path）/ game / theater（草稿，配 name+field）/ repo（提交暂存区，配 path）",
        "    · name / path — 见 type 说明；field (可选) — game 默认 gameHtml，theater 默认 openingHtml",
        "    · content (必填) — 内容；append (可选) — true=追加（大文件分轮写）",
        '  调用：[执行动作:写入({"type":"game","name":"五子棋","content":"<!doctype html>…","append":true})]',
    ],
    async run(args, context) {
        if (args.type === "repo") return githubStageFileTool.run({ path: args.path, content: args.content, append: args.append, clear: args.clear }, context);
        if (args.type === "app") return contentToolByNative("stage_app_file").run({ path: args.path, content: args.content, append: args.append, base64: args.base64 }, context);
        return workbenchWriteLocal(args as Record<string, unknown>);
    },
};

const editTool: QaTool = {
    name: "编辑",
    nativeName: "edit_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater", "repo"], description: "编辑目标" },
            name: { type: "string", description: "app：已装应用名；game/theater：标题（只在本机测试时会自动转成草稿再改）" },
            path: { type: "string", description: "app：暂存文件路径；repo：仓库文件路径" },
            field: { type: "string", description: "game/theater：字段名，game 默认 gameHtml，theater 默认 openingHtml" },
            find: { type: "string", description: "要被替换的原文片段（须唯一，含足够上下文；空格换行须与原文完全一致）" },
            replace: { type: "string", description: "替换后的新片段" },
            all: { type: "boolean", description: "true=替换全部匹配处（默认要求唯一匹配）" },
        },
        required: ["type", "find", "replace"],
    },
    description:
        "改已有内容的首选方式（find/replace 片段替换）：只输出改动片段，省 token 且不会被输出上限截断，绝不要整体重写大文件。可改：已装 APP（name）、应用暂存文件（path）、游戏/剧场草稿字段（name+field）、仓库文件（type=repo + path，改动进提交暂存区，「发布」时才提交）。改前先「读取」核对原文。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater / repo",
        "    · name / path / field — 定位目标，见参数说明",
        "    · find (必填) / replace (必填) / all (可选) — 原文片段须唯一，all=true 替换全部",
        '  调用：[执行动作:编辑({"type":"game","name":"五子棋","find":"const SIZE = 15","replace":"const SIZE = 19"})]',
    ],
    async run(args, context) {
        if (args.type === "repo") {
            const config = loadQaGithubConfig();
            if (!config) return "尚未连接 GitHub 仓库。";
            const path = typeof args.path === "string" ? args.path.trim().replace(/^\.?\//, "") : "";
            if (!path) return "编辑 repo 需要 path（仓库文件路径）。";
            const find = typeof args.find === "string" ? args.find : "";
            const replace = typeof args.replace === "string" ? args.replace : "";
            if (!find) return "缺少 find（要被替换的原文片段）。";
            let base = commitStaging().get(path);
            const fromStaging = base != null;
            if (base == null) {
                try {
                    base = (await readQaGithubFile(config, path, context?.signal)).text;
                } catch (error) {
                    return `读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}。新文件请用「写入」type=repo。`;
                }
            }
            const count = base.split(find).length - 1;
            if (count === 0) return `文件 ${path}：找不到 find 片段。先用「读取」type=repo 核对原文（空格与换行须完全一致）。`;
            if (count > 1 && args.all !== true) return `文件 ${path}：find 片段匹配了 ${count} 处。加长片段使其唯一，或加 all:true 替换全部。`;
            const next = args.all === true ? base.split(find).join(replace) : base.replace(find, replace);
            commitStaging().set(path, next);
            persistCommitStaging();
            return `✓ 已替换 ${path} 的 ${args.all === true ? count : 1} 处并暂存（${fromStaging ? "基于暂存内容" : "基于仓库当前内容"}，现 ${next.length.toLocaleString()} 字符）。全部修改就绪后用「发布」type=repo 提交。`;
        }
        return workbenchEditLocal(args as Record<string, unknown>, context);
    },
};

const publishTool: QaTool = {
    name: "发布",
    nativeName: "publish_item",
    parameters: {
        type: "object",
        properties: {
            type: { type: "string", enum: ["app", "game", "theater", "repo"], description: "发布目标" },
            name: { type: "string", description: "app 单文件时的应用名；game/theater：草稿标题" },
            message: { type: "string", description: "repo：提交说明（必填）" },
            branch: { type: "string", description: "repo：目标分支，默认仓库默认分支，不存在会自动创建" },
            deletes: { type: "array", items: { type: "string" }, description: "repo：要删除的文件路径" },
            description: { type: "string", description: "app：一句话简介" },
            permissions: { type: "array", items: { type: "string" }, description: "app：覆盖默认权限集" },
            clear: { type: "boolean", description: "true=不发布，只清空对应暂存区（app/repo）" },
        },
        required: ["type"],
    },
    description:
        "把写好的内容落地：app=用应用暂存区组包安装到桌面（有 manifest.json 走完整包，只有 index.html 时配 name 走单文件）；game/theater=把草稿装进本机测试（游戏大厅/黑市剧场）；repo=把提交暂存区的全部修改提交到仓库（需 message，确认模式会先给用户确认）。app/game 发布前会做结构体检（文档收尾位置、script 配平、内联脚本语法试编译），不过会返回具体问题——按提示「编辑」修复后重新发布即可。",
    schemaLines: [
        "  参数：",
        "    · type (必填) — app / game / theater / repo",
        "    · name — app 单文件应用名 / game、theater 草稿标题",
        "    · message (repo 必填) / branch / deletes — 提交说明、目标分支、要删除的路径",
        "    · clear (可选) — true=只清空对应暂存区",
        '  调用：[执行动作:发布({"type":"game","name":"五子棋"})] 或 [执行动作:发布({"type":"repo","message":"修复计分"})]',
    ],
    async run(args, context) {
        if (args.type === "repo") {
            if (args.clear === true) {
                commitStaging().clear();
                persistCommitStaging();
                return "✓ 提交暂存区已清空。";
            }
            const deletes = Array.isArray(args.deletes) ? args.deletes : [];
            if (commitStaging().size === 0 && deletes.length === 0) return "提交暂存区为空，也没有 deletes。先用「写入」或「编辑」type=repo 修改文件。";
            const message = typeof args.message === "string" ? args.message.trim() : "";
            if (!message) return "发布 repo 需要 message（提交说明）。";
            const files = [...commitStaging().keys()].map((path) => ({ path, fromStaged: true }));
            return githubCommitTool.run({ message, branch: args.branch, files, deletes: deletes.length ? deletes : undefined }, context);
        }
        return workbenchPublishLocal(args as Record<string, unknown>, context);
    },
};

const diagnoseTool: QaTool = {
    name: "环境体检",
    nativeName: "env_check",
    parameters: {
        type: "object",
        properties: {
            scope: { type: "string", enum: ["api", "storage", "errors", "device"], description: "检查什么：api=LLM API 连通性；storage=浏览器存储占用；errors=运行时报错收集（见工具说明的覆盖范围）；device=设备与运行环境" },
            name: { type: "string", description: "scope=api 时只测指定名称的配置" },
        },
        required: ["scope"],
    },
    description:
        "检查运行环境本身是否健康：api=逐个真实测试已配置的 LLM API 连通性；storage=存储配额与占用；device=浏览器/视口/PWA/通知权限；errors=本次会话收集到的运行时报错（宿主页面 + 本机测试游戏/剧场 iframe）与 LLM 请求快照。它只看环境，不分析任何内容代码——某个 APP/游戏自身功能不对，用「读取」看它的源码。",
    schemaLines: [
        "  参数：",
        "    · scope (必填) — api / storage / errors / device",
        "    · name (可选) — scope=api 时只测该名称的配置",
        '  调用：[执行动作:环境体检({"scope":"api"})]',
    ],
    async run(args, context) {
        if (args.scope === "api") return apiCheckTool.run({ name: args.name }, context);
        if (args.scope === "storage") return storageReportTool.run({}, context);
        if (args.scope === "errors") return errorLogTool.run({}, context);
        if (args.scope === "device") return deviceInfoTool.run({}, context);
        return "scope 需为 api / storage / errors / device 之一。";
    },
};

// 「诊断」旧名别名：改名「环境体检」前的会话回放/弱模型旧指令仍可执行（隐藏，不进提示词）
const diagnoseLegacyAliasTool: QaTool = {
    name: "诊断",
    nativeName: "run_diagnostics",
    parameters: diagnoseTool.parameters,
    description: diagnoseTool.description,
    schemaLines: diagnoseTool.schemaLines,
    run: (args, context) => diagnoseTool.run(args, context),
};

/* 仅 debug/开发模式：工坊 AI 可以在本页执行任意 JS，用来修数据、调试 DOM/IndexedDB。
   release 构建（NODE_ENV=production）不会注册这个工具。 */
const workshopHarnessEvalTool: QaTool = {
    name: "运行调试代码",
    nativeName: "harness_eval",
    parameters: {
        type: "object",
        properties: {
            code: { type: "string", description: "要在本页执行的 JS 表达式；支持 await，返回结果会回传" },
            confirm: { type: "boolean", description: "必须为 true；这是高权限调试工具" },
        },
        required: ["code", "confirm"],
    },
    description: "仅在 debug/开发包可用：在当前网页执行任意 JS（可读写 IndexedDB/KV/DOM）。用于修复数据、验证页面逻辑；release 不注册。必须 confirm=true。",
    schemaLines: [
        "  参数：",
        "    · code (必填) — JS 表达式，支持 await",
        "    · confirm (必填) — 必须 true",
        '  调用：[执行动作:运行调试代码({"code":"document.title","confirm":true})]',
    ],
    async run(args) {
        if (args.confirm !== true) return "高权限调试代码必须 confirm=true。";
        if (process.env.NODE_ENV === "production") return "release 构建未开放本机调试代码。";
        const code = String(args.code || "").trim();
        if (!code) return "code 不能为空。";
        try {
            const AsyncFunction = Object.getPrototypeOf(async function () { /* noop */ }).constructor as new (...parts: string[]) => (...values: unknown[]) => Promise<unknown>;
            const fn = new AsyncFunction(`"use strict"; return (${code});`);
            const value = await fn();
            let text = "";
            try { text = JSON.stringify(value); } catch { text = String(value); }
            return (text || String(value)).slice(0, 12000);
        } catch (error) {
            return "执行失败：" + (error instanceof Error ? error.message : String(error));
        }
    },
};

const repoQueryTool: QaTool = {
    name: "仓库查询",
    nativeName: "repo_query",
    parameters: {
        type: "object",
        properties: {
            kind: { type: "string", enum: ["commits", "branches", "pulls", "issues"], description: "查什么，默认 commits" },
            sha: { type: "string", description: "commits：看该提交的改动详情（含 diff）" },
            number: { type: "number", description: "pulls/issues：编号，不填列出列表" },
            state: { type: "string", enum: ["open", "closed", "all"], description: "pulls/issues 列表状态过滤，默认 open" },
            branch: { type: "string", description: "commits：按分支过滤" },
            path: { type: "string", description: "commits：只看该文件的历史" },
            limit: { type: "number", description: "commits：条数，默认 10" },
        },
    },
    description:
        "查仓库状态：kind=commits（默认）看提交历史或某次提交的 diff（sha）；branches 列分支；pulls 列 PR 或看详情（number）；issues 列 issue 或看详情与评论（number）。",
    schemaLines: [
        "  参数：",
        "    · kind (可选) — commits（默认）/ branches / pulls / issues",
        "    · sha / number / state / branch / path / limit — 按 kind 取用",
        '  调用：[执行动作:仓库查询({"kind":"pulls"})] 或 [执行动作:仓库查询({"sha":"abc123"})]',
    ],
    async run(args, context) {
        const kind = typeof args.kind === "string" ? args.kind : "";
        if (kind === "branches") return githubBranchListTool.run({}, context);
        if (kind === "pulls") return githubPullReadTool.run({ number: args.number, state: args.state }, context);
        if (kind === "issues") return githubIssueReadTool.run({ number: args.number, state: args.state }, context);
        return githubHistoryTool.run({ sha: args.sha, branch: args.branch, path: args.path, limit: args.limit }, context);
    },
};

const branchOpsTool: QaTool = {
    name: "分支管理",
    nativeName: "branch_ops",
    parameters: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["create", "delete"], description: "create=新建分支；delete=删除分支" },
            name: { type: "string", description: "分支名" },
            from: { type: "string", description: "create：从哪个分支切出，默认仓库配置分支/默认分支" },
        },
        required: ["action", "name"],
    },
    description:
        "管理仓库分支：create 新建（已存在不报错，之后「发布」type=repo 用 branch 参数提交过去）；delete 删除（默认分支与工坊工作分支受保护）。",
    schemaLines: [
        "  参数：",
        "    · action (必填) — create / delete",
        "    · name (必填) — 分支名；from (可选) — create 时的源分支",
        '  调用：[执行动作:分支管理({"action":"create","name":"feature/dark-mode"})]',
    ],
    async run(args, context) {
        if (args.action === "delete") return githubBranchDeleteTool.run({ name: args.name }, context);
        if (args.action === "create") return githubBranchTool.run({ name: args.name, from: args.from }, context);
        return "action 需为 create / delete。";
    },
};

// ── 注册表 ───────────────────────────────────────────

// 旧工具分组（隐藏别名：仍可执行，不进系统提示）
const BASE_TOOLS: QaTool[] = [apiCheckTool, storageReportTool, errorLogTool, deviceInfoTool, feedbackTool, faqTool, ...QA_CONTENT_TOOLS];

// 暴露给模型的统一工具集
const UNIFIED_BASE_TOOLS: QaTool[] = [
    listTool,
    readTool,
    writeTool,
    editTool,
    publishTool,
    contentToolByNative("read_creation_guide"),
    faqTool,
    contentToolByNative("export_local_content"),
    // 共同建设：贡献改动给官方仓库（读侧公共接口，提交走集市中转，与「连接仓库」无关）
    contentToolByNative("compare_with_official"),
    contentToolByNative("read_contrib_diff"),
    contentToolByNative("submit_contribution"),
    diagnoseTool,
    feedbackTool,
    ...(process.env.NODE_ENV !== "production" ? [workshopHarnessEvalTool] : []),
];
const UNIFIED_GITHUB_READ_TOOLS: QaTool[] = [githubSearchTool, repoQueryTool];
const UNIFIED_GITHUB_WRITE_TOOLS: QaTool[] = [branchOpsTool, githubPullCreateTool, githubPullMergeTool, githubIssueUpdateTool, githubSyncUpstreamTool];

/** 当前可用工具集：统一 CRUD + 辅助 + （已连接仓库）查询 + （有 PAT）写入 + （已连接角色电脑）工作机。 */
export function getQaTools(): QaTool[] {
    const config = loadQaGithubConfig();
    const tools = [...UNIFIED_BASE_TOOLS];
    if (config) tools.push(...UNIFIED_GITHUB_READ_TOOLS);
    if (config?.token) tools.push(...UNIFIED_GITHUB_WRITE_TOOLS);
    if (isWorkshopComputerEnabled()) tools.push(...QA_COMPUTER_TOOLS);
    return tools;
}

// 全量注册表（store 里用于工具名映射与执行查找）：统一工具 + 全部旧工具隐藏别名，
// Set 去重（部分工具两边都在）
export const QA_TOOLS: QaTool[] = [...new Set([
    ...UNIFIED_BASE_TOOLS,
    workshopHarnessEvalTool,
    ...UNIFIED_GITHUB_READ_TOOLS,
    ...UNIFIED_GITHUB_WRITE_TOOLS,
    ...QA_COMPUTER_TOOLS,
    ...QA_COMPUTER_ALIAS_TOOLS,
    diagnoseLegacyAliasTool,
    ...BASE_TOOLS,
    ...GITHUB_TOOLS,
    ...GITHUB_WRITE_TOOLS,
])];

// ── 原生工具协议（function calling）────────────────────

export type QaNativeToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };

/** 当前可用工具的原生定义（供请求体 tools 字段用）。 */
export function getQaNativeToolDefinitions(): QaNativeToolDefinition[] {
    return getQaTools().map((tool) => ({
        name: tool.nativeName,
        description: tool.description,
        parameters: tool.parameters,
    }));
}

/** 原生英文名 → 中文工具名（执行与 UI 展示都用中文名）。 */
export function buildQaNativeNameMap(): Map<string, string> {
    return new Map(QA_TOOLS.map((tool) => [tool.nativeName, tool.name]));
}

export function buildQaToolsPrompt(): string {
    const tools = getQaTools();
    const lines: string[] = [];
    lines.push("===== 你的工具 =====");
    lines.push("排查用户问题先分诊，再选工具，不要凭空猜测、也不要把工具挨个跑一遍：");
    lines.push("· 某个 APP/游戏/剧场自身行为不对（界面不显示、按钮没反应、数据不对）→ 这是它的代码问题，「读取」它的源码定位逻辑，与环境无关；");
    lines.push("· 环境问题（API 连不上、存储满、整个页面崩溃报错、设备兼容）→「环境体检」对应 scope；");
    lines.push("· 产品用法问题（功能怎么用、设置在哪）→「答疑文档」。");
    lines.push("可用工具：");
    lines.push("");
    for (const tool of tools) {
        lines.push(`【${tool.name}】${tool.description}`);
        lines.push(...tool.schemaLines);
        lines.push("");
    }
    lines.push("===== 调用规则 =====");
    lines.push('· 执行动作：使用 [执行动作:工具名({"参数":"值"})] 格式，无参数时用 [执行动作:工具名({})]');
    lines.push("· 一条回复里可以调用多个工具；调用后等待系统返回工具结果再继续分析");
    lines.push("· 产品问题没把握时先用「答疑文档」按关键词检索；文档查不到且已连接仓库时再查源码；仍无结论就如实说明");
    lines.push("· 回答代码问题时，先用「清单」scope=repo 或「搜索仓库代码」定位，再用「读取」type=repo 看具体实现，基于真实代码作答");
    lines.push("· 用户想要新 APP/小游戏/剧场时：先用「创作指南」读对应类型的制作说明（可分页），用「写入」写内容（可能超出输出预算的大文件才分段 append），写完「发布」装进本机，最后告诉用户去哪里打开；同名会更新。创作所需的协议/API/声明资料一律以「创作指南」为准，不要查「答疑文档」——那是给用户答疑用的");
    lines.push("· 改已有内容（本机或仓库）一律先「读取」核对原文，再用「编辑」find/replace 只改动片段，绝不整体重写大文件；改完本机内容重新「发布」生效");
    lines.push("· 收到工具结果后，用人话向用户解释结论和建议，不要原样罗列");
    lines.push("· 不需要工具时直接回复文字");
    return lines.join("\n");
}

/**
 * 工具行副标题：从参数里提炼一句人能看懂的摘要（统一工具名太泛，"读取/写入"
 * 不带参数没有信息量）。规则通用，旧工具的 title/query/path 也能覆盖。
 * 例：读取 → repo:lib/chat-engine.ts 1-80行；写入 → app:index.html 3.2k字·追加。
 */
export function formatQaToolSubtitle(name: string, args?: Record<string, unknown>): string {
    void name;
    if (!args || typeof args !== "object") return "";
    const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
    const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const clipText = (v: string, max: number): string => (v.length > max ? `${v.slice(0, max)}…` : v);

    const kind = str(args.type) || str(args.scope) || str(args.kind) || str(args.action);
    const target = str(args.path) || str(args.name) || str(args.title);
    const field = str(args.field);
    const parts: string[] = [];
    if (kind && target) parts.push(`${kind}:${clipText(target, 36)}${field ? `·${field}` : ""}`);
    else if (kind) parts.push(kind + (field ? `·${field}` : ""));
    else if (target) parts.push(clipText(target, 36) + (field ? `·${field}` : ""));

    const query = str(args.query) || (!target ? str(args.find) : "");
    if (query) parts.push(clipText(query, 24));
    const sha = str(args.sha);
    if (sha) parts.push(sha.slice(0, 8));
    const number = num(args.number);
    if (number != null) parts.push(`#${number}`);
    const page = num(args.page);
    if (page != null && page > 1) parts.push(`第${page}页`);
    const start = num(args.start);
    const end = num(args.end);
    if (start != null || end != null) parts.push(`${start ?? 1}-${end ?? ""}行`);

    const contentLen = typeof args.content === "string" ? args.content.length : 0;
    if (contentLen > 0) {
        const size = contentLen >= 1000 ? `${(contentLen / 1000).toFixed(1)}k` : String(contentLen);
        parts.push(`${size}字${args.append === true ? "·追加" : ""}`);
    } else if (args.append === true) {
        parts.push("追加");
    }
    if (args.fromDraft === true) parts.push("从草稿");
    if (args.fromStaged === true) parts.push("从暂存");
    if (args.clear === true) parts.push("清空");
    const message = str(args.message);
    if (message) parts.push(clipText(message, 20));
    return parts.join(" ");
}

export async function runQaToolCall(call: ToolCall, context?: QaToolContext): Promise<QaToolRunResult> {
    const tool = QA_TOOLS.find((t) => t.name === call.name);
    if (!tool) {
        return { name: call.name, success: false, resultForModel: `未知工具「${call.name}」。可用工具：${getQaTools().map((t) => t.name).join("、")}` };
    }
    try {
        const result = await tool.run(call.args ?? {}, context);
        return { name: call.name, success: true, resultForModel: result };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { name: call.name, success: false, resultForModel: `工具执行失败：${message.slice(0, 300)}` };
    }
}
