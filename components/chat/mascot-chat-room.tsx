"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertCircle, ChevronLeft, Code, Image as ImageIcon, MessageSquare, MoreHorizontal, RotateCcw, Sparkles, Trash2, UserRound } from "lucide-react";
import { PageShell } from "@/components/ui/page-shell";
import { ConfirmDialog } from "@/components/ui/modal";
import { MediaPreviewOverlay } from "@/components/chat/media-preview-overlay";
import { Input } from "@/components/ui/form";
import CSSSchemeBar from "@/components/ui/css-scheme-picker";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { CHAT_SESSION_CSS_EXAMPLE } from "@/lib/css-examples";
import {
    clearMascotToolHistoryMessages,
    createMascotSession,
    deleteMascotMessageWithLinkedTools,
    deleteMascotSession,
    generateMascotReply,
    sendMascotMessage,
    getMascotChatSnapshot,
    hasMascotToolHistoryMessages,
    hydrateMascotChat,
    renameMascotSession,
    setMascotMessages,
    stopMascotGeneration,
    subscribeMascotChat,
    switchMascotSession,
} from "@/lib/mascot-chat-store";
import type { MascotMsg } from "@/lib/mascot-engine";
import { getMascotContext, subscribeMascotContext } from "@/lib/mascot-context";
import {
    DEFAULT_MASCOT_AVATAR,
    DEFAULT_MASCOT_SETTINGS,
    getMascotSettingsSnapshot,
    resolveMascotImageRef,
    subscribeMascotSettings,
    updateMascotSettings,
} from "@/lib/mascot-settings";
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { UserIdentity } from "@/components/settings/user-identity";
import { EmojiPanel } from "./emoji-panel";
import { BilingualTextBlock } from "./message-bubble";
import { ChatFallbackAvatar } from "./chat-fallback-avatar";
import { CHAT_APP_SETTINGS_UPDATED_EVENT, loadChatAppSettings } from "@/lib/chat-storage";
import { shouldSendChatInputOnEnter } from "@/lib/chat-input-keyboard";
import { useChatBottomReserve } from "./use-chat-bottom-reserve";

type MascotChatRoomProps = {
    onBack: () => void;
    onDeleted?: () => void;
};

type ContextMenuAnchor = {
    x: number;
    y: number;
};

const MASCOT_INITIAL_VISIBLE_MESSAGE_COUNT = 20;
const MASCOT_LOAD_MORE_MESSAGE_COUNT = 20;
const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i;

function isLikelyImageFile(file: File): boolean {
    return file.type.startsWith("image/") || IMAGE_FILE_EXT_RE.test(file.name) || !file.type;
}

function fileToDataUrl(file: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.onload = () => resolve(String(reader.result || ""));
        reader.readAsDataURL(file);
    });
}

function isHiddenMascotPlaceholder(msg: MascotMsg): boolean {
    return msg.role === "mascot" && !!msg.displayText && /^（(调用工具中|无内容)/.test(msg.displayText);
}

function getMascotMessageText(msg: MascotMsg): string {
    return msg.displayText || msg.text || "";
}

function copyTextToClipboard(text: string): void {
    const fallbackCopy = () => {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:-9999px;opacity:0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand("copy"); } catch {}
        document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function MascotAvatar({ src, alt }: { src: string; alt: string }) {
    return (
        <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-white shrink-0 flex items-center justify-center overflow-hidden">
            {src ? <img src={src} className="w-full h-full object-contain p-[2px]" alt={alt} /> : <ChatFallbackAvatar />}
        </div>
    );
}

function UserAvatar({ identity }: { identity: UserIdentity | null }) {
    return (
        <div className="chat-msg-avatar w-[40px] h-[40px] rounded-[20px] bg-[var(--c-page-body-bg)] shrink-0 flex items-center justify-center overflow-hidden">
            {identity?.avatarUrl ? (
                <img src={identity.avatarUrl} alt="Me" className="w-full h-full object-cover rounded-[20px]" />
            ) : (
                <UserRound size={20} color="var(--c-text)" />
            )}
        </div>
    );
}

function MascotInfoIcon({ children, color }: { children: ReactNode; color: string }) {
    return (
        <span className="chat-info-icon" style={{ "--icon-color": color } as CSSProperties}>
            {children}
        </span>
    );
}

function MascotInfoPanel({
    avatarUrl,
    onClose,
    onDeleted,
}: {
    avatarUrl: string;
    onClose: () => void;
    onDeleted?: () => void;
}) {
    const settings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
    const [editingName, setEditingName] = useState(false);
    const [nameDraft, setNameDraft] = useState(settings.nickname);
    const [editingPersona, setEditingPersona] = useState(false);
    const [personaDraft, setPersonaDraft] = useState(settings.personaPrompt);
    const [editingCSS, setEditingCSS] = useState(false);
    const [cssDraft, setCssDraft] = useState(settings.chatCustomCSS || "");
    const [showConfirmClearTools, setShowConfirmClearTools] = useState(false);
    const [showConfirmDelete, setShowConfirmDelete] = useState(false);
    const chat = useSyncExternalStore(subscribeMascotChat, getMascotChatSnapshot, getMascotChatSnapshot);
    const hasToolHistory = hasMascotToolHistoryMessages(chat.messages);
    const hasCustomAvatar = !!settings.avatarImage && settings.avatarImage !== DEFAULT_MASCOT_AVATAR;

    useEffect(() => {
        setNameDraft(settings.nickname);
        setPersonaDraft(settings.personaPrompt);
        setCssDraft(settings.chatCustomCSS || "");
    }, [settings.nickname, settings.personaPrompt, settings.chatCustomCSS]);

    const saveUploadedImage = async (file: File, field: "avatarImage" | "chatBackgroundImage") => {
        try {
            const { saveChatImageToIndexedDB } = await import("@/lib/chat-asset-storage");
            const id = await saveChatImageToIndexedDB(file);
            updateMascotSettings({ [field]: id });
        } catch (error) {
            console.error("[MascotInfo] save image failed:", error);
            alert("图片保存失败，请重试");
        }
    };

    const handleClearToolHistory = () => {
        const result = clearMascotToolHistoryMessages(chat.messages);
        setMascotMessages(result.messages);
        setShowConfirmClearTools(false);
        window.dispatchEvent(new CustomEvent("global-notice", {
            detail: result.deletedMessages + result.cleanedMessages > 0
                ? `已清理 ${result.deletedMessages} 条工具记录，整理 ${result.cleanedMessages} 条消息。`
                : "没有可清理的工具调用历史。",
        }));
    };

    return (
        <PageShell title="AI助手信息" onBack={onClose} className="absolute inset-0 z-[100]">
            <div className="page-menu chat-info-menu">
                <div className="menu-group">
                    <label className="menu-item">
                        <MascotInfoIcon color="var(--c-icon-active)"><ImageIcon size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group">
                            <span className="menu-label">修改形象</span>
                            <span className="menu-desc">用于桌面小组件、悬浮窗和聊天头像</span>
                        </div>
                        <div className="menu-right">
                            {hasCustomAvatar ? (
                                <button
                                    type="button"
                                    className="menu-desc mr-2 text-[var(--c-danger)]"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        updateMascotSettings({ avatarImage: DEFAULT_MASCOT_AVATAR });
                                    }}
                                >
                                    清除
                                </button>
                            ) : null}
                            <span className="w-9 h-9 rounded-full overflow-hidden bg-white flex items-center justify-center">
                                <img src={avatarUrl} className="w-full h-full object-contain p-[2px]" alt="" />
                            </span>
                        </div>
                        <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = "";
                                if (file) void saveUploadedImage(file, "avatarImage");
                            }}
                        />
                    </label>
                    <button className="menu-item" onClick={() => setEditingName(true)}>
                        <MascotInfoIcon color="var(--c-action-blue,#246bfd)"><MessageSquare size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group"><span className="menu-label">修改昵称</span></div>
                        <div className="menu-right"><span className="menu-desc mr-1">{settings.nickname}</span></div>
                    </button>
                    <button className="menu-item" onClick={() => setEditingPersona(true)}>
                        <MascotInfoIcon color="var(--c-icon-active)"><UserRound size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group">
                            <span className="menu-label">主人格提示词</span>
                            <span className="menu-desc">完整替换 AI助手的人格底层提示词</span>
                        </div>
                    </button>
                </div>

                <div className="menu-group">
                    <label className="menu-item">
                        <MascotInfoIcon color="var(--c-action-blue,#246bfd)"><ImageIcon size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group"><span className="menu-label">聊天背景</span></div>
                        <div className="menu-right">
                            {settings.chatBackgroundImage ? (
                                <button
                                    type="button"
                                    className="menu-desc mr-1 text-[var(--c-danger)]"
                                    onClick={(event) => {
                                        event.preventDefault();
                                        updateMascotSettings({ chatBackgroundImage: "" });
                                    }}
                                >
                                    清除
                                </button>
                            ) : null}
                        </div>
                        <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = "";
                                if (file) void saveUploadedImage(file, "chatBackgroundImage");
                            }}
                        />
                    </label>
                    <button className="menu-item" onClick={() => setEditingCSS(true)}>
                        <MascotInfoIcon color="var(--c-icon-active)"><Code size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group"><span className="menu-label">自定义 CSS 样式</span></div>
                        <div className="menu-right">{settings.chatCustomCSS ? <span className="menu-desc mr-1">已设置</span> : null}</div>
                    </button>
                </div>

                <div className="menu-group">
                    <button
                        className="menu-item"
                        disabled={chat.isThinking || !hasToolHistory}
                        onClick={() => {
                            if (!chat.isThinking && hasToolHistory) setShowConfirmClearTools(true);
                        }}
                        style={chat.isThinking || !hasToolHistory ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <MascotInfoIcon color="var(--c-danger)"><Code size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">清理原生tool调用历史——防报错</span>
                            <span className="menu-desc">
                                {chat.isThinking ? "AI助手执行中，完成后再清理" : "切换到文本协议 API 前使用"}
                            </span>
                        </div>
                    </button>
                    <button
                        className="menu-item"
                        disabled={!chat.hydrated || chat.isThinking}
                        onClick={() => {
                            const id = createMascotSession();
                            if (id) onClose();
                        }}
                        style={!chat.hydrated || chat.isThinking ? { opacity: 0.55, cursor: "not-allowed" } : undefined}
                    >
                        <MascotInfoIcon color="var(--c-icon-active)"><RotateCcw size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group">
                            <span className="menu-label">开启新对话</span>
                            <span className="menu-desc">保留当前记录，创建一段独立对话</span>
                        </div>
                    </button>
                    {chat.sessions.map((session) => {
                        const active = session.id === chat.activeSessionId;
                        return (
                            <div className="menu-item" key={session.id} style={{ gap: 8 }}>
                                <MascotInfoIcon color={active ? "var(--c-icon-active)" : "var(--c-text-secondary)"}>
                                    <MessageSquare size={21} strokeWidth={1.75} />
                                </MascotInfoIcon>
                                <button
                                    type="button"
                                    className="menu-label-group min-w-0 flex-1 text-left"
                                    disabled={chat.isThinking || active}
                                    onClick={() => {
                                        if (switchMascotSession(session.id)) onClose();
                                    }}
                                    style={{ opacity: chat.isThinking ? 0.55 : 1 }}
                                >
                                    <span className="menu-label truncate">{session.title}{active ? "（当前）" : ""}</span>
                                    <span className="menu-desc">{new Date(session.updatedAt).toLocaleString()}</span>
                                </button>
                                <button
                                    type="button"
                                    className="menu-desc shrink-0"
                                    disabled={chat.isThinking}
                                    onClick={() => {
                                        const title = window.prompt("重命名对话", session.title);
                                        if (title !== null) renameMascotSession(session.id, title);
                                    }}
                                >改名</button>
                                <button
                                    type="button"
                                    className="menu-desc shrink-0 text-[var(--c-danger)]"
                                    disabled={chat.isThinking}
                                    onClick={() => {
                                        if (window.confirm(`确定删除对话“${session.title}”吗？此操作不会删除角色卡，但无法恢复这段聊天记录。`)) {
                                            deleteMascotSession(session.id);
                                        }
                                    }}
                                >删除</button>
                            </div>
                        );
                    })}
                    <button className="menu-item" onClick={() => setShowConfirmDelete(true)}>
                        <MascotInfoIcon color="var(--c-danger)"><Trash2 size={22} strokeWidth={1.75} /></MascotInfoIcon>
                        <div className="menu-label-group">
                            <span className="menu-label menu-label-danger">从聊天中删除 AI助手</span>
                            <span className="menu-desc">删除后可在添加好友里重新添加，不会触发打招呼</span>
                        </div>
                    </button>
                </div>
            </div>

            {editingName && (
                <div className="modal-overlay">
                    <div className="modal-dialog">
                        <div className="ts-17 font-semibold text-center text-[var(--c-text)]">修改昵称</div>
                        <Input value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} placeholder="AI助手" />
                        <div className="flex gap-3 w-full">
                            <button className="ui-btn ui-btn-ghost flex-1" onClick={() => setEditingName(false)}>取消</button>
                            <button
                                className="ui-btn ui-btn-success flex-1"
                                onClick={() => {
                                    updateMascotSettings({ nickname: nameDraft.trim() || "AI助手" });
                                    setEditingName(false);
                                }}
                            >
                                保存
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {editingPersona && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="主人格提示词" onBack={() => setEditingPersona(false)}>
                        <div className="theme-section-page">
                            <textarea
                                className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                                style={{ minHeight: 420, resize: "none", scrollbarWidth: "none" }}
                                value={personaDraft}
                                onChange={(event) => setPersonaDraft(event.target.value)}
                                spellCheck={false}
                            />
                            <div className="flex gap-2 mt-3">
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setPersonaDraft(DEFAULT_MASCOT_SETTINGS.personaPrompt)}>默认</button>
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setPersonaDraft("")}>清空</button>
                                <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={() => { updateMascotSettings({ personaPrompt: personaDraft }); setEditingPersona(false); }}>保存</button>
                            </div>
                        </div>
                    </PageShell>
                </div>
                </div>
            )}

            {editingCSS && (
                <div style={{ position: "absolute", inset: 0, zIndex: 9999, background: "#ffffff" }}>
                <div style={{ position: "absolute", inset: 0, background: "var(--c-page-body-bg)" }}>
                    <PageShell title="自定义 CSS" onBack={() => setEditingCSS(false)}>
                        <div className="theme-section-page">
                            <p className="ts-13 text-[var(--c-text)] mb-3 leading-relaxed">
                                支持 :root 变量和选择器，仅作用于 AI助手聊天室。CSS 方案与普通聊天室共用。
                            </p>
                            <textarea
                                className="ui-textarea font-mono ts-13 leading-relaxed flex-1"
                                style={{ minHeight: 280, resize: "none", scrollbarWidth: "none" }}
                                placeholder={`:root {\n  --c-bubble-self: #95ec69;\n}\n\n.chat-bubble-role-user {\n  border-radius: 6px;\n}\n\n.chat-html-inline-frame {\n  max-height: min(36vh, 340px);\n}`}
                                value={cssDraft}
                                onChange={(event) => setCssDraft(event.target.value)}
                                spellCheck={false}
                            />
                            <div className="flex gap-2 mt-3 items-center">
                                <CSSSchemeBar target="chat_session" currentCSS={cssDraft} onLoad={setCssDraft} />
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCssDraft(CHAT_SESSION_CSS_EXAMPLE)}>示例</button>
                                <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => setCssDraft("")}>清除</button>
                                <button type="button" className="ui-btn ui-btn-soft-action flex-1" onClick={() => { updateMascotSettings({ chatCustomCSS: cssDraft }); setEditingCSS(false); }}>应用</button>
                            </div>
                        </div>
                    </PageShell>
                </div>
                </div>
            )}

            {showConfirmClearTools && (
                <ConfirmDialog
                    title="清理工具调用历史？"
                    message="将移除 AI助手会话中的工具调用记录、工具结果记录，并清除助手消息里的原生工具调用元数据。普通对话内容不会删除。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="清理"
                    cancelLabel="取消"
                    onConfirm={handleClearToolHistory}
                    onCancel={() => setShowConfirmClearTools(false)}
                />
            )}

            {showConfirmDelete && (
                <ConfirmDialog
                    title="从聊天中删除 AI助手？"
                    message="删除后它不会出现在聊天列表和联系人中。之后可在添加好友页面重新添加，不会触发打招呼或自动回复。"
                    icon={AlertCircle}
                    variant="danger"
                    confirmLabel="删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        updateMascotSettings({ chatEnabled: false });
                        setShowConfirmDelete(false);
                        onDeleted?.();
                    }}
                    onCancel={() => setShowConfirmDelete(false)}
                />
            )}
        </PageShell>
    );
}

export function MascotChatRoom({ onBack, onDeleted }: MascotChatRoomProps) {
    const chat = useSyncExternalStore(subscribeMascotChat, getMascotChatSnapshot, getMascotChatSnapshot);
    const settings = useSyncExternalStore(subscribeMascotSettings, getMascotSettingsSnapshot, getMascotSettingsSnapshot);
    const context = useSyncExternalStore(subscribeMascotContext, getMascotContext, getMascotContext);
    const [avatarUrl, setAvatarUrl] = useState(settings.avatarImage || DEFAULT_MASCOT_AVATAR);
    const [backgroundUrl, setBackgroundUrl] = useState("");
    const [inputText, setInputText] = useState("");
    const [pendingImages, setPendingImages] = useState<string[]>([]);
    const [imagePreviewCache, setImagePreviewCache] = useState<Record<string, string>>({});
    const [showEmojiPanel, setShowEmojiPanel] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [initialScrollReady, setInitialScrollReady] = useState(false);
    const [visibleMascotMessageCount, setVisibleMascotMessageCount] = useState(MASCOT_INITIAL_VISIBLE_MESSAGE_COUNT);
    const [activeMascotMessageIndex, setActiveMascotMessageIndex] = useState<number | null>(null);
    const [contextMenuAnchor, setContextMenuAnchor] = useState<ContextMenuAnchor | null>(null);
    const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
    const [enterToSendEnabled, setEnterToSendEnabled] = useState(() => loadChatAppSettings().enterToSendEnabled === true);
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const bottomScrollTimersRef = useRef<number[]>([]);
    const loadMoreRestoreRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
    const stickToBottomRef = useRef(true);
    const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longPressStartRef = useRef<ContextMenuAnchor | null>(null);
    const longPressTriggeredRef = useRef(false);
    const identity = useMemo(() => resolveUserIdentity(), []);
    useChatBottomReserve(wrapperRef, scrollRef, `${showEmojiPanel}:${pendingImages.length}`);
    const allVisibleMessageEntries = useMemo(() => (
        chat.messages
            .map((msg, rawIndex) => ({ msg, rawIndex }))
            .filter(({ msg }) => !msg.hidden && !isHiddenMascotPlaceholder(msg))
    ), [chat.messages]);
    const visibleMessageEntries = useMemo(() => (
        allVisibleMessageEntries.slice(-visibleMascotMessageCount)
    ), [allVisibleMessageEntries, visibleMascotMessageCount]);
    const hasMoreMascotMessages = allVisibleMessageEntries.length > visibleMessageEntries.length;
    const latestVisibleChatMessage = [...chat.messages].reverse().find((msg) => !msg.hidden && msg.role !== "tool");
    const canGenerateReply = !chat.isThinking && latestVisibleChatMessage?.role === "user";
    const scrollSignature = useMemo(() => {
        const last = visibleMessageEntries[visibleMessageEntries.length - 1]?.msg;
        const lastText = last ? getMascotMessageText(last) : "";
        return [
            visibleMessageEntries.length,
            chat.isThinking ? 1 : 0,
            last?.role || "",
            lastText.length,
            last?.images?.length || 0,
        ].join(":");
    }, [chat.isThinking, visibleMessageEntries]);
    const imageLoadSignature = useMemo(() => {
        const refs: string[] = [];
        for (const { msg } of visibleMessageEntries) {
            refs.push(...(msg.images || []));
        }
        const loaded = refs.filter((ref) => ref.startsWith("data:") || !!imagePreviewCache[ref]).length;
        return `${refs.length}:${loaded}`;
    }, [imagePreviewCache, visibleMessageEntries]);

    useEffect(() => {
        const syncEnterToSend = () => {
            setEnterToSendEnabled(loadChatAppSettings().enterToSendEnabled === true);
        };
        window.addEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
        return () => window.removeEventListener(CHAT_APP_SETTINGS_UPDATED_EVENT, syncEnterToSend);
    }, []);

    useEffect(() => {
        void hydrateMascotChat();
    }, []);

    useEffect(() => {
        let cancelled = false;
        resolveMascotImageRef(settings.avatarImage).then((url) => {
            if (!cancelled) setAvatarUrl(url);
        });
        return () => { cancelled = true; };
    }, [settings.avatarImage]);

    useEffect(() => {
        let cancelled = false;
        resolveMascotImageRef(settings.chatBackgroundImage, "").then((url) => {
            if (!cancelled) setBackgroundUrl(url);
        });
        return () => { cancelled = true; };
    }, [settings.chatBackgroundImage]);

    useEffect(() => {
        const refs = new Set<string>();
        for (const msg of chat.messages) {
            for (const ref of msg.images || []) refs.add(ref);
        }
        for (const ref of pendingImages) refs.add(ref);
        const missing = [...refs].filter((ref) => !imagePreviewCache[ref]);
        if (missing.length === 0) return;
        let cancelled = false;
        (async () => {
            const { loadMediaObjectUrl } = await import("@/lib/media-cache-storage");
            const updates: Record<string, string> = {};
            for (const ref of missing) {
                if (ref.startsWith("data:")) {
                    updates[ref] = ref;
                    continue;
                }
                const url = await loadMediaObjectUrl(ref);
                if (cancelled) return;
                if (url) updates[ref] = url;
            }
            if (!cancelled && Object.keys(updates).length > 0) {
                setImagePreviewCache((prev) => ({ ...prev, ...updates }));
            }
        })();
        return () => { cancelled = true; };
    }, [chat.messages, pendingImages, imagePreviewCache]);

    const scrollMascotChatToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        stickToBottomRef.current = true;
    }, []);

    const updateMascotStickToBottom = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }, []);

    const scheduleMascotBottomScroll = useCallback((revealAfterScroll = false) => {
        const run = () => scrollMascotChatToBottom();
        if (typeof window !== "undefined") {
            for (const timer of bottomScrollTimersRef.current) window.clearTimeout(timer);
            bottomScrollTimersRef.current = [];
        }
        run();
        requestAnimationFrame(() => {
            run();
            requestAnimationFrame(() => {
                run();
                if (revealAfterScroll) setInitialScrollReady(true);
            });
        });
        if (typeof window !== "undefined") {
            const timers = bottomScrollTimersRef.current;
            timers.push(window.setTimeout(run, 80));
            timers.push(window.setTimeout(run, 220));
        }
    }, [scrollMascotChatToBottom]);

    const handleMascotImageLoad = useCallback(() => {
        if (!stickToBottomRef.current) return;
        scheduleMascotBottomScroll();
    }, [scheduleMascotBottomScroll]);

    useLayoutEffect(() => {
        if (!chat.hydrated) return;
        const restore = loadMoreRestoreRef.current;
        if (restore) {
            const el = scrollRef.current;
            if (el) {
                el.scrollTop = restore.scrollTop + (el.scrollHeight - restore.scrollHeight);
            }
            loadMoreRestoreRef.current = null;
            return;
        }
        scheduleMascotBottomScroll(!initialScrollReady);
    }, [chat.hydrated, imageLoadSignature, initialScrollReady, scheduleMascotBottomScroll, scrollSignature, visibleMascotMessageCount]);

    useEffect(() => () => {
        for (const timer of bottomScrollTimersRef.current) window.clearTimeout(timer);
        bottomScrollTimersRef.current = [];
    }, []);

    useEffect(() => {
        if (activeMascotMessageIndex === null) return;
        if (!chat.messages[activeMascotMessageIndex]) {
            setActiveMascotMessageIndex(null);
            setContextMenuAnchor(null);
        }
    }, [activeMascotMessageIndex, chat.messages]);

    useEffect(() => {
        if (!chat.isThinking) return;
        setActiveMascotMessageIndex(null);
        setContextMenuAnchor(null);
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, [chat.isThinking]);

    const handlePickImages = useCallback(async (files: File[] | FileList | null) => {
        if (!files || files.length === 0) return;
        const refs: string[] = [];
        const previews: Record<string, string> = {};
        for (const file of Array.from(files)) {
            if (!isLikelyImageFile(file)) continue;
            try {
                const ref = await fileToDataUrl(file);
                refs.push(ref);
                previews[ref] = ref;
            } catch (error) {
                console.warn("[MascotChatRoom] image read failed:", error);
            }
        }
        if (refs.length > 0) {
            setImagePreviewCache((prev) => ({ ...prev, ...previews }));
            setPendingImages((prev) => [...prev, ...refs].slice(0, 4));
        }
    }, []);

    const resizeTextarea = () => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    };

    const appendEmoji = (emoji: string) => {
        setInputText((prev) => prev + emoji);
        requestAnimationFrame(() => {
            resizeTextarea();
            textareaRef.current?.focus();
        });
    };

    const handleSend = async () => {
        if (chat.isThinking) {
            stopMascotGeneration();
            return;
        }
        const text = inputText.trim();
        if (!text && pendingImages.length === 0) return;
        setInputText("");
        textareaRef.current?.style.setProperty("height", "auto");
        const images = pendingImages;
        setPendingImages([]);
        setShowEmojiPanel(false);
        await sendMascotMessage({ text, images, context });
    };

    const handleGenerateReply = async () => {
        if (!canGenerateReply) return;
        setShowEmojiPanel(false);
        await generateMascotReply({ context });
    };

    const closeMascotContextMenu = useCallback(() => {
        setActiveMascotMessageIndex(null);
        setContextMenuAnchor(null);
    }, []);

    const handleLoadMoreMascotMessages = useCallback(() => {
        if (!hasMoreMascotMessages) return;
        const el = scrollRef.current;
        if (el) {
            loadMoreRestoreRef.current = {
                scrollHeight: el.scrollHeight,
                scrollTop: el.scrollTop,
            };
        }
        stickToBottomRef.current = false;
        closeMascotContextMenu();
        setVisibleMascotMessageCount((prev) => Math.min(
            prev + MASCOT_LOAD_MORE_MESSAGE_COUNT,
            allVisibleMessageEntries.length,
        ));
    }, [allVisibleMessageEntries.length, closeMascotContextMenu, hasMoreMascotMessages]);

    const openMascotContextMenu = useCallback((rawIndex: number, anchor: ContextMenuAnchor) => {
        if (chat.isThinking) return;
        setContextMenuAnchor(anchor);
        setActiveMascotMessageIndex(rawIndex);
    }, [chat.isThinking]);

    const cancelMascotLongPress = useCallback(() => {
        longPressStartRef.current = null;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const handleMascotMessagePointerDown = useCallback((event: ReactPointerEvent, rawIndex: number) => {
        if (chat.isThinking) return;
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const anchor = { x: event.clientX, y: event.clientY };
        longPressStartRef.current = anchor;
        longPressTriggeredRef.current = false;
        if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            openMascotContextMenu(rawIndex, anchor);
            longPressTimerRef.current = null;
        }, 500);
    }, [chat.isThinking, openMascotContextMenu]);

    const handleMascotMessagePointerUp = useCallback((event: ReactPointerEvent) => {
        longPressStartRef.current = null;
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        if (longPressTriggeredRef.current) {
            event.preventDefault();
            event.stopPropagation();
            longPressTriggeredRef.current = false;
        }
    }, []);

    const handleMascotMessagePointerMove = useCallback((event: ReactPointerEvent) => {
        if (!longPressStartRef.current) return;
        const dx = Math.abs(event.clientX - longPressStartRef.current.x);
        const dy = Math.abs(event.clientY - longPressStartRef.current.y);
        if (dx > 10 || dy > 10) cancelMascotLongPress();
    }, [cancelMascotLongPress]);

    const getContextMenuInitialStyle = useCallback((): CSSProperties => {
        if (!contextMenuAnchor) return { left: 0, top: 0 };
        return { left: contextMenuAnchor.x, top: Math.max(8, contextMenuAnchor.y - 70) };
    }, [contextMenuAnchor]);

    const positionFloatingContextMenu = useCallback((el: HTMLDivElement | null) => {
        if (!el || !contextMenuAnchor) return;
        const margin = 8;
        const gap = 12;
        const menuW = el.offsetWidth;
        const menuH = el.offsetHeight;
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        let left = contextMenuAnchor.x - menuW / 2;
        left = Math.max(margin, Math.min(left, viewportW - menuW - margin));
        const placeBelow = contextMenuAnchor.y - menuH - gap < margin;
        let top = placeBelow ? contextMenuAnchor.y + gap : contextMenuAnchor.y - menuH - gap;
        top = Math.max(margin, Math.min(top, viewportH - menuH - margin));
        el.style.left = `${left}px`;
        el.style.top = `${top}px`;
        el.style.right = "auto";
        el.style.bottom = "auto";
        const tri = el.querySelector("[data-menu-triangle]") as HTMLElement | null;
        if (!tri) return;
        const triLeft = Math.max(14, Math.min(contextMenuAnchor.x - left, menuW - 14));
        tri.style.left = `${triLeft}px`;
        tri.style.right = "auto";
        tri.style.transform = "translateX(-50%)";
        if (placeBelow) {
            tri.style.top = "-6px";
            tri.style.bottom = "auto";
            tri.style.borderTop = "none";
            tri.style.borderBottom = "6px solid var(--ctx-menu-bg, #2c2c2c)";
        } else {
            tri.style.top = "auto";
            tri.style.bottom = "-6px";
            tri.style.borderBottom = "none";
            tri.style.borderTop = "6px solid var(--ctx-menu-bg, #2c2c2c)";
        }
    }, [contextMenuAnchor]);

    const handleCopyMascotMessage = useCallback((rawIndex: number) => {
        const msg = chat.messages[rawIndex];
        if (!msg) return;
        const text = getMascotMessageText(msg).trim() || (msg.images?.length ? "[图片]" : "");
        if (text) copyTextToClipboard(text);
        closeMascotContextMenu();
    }, [chat.messages, closeMascotContextMenu]);

    const handleDeleteMascotMessage = useCallback((rawIndex: number) => {
        if (chat.isThinking) {
            window.dispatchEvent(new CustomEvent("global-notice", { detail: "AI助手正在回复，完成后再删除消息。" }));
            closeMascotContextMenu();
            return;
        }
        const result = deleteMascotMessageWithLinkedTools(chat.messages, rawIndex);
        if (result.deletedMessages > 0 || result.cleanedMessages > 0) {
            setMascotMessages(result.messages);
        }
        closeMascotContextMenu();
    }, [chat.isThinking, chat.messages, closeMascotContextMenu]);

    const renderMascotContextMenu = (rawIndex: number, role: MascotMsg["role"]) => {
        if (activeMascotMessageIndex !== rawIndex) return null;
        const menu = (
            <div
                onPointerDown={(event) => event.stopPropagation()}
                ref={positionFloatingContextMenu}
                style={getContextMenuInitialStyle()}
                className="ctx-menu chat-floating-ctx-menu flex py-[6px] px-0"
                data-role={role === "user" ? "user" : "assistant"}
            >
                <button type="button" onClick={() => handleCopyMascotMessage(rawIndex)} className="ctx-menu-btn">复制</button>
                <button type="button" onClick={() => handleDeleteMascotMessage(rawIndex)} className="ctx-menu-btn ctx-menu-btn-danger">删除</button>
                <div data-menu-triangle className="ctx-menu-triangle absolute -top-[6px] w-0 h-0" />
            </div>
        );
        return wrapperRef.current ? createPortal(menu, wrapperRef.current) : menu;
    };

    const chatRoomBackgroundStyle = backgroundUrl ? {
        backgroundColor: "#fff",
        backgroundImage: `url(${backgroundUrl})`,
        backgroundPosition: "center",
        backgroundSize: "cover",
        backgroundRepeat: "no-repeat",
    } : undefined;

    const renderImages = (msg: MascotMsg) => {
        if (!msg.images?.length) return null;
        return (
            <div className="mascot-inline-images">
                {msg.images.map((ref, idx) => {
                    const url = imagePreviewCache[ref] || (ref.startsWith("data:") ? ref : "");
                    if (!url) return <span key={idx} className="mascot-inline-image-loading" />;
                    return (
                        <img
                            key={idx}
                            src={url}
                            alt=""
                            style={{ cursor: "pointer" }}
                            onLoad={handleMascotImageLoad}
                            onClick={e => { e.stopPropagation(); setPreviewImageUrl(url); }}
                        />
                    );
                })}
            </div>
        );
    };

    return (
        <div
            ref={wrapperRef}
            className="mascot-chat-session chat-room-wrapper page-shell inset-0 flex flex-col z-20"
            style={chatRoomBackgroundStyle}
            {...(backgroundUrl ? { "data-has-bg-image": "" } : {})}
            {...(showInfo ? { "data-settings-open": "" } : {})}
            {...(!initialScrollReady ? { "data-initial-scroll-pending": "" } : {})}
        >
            {settings.chatCustomCSS && (
                <SessionCustomCSS css={settings.chatCustomCSS} scope=".mascot-chat-session" />
            )}
            <style>{`
                .mascot-chat-session > .page-body {
                    overflow-y: scroll;
                    -webkit-overflow-scrolling: touch;
                    overscroll-behavior: contain;
                    transition: opacity 120ms ease;
                }
                .mascot-chat-session[data-initial-scroll-pending] > .page-body {
                    opacity: 0;
                }
                .mascot-inline-images {
                    display: flex;
                    flex-wrap: wrap;
                    justify-content: flex-start;
                    align-items: flex-start;
                    gap: 6px;
                    margin-bottom: 6px;
                    width: min(230px, 100%);
                    max-width: 230px;
                }
                .mascot-inline-images img,
                .mascot-inline-image-loading {
                    width: auto;
                    max-width: 230px;
                    height: auto;
                    max-height: 260px;
                    object-fit: contain;
                    border-radius: 8px;
                    background: color-mix(in srgb, var(--c-text) 8%, transparent);
                }
                .mascot-inline-image-loading {
                    width: 120px;
                    height: 120px;
                }
                .mascot-tool-result-card {
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    gap: 7px;
                    max-width: min(86%, 260px);
                    position: relative;
                    cursor: pointer;
                    -webkit-user-select: none;
                    user-select: none;
                }
                .mascot-tool-result-card[data-active] {
                    overflow: visible;
                }
                .mascot-tool-result-card .chat-sys-msg {
                    max-width: 100%;
                }
                .mascot-tool-result-card .mascot-inline-images {
                    justify-content: center;
                    margin-bottom: 0;
                }
                .mascot-tool-result-card .mascot-inline-images img,
                .mascot-tool-result-card .mascot-inline-image-loading {
                    max-height: 220px;
                }
                .mascot-pending-strip {
                    display: flex;
                    gap: 8px;
                    padding: 8px 12px 0;
                    overflow-x: auto;
                }
                .mascot-pending-thumb {
                    width: 52px;
                    height: 52px;
                    border-radius: 10px;
                    overflow: hidden;
                    position: relative;
                    background: var(--c-input);
                    flex: 0 0 auto;
                }
                .mascot-pending-thumb img {
                    width: 100%;
                    height: 100%;
                    object-fit: cover;
                }
                .mascot-pending-thumb button {
                    position: absolute;
                    top: 2px;
                    right: 2px;
                    width: 18px;
                    height: 18px;
                    border: none;
                    border-radius: 9px;
                    background: rgba(0,0,0,0.45);
                    color: #fff;
                    font-size: 12px;
                }
            `}</style>

            <header className="page-header chat-room-main-pane" data-ui="header">
                <div className="page-header-safe-area" />
                <div className="page-header-content">
                    <button className="page-back-btn" type="button" onClick={onBack} aria-label="返回">
                        <ChevronLeft size={24} strokeWidth={1.5} />
                    </button>
                    <span className="page-title" style={{ position: "relative" }}>
                        {settings.nickname || "AI助手"}
                        {chat.isThinking && (
                            <span className="chat-typing-indicator">
                                正在思考<span className="chat-typing-dots"><i/><i/><i/></span>
                            </span>
                        )}
                    </span>
                    <span className="page-header-right">
                        <button className="page-back-btn" type="button" onClick={() => setShowInfo(true)} aria-label="更多">
                            <MoreHorizontal size={22} strokeWidth={1.5} />
                        </button>
                    </span>
                </div>
            </header>

            <div
                ref={scrollRef}
                className="page-body chat-room-main-pane flex flex-col gap-4 chat-scroll-anchored"
                onScroll={updateMascotStickToBottom}
                onPointerDown={() => {
                    if (showEmojiPanel) setShowEmojiPanel(false);
                    if (activeMascotMessageIndex !== null) closeMascotContextMenu();
                }}
            >
                {hasMoreMascotMessages && (
                    <button
                        type="button"
                        className="chat-sys-msg chat-load-more-button"
                        onClick={handleLoadMoreMascotMessages}
                    >
                        <span>查看更多消息</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="18 15 12 9 6 15" />
                        </svg>
                    </button>
                )}
                {visibleMessageEntries.map(({ msg, rawIndex }) => {
                    if (msg.role === "tool") {
                        const label = msg.displayText || msg.text || msg.toolDisplayName || msg.toolName || "工具";
                        const shownName = msg.toolDisplayName || msg.toolName || "工具";
                        const running = msg.toolSuccess === undefined;
                        const toolSummary = running
                            ? `正在调用 ${shownName}…`
                            : `${shownName}${label && label !== shownName ? `：${label.slice(0, 80)}${label.length > 80 ? "…" : ""}` : ""}`;
                        return (
                            <div key={`${rawIndex}-${msg.createdAt || ""}`} className="chat-msg-wrapper" data-role="system">
                                <div
                                    className="mascot-tool-result-card"
                                    onPointerDown={(event) => handleMascotMessagePointerDown(event, rawIndex)}
                                    onPointerUp={handleMascotMessagePointerUp}
                                    onPointerCancel={cancelMascotLongPress}
                                    onPointerLeave={cancelMascotLongPress}
                                    onPointerMove={handleMascotMessagePointerMove}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        openMascotContextMenu(rawIndex, { x: event.clientX, y: event.clientY });
                                    }}
                                    {...(activeMascotMessageIndex === rawIndex ? { "data-active": "" } : {})}
                                >
                                    {renderMascotContextMenu(rawIndex, msg.role)}
                                    <div className="chat-sys-msg relative truncate" title={label}>
                                        {toolSummary}
                                    </div>
                                    {renderImages(msg)}
                                </div>
                            </div>
                        );
                    }
                    const isUser = msg.role === "user";
                    return (
                        <div key={`${rawIndex}-${msg.createdAt || ""}`} className="chat-msg-wrapper" data-role={isUser ? "user" : "assistant"}>
                            {!isUser && <MascotAvatar src={avatarUrl} alt={settings.nickname || "AI助手"} />}
                            <div className="chat-msg-content-wrap flex flex-col min-w-0 max-w-[70%]">
                                <div
                                    className={`${isUser ? "chat-bubble-role-user" : "chat-bubble-role-assistant chat-bubble-role-mascot"} rounded-md break-words relative cursor-pointer select-none`}
                                    data-ui={isUser ? "bubble-user" : "bubble-bot"}
                                    onPointerDown={(event) => handleMascotMessagePointerDown(event, rawIndex)}
                                    onPointerUp={handleMascotMessagePointerUp}
                                    onPointerCancel={cancelMascotLongPress}
                                    onPointerLeave={cancelMascotLongPress}
                                    onPointerMove={handleMascotMessagePointerMove}
                                    onContextMenu={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                        openMascotContextMenu(rawIndex, { x: event.clientX, y: event.clientY });
                                    }}
                                    {...(activeMascotMessageIndex === rawIndex ? { "data-active": "" } : {})}
                                >
                                    {renderMascotContextMenu(rawIndex, msg.role)}
                                    {renderImages(msg)}
                                    {getMascotMessageText(msg) ? (
                                        <BilingualTextBlock text={getMascotMessageText(msg)} mode="markdown" defaultExpanded />
                                    ) : null}
                                </div>
                            </div>
                            {isUser && <UserAvatar identity={identity} />}
                        </div>
                    );
                })}
                {chat.isThinking && (
                    <div className="chat-msg-wrapper" data-role="assistant">
                        <MascotAvatar src={avatarUrl} alt={settings.nickname || "AI助手"} />
                        <div className="chat-bubble-role-assistant chat-bubble-role-mascot rounded-md mascot-thinking">
                            思考中<span className="mascot-dot"></span><span className="mascot-dot"></span><span className="mascot-dot"></span>
                        </div>
                    </div>
                )}
                <div style={{ overflowAnchor: "auto", height: 1 }} />
            </div>

            <div className="chat-input-bar chat-room-main-pane flex flex-col" data-ui="input">
                {pendingImages.length > 0 && (
                    <div className="mascot-pending-strip">
                        {pendingImages.map((ref, idx) => {
                            const url = imagePreviewCache[ref];
                            return (
                                <div key={`${ref}-${idx}`} className="mascot-pending-thumb">
                                    {url ? <img src={url} alt="" /> : null}
                                    <button type="button" onClick={() => setPendingImages((prev) => prev.filter((_, i) => i !== idx))}>×</button>
                                </div>
                            );
                        })}
                    </div>
                )}
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={inputText}
                    onChange={(event) => {
                        setInputText(event.target.value);
                        resizeTextarea();
                    }}
                    onFocus={() => {
                        if (showEmojiPanel) setShowEmojiPanel(false);
                    }}
                    onKeyDown={(event) => {
                        if (shouldSendChatInputOnEnter(event, enterToSendEnabled)) {
                            event.preventDefault();
                            // 思考中回车吞掉：不发送，也不能落进 handleSend 的停止分支误停生成（停止只走按钮）
                            if (chat.isThinking) return;
                            void handleSend();
                        }
                    }}
                    enterKeyHint={enterToSendEnabled ? "send" : "enter"}
                    className="chat-input-textarea"
                    placeholder={`跟${settings.nickname || "AI助手"}聊聊...`}
                    /* 思考中不再 disable：禁用聚焦中的元素会强制失焦收键盘且不走正常 blur 事件序列，
                       在 iOS PWA 上与键盘收起的 viewport 复原竞态，偶发把底部输入栏卡在屏幕外
                       （表现为发送后整条输入栏消失，退出重进恢复）。对齐普通聊天室：生成中可继续打字，
                       字留在框里；发送键在思考中仍是停止键。 */
                />
                <div className="chat-input-actions">
                    <label
                        className="ui-bare-btn text-[var(--c-text)]"
                        aria-disabled={chat.isThinking || pendingImages.length >= 4}
                        title={pendingImages.length >= 4 ? "最多 4 张图" : "添加图片"}
                        onClick={(event) => {
                            if (chat.isThinking || pendingImages.length >= 4) event.preventDefault();
                        }}
                    >
                        <ImageIcon size={24} strokeWidth={1.5} />
                        <input
                            type="file"
                            accept="image/*"
                            multiple
                            className="hidden"
                            onChange={(event) => {
                                const files = event.currentTarget.files ? Array.from(event.currentTarget.files) : [];
                                event.currentTarget.value = "";
                                void handlePickImages(files);
                            }}
                        />
                    </label>
                    <button
                        type="button"
                        onClick={() => setShowEmojiPanel((prev) => !prev)}
                        className="ui-bare-btn text-[var(--c-text)]"
                        aria-label="表情"
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M8 14s1.5 2 4 2 4-2 4-2" /><line x1="9" y1="9" x2="9.01" y2="9" /><line x1="15" y1="9" x2="15.01" y2="9" /></svg>
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleSend()}
                        disabled={!chat.isThinking && !inputText.trim() && pendingImages.length === 0}
                        className="ui-bare-btn text-[var(--c-text)]"
                        aria-label={chat.isThinking ? "停止生成" : "发送"}
                    >
                        {chat.isThinking ? (
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="10" />
                                <rect x="9" y="9" width="6" height="6" rx="1" />
                            </svg>
                        ) : (
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => void handleGenerateReply()}
                        disabled={!canGenerateReply}
                        className="ui-bare-btn text-[var(--c-text)]"
                        aria-label="重新生成回复"
                        title="生成回复（发送后未生成或删除回复后使用）"
                    >
                        <Sparkles size={24} strokeWidth={1.5} />
                    </button>
                </div>
                {showEmojiPanel && <EmojiPanel onSelect={appendEmoji} />}
            </div>

            {showInfo && wrapperRef.current?.parentElement && createPortal(
                <div className="chat-settings-layer absolute inset-0 z-50">
                    <MascotInfoPanel
                        avatarUrl={avatarUrl}
                        onClose={() => setShowInfo(false)}
                        onDeleted={() => {
                            setShowInfo(false);
                            onDeleted?.();
                        }}
                    />
                </div>,
                wrapperRef.current.parentElement
            )}

            {previewImageUrl && (
                <MediaPreviewOverlay
                    imageUrl={previewImageUrl}
                    saveFilename="小卷图片.png"
                    onClose={() => setPreviewImageUrl(null)}
                />
            )}
        </div>
    );
}
