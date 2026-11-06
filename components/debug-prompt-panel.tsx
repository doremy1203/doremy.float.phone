"use client";

import { useState, useEffect, useRef, useSyncExternalStore, useMemo, useCallback, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties } from "react";
import { getDebugChatState, getDebugPromptSnapshot, getDebugPromptSnapshotByApp, subscribeDebugChatState, subscribeDebugPromptSnapshot, type DebugPromptSnapshot } from "@/lib/debug-store";
import { previewPromptRequestSnapshot, previewPromptPayload, readCompressedImageDataUrl, ChatEngineError } from "@/lib/chat-engine";
import { previewGroupPromptRequestSnapshot } from "@/lib/group-chat-engine";
import { FileText, Tags, X } from "lucide-react";
import {
    getFloatingDockState,
    subscribeFloatingDockState,
    expandFloatingDock,
    collapseFloatingDock,
    setFloatingDockAnchor,
    setActiveFloatingTool,
} from "@/lib/floating-dock-store";
import {
    previewMomentsPostPrompt,
    previewMomentsCommentPrompt,
    previewMomentsNPCPrompt,
    previewMomentsReplyPrompt,
    type MomentsPreviewResult,
} from "@/lib/moments-engine";
import { previewCalendarPromptPayload } from "@/lib/calendar-engine";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, hydrateChatStorage, loadChatAppSettings, loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { getAllPosts } from "@/lib/moments-storage";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { getWeekStartIso } from "@/lib/calendar-utils";
import { loadStorySessions, loadStoryMessages } from "@/lib/story-storage";
import { previewStoryPromptPayload } from "@/lib/story-engine";
import { loadVnSessions, loadVnMessages } from "@/lib/vn-storage";
import { previewVnPromptPayload } from "@/lib/vn-engine";
import { loadChatOfflineTurns } from "@/lib/chat-offline-storage";
import { buildOfflinePromptHistory } from "@/lib/offline-prompt-builder";
import { EXTRA_PROMPT_APPS, type ExtraPromptAppId } from "@/components/debug-prompt-registry";
import { previewCheckPhonePromptPayload } from "@/lib/checkphone-engine";
import { CHECKPHONE_APP_SPECS, type CheckPhoneAppId } from "@/lib/checkphone-config";
import { hydrateReadingStorage, loadBooks, loadChapters, loadAnnotations } from "@/lib/reading-storage";
import { previewReadingAnnotationPrompt, previewReadingDiscussPrompt } from "@/lib/reading-engine";
import { previewDwellingPromptPayload, type DwellingRefreshMode } from "@/lib/dwelling-engine";
import { loadDiaryEntries } from "@/lib/diary-entry-storage";
import { previewDiaryEntryPromptPayload } from "@/lib/diary-entry-engine";
import { fetchNoteWall, fetchNoteWallComments } from "@/lib/notewall-client";
import { previewNoteWallPromptPayload, type NoteWallReplyCandidate } from "@/lib/notewall-engine";
import { loadXiaohongshuState } from "@/lib/xiaohongshu-storage";
import { previewXiaohongshuPromptPayload } from "@/lib/xiaohongshu-engine";
import { loadCoCreateSession } from "@/lib/cocreate-storage";
import { previewCoCreatePromptPayload } from "@/lib/cocreate-engine";
import { previewShoppingPromptPayload } from "@/lib/shopping-engine";
import { previewInterviewMagazinePromptPayload } from "@/lib/interview-magazine-engine";
import { hydrateMapStorage, loadMapWorlds, getLatestSave } from "@/lib/map-storage";
import { previewAdventureCompanionPromptPayload } from "@/lib/map-rpg-engine";
import { getApiLogs, type DebugInfo } from "@/lib/api-log-store";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { BookChapter } from "@/lib/reading-types";
import type { CoCreateMode } from "@/lib/cocreate-types";
import type { MapWorld, GameSave } from "@/lib/map-types";
import { loadVirtualLifeState } from "@/lib/life/life-storage";
import { buildLifeScenePromptContext } from "@/lib/life/life-scene-prompt";
import { loadPhotoWallState } from "@/lib/photo-wall-storage";
import { wallWorldOf } from "@/lib/photo-wall-world";
import { loadMediaBlob } from "@/lib/media-cache-storage";
import { resolveCheckInGuidance } from "@/lib/screenshot/checkin-guidance";
import { buildCheckInLifeContextNote } from "@/lib/screenshot/checkin-engine";
import { loadWidgetConfig, loadWidgetData } from "@/lib/widget/storage";
import { loadBridgeRules } from "@/lib/reality-bridge/storage";


type CoreDebugMode = "chat" | "moments" | "calendar" | "story" | "vn";
type DebugMode = CoreDebugMode | ExtraPromptAppId | "actual";

type UnifiedMessage = {
    role: string;
    content: string | import("@/lib/llm-prompt-assembler").LLMContentPart[];
    marker?: string;
    depth?: number;
    order?: number;
};

type PromptPreviewResult = {
    messages: LLMMessage[];
    characterName: string;
    model: string;
    presetName: string;
};

type FloatingPosition = {
    left: number;
    top: number;
};

type FloatingDragState = FloatingPosition & {
    pointerId: number;
    startClientX: number;
    startClientY: number;
    maxLeft: number;
    maxTop: number;
    moved: boolean;
};

function stringifyContent(content: UnifiedMessage["content"]): string {
    if (typeof content === "string") return content;
    return content.map(p => p.type === "text" ? p.text : "[图片]").join("\n");
}

function splitMarkerBadges(marker?: string): string[] {
    if (!marker) return [];
    return marker.split(" + ").map(part => part.trim()).filter(Boolean);
}

function isExtraPromptMode(mode: DebugMode): mode is ExtraPromptAppId {
    return EXTRA_PROMPT_APPS.some(app => app.id === mode);
}

function createPromptPreviewSession(characterId: string, prefix: string): ChatSession {
    const contact = loadChatContacts().find(item => item.characterId === characterId);
    const session = loadChatSessions().find(item =>
        !item.isGroup && (item.contactId === contact?.id || item.contactId === characterId)
    );
    return session ?? {
        id: `${prefix}-${characterId}`,
        contactId: contact?.id ?? characterId,
        unreadCount: 0,
        updatedAt: new Date().toISOString(),
        isPinned: false,
        isGroup: false,
    };
}

function createPromptPreviewMessage(sessionId: string, content: string, prefix: string): ChatMessage {
    return {
        id: `${prefix}-${Date.now()}`,
        sessionId,
        role: "user",
        content,
        status: "sent",
        createdAt: new Date().toISOString(),
    };
}

export function DebugPromptPanel() {
    const chatState = useSyncExternalStore(subscribeDebugChatState, getDebugChatState, () => null);
    const promptSnapshot = useSyncExternalStore(subscribeDebugPromptSnapshot, getDebugPromptSnapshot, () => null);
    const [collapsed, setCollapsed] = useState(true);
    const [enabled, setEnabled] = useState(false);
    const [mode, setMode] = useState<DebugMode>("chat");
    const [actualLogs, setActualLogs] = useState<DebugInfo[]>([]);
    const [actualSelectedId, setActualSelectedId] = useState("");
    const [floatingPosition, setFloatingPosition] = useState<FloatingPosition | null>(null);
    const [draggingFloatingButton, setDraggingFloatingButton] = useState(false);
    const [floatingDockEnabled, setFloatingDockEnabled] = useState(false);
    const [quickActionEnabled, setQuickActionEnabled] = useState(false);
    const dockState = useSyncExternalStore(subscribeFloatingDockState, getFloatingDockState, getFloatingDockState);
    const floatingDragRef = useRef<FloatingDragState | null>(null);
    const suppressFloatingClickRef = useRef(false);
    const [selectedChatSessionId, setSelectedChatSessionId] = useState("");
    const [followUpMode, setFollowUpMode] = useState(false);
    const [offlinePreviewMode, setOfflinePreviewMode] = useState(false);
    const [offlinePendingText, setOfflinePendingText] = useState("");

    // Moments state
    const [momentsResult, setMomentsResult] = useState<MomentsPreviewResult | null>(null);
    const [momentsType, setMomentsType] = useState<"post" | "comment" | "npc" | "reply">("post");
    const [selectedCharId, setSelectedCharId] = useState<string>("");
    const [selectedPostId, setSelectedPostId] = useState<string>("");

    // Calendar state
    const [calendarResult, setCalendarResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [calendarOwnerId, setCalendarOwnerId] = useState<string>("");
    const [calendarWeekStart, setCalendarWeekStart] = useState<string>(() => getWeekStartIso(new Date()));

    // Story state
    const [storyResult, setStoryResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [storyCharacterId, setStoryCharacterId] = useState<string>("");

    // VN state
    const [vnResult, setVnResult] = useState<{
        messages: LLMMessage[];
        characterName: string;
        model: string;
        presetName: string;
    } | null>(null);
    const [vnCharacterId, setVnCharacterId] = useState<string>("");

    // Extra app state
    const [extraResult, setExtraResult] = useState<PromptPreviewResult | null>(null);
    const [extraAppId, setExtraAppId] = useState<ExtraPromptAppId>("checkphone");
    const [extraCharacterId, setExtraCharacterId] = useState<string>("");
    const [lifePreviewMode, setLifePreviewMode] = useState<"autonomy" | "scene">("autonomy");
    const [photoWallPreviewMode, setPhotoWallPreviewMode] = useState<"annotation" | "doodle">("annotation");
    const [checkInPreviewKind, setCheckInPreviewKind] = useState<"accepted" | "declined" | "timeout" | "failed">("accepted");
    const [watchPreviewMode, setWatchPreviewMode] = useState<"watch" | "review">("watch");
    const [checkPhoneAppId, setCheckPhoneAppId] = useState<CheckPhoneAppId | "manifest">("manifest");
    const [readingBookId, setReadingBookId] = useState<string>("");
    const [readingChapterIndex, setReadingChapterIndex] = useState<string>("");
    const [readingChapters, setReadingChapters] = useState<BookChapter[]>([]);
    const [readingStorageVersion, setReadingStorageVersion] = useState(0);
    const [readingMode, setReadingMode] = useState<"annotate" | "discuss">("annotate");
    const [dwellingMode, setDwellingMode] = useState<DwellingRefreshMode | "explore">("full");
    const [noteWallMode, setNoteWallMode] = useState<"note" | "reply">("note");
    const [xiaohongshuMode, setXiaohongshuMode] = useState<"activity" | "reaction" | "comment" | "mention">("activity");
    const [coCreateMode, setCoCreateMode] = useState<CoCreateMode>("write");
    const [shoppingMode, setShoppingMode] = useState<"catalog" | "search">("catalog");
    const [shoppingQuery, setShoppingQuery] = useState("礼物");
    const [interviewMode, setInterviewMode] = useState<"opening" | "host" | "answer" | "article">("opening");
    const [interviewTheme, setInterviewTheme] = useState("一次关于在场的采访");
    const [adventureWorldId, setAdventureWorldId] = useState<string>("");
    const [adventureStorageVersion, setAdventureStorageVersion] = useState(0);
    const [adventureInstructionMode, setAdventureInstructionMode] = useState<"turn" | "exit">("turn");

    // Shared
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
    const [badgesShownIdx, setBadgesShownIdx] = useState<Set<number>>(new Set());
    const scrollRef = useRef<HTMLDivElement>(null);
    // 聊天存储是异步水合的：面板可能在水合完成前就算出空的会话列表，
    // 之后不点进聊天室依赖不变化，列表永远是空的。这里等水合完成后主动刷新一次。
    const [sessionsVersion, setSessionsVersion] = useState(0);
    useEffect(() => {
        let cancelled = false;
        void hydrateChatStorage().then(() => {
            if (!cancelled) setSessionsVersion(v => v + 1);
        });
        return () => { cancelled = true; };
    }, []);
    const chatSessionOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as { session: ChatSession; label: string }[];
        const sessions = loadChatSessions();
        const chars = loadCharacters();
        const charNameById = new Map(chars.map(c => [c.id, c.name]));
        // 不列出已删除角色的残留单聊，也不列出没有任何有效角色的空群聊。
        return sessions
            .filter(session => session.isGroup
                ? (session.participantIds || []).some(id => charNameById.has(id))
                : charNameById.has(session.contactId))
            .map(session => {
                if (session.isGroup) {
                    const fallbackName = (session.participantIds || [])
                        .map(id => charNameById.get(id))
                        .filter(Boolean)
                        .slice(0, 3)
                        .join("、");
                    return {
                        session,
                        label: `群聊 · ${session.groupName || fallbackName || "未命名群聊"}`,
                    };
                }
                return {
                    session,
                    label: charNameById.get(session.contactId) || session.alias || session.contactId,
                };
            });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, chatState?.session?.id, sessionsVersion, collapsed]);
    const activeChatSession = chatSessionOptions.find(option => option.session.id === selectedChatSessionId)?.session
        ?? chatState?.session
        ?? null;
    const activeChatSnapshot: DebugPromptSnapshot | null = (() => {
        if (!activeChatSession) return null;
        if (!promptSnapshot) return null;
        const appTags = promptSnapshot.appTags || [];
        const isChatRequest = promptSnapshot.appId === "chat"
            || promptSnapshot.appId === "group_chat"
            || appTags.includes("chat")
            || appTags.includes("group_chat");
        if (!isChatRequest) return null;
        if (promptSnapshot.sessionId !== activeChatSession.id) return null;
        return promptSnapshot;
    })();

    const activeExtraSnapshot: DebugPromptSnapshot | null = (() => {
        if (!isExtraPromptMode(mode) || !promptSnapshot) return null;
        const definition = EXTRA_PROMPT_APPS.find(app => app.id === mode);
        if (!definition?.snapshotOnly) return null;
        const retained = (definition.snapshotAppIds ?? [])
            .map(appId => getDebugPromptSnapshotByApp(appId))
            .filter((snapshot): snapshot is DebugPromptSnapshot => Boolean(snapshot))
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
        if (retained) return retained;
        const appIdMatches = definition.snapshotAppIds?.includes(promptSnapshot.appId) ?? false;
        const tagMatches = definition.snapshotTags?.some(tag => promptSnapshot.appTags?.includes(tag)) ?? false;
        return appIdMatches || tagMatches ? promptSnapshot : null;
    })();

    // Clear on mode/session change
    useEffect(() => {
        setMomentsResult(null);
        setCalendarResult(null);
        setStoryResult(null);
        setVnResult(null);
        setExtraResult(null);
        setError(null);
        setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
    }, [activeChatSession?.id, mode, extraAppId, readingMode]);

    useEffect(() => {
        if (selectedChatSessionId && chatSessionOptions.some(option => option.session.id === selectedChatSessionId)) return;
        const nextSessionId = chatState?.session?.id
            ?? chatSessionOptions[0]?.session.id
            ?? "";
        if (nextSessionId !== selectedChatSessionId) setSelectedChatSessionId(nextSessionId);
    }, [chatSessionOptions, chatState?.session?.id, selectedChatSessionId]);

    const handleClosePanel = useCallback(() => {
        setCollapsed(true);
        if (floatingDockEnabled) {
            collapseFloatingDock();
        }
    }, [floatingDockEnabled]);

    useEffect(() => {
        const syncEnabled = (event?: Event) => {
            const detail = (event as CustomEvent | undefined)?.detail;
            const settings = loadChatAppSettings();
            const nextEnabled = typeof detail?.promptViewerEnabled === "boolean"
                ? detail.promptViewerEnabled
                : settings.promptViewerEnabled === true;
            setEnabled(nextEnabled);
            setQuickActionEnabled(typeof detail?.quickActionEnabled === "boolean" ? detail.quickActionEnabled : settings.quickActionEnabled === true);
            setFloatingDockEnabled(typeof detail?.floatingDockEnabled === "boolean" ? detail.floatingDockEnabled : settings.floatingDockEnabled === true);
            if (!nextEnabled) setCollapsed(true);
        };
        syncEnabled();
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnabled);
    }, []);

    useEffect(() => {
        if (collapsed) return;
        const handlePointerDown = (event: PointerEvent) => {
            const panel = document.querySelector(".pv-panel");
            const floatBtn = (event.target as HTMLElement | null)?.closest(".prompt-viewer-float-button");
            if (floatBtn) return;
            if (panel && !panel.contains(event.target as Node)) {
                handleClosePanel();
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        return () => document.removeEventListener("pointerdown", handlePointerDown);
    }, [collapsed, handleClosePanel]);

    useEffect(() => {
        if (mode !== "chat" || !activeChatSnapshot) return;
        setError(null);
        setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
        requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
    }, [activeChatSnapshot?.id, mode]);
    useEffect(() => {
        if (mode !== "actual") return;
        const logs = getApiLogs().slice().reverse();
        setActualLogs(logs);
        setActualSelectedId(current => current && logs.some(log => log.id === current) ? current : (logs[0]?.id ?? ""));
        setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
    }, [mode]);

    // Get unified messages for display.
    const displayMessages: UnifiedMessage[] = (() => {
        if (mode === "chat" && activeChatSnapshot) {
            return activeChatSnapshot.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m.marker,
            }));
        }
        if (mode === "moments" && momentsResult) {
            return momentsResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "calendar" && calendarResult) {
            return calendarResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "story" && storyResult) {
            return storyResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "vn" && vnResult) {
            return vnResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        if (mode === "actual") {
            const log = actualLogs.find(item => item.id === actualSelectedId);
            return log ? log.messages.map(message => ({ role: message.role, content: message.content, marker: message.marker })) : [];
        }
        if (isExtraPromptMode(mode) && activeExtraSnapshot) {
            const messages = activeExtraSnapshot.messages.map(m => ({ role: m.role, content: m.content, marker: m.marker }));
            if (activeExtraSnapshot.tools?.length) {
                messages.push({
                    role: "tools",
                    content: activeExtraSnapshot.tools.map(tool => tool.name + (tool.description ? "： " + tool.description : "")).join("\n"),
                    marker: "本次真实请求允许的工具",
                });
            }
            return messages;
        }
        if (isExtraPromptMode(mode) && extraResult) {
            return extraResult.messages.map(m => ({
                role: m.role,
                content: m.content,
                marker: m._debugMeta?.marker,
                depth: m._debugMeta?.depth,
                order: m._debugMeta?.order,
            }));
        }
        return [];
    })();

    const actualLog = mode === "actual" ? actualLogs.find(item => item.id === actualSelectedId) ?? null : null;
    const resultMeta = mode === "actual"
        ? (actualLog ? { characterName: actualLog.characterName || "实际调用", model: actualLog.model || "", presetName: "实际调用", messages: [] } : null)
        : mode === "chat"
        ? activeChatSnapshot
        : mode === "moments"
            ? momentsResult
            : mode === "calendar"
                ? calendarResult
                : mode === "story"
                    ? storyResult
                    : mode === "vn"
                        ? vnResult
                        : isExtraPromptMode(mode) ? (activeExtraSnapshot ?? extraResult) : extraResult;

    // ── Chat Preview ──
    async function handleChatPreview() {
        if (!activeChatSession) return;
        setError(null);
        setLoading(true);
        try {
            if (offlinePreviewMode) {
                // 线下模式：历史来自「线下轮次」，assistant 内容为 <content>+摘要 XML，
                // 与 chat-room 真实线下生成完全一致（appTags 带 offline）。
                // 空历史也允许预览：看的就是首条线下消息发出前的完整提示词
                const offlineTurns = loadChatOfflineTurns(activeChatSession.id);
                const offlineHistory = buildOfflinePromptHistory(activeChatSession, offlineTurns, offlinePendingText);
                if (activeChatSession.isGroup) {
                    await previewGroupPromptRequestSnapshot(activeChatSession, offlineHistory, {
                        appTags: ["group_chat", "offline"],
                        excludeOfflineSessionId: activeChatSession.id,
                        disableTools: true,
                    });
                } else {
                    await previewPromptRequestSnapshot(activeChatSession, offlineHistory, {
                        appTags: ["chat", "offline"],
                        excludeOfflineSessionId: activeChatSession.id,
                    });
                }
            } else {
                const latestMessages = loadChatMessages(activeChatSession.id);
                if (activeChatSession.isGroup) {
                    await previewGroupPromptRequestSnapshot(activeChatSession, latestMessages);
                } else {
                    await previewPromptRequestSnapshot(
                        activeChatSession,
                        latestMessages,
                        followUpMode
                            ? { followUpAuto: true, appTags: ["chat", "text", "followup"] }
                            : { appTags: ["chat", "text"] }
                    );
                }
            }
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof ChatEngineError ? e.message : String(e));
        } finally {
            setLoading(false);
        }
    }

    // ── Calendar Preview ──
    async function handleCalendarPreview() {
        setError(null);
        setLoading(true);
        try {
            const result = await previewCalendarPromptPayload("character", calendarOwnerId, calendarWeekStart);
            setCalendarResult(result);
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setCalendarResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleStoryPreview() {
        if (!storyCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadStorySessions().find(s => s.characterId === storyCharacterId);
            const history = session ? loadStoryMessages(session.id) : [];
            const result = await previewStoryPromptPayload(storyCharacterId, history, {
                sessionContextExcludedTags: session?.contextExcludedTags,
            });
            setStoryResult(result);
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setStoryResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── VN Preview ──
    async function handleVnPreview() {
        if (!vnCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            const session = loadVnSessions().find(s => s.characterId === vnCharacterId);
            const history = session ? loadVnMessages(session.id) : [];
            const result = await previewVnPromptPayload(vnCharacterId, history);
            setVnResult(result);
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setVnResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Moments Preview ──
    async function handleMomentsPreview() {
        if (!selectedCharId) return;
        setError(null);
        setLoading(true);
        try {
            let result: MomentsPreviewResult | null;
            if (momentsType === "post") {
                result = await previewMomentsPostPrompt(selectedCharId);
            } else {
                if (!selectedPostId) {
                    setError("请先选择一条帖子");
                    setLoading(false);
                    return;
                }
                if (momentsType === "comment") {
                    result = await previewMomentsCommentPrompt(selectedCharId, selectedPostId);
                } else if (momentsType === "npc") {
                    result = await previewMomentsNPCPrompt(selectedCharId, selectedPostId);
                } else {
                    result = await previewMomentsReplyPrompt(selectedCharId, selectedPostId);
                }
            }
            if (!result) {
                setError("无法生成预览，请检查角色是否绑定了API和预设");
                setLoading(false);
                return;
            }
            setMomentsResult(result);
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(String(e));
            setMomentsResult(null);
        } finally {
            setLoading(false);
        }
    }

    async function handleExtraPreview() {
        const previewCharacterId = extraCharacterId || (extraAppId === "phone_widget" ? loadWidgetConfig().characterId : "");
        const requiresCharacter = extraAppId !== "shopping";
        if (requiresCharacter && !previewCharacterId) return;
        setError(null);
        setLoading(true);
        try {
            let result: PromptPreviewResult;
            if (extraAppId === "life") {
                const character = loadCharacters().find(item => item.id === previewCharacterId);
                if (!character) throw new Error("请先选择生活系统中的角色");
                const state = loadVirtualLifeState();
                const activeScene = state.scenes.find(scene =>
                    scene.status === "active" && scene.participants.some(participant =>
                        participant.ownerType === "character" && participant.ownerId === character.id
                    )
                );
                const actor = state.actorStates.find(item => item.ownerType === "character" && item.ownerId === character.id);
                const schedule = state.schedules
                    .filter(item => item.ownerType === "character" && item.ownerId === character.id)
                    .sort((a, b) => a.startAt.localeCompare(b.startAt))
                    .find(item => new Date(item.endAt).getTime() >= Date.now());
                const sceneContext = activeScene
                    ? buildLifeScenePromptContext(state, activeScene, character.id)
                    : [
                        "【生活系统预览：当前没有该角色参与的活动现场】",
                        actor?.activity ? "角色当前活动：" + actor.activity : "",
                        actor?.actualLocationName ? "角色实际地点：" + actor.actualLocationName : "",
                        schedule ? "最近日程：" + schedule.title + "；" + schedule.startAt + "–" + schedule.endAt + "；地点：" + (schedule.plannedLocationName || "未确定") : "当前没有可用的近期日程。",
                    ].filter(Boolean).join("\n");
                const sessionContact = loadChatContacts().find(item => item.characterId === character.id);
                const liveSession = loadChatSessions().find(item => item.contactId === sessionContact?.id && !item.isGroup);
                const session = liveSession ?? createPromptPreviewSession(character.id, "life-preview");
                const prompt = [
                    state.settings.keepDialogueConcise ? "保持简短：一句对白，必要时附一个动作。" : "允许适度展开，但保持实时互动感。",
                    lifePreviewMode === "autonomy"
                        ? "这是生活系统的自主现场回合预览。请以角色身份结合当前生活状态自然发起行动或交流，不要把生活现场写成普通线上聊天。"
                        : "这是生活现场互动回合预览。玩家刚刚在现场发起互动，请结合最近发生的动作、对白和当前场景状态作出回应；不要要求玩家重复已经提供的信息。",
                    state.settings.allowCharactersToStaySilent
                        ? "如果角色不想说话，可以整轮不输出；但没有对白时不要只发 action。"
                        : "本轮需要对玩家的输入作出回应。",
                    state.settings.enableAmbientDetails ? "可以用一两笔简短环境细节营造现场感，不要扩写成长篇旁白。" : "不需要环境氛围描写，直接进行实时互动。",
                    sceneContext,
                    "玩家本轮行动：（预览占位）",
                    "玩家本轮对白：（预览占位）",
                ].filter(Boolean).join("\n\n");
                const history = liveSession
                    ? loadChatMessages(session.id).filter(item => item.status !== "failed" && !item.isRetracted)
                    : [];
                const message = createPromptPreviewMessage(session.id, prompt, "life-preview");
                result = await previewPromptPayload(session, [...history, message], {
                    appId: "life",
                    appTags: ["life", "turn", lifePreviewMode, ...(state.settings.enableCharacterAutonomy ? ["tools"] : [])],
                    includeDirectChatEntries: false,
                });
            } else if (extraAppId === "photo_wall") {
                const character = loadCharacters().find(item => item.id === previewCharacterId);
                if (!character) throw new Error("请先选择照片墙中出镜的角色");
                const wall = loadPhotoWallState();
                if (!wall.photos.length) throw new Error("照片墙目前没有照片，先添加一张照片再预览");
                const photo = wall.photos[0];
                const session = createPromptPreviewSession(character.id, "photo-wall");
                const history = loadChatMessages(session.id).slice(-(photoWallPreviewMode === "annotation" ? 16 : 12));
                let instruction = "";
                let attachedImages: string[] | undefined;
                if (photoWallPreviewMode === "annotation") {
                    instruction = [
                        `照片标题：${photo.title}。`,
                        `照片背面已有内容：${photo.backNote || photo.caption || "还没有写下记录"}。`,
                        `标签：${photo.tags.join("、") || "没有标签"}。`,
                        `照片类型：${({ favorite: "珍藏", selfie: "自拍", candid: "不经意的你", scenery: "沿途风景", object: "喜欢的小物", moment: "共同瞬间" } as Record<string, string>)[photo.kind]}；拍摄者：${photo.ownerName}。`,
                        "请据此写一条照片背面的批注。",
                    ].join("\n");
                    const stored = await loadMediaBlob(photo.mediaRef).catch(() => null);
                    attachedImages = stored ? [await readCompressedImageDataUrl(stored.blob)] : undefined;
                } else {
                    const layout = wall.photos.slice(0, 40).map((item, index) => ({
                        index,
                        title: item.title || "未命名照片",
                        owner: item.ownerName,
                        kind: ({ favorite: "珍藏", selfie: "自拍", candid: "不经意的你", scenery: "沿途风景", object: "喜欢的小物", moment: "共同瞬间" } as Record<string, string>)[item.kind],
                        placement: item.placement ? {
                            x: Number(item.placement.x.toFixed(3)),
                            y: Number(item.placement.y.toFixed(3)),
                            scale: Number(item.placement.scale.toFixed(2)),
                            rotation: item.placement.rotation,
                        } : null,
                    }));
                    instruction = [
                        `你的名字：${character.name}。`,
                        `角色设定：${(character.persona || character.personality || "").slice(0, 500)}`,
                        `画布尺寸：${wallWorldOf(wall).width} × ${wallWorldOf(wall).height}。`,
                        `墙上照片（placement 的 x/y 是照片布局锚点，仅用于估计位置）：${JSON.stringify(layout)}`,
                        "请按要求创作装饰涂鸦 JSON。",
                    ].join("\n");
                }
                const message = createPromptPreviewMessage(session.id, instruction, "photo-wall-preview");
                result = await previewPromptPayload(session, [...history, message], {
                    appId: "photo_wall",
                    appTags: ["photo_wall", photoWallPreviewMode === "annotation" ? "annotation" : "doodle"],
                    toolsAllowed: false,
                    attachedImages,
                });
            } else if (extraAppId === "checkin") {
                const character = loadCharacters().find(item => item.id === previewCharacterId);
                if (!character) throw new Error("请先选择查岗角色");
                const session = createPromptPreviewSession(character.id, "checkin-preview");
                const history = loadChatMessages(session.id);
                const name = character.name || "TA";
                const eventText = checkInPreviewKind === "accepted"
                    ? `[${name}想看看你现在在做什么，你把屏幕给它看了]`
                    : checkInPreviewKind === "declined"
                        ? `[${name}想看看你现在在做什么，你没有给它看]`
                        : checkInPreviewKind === "timeout"
                            ? `[${name}想看看你现在在做什么，你没有回应]`
                            : `[${name}想看看你现在在做什么，但没能截到屏幕（预览模拟失败）]`;
                const eventMessage: ChatMessage = {
                    id: `checkin-event-preview-${Date.now()}`, sessionId: session.id, role: "system",
                    content: eventText, status: "sent", createdAt: new Date().toISOString(),
                };
                const guidance = resolveCheckInGuidance(checkInPreviewKind, name);
                const lifeNote = buildCheckInLifeContextNote(character.id);
                result = await previewPromptPayload(session, [...history, eventMessage], {
                    appId: "checkin",
                    appTags: ["checkin", "screenshot", checkInPreviewKind],
                    ephemeralSystemNote: [guidance, lifeNote].filter(Boolean).join("\n\n"),
                });
            } else if (extraAppId === "watch_together") {
                const character = loadCharacters().find(item => item.id === previewCharacterId);
                if (!character) throw new Error("请先选择一起看的陪看角色");
                type WatchPromptMemory = {
                    title?: string; platform?: string; startedAt?: string; durationSeconds?: number;
                    comments?: string[]; discussion?: Array<{ createdAt?: string; timepoint?: string; kind?: string; characterName?: string; text?: string }>;
                };
                let memory: WatchPromptMemory | null = null;
                try {
                    const raw = JSON.parse(window.localStorage.getItem("ai_phone_watch_memory_records_v1") || "[]") as unknown;
                    memory = Array.isArray(raw) && raw[0] && typeof raw[0] === "object" ? raw[0] as WatchPromptMemory : null;
                } catch { memory = null; }
                const session = createPromptPreviewSession(character.id, "watch-together");
                const history = loadChatMessages(session.id).slice(-8).filter(item => item.status !== "failed" && !item.isRetracted);
                const profile = character as unknown as Record<string, unknown>;
                const roleDetails = [
                    typeof profile.description === "string" ? "角色介绍：" + profile.description : "",
                    typeof profile.personality === "string" ? "性格：" + profile.personality : "",
                    typeof profile.scenario === "string" ? "背景设定：" + profile.scenario : "",
                    typeof profile.systemPrompt === "string" ? "角色设定：" + profile.systemPrompt : "",
                ].filter(Boolean).join("\n").slice(0, 3500);
                const savedMoments = (memory?.discussion?.length
                    ? memory.discussion.map(item => "[" + (item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN") : "已保存") + (item.timepoint ? " · " + item.timepoint : "") + "] " + (item.kind === "user" ? "我" : item.characterName || "角色") + "：" + (item.text || ""))
                    : memory?.comments || []).join("\n").slice(-12000);
                let prompt: string;
                let appTags: string[];
                if (watchPreviewMode === "review") {
                    prompt = [
                        "角色是" + character.name + "。",
                        roleDetails,
                        "视频标题：" + (memory?.title || "暂未命名"),
                        "视频平台：" + (memory?.platform || "未知平台"),
                        "共同观看时间：" + (memory?.startedAt ? new Date(memory.startedAt).toLocaleString("zh-CN") : "本次预览时间"),
                        "本次陪看时长约：" + Math.floor(Math.max(0, Number(memory?.durationSeconds) || 0) / 60) + " 分钟",
                        savedMoments ? "本次真实保存的互动片段：\n" + savedMoments : "本次没有保存具体对话片段。",
                        "请据此写观后感与纪念卡。",
                    ].filter(Boolean).join("\n");
                    appTags = ["watch_together", "review"];
                } else {
                    let watchSettings: { currentMoment?: string } = {};
                    try { watchSettings = JSON.parse(window.localStorage.getItem("ai_phone_watch_together_v1") || "{}") as typeof watchSettings; } catch { /* use defaults */ }
                    prompt = [
                        "视频平台：" + (memory?.platform || "当前陪看平台"),
                        "视频标题（用户可编辑）：" + (memory?.title || "暂未命名") + "。",
                        "用户描述的当前片段/时间点与两人的互动：" + ((watchSettings.currentMoment || "").trim() || "用户暂未提供具体画面描述") + "。",
                        savedMoments ? "本次已保存的互动片段：\n" + savedMoments.slice(-4000) : "",
                        "当前提示词预览没有读取播放器实时截图或未保存字幕；不得声称看见实际画面。只根据用户描述和已有文字互动回应。",
                        "本轮由陪看触发器明确要求你发言，请输出一句自然的角色反应。",
                    ].filter(Boolean).join("\n");
                    appTags = ["watch_together", "watch"];
                }
                const message = createPromptPreviewMessage(session.id, prompt, "watch-preview");
                result = await previewPromptPayload(session, [...history, message], {
                    appId: "watch_together", appTags, toolsAllowed: false,
                });
            } else if (extraAppId === "phone_widget") {
                const characterId = previewCharacterId;
                const character = loadCharacters().find(item => item.id === characterId);
                if (!character) throw new Error("请先选择桌面小组件使用的角色（也可使用小组件当前绑定角色）");
                const previous = loadWidgetData(character.id);
                const trigger = previous?.text
                    ? `请留下一句今天的桌面状态。不要重复上次留在桌面上的话：「${previous.text}」，换一个自然的角度。`
                    : "请留下一句今天的桌面状态。";
                const session: ChatSession = {
                    id: `phone-widget-${character.id}`, contactId: character.id, unreadCount: 0,
                    updatedAt: new Date().toISOString(), isPinned: false, isGroup: false,
                };
                const message = createPromptPreviewMessage(session.id, trigger, "widget-preview");
                result = await previewPromptPayload(session, [message], {
                    appId: "phone_widget", appTags: ["phone_widget", "status"],
                });
            } else if (extraAppId === "reality_bridge") {
                const character = loadCharacters().find(item => item.id === previewCharacterId);
                if (!character) throw new Error("请先选择现实桥规则绑定的角色");
                const rule = loadBridgeRules().find(item => item.actions.chat?.characterId === character.id);
                if (!rule) throw new Error("现实桥还没有绑定这个角色的规则；先在现实桥规则中选择该角色，再回来预览");
                const session = createPromptPreviewSession(character.id, "reality-bridge");
                const history = loadChatMessages(session.id, 30);
                const instruction = [
                    `规则名称：${rule.name || "现实桥联动"}`,
                    `触发信号：${rule.matchType || "任意信号"}`,
                    "事件正文：{payload}（这是运行时会替换的占位符）",
                    "请据此生成离线回复库。",
                ].join("\n");
                const message = createPromptPreviewMessage(session.id, instruction, "reality-bridge-preview");
                result = await previewPromptPayload(session, [...history, message], {
                    appId: "reality_bridge", appTags: ["reality_bridge", "offline_library"],
                });
            } else if (extraAppId === "checkphone") {
                result = await previewCheckPhonePromptPayload(extraCharacterId, checkPhoneAppId);
            } else if (extraAppId === "reading") {
                const book = loadBooks().find(item => item.id === readingBookId);
                const chapter = readingChapters.find(item => String(item.index) === readingChapterIndex);
                if (!book || !chapter) throw new Error("请先选择书籍与章节");
                const annotations = await loadAnnotations(book.id, chapter.index);
                if (readingMode === "discuss") {
                    const session = chatSessionOptions.find(option => !option.session.isGroup && option.session.contactId === extraCharacterId)?.session;
                    if (!session) throw new Error("没有找到这个角色的聊天会话，无法预览阅读对话");
                    result = await previewReadingDiscussPrompt(session, book, {
                        chapterTitle: chapter.title,
                        chapterContent: [
                            "当前阅读中心：整章",
                            "本次上下文范围：整章",
                            "",
                            chapter.paragraphs.map((paragraph, index) => `[${index + 1}] ${paragraph}`).join("\n\n"),
                        ].join("\n"),
                        annotations,
                    }, extraCharacterId);
                } else {
                    result = await previewReadingAnnotationPrompt(book, chapter, annotations, extraCharacterId);
                }
            } else if (extraAppId === "dwelling") {
                result = await previewDwellingPromptPayload(extraCharacterId, dwellingMode);
            } else if (extraAppId === "diary") {
                const entries = loadDiaryEntries().filter(entry => entry.characterId === extraCharacterId);
                result = await previewDiaryEntryPromptPayload(extraCharacterId, entries);
            } else if (extraAppId === "notewall") {
                const wall = await fetchNoteWall().catch(() => ({ notes: [] }));
                const candidates: NoteWallReplyCandidate[] = noteWallMode === "reply"
                    ? await Promise.all(wall.notes.slice(0, 5).map(async note => ({
                        note,
                        comments: await fetchNoteWallComments(note.id).catch(() => []),
                    })))
                    : [];
                result = await previewNoteWallPromptPayload(extraCharacterId, noteWallMode, wall.notes, candidates);
            } else if (extraAppId === "xiaohongshu") {
                const state = loadXiaohongshuState();
                result = await previewXiaohongshuPromptPayload(extraCharacterId, xiaohongshuMode, state.notes, state.settings);
            } else if (extraAppId === "cocreate") {
                const session = loadCoCreateSession(extraCharacterId);
                result = await previewCoCreatePromptPayload(session, coCreateMode);
            } else if (extraAppId === "shopping") {
                result = await previewShoppingPromptPayload(shoppingMode, { query: shoppingQuery });
            } else if (extraAppId === "interview") {
                result = await previewInterviewMagazinePromptPayload({
                    theme: interviewTheme,
                    characterIds: [extraCharacterId],
                    mode: interviewMode,
                    transcript: [],
                });
            } else {
                if (!selectedAdventureSave) throw new Error("请先选择一个有存档的冒险世界");
                const agent = selectedAdventureSave.agents.find(item => item.characterId === extraCharacterId);
                const sharedUserIdentity = selectedAdventureSave.agents.length > 1 ? resolveUserIdentity(undefined, "adventure") : undefined;
                result = await previewAdventureCompanionPromptPayload(
                    extraCharacterId,
                    selectedAdventureSave.streamLog,
                    sharedUserIdentity,
                    agent?.affinity,
                    adventureInstructionMode === "exit"
                        ? { instruction: "{{user}}刚才决定离开当前事件，不再继续。请以你的身份回应{{user}}的离开：你会说什么、有什么反应、接下来是否跟随/挽留/沉默旁观。" }
                        : undefined,
                );
            }
            setExtraResult(result);
            setExpandedIdx(new Set()); setBadgesShownIdx(new Set());
            requestAnimationFrame(() => { scrollRef.current?.scrollTo(0, 0); });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setExtraResult(null);
        } finally {
            setLoading(false);
        }
    }

    // ── Expand/Collapse ──
    function toggleExpand(idx: number) {
        setExpandedIdx(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    }
    function toggleBadges(idx: number) {
        setBadgesShownIdx(prev => {
            const next = new Set(prev);
            if (next.has(idx)) next.delete(idx); else next.add(idx);
            return next;
        });
    }
    function expandAll() { setExpandedIdx(new Set(displayMessages.map((_, i) => i))); }
    function collapseAll() { setExpandedIdx(new Set()); setBadgesShownIdx(new Set()); }
    const allMessagesExpanded = displayMessages.length > 0 && expandedIdx.size === displayMessages.length;

    function clampFloatingPosition(value: number, max: number): number {
        return Math.min(Math.max(value, 12), max);
    }

    function getFloatingButtonBounds(button: HTMLButtonElement, currentPos: FloatingPosition | null) {
        const parent = button.offsetParent instanceof HTMLElement ? button.offsetParent : null;
        const parentRect = parent?.getBoundingClientRect() ?? {
            left: 0,
            top: 0,
            width: window.innerWidth,
            height: window.innerHeight,
        };
        // 始终使用未变换的纯净布局坐标：优先使用 state 中的位置，若初始未拖拽则取 offsetLeft / offsetTop（不受 CSS transform 影响）
        const left = currentPos ? currentPos.left : button.offsetLeft;
        const top = currentPos ? currentPos.top : button.offsetTop;
        return {
            left,
            top,
            maxLeft: Math.max(12, parentRect.width - 56 - 12),
            maxTop: Math.max(12, parentRect.height - 56 - 12),
            parentWidth: parentRect.width,
            parentHeight: parentRect.height,
        };
    }

    function handleFloatingPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
        const isDual = floatingDockEnabled && quickActionEnabled && enabled;
        const isPromptPrimary = !isDual || dockState.primaryTool === "prompt-viewer";
        if (dockState.isExpanded || (isDual && !isPromptPrimary)) {
            // 双球模式下且并非当前停靠主球，或处于展开挑选态时，不接受拖拽
            return;
        }
        event.stopPropagation();
        const button = event.currentTarget;
        const anchor = isDual ? dockState.anchorPosition : null;
        const bounds = getFloatingButtonBounds(button, (isDual && anchor) ? anchor : floatingPosition);
        floatingDragRef.current = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            left: bounds.left,
            top: bounds.top,
            maxLeft: bounds.maxLeft,
            maxTop: bounds.maxTop,
            moved: false,
        };
        // 不在 pointerDown 立即 setDraggingFloatingButton(true)，避免普通点击时瞬间取消 is-docked 产生动画抖动
        button.setPointerCapture(event.pointerId);
    }

    function handleFloatingPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        const deltaX = event.clientX - drag.startClientX;
        const deltaY = event.clientY - drag.startClientY;
        if (!drag.moved) {
            // 超过 3px 移动阈值才判定为拖拽，杜绝手指/鼠标微小震颤把贴边位移写入 floatingPosition
            if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
                drag.moved = true;
                setDraggingFloatingButton(true);
            } else {
                return;
            }
        }
        setFloatingPosition({
            left: clampFloatingPosition(drag.left + deltaX, drag.maxLeft),
            top: clampFloatingPosition(drag.top + deltaY, drag.maxTop),
        });
    }

    function handleFloatingPointerEnd(event: ReactPointerEvent<HTMLButtonElement>) {
        const drag = floatingDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        event.stopPropagation();
        if (drag.moved) {
            suppressFloatingClickRef.current = true;
            if (floatingDockEnabled) {
                const bounds = getFloatingButtonBounds(event.currentTarget, floatingPosition);
                const midX = bounds.parentWidth / 2;
                const currentX = drag.left + (event.clientX - drag.startClientX);
                const currentTop = drag.top + (event.clientY - drag.startClientY);
                const isLeft = currentX < midX;
                const snappedLeft = isLeft ? 18 : Math.max(18, bounds.parentWidth - 56 - 18);
                const snappedTop = clampFloatingPosition(currentTop, bounds.maxTop);
                const newPos = { left: snappedLeft, top: snappedTop };
                setFloatingPosition(newPos);
                setFloatingDockAnchor({ ...newPos, dockSide: isLeft ? "left" : "right" });
                if (collapsed) {
                    collapseFloatingDock();
                }
            }
        }

        floatingDragRef.current = null;
        setDraggingFloatingButton(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
        }
    }

    function handleFloatingButtonClick(event: ReactMouseEvent<HTMLButtonElement>) {
        event.stopPropagation();
        if (suppressFloatingClickRef.current) {
            suppressFloatingClickRef.current = false;
            return;
        }
        if (!collapsed) {
            handleClosePanel();
            return;
        }
        if (floatingDockEnabled) {
            const isDual = quickActionEnabled && enabled;
            const isPromptPrimary = !isDual || dockState.primaryTool === "prompt-viewer";
            // Dual-ball mode: if currently docked as primary and not expanded, clicking expands both balls!
            if (isDual && isPromptPrimary && dockState.isDocked && !dockState.isExpanded) {
                expandFloatingDock();
                return;
            }
            setActiveFloatingTool("prompt-viewer");
        }
        setCollapsed(false);
    }

    function handleModeChange(nextMode: DebugMode) {
        if (isExtraPromptMode(nextMode)) {
            setExtraAppId(nextMode);
        }
        setMode(nextMode);
    }

    const totalChars = displayMessages.reduce((sum, m) => sum + stringifyContent(m.content).length, 0);
    const estimatedTokens = Math.round(totalChars / 2);

    const debugTabs: [DebugMode, string][] = [
        ["chat", activeChatSession?.isGroup ? "群聊" : "聊天"],
        ["moments", "朋友圈"],
        ["calendar", "日历"],
        ["story", "剧情"],
        ["vn", "漫卷"],
        ...EXTRA_PROMPT_APPS.map(app => [app.id, app.label] as [DebugMode, string]),
        ["actual", "实际调用"],
    ];

    // ── Character/Post options for moments (memoized) ──
    const charOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const contacts = loadChatContacts();
        const chars = loadCharacters();
        const map = new Map<string, string>();
        contacts.forEach(c => {
            const name = chars.find(ch => ch.id === c.characterId)?.name;
            if (name) map.set(c.characterId, name);
        });
        chars.forEach(c => map.set(c.id, c.name));
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    }, []);

    const readingBookOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        return loadBooks().map(book => ({ id: book.id, title: book.title }));
    }, [enabled, extraAppId, readingStorageVersion]);

    const adventureWorldOptions = useMemo(() => {
        if (typeof window === "undefined") return [] as MapWorld[];
        return loadMapWorlds().filter(world => world.status !== "generating");
    }, [enabled, extraAppId, adventureStorageVersion]);
    const selectedAdventureWorld = adventureWorldOptions.find(world => world.id === adventureWorldId) ?? null;
    const selectedAdventureSave: GameSave | null = useMemo(
        () => selectedAdventureWorld ? getLatestSave(selectedAdventureWorld.id) : null,
        [selectedAdventureWorld, adventureStorageVersion],
    );

    const postOptions = useMemo(() => {
        if (typeof window === "undefined") return [];
        const posts = getAllPosts();
        const chars = loadCharacters();
        return posts.slice(0, 30).map(p => {
            const authorName = p.authorType === "user" ? "我" : (chars.find(c => c.id === p.authorId)?.name ?? "?");
            return { id: p.id, label: `${authorName}: ${p.content.slice(0, 30)}...` };
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [momentsType]);

    useEffect(() => {
        if (calendarOwnerId || charOptions.length === 0) return;
        setCalendarOwnerId(charOptions[0].id);
    }, [calendarOwnerId, charOptions]);

    useEffect(() => {
        if (extraCharacterId || charOptions.length === 0) return;
        setExtraCharacterId(charOptions[0].id);
    }, [extraCharacterId, charOptions]);

    useEffect(() => {
        if (extraAppId !== "reading") return;
        let cancelled = false;
        hydrateReadingStorage().then(() => {
            if (!cancelled) setReadingStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (readingBookId || readingBookOptions.length === 0) return;
        setReadingBookId(readingBookOptions[0].id);
    }, [readingBookId, readingBookOptions]);

    useEffect(() => {
        let cancelled = false;
        if (!readingBookId) {
            setReadingChapters([]);
            setReadingChapterIndex("");
            return;
        }
        loadChapters(readingBookId).then(chapters => {
            if (cancelled) return;
            setReadingChapters(chapters);
            const currentExists = readingChapterIndex && chapters.some(chapter => String(chapter.index) === readingChapterIndex);
            if (!currentExists) setReadingChapterIndex(chapters[0] ? String(chapters[0].index) : "");
        }).catch(() => {
            if (cancelled) return;
            setReadingChapters([]);
            setReadingChapterIndex("");
        });
        return () => { cancelled = true; };
    }, [readingBookId, readingChapterIndex]);

    useEffect(() => {
        if (extraAppId !== "adventure") return;
        let cancelled = false;
        hydrateMapStorage().then(() => {
            if (!cancelled) setAdventureStorageVersion(version => version + 1);
        }).catch(() => undefined);
        return () => { cancelled = true; };
    }, [extraAppId]);

    useEffect(() => {
        if (adventureWorldId || adventureWorldOptions.length === 0) return;
        setAdventureWorldId(adventureWorldOptions[0].id);
    }, [adventureWorldId, adventureWorldOptions]);

    if (!enabled) return null;

    const isPanelOpen = !collapsed;
    const showFloatingButton = collapsed || floatingDockEnabled;
    const isDual = floatingDockEnabled && quickActionEnabled && enabled;
    const isPromptPrimary = !isDual || dockState.primaryTool === "prompt-viewer";

    const isHiddenBehind = isDual && !isPromptPrimary && !isPanelOpen && !dockState.isExpanded;
    const isDocked = floatingDockEnabled && !isPanelOpen && (
        isPromptPrimary
            ? (dockState.isDocked && !draggingFloatingButton)
            : false
    );
    const isExpanded = floatingDockEnabled && !isPanelOpen && dockState.isExpanded;
    const isPaired = isDual && !isPromptPrimary && !isPanelOpen && dockState.isExpanded;
    const anchor = isDual ? dockState.anchorPosition : null;
    const dockSide = dockState.dockSide;

    const buttonClass = [
        "prompt-viewer-float-button",
        isHiddenBehind ? "is-hidden-behind" : "",
        isDocked ? "is-docked" : "",
        isPanelOpen ? "is-open" : "",
        isExpanded ? "is-expanded" : "",
        isPaired ? "is-paired" : "",
    ].filter(Boolean).join(" ");

    let buttonStyle: CSSProperties | undefined;
    if (draggingFloatingButton && floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual && anchor) {
        buttonStyle = { left: anchor.left, top: anchor.top };
    } else if (floatingPosition) {
        buttonStyle = { left: floatingPosition.left, top: floatingPosition.top };
    } else if (isDual) {
        buttonStyle = { bottom: 148, right: 18 };
    }
    if (isPanelOpen) {
        buttonStyle = { ...buttonStyle, zIndex: 100001 };
    }

    const floatingButton = showFloatingButton ? (
        <button
            type="button"
            className={buttonClass}
            aria-label={isPanelOpen ? "关闭提示词查看器" : "打开提示词查看器"}
            data-positioned={(isDual ? !!anchor : !!floatingPosition) ? "" : undefined}
            data-dragging={draggingFloatingButton ? "" : undefined}
            data-dock-side={floatingDockEnabled ? dockSide : undefined}
            onPointerDown={handleFloatingPointerDown}
            onPointerMove={handleFloatingPointerMove}
            onPointerUp={handleFloatingPointerEnd}
            onPointerCancel={handleFloatingPointerEnd}
            onClick={handleFloatingButtonClick}
            style={buttonStyle}
        >
            <FileText size={24} strokeWidth={1.9} />
        </button>
    ) : null;

    if (collapsed) {
        return floatingButton;
    }

    const renderCharSelect = (value: string, onChange: (v: string) => void) => (
        <select value={value} onChange={e => onChange(e.target.value)} className="pv-select">
            <option value="">选择角色...</option>
            {charOptions.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
    );

    const renderPreviewBtn = (onClick: () => void, disabled: boolean) => (
        <button onClick={onClick} disabled={disabled} className="pv-btn pv-btn-primary">
            {loading ? "加载中..." : "预览"}
        </button>
    );

    const getExtraPreviewWarning = () => {
        if (extraAppId === "reading") {
            return "实际上下文以阅读实际场景注入，不按章节注入，此处仅为模拟";
        }
        if (extraAppId === "dwelling" && dwellingMode === "explore") {
            return "实际上下文以栖所当前点击的房间、家具和物品注入，此处仅用首个物品模拟";
        }
        if (extraAppId === "notewall" && noteWallMode === "reply") {
            return "实际上下文以便签墙真实触发的便签和评论注入，此处仅取候选便签模拟";
        }
        if (extraAppId === "xiaohongshu") {
            return "实际上下文以小红书当前触发的笔记、评论或@注入，此处仅取现有数据模拟";
        }
        if (extraAppId === "cocreate") {
            return "实际上下文以共创当前会话和刚发送内容注入，此处仅基于已保存会话模拟";
        }
        if (extraAppId === "interview") {
            return "实际上下文以在场采访流程和已有转录注入，此处仅用空转录模拟";
        }
        if (extraAppId === "adventure") {
            return "实际上下文以冒险当前事件、队伍状态和本轮行为注入，此处仅基于最近存档模拟";
        }
        if (extraAppId === "life") {
            return "使用当前本机生活状态、活动现场与角色预设组装；不会触发角色行动或写入生活记录。";
        }
        if (extraAppId === "photo_wall") {
            return photoWallPreviewMode === "annotation"
                ? "批注预览使用照片墙第一张照片及其图片（若本机媒体可读取）；不会保存批注。"
                : "涂鸦预览使用当前照片墙布局数据；不会生成或写入涂鸦。";
        }
        if (extraAppId === "checkin") {
            return checkInPreviewKind === "accepted"
                ? "按「同意展示」事件组装；为保护隐私，预览不附带真实屏幕截图。"
                : "按所选查岗结果和一次性指导语组装；不会真正触发查岗或通知角色。";
        }
        if (extraAppId === "watch_together") {
            return watchPreviewMode === "review"
                ? "观后感预览使用最近一条已保存的陪看记录；不会重新读取视频。"
                : "即时陪看预览使用最近保存的视频信息与文字互动；不读取播放器实时截图或未保存字幕。";
        }
        if (extraAppId === "phone_widget") {
            return "使用小组件当前绑定角色与上次桌面状态构造同款触发消息；只预览，不更新桌面。";
        }
        if (extraAppId === "reality_bridge") {
            return "使用当前绑定该角色的第一条规则与 {payload} 占位符；不会执行规则或生成离线回复。";
        }
        return null;
    };

    const renderExtraPreviewWarning = () => {
        const warning = getExtraPreviewWarning();
        return warning ? <span className="pv-context-warning">{warning}</span> : null;
    };

    const renderExtraControls = () => {
        const definition = EXTRA_PROMPT_APPS.find(app => app.id === extraAppId);
        if (definition?.snapshotOnly) {
            return <span className="pv-context-warning">{activeExtraSnapshot
                ? "真实请求 · " + activeExtraSnapshot.appId
                    + (activeExtraSnapshot.appTags?.length ? " · tags: " + activeExtraSnapshot.appTags.join(", ") : "")
                    + " · " + new Date(activeExtraSnapshot.timestamp).toLocaleString("zh-CN")
                    + " · 工具 " + (activeExtraSnapshot.tools?.length ?? 0) + " 项"
                : "此入口只展示真实请求快照，不生成静态假预览。请按下方提示先在对应 APP 触发一次请求。"}
            </span>;
        }
        return (

        <>
            {extraAppId !== "shopping" && renderCharSelect(extraCharacterId, setExtraCharacterId)}
            {extraAppId === "life" && (
                <select value={lifePreviewMode} onChange={e => setLifePreviewMode(e.target.value as "autonomy" | "scene")} className="pv-select">
                    <option value="autonomy">自主现场回合</option>
                    <option value="scene">生活现场回合</option>
                </select>
            )}
            {extraAppId === "photo_wall" && (
                <select value={photoWallPreviewMode} onChange={e => setPhotoWallPreviewMode(e.target.value as "annotation" | "doodle")} className="pv-select">
                    <option value="annotation">照片背面批注</option>
                    <option value="doodle">装饰涂鸦</option>
                </select>
            )}
            {extraAppId === "checkin" && (
                <select value={checkInPreviewKind} onChange={e => setCheckInPreviewKind(e.target.value as typeof checkInPreviewKind)} className="pv-select">
                    <option value="accepted">同意展示屏幕</option>
                    <option value="declined">拒绝展示</option>
                    <option value="timeout">超时未回应</option>
                    <option value="failed">截屏失败</option>
                </select>
            )}
            {extraAppId === "watch_together" && (
                <select value={watchPreviewMode} onChange={e => setWatchPreviewMode(e.target.value as "watch" | "review")} className="pv-select">
                    <option value="watch">陪看即时回应</option>
                    <option value="review">观后感 / 纪念卡</option>
                </select>
            )}
            {extraAppId === "checkphone" && (
                <select value={checkPhoneAppId} onChange={e => setCheckPhoneAppId(e.target.value as CheckPhoneAppId | "manifest")} className="pv-select">
                    <option value="manifest">桌面清单</option>
                    {Object.values(CHECKPHONE_APP_SPECS).map(spec => (
                        <option key={spec.id} value={spec.id}>{spec.label}</option>
                    ))}
                </select>
            )}
            {extraAppId === "reading" && (
                <>
                    <select value={readingMode} onChange={e => setReadingMode(e.target.value as "annotate" | "discuss")} className="pv-select">
                        <option value="annotate">批注</option>
                        <option value="discuss">对话</option>
                    </select>
                    <select value={readingBookId} onChange={e => setReadingBookId(e.target.value)} className="pv-select">
                        <option value="">选择书籍...</option>
                        {readingBookOptions.map(book => <option key={book.id} value={book.id}>{book.title}</option>)}
                    </select>
                    <select value={readingChapterIndex} onChange={e => setReadingChapterIndex(e.target.value)} className="pv-select">
                        <option value="">选择章节...</option>
                        {readingChapters.map(chapter => (
                            <option key={chapter.id} value={String(chapter.index)}>{chapter.title}</option>
                        ))}
                    </select>
                </>
            )}
            {extraAppId === "dwelling" && (
                <select value={dwellingMode} onChange={e => setDwellingMode(e.target.value as DwellingRefreshMode | "explore")} className="pv-select">
                    <option value="full">完整栖所</option>
                    <option value="items">刷新物品</option>
                    <option value="explore">探索物品</option>
                </select>
            )}
            {extraAppId === "notewall" && (
                <select value={noteWallMode} onChange={e => setNoteWallMode(e.target.value as "note" | "reply")} className="pv-select">
                    <option value="note">生成便签</option>
                    <option value="reply">回复便签</option>
                </select>
            )}
            {extraAppId === "xiaohongshu" && (
                <select value={xiaohongshuMode} onChange={e => setXiaohongshuMode(e.target.value as "activity" | "reaction" | "comment" | "mention")} className="pv-select">
                    <option value="activity">浏览互动</option>
                    <option value="reaction">回应用户笔记</option>
                    <option value="comment">回复评论</option>
                    <option value="mention">回复@</option>
                </select>
            )}
            {extraAppId === "cocreate" && (
                <select value={coCreateMode} onChange={e => setCoCreateMode(e.target.value as CoCreateMode)} className="pv-select">
                    <option value="write">写作</option>
                    <option value="discuss">讨论</option>
                </select>
            )}
            {extraAppId === "shopping" && (
                <>
                    <select value={shoppingMode} onChange={e => setShoppingMode(e.target.value as "catalog" | "search")} className="pv-select">
                        <option value="catalog">首页推荐</option>
                        <option value="search">搜索结果</option>
                    </select>
                    {shoppingMode === "search" && (
                        <input value={shoppingQuery} onChange={e => setShoppingQuery(e.target.value)} className="pv-select" placeholder="搜索词" />
                    )}
                </>
            )}
            {extraAppId === "interview" && (
                <>
                    <select value={interviewMode} onChange={e => setInterviewMode(e.target.value as "opening" | "host" | "answer" | "article")} className="pv-select">
                        <option value="opening">开场提问</option>
                        <option value="host">主持人追问</option>
                        <option value="answer">嘉宾回答</option>
                        <option value="article">专栏成稿</option>
                    </select>
                    <input value={interviewTheme} onChange={e => setInterviewTheme(e.target.value)} className="pv-select" placeholder="在场主题" />
                </>
            )}
            {extraAppId === "adventure" && (
                <>
                    <select value={adventureWorldId} onChange={e => setAdventureWorldId(e.target.value)} className="pv-select">
                        <option value="">选择冒险世界...</option>
                        {adventureWorldOptions.map(world => (
                            <option key={world.id} value={world.id}>{world.skeleton.world.name || "未命名世界"}</option>
                        ))}
                    </select>
                    <select value={adventureInstructionMode} onChange={e => setAdventureInstructionMode(e.target.value as "turn" | "exit")} className="pv-select">
                        <option value="turn">角色宣言</option>
                        <option value="exit">离开回应</option>
                    </select>
                </>
            )}
            {renderPreviewBtn(handleExtraPreview, loading || (extraAppId !== "shopping" && !extraCharacterId && !(extraAppId === "phone_widget" && loadWidgetConfig().characterId)))}
            {renderExtraPreviewWarning()}
        </>
        );
    };

    return (
        <>
            {floatingButton}
            <div className="pv-panel" onPointerDown={e => e.stopPropagation()}>
            {/* Header */}
            <div className="pv-header">
                <span className="pv-header-title">提示词查看器</span>
                {resultMeta && <span className="pv-header-meta">{resultMeta.characterName}</span>}
                <span style={{ flex: 1 }} />
                <button type="button" className="pv-close-btn" aria-label="关闭" onClick={(e) => { e.stopPropagation(); handleClosePanel(); }}>
                    <X size={18} strokeWidth={2} />
                </button>
            </div>

            {/* Tabs */}
            <div className="pv-tabs">
                {debugTabs.map(([key, label]) => (
                    <button key={key} className="pv-tab" onClick={() => handleModeChange(key)} {...(mode === key ? { "data-active": "" } : {})}>
                        {label}
                    </button>
                ))}
            </div>
            <div className="pv-divider" />

            {/* Toolbar */}
            <div className="pv-toolbar">
                {mode === "actual" && (
                    <>
                        <select value={actualSelectedId} onChange={e => setActualSelectedId(e.target.value)} className="pv-select">
                            {actualLogs.length === 0 ? <option value="">没有实际调用记录</option> : null}
                            {actualLogs.map(log => <option key={log.id} value={log.id}>{(log.characterName || "未命名") + " · " + (log.model || "未知模型") + " · " + new Date(log.timestamp).toLocaleTimeString("zh-CN") + (log.source === "qa" ? " · 工坊" : "")}</option>)}
                        </select>
                        <button onClick={() => { const logs = getApiLogs().slice().reverse(); setActualLogs(logs); setActualSelectedId(logs[0]?.id ?? ""); }} className="pv-btn">刷新</button>
                    </>
                )}
                {mode === "chat" && (
                    <>
                        <select
                            value={activeChatSession?.id || ""}
                            onChange={e => setSelectedChatSessionId(e.target.value)}
                            className="pv-select"
                        >
                            <option value="">选择聊天...</option>
                            {chatSessionOptions.map(option => (
                                <option key={option.session.id} value={option.session.id}>{option.label}</option>
                            ))}
                        </select>
                        <button onClick={handleChatPreview} disabled={loading || !activeChatSession} className="pv-btn pv-btn-primary">
                            {loading ? "加载中..." : "预览 Prompt"}
                        </button>
                        {activeChatSession && !activeChatSession.isGroup && (
                            <button onClick={() => setFollowUpMode(f => !f)} className="pv-toggle" {...(followUpMode ? { "data-active": "" } : {})}>
                                {followUpMode ? "追发 ON" : "追发 OFF"}
                            </button>
                        )}
                        {activeChatSession && (
                            <>
                                <button onClick={() => { setOfflinePreviewMode(v => !v); }} className="pv-toggle" {...(offlinePreviewMode ? { "data-active": "" } : {})}>
                                    {offlinePreviewMode ? "线下 ON" : "线下 OFF"}
                                </button>
                                {offlinePreviewMode && (
                                    <input
                                        value={offlinePendingText}
                                        onChange={e => setOfflinePendingText(e.target.value)}
                                        className="pv-select"
                                        placeholder="输入下一条线下消息（可选）"
                                    />
                                )}
                            </>
                        )}
                    </>
                )}
                {mode === "moments" && (
                    <>
                        <select value={momentsType} onChange={e => setMomentsType(e.target.value as "post" | "comment" | "npc" | "reply")} className="pv-select">
                            <option value="post">发帖</option>
                            <option value="comment">评论</option>
                            <option value="npc">NPC互动</option>
                            <option value="reply">回复</option>
                        </select>
                        {renderCharSelect(selectedCharId, setSelectedCharId)}
                        {(momentsType !== "post") && (
                            <select value={selectedPostId} onChange={e => setSelectedPostId(e.target.value)} className="pv-select">
                                <option value="">选择帖子...</option>
                                {postOptions.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
                            </select>
                        )}
                        {renderPreviewBtn(handleMomentsPreview, !selectedCharId || loading)}
                    </>
                )}
                {mode === "calendar" && (
                    <>
                        {renderCharSelect(calendarOwnerId, setCalendarOwnerId)}
                        <input type="date" value={calendarWeekStart} onChange={e => setCalendarWeekStart(e.target.value || getWeekStartIso(new Date()))} className="pv-select" />
                        {renderPreviewBtn(handleCalendarPreview, loading || !calendarOwnerId)}
                    </>
                )}
                {mode === "story" && (
                    <>
                        {renderCharSelect(storyCharacterId, setStoryCharacterId)}
                        {renderPreviewBtn(handleStoryPreview, loading || !storyCharacterId)}
                    </>
                )}
                {mode === "vn" && (
                    <>
                        {renderCharSelect(vnCharacterId, setVnCharacterId)}
                        {renderPreviewBtn(handleVnPreview, loading || !vnCharacterId)}
                    </>
                )}
                {isExtraPromptMode(mode) && renderExtraControls()}
                {displayMessages.length > 0 && (
                    <button onClick={allMessagesExpanded ? collapseAll : expandAll} className="pv-btn pv-btn-ghost">
                        {allMessagesExpanded ? "全部折叠" : "全部展开"}
                    </button>
                )}
                {resultMeta && (
                    <span className="pv-toolbar-meta">{resultMeta.model} · {resultMeta.presetName}</span>
                )}
            </div>
            <div className="pv-divider" />

            {/* Body */}
            <div ref={scrollRef} className="pv-body">
                {error && <div className="pv-error">{error}</div>}

                {displayMessages.map((msg, idx) => {
                    const isExpanded = expandedIdx.has(idx);
                    const textContent = stringifyContent(msg.content);
                    const preview = textContent.slice(0, 120);
                    const needsTruncation = textContent.length > 120;
                    const markerBadges = splitMarkerBadges(msg.marker);

                    const badgesVisible = badgesShownIdx.has(idx);

                    return (
                        <div key={idx} className="pv-msg">
                            <div className="pv-msg-header" onClick={() => toggleExpand(idx)}>
                                <span className="pv-msg-role" data-role={msg.role}>{msg.role}</span>
                                {markerBadges.length > 0 && (
                                    <button
                                        type="button"
                                        className="pv-msg-badge-toggle"
                                        aria-label={badgesVisible ? "收起组成标签" : "展开组成标签"}
                                        {...(badgesVisible ? { "data-active": "" } : {})}
                                        onClick={e => { e.stopPropagation(); toggleBadges(idx); }}
                                    >
                                        <Tags size={11} strokeWidth={2} />
                                        {markerBadges.length}
                                    </button>
                                )}
                                {msg.depth !== undefined && (
                                    <span className="pv-msg-depth">D:{msg.depth} O:{msg.order}</span>
                                )}
                                <span style={{ flex: 1 }} />
                                <span className="pv-msg-toggle">
                                    {isExpanded ? "▼" : "▶"} {textContent.length}c
                                </span>
                            </div>
                            {badgesVisible && markerBadges.length > 0 && (
                                <div className="pv-msg-badges">
                                    {markerBadges.map((badge, bi) => (
                                        <span key={`${idx}-${bi}`} className="pv-msg-badge">{badge}</span>
                                    ))}
                                </div>
                            )}
                            <div className="pv-msg-body" style={{
                                maxHeight: isExpanded ? undefined : 60,
                                overflow: isExpanded ? undefined : "hidden",
                            }}>
                                {isExpanded ? textContent : (needsTruncation ? preview + "..." : preview)}
                            </div>
                        </div>
                    );
                })}

                {displayMessages.length === 0 && !error && (
                    <div className="pv-empty">
                        {mode === "chat"
                            ? (activeChatSession
                                ? (offlinePreviewMode ? "点击「预览 Prompt」查看线下模式的真实提示词（含 <content> 与摘要 XML）" : "点击「预览 Prompt」查看下一轮会发送的真实提示词")
                                : "选择聊天对象后点击「预览 Prompt」")
                            : mode === "moments" ? "选择角色后点击「预览」查看朋友圈 Prompt"
                            : mode === "calendar" ? "选择角色与日期后点击「预览」"
                            : mode === "vn" ? "选择角色后点击「预览」查看漫卷 Prompt"
                            : mode === "story" ? "选择角色后点击「预览」查看剧情 Prompt"
                            : mode === "actual"
                                ? (actualLogs.length ? "上方选择一条实际调用查看完整 messages" : "还没有底层模型调用记录。发一次消息、生成一次内容后再来。")
                            : isExtraPromptMode(mode)
                                ? (activeExtraSnapshot ? "已读取最近一次真实请求；消息内容与动态上下文来自该次实际模型调用。" : EXTRA_PROMPT_APPS.find(app => app.id === mode)?.emptyText ?? "选择 APP 后点击「预览」")
                                : "选择 APP 后点击「预览」"
                        }
                    </div>
                )}
            </div>

            {/* Footer */}
            {displayMessages.length > 0 && (
                <>
                    <div className="pv-divider" />
                    <div className="pv-footer">
                        <span>{displayMessages.length} 条消息</span>
                        <span>{totalChars.toLocaleString()} 字符</span>
                        <span>~{estimatedTokens.toLocaleString()} tokens</span>
                    </div>
                </>
            )}
        </div>
        </>
    );
}
