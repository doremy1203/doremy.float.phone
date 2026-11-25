import { loadAllCustomApps } from "./builtin-apps/registry";
import { loadCustomAppToolsForContext, type RegisteredCustomAppExtension } from "./custom-app-sdk-registry";
import type { CustomAppToolDefinition, InstalledCustomApp } from "./custom-app-types";
import { toolNameMatches, type ToolNameMacroContext } from "./tool-storage";
import type { CustomAppHostAction } from "./custom-app-host-api";
import type { ToolCall, ToolExecutionContext, ToolResult } from "./tool-executor";

export type CustomAppToolExecutorPayload = {
  app: InstalledCustomApp;
  tool: RegisteredCustomAppExtension<CustomAppToolDefinition>;
  args: Record<string, unknown>;
  context?: ToolExecutionContext;
};

export type CustomAppToolExecutor = (payload: CustomAppToolExecutorPayload) => Promise<unknown>;

const customAppToolExecutors = new Map<string, CustomAppToolExecutor>();
let customAppBackgroundToolExecutor: CustomAppToolExecutor | null = null;

function stringifyToolData(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeToolResult(toolName: string, raw: unknown): ToolResult {
  if (typeof raw === "string") {
    return { name: toolName, success: true, data: raw, userNotice: `✓ ${toolName} 执行成功` };
  }
  const record = asRecord(raw);
  const success = record.success === false || record.ok === false ? false : true;
  const data = stringifyToolData(record.data ?? record.result ?? record.text ?? record.message);
  const error = stringifyToolData(record.error);
  return {
    name: String(record.name ?? toolName),
    success,
    data: success ? data : undefined,
    error: success ? undefined : error || "自定义 APP 工具执行失败。",
    userNotice: stringifyToolData(record.userNotice ?? record.notice),
    continueConversation: typeof record.continueConversation === "boolean" ? record.continueConversation : undefined,
    persistToHistory: typeof record.persistToHistory === "boolean" ? record.persistToHistory : undefined,
    pendingApproval: record.pendingApproval === true ? true : undefined,
  };
}

function valueAtPath(root: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[part];
  }, root);
}

function expandTemplate(
  text: string,
  app: InstalledCustomApp,
  tool: CustomAppToolDefinition,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): string {
  const scope: Record<string, unknown> = {
    app: { id: app.id, name: app.name },
    tool: { id: tool.id, name: tool.name },
    args,
    context: context ?? {},
  };
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, path: string) => {
    const value = valueAtPath(scope, path);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return stringifyToolData(value) ?? "";
    return String(value);
  });
}

function expandActionValue(
  value: unknown,
  app: InstalledCustomApp,
  tool: CustomAppToolDefinition,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): unknown {
  if (typeof value === "string") return expandTemplate(value, app, tool, args, context);
  if (Array.isArray(value)) return value.map(item => expandActionValue(item, app, tool, args, context));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    expandActionValue(item, app, tool, args, context),
  ]));
}

async function executeManifestToolActions(
  app: InstalledCustomApp,
  tool: RegisteredCustomAppExtension<CustomAppToolDefinition>,
  args: Record<string, unknown>,
  context?: ToolExecutionContext,
): Promise<ToolResult | null> {
  if (!tool.actions?.length) return null;
  const { executeCustomAppHostAction } = await import("./custom-app-host-api");
  const results: unknown[] = [];
  for (const action of tool.actions) {
    const expanded = expandActionValue(action, app, tool, args, context);
    const actionRecord = asRecord(expanded);
    if (!actionRecord.type) {
      throw new Error(`自定义 APP 工具「${tool.name}」的 actions 缺少 type。`);
    }
    results.push(await executeCustomAppHostAction(app, actionRecord as CustomAppHostAction));
  }
  return {
    name: tool.name,
    success: true,
    data: stringifyToolData(results),
    userNotice: `✓ ${tool.name} 执行成功`,
  };
}

function findCustomAppToolForCall(
  name: string,
  appId?: string,
  macroContext?: ToolNameMacroContext,
): { app: InstalledCustomApp; tool: RegisteredCustomAppExtension<CustomAppToolDefinition> } | null {
  const apps = loadAllCustomApps();
  for (const tool of loadCustomAppToolsForContext(appId)) {
    if (!toolNameMatches(tool.name, name, macroContext)) continue;
    const app = apps.find(item => item.id === tool.appId);
    if (!app) continue;
    return { app, tool };
  }
  return null;
}

export function registerCustomAppToolExecutor(appId: string, executor: CustomAppToolExecutor): () => void {
  customAppToolExecutors.set(appId, executor);
  return () => {
    if (customAppToolExecutors.get(appId) === executor) {
      customAppToolExecutors.delete(appId);
    }
  };
}

export function registerCustomAppBackgroundToolExecutor(executor: CustomAppToolExecutor): () => void {
  customAppBackgroundToolExecutor = executor;
  return () => {
    if (customAppBackgroundToolExecutor === executor) {
      customAppBackgroundToolExecutor = null;
    }
  };
}

function shouldRunRuntimeToolHandler(tool: CustomAppToolDefinition): boolean {
  if (tool.handler || tool.entry) return true;
  return !tool.actions?.length && !tool.resultTemplate;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRuntimeHandlerMissing(message: string): boolean {
  return /tool handler not found|handler not registered|handler.*未注册|未注册.*handler/i.test(message);
}

export async function executeCustomAppToolCall(
  call: ToolCall,
  context?: ToolExecutionContext,
  macroContext?: ToolNameMacroContext,
): Promise<ToolResult | null> {
  const found = findCustomAppToolForCall(call.name, context?.appId ?? "chat", macroContext);
  if (!found) return null;
  const { app, tool } = found;
  const executor = customAppToolExecutors.get(app.id);
  let backgroundError = "";
  try {
    if (executor) {
      try {
        const raw = await executor({ app, tool, args: call.args, context });
        return normalizeToolResult(tool.name, raw);
      } catch (err) {
        const message = errorMessage(err);
        if (!isRuntimeHandlerMissing(message)) {
          return {
            name: tool.name,
            success: false,
            error: message,
            userNotice: `✗ ${tool.name}: APP handler 执行失败。`,
          };
        }
        backgroundError = message;
      }
    }
    if (customAppBackgroundToolExecutor && shouldRunRuntimeToolHandler(tool)) {
      try {
        const raw = await customAppBackgroundToolExecutor({ app, tool, args: call.args, context });
        return normalizeToolResult(tool.name, raw);
      } catch (err) {
        backgroundError = errorMessage(err);
      }
    }
    const actionResult = await executeManifestToolActions(app, tool, call.args, context);
    if (actionResult) return actionResult;
    if (tool.resultTemplate) {
      return {
        name: tool.name,
        success: true,
        data: expandTemplate(tool.resultTemplate, app, tool, call.args, context),
        userNotice: `✓ ${tool.name} 执行成功`,
      };
    }
    return {
      name: tool.name,
      success: false,
      error: backgroundError
        ? `自定义 APP「${app.name}」的「${tool.name}」后台 handler 执行失败：${backgroundError}`
        : `自定义 APP「${app.name}」尚未打开或没有为「${tool.name}」注册 handler。`,
      userNotice: `✗ ${tool.name}: ${backgroundError && !isRuntimeHandlerMissing(backgroundError) ? "APP handler 执行失败" : "APP handler 未注册"}。`,
    };
  } catch (err) {
    return {
      name: tool.name,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
