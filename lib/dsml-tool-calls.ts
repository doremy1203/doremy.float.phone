/**
 * DeepSeek 系列模型有时不把工具调用放在 provider 的 tool_calls 字段，
 * 而是把 DSML 标记直接写进正文：
 *
 *   <｜DSML｜tool_calls>
 *   <｜DSML｜invoke name="action_ab12cd">
 *   <｜DSML｜parameter name="text" string="true">你好</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜tool_calls>
 *
 * 这里负责识别并剥离这些标记；能解析出的调用交给调用方去执行。
 * 兼容 V4 的 tool_calls、V3.2 的 function_calls、旧版无 DSML 前缀的裸标签，
 * 以及网页端出现的双竖线 / 竖线两侧带空格变体。
 */

export type DsmlToolCall = {
    id: string;
    name: string;
    args: Record<string, unknown>;
};

export type DsmlExtraction = {
    text: string;
    toolCalls: DsmlToolCall[];
};

function normalizeMarkers(value: string): string {
    return value
        .replace(/\uFF5C/g, "|")
        // 兼容 <｜DSML｜、< | | DSML | |、<||DSML|| 等写法（竖线之间可能带空格）
        .replace(/<\s*\/\s*(?:\|\s*)+DSML\s*(?:\|\s*)+/gi, "</|DSML|")
        .replace(/<\s*(?:\|\s*)+DSML\s*(?:\|\s*)+/gi, "<|DSML|");
}

const OPEN = String.raw`<\s*(?:\|DSML\|\s*)?`;
const CLOSE = String.raw`<\/\s*(?:\|DSML\|\s*)?`;
const CALL_NAME = String.raw`(tool_calls|function_calls|calls)`;

function parseArgs(body: string): Array<{ name: string; args: Record<string, unknown> }> {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const invokeRe = new RegExp(
        String.raw`${OPEN}invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)${CLOSE}invoke\s*>`,
        "gi",
    );
    let invoke: RegExpExecArray | null;
    while ((invoke = invokeRe.exec(body))) {
        const name = invoke[1].trim();
        const inner = invoke[2];
        const args: Record<string, unknown> = {};
        const paramRe = new RegExp(
            String.raw`${OPEN}parameter\s+name\s*=\s*"([^"]+)"\s*(?:string\s*=\s*"(true|false)")?\s*>([\s\S]*?)${CLOSE}parameter\s*>`,
            "gi",
        );
        let param: RegExpExecArray | null;
        while ((param = paramRe.exec(inner))) {
            const key = param[1].trim();
            const isString = param[2] !== "false";
            const rawValue = param[3].trim();
            if (!key) continue;
            if (isString) {
                args[key] = rawValue;
            } else {
                try { args[key] = JSON.parse(rawValue); }
                catch { args[key] = rawValue; }
            }
        }
        if (name) calls.push({ name, args });
    }
    return calls;
}

export function extractDsmlToolCalls(raw: string): DsmlExtraction {
    const source = normalizeMarkers(String(raw ?? ""));
    if (!source) return { text: "", toolCalls: [] };
    const collected: Array<{ name: string; args: Record<string, unknown> }> = [];
    let text = source;

    // 1) 完整闭合的调用块
    const closedRe = new RegExp(String.raw`${OPEN}${CALL_NAME}\s*>([\s\S]*?)${CLOSE}\1\s*>`, "gi");
    text = text.replace(closedRe, (_whole, _name: string, body: string) => {
        collected.push(...parseArgs(body));
        return "";
    });

    // 2) 模型截断/漏闭合的调用块：从开标签一直吃到下一个开标签或文本末尾
    if (new RegExp(String.raw`${OPEN}${CALL_NAME}\s*>`, "i").test(text)) {
        const unclosedRe = new RegExp(
            String.raw`${OPEN}${CALL_NAME}\s*>([\s\S]*?)(?=${OPEN}(?:tool_calls|function_calls|calls)\s*>|$)`,
            "gi",
        );
        text = text.replace(unclosedRe, (_whole, _name: string, body: string) => {
            collected.push(...parseArgs(body));
            return "";
        });
    }

    // 3) 残留的孤立标记（只有开/闭标签，没有内容）
    text = text
        .replace(new RegExp(String.raw`${CLOSE}(?:tool_calls|function_calls|calls|invoke|parameter)\s*>`, "gi"), "")
        .replace(new RegExp(String.raw`${OPEN}(?:tool_calls|function_calls|calls)\s*>`, "gi"), "");

    const unique = new Map<string, DsmlToolCall>();
    collected.forEach((call, index) => {
        const signature = call.name + ":" + JSON.stringify(call.args);
        if (unique.has(signature)) return;
        unique.set(signature, {
            id: `dsml_${Date.now().toString(36)}_${index}`,
            name: call.name,
            args: call.args,
        });
    });

    return {
        text: text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
        toolCalls: [...unique.values()],
    };
}

/** 只剥标记、不做执行时的便捷入口。 */
export function stripDsmlToolCalls(raw: string): string {
    return extractDsmlToolCalls(raw).text;
}
