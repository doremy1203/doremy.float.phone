import { loadAllCustomApps } from "./builtin-apps/registry";
import type {
  CustomAppChatCardAction,
  CustomAppChatInputTool,
  CustomAppChatMessageAction,
  CustomAppEventSubscription,
  CustomAppExtensionEntry,
  CustomAppPromptProfile,
  CustomAppToolDefinition,
  CustomAppUiExtensions,
  InstalledCustomApp,
} from "./custom-app-types";

export type RegisteredCustomAppExtension<T> = T & {
  appId: string;
  appName: string;
  appIconDataUrl?: string;
};

function withApp<T extends object>(app: InstalledCustomApp, item: T): RegisteredCustomAppExtension<T> {
  return {
    ...item,
    appId: app.id,
    appName: app.name,
    appIconDataUrl: app.iconDataUrl,
  };
}

function dedupeByAppAndId<T extends { appId: string; id?: string; event?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = `${item.appId}:${item.id ?? item.event ?? result.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function customAppIdFromContext(appId?: string): string | null {
  if (!appId?.startsWith("custom_app:")) return null;
  return appId.slice("custom_app:".length).trim() || null;
}

function isSharedCustomAppTool(tool: CustomAppToolDefinition): boolean {
  return tool.visibility === "shared";
}

function canExposeCustomAppTools(app: InstalledCustomApp): boolean {
  return app.permissions.includes("chat.tools" as never);
}

function customAppToolVisibleInContext(
  app: InstalledCustomApp,
  tool: CustomAppToolDefinition,
  appId?: string,
): boolean {
  if (tool.enabled === false || !canExposeCustomAppTools(app)) return false;
  const customAppId = customAppIdFromContext(appId);
  if (customAppId && app.id === customAppId) return true;
  return isSharedCustomAppTool(tool);
}

function loadCustomAppToolDefinitions(app: InstalledCustomApp): CustomAppToolDefinition[] {
  const canonical = app.manifest.extensions?.tools ?? [];
  const legacy = app.manifest.extensions?.chat?.tools ?? app.manifest.chatExtensions?.tools ?? [];
  return canonical.length > 0 ? canonical : legacy;
}

export function loadCustomAppPromptProfiles(): Array<RegisteredCustomAppExtension<CustomAppPromptProfile>> {
  const items = loadAllCustomApps().flatMap(app => {
    const canonical = app.manifest.extensions?.prompt?.profiles ?? [];
    const profiles = canonical.length > 0 ? canonical : app.manifest.promptProfiles ?? [];
    return profiles.map(profile => withApp(app, profile));
  });
  return dedupeByAppAndId(items);
}

export function loadCustomAppEventSubscriptions(): Array<RegisteredCustomAppExtension<CustomAppEventSubscription>> {
  const items = loadAllCustomApps().flatMap(app => {
    const canonical = app.manifest.extensions?.events ?? [];
    const events = canonical.length > 0 ? canonical : app.manifest.events ?? [];
    return events.map(event => withApp(app, event));
  });
  return dedupeByAppAndId(items);
}

export function loadCustomAppChatMessageActions(): Array<RegisteredCustomAppExtension<CustomAppChatMessageAction>> {
  const items = loadAllCustomApps().flatMap(app => (
    app.manifest.extensions?.chat?.messageActions ?? []
  ).map(action => withApp(app, action)));
  return dedupeByAppAndId(items);
}

export function loadCustomAppChatCardActions(): Array<RegisteredCustomAppExtension<CustomAppChatCardAction>> {
  const items = loadAllCustomApps().flatMap(app => (
    app.manifest.extensions?.chat?.cardActions ?? []
  ).map(action => withApp(app, action)));
  return dedupeByAppAndId(items);
}

export function loadCustomAppChatInputTools(): Array<RegisteredCustomAppExtension<CustomAppChatInputTool>> {
  const items = loadAllCustomApps().flatMap(app => (
    app.manifest.extensions?.chat?.inputTools ?? []
  ).map(tool => withApp(app, tool)));
  return dedupeByAppAndId(items);
}

export function loadCustomAppChatTools(): Array<RegisteredCustomAppExtension<CustomAppToolDefinition>> {
  const items = loadAllCustomApps().flatMap(app => (
    canExposeCustomAppTools(app)
      ? loadCustomAppToolDefinitions(app).filter(isSharedCustomAppTool).map(tool => withApp(app, tool))
      : []
  ));
  return dedupeByAppAndId(items);
}

export function loadCustomAppToolsForContext(appId?: string): Array<RegisteredCustomAppExtension<CustomAppToolDefinition>> {
  const items = loadAllCustomApps().flatMap(app => (
    loadCustomAppToolDefinitions(app)
      .filter(tool => customAppToolVisibleInContext(app, tool, appId))
      .map(tool => withApp(app, tool))
  ));
  return dedupeByAppAndId(items);
}

export function loadCustomAppUiExtensions(
  slot: keyof CustomAppUiExtensions,
): Array<RegisteredCustomAppExtension<CustomAppExtensionEntry>> {
  const items = loadAllCustomApps().flatMap(app => (
    app.manifest.extensions?.ui?.[slot] ?? []
  ).map(entry => withApp(app, entry)));
  return dedupeByAppAndId(items);
}
