import { loadAllCustomApps } from "./builtin-apps/registry";
import type { CustomAppChatDirective, CustomAppChatPlusAction, InstalledCustomApp } from "./custom-app-types";

export type RegisteredCustomAppChatDirective = CustomAppChatDirective & {
  appId: string;
  appName: string;
};

export type RegisteredCustomAppChatPlusAction = CustomAppChatPlusAction & {
  appId: string;
  appName: string;
  appIconDataUrl?: string;
};

const BUILTIN_DIRECTIVE_LABELS = new Set([
  "红包",
  "转账",
  "代付请求",
  "礼物",
  "照片",
  "位置",
  "表情包",
  "语音条",
  "音乐",
  "音乐分享",
  "引用",
  "领取红包",
  "拒收红包",
  "领取转账",
  "拒收转账",
  "接受代付",
  "拒绝代付",
]);

function cleanText(value: unknown, maxLength: number): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, maxLength);
}

function cleanDirectiveLabel(value: unknown): string {
  return cleanText(value, 24).replace(/[\[\]：:\n\r]/g, "");
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatSyntax(label: string, syntax?: string): string {
  const text = cleanText(syntax, 160);
  if (text.startsWith("[") && text.endsWith("]")) return text;
  return `[${label}:内容]`;
}

export function getCustomAppDirectiveSyntaxHead(syntax: string | undefined): string {
  const text = cleanText(syntax, 160);
  const body = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return cleanDirectiveLabel(body.split(/[：:]/)[0] || "");
}

function normalizeDirective(app: InstalledCustomApp, directive: CustomAppChatDirective): RegisteredCustomAppChatDirective | null {
  const label = cleanDirectiveLabel(directive.label);
  if (!label || BUILTIN_DIRECTIVE_LABELS.has(label)) return null;
  const syntax = formatSyntax(label, directive.syntax);
  const syntaxHead = getCustomAppDirectiveSyntaxHead(syntax);
  if (!syntaxHead || BUILTIN_DIRECTIVE_LABELS.has(syntaxHead)) return null;
  const id = cleanText(directive.id || label, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) return null;
  return {
    id,
    label,
    syntax,
    description: cleanText(directive.description, 500) || undefined,
    card: plainRecord(directive.card ?? directive.layout),
    title: cleanText(directive.title, 80) || undefined,
    appLabel: cleanText(directive.appLabel, 60) || undefined,
    status: cleanText(directive.status, 40) || undefined,
    tone: cleanText(directive.tone, 40) || undefined,
    accentColor: cleanText(directive.accentColor, 40) || undefined,
    sceneId: cleanText(directive.sceneId, 80) || undefined,
    sceneTag: cleanText(directive.sceneTag, 120) || undefined,
    tags: Array.isArray(directive.tags)
      ? directive.tags.map(tag => cleanText(tag, 120)).filter(Boolean).slice(0, 30)
      : undefined,
    actions: Array.isArray(directive.actions)
      ? directive.actions.map(action => ({
        label: cleanText(action.label, 40),
        style: cleanText(action.style, 30),
      })).filter(action => action.label).slice(0, 3)
      : undefined,
    appId: app.id,
    appName: app.name,
  };
}

function normalizePlusAction(app: InstalledCustomApp, action: CustomAppChatPlusAction): RegisteredCustomAppChatPlusAction | null {
  const label = cleanDirectiveLabel(action.label);
  if (!label || BUILTIN_DIRECTIVE_LABELS.has(label)) return null;
  const id = cleanText(action.id || label, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!id) return null;
  const presentation = action.presentation === "modal"
    || action.presentation === "fullscreen"
    || action.presentation === "app"
    || action.presentation === "none"
    || action.presentation === "panel"
    ? action.presentation
    : undefined;
  return {
    id,
    label,
    description: cleanText(action.description, 240) || undefined,
    icon: cleanText(action.icon, 80) || undefined,
    entry: cleanText(action.entry, 80) || undefined,
    presentation,
    panelHeight: cleanText(action.panelHeight, 40) || undefined,
    data: action.data && typeof action.data === "object" && !Array.isArray(action.data)
      ? action.data
      : undefined,
    directiveId: cleanText(action.directiveId, 80) || undefined,
    sceneId: cleanText(action.sceneId, 80) || undefined,
    sceneTag: cleanText(action.sceneTag, 120) || undefined,
    tags: Array.isArray(action.tags)
      ? action.tags.map(tag => cleanText(tag, 120)).filter(Boolean).slice(0, 30)
      : undefined,
    appId: app.id,
    appName: app.name,
    appIconDataUrl: app.iconDataUrl,
  };
}

export function loadCustomAppChatDirectives(): RegisteredCustomAppChatDirective[] {
  const installed = loadAllCustomApps();
  const result: RegisteredCustomAppChatDirective[] = [];
  const seen = new Set<string>();
  for (const app of installed) {
    const canonical = app.manifest.extensions?.chat?.directives ?? [];
    const legacy = [
      ...(app.manifest.chatDirectives ?? []),
      ...(app.manifest.chatExtensions?.directives ?? []),
    ];
    const directives = canonical.length > 0 ? canonical : legacy;
    for (const directive of directives) {
      const normalized = normalizeDirective(app, directive);
      if (!normalized) continue;
      const key = getCustomAppDirectiveSyntaxHead(normalized.syntax);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function loadCustomAppChatPlusActions(): RegisteredCustomAppChatPlusAction[] {
  const installed = loadAllCustomApps();
  const result: RegisteredCustomAppChatPlusAction[] = [];
  const seen = new Set<string>();
  for (const app of installed) {
    const canonical = app.manifest.extensions?.chat?.plusActions ?? [];
    const legacy = [
      ...(app.manifest.chatPlusActions ?? []),
      ...(app.manifest.chatExtensions?.plusActions ?? []),
    ];
    const actions = canonical.length > 0 ? canonical : legacy;
    for (const action of actions) {
      const normalized = normalizePlusAction(app, action);
      if (!normalized) continue;
      const key = `${normalized.appId}:${normalized.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function findCustomAppChatDirective(label: string): RegisteredCustomAppChatDirective | null {
  const normalized = cleanDirectiveLabel(label);
  if (!normalized) return null;
  return loadCustomAppChatDirectives().find(item => getCustomAppDirectiveSyntaxHead(item.syntax) === normalized) ?? null;
}

export function formatCustomAppChatDirectivesForPrompt(options: { group?: boolean } = {}): string {
  const directives = loadCustomAppChatDirectives();
  if (directives.length === 0) return "";
  const lines: string[] = [];
  for (const directive of directives) {
    lines.push("");
    lines.push(`### ${directive.label}`);
    const syntax = directive.syntax || `[${directive.label}:内容]`;
    lines.push(`【格式】${options.group ? `[角色名]: ${syntax}` : syntax}`);
    const description = directive.description || `触发「${directive.appName}」提供的${directive.label}功能。`;
    lines.push(`【规则】${description}`);
  }
  return lines.join("\n");
}

export function splitCustomAppDirectiveArgs(rawArgs: string): string[] {
  const text = cleanText(rawArgs, 1000).replace(/^[：:]/, "");
  if (!text) return [];
  // 时间参数自带冒号（[约专注:13:00:事项:45]）；先保护 HH:MM，
  // 否则会被拆成 ["13","00","事项","45"]，卡片上时间/事项/分钟全部错位。
  const protectedText = text.replace(/(\d{1,2})[:：](\d{1,2})(?!\d)/g, "$1@$2");
  return protectedText
    .split(/[：:]/)
    .map(item => item.trim().replace(/@/g, ":"))
    .filter(Boolean)
    .slice(0, 8);
}

export function formatCustomAppDirectiveSummary(
  directive: RegisteredCustomAppChatDirective,
  args: string[],
): string {
  const head = getCustomAppDirectiveSyntaxHead(directive.syntax);
  const detail = args.join("，");
  return detail ? `[${head}：${detail}]` : `[${head}]`;
}
