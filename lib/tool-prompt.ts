import type { EnabledTool } from "./tool-storage";
import { MacroEngine, postProcessTrim } from "./macro-engine";

export type ToolSchemaFormatContext = {
    characterName?: string;
    userName?: string;
};

function expandToolMacros(text: string, context?: ToolSchemaFormatContext): string {
    if (!context) return text;
    const engine = new MacroEngine(context.characterName ?? "", context.userName ?? "用户");
    return postProcessTrim(engine.expand(text));
}

/**
 * Format enabled tools as compact list (name + description only, no params).
 * Returns empty string if no tools (TRIM removes the line).
 */
export function formatToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "以下是当前可用的动作类别。用户请求涉及真实数据查询、应用功能执行、保存/修改数据或其他工具能实际完成的任务时，应主动选择并执行匹配动作；纯闲聊、创作或无需外部数据的常识解释则直接回答，不要机械调用工具：",
        "角色主动性补充：当当前回合有明确的待办、承诺、邀约、日程变化、用户此前表达过的需求或需要核实的现实状态时，不要只口头表示‘我会处理’；检查当前可用动作，选择最小且匹配的工具完成下一步，并依据真实结果继续。若只是角色自主聊天且没有真实操作必要，不要为了显得主动而乱调用工具。",
        "工具可用性以本轮实际提供的动作列表为准；没有暴露、被禁用或执行失败的动作不得假装可用。需要用户授权、确认或会产生外部影响的操作必须遵守对应权限，不得擅自替用户做不可逆决定。完成一项动作后检查返回结果，必要时继续完成同一目标的下一步，但要避免重复执行已经成功的动作。",
        "现实感知与行动反馈：当情境确实需要确认用户此刻的现实状态时，若本轮提供了现实桥/感知工具，主动先查询相关且已授权的信息；不要只凭猜测断言用户正在做什么。只有当动作与当前情境明确相关、动作已启用且权限允许时，才自主执行最小必要的设备操作。执行后必须在后续自然语言回复中明确告诉用户【做了什么、为什么此刻这么做、实际结果如何】；不能只发动作指令或只做不说，也不能把失败说成成功。若没有真实必要就不要为了表现主动而调用设备。高影响或不可逆操作必须先取得明确确认。",
        "现实感知与行动反馈：当情境确实需要确认用户此刻的现实状态时，若本轮提供了现实桥/感知工具，主动先查询相关且已授权的信息；不要只凭猜测断言用户正在做什么。只有当动作与当前情境明确相关、动作已启用且权限允许时，才自主执行最小必要的设备操作。执行后必须在后续自然语言回复中明确告诉用户【做了什么、为什么此刻这么做、实际结果如何】；不能只发动作指令或只做不说，也不能把失败说成成功。若没有真实必要就不要为了表现主动而调用设备。高影响或不可逆操作必须先取得明确确认。",
        "",
        toolList,
        "",
        "使用步骤：",
        "1. 判断用户任务是否需要真实查询或执行；需要时，主动选择最匹配的动作类别，并用 [获取指令:动作类别名] 获取参数格式。不要因用户没有明确说‘调用工具’而跳过实际操作。",
        "2. 获取指令后，立即按 [执行动作:动作名(参数JSON)] 执行；如果上下文中已有该动作的说明，不要重复获取，直接执行。必须依据执行结果回答，失败不得伪称成功，也不得把失败说成无数据。",
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format enabled tools for GROUP CHAT — includes actor name prefix in format.
 */
export function formatGroupToolsForPrompt(tools: EnabledTool[]): string {
    if (tools.length === 0) return "";

    const toolList = tools.map(t => `${t.name}: ${t.description}`).join("\n");

    return [
        "<available_actions>",
        "以下是当前可用的动作类别。用户请求涉及真实数据查询、应用功能执行、保存/修改数据或其他工具能实际完成的任务时，应主动选择并执行匹配动作；纯闲聊、创作或无需外部数据的常识解释则直接回答，不要机械调用工具：",
        "角色主动性补充：当当前回合有明确的待办、承诺、邀约、日程变化、用户此前表达过的需求或需要核实的现实状态时，不要只口头表示‘我会处理’；检查当前可用动作，选择最小且匹配的工具完成下一步，并依据真实结果继续。若只是角色自主聊天且没有真实操作必要，不要为了显得主动而乱调用工具。",
        "工具可用性以本轮实际提供的动作列表为准；没有暴露、被禁用或执行失败的动作不得假装可用。需要用户授权、确认或会产生外部影响的操作必须遵守对应权限，不得擅自替用户做不可逆决定。完成一项动作后检查返回结果，必要时继续完成同一目标的下一步，但要避免重复执行已经成功的动作。",
        "",
        toolList,
        "",
        "使用步骤：",
        '1. 需要系统处理某个动作类别时，先用 ["角色名"获取指令:动作类别名] 获取可执行动作格式。',
        '2. 获取指令后，用 ["角色名"执行动作:动作名(参数JSON)] 输出动作指令；必须用引号标注是哪个角色在执行动作，同一次回复中只能有一个角色执行动作。不要编造动作，不需要动作时正常聊天即可。*如果上下文中已经获取过某个指令，则不要重复获取，需要时，直接执行前面获取过的指令即可*',
        "",
        "</available_actions>",
    ].join("\n");
}

/**
 * Format a single action's parameter schema for the "获取指令" response.
 */
export function formatToolSchema(tool: EnabledTool, context?: ToolSchemaFormatContext): string {
    if (tool.usageGuide) return expandToolMacros(tool.usageGuide, context);

    if (tool.source === "rest_package") {
        const lines: string[] = [];
        lines.push(`REST 工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.restTools || tool.restTools.length === 0) {
            lines.push("这个套件里没有已启用的 REST 子工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出套件名称本身。");
        for (const restTool of tool.restTools) {
            lines.push("");
            lines.push(`动作：${restTool.name}`);
            if (restTool.description) lines.push(`描述：${restTool.description}`);
            try {
                const schema = JSON.parse(restTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("参数：");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出 REST 工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "composite_package") {
        const lines: string[] = [];
        lines.push(`组合工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.compositeTools || tool.compositeTools.length === 0) {
            lines.push("这个套件里没有已启用的组合工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体组合工具如下。执行时必须使用具体组合工具名，不要输出套件名称本身。");
        for (const compositeTool of tool.compositeTools) {
            lines.push("");
            lines.push(`动作：${compositeTool.name}`);
            if (compositeTool.description) lines.push(`描述：${compositeTool.description}`);
            try {
                const schema = JSON.parse(compositeTool.parameterSchema);
                const props = schema.properties || {};
                const entries = Object.entries(props);
                if (entries.length > 0) {
                    lines.push("参数：");
                    for (const [key, val] of entries) {
                        const v = val as Record<string, unknown>;
                        const type = (v.type as string) || "string";
                        const desc = (v.description as string) || "";
                        lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                    }
                }
            } catch { /* ignore invalid schema */ }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体组合工具，并使用格式：",
            "[执行动作:具体组合工具名({参数JSON})]",
            "禁止输出组合工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "mcp_server") {
        const lines: string[] = [];
        lines.push(`MCP：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.mcpTools || tool.mcpTools.length === 0) {
            lines.push("这个 MCP 还没有发现到具体动作，请先让用户在设置里点击“发现工具”。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出 MCP 名称本身。");
        for (const mcpTool of tool.mcpTools) {
            lines.push("");
            lines.push(`动作：${mcpTool.name}`);
            if (mcpTool.description) lines.push(`描述：${mcpTool.description}`);
            const schema = mcpTool.inputSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("参数：");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出 MCP 名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    if (tool.source === "custom_app_package") {
        const lines: string[] = [];
        lines.push(`自定义 APP 工具套件：${tool.name}`);
        lines.push(`描述：${tool.description}`);
        if (!tool.customAppTools || tool.customAppTools.length === 0) {
            lines.push("这个 APP 当前没有可执行的子工具。");
            return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}`, context);
        }

        lines.push("可执行的具体动作如下。执行时必须使用具体动作名，不要输出工具套件名称本身。");
        for (const customAppTool of tool.customAppTools) {
            lines.push("");
            lines.push(`动作：${customAppTool.name}`);
            if (customAppTool.description) lines.push(`描述：${customAppTool.description}`);
            const schema = customAppTool.parameterSchema as { properties?: Record<string, Record<string, unknown>> } | undefined;
            const props = schema?.properties || {};
            const entries = Object.entries(props);
            if (entries.length > 0) {
                lines.push("参数：");
                for (const [key, val] of entries) {
                    const type = (val.type as string) || "string";
                    const desc = (val.description as string) || "";
                    lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
                }
            }
        }

        return expandToolMacros([
            "以下是你获取指令的返回结果：",
            lines.join("\n"),
            "请根据用户需求选择一个具体动作，并使用格式：",
            "[执行动作:具体动作名({参数JSON})]",
            "禁止输出工具套件名称本身。执行动作时只输出动作指令，不要附加闲聊内容。",
        ].join("\n"), context);
    }

    const lines: string[] = [];
    lines.push(`动作：${tool.name}`);
    lines.push(`描述：${tool.description}`);

    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const entries = Object.entries(props);
        if (entries.length > 0) {
            lines.push("参数：");
            for (const [key, val] of entries) {
                const v = val as Record<string, unknown>;
                const type = (v.type as string) || "string";
                const desc = (v.description as string) || "";
                lines.push(`  - ${key} (${type})${desc ? ": " + desc : ""}`);
            }
        }
    } catch { /* ignore */ }

    // Build example call with placeholder values
    let exampleArgs = "{}";
    try {
        const schema = JSON.parse(tool.parameterSchema);
        const props = schema.properties || {};
        const example: Record<string, string> = {};
        for (const [key] of Object.entries(props)) {
            example[key] = "...";
        }
        if (Object.keys(example).length > 0) exampleArgs = JSON.stringify(example);
    } catch { /* ignore */ }

    return expandToolMacros(`以下是你获取指令的返回结果：\n${lines.join("\n")}\n请立即使用以下格式输出动作指令（将...替换为实际值）：\n[执行动作:${tool.name}(${exampleArgs})]\n禁止再次使用[获取指令]。不要重复之前说过的内容。!!!执行动作时，直接输出动作指令，禁止输出任何其他内容，包括任何[内心]、状态值、聊天内容、富媒体指令等。忽略chat_output_format里的所有指令，否则系统将出现重大错误`, context);
}
