import { DOCK_DEFAULT, ICONS, PAGE_1_DEFAULT, PAGE_2_DEFAULT, PAGE_3_DEFAULT, type DesktopIconId, type IconId, type IconPosition } from "@/lib/desktop-config";
import { isCustomAppIconId } from "@/lib/custom-app-types";
import { loadInstalledCustomApps } from "@/lib/custom-app-storage";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZE_CELLS, type WidgetInstance, type WidgetSize } from "@/lib/widget-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const ICON_LAYOUT_STORAGE_KEY = "ai_phone_icon_layout_v2";
export const ICON_LAYOUT_STORAGE_KEY_V1 = "ai_phone_icon_layout_v1";
export const DOCK_LAYOUT_STORAGE_KEY = "ai_phone_dock_layout_v1";
export const DESKTOP_FOLDERS_STORAGE_KEY = "ai_phone_desktop_folders_v1";

/** Max icons the dock can hold. Dragging a page icon in is rejected once full. */
export const DOCK_MAX = 4;

registerKvMigration(ICON_LAYOUT_STORAGE_KEY);
registerKvMigration(ICON_LAYOUT_STORAGE_KEY_V1);
registerKvMigration(DOCK_LAYOUT_STORAGE_KEY);
registerKvMigration(DESKTOP_FOLDERS_STORAGE_KEY);

export type DesktopPageKey = `page${number}`;

export type DesktopIconLayout = Record<DesktopPageKey, IconPosition[]> & {
  page1: IconPosition[];
  page2: IconPosition[];
};

export function getDesktopPageKey(pageNumber: number): DesktopPageKey {
  const safePage = Math.max(1, Math.floor(pageNumber));
  return `page${safePage}` as DesktopPageKey;
}

export function getDesktopPageNumber(pageKey: string): number {
  const match = pageKey.match(/^page([1-9]\d*)$/);
  return match ? Number(match[1]) : 0;
}

export function getDesktopPageKeys(layout: Partial<Record<string, unknown>>): DesktopPageKey[] {
  const maxPage = Math.max(
    2,
    ...Object.keys(layout)
      .map(getDesktopPageNumber)
      .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1)
  );
  return Array.from({ length: maxPage }, (_, index) => getDesktopPageKey(index + 1));
}

export function getDesktopIconLayoutItems(layout: DesktopIconLayout): IconPosition[] {
  return getDesktopPageKeys(layout).flatMap((pageKey) => layout[pageKey] ?? []);
}

function getInstalledCustomIconIds(): Set<string> {
  return new Set(loadInstalledCustomApps().map(app => `custom_app:${app.id}`));
}

function migrateLegacyDesktopIconId(id: string, customIconIds = getInstalledCustomIconIds()): DesktopIconId | null {
  if (id === "forum") return "cocreate";
  if (id === "fortune") return "interview_magazine";
  if (isCustomAppIconId(id) && customIconIds.has(id)) return id;
  return id in ICONS ? id as IconId : null;
}

function buildWidgetOccupancy(widgets: WidgetInstance[], page: number): boolean[][] {
  const grid: boolean[][] = Array.from({ length: GRID_ROWS }, () =>
    Array.from({ length: GRID_COLS }, () => false)
  );

  for (const widget of widgets) {
    if (widget.page !== page) continue;
    const [rows, cols] = WIDGET_SIZE_CELLS[widget.size];
    for (let rowOffset = 0; rowOffset < rows; rowOffset++) {
      for (let colOffset = 0; colOffset < cols; colOffset++) {
        const row = widget.row - 1 + rowOffset;
        const col = widget.col - 1 + colOffset;
        if (row >= 0 && row < GRID_ROWS && col >= 0 && col < GRID_COLS) {
          grid[row][col] = true;
        }
      }
    }
  }

  return grid;
}

function flowIconsToPositions(icons: DesktopIconId[], occupied?: boolean[][]): IconPosition[] {
  const result: IconPosition[] = [];
  let index = 0;
  for (let row = 0; row < GRID_ROWS && index < icons.length; row++) {
    for (let col = 0; col < GRID_COLS && index < icons.length; col++) {
      if (occupied?.[row]?.[col]) {
        continue;
      }
      result.push({ id: icons[index], row: row + 1, col: col + 1 });
      index++;
    }
  }
  return result;
}

export function createDefaultDesktopIconLayout(_widgets: WidgetInstance[] = []): DesktopIconLayout {
  return {
    page1: PAGE_1_DEFAULT.map((id, i) => ({
      id,
      row: 5 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
    // 第二页：第 4 行留给 iOS 操作菜单组件，图标从第 5 行开始
    page2: PAGE_2_DEFAULT.map((id, i) => ({
      id,
      row: 5 + Math.floor(i / GRID_COLS),
      col: (i % GRID_COLS) + 1,
    })),
    // 第三页：右半边 2×2（第 4~5 行、第 3~4 列），左半边留给日历组件
    page3: PAGE_3_DEFAULT.map((id, i) => ({
      id,
      row: 4 + Math.floor(i / 2),
      col: 3 + (i % 2),
    })),
  } as DesktopIconLayout;
}

function normalizePage(raw: unknown, folderIds?: Set<string>): IconPosition[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seenIds = new Set<DesktopIconId>();
  const seenCells = new Set<string>();
  const result: IconPosition[] = [];

  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const { id, row, col } = item as { id?: unknown; row?: unknown; col?: unknown };
    if (typeof id !== "string" || typeof row !== "number" || typeof col !== "number") {
      continue;
    }
    // 文件夹 tile：随附文件夹表的调用方（主题包导出/导入）显式放行，
    // 否则照旧丢弃——没有成员表的 folder tile 是空壳
    const migratedId = folderIds?.has(id) ? (id as DesktopIconId) : migrateLegacyDesktopIconId(id, customIconIds);
    if (
      !migratedId
      || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId) && !folderIds?.has(migratedId))
      || row < 1
      || row > GRID_ROWS
      || col < 1
      || col > GRID_COLS
    ) {
      continue;
    }

    const iconId = migratedId;
    const cellKey = `${row},${col}`;
    if (seenIds.has(iconId) || seenCells.has(cellKey)) {
      continue;
    }

    seenIds.add(iconId);
    seenCells.add(cellKey);
    result.push({ id: iconId, row, col });
  }

  return result;
}

export function normalizeDesktopIconLayout(raw: unknown, folderIds?: Set<string>): DesktopIconLayout {
  if (!raw || typeof raw !== "object") {
    return createDefaultDesktopIconLayout();
  }

  const candidate = raw as Record<string, unknown>;
  const normalized = {} as DesktopIconLayout;
  for (const pageKey of getDesktopPageKeys(candidate)) {
    normalized[pageKey] = normalizePage(candidate[pageKey], folderIds);
  }
  return normalized;
}

export function writeDesktopIconLayout(layout: DesktopIconLayout, folderIds?: Set<string>): DesktopIconLayout {
  const normalized = normalizeDesktopIconLayout(layout, folderIds);
  kvSet(ICON_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

/**
 * 把已安装但没出现在布局或 dock 里的自定义 app 图标补回桌面空位。
 * 恢复默认外观、导入主题包时图标布局会被整体覆盖，若不补回，
 * 已安装的自定义 app 会从桌面上消失（app 本体仍在，只是没有图标可点）。
 */
export function appendMissingCustomAppIcons(
  layout: DesktopIconLayout,
  widgets: WidgetInstance[] = [],
  dock: DesktopIconId[] = []
): DesktopIconLayout {
  const present = new Set<string>(dock);
  for (const icon of getDesktopIconLayoutItems(layout)) {
    present.add(icon.id);
  }
  const missing = Array.from(getInstalledCustomIconIds()).filter((id) => !present.has(id)) as DesktopIconId[];
  if (missing.length === 0) {
    return layout;
  }

  const next = { ...layout } as DesktopIconLayout;
  let index = 0;
  // 页面满（含组件占位）就顺延到下一页；上限只是防御性兜底，不会实际触达。
  for (let page = 1; index < missing.length && page <= 50; page++) {
    const pageKey = getDesktopPageKey(page);
    const icons = next[pageKey] ?? [];
    const occupied = buildWidgetOccupancy(widgets, page);
    for (const icon of icons) {
      if (icon.row >= 1 && icon.row <= GRID_ROWS && icon.col >= 1 && icon.col <= GRID_COLS) {
        occupied[icon.row - 1][icon.col - 1] = true;
      }
    }
    const placed: IconPosition[] = [];
    for (let row = 0; row < GRID_ROWS && index < missing.length; row++) {
      for (let col = 0; col < GRID_COLS && index < missing.length; col++) {
        if (occupied[row][col]) {
          continue;
        }
        placed.push({ id: missing[index], row: row + 1, col: col + 1 });
        index++;
      }
    }
    if (placed.length > 0) {
      next[pageKey] = [...icons, ...placed];
    }
  }
  return next;
}

// ── Desktop folders ───────────────────────────────────
// 文件夹内容表：folder:xxx → { name, icons }。tile 本身作为普通图标
// 存在分页布局里；这张表只管"里面装了什么、叫什么"。

export type DesktopFolder = { name: string; icons: DesktopIconId[] };
export type DesktopFolderMap = Record<string, DesktopFolder>;

/** 校验并去重文件夹表：只保留已知/已安装的成员图标（文件夹不可嵌套） */
export function normalizeDesktopFolders(raw: unknown): DesktopFolderMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seen = new Set<string>();
  const result: DesktopFolderMap = {};
  for (const [folderId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!folderId.startsWith("folder:") || !value || typeof value !== "object") continue;
    const { name, icons } = value as { name?: unknown; icons?: unknown };
    if (!Array.isArray(icons)) continue;
    const members: DesktopIconId[] = [];
    for (const item of icons) {
      if (typeof item !== "string" || item.startsWith("folder:")) continue;
      const migratedId = migrateLegacyDesktopIconId(item, customIconIds);
      if (!migratedId || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId))) continue;
      if (seen.has(migratedId) || members.includes(migratedId)) continue;
      seen.add(migratedId);
      members.push(migratedId);
    }
    result[folderId] = {
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 24) : "文件夹",
      icons: members,
    };
  }
  return result;
}

export function loadDesktopFolders(): DesktopFolderMap {
  const raw = kvGet(DESKTOP_FOLDERS_STORAGE_KEY);
  if (raw == null) return {};
  try {
    return normalizeDesktopFolders(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function writeDesktopFolders(folders: DesktopFolderMap): void {
  kvSet(DESKTOP_FOLDERS_STORAGE_KEY, JSON.stringify(folders));
}

// ── Dock layout ───────────────────────────────────────
// The dock is an ordered list of icon ids (max DOCK_MAX). It is stored
// separately from the paged icon layout, and the two are kept disjoint:
// an icon lives either on a page or in the dock, never both.

/** Keep only known/installed icons, dedup, cap at DOCK_MAX. */
export function normalizeDock(raw: unknown): DesktopIconId[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const knownIcons = new Set<string>(Object.keys(ICONS));
  const customIconIds = getInstalledCustomIconIds();
  const seen = new Set<DesktopIconId>();
  const result: DesktopIconId[] = [];

  for (const item of raw) {
    if (typeof item !== "string") {
      continue;
    }
    const migratedId = migrateLegacyDesktopIconId(item, customIconIds);
    if (
      !migratedId
      || (!knownIcons.has(migratedId) && !customIconIds.has(migratedId))
      || seen.has(migratedId)
    ) {
      continue;
    }
    seen.add(migratedId);
    result.push(migratedId);
    if (result.length >= DOCK_MAX) {
      break;
    }
  }

  return result;
}

/** Read the persisted dock, seeding DOCK_DEFAULT when nothing was ever stored. */
export function loadDockLayout(): DesktopIconId[] {
  const raw = kvGet(DOCK_LAYOUT_STORAGE_KEY);
  if (raw == null) {
    return normalizeDock(DOCK_DEFAULT);
  }
  try {
    return normalizeDock(JSON.parse(raw));
  } catch {
    return normalizeDock(DOCK_DEFAULT);
  }
}

export function writeDockLayout(dock: DesktopIconId[]): DesktopIconId[] {
  const normalized = normalizeDock(dock);
  kvSet(DOCK_LAYOUT_STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

// ── Desktop view mode ─────────────────────────────────
// 主屏的两种形态，只影响"怎么摆"，不影响图标布局 / 组件位置 / 主题：
//   paged  = 原来的多页翻页桌面（保持原样，一行都不改）
//   single = 单页桌面：上半是「常用」（沿用第一页的图标），
//            全部应用收在右下角「应用目录」按钮后，点开是一整页全屏清单。
// 两者随时互相切换，切换只写这一个键。入口在「主题 App → 桌面形态」。

export const DESKTOP_VIEW_MODE_STORAGE_KEY = "ai_phone_desktop_view_mode_v1";

export type DesktopViewMode = "paged" | "single";

registerKvMigration(DESKTOP_VIEW_MODE_STORAGE_KEY);

export function loadDesktopViewMode(): DesktopViewMode {
  const raw = kvGet(DESKTOP_VIEW_MODE_STORAGE_KEY);
  if (!raw) return "paged";
  try {
    return JSON.parse(raw) === "single" ? "single" : "paged";
  } catch {
    return raw === "single" ? "single" : "paged";
  }
}

export function writeDesktopViewMode(mode: DesktopViewMode): void {
  kvSet(DESKTOP_VIEW_MODE_STORAGE_KEY, JSON.stringify(mode === "single" ? "single" : "paged"));
}

// ── Single-page desktop content ───────────────────────
// 单页桌面的内容与多页布局**解耦**，各自独立：
//   favorites = 单页「常用」的图标清单（装新应用不会自动挤进来，由用户在
//               「主题 → 桌面形态」里勾选）
//   widgets   = 单页顶部展示的组件类型清单
// 两者都不影响多页桌面的图标位置与组件摆位。

export const SINGLE_FAVORITES_STORAGE_KEY = "ai_phone_single_favorites_v1";
export const SINGLE_WIDGETS_STORAGE_KEY = "ai_phone_single_widgets_v1";

registerKvMigration(SINGLE_FAVORITES_STORAGE_KEY);
registerKvMigration(SINGLE_WIDGETS_STORAGE_KEY);

/** 读取单页「常用」清单；从未设置过时返回 null（调用方自行决定默认值）。 */
export function loadSingleFavorites(): DesktopIconId[] | null {
  const raw = kvGet(SINGLE_FAVORITES_STORAGE_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const known = new Set<string>(Object.keys(ICONS));
    const customIconIds = getInstalledCustomIconIds();
    const seen = new Set<DesktopIconId>();
    const result: DesktopIconId[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      if (item.startsWith("folder:")) continue; // 文件夹不进常用
      const migrated = migrateLegacyDesktopIconId(item, customIconIds);
      if (!migrated || seen.has(migrated)) continue;
      if (!known.has(migrated) && !customIconIds.has(migrated)) continue;
      seen.add(migrated);
      result.push(migrated);
    }
    return result;
  } catch {
    return null;
  }
}

export function writeSingleFavorites(ids: DesktopIconId[]): void {
  kvSet(SINGLE_FAVORITES_STORAGE_KEY, JSON.stringify(ids));
}

/** 读取单页组件清单；从未设置过时返回 null（调用方自行决定默认值）。 */
export function loadSingleWidgets(): string[] | null {
  const raw = kvGet(SINGLE_WIDGETS_STORAGE_KEY);
  if (raw == null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return null;
  }
}

export function writeSingleWidgets(types: string[]): void {
  kvSet(SINGLE_WIDGETS_STORAGE_KEY, JSON.stringify(types));
}

// 单页组件的尺寸覆盖与「是否显示组件名」开关。
// 尺寸用「类型 → 尺寸」的映射单独存，不动上面那份字符串清单——
// 这样已经存过的清单不用迁移，缺尺寸的项回落到该组件的推荐尺寸。

export const SINGLE_WIDGET_SIZES_STORAGE_KEY = "ai_phone_single_widget_sizes_v1";
export const SINGLE_WIDGET_LABELS_STORAGE_KEY = "ai_phone_single_widget_labels_v1";

registerKvMigration(SINGLE_WIDGET_SIZES_STORAGE_KEY);
registerKvMigration(SINGLE_WIDGET_LABELS_STORAGE_KEY);

export function loadSingleWidgetSizes(): Record<string, WidgetSize> {
  const raw = kvGet(SINGLE_WIDGET_SIZES_STORAGE_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const valid = new Set(Object.keys(WIDGET_SIZE_CELLS));
    const result: Record<string, WidgetSize> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string" || !valid.has(value)) continue;
      result[key] = value as WidgetSize;
    }
    return result;
  } catch {
    return {};
  }
}

export function writeSingleWidgetSizes(sizes: Record<string, WidgetSize>): void {
  kvSet(SINGLE_WIDGET_SIZES_STORAGE_KEY, JSON.stringify(sizes));
}

/** 单页组件下面那行名称是否显示。默认显示（保持与多页一致，不做意外改动）。 */
export function loadSingleWidgetLabelsVisible(): boolean {
  const raw = kvGet(SINGLE_WIDGET_LABELS_STORAGE_KEY);
  if (raw == null) return true;
  try {
    return JSON.parse(raw) !== false;
  } catch {
    return raw !== "false";
  }
}

export function writeSingleWidgetLabelsVisible(visible: boolean): void {
  kvSet(SINGLE_WIDGET_LABELS_STORAGE_KEY, JSON.stringify(visible));
}
