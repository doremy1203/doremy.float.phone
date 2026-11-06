import { jsonrepair } from "jsonrepair";

export type LifeOutputIssue =
    | "json_parse"
    | "schema"
    | "outside_text"
    | "multiple_actions"
    | "speech_in_action"
    | "action_in_dialogue"
    | "action_only"
    | "consecutive_action_only"
    | "multiple_tools"
    | "empty_turn";

export type LifeOutputPlanChange = {
    title: string;
    locationId: string;
    startAt: string;
    endAt: string;
};

export type LifeOutputInvitation = {
    time: string;
    locationId: string;
    activity: string;
    reason: string;
    durationMinutes: number;
};

export type LifeOutputFollowRequest = {
    durationMinutes: number;
    reason: string;
};

export type ParsedLifeOutput = {
    action?: string;
    dialogue: string;
    dialogues: string[];
    planChange?: LifeOutputPlanChange;
    invitation?: LifeOutputInvitation;
    followRequest?: LifeOutputFollowRequest;
    issues: LifeOutputIssue[];
    mode: "json" | "xml" | "text";
    toolCount: number;
};

export type LifeOutputValidationOptions = {
    previousActionOnly?: boolean;
    maxConsecutiveActionOnly?: 0 | 1 | 2;
    /** 主动回合允许整轮沉默；回复回合通常不允许。 */
    allowEmpty?: boolean;
};

const ACTION_VERB = /笑了笑|笑着|看向|看着|望向|望着|转过身|转身|低下头|低头|抬起头|抬头|抬手|伸出手|伸手|靠近|走到|走向|走近|走进|走出|进来|出去|离开|回到|上楼|下楼|坐下|起身|站起|站起来|蹲下|躺下|趴下|坐直|弯腰|点点头|点头|摇摇头|摇头|叹了口气|叹气|皱起眉|皱眉|眨了眨眼|眨眼|闭眼|睁眼|抬眼|垂眸|抱住|抱紧|松开|握紧|攥紧|拿起|放下|注视|呼吸|吸了口气|呼了口气|轻轻地|轻轻|慢慢地|慢慢|停下脚步|停住脚步|站定|移开视线|别开目光|耳尖泛红|脸颊泛红|动作|神情|姿态|抚摸|轻抚|摸了摸|拍了拍|戳了戳|碰了碰|蹭了蹭|揉了揉|敲了敲|踢了踢|推了推|拉了拉|拉住|牵起|牵住|搂住|拥抱|贴近|挪了挪|向前一步|后退一步|倚着|靠在|倚靠|扶着|拨开|整理|掀开|合上|翻开|打开|关上|推开|推门|推到|递给|放在|移到|收回|收起|收好|盖上|披上|穿上|脱下|挡住|拦住|扶住|握住|咬了咬唇|舔了舔唇|抿唇|垂眼|垂下眼|侧头|侧过脸|偏头|转过头|背过身|跨过|绕过|穿过|沉默|犹豫|停顿|怔|愣|扬起嘴角|唇角|眼神|视线|目光|把.+?(?:递给|放在|拿起|放下|推到|移到|收起|收好)|将.+?(?:递给|放在|拿起|放下|推到|移到|收起|收好)/;
const SPEECH_VERB = /(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|喊道|叫道|说|问|答|道|喊|叫)/;
const QUOTE_RE = /[“「『"]([^”」』"]+)[”」』"]/g;

function stripFences(value: string): string {
    return value
        .replace(/^\s*```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
}

function normalizeEscaped(value: string): string {
    return value.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&amp;/gi, "&");
}

function asString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeJsonDialogue(value: unknown): string {
    const text = asString(value);
    if (!text) return "";
    const pairs: Array<[string, string]> = [["“", "”"], ["「", "」"], ["『", "』"], ['"', '"']];
    for (const [open, close] of pairs) {
        if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
            return text.slice(open.length, -close.length).trim();
        }
    }
    return text;
}

function asStringArray(value: unknown): string[] {
    if (typeof value === "string") return value.trim() ? [value.trim()] : [];
    if (!Array.isArray(value)) return [];
    return value.map(item => asString(item)).filter(Boolean);
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizePlanChange(value: unknown): LifeOutputPlanChange | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    const startAt = asString(record.startAt ?? record.start_at);
    const endAt = asString(record.endAt ?? record.end_at);
    const title = asString(record.title);
    const locationId = asString(record.locationId ?? record.location_id) || "home";
    if (!startAt || !endAt || !title) return undefined;
    return { startAt, endAt, title, locationId };
}

function normalizeInvitation(value: unknown): LifeOutputInvitation | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    const time = asString(record.time ?? record.startAt ?? record.start_at);
    const activity = asString(record.activity);
    if (!time || !activity) return undefined;
    const rawDuration = Number(record.durationMinutes ?? record.duration_minutes);
    const durationMinutes = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.max(15, Math.min(rawDuration, 24 * 60)) : 60;
    return {
        time,
        locationId: asString(record.locationId ?? record.location_id) || "cafe",
        activity,
        reason: asString(record.reason),
        durationMinutes,
    };
}

function normalizeFollowRequest(value: unknown): LifeOutputFollowRequest | undefined {
    const record = asRecord(value);
    if (!record) return undefined;
    const rawDuration = Number(record.durationMinutes ?? record.duration_minutes);
    const durationMinutes = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.max(15, Math.min(rawDuration, 24 * 60)) : 120;
    return { durationMinutes, reason: asString(record.reason) };
}

function extractQuoted(text: string): { outside: string; quotes: string[] } {
    const quotes: string[] = [];
    const outside = text.replace(QUOTE_RE, (_whole, spoken: string) => {
        if (spoken.trim()) quotes.push(spoken.trim());
        return " ";
    }).trim();
    return { outside, quotes };
}

function cleanStageAction(value: string): string {
    return value
        .replace(/[，,：:]?\s*(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|说|问|答|道|喊|叫)\s*[：:，,]?\s*$/, "")
        .replace(/^(?:她|他|我|对方|那个人)\s*$/, "")
        .trim();
}

function cleanAction(raw: string, dialogues: string[]): string {
    const normalized = raw.replace(/\*+/g, "").trim();
    if (!normalized) return "";
    const { outside, quotes } = extractQuoted(normalized);
    dialogues.push(...quotes);
    let action = outside.replace(/\s+/g, " ").trim();
    // 兼容“她轻声说：别熬夜了”这种没有引号的台词；只在有动作前缀时拆。
    const speech = action.match(/^(.{1,120}?)(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|说|问|答|喊|叫)\s*[:：]\s*(.+)$/s);
    if (speech && ACTION_VERB.test(speech[1])) {
        action = speech[1].trim().replace(/[，,：:]$/, "");
        dialogues.push(speech[2].trim());
    }
    return action
        .replace(/^[-•]\s*/, "")
        .replace(/[，,：:]?\s*(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|说|问|答|道|喊|叫)\s*[。.!！?？]?$/, "")
        .replace(/^(?:她|他|我|对方|那个人)\s*$/, "")
        .trim();
}

function cleanDialogue(raw: string, actions: string[]): string | null {
    let text = raw.replace(/\r/g, "").trim();
    if (!text) return null;
    const stageDirections: string[] = [];
    // 引号内的才是台词；引号外的叙述/动作归 action。
    const quoted = extractQuoted(text);
    if (quoted.quotes.length > 0) {
        if (quoted.outside && ACTION_VERB.test(quoted.outside)) stageDirections.push(cleanStageAction(quoted.outside));
        text = quoted.quotes.join(" ");
    }
    text = text.replace(/\*([^*\n]+)\*/g, (_whole, value: string) => {
        if (value.trim()) stageDirections.push(value.trim());
        return " ";
    });
    text = text.replace(/[（(]([^（）()\n]+)[）)]/g, (_whole, value: string) => {
        if (value.trim()) stageDirections.push(value.trim());
        return " ";
    });
    // “她笑了笑，说：……” / “她轻声说‘……’”
    const speech = text.match(/^(.{1,120}?)(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|说|问|答|喊|叫)\s*[:：，,]?\s*(.+)$/s);
    if (speech && ACTION_VERB.test(speech[1])) {
        stageDirections.push(cleanStageAction(speech[1]));
        text = speech[2].trim();
    }
    const dialogue = text
        .replace(/^[-•]\s*/, "")
        .replace(/^[“「『"]+|[”」』"]+$/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!dialogue) {
        actions.push(...stageDirections);
        return null;
    }
    // 没有引号、没有问/叹号，且整句是动作：归 action，不归 dialogue。
    if (!/[“”「」"]/.test(dialogue) && !/[？?！!]$/.test(dialogue) && ACTION_VERB.test(dialogue) && !SPEECH_VERB.test(dialogue)) {
        actions.push(dialogue);
        actions.push(...stageDirections);
        return null;
    }
    actions.push(...stageDirections);
    return dialogue;
}

function buildParsed(
    action: string | undefined,
    dialogues: string[],
    mode: ParsedLifeOutput["mode"],
    issues: LifeOutputIssue[],
    extras?: {
        planChange?: LifeOutputPlanChange;
        invitation?: LifeOutputInvitation;
        followRequest?: LifeOutputFollowRequest;
        toolCount?: number;
    },
): ParsedLifeOutput {
    const cleanDialogues = dialogues.map(value => value.trim()).filter(Boolean);
    return {
        action: action?.trim() || undefined,
        dialogue: cleanDialogues.join("\n"),
        dialogues: cleanDialogues,
        planChange: extras?.planChange,
        invitation: extras?.invitation,
        followRequest: extras?.followRequest,
        issues: [...new Set(issues)],
        mode,
        toolCount: extras?.toolCount ?? [extras?.planChange, extras?.invitation, extras?.followRequest].filter(Boolean).length,
    };
}

function parseJsonObject(raw: string): ParsedLifeOutput | null {
    const text = stripFences(normalizeEscaped(raw));
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const candidate = text.slice(start, end + 1);
    let parsed: unknown;
    try {
        parsed = JSON.parse(candidate);
    } catch {
        try {
            parsed = JSON.parse(jsonrepair(candidate));
        } catch {
            return null;
        }
    }
    const record = asRecord(parsed);
    if (!record) return null;
    const issues: LifeOutputIssue[] = [];
    if (text.slice(0, start).trim() || text.slice(end + 1).trim()) issues.push("outside_text");
    const rawAction = record.action;
    // A valid structured JSON response already defines the action/dialogue boundary.
    // Do not run legacy prose extraction here: it can silently move or rewrite content
    // the model deliberately placed in a specific field. XML/plain-text fallbacks below
    // retain the old compatibility parser.
    const action = typeof rawAction === "string" ? rawAction.trim() : "";
    let rawDialogues: unknown = record.dialogues ?? record.dialogue;
    if (typeof rawDialogues === "string") rawDialogues = [rawDialogues];
    const dialogues = Array.isArray(rawDialogues)
        ? rawDialogues.map(normalizeJsonDialogue).filter(Boolean)
        : [];
    const rawPlanChange = record.plan_change ?? record.planChange;
    const rawInvitation = record.invitation;
    const rawFollowRequest = record.follow_request ?? record.followRequest;
    const planChange = normalizePlanChange(rawPlanChange);
    const invitation = normalizeInvitation(rawInvitation);
    const followRequest = normalizeFollowRequest(rawFollowRequest);
    const toolCount = [planChange, invitation, followRequest].filter(Boolean).length;
    if (toolCount > 1) issues.push("multiple_tools");
    if (rawPlanChange != null && !planChange) issues.push("schema");
    if (rawInvitation != null && !invitation) issues.push("schema");
    if (rawFollowRequest != null && !followRequest) issues.push("schema");
    if (planChange && (!planChange.startAt || !planChange.endAt)) issues.push("schema");
    if (invitation && (!invitation.time || !invitation.activity)) issues.push("schema");
    if (rawAction != null && typeof rawAction !== "string") issues.push("schema");
    if (rawDialogues != null && !Array.isArray(rawDialogues)) issues.push("schema");
    if (Array.isArray(rawDialogues) && rawDialogues.some(item => typeof item !== "string")) issues.push("schema");
    return buildParsed(action, dialogues, "json", issues, { planChange, invitation, followRequest, toolCount });
}

function parseXml(raw: string): ParsedLifeOutput | null {
    const source = normalizeEscaped(raw);
    const actionMatches = [...source.matchAll(/<life_action\b[^>]*>([\s\S]*?)(?:<\/life_action\s*>|(?=<life_dialogue\b)|$)/ig)];
    const dialogueMatches = [...source.matchAll(/<life_dialogue\b[^>]*>([\s\S]*?)(?:<\/life_dialogue\s*>|$)/ig)];
    if (actionMatches.length === 0 && dialogueMatches.length === 0) return null;
    const issues: LifeOutputIssue[] = [];
    if (actionMatches.length > 1) issues.push("multiple_actions");
    const outside = source
        .replace(/<life_action\b[^>]*>[\s\S]*?(?:<\/life_action\s*>|(?=<life_dialogue\b)|$)/ig, " ")
        .replace(/<life_dialogue\b[^>]*>[\s\S]*?(?:<\/life_dialogue\s*>|$)/ig, " ")
        .replace(/<life_(?:follow_request|plan_change|invitation)\b[^>]*\/?\s*>/ig, " ")
        .trim();
    if (outside) issues.push("outside_text");
    const dialogues: string[] = [];
    const actions: string[] = [];
    for (const match of actionMatches) {
        const value = cleanAction(match[1] || "", dialogues);
        if (value) actions.push(value);
    }
    for (const match of dialogueMatches) {
        const value = cleanDialogue(match[1] || "", actions);
        if (value) dialogues.push(value);
    }
    const attribute = (tag: string, name: string): string => {
        const record = source.match(new RegExp(`<${tag}\\b([^>]*)\\/?\\s*>`, "i"));
        if (!record) return "";
        const value = record[1].match(new RegExp(name + "\\s*=\\s*[\"']([^\"']*)", "i"));
        return (value?.[1] || "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").trim();
    };
    const planTag = source.match(/<life_plan_change\b([^>]*)\/?\s*>/i);
    const inviteTag = source.match(/<life_invitation\b([^>]*)\/?\s*>/i);
    const followTag = source.match(/<life_follow_request\b([^>]*)\/?\s*>/i);
    const planChange = planTag ? normalizePlanChange({
        startAt: attribute("life_plan_change", "startAt"),
        endAt: attribute("life_plan_change", "endAt"),
        title: attribute("life_plan_change", "title"),
        locationId: attribute("life_plan_change", "locationId"),
    }) : undefined;
    const invitation = inviteTag ? normalizeInvitation({
        time: attribute("life_invitation", "time"),
        locationId: attribute("life_invitation", "locationId"),
        activity: attribute("life_invitation", "activity"),
        reason: attribute("life_invitation", "reason"),
        durationMinutes: attribute("life_invitation", "durationMinutes"),
    }) : undefined;
    const followRequest = followTag ? normalizeFollowRequest({
        durationMinutes: attribute("life_follow_request", "durationMinutes"),
        reason: attribute("life_follow_request", "reason"),
    }) : undefined;
    const toolCount = [planChange, invitation, followRequest].filter(Boolean).length;
    if (toolCount > 1) issues.push("multiple_tools");
    return buildParsed(actions.join("；"), dialogues, "xml", issues, { planChange, invitation, followRequest, toolCount });
}

function parseLooseText(raw: string): ParsedLifeOutput {
    const source = normalizeEscaped(raw);
    const actions: string[] = [];
    const dialogues: string[] = [];
    let text = source.replace(/\*([^*\n]+)\*/g, (_whole, value: string) => {
        if (value.trim()) actions.push(value.trim());
        return " ";
    });
    text = text.replace(/[（(]([^（）()\n]+)[）)]/g, (whole, value: string) => {
        if (ACTION_VERB.test(value)) {
            actions.push(value.trim());
            return " ";
        }
        return whole;
    });
    for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
        const actionLabel = line.match(/^(?:动作|行动|旁白|场景描写)\s*[:：]\s*(.+)$/);
        const dialogueLabel = line.match(/^对白\s*[:：]\s*(.+)$/);
        if (actionLabel) {
            actions.push(actionLabel[1].trim());
            continue;
        }
        const value = dialogueLabel ? dialogueLabel[1].trim() : line;
        const { outside, quotes } = extractQuoted(value);
        if (quotes.length) {
            if (outside && ACTION_VERB.test(outside)) actions.push(outside.replace(/[，,：:]?(?:说道|说着|开口道|问道|答道)$/g, "").trim());
            dialogues.push(...quotes);
            continue;
        }
        const speech = value.match(/^(.{1,120}?)(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道|说|问|答|喊|叫)\s*[:：，,]?\s*(.+)$/s);
        if (speech && ACTION_VERB.test(speech[1])) {
            actions.push(speech[1].trim().replace(/[，,：:]$/, ""));
            dialogues.push(speech[2].trim());
            continue;
        }
        if (ACTION_VERB.test(value) && !/[？?！!]$/.test(value)) {
            actions.push(value.replace(/^(?:动作|行动|旁白|场景描写)\s*[:：]\s*/, "").trim());
        } else {
            dialogues.push(value.replace(/^[“「『"]+|[”」』"]+$/g, "").trim());
        }
    }
    return buildParsed(actions.filter(Boolean).join("；"), dialogues, "text", []);
}

export function parseLifeOutput(raw: string): ParsedLifeOutput {
    const text = String(raw ?? "");
    const fromJson = parseJsonObject(text);
    if (fromJson) return fromJson;
    const fromXml = parseXml(text);
    if (fromXml) return fromXml;
    const fallback = parseLooseText(text);
    // 看起来像 JSON 但解析失败：保留兜底结果，同时标记格式问题，让上层重试。
    if (text.trim().startsWith("{") || text.indexOf("\"action\"") >= 0) {
        fallback.issues = [...new Set([...fallback.issues, "json_parse" as const])];
    }
    return fallback;
}

export function validateLifeOutput(
    output: ParsedLifeOutput,
    options: LifeOutputValidationOptions = {},
): LifeOutputIssue[] {
    const issues = new Set<LifeOutputIssue>(output.issues);
    const hasAction = Boolean(output.action?.trim());
    const hasDialogue = output.dialogues.some(item => Boolean(item.trim()));
    if (!hasAction && !hasDialogue && !options.allowEmpty) issues.add("empty_turn");
    if (hasAction && !hasDialogue) {
        const max = options.maxConsecutiveActionOnly ?? 1;
        if (max <= 0) issues.add("action_only");
        else if (options.previousActionOnly) issues.add("consecutive_action_only");
    }
    if (output.action && (/[“”「」"]/.test(output.action) || /(?:轻声说|低声说|开口道|说道|说着|问道|答道|回答道)\s*[:：]?\s*\S+/.test(output.action))) issues.add("speech_in_action");
    if (output.dialogues.some(item => /[（(]|\*/.test(item) || (ACTION_VERB.test(item) && SPEECH_VERB.test(item)))) issues.add("action_in_dialogue");
    if (output.toolCount > 1) issues.add("multiple_tools");
    return [...issues];
}

export function describeLifeOutputIssues(issues: LifeOutputIssue[]): string {
    const labels: Record<LifeOutputIssue, string> = {
        json_parse: "JSON 无法解析",
        schema: "字段类型或必填项不正确",
        outside_text: "JSON/标签外还有多余文字",
        multiple_actions: "出现了多个 action",
        speech_in_action: "action 里写了台词",
        action_in_dialogue: "dialogue 里写了动作/括号/星号",
        action_only: "这一轮只有 action，没有 dialogue",
        consecutive_action_only: "连续两轮只有 action，没有 dialogue",
        multiple_tools: "一轮里出现了多个工具",
        empty_turn: "action 和 dialogue 都为空",
    };
    return [...new Set(issues)].map(issue => labels[issue]).join("；");
}
