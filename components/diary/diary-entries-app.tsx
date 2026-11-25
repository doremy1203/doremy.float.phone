"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { Bot, ChevronLeft, Clock3, Download, Heart, NotebookPen, Pencil, RotateCcw, Search, SlidersHorizontal, Trash2, WandSparkles, X } from "lucide-react";
import { DotsThree } from "@phosphor-icons/react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateDiaryEntryForCharacter } from "@/lib/diary-entry-engine";
import { useDiaryGenerating } from "@/lib/diary-generating-tracker";
import {
  DIARY_ENTRIES_UPDATED_EVENT,
  DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT,
} from "@/lib/diary-entry-timer-service";
import {
  createDiaryEntry,
  deleteDiaryEntry,
  restoreDiaryEntryRevision,
  setDiaryEntryFavorite,
  updateDiaryEntry,
  loadDiaryEntries,
  loadDiaryEntryFontAssetId,
  loadDiaryEntryFontScale,
  loadDiaryEntryTimerSettings,
  saveDiaryEntryFontAssetId,
  saveDiaryEntryFontScale,
  saveDiaryEntryTimerSettings,
} from "@/lib/diary-entry-storage";
import type { DiaryEntry, DiaryEntryBlock, DiaryEntryTimerSettings, DiaryEntryTrigger } from "@/lib/diary-entry-types";
import { getThemeAssetDataUrl, saveThemeAssetFromBlob } from "@/lib/theme-storage";
import { downloadDiaryEntriesZip, downloadDiaryEntry, type DiaryExportFormat } from "@/lib/diary-entry-export";

const DIARY_USER_FONT_FAMILY = "AIPhoneDiaryEntryUserFont";
const DIARY_USER_FONT_STYLE_ID = "ai-phone-diary-entry-user-font-face";

type DiaryEntriesAppProps = {
  onBack: () => void;
  onNotice?: (message: string) => void;
};

type DiaryBook = {
  characterId: string;
  characterName: string;
  avatar: string;
  entries: DiaryEntry[];
};

type DiaryEntryDragState = {
  entry: DiaryEntry;
  x: number;
  y: number;
  width: number;
  height: number;
  isOverTrash: boolean;
};

type DiaryEntryDragSession = {
  entry: DiaryEntry;
  pointerId: number;
  target: HTMLButtonElement;
  startX: number;
  startY: number;
  width: number;
  height: number;
  timer: number | null;
  dragging: boolean;
};

type DiaryEntryDragScrollLock = {
  bodyOverflow: string;
  bodyTouchAction: string;
  htmlOverscrollBehavior: string;
  htmlTouchAction: string;
  main: HTMLElement | null;
  mainOverflow: string;
  mainTouchAction: string;
  mainScrollTop: number;
};

function formatEntryTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || "未知时间";
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function blockPlainText(block: DiaryEntryBlock): string {
  if (block.type === "paragraph" || block.type === "quote") return block.text;
  if (block.type === "correction") return block.replacement || block.text;
  if (block.type === "image") return block.caption || block.description;
  if (block.type === "todo") return block.items.map(item => item.text).join(" / ");
  return "";
}

function getEntryMarkers(entry: DiaryEntry): string[] {
  return Array.from(new Set([
    entry.mood,
    ...entry.tags,
    entry.weather,
  ].map(item => item.trim()).filter(Boolean))).slice(0, 4);
}

function DiaryWritingStatus({ label = "写入中" }: { label?: string }) {
  return (
    <span className="diary-writing-status" aria-label={label}>
      <span>{label}</span>
      <span className="diary-writing-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}

export function DiaryEntriesApp({ onBack, onNotice }: DiaryEntriesAppProps) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [settings, setSettings] = useState<DiaryEntryTimerSettings>(() => loadDiaryEntryTimerSettings());
  const [timerSettingsOpen, setTimerSettingsOpen] = useState(false);
  const [writePanelOpen, setWritePanelOpen] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [activeEntry, setActiveEntry] = useState<DiaryEntry | null>(null);
  const [editingEntry, setEditingEntry] = useState<DiaryEntry | null>(null);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [activeMonth, setActiveMonth] = useState("all");
  const [activeDate, setActiveDate] = useState("");
  const [isExporting, setIsExporting] = useState(false);
  const [deleteCandidateEntry, setDeleteCandidateEntry] = useState<DiaryEntry | null>(null);
  const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
  const [localGeneratingIds, setGeneratingCharacterIds] = useState<string[]>([]);
  const [diaryFontAssetId, setDiaryFontAssetId] = useState<string | null>(() => loadDiaryEntryFontAssetId());
  const [diaryFontDataUrl, setDiaryFontDataUrl] = useState<string | null>(null);
  const [diaryFontScale, setDiaryFontScale] = useState<number>(() => loadDiaryEntryFontScale());
  // Merge in the module-level tracker so background generation (timer, or a
  // batch started before leaving the app) is visible again after re-entry.
  const trackedGeneratingIds = useDiaryGenerating();
  const generatingCharacterIds = useMemo(
    () => Array.from(new Set([...localGeneratingIds, ...trackedGeneratingIds])),
    [localGeneratingIds, trackedGeneratingIds],
  );
  const [entryDrag, setEntryDrag] = useState<DiaryEntryDragState | null>(null);
  const entryMainRef = useRef<HTMLElement | null>(null);
  const entryTrashRef = useRef<HTMLDivElement | null>(null);
  const fontFileRef = useRef<HTMLInputElement | null>(null);
  const entryDragRef = useRef<DiaryEntryDragSession | null>(null);
  const entryDragClickSuppressedRef = useRef(false);
  const entryDragClickSuppressTimerRef = useRef<number | null>(null);
  const entryDragScrollLockRef = useRef<DiaryEntryDragScrollLock | null>(null);
  const entryDragTouchMoveBlockerRef = useRef<((event: globalThis.TouchEvent) => void) | null>(null);

  const notify = useCallback((message: string) => {
    onNotice?.(message);
  }, [onNotice]);

  const refreshEntries = useCallback(() => {
    setEntries(loadDiaryEntries());
  }, []);

  useEffect(() => {
    if (!diaryFontAssetId) {
      setDiaryFontDataUrl(null);
      return;
    }
    let cancelled = false;
    void getThemeAssetDataUrl(diaryFontAssetId).then((dataUrl) => {
      if (cancelled) return;
      if (dataUrl) {
        setDiaryFontDataUrl(dataUrl);
        return;
      }
      saveDiaryEntryFontAssetId(null);
      setDiaryFontAssetId(null);
      setDiaryFontDataUrl(null);
      notify("日记字体资源丢失，已恢复默认字体");
    }).catch(() => {
      if (cancelled) return;
      setDiaryFontDataUrl(null);
      notify("日记字体加载失败，暂时使用默认字体");
    });
    return () => { cancelled = true; };
  }, [diaryFontAssetId, notify]);

  useEffect(() => {
    let node = document.getElementById(DIARY_USER_FONT_STYLE_ID) as HTMLStyleElement | null;
    if (!node) {
      node = document.createElement("style");
      node.id = DIARY_USER_FONT_STYLE_ID;
      document.head.append(node);
    }
    node.textContent = diaryFontDataUrl
      ? `@font-face{font-family:"${DIARY_USER_FONT_FAMILY}";src:url("${diaryFontDataUrl}");font-display:swap;}`
      : "";
  }, [diaryFontDataUrl]);

  const handleDiaryFontUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      const assetId = await saveThemeAssetFromBlob(file, "font");
      const dataUrl = await getThemeAssetDataUrl(assetId);
      if (!dataUrl) {
        throw new Error("字体资源没有保存成功");
      }
      saveDiaryEntryFontAssetId(assetId);
      setDiaryFontAssetId(assetId);
      setDiaryFontDataUrl(dataUrl);
      notify(`日记字体已上传：${file.name}`);
    } catch (error) {
      notify("日记字体上传失败：" + String(error));
    }
  }, [notify]);

  const handleDiaryFontScaleChange = useCallback((scale: number) => {
    const normalized = Math.min(1.25, Math.max(0.85, scale));
    setDiaryFontScale(normalized);
    saveDiaryEntryFontScale(normalized);
  }, []);

  const handleDiaryFontReset = useCallback(() => {
    saveDiaryEntryFontAssetId(null);
    saveDiaryEntryFontScale(1);
    setDiaryFontAssetId(null);
    setDiaryFontDataUrl(null);
    setDiaryFontScale(1);
    notify("已恢复默认日记字体");
  }, [notify]);

  const diaryEntryStyle = useMemo(() => {
    return {
      ...(diaryFontDataUrl
        ? { "--diary-entry-font-family": `"${DIARY_USER_FONT_FAMILY}", "NoteWall Ximai", var(--app-font-family)` }
        : {}),
      "--diary-entry-font-scale": String(diaryFontScale),
    } as CSSProperties;
  }, [diaryFontDataUrl, diaryFontScale]);

  const deleteEntry = useCallback((entry: DiaryEntry) => {
    deleteDiaryEntry(entry.id);
    setActiveEntry(current => current?.id === entry.id ? null : current);
    setDeleteCandidateEntry(current => current?.id === entry.id ? null : current);
    refreshEntries();
    notify(`已删除 ${entry.characterName} 的日记。`);
  }, [notify, refreshEntries]);

  const handleToggleFavorite = useCallback((entry: DiaryEntry) => {
    const updated = setDiaryEntryFavorite(entry.id, !entry.isFavorite);
    if (!updated) return;
    setActiveEntry(updated);
    refreshEntries();
    notify(updated.isFavorite ? "已加入珍藏。" : "已从珍藏中移除。");
  }, [notify, refreshEntries]);

  const handleSaveEdit = useCallback((entryId: string, patch: { title: string; dateLabel: string; mood: string; weather: string; tags: string[]; blocks: DiaryEntryBlock[] }) => {
    const updated = updateDiaryEntry(entryId, { ...patch, body: patch.blocks.map(blockPlainText).filter(Boolean).join("\n\n") });
    if (!updated) { notify("日记保存失败，请重试。"); return; }
    setActiveEntry(updated); setEditingEntry(null); refreshEntries(); notify("日记已保存，原有内容结构已保留。");
  }, [notify, refreshEntries]);

  const handleRestorePrevious = useCallback((entry: DiaryEntry) => {
    const updated = restoreDiaryEntryRevision(entry.id);
    if (!updated) {
      notify("没有可恢复的旧版本。");
      return;
    }
    setActiveEntry(updated);
    refreshEntries();
    notify("已恢复上一个版本，当前内容也已留档。");
  }, [notify, refreshEntries]);

  const handleExportEntry = useCallback(async (entry: DiaryEntry, format: DiaryExportFormat) => {
    try {
      await downloadDiaryEntry(entry, format);
      notify(format === "md" ? "已发起 Markdown 导出。" : "已发起 TXT 导出。");
    } catch (error) {
      notify("导出失败：" + (error instanceof Error ? error.message : String(error)));
    }
  }, [notify]);

  const handleExportZip = useCallback(async () => {
    const scopedEntries = loadDiaryEntries().filter(entry => {
      if (activeCharacterId && entry.characterId !== activeCharacterId) return false;
      return !favoritesOnly || Boolean(entry.isFavorite);
    });
    if (!scopedEntries.length) {
      notify("当前没有可导出的日记。");
      return;
    }
    setIsExporting(true);
    try {
      await downloadDiaryEntriesZip(scopedEntries);
      notify(`已导出 ${scopedEntries.length} 篇日记。`);
    } catch (error) {
      notify("批量导出失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      setIsExporting(false);
    }
  }, [activeCharacterId, favoritesOnly, notify]);

  useEffect(() => {
    setCharacters(loadCharacters());
    refreshEntries();
  }, [refreshEntries]);

  useEffect(() => {
    saveDiaryEntryTimerSettings(settings);
    window.dispatchEvent(new CustomEvent(DIARY_ENTRY_TIMER_SETTINGS_UPDATED_EVENT));
  }, [settings]);

  useEffect(() => {
    const handleEntriesUpdated = () => {
      refreshEntries();
      setSettings(loadDiaryEntryTimerSettings());
    };
    window.addEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
    return () => window.removeEventListener(DIARY_ENTRIES_UPDATED_EVENT, handleEntriesUpdated);
  }, [refreshEntries]);

  const resolveTargets = useCallback((characterIds: string[]): Character[] => {
    const stored = loadCharacters();
    const uniqueIds = Array.from(new Set(characterIds.filter(Boolean)));
    return uniqueIds
      .map(characterId => characters.find(item => item.id === characterId) ?? stored.find(item => item.id === characterId))
      .filter(Boolean) as Character[];
  }, [characters]);

  const generateForCharacters = useCallback(async (characterIds: string[], trigger: DiaryEntryTrigger = "manual") => {
    const targets = resolveTargets(characterIds);
    if (targets.length === 0) {
      notify("找不到角色。");
      return;
    }

    const targetIds = targets.map(character => character.id);
    setGeneratingCharacterIds(prev => Array.from(new Set([...prev, ...targetIds])));
    try {
      const baseEntries = loadDiaryEntries();
      const results = await Promise.all(targets.map(async character => {
        try {
          return {
            status: "fulfilled" as const,
            character,
            draft: await generateDiaryEntryForCharacter(character.id, baseEntries, trigger),
          };
        } catch {
          return { status: "rejected" as const, character };
        }
      }));

      const createdEntries: DiaryEntry[] = [];
      const failedNames: string[] = [];
      for (const result of results) {
        if (result.status === "rejected") {
          failedNames.push(result.character.name);
          continue;
        }
        try {
          createdEntries.push(createDiaryEntry({
            characterId: result.character.id,
            characterName: result.character.name,
            title: result.draft.title,
            mood: result.draft.mood,
            weather: result.draft.weather,
            tags: result.draft.tags,
            body: result.draft.body,
            blocks: result.draft.blocks,
            trigger,
          }));
        } catch {
          failedNames.push(result.character.name);
        }
      }

      refreshEntries();
      if (createdEntries.length === 1 && failedNames.length === 0) {
        notify(`${createdEntries[0].characterName} 写了一篇日记。`);
      } else if (createdEntries.length > 0) {
        notify(`已生成 ${createdEntries.length} 篇日记${failedNames.length ? `，${failedNames.length} 个失败` : ""}。`);
      } else {
        notify(failedNames.length ? `日记生成失败：${failedNames.join("、")}` : "日记生成失败。");
      }
    } finally {
      setGeneratingCharacterIds(prev => prev.filter(id => !targetIds.includes(id)));
    }
  }, [notify, refreshEntries, resolveTargets]);

  const clearEntryDragTimer = useCallback(() => {
    const timer = entryDragRef.current?.timer;
    if (timer !== null && timer !== undefined) {
      window.clearTimeout(timer);
      if (entryDragRef.current) entryDragRef.current.timer = null;
    }
  }, []);

  const suppressEntryClick = useCallback((duration = 700) => {
    if (entryDragClickSuppressTimerRef.current !== null) {
      window.clearTimeout(entryDragClickSuppressTimerRef.current);
    }
    entryDragClickSuppressedRef.current = true;
    entryDragClickSuppressTimerRef.current = window.setTimeout(() => {
      entryDragClickSuppressedRef.current = false;
      entryDragClickSuppressTimerRef.current = null;
    }, duration);
  }, []);

  const lockEntryDragScroll = useCallback(() => {
    if (entryDragScrollLockRef.current || typeof document === "undefined") return;
    const main = entryMainRef.current;
    entryDragScrollLockRef.current = {
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      htmlOverscrollBehavior: document.documentElement.style.overscrollBehavior,
      htmlTouchAction: document.documentElement.style.touchAction,
      main,
      mainOverflow: main?.style.overflow ?? "",
      mainTouchAction: main?.style.touchAction ?? "",
      mainScrollTop: main?.scrollTop ?? 0,
    };
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overscrollBehavior = "none";
    document.documentElement.style.touchAction = "none";
    if (!entryDragTouchMoveBlockerRef.current) {
      entryDragTouchMoveBlockerRef.current = (event: globalThis.TouchEvent) => {
        event.preventDefault();
      };
      document.addEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true, passive: false });
    }
    if (main) {
      main.style.overflow = "hidden";
      main.style.touchAction = "none";
    }
  }, []);

  const unlockEntryDragScroll = useCallback(() => {
    const lock = entryDragScrollLockRef.current;
    if (!lock || typeof document === "undefined") return;
    document.body.style.overflow = lock.bodyOverflow;
    document.body.style.touchAction = lock.bodyTouchAction;
    document.documentElement.style.overscrollBehavior = lock.htmlOverscrollBehavior;
    document.documentElement.style.touchAction = lock.htmlTouchAction;
    if (entryDragTouchMoveBlockerRef.current) {
      document.removeEventListener("touchmove", entryDragTouchMoveBlockerRef.current, { capture: true });
      entryDragTouchMoveBlockerRef.current = null;
    }
    if (lock.main) {
      lock.main.style.overflow = lock.mainOverflow;
      lock.main.style.touchAction = lock.mainTouchAction;
      lock.main.scrollTop = lock.mainScrollTop;
    }
    entryDragScrollLockRef.current = null;
  }, []);

  const isEntryOverTrash = useCallback((clientX: number, clientY: number, width: number, height: number) => {
    const trashRect = entryTrashRef.current?.getBoundingClientRect();
    if (!trashRect) return false;
    const entryRect = {
      left: clientX - width / 2,
      right: clientX + width / 2,
      top: clientY - height / 2,
      bottom: clientY + height / 2,
    };
    return entryRect.left < trashRect.right
      && entryRect.right > trashRect.left
      && entryRect.top < trashRect.bottom
      && entryRect.bottom > trashRect.top;
  }, []);

  const resetEntryDrag = useCallback(() => {
    clearEntryDragTimer();
    const session = entryDragRef.current;
    if (session?.dragging) {
      suppressEntryClick();
    }
    if (session) {
      try {
        session.target.releasePointerCapture(session.pointerId);
      } catch {
        // Pointer capture may already be gone.
      }
    }
    entryDragRef.current = null;
    setEntryDrag(null);
    unlockEntryDragScroll();
  }, [clearEntryDragTimer, suppressEntryClick, unlockEntryDragScroll]);

  const updateEntryDragPosition = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session?.dragging) return;
    const lock = entryDragScrollLockRef.current;
    if (lock?.main) lock.main.scrollTop = lock.mainScrollTop;
    const isOverTrash = isEntryOverTrash(clientX, clientY, session.width, session.height);
    setEntryDrag({
      entry: session.entry,
      x: clientX,
      y: clientY,
      width: session.width,
      height: session.height,
      isOverTrash,
    });
  }, [isEntryOverTrash]);

  const finishEntryDrag = useCallback((clientX: number, clientY: number) => {
    const session = entryDragRef.current;
    if (!session) return;
    const shouldDelete = session.dragging && isEntryOverTrash(clientX, clientY, session.width, session.height);
    const entry = session.entry;
    resetEntryDrag();
    if (shouldDelete) setDeleteCandidateEntry(entry);
  }, [isEntryOverTrash, resetEntryDrag]);

  useEffect(() => {
    if (!entryDrag) return;
    const handleWindowPointerMove = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session?.dragging || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      updateEntryDragPosition(event.clientX, event.clientY);
    };
    const handleWindowPointerUp = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      finishEntryDrag(event.clientX, event.clientY);
    };
    const handleWindowPointerCancel = (event: globalThis.PointerEvent) => {
      const session = entryDragRef.current;
      if (!session || session.pointerId !== event.pointerId) return;
      resetEntryDrag();
    };
    window.addEventListener("pointermove", handleWindowPointerMove, { passive: false });
    window.addEventListener("pointerup", handleWindowPointerUp, { passive: false });
    window.addEventListener("pointercancel", handleWindowPointerCancel);
    return () => {
      window.removeEventListener("pointermove", handleWindowPointerMove);
      window.removeEventListener("pointerup", handleWindowPointerUp);
      window.removeEventListener("pointercancel", handleWindowPointerCancel);
    };
  }, [entryDrag, finishEntryDrag, resetEntryDrag, updateEntryDragPosition]);

  useEffect(() => {
    return () => {
      resetEntryDrag();
      unlockEntryDragScroll();
      if (entryDragClickSuppressTimerRef.current !== null) {
        window.clearTimeout(entryDragClickSuppressTimerRef.current);
        entryDragClickSuppressTimerRef.current = null;
      }
    };
  }, [resetEntryDrag, unlockEntryDragScroll]);

  const handleEntryPointerDown = useCallback((event: PointerEvent<HTMLButtonElement>, entry: DiaryEntry) => {
    if (!activeCharacterId) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    clearEntryDragTimer();
    const rect = event.currentTarget.getBoundingClientRect();
    const target = event.currentTarget;
    entryDragRef.current = {
      entry,
      pointerId: event.pointerId,
      target,
      startX: event.clientX,
      startY: event.clientY,
      width: rect.width,
      height: rect.height,
      timer: window.setTimeout(() => {
        const session = entryDragRef.current;
        if (!session || session.pointerId !== event.pointerId || session.dragging) return;
        session.dragging = true;
        session.timer = null;
        suppressEntryClick(900);
        lockEntryDragScroll();
        try {
          session.target.setPointerCapture(session.pointerId);
        } catch {
          // Some touch browsers release capture during native gestures.
        }
        setEntryDrag({
          entry: session.entry,
          x: event.clientX,
          y: event.clientY,
          width: session.width,
          height: session.height,
          isOverTrash: isEntryOverTrash(event.clientX, event.clientY, session.width, session.height),
        });
      }, 430),
      dragging: false,
    };
  }, [activeCharacterId, clearEntryDragTimer, isEntryOverTrash, lockEntryDragScroll, suppressEntryClick]);

  const handleEntryPointerMove = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    const dx = event.clientX - session.startX;
    const dy = event.clientY - session.startY;
    if (!session.dragging) {
      if (Math.hypot(dx, dy) > 8) {
        clearEntryDragTimer();
        entryDragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    updateEntryDragPosition(event.clientX, event.clientY);
  }, [clearEntryDragTimer, updateEntryDragPosition]);

  const handleEntryPointerUp = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    finishEntryDrag(event.clientX, event.clientY);
  }, [finishEntryDrag]);

  const handleEntryPointerCancel = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    resetEntryDrag();
  }, [resetEntryDrag]);

  const handleEntryPointerLeave = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    const session = entryDragRef.current;
    if (!session || session.pointerId !== event.pointerId || session.dragging) return;
    clearEntryDragTimer();
    entryDragRef.current = null;
  }, [clearEntryDragTimer]);

  const books = useMemo<DiaryBook[]>(() => {
    const map = new Map<string, DiaryEntry[]>();
    for (const entry of entries) {
      const list = map.get(entry.characterId);
      if (list) list.push(entry);
      else map.set(entry.characterId, [entry]);
    }
    return Array.from(map.entries()).map(([characterId, characterEntries]) => ({
      characterId,
      characterName: characterEntries[0].characterName,
      avatar: characters.find(character => character.id === characterId)?.avatar ?? "",
      entries: characterEntries,
    }));
  }, [entries, characters]);

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return entries.filter(entry => {
      if (favoritesOnly && !entry.isFavorite) return false;
      const date = new Date(entry.createdAt);
      const monthKey = Number.isNaN(date.getTime()) ? "" : date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
      const dateKey = Number.isNaN(date.getTime()) ? "" : date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      if (activeMonth !== "all" && monthKey !== activeMonth) return false;
      if (activeDate && dateKey !== activeDate) return false;
      if (!query) return true;
      const searchable = [entry.title, entry.body, entry.dateLabel, entry.characterName, entry.mood, entry.weather, ...entry.tags]
        .join(" ").toLocaleLowerCase();
      return searchable.includes(query);
    });
  }, [entries, favoritesOnly, searchQuery, activeMonth, activeDate]);
  const filteredEntryIds = useMemo(() => new Set(filteredEntries.map(entry => entry.id)), [filteredEntries]);
  const visibleBooks = useMemo(() => books
    .map(book => ({ ...book, entries: book.entries.filter(entry => filteredEntryIds.has(entry.id)) }))
    .filter(book => book.entries.length > 0), [books, filteredEntryIds]);
  const visibleEntryCount = filteredEntries.length;
  const activeBook = useMemo(
    () => (activeCharacterId ? visibleBooks.find(book => book.characterId === activeCharacterId) ?? null : null),
    [activeCharacterId, visibleBooks],
  );
  const activeBookBusy = Boolean(activeBook && generatingCharacterIds.includes(activeBook.characterId));
  const readingEntries = activeBook?.entries ?? [];
  const readingIndex = activeEntry ? readingEntries.findIndex(item => item.id === activeEntry.id) : -1;
  const moveReadingPage = (offset: number) => { const next = readingEntries[readingIndex + offset]; if (next) setActiveEntry(next); };
  return (
    <section className={`diary-app diary-entry-app ${entryDrag ? "is-entry-dragging" : ""}`} style={diaryEntryStyle}>
      {generatingCharacterIds.length > 0 && (
        <div className="diary-generating-toast" role="status">
          <span className="diary-generating-toast-spinner" aria-hidden="true" />
          正在生成日记{generatingCharacterIds.length > 1 ? `（${generatingCharacterIds.length} 篇）` : ""}…
        </div>
      )}
      <header className="diary-app-header diary-entry-header">
        <button
          type="button"
          className="diary-icon-btn"
          onClick={() => (activeBook ? setActiveCharacterId(null) : favoritesOnly ? setFavoritesOnly(false) : onBack())}
          aria-label="返回"
        >
          <ChevronLeft size={20} />
        </button>
        <div>
          <h1>{activeBook ? `${activeBook.characterName} 的日记` : favoritesOnly ? "珍藏日记" : "日记"}</h1>
          <p>{activeBook ? `共 ${activeBook.entries.length} 篇${favoritesOnly ? "珍藏" : "手写日常"}` : favoritesOnly ? `共 ${visibleEntryCount} 篇珍藏` : "每个角色一本，点开翻阅"}</p>
        </div>
        <input
          ref={fontFileRef}
          type="file"
          accept=".ttf,.otf,.woff,.woff2,font/*,application/font-woff,application/font-woff2"
          className="hidden"
          onChange={handleDiaryFontUpload}
        />
        <span className="diary-entry-header-actions">
          <button type="button" className="note-wall-menu-btn" onClick={() => void handleExportZip()} disabled={isExporting || visibleEntryCount === 0} aria-label="批量导出日记" title={activeBook ? "导出本册日记 ZIP" : favoritesOnly ? "导出全部珍藏 ZIP" : "导出全部日记 ZIP"}>
            <Download size={19} />
          </button>
          <button
            type="button"
            className="note-wall-menu-btn diary-font-upload-btn"
            onClick={() => setFontPanelOpen(true)}
            aria-label="日记字体设置"
            title="日记字体设置"
          >
            <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          </button>
          <button type="button" className="note-wall-menu-btn" onClick={() => setTimerSettingsOpen(true)} aria-label="日记设置">
            <DotsThree size={28} weight="bold" />
          </button>
        </span>
      </header>

      <main ref={entryMainRef} className="diary-entry-main">
        <div className="diary-entry-toolbar">
          <div className="diary-entry-search">
            <Search size={18} aria-hidden="true" />
            <input value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="搜索日记标题、内容或角色" aria-label="搜索日记" />
            {searchQuery ? <button type="button" onClick={() => setSearchQuery("")} aria-label="清空搜索"><X size={15} /></button> : null}
          </div>
          <button type="button" className={`diary-entry-filter-trigger ${filterOpen || activeMonth !== "all" || activeDate ? "is-active" : ""}`} onClick={() => setFilterOpen(value => !value)} aria-label="筛选日记" aria-expanded={filterOpen}>
            <SlidersHorizontal size={19} />
          </button>
          <button type="button" className={`diary-entry-favorite-entry ${favoritesOnly ? "is-active" : ""}`} onClick={() => { setActiveCharacterId(null); setFavoritesOnly(value => !value); }} aria-label={favoritesOnly ? "查看全部日记" : "只看珍藏日记"} aria-pressed={favoritesOnly}>
            <Heart size={19} fill={favoritesOnly ? "currentColor" : "none"} />
          </button>
        </div>
        {filterOpen ? (
          <section className="diary-entry-filter-panel" aria-label="日期筛选">
            <label><span>月份</span><input type="month" value={activeMonth === "all" ? "" : activeMonth} onChange={event => { setActiveMonth(event.target.value || "all"); setActiveDate(""); }} /></label>
            <label><span>具体日期</span><input type="date" value={activeDate} onChange={event => { setActiveDate(event.target.value); setActiveMonth("all"); }} /></label>
            <button type="button" onClick={() => { setActiveMonth("all"); setActiveDate(""); }}>重置筛选</button>
          </section>
        ) : null}
        {visibleEntryCount === 0 ? (
          <div className="diary-entry-empty">
            {favoritesOnly ? <Heart size={34} strokeWidth={1.5} /> : <NotebookPen size={34} strokeWidth={1.5} />}
            <h2>{searchQuery.trim() || activeMonth !== "all" || activeDate ? "没有找到符合条件的日记" : favoritesOnly ? "还没有珍藏" : "还没有日记"}</h2>
            <p>{searchQuery.trim() || activeMonth !== "all" || activeDate ? "试试更换关键词，或清除日期筛选。" : favoritesOnly ? "遇到喜欢的文章，点亮爱心就能收进这里。" : "让角色先写一篇，纸面会从这里开始铺开。"}</p>
            {favoritesOnly ? <button type="button" onClick={() => setFavoritesOnly(false)}>返回全部日记</button> : <button type="button" onClick={() => setWritePanelOpen(true)}>让TA写一篇</button>}
          </div>
        ) : activeBook ? (
          <div className="diary-entry-list">
            {activeBook.entries.map(entry => (
              <DiaryEntryCard
                key={entry.id}
                entry={entry}
                isDragSource={entryDrag?.entry.id === entry.id}
                onPointerDown={(event) => handleEntryPointerDown(event, entry)}
                onPointerMove={handleEntryPointerMove}
                onPointerUp={handleEntryPointerUp}
                onPointerCancel={handleEntryPointerCancel}
                onPointerLeave={handleEntryPointerLeave}
                onClick={(event) => {
                  event.stopPropagation();
                  if (entryDragClickSuppressedRef.current) {
                    event.preventDefault();
                    return;
                  }
                  setActiveEntry(entry);
                }}
              />
            ))}
          </div>
        ) : (
          <div className="diary-shelf">
            {[0, 1].map(column => (
              <div className="diary-shelf-column" key={column}>
                {visibleBooks.filter((_, index) => index % 2 === column).map(book => (
                  <DiaryBookCover
                    key={book.characterId}
                    book={book}
                    busy={generatingCharacterIds.includes(book.characterId)}
                    onOpen={() => { setActiveMonth("all"); setActiveCharacterId(book.characterId); }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </main>

      {entries.length > 0 && !favoritesOnly ? (
        activeBook ? (
          <button
            type="button"
            className="diary-entry-write-btn"
            disabled={activeBookBusy}
            aria-busy={activeBookBusy}
            onClick={() => generateForCharacters([activeBook.characterId])}
          >
            <WandSparkles size={18} strokeWidth={1.7} />
            {activeBookBusy ? <DiaryWritingStatus /> : <span>让TA写</span>}
          </button>
        ) : (
          <button type="button" className="diary-entry-write-btn" onClick={() => setWritePanelOpen(true)}>
            <WandSparkles size={18} strokeWidth={1.7} />
            <span>让TA写</span>
          </button>
        )
      ) : null}

      {timerSettingsOpen ? (
        <DiaryEntryTimerSettingsPanel
          characters={characters}
          settings={settings}
          generatingCharacterIds={generatingCharacterIds}
          onChange={setSettings}
          onClose={() => setTimerSettingsOpen(false)}
        />
      ) : null}

      {writePanelOpen ? (
        <DiaryEntryWritePanel
          characters={characters}
          generatingCharacterIds={generatingCharacterIds}
          onGenerateMany={generateForCharacters}
          onClose={() => setWritePanelOpen(false)}
        />
      ) : null}

      {fontPanelOpen ? (
        <DiaryEntryFontPanel
          hasCustomFont={Boolean(diaryFontDataUrl)}
          scale={diaryFontScale}
          onUpload={() => fontFileRef.current?.click()}
          onScaleChange={handleDiaryFontScaleChange}
          onReset={handleDiaryFontReset}
          onClose={() => setFontPanelOpen(false)}
        />
      ) : null}

      {activeEntry ? (
        <DiaryEntryDetail
          entry={activeEntry}
          onClose={() => setActiveEntry(null)}
          onEdit={() => setEditingEntry(activeEntry)}
          onToggleFavorite={() => handleToggleFavorite(activeEntry)}
          onExport={format => { void handleExportEntry(activeEntry, format); }}
          onRestore={() => handleRestorePrevious(activeEntry)}
          onPrevious={() => moveReadingPage(-1)} onNext={() => moveReadingPage(1)}
          readingIndex={readingIndex} readingCount={readingEntries.length}
        />
      ) : null}

      {editingEntry ? (
        <DiaryEntryEditPanel
          entry={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSave={patch => handleSaveEdit(editingEntry.id, patch)}
        />
      ) : null}

      {deleteCandidateEntry ? (
        <div
          className="nw-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="diary-entry-delete-title"
          onClick={() => setDeleteCandidateEntry(null)}
        >
          <section className="nw-delete-confirm" onClick={event => event.stopPropagation()}>
            <div className="nw-delete-confirm-icon">
              <Trash2 size={24} strokeWidth={1.8} />
            </div>
            <h2 id="diary-entry-delete-title">删除日记</h2>
            <p>这篇日记会被删除，对应的短期记忆事件也会消失。</p>
            <div>
              <button type="button" className="nw-secondary-btn" onClick={() => setDeleteCandidateEntry(null)}>取消</button>
              <button type="button" className="nw-danger-btn" onClick={() => deleteEntry(deleteCandidateEntry)}>
                <span className="note-wall-primary-content">
                  <span>删除</span>
                </span>
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <div
        ref={entryTrashRef}
        className={`diary-entry-trash-bin ${entryDrag ? "is-visible" : ""} ${entryDrag?.isOverTrash ? "is-over" : ""}`}
        aria-hidden={!entryDrag}
      >
        <Trash2 size={30} strokeWidth={1.8} />
      </div>

      {entryDrag ? (
        <div
          className="diary-entry-card diary-entry-drag-ghost"
          style={{
            left: entryDrag.x,
            top: entryDrag.y,
            width: entryDrag.width,
            minHeight: entryDrag.height,
          }}
        >
          <DiaryEntryCardContent entry={entryDrag.entry} />
        </div>
      ) : null}
    </section>
  );
}

const DIARY_BOOK_COVER_COUNT = 6;

function hashText(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function DiaryBookCover({ book, busy, onOpen }: { book: DiaryBook; busy: boolean; onOpen: () => void }) {
  const hash = hashText(book.characterId);
  const latest = book.entries[0];
  return (
    <button
      type="button"
      className="diary-book"
      data-cover={hash % DIARY_BOOK_COVER_COUNT}
      onClick={onOpen}
    >
      <span className="diary-book-spine" aria-hidden="true" />
      <span className="diary-book-frame" aria-hidden="true" />
      <span className="diary-book-label">
        <span className="diary-book-avatar">
          {book.avatar ? <img src={book.avatar} alt="" /> : <Bot size={20} />}
        </span>
        <strong>{book.characterName}</strong>
        <em>{busy ? <DiaryWritingStatus /> : "的日记本"}</em>
      </span>
      <span className="diary-book-meta">
        <span>{book.entries.length} 篇</span>
        <time>{formatEntryTime(latest.createdAt)}</time>
      </span>
    </button>
  );
}

function DiaryEntryCardContent({ entry }: { entry: DiaryEntry }) {
  const preview = entry.blocks.map(blockPlainText).filter(Boolean).join(" ");
  const markers = getEntryMarkers(entry);
  return (
    <>
      <span className="diary-entry-card-kicker">DIARY{entry.isFavorite ? <span className="diary-entry-card-favorite" aria-label="已珍藏"> ♥</span> : null}</span>

      {markers.length > 0 ? (
        <span className="diary-entry-card-markers">
          {markers.map(marker => <span key={marker} className="diary-entry-marker">{marker}</span>)}
        </span>
      ) : null}
      <strong>{entry.title}</strong>
      <span className="diary-entry-card-text">{clipText(preview || entry.body, 130)}</span>
      <span className="diary-entry-card-meta">
        <span>{entry.characterName}</span>
        <time>{formatEntryTime(entry.createdAt)}</time>
      </span>
    </>
  );
}

function DiaryEntryCard({
  entry,
  isDragSource,
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}: {
  entry: DiaryEntry;
  isDragSource: boolean;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`diary-entry-card ${isDragSource ? "is-drag-source" : ""}`}
      draggable={false}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onContextMenu={event => event.preventDefault()}
      onClick={onClick}
    >
      <DiaryEntryCardContent entry={entry} />
    </button>
  );
}

function DiaryEntryFontPanel({
  hasCustomFont,
  scale,
  onUpload,
  onScaleChange,
  onReset,
  onClose,
}: {
  hasCustomFont: boolean;
  scale: number;
  onUpload: () => void;
  onScaleChange: (scale: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-font-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>日记字体</h2>
            <p>{hasCustomFont ? "已使用自定义字体" : "当前使用默认手写字体"}</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <button type="button" className="diary-font-upload-action" onClick={onUpload}>
          <span className="diary-font-upload-mark" aria-hidden="true">Aa</span>
          <span>上传字体</span>
        </button>

        <label className="diary-font-size-control">
          <span>
            <strong>字号</strong>
            <em>{Math.round(scale * 100)}%</em>
          </span>
          <input
            type="range"
            min="0.85"
            max="1.25"
            step="any"
            value={scale}
            onChange={event => onScaleChange(Number(event.target.value))}
          />
        </label>

        <button type="button" className="diary-font-reset-btn" onClick={onReset}>
          恢复默认
        </button>
      </section>
    </div>
  );
}

function DiaryEntryTimerSettingsPanel({ characters, settings, generatingCharacterIds, onChange, onClose }: {
  characters: Character[];
  settings: DiaryEntryTimerSettings;
  generatingCharacterIds: string[];
  onChange: (settings: DiaryEntryTimerSettings) => void;
  onClose: () => void;
}) {
  const busy = generatingCharacterIds.length > 0;

  const toggleTimerCharacter = (characterId: string) => {
    onChange({
      ...settings,
      characterIds: settings.characterIds.includes(characterId)
        ? settings.characterIds.filter(id => id !== characterId)
        : [...settings.characterIds, characterId],
    });
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>定时写日记</h2>
            <p>默认一天一次；未选择角色时，会按全部角色处理。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="diary-entry-setting-grid">
          <label className="diary-entry-toggle-row">
            <span>
              <Clock3 size={17} />
              定时写日记
            </span>
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={event => onChange({ ...settings, enabled: event.target.checked })}
            />
          </label>
          <label className="diary-entry-number-field">
            <span>间隔小时</span>
            <input
              type="number"
              min={1}
              max={720}
              value={settings.intervalHours}
              onChange={event => onChange({ ...settings, intervalHours: Math.max(1, Math.min(720, Number(event.target.value) || 24)) })}
            />
          </label>
        </div>

        <section className="diary-entry-character-section">
          <div className="diary-entry-section-title">
            <strong>定时角色</strong>
            <span>{settings.characterIds.length ? `已选 ${settings.characterIds.length} 个` : "默认全部"}</span>
          </div>
          <CharacterAvatarGrid
            characters={characters}
            selectedIds={settings.characterIds}
            busyIds={generatingCharacterIds}
            disabled={busy}
            onToggle={toggleTimerCharacter}
          />
        </section>
      </section>
    </div>
  );
}

function DiaryEntryWritePanel({ characters, generatingCharacterIds, onGenerateMany, onClose }: {
  characters: Character[];
  generatingCharacterIds: string[];
  onGenerateMany: (characterIds: string[], trigger?: DiaryEntryTrigger) => Promise<void> | void;
  onClose: () => void;
}) {
  const [selectedImmediateIds, setSelectedImmediateIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  const busy = confirming || generatingCharacterIds.length > 0;

  const toggleImmediateCharacter = (characterId: string) => {
    setSelectedImmediateIds(prev => prev.includes(characterId)
      ? prev.filter(id => id !== characterId)
      : [...prev, characterId]);
  };

  const handleConfirm = async () => {
    if (busy || selectedImmediateIds.length === 0) return;
    setConfirming(true);
    try {
      await onGenerateMany(selectedImmediateIds, "manual");
      setSelectedImmediateIds([]);
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="nw-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <section className="diary-entry-settings diary-entry-write-panel" onClick={event => event.stopPropagation()}>
        <header>
          <div>
            <h2>让TA写一篇</h2>
            <p>选择角色后确认，会并行生成日记。</p>
          </div>
          <button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>

        <CharacterAvatarGrid
          characters={characters}
          selectedIds={selectedImmediateIds}
          busyIds={generatingCharacterIds}
          disabled={busy}
          onToggle={toggleImmediateCharacter}
        />
        {selectedImmediateIds.length > 0 ? (
          <button
            type="button"
            className={`diary-entry-confirm-btn ${confirming ? "is-loading" : ""}`}
            disabled={busy}
            onClick={handleConfirm}
            aria-busy={confirming}
          >
            <span className="note-wall-primary-content">
              {confirming ? <span className="note-wall-primary-spinner" aria-hidden="true" /> : null}
              <span>{confirming ? <DiaryWritingStatus /> : `确认让 ${selectedImmediateIds.length} 个角色写日记`}</span>
            </span>
          </button>
        ) : null}
      </section>
    </div>
  );
}

function CharacterAvatarGrid({ characters, selectedIds, busyIds, disabled, onToggle }: {
  characters: Character[];
  selectedIds: string[];
  busyIds: string[];
  disabled: boolean;
  onToggle: (characterId: string) => void;
}) {
  if (characters.length === 0) return <p className="diary-entry-empty-line">暂无角色。</p>;

  return (
    <div className="diary-entry-character-grid">
      {characters.map(character => {
        const selected = selectedIds.includes(character.id);
        const busy = busyIds.includes(character.id);
        return (
          <button
            key={character.id}
            type="button"
            className={selected ? "is-selected" : ""}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onToggle(character.id)}
          >
            <span>
              {character.avatar ? <img src={character.avatar} alt="" /> : <Bot size={18} />}
            </span>
            <strong>{character.name}</strong>
            {busy ? <em><DiaryWritingStatus /></em> : null}
          </button>
        );
      })}
    </div>
  );
}

function buildDiaryParagraphBlocks(body: string): DiaryEntryBlock[] {
  const paragraphs = body.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const blocks: DiaryEntryBlock[] = [];
  for (const paragraph of paragraphs) {
    const text = paragraph.trim();
    if (!text) continue;
    for (let offset = 0; offset < text.length; offset += 900) {
      blocks.push({ type: "paragraph", text: text.slice(offset, offset + 900) });
    }
  }
  return blocks.slice(0, 18);
}

function DiaryEntryDetail({
  entry, onClose, onEdit, onToggleFavorite, onExport, onRestore, onPrevious, onNext, readingIndex, readingCount,
}: {
  entry: DiaryEntry;
  onClose: () => void;
  onEdit: () => void;
  onToggleFavorite: () => void;
  onExport: (format: DiaryExportFormat) => void;
  onRestore: () => void;
  onPrevious: () => void;
  onNext: () => void;
  readingIndex: number;
  readingCount: number;
}) {
  const markers = getEntryMarkers(entry);
  const readingScrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (readingScrollRef.current) readingScrollRef.current.scrollTop = 0;
  }, [entry.id]);
  return (
    <div className="nw-modal-backdrop diary-entry-detail-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <article className="diary-entry-detail-paper" onClick={(event) => event.stopPropagation()}>
        <span className="diary-entry-paper-clip" aria-hidden="true"><span /></span>
        <div ref={readingScrollRef} className="diary-entry-detail-scroll">
          <header>
            <div>
              <span>日记详情 · {entry.dateLabel || formatEntryTime(entry.createdAt)}</span>
              <h2>{entry.title}</h2>
              {entry.weather ? <small className="diary-entry-detail-weather">{entry.weather}</small> : null}
            </div>
            <div className="diary-entry-detail-top">
              <button type="button" onClick={onClose}>关闭</button>
              {markers.length > 0 ? (
                <span className="diary-entry-detail-markers">
                  {markers.map(marker => <span key={marker} className="diary-entry-marker">{marker}</span>)}
                </span>
              ) : null}
            </div>
          </header>
          <div className="diary-entry-blocks">
            {entry.blocks.map((block, index) => (
              <section className="diary-entry-reading-block" key={block.type + "-" + index}>
                <DiaryBlockView block={block} />
              </section>
            ))}
          </div>
          <nav className="diary-entry-reading-nav"><button type="button" onClick={onPrevious} disabled={readingIndex <= 0}>上一篇</button><span>{readingIndex >= 0 ? readingIndex + 1 : 0} / {readingCount}</span><button type="button" onClick={onNext} disabled={readingIndex < 0 || readingIndex >= readingCount - 1}>下一篇</button></nav>
          <div className="diary-entry-detail-actions">
            <button type="button" onClick={onToggleFavorite} aria-pressed={Boolean(entry.isFavorite)}><Heart size={15} fill={entry.isFavorite ? "currentColor" : "none"} />{entry.isFavorite ? "已珍藏" : "珍藏"}</button>
            <button type="button" onClick={onEdit}><Pencil size={15} />编辑</button>
            <button type="button" onClick={() => onExport("txt")}>导出 TXT</button>
            <button type="button" onClick={() => onExport("md")}>导出 Markdown</button>
            {entry.revisionHistory?.length ? <button type="button" onClick={onRestore}><RotateCcw size={15} />恢复上版</button> : null}
          </div>
          <footer className="diary-entry-detail-signature">
            <span>{entry.characterName}{entry.updatedAt !== entry.createdAt ? " · 已编辑" : ""}</span>
            <time>{formatEntryTime(entry.createdAt)}</time>
          </footer>
        </div>
      </article>
    </div>
  );
}

function DiaryEntryEditPanel({ entry, onClose, onSave }: {
  entry: DiaryEntry;
  onClose: () => void;
  onSave: (patch: { title: string; dateLabel: string; mood: string; weather: string; tags: string[]; blocks: DiaryEntryBlock[] }) => void;
}) {
  const [title, setTitle] = useState(entry.title);
  const [dateLabel, setDateLabel] = useState(entry.dateLabel);
  const [mood, setMood] = useState(entry.mood);
  const [weather, setWeather] = useState(entry.weather);
  const [tags, setTags] = useState(entry.tags.join("、"));
  const [blocks, setBlocks] = useState<DiaryEntryBlock[]>(() => JSON.parse(JSON.stringify(entry.blocks)));
  const patchBlock = (index: number, patch: Record<string, unknown>) => setBlocks(current => current.map((block, i) => i === index ? ({ ...block, ...patch } as DiaryEntryBlock) : block));
  const patchParagraphGroup = (start: number, end: number, value: string) => {
    const paragraphs = value.replace(/\\r\\n?/g, "\\n").split(/\\n{2,}/).map(text => text.trim()).filter(Boolean);
    setBlocks(current => [
      ...current.slice(0, start),
      ...paragraphs.map(text => ({ type: "paragraph" as const, text })),
      ...current.slice(end),
    ]);
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({ title: title.trim() || "未命名日记", dateLabel: dateLabel.trim(), mood: mood.trim(), weather: weather.trim(), tags: tags.split(/[,，、\s]+/).map(item => item.trim()).filter(Boolean).slice(0, 5), blocks });
  };
  return (
    <div className="nw-modal-backdrop diary-entry-edit-backdrop" role="dialog" aria-modal="true" aria-labelledby="diary-entry-edit-title" onClick={onClose}>
      <form className="diary-entry-edit-panel" onClick={event => event.stopPropagation()} onSubmit={submit}>
        <header><div><h2 id="diary-entry-edit-title">编辑日记</h2><p>保留段落、引用、涂改和待办清单的原有结构。</p></div><button type="button" className="diary-icon-btn" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
        <label><span>标题</span><input value={title} maxLength={80} onChange={event => setTitle(event.target.value)} /></label>
        <div className="diary-entry-edit-grid">
          <label><span>日期</span><input value={dateLabel} maxLength={40} onChange={event => setDateLabel(event.target.value)} /></label>
          <label><span>天气</span><input value={weather} maxLength={60} onChange={event => setWeather(event.target.value)} /></label>
          <label><span>心情</span><input value={mood} maxLength={60} onChange={event => setMood(event.target.value)} /></label>
          <label><span>标签</span><input value={tags} maxLength={100} onChange={event => setTags(event.target.value)} /></label>
        </div>
        <div className="diary-entry-edit-body diary-entry-edit-blocks"><span>日记内容</span>
          {blocks.map((block, index) => {
            if (block.type === "paragraph") {
              if (index > 0 && blocks[index - 1].type === "paragraph") return null;
              let end = index + 1;
              while (end < blocks.length && blocks[end].type === "paragraph") end += 1;
              return <section className="diary-edit-block diary-edit-paragraph-group" key={`paragraph-${index}`}>
                <small>正文</small>
                <textarea
                  rows={Math.min(18, Math.max(8, blocks.slice(index, end).reduce((count, item) => count + (item.type === "paragraph" ? item.text.split("\\n").length : 0), 0) + (end - index - 1) * 2))}
                  value={blocks.slice(index, end).map(item => item.type === "paragraph" ? item.text : "").join("\\n\\n")}
                  onChange={event => patchParagraphGroup(index, end, event.target.value)}
                />
              </section>;
            }
            return <section className="diary-edit-block" key={`block-${index}`}><small>{block.type === "todo" ? "待办清单" : block.type === "correction" ? "涂改记录" : block.type === "quote" ? "引用" : "图片记录"}</small>
              {block.type === "todo" ? <><input value={block.title || ""} placeholder="清单标题" onChange={event => patchBlock(index, { title: event.target.value })} />{block.items.map((item, itemIndex) => <label className="diary-edit-todo-row" key={itemIndex}><input type="checkbox" checked={item.done} onChange={event => patchBlock(index, { items: block.items.map((v, i) => i === itemIndex ? { ...v, done: event.target.checked } : v) })} /><input value={item.text} onChange={event => patchBlock(index, { items: block.items.map((v, i) => i === itemIndex ? { ...v, text: event.target.value } : v) })} /></label>)}</>
              : block.type === "correction" ? <><textarea value={block.text} onChange={event => patchBlock(index, { text: event.target.value })} /><textarea value={block.replacement || ""} placeholder="修改后的文字" onChange={event => patchBlock(index, { replacement: event.target.value })} /></>
              : block.type === "quote" ? <textarea value={block.text} onChange={event => patchBlock(index, { text: event.target.value })} />
              : <><input value={block.caption || ""} placeholder="图片说明" onChange={event => patchBlock(index, { caption: event.target.value })} /><textarea value={block.description} onChange={event => patchBlock(index, { description: event.target.value })} /></>}
            </section>;
          })}
        </div>
        <footer><button type="button" onClick={onClose}>取消</button><button type="submit">保存修改</button></footer>
      </form>
    </div>
  );
}

function DiaryBlockView({ block }: { block: DiaryEntryBlock }) {
  if (block.type === "quote") {
    return <blockquote className="diary-entry-quote">{block.text}</blockquote>;
  }
  if (block.type === "correction") {
    return (
      <p className="diary-entry-correction">
        <del>{block.text}</del>
        {block.replacement ? <ins>{block.replacement}</ins> : null}
      </p>
    );
  }
  if (block.type === "todo") {
    return (
      <section className="diary-entry-todo">
        {block.title ? <h3>{block.title}</h3> : null}
        <ul>
          {block.items.map((item, index) => (
            <li key={`${item.text}-${index}`} data-done={item.done ? "true" : "false"}>
              <span />
              <p>{item.text}</p>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  if (block.type === "image") {
    return (
      <figure className="diary-entry-image-block">
        <div>{block.description}</div>
        {block.caption ? <figcaption>{block.caption}</figcaption> : null}
      </figure>
    );
  }
  return <p className="diary-entry-paragraph">{block.text}</p>;
}
