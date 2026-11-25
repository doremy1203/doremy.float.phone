import { loadInstalledCustomApps } from "../custom-app-storage";
import type { InstalledCustomApp } from "../custom-app-types";
import { buildFocusCompanionApp, FOCUS_COMPANION_APP_ID, FOCUS_COMPANION_MANIFEST } from "./focus-companion-meta";
import { buildHeartcraftApp, HEARTCRAFT_APP_ID, HEARTCRAFT_MANIFEST } from "./heartcraft-meta";

/**
 * 内置应用也要参与「聊天工具箱 / 富媒体指令 / 后台事件」这三张注册表，
 * 否则装成内置版之后，角色就看不到手作工具、也不会从聊天里自动开工。
 *
 * 规则：如果用户自己从应用市场装了同一个 manifest id 的版本，就让市场版接管，
 * 避免同一个 APP 出现两套工具/两条指令。两版共用同一个 app id，数据也是同一份。
 */
/** 旧市场版只作为迁移来源保留，不再接管内置应用的工具和后台事件。 */
export function isHeartcraftInstalled(): boolean {
  return loadInstalledCustomApps().some((app) => app.id === HEARTCRAFT_APP_ID);
}

/** 用户自己从应用市场装了同一个 id 的「角色陪伴专注」时，让市场版接管（数据同源，避免双注册）。 */
export function isFocusCompanionInstalled(): boolean {
  return loadInstalledCustomApps().some((app) => app.id === FOCUS_COMPANION_APP_ID);
}

/** 按 app id 取内置应用（不含 HTML，够做存在性判断/权限判断）。 */
export function getBuiltinCustomApp(appId: string): InstalledCustomApp | null {
  if (appId === HEARTCRAFT_APP_ID) return buildHeartcraftApp("");
  if (appId === FOCUS_COMPANION_APP_ID) return buildFocusCompanionApp("");
  return null;
}

/** 内置版始终优先；旧市场版记录保留在存储中供数据迁移/回滚，但不再注册运行。 */
/** 市场版的记录可能与内置 id 不一致（历史版本/重命名/包内 id 变体），
 *  按 id、manifest.id、manifest.identifier、显示名四路匹配，避免同一个应用出现两份。 */
function isSameBuiltin(app: InstalledCustomApp, id: string, manifest: { id?: string; identifier?: string; name?: string }): boolean {
  const m = app.manifest || ({} as InstalledCustomApp["manifest"]);
  const candidates = [app.id, m.id, (m as unknown as { identifier?: string }).identifier].filter(Boolean);
  if (candidates.some((v) => String(v) === id)) return true;
  /* 市场安装器会给 id 加前缀/后缀：app_<manifestId>_<hash>。按前缀也算同一个应用。 */
  if (candidates.some((v) => {
    const text = String(v);
    return text.indexOf("app_" + id + "_") === 0 || text.replace(/^app_/, "").split("_").slice(0, String(id).split(".").length).join(".") === id;
  })) return true;
  const name = String(m.name || "").trim();
  return Boolean(name) && name === String(manifest.name || "").trim();
}

export function loadAllCustomApps(): InstalledCustomApp[] {
  const installed = loadInstalledCustomApps().filter((app) => (
    !isSameBuiltin(app, HEARTCRAFT_APP_ID, HEARTCRAFT_MANIFEST)
    && !isSameBuiltin(app, FOCUS_COMPANION_APP_ID, FOCUS_COMPANION_MANIFEST)
  ));
  return [buildHeartcraftApp(""), buildFocusCompanionApp(""), ...installed];
}
