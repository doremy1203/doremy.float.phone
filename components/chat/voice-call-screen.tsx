"use client";

import { useState, useRef, useEffect, useCallback, type CSSProperties } from "react";
import { ChatSession, ChatMessage, loadChatMessages, pushChatMessage, getLatestCharacterStateValues, updateChatMessage, deleteChatMessage } from "@/lib/chat-storage";
import { getStatusRegionConfig, isCustomStatusRegionActive } from "@/lib/chat-status-region";
import type { StateValue } from "@/lib/chat-storage";
import { parseStateValues, mergeStateValues } from "@/lib/state-value-parser";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { generateChatCompletion, flattenCompletionResult, ChatEngineError } from "@/lib/chat-engine";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { cancelFollowUp } from "@/lib/follow-up-service";
import { persistCallAudio, releaseCallAudioRef } from "@/lib/call-audio-storage";
import { suspendBailoutsForCall } from "@/lib/push-bailout-client";
import { createSTTSession, type STTSession } from "@/lib/stt-service";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlob, playAudioBlobViaMediaElement, setCallAudioSessionActive } from "@/lib/tts-service";
import { isCallRecordingSupported, resolveCloudSttConfig } from "@/lib/stt-cloud";
import { useHoldToTalk } from "./use-hold-to-talk";
import { suspendKeepAliveForCall, resumeKeepAliveAfterCall } from "@/lib/use-weixin-bridge";
import { BilingualTextBlock } from "./message-bubble";
import { splitBilingualText } from "@/lib/bilingual-text";
import type { Character } from "@/lib/character-types";
import { useCallKeyboardOffsetStyle } from "./use-call-keyboard-offset";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser, isIOSDevice } from "./voice-input-platform";
import { CallVolumeControl } from "./call-volume-control";
import { startIncomingCallVibration } from "@/lib/call-vibration";
import { useCallScreenSounds } from "@/lib/chat-sound";
import { CallMiniWindow } from "./call-mini-window";
import { CallSubtitleItem, type CallSubtitleAction } from "./call-subtitle-item";
import { type CallAutoChatConfig, MAX_TURNS_LIMIT, MIN_INTERVAL_SECONDS, loadCallAutoChatConfig, randomAutoChatDelaySeconds, saveCallAutoChatConfig } from "@/lib/call-auto-chat";
import { isShellEnvironment, stopShellCallOverlay } from "@/lib/shell-call-overlay";
import { beginTurn, type TurnHandle } from "@/lib/turn-coordinator";
import { useShellCallOverlay } from "./use-shell-call-overlay";
import { useCallReplyQueue } from "./use-call-reply-queue";

// ── Types ───────────────────────────────────────────

type CallState =
    | "CONNECTING"
    | "IDLE"
    | "USER_SPEAKING"
    | "PROCESSING"
    | "AI_SPEAKING"
    | "ENDED";

type SubtitleEntry = {
    id: string;
    role: "user" | "assistant";
    text: string;
    /** 这条字幕对应的聊天消息 id。编辑 / 删除 / 重新生成都要落到真实记录上，
     *  所以从 1.0.10 起不再用假 id（原先角色字幕是 ai-<时间戳>，定位不到记录）。 */
    messageIds?: string[];
    /** 实际送去合成语音的文本；重听时用它重新合成。用户的话没有这一项。 */
    speechText?: string;
};

type VoiceCallScreenProps = {
    session: ChatSession;
    character: Character;
    onEnd: () => void;
    onConnect?: () => void;
    initiator?: "user" | "character";
    /** 通话是否处于缩小的悬浮窗状态：通话继续（识别/播放/计时不停），界面缩为小窗 */
    minimized?: boolean;
    /** 点击左上角返回键：请求缩小为悬浮窗（通话继续，不挂断） */
    onMinimize?: () => void;
    /** 点击悬浮窗：请求恢复为全屏通话界面 */
    onRestore?: () => void;
};

/** 自动搭话设置里的数字输入框样式（深底浅字，随面板走） */
const AUTO_CHAT_INPUT_STYLE: CSSProperties = {
    width: 66,
    padding: "4px 6px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    fontSize: 12,
    textAlign: "center",
};

/** 自动搭话按钮的默认落点（可拖动，拖动后位置记在本地）。
 *  默认靠右上：原先放左上时和「缩小通话」返回键叠在一起，返回键被挡住点不到。 */
const AUTO_CHAT_DEFAULT_POS: { x: number | null; y: number } = { x: null, y: 104 };
const AUTO_CHAT_POS_KEY = "call-auto-chat-btn-pos-v1";

/** 自动搭话按钮/面板的容器基础样式（具体位置由拖动状态决定） */
const AUTO_CHAT_BOX_BASE: CSSProperties = {
    position: "absolute",
    zIndex: 30,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: 6,
    touchAction: "none",
};

function stripBilingualForSpeech(text: string): string {
    return text
        .split("\n")
        .map(line => splitBilingualText(line)?.original || line)
        .join("\n");
}

// ── Component ───────────────────────────────────────

export function VoiceCallScreen({ session, character, onEnd, onConnect, initiator = "user", minimized = false, onMinimize, onRestore }: VoiceCallScreenProps) {
    // iOS 保留 Web Speech 免提 + Web Audio 播放（麦克风会话共存的老方案）；
    // 其余设备改「按住说话 + 云端转写」，播放走媒体元素（音量键可控、无静音拨键坑）。
    // 没配 OpenAI 兼容识别时回落旧行为（安卓=文字输入）。
    const iosDeviceRef = useRef(isIOSDevice());
    const iosDevice = iosDeviceRef.current;
    const holdToTalkRef = useRef(
        !iosDeviceRef.current && isCallRecordingSupported() && resolveCloudSttConfig(session.contactId) !== null,
    );
    const holdToTalk = holdToTalkRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !holdToTalkRef.current);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const playCallAudio = iosDevice ? playAudioBlob : playAudioBlobViaMediaElement;
    const keyboardOffsetStyle = useCallKeyboardOffsetStyle();
    const [callState, setCallState] = useState<CallState>("CONNECTING");
    const hasConnectedRef = useRef(false);
    const [callDuration, setCallDuration] = useState(0);
    const [subtitles, setSubtitles] = useState<SubtitleEntry[]>([]);
    const [interimText, setInterimText] = useState("");
    const [isMuted, setIsMuted] = useState(false);
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [typedText, setTypedText] = useState("");
    const [bgImageResolved, setBgImageResolved] = useState<string | null>(null);

    // 通话是交互阻塞态：通话期间所有主动消息让路；挂断/卸载时 abort 当前通话 turn。
    const callTurnRef = useRef<TurnHandle | null>(null);
    useEffect(() => {
        const turn = beginTurn({ kind: "call", characterId: character.id, sessionId: session.id });
        callTurnRef.current = turn;
        return () => {
            turn?.abort();
            turn?.end();
            callTurnRef.current = null;
        };
    }, [character.id, session.id]);
    const [showSttWarning, setShowSttWarning] = useState(false);
    // 正在重听的字幕 id（按钮据此高亮）
    const [replayingId, setReplayingId] = useState<string | null>(null);

    // 已合成音频按字幕 id 缓存：重听直接放，不重复烧 TTS 额度。
    // 上限 20 段——一次长通话能攒下几十段，全留着内存扛不住，丢最旧的。
    const audioCacheRef = useRef<Map<string, Blob>>(new Map());
    const cacheAudio = (id: string, blob: Blob) => {
        const cache = audioCacheRef.current;
        cache.set(id, blob);
        while (cache.size > 20) {
            const oldest = cache.keys().next().value;
            if (oldest === undefined) break;
            cache.delete(oldest);
        }
    };
    // 自动搭话：进通话时读一次配置；改动即时存盘并热生效
    const [autoChatConfig, setAutoChatConfig] = useState<CallAutoChatConfig>(() => loadCallAutoChatConfig());
    const [showAutoChatPanel, setShowAutoChatPanel] = useState(false);
    // 安卓壳里：切到别的 App 时用原生浮窗顶上（浮窗权限未开时给一条引导）。
    // 具体接线与引导标记由 useShellCallOverlay 提供，见下方调用处。
    // 自动搭话按钮的位置（可拖动，拖动后记在本地，下次通话沿用）
    const [autoChatPos, setAutoChatPos] = useState<{ x: number | null; y: number }>(() => {
        if (typeof window === "undefined") return { ...AUTO_CHAT_DEFAULT_POS };
        try {
            const raw = window.localStorage.getItem(AUTO_CHAT_POS_KEY);
            if (!raw) return { ...AUTO_CHAT_DEFAULT_POS };
            const parsed = JSON.parse(raw) as { x?: number | null; y?: number };
            return {
                x: typeof parsed.x === "number" ? parsed.x : null,
                y: typeof parsed.y === "number" ? parsed.y : AUTO_CHAT_DEFAULT_POS.y,
            };
        } catch {
            return { ...AUTO_CHAT_DEFAULT_POS };
        }
    });

    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const callStartRef = useRef<number>(0);
    const pausedAtRef = useRef<number | null>(null);
    const minimizedRef = useRef(false);
    const stateRef = useRef<string>("CONNECTING");
    const interimTextRef = useRef<string>("");  // ref 版本，闭包安全
    const sttWarningShownRef = useRef(false);
    // 自动搭话：下一次可开口的时刻（毫秒时间戳）
    const autoChatDeadlineRef = useRef<number>(0);
    // 本次通话已自动搭话条数（用户一开口清零）
    const autoTurnsRef = useRef(0);
    // 角色连着几轮没说出内容：等待时长按此翻倍，避免空转连发
    const emptyAutoTurnsRef = useRef(0);
    // 配置的 ref 快照：心跳里读最新值，不必因设置变化重建定时器
    const autoChatConfigRef = useRef<CallAutoChatConfig>(autoChatConfig);
    // handleHangup 依赖 callDuration（每秒都变），直接进 effect 依赖会让监听器
    // 每秒重装一次；用 ref 转发，订阅只建立一次。
    // （本次通话 id、原生事件订阅、计时校准都交给 useShellCallOverlay 了）
    const hangupRef = useRef<() => void>(() => {});
    // 时长的 ref 快照：同步给原生浮窗时读，避免把每秒变化的 callDuration 塞进 effect 依赖
    const callDurationRef = useRef(0);
    useEffect(() => { callDurationRef.current = callDuration; }, [callDuration]);
    // 自动搭话按钮的拖动状态
    const autoChatDragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);
    const autoChatBoxRef = useRef<HTMLDivElement | null>(null);
    const subtitleScrollRef = useRef<HTMLDivElement>(null);
    const messagesRef = useRef<ChatMessage[]>([]);
    const _initUi = resolveUserIdentity(session.contactId, "chat");
    const userNameRef = useRef<string>(_initUi?.name || "你");

    // Keep refs in sync
    useEffect(() => { stateRef.current = callState; }, [callState]);
    useEffect(() => { minimizedRef.current = minimized; }, [minimized]);

    // 缩小为悬浮窗：通话继续，不再「冻结」。
    //
    // 旧实现把缩小当成挂起——中止识别、打断在播放的语音、停掉计时，于是悬浮窗
    // 只是一个空壳：角色正在说的那句被硬切，之后也再没有声音，用户看到的就是
    // 「一缩小就没声音」。真实手机上通话缩成小窗后是继续通话的，这里对齐：
    // 播放不打断，识别与计时照常，悬浮窗就是通话中的小窗。
    useEffect(() => {
        if (!minimized) return;
        // 只清掉界面上的临时字幕；通话本身（播放 / 识别 / 计时）保持运行。
        setInterimText("");
    }, [minimized]);

    // 来电等待接听：循环振动（开关在聊天主页，iOS 网页不支持自动无效果）
    // + 来电/致电铃声与挂断音（角色专属提示音优先，其余在"全局聊天信息 → 提示音"）
    useCallScreenSounds({ initiator, callState, session });
    useEffect(() => {
        if (initiator !== "character" || callState !== "CONNECTING") return;
        const stop = startIncomingCallVibration();
        return stop;
    }, [initiator, callState]);

    // Pause WeChat keep-alive while the call holds the mic/audio; restore on exit.
    useEffect(() => {
        suspendKeepAliveForCall();
        return () => { resumeKeepAliveAfterCall(); };
    }, []);

    // 通话音频会话 + 卸载兜底：不经挂断键退出（返回聊天页/切会话/组件被销毁）时，
    // 把识别、在途播放与音频会话全部释放。此前识别的自动重启循环在卸载后条件
    // 恒成立（stateRef 停在 IDLE），会在后台无限自我重启，麦克风永不归还，
    // 整页音频被钉在通话模式（语音条/试听音量巨大且音量键失灵）。
    useEffect(() => {
        setCallAudioSessionActive(true);
        return () => {
            stateRef.current = "ENDED";
            if (sttRef.current) { sttRef.current.abort(); sttRef.current = null; }
            if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
            setCallAudioSessionActive(false);
        };
    }, []);
    useEffect(() => { interimTextRef.current = interimText; }, [interimText]);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttWarningShownRef.current || isCallSttWarningHidden()) return;
        sttWarningShownRef.current = true;
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
    }, []);

    // Scroll subtitles to bottom on change
    useEffect(() => {
        if (subtitleScrollRef.current) {
            subtitleScrollRef.current.scrollTop = subtitleScrollRef.current.scrollHeight;
        }
    }, [subtitles, interimText]);

    // ── Resolve voiceBackground from IndexedDB ──────

    useEffect(() => {
        if (!session.voiceBackground) {
            setBgImageResolved(null);
            return;
        }
        if (session.voiceBackground.startsWith("data:") || session.voiceBackground.startsWith("http")) {
            setBgImageResolved(session.voiceBackground);
            return;
        }
        // IndexedDB ID
        import("@/lib/chat-asset-storage").then(({ getChatImageFromIndexedDB }) => {
            getChatImageFromIndexedDB(session.voiceBackground!).then(dataUrl => {
                if (dataUrl) setBgImageResolved(dataUrl);
            });
        });
    }, [session.voiceBackground]);

    // ── Call timer ───────────────────────────────────

    useEffect(() => {
        if (callState === "CONNECTING" || callState === "ENDED") return;

        if (!callStartRef.current) {
            callStartRef.current = Date.now();
        }

        // 悬浮窗不再冻结计时：通话在后台继续，时长就该继续走。
        // pausedAtRef 的补偿保留着——若某次会话在旧版逻辑下进入过冻结态，
        // 恢复时仍能把那段时长补回起点，不会出现时长跳变。
        if (pausedAtRef.current !== null) {
            callStartRef.current += Date.now() - pausedAtRef.current;
            pausedAtRef.current = null;
        }

        timerRef.current = setInterval(() => {
            setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
        }, 1000);

        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [callState, minimized]);

    // ── Connecting animation (3s fake dial) ─────────

    useEffect(() => {
        cancelFollowUp(session.id);
        // 通话期间不打扰：撤掉这个会话已挂在服务端的离线预约。
        // 通话里系统看不见你的文字回复，会误判成沉默、到点弹一条主动消息
        //（只在通知里出现，聊天室里没有对应记录——人明明在电话里聊着）。
        void suspendBailoutsForCall(session.id);

        // Resolve user name
        const ui = resolveUserIdentity(session.contactId, "chat");
        userNameRef.current = ui?.name || "你";

        // Load existing messages for context
        messagesRef.current = loadChatMessages(session.id);

        // Insert system message (skip if already exists from strict mode remount)
        const lastMsg = messagesRef.current[messagesRef.current.length - 1];
        const initRole = initiator === "character" ? "assistant" : "user";
        if (!lastMsg || !(lastMsg.content.includes("发起了语音通话"))) {
            const callMsg = initiator === "character"
                ? `[我向${userNameRef.current}发起了语音通话]`
                : `[我向${character.name}发起了语音通话]`;
            const sysMsg = pushChatMessage({
                sessionId: session.id,
                role: initRole,
                content: callMsg,
            });
            messagesRef.current = [...messagesRef.current, sysMsg];
        }

        // User-initiated: auto-connect after 3s fake dial
        // Character-initiated: wait for user to accept
        let connectTimer: NodeJS.Timeout | undefined;
        if (initiator !== "character") {
            connectTimer = setTimeout(() => {
                setCallState("IDLE");
            }, 3000);
        }

        return () => {
            if (connectTimer) clearTimeout(connectTimer);
            if (timerRef.current) clearInterval(timerRef.current);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Track first connect
    useEffect(() => {
        if (callState !== "CONNECTING" && !hasConnectedRef.current) {
            hasConnectedRef.current = true;
        }
    }, [callState]);

    // ── Format time MM:SS ───────────────────────────

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    };

    // ── State label ─────────────────────────────────

    const stateLabel = (): string => {
        switch (callState) {
            case "CONNECTING": return initiator === "character" ? "来电..." : "正在呼叫...";
            case "IDLE": return isMuted ? "已静音" : "通话中";
            case "USER_SPEAKING": return "正在聆听...";
            case "PROCESSING": return "对方正在思考...";
            case "AI_SPEAKING": return "对方正在说话...";
            case "ENDED": return "通话已结束";
        }
    };

    // ── AI response processing (same logic as chat-room) ──

    const processAIResponse = useCallback((aiResponseText: string): { cleanParts: string[]; stateValues: StateValue[]; messageIds: string[]; speechMessageIds: string[] } => {
        // 本轮回合落进聊天记录的消息 id。字幕要带着它们，编辑 / 删除 / 重新生成
        // 才能定位到真实记录——而不只是改屏幕上那一行字。
        const createdMessageIds: string[] = [];
        // 本轮真正「被朗读」的消息 id：原音留档只挂在这些消息上。
        // 贴纸、红包这类没有台词的富媒体消息不挂，免得复听按钮重复又对不上语音。
        const speechMessageIds: string[] = [];
        // Use shared parseAIResponse for full rich media support (stickers, quotes, etc.)
        const previousState = getLatestCharacterStateValues(session.contactId);

        const { parts, stateValues, freshStateValues, statusPanel, innerMonologue } = parseAIResponse(aiResponseText, previousState);

        // 自定义状态栏渲染戳：不盖的话 custom 模式下 [状态栏] 原文按 markdown 渲染，看着像掉格式
        const statusRegionMode = statusPanel && isCustomStatusRegionActive(getStatusRegionConfig(session.id))
            ? ("custom" as const)
            : undefined;

        // Filter out non-chat action types (voice_call, video_call, poke, etc.)
        const chatParts = parts.filter(p =>
            !p.mediaType || !["voice_call", "video_call", "poke", "accept_red_packet", "decline_red_packet", "accept_transfer", "decline_transfer", "accept_payment_request", "decline_payment_request"].includes(p.mediaType)
        );

        // Save messages to storage
        if (chatParts.length === 0 && (statusPanel || innerMonologue)) {
            const aiMsg = pushChatMessage({
                sessionId: session.id,
                role: "assistant",
                content: "",
                statusPanel,
                statusRegionMode,
                innerMonologue,
                stateValues: stateValues.length > 0 ? stateValues : undefined,
                freshStateValues,
                origin: "call",
            });
            messagesRef.current = [...messagesRef.current, aiMsg];
            createdMessageIds.push(aiMsg.id);
        } else {
            const newMsgs = chatParts.map((part, idx) =>
                pushChatMessage({
                    sessionId: session.id,
                    role: "assistant",
                    content: part.content,
                    mediaType: part.mediaType,
                    mediaData: part.mediaData,
                    // 标记来源为通话：折叠只收这类消息
                    origin: "call",
                    statusPanel: idx === 0 && statusPanel ? statusPanel : undefined,
                    statusRegionMode: idx === 0 && statusPanel ? statusRegionMode : undefined,
                    innerMonologue: idx === 0 && innerMonologue ? innerMonologue : undefined,
                    stateValues: idx === 0 && stateValues.length > 0 ? stateValues : undefined,
                    freshStateValues: idx === 0 ? freshStateValues : undefined,
                })
            );
            messagesRef.current = [...messagesRef.current, ...newMsgs];
            createdMessageIds.push(...newMsgs.map(m => m.id));
            chatParts.forEach((part, idx) => {
                if (!part.mediaType && part.content.trim() && newMsgs[idx]) {
                    speechMessageIds.push(newMsgs[idx].id);
                }
            });
        }
        window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));

        // Return clean text parts for TTS (exclude rich media content)
        const cleanParts = chatParts
            .filter(p => !p.mediaType && p.content.trim())
            .map(p => p.content);

        return { cleanParts, stateValues, messageIds: createdMessageIds, speechMessageIds };
    }, [session.id, session.contactId]);

    // ── 自动搭话：安排下一次主动开口 ──────────────────
    //
    // 每次角色说完（或空转一趟）都调一次：按配置在 [min, max] 里随机取间隔，
    // 算出「下一次可开口的时刻」。真人是忽快忽慢的，固定节拍像定时器。
    // 空转那几轮按翻倍惩罚（最多 4 倍），别让它在没人听时连珠炮。
    const scheduleNextAutoChat = useCallback(() => {
        const config = autoChatConfigRef.current;
        if (!config.enabled) {
            autoChatDeadlineRef.current = 0;
            return;
        }
        const backoff = 1 + Math.min(emptyAutoTurnsRef.current, 3);
        autoChatDeadlineRef.current = Date.now() + randomAutoChatDelaySeconds(config) * backoff * 1000;
    }, []);

    // ── Full conversation turn ──────────────────────

    const runConversationTurn = useCallback(async (userText?: string) => {
        // 用户开口：自动搭话重新计数（上限按「你开口后」重新算）
        if (userText) {
            autoTurnsRef.current = 0;
            emptyAutoTurnsRef.current = 0;
            autoChatDeadlineRef.current = 0;
        }

        // 1. Save user message (skip for initial greeting)
        if (userText) {
            const userMsg = pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: userText,
                // 标记来源为通话：折叠只收这类消息，通话期间在聊天室发的留在时间流
                origin: "call",
            });
            messagesRef.current = [...messagesRef.current, userMsg];
            // 通知聊天室刷新：通话屏在聊天室之外（CallLayer），不广播的话
            // 通话中落库的消息要等挂断（chat-call-ended）才会出现在聊天室里，
            // 折叠条也就一直不更新（用户实报「要挂掉才同步」）。
            window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));

            // Add user subtitle
            setSubtitles(prev => [...prev, { id: userMsg.id, role: "user", text: userText, messageIds: [userMsg.id] }]);
        }

        // 2. Switch to PROCESSING
        setCallState("PROCESSING");
        setInterimText("");

        try {
            // 3. Generate AI response
            const aiResponseText = flattenCompletionResult(await generateChatCompletion(session, messagesRef.current, {
                appTags: ["chat", "voice"],
                signal: callTurnRef.current?.signal,
            }));

            // Bail if call ended during generation
            if (stateRef.current === "ENDED") return;

            // 4. Process response
            const { cleanParts, messageIds, speechMessageIds } = processAIResponse(aiResponseText);
            const displayText = cleanParts.join("\n");
            const speechText = stripBilingualForSpeech(displayText);

            if (!displayText) {
                // 这轮角色没说出内容：下次等更久，避免空转连发
                emptyAutoTurnsRef.current += 1;
                scheduleNextAutoChat();
                setCallState("IDLE");
                return;
            }

            // 5. Add AI subtitle
            // 带上 messageIds 与实际朗读文本：前者让长按菜单能改到真实记录，
            // 后者让「重听」可以重新合成（不必从渲染后的富文本里再猜一遍）。
            const subtitleId = `ai-${Date.now()}`;
            setSubtitles(prev => [...prev, { id: subtitleId, role: "assistant", text: displayText, messageIds, speechText }]);

            // 6. TTS —— 缩成悬浮窗也照常播。
            // 原先这里遇到小窗直接静默返回，于是「正在生成时退出全屏」那句话
            // 永远没声音。用户要的是通话继续，语音就该继续。
            setCallState("AI_SPEAKING");

            const voiceConfig = resolveVoiceConfig(session.contactId);
            if (voiceConfig) {
                try {
                    const audioBlob = await synthesizeSpeech(speechText, voiceConfig);
                    if (stateRef.current === "ENDED") return;

                    if (audioBlob) {
                        // 存一份给「重听」用：不然每次重听都要重新调一次 TTS API，
                        // 既慢又费额度。缓存满了自动丢最旧的（见 cacheAudio）。
                        cacheAudio(subtitleId, audioBlob);
                        // 落库留档：音频本体进媒体库，引用写进这条消息的 mediaData。
                        // 缓存是内存临时品、挂断即失；落库之后「通话统计」才可能复听原音
                        // ——宿主代播 voice.play 支持 media-store:// 引用，音频不过通信桥。
                        void persistCallAudio(audioBlob, {
                            sessionId: session.id,
                            characterId: session.contactId,
                        }).then(ref => {
                            if (!ref) return;
                            // 一轮可能出多段文本，而语音是整轮合一次：挂在第一段上。
                            const targetId = speechMessageIds[0];
                            if (!targetId) return;
                            const target = loadChatMessages(session.id).find(item => item.id === targetId);
                            if (!target) return;
                            updateChatMessage(targetId, {
                                mediaData: { ...(target.mediaData || {}), callAudioRef: ref },
                            });
                        });
                        const { promise, abort } = playCallAudio(audioBlob);
                        audioAbortRef.current = abort;
                        await promise;
                        audioAbortRef.current = null;
                    }
                } catch (e) {
                    console.warn("[VoiceCall] TTS failed:", e);
                }
            }

            if (stateRef.current !== "ENDED") {
                emptyAutoTurnsRef.current = 0;
                scheduleNextAutoChat();
                setCallState("IDLE");
            }
        } catch (error: unknown) {
            console.error("[VoiceCall] Error:", error);
            if (stateRef.current !== "ENDED") {
                setSubtitles(prev => [...prev, {
                    id: `err-${Date.now()}`,
                    role: "assistant",
                    text: `⚠️ ${error instanceof Error ? error.message : String(error)}`,
                }]);
                scheduleNextAutoChat();
                setCallState("IDLE");
            }
        }
    }, [session, processAIResponse, playCallAudio, scheduleNextAutoChat]);

    // ── 安卓壳原生浮窗 ──────────────────────────────
    //
    // 原实现在这里手写接线，有两个坑：
    //   1. 依赖数组里放了 callState。通话中状态每秒都在 IDLE / 聆听 / 思考 / 说话
    //      之间跳，effect 每跳一次就 stop + start，浮窗被整个拆了重建、计时归零，
    //      表现为「一说话时长就跳、不说话又变回 0」。
    //   2. 启动时没带 elapsedSeconds，原生只能从 0 起数。
    // 现已统一改用 useShellCallOverlay（视频/群聊通话早就走它）：内部按「是否已接通」
    // 判定，状态切换不重建浮窗，并会把网页已通话秒数带给原生做基准。

    // ── 自动搭话：心跳 ───────────────────────────────
    //
    // 每秒看一眼：通话处于 IDLE（谁也没在说）、没超上限、已过随机等待点，
    // 就让角色主动开口。缩成小窗也照常触发——用户要的就是「挂着也一直聊」，
    // 只是触发前会停掉在听的识别，免得把角色自己的声音录进去。
    useEffect(() => {
        autoChatConfigRef.current = autoChatConfig;
        if (!autoChatConfig.enabled) {
            autoChatDeadlineRef.current = 0;
            return;
        }
        // 刚开启（或刚进通话）：从当下起算一个随机间隔
        if (!autoChatDeadlineRef.current) {
            autoChatDeadlineRef.current = Date.now() + randomAutoChatDelaySeconds(autoChatConfig) * 1000;
        }
        const timer = window.setInterval(() => {
            if (stateRef.current !== "IDLE") return;
            const limit = autoChatConfigRef.current.maxTurns;
            if (limit > 0 && autoTurnsRef.current >= limit) return;
            const deadline = autoChatDeadlineRef.current;
            if (!deadline || Date.now() < deadline) return;
            autoTurnsRef.current += 1;
            autoChatDeadlineRef.current = 0;
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            void runConversationTurn();
        }, 1000);
        return () => window.clearInterval(timer);
    }, [autoChatConfig, runConversationTurn]);

    // ── Auto-listen: 进入 IDLE 自动开始监听 ────────

    const startListening = useCallback(() => {
        if (holdToTalk) return; // 按住说话模式不用 Web Speech 自动监听
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setInterimText("");
        interimTextRef.current = "";

        const stt = createSTTSession({
            onInterim: (text) => {
                setInterimText(text);
                interimTextRef.current = text;
                // 有中间结果 → 切到 USER_SPEAKING
                if (stateRef.current === "IDLE") {
                    setCallState("USER_SPEAKING");
                }
            },
            onFinal: (text) => {
                sttRef.current = null;
                if (text.trim()) {
                    runConversationTurn(text.trim());
                } else {
                    setInterimText("");
                    setCallState("IDLE");
                }
            },
            onError: (error) => {
                console.warn("[VoiceCall] STT error:", error);
                sttRef.current = null;
                setInterimText("");
                showSttCompatibilityWarning();
                // 严重错误，回到 IDLE（会触发重新监听）
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    setCallState("IDLE");
                }
            },
            onNoSpeech: () => {
                // 没检测到语音 → 静默重新开始监听
                sttRef.current = null;
                showSttCompatibilityWarning();
                if (stateRef.current === "IDLE" || stateRef.current === "USER_SPEAKING") {
                    // 短暂延迟后重启，避免快速循环
                    setTimeout(() => {
                        if (stateRef.current === "IDLE") {
                            startListening();
                        }
                    }, 300);
                }
            },
            onEnd: () => {
                // 没有 finalText 也没有 no-speech → 用 interimRef 兜底
                sttRef.current = null;
                if (stateRef.current === "USER_SPEAKING" || stateRef.current === "IDLE") {
                    const fallback = interimTextRef.current;
                    if (fallback.trim()) {
                        runConversationTurn(fallback.trim());
                    } else {
                        setInterimText("");
                        setCallState("IDLE");
                    }
                }
            },
        }, "zh-CN");

        sttRef.current = stt;

        if (stt.isSupported) {
            stt.start();
        } else {
            sttRef.current = null;
            showSttCompatibilityWarning();
        }
    }, [androidTextInputOnly, holdToTalk, runConversationTurn, session.contactId, showSttCompatibilityWarning]);

    // IDLE 时自动开启监听（按住说话模式无自动监听，识别只在按住期间发生）
    useEffect(() => {
        if (holdToTalk) return;
        if (inputMode === "text" && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
            setInterimText("");
        }
        if (!androidTextInputOnly && inputMode === "voice" && callState === "IDLE" && !isMuted && !minimized) {
            // 短暂延迟让 UI 过渡完成
            const timer = setTimeout(() => {
                if (stateRef.current === "IDLE" && !minimizedRef.current) {
                    startListening();
                }
            }, 500);
            return () => clearTimeout(timer);
        }
        // 静音时停止监听
        if (isMuted && sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
    }, [androidTextInputOnly, holdToTalk, callState, isMuted, inputMode, minimized, startListening]);

    const handleInputModeToggle = useCallback(() => {
        if (androidTextInputOnly) {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            if (sttRef.current) {
                sttRef.current.abort();
                sttRef.current = null;
            }
            setInterimText("");
            if (stateRef.current === "USER_SPEAKING") setCallState("IDLE");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    }, [androidTextInputOnly, inputMode]);

    const handleTextSubmit = useCallback(() => {
        const text = typedText.trim();
        if (!text || callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setTypedText("");
        runConversationTurn(text);
    }, [typedText, callState, runConversationTurn]);

    // 输入框左侧的"重回"键：不发送新内容，直接让对方基于当前上下文重新回复一次
    const handleRegenerate = useCallback(() => {
        if (callState !== "IDLE") return;
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        runConversationTurn();
    }, [callState, runConversationTurn]);

    // 按住说话（非 iOS）：按下录音，松开转写后走对话轮
    const holdInput = useHoldToTalk({
        characterId: session.contactId,
        canStart: () => stateRef.current === "IDLE",
        onRecordingStart: () => {
            setInterimText("");
            if (stateRef.current === "IDLE") setCallState("USER_SPEAKING");
        },
        onTranscribeStart: () => {
            if (stateRef.current === "USER_SPEAKING") setCallState("PROCESSING");
        },
        onTranscript: (text) => { void runConversationTurn(text); },
        onError: () => {
            if (stateRef.current === "USER_SPEAKING" || stateRef.current === "PROCESSING") {
                setCallState("IDLE");
            }
        },
    });

    // ── Hangup ──────────────────────────────────────

    const handleHangup = useCallback(() => {
        // 挂断时收掉原生浮窗（安卓壳里）
        stopShellCallOverlay();
        setCallState("ENDED");

        // Stop any ongoing STT
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }

        // Stop any ongoing audio playback
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }

        // Stop browser TTS
        if (window.speechSynthesis) {
            window.speechSynthesis.cancel();
        }

        const endMsg = pushChatMessage({
            sessionId: session.id,
            role: "user",
            content: `[我挂断了语音通话]`,
            mediaData: { callDuration: formatTime(callDuration) },
        });
        messagesRef.current = [...messagesRef.current, endMsg];

        // Delay then close
        setTimeout(() => onEnd(), 1500);
    }, [session.id, callDuration, onEnd]);

    // 保持 ref 指向最新的 handleHangup（原生浮窗的挂断事件要调到它）
    useEffect(() => { hangupRef.current = handleHangup; }, [handleHangup]);

    // ── 待发送队列 ──
    //
    // 角色正在说话/思考时不能立刻发新消息（会打断当前一轮）。从前是「忙就丢掉」，
    // 从浮窗回复条发消息时因此常常空发——字收了、条收了，消息却没了。
    // 改为排队：空闲了自动补发。必须放在 runConversationTurn 之后。
    const replyQueue = useCallReplyQueue({
        callState,
        callStateRef: stateRef,
        runTurn: (text) => { void runConversationTurn(text); },
        active: callState !== "CONNECTING" && callState !== "ENDED",
    });

    // ── 字幕操作：重听 / 编辑 / 删除 / 重新生成 ──────
    //
    // 四项都要落到真实聊天记录上（字幕带着 messageIds），不是只改屏幕上那行字：
    // 只改屏幕会被下次重渲染覆盖，只改记录则通话页与聊天页对不上。

    /**
     * 清掉若干消息上的原音留档。
     *
     * 消息被编辑 / 删除 / 重新生成后，留档的音频与屏幕上的文字已经对不上，继续留着
     * 只会让人点开听到另一句话。内存缓存原本就会 .delete，落库的引用同样要清。
     */
    const releaseAudioRefs = useCallback((messageIds: string[] | undefined) => {
        for (const id of messageIds ?? []) {
            const msg = messagesRef.current.find(item => item.id === id);
            const ref = msg?.mediaData?.callAudioRef;
            if (!ref) continue;
            void releaseCallAudioRef(ref);
            updateChatMessage(id, { mediaData: { ...msg.mediaData, callAudioRef: undefined } });
        }
    }, []);

    /** 重听一句。优先放缓存，没有就现场合成；合成结果缓存起来，避免重复烧 TTS 额度。 */
    const handleReplaySubtitle = useCallback(async (sub: SubtitleEntry) => {
        const text = (sub.speechText || sub.text).trim();
        if (!text) return;
        // 先掐掉正在播的那句，否则两句叠在一起听不清
        if (audioAbortRef.current) { audioAbortRef.current(); audioAbortRef.current = null; }
        const cached = audioCacheRef.current.get(sub.id);
        const voiceConfig = cached ? null : resolveVoiceConfig(session.contactId);
        if (!cached && !voiceConfig) return;
        setReplayingId(sub.id);
        try {
            let blob: Blob | null = cached ?? null;
            if (!blob && voiceConfig) {
                blob = await synthesizeSpeech(text, voiceConfig);
                if (blob) cacheAudio(sub.id, blob);
            }
            if (!blob) return;
            const { promise, abort } = playCallAudio(blob);
            audioAbortRef.current = abort;
            await promise;
            audioAbortRef.current = null;
        } catch (e) {
            console.warn("[VoiceCall] replay failed:", e);
        } finally {
            setReplayingId((current) => (current === sub.id ? null : current));
        }
    }, [session.contactId, playCallAudio]);

    /** 编辑一句：改写真实记录 + 同步字幕文本，并作废这句的音频缓存。 */
    const handleEditSubtitle = useCallback((sub: SubtitleEntry, next: string) => {
        releaseAudioRefs(sub.messageIds);
        const ids = sub.messageIds ?? [];
        if (ids.length > 0) updateChatMessage(ids[0], { content: next });
        setSubtitles(prev => prev.map(item => item.id === sub.id
            ? { ...item, text: next, speechText: item.role === "assistant" ? next : undefined }
            : item));
        audioCacheRef.current.delete(sub.id);
        messagesRef.current = loadChatMessages(session.id);
    }, [session.id]);

    /** 删除一句：先删真实记录，再摘掉字幕。 */
    const handleDeleteSubtitle = useCallback((sub: SubtitleEntry) => {
        releaseAudioRefs(sub.messageIds);
        for (const id of sub.messageIds ?? []) deleteChatMessage(id);
        setSubtitles(prev => prev.filter(item => item.id !== sub.id));
        audioCacheRef.current.delete(sub.id);
        messagesRef.current = loadChatMessages(session.id);
    }, [session.id]);

    /**
     * 重新生成一句：删掉这句对应的记录，再让角色基于当前上下文重说一轮。
     *
     * 只在空闲时可用——正在生成或说话时重开会打断在途的一轮，状态机会乱。
     * 界面侧也只对「最后一条角色字幕」开放：它要删掉这句之后的记录，
     * 对中间句开放会把用户后面说的话一起级联删掉。
     */
    const handleRegenerateSubtitle = useCallback((sub: SubtitleEntry) => {
        if (stateRef.current !== "IDLE") return;
        releaseAudioRefs(sub.messageIds);
        for (const id of sub.messageIds ?? []) deleteChatMessage(id);
        setSubtitles(prev => prev.filter(item => item.id !== sub.id));
        audioCacheRef.current.delete(sub.id);
        // 先同步内存上下文再重开，否则角色会看见刚被删掉的那句
        messagesRef.current = loadChatMessages(session.id);
        void runConversationTurn();
    }, [session.id, runConversationTurn]);

    // ── 接入原生浮窗 ──
    //
    // 必须放在 handleHangup / runConversationTurn 定义之后：下面这个钩子的
    // 参数直接引用它们，位置提前会撞上 const 的暂时性死区，渲染即抛错。
    const shellOverlay = useShellCallOverlay({
        active: callState !== "CONNECTING" && callState !== "ENDED",
        label: "语音通话",
        name: character.name,
        avatar: bgImageResolved || character.avatar || null,
        // 墙钟推算而不是直接读 callDurationRef：页面在后台被系统冻结时，
        // 那个 state 的镜像会停在旧值，回灌给原生反而把浮窗时长往回拽。
        getDuration: () => Math.max(
            callDurationRef.current,
            callStartRef.current ? Math.floor((Date.now() - callStartRef.current) / 1000) : 0,
        ),
        // 浮窗里发来的消息一律进队列：忙时排队、空闲时自动补发，不再静默丢弃
        onReply: (text) => { replyQueue.submit(text); },
        onHangup: () => hangupRef.current(),
        onRestore,
        onTick: (seconds) => {
            // 原生计时校准：只前进、不后退。
            // 网页在后台被冻结时计时会落后，以原生为准把基准推上去；
            // 反过来（原生更小）一律忽略，否则时长来回跳，
            // 挂断时写进聊天记录的时长也跟着乱。
            if (seconds > callDurationRef.current) {
                callStartRef.current = Date.now() - seconds * 1000;
                callDurationRef.current = seconds;
                setCallDuration(seconds);
            }
        },
        // 待发条数同步给原生浮窗角标：切到别的 App 后队列看不见，
        // 这是唯一能告诉用户「话还排着、没丢」的地方。
        pendingCount: replyQueue.pending,
    });

    // 浮窗权限未开时的引导条（钩子里给标记，这里管自动消失）
    useEffect(() => {
        if (!shellOverlay.showPermissionHint) return;
        const done = () => shellOverlay.dismissPermissionHint();
        const timer = window.setTimeout(done, 12000);
        return () => window.clearTimeout(timer);
    }, [shellOverlay.showPermissionHint]);

    // ── 自动搭话按钮的拖动（指针事件；拖过就不触发开关） ──
    const handleAutoChatPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // 点在展开的面板内部（勾选框、数字框）时不拖动
        if ((event.target as HTMLElement).closest("[data-auto-chat-panel]")) return;
        const box = autoChatBoxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        event.currentTarget.setPointerCapture(event.pointerId);
        autoChatDragRef.current = {
            id: event.pointerId,
            sx: event.clientX,
            sy: event.clientY,
            ox: rect.left,
            oy: rect.top,
            moved: false,
        };
    }, []);

    const handleAutoChatPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = autoChatDragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.sx;
        const dy = event.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        const width = autoChatBoxRef.current?.offsetWidth ?? 120;
        const maxX = Math.max(0, window.innerWidth - width);
        setAutoChatPos({
            x: Math.min(Math.max(0, drag.ox + dx), maxX),
            y: Math.max(0, drag.oy + dy),
        });
    }, []);

    const handleAutoChatPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = autoChatDragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        autoChatDragRef.current = null;
        if (!drag.moved) {
            // 没移动 = 轻点：开合面板
            setShowAutoChatPanel(v => !v);
            return;
        }
        try {
            window.localStorage.setItem(AUTO_CHAT_POS_KEY, JSON.stringify(autoChatPos));
        } catch {
            /* 存不下就算了，不影响这次拖动 */
        }
    }, [autoChatPos]);

    // ── Render ──────────────────────────────────────

    if (minimized) {
        return (
            <CallMiniWindow
                imageUrl={bgImageResolved || character.avatar || null}
                title={character.name}
                meta={[callState === "ENDED" ? "通话已结束" : "语音通话", formatTime(callDuration)]}
                ariaLabel={`返回与${character.name}的语音通话`}
                onRestore={onRestore}
                // 长按小窗就地回复，不必先跳回通话界面
                onReply={(text) => replyQueue.submit(text) !== "rejected"}
                pendingCount={replyQueue.pending}
            />
        );
    }

    return (
        <div
            className="absolute inset-0 z-[100] flex flex-col text-white overflow-hidden call-bg-default call-keyboard-shift"
            style={bgImageResolved ? { ...keyboardOffsetStyle, background: `url(${bgImageResolved}) center/cover no-repeat` } : keyboardOffsetStyle}
        >
            {/* Dark overlay for readability */}
            <div
                className="call-overlay absolute inset-0 z-0"
                {...(bgImageResolved ? { "data-has-image": "" } : {})}
            />

            <CallVolumeControl />

            {/* 待发送提示：缩成小窗/全屏都看得见，避免以为消息丢了 */}
            {replyQueue.pending > 0 && (
                <div
                    style={{
                        position: "absolute", top: 12, left: "50%", transform: "translateX(-50%)",
                        zIndex: 45, padding: "4px 12px", borderRadius: 999,
                        background: "rgba(20,20,26,0.8)", backdropFilter: "blur(8px)",
                        fontSize: 11.5, color: "#fff", whiteSpace: "nowrap",
                    }}
                >
                    对方说完就发 · 还有 {replyQueue.pending} 条
                </div>
            )}

            {/* 浮窗权限未开：切出去时给一条引导（只在壳里、且确实触发过时出现） */}
            {shellOverlay.showPermissionHint && isShellEnvironment() && (
                <div
                    role="button"
                    onClick={() => { shellOverlay.requestPermission(); shellOverlay.dismissPermissionHint(); }}
                    style={{
                        position: "absolute", top: 100, left: 12, right: 12, zIndex: 40,
                        padding: "9px 12px", borderRadius: 12,
                        background: "rgba(20,20,26,0.88)", backdropFilter: "blur(10px)",
                        color: "#fff", fontSize: 12, lineHeight: 1.5, cursor: "pointer",
                        boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
                    }}
                >
                    切到其他 App 时会挂一个通话浮窗。首次使用需开启「显示在其他应用上层」权限，点这里去开。
                </div>
            )}

            {onMinimize && callState !== "ENDED" && (
                <button
                    type="button"
                    className="call-back-btn"
                    onClick={onMinimize}
                    aria-label="缩小通话"
                    title="缩小通话"
                >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
            )}

            {/* 自动搭话：我不出声时让角色主动找话说（煲电话粥用） */}
            {callState !== "CONNECTING" && callState !== "ENDED" && (
                <div
                    ref={autoChatBoxRef}
                    style={{
                        ...AUTO_CHAT_BOX_BASE,
                        top: autoChatPos.y,
                        ...(autoChatPos.x == null ? { right: 12 } : { left: autoChatPos.x }),
                    }}
                    onPointerDown={handleAutoChatPointerDown}
                    onPointerMove={handleAutoChatPointerMove}
                    onPointerUp={handleAutoChatPointerUp}
                    onPointerCancel={handleAutoChatPointerUp}
                >
                    <button
                        type="button"
                        aria-label="自动搭话设置"
                        title={
                            autoChatConfig.enabled
                                ? `自动搭话：静默 ${autoChatConfig.minSeconds}~${autoChatConfig.maxSeconds} 秒随机开口`
                                : "自动搭话：已关闭"
                        }
                        style={{
                            display: "flex", alignItems: "center", gap: 5,
                            padding: "6px 10px", borderRadius: 999, border: "none",
                            background: autoChatConfig.enabled ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.18)",
                            color: autoChatConfig.enabled ? "#1b1b22" : "#fff",
                            fontSize: 12, fontWeight: 600, cursor: "pointer",
                            backdropFilter: "blur(8px)",
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                        </svg>
                        {autoChatConfig.enabled
                            ? `自动搭话 ${autoChatConfig.minSeconds}~${autoChatConfig.maxSeconds}s`
                            : "自动搭话 关"}
                    </button>

                    {showAutoChatPanel && (
                        <div
                            data-auto-chat-panel=""
                            style={{
                                display: "flex", flexDirection: "column", gap: 9,
                                padding: "11px 12px", borderRadius: 14,
                                background: "rgba(20,20,26,0.82)", backdropFilter: "blur(10px)",
                                color: "#fff", fontSize: 12, minWidth: 196,
                                boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                            }}
                        >
                            <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <span style={{ fontWeight: 600 }}>自动搭话</span>
                                <input
                                    type="checkbox"
                                    checked={autoChatConfig.enabled}
                                    onChange={(e) => {
                                        const next = saveCallAutoChatConfig({ ...autoChatConfig, enabled: e.target.checked });
                                        setAutoChatConfig(next);
                                        autoTurnsRef.current = 0;
                                        emptyAutoTurnsRef.current = 0;
                                        autoChatDeadlineRef.current = 0;
                                    }}
                                    style={{ width: 18, height: 18, accentColor: "#fff" }}
                                />
                            </label>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <span>静默下限</span>
                                <input
                                    type="number"
                                    min={MIN_INTERVAL_SECONDS}
                                    defaultValue={autoChatConfig.minSeconds}
                                    title={`最小 ${MIN_INTERVAL_SECONDS} 秒`}
                                    onBlur={(e) => {
                                        const next = saveCallAutoChatConfig({ ...autoChatConfig, minSeconds: Number(e.target.value) });
                                        setAutoChatConfig(next);
                                        e.target.value = String(next.minSeconds);
                                        autoChatDeadlineRef.current = 0;
                                    }}
                                    style={AUTO_CHAT_INPUT_STYLE}
                                />
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <span>静默上限</span>
                                <input
                                    type="number"
                                    min={autoChatConfig.minSeconds}
                                    defaultValue={autoChatConfig.maxSeconds}
                                    title="不小于静默下限"
                                    onBlur={(e) => {
                                        const next = saveCallAutoChatConfig({ ...autoChatConfig, maxSeconds: Number(e.target.value) });
                                        setAutoChatConfig(next);
                                        e.target.value = String(next.maxSeconds);
                                        autoChatDeadlineRef.current = 0;
                                    }}
                                    style={AUTO_CHAT_INPUT_STYLE}
                                />
                            </div>

                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <span>条数上限</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={MAX_TURNS_LIMIT}
                                    defaultValue={autoChatConfig.maxTurns}
                                    title="0 = 不限"
                                    onBlur={(e) => {
                                        const next = saveCallAutoChatConfig({ ...autoChatConfig, maxTurns: Number(e.target.value) });
                                        setAutoChatConfig(next);
                                        e.target.value = String(next.maxTurns);
                                    }}
                                    style={AUTO_CHAT_INPUT_STYLE}
                                />
                            </div>

                            <div style={{ opacity: 0.62, lineHeight: 1.5 }}>
                                静默时长在上下限之间随机取值；条数上限填 0 = 不限。你开口后重新计数。
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Content wrapper — force white text so themes don't override call UI */}
            <div className="voicecall-controls gcall-body">
                {/* Top: Duration + Status */}
                <div className="gcall-topbar">
                    <div className="gcall-topbar-title">
                        {character.name}
                    </div>
                    <div
                        className="gcall-topbar-sub"
                        {...(callState === "CONNECTING" || callState === "PROCESSING" ? { "data-anim": "" } : {})}
                    >
                        {callState !== "CONNECTING" && callState !== "ENDED" ? `${formatTime(callDuration)} · ` : ""}
                        {stateLabel()}
                    </div>
                </div>

                {/* Center: Avatar + connecting ring */}
                <div className="flex-none flex justify-center items-center pt-[30px] pb-5">
                    <div className="relative flex items-center justify-center">
                        <div
                            className="voicecall-avatar"
                            {...(callState === "AI_SPEAKING" ? { "data-speaking": "" } : {})}
                        >
                            {character.avatar ? (
                                <img
                                    src={character.avatar}
                                    alt={character.name}
                                    className="w-full h-full object-cover"
                                />
                            ) : (
                                <span className="ts-48 text-[var(--c-icon)]">
                                    {character.name?.[0] || "?"}
                                </span>
                            )}
                        </div>
                        {callState === "CONNECTING" && (
                            <>
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite",
                                    }}
                                />
                                <div
                                    className="absolute w-[160px] h-[160px] rounded-full pointer-events-none"
                                    style={{
                                        border: "2px solid rgba(255,255,255,0.2)",
                                        animation: "voicecall-ring 1.5s ease-out infinite 0.5s",
                                    }}
                                />
                            </>
                        )}
                    </div>
                </div>

                <div className="text-center ts-18 font-semibold mb-2">
                    {character.name}
                </div>

                {/* Subtitle area — top fade via mask */}
                <div
                    ref={subtitleScrollRef}
                    className="voicecall-subtitle-mask flex-1 min-h-0 overflow-auto px-5 py-[10px] flex flex-col gap-2 relative"
                    {...(inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" ? { "data-text-input": "" } : {})}
                >
                    {/* 排队中的消息：角色说完这轮就会自动发出去，让用户知道没丢 */}
                    {replyQueue.pending > 0 && (
                        <div
                            style={{
                                alignSelf: "center", flexShrink: 0,
                                padding: "4px 12px", borderRadius: 999,
                                background: "rgba(255,255,255,0.16)", backdropFilter: "blur(8px)",
                                fontSize: 11.5, color: "rgba(255,255,255,0.92)",
                            }}
                        >
                            对方说完就发 · 还有 {replyQueue.pending} 条
                        </div>
                    )}
                    {subtitles.map((sub, index) => {
                        const isAssistant = sub.role === "assistant";
                        // 「重新生成」只给最后一条角色字幕：它要删掉这句及之后的记录重说，
                        // 对中间句开放会把用户后面说的话一起级联删掉。
                        const isLastAssistant = isAssistant
                            && !subtitles.slice(index + 1).some(item => item.role === "assistant");
                        const actions: CallSubtitleAction[] = [];
                        if (isLastAssistant) {
                            actions.push({
                                key: "regenerate",
                                label: "重新生成这一句",
                                onSelect: () => handleRegenerateSubtitle(sub),
                            });
                        }
                        actions.push({
                            key: "delete",
                            label: "删除这一句",
                            danger: true,
                            onSelect: () => handleDeleteSubtitle(sub),
                        });
                        return (
                            <CallSubtitleItem
                                key={sub.id}
                                role={sub.role}
                                text={sub.text}
                                bilingualClassName="call-subtitle-bilingual"
                                defaultExpanded={session.collapseBilingualTranslation !== false ? false : true}
                                onReplay={isAssistant ? () => { void handleReplaySubtitle(sub); } : undefined}
                                replaying={replayingId === sub.id}
                                actions={actions}
                                onEditSubmit={(next) => handleEditSubtitle(sub, next)}
                            />
                        );
                    })}

                    {/* Interim STT text */}
                    {interimText && callState === "USER_SPEAKING" && (
                        <div className="call-subtitle" data-interim="">
                            {interimText}
                        </div>
                    )}
                </div>

                {inputMode === "text" && callState !== "CONNECTING" && callState !== "ENDED" && (
                    <form
                        className="call-text-input-panel voicecall-text-input-panel call-text-input-row"
                        onSubmit={(e) => {
                            e.preventDefault();
                            handleTextSubmit();
                        }}
                    >
                        <button
                            type="button"
                            onClick={handleRegenerate}
                            className="call-regenerate-btn"
                            disabled={callState !== "IDLE"}
                            aria-label="让对方重新回复"
                            title="让对方重新回复"
                        >
                            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M23 4v6h-6" />
                                <path d="M1 20v-6h6" />
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                            </svg>
                        </button>
                        <div className="call-text-input-shell">
                            <input
                                value={typedText}
                                onChange={e => setTypedText(e.target.value)}
                                className="call-text-input"
                                placeholder={callState === "IDLE" ? "输入你想说的话..." : "稍等对方说完..."}
                                disabled={callState !== "IDLE"}
                            />
                            <button
                                type="submit"
                                className="call-text-send-btn"
                                disabled={!typedText.trim() || callState !== "IDLE"}
                                aria-label="发送"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 19V5" />
                                    <path d="M5 12l7-7 7 7" />
                                </svg>
                            </button>
                        </div>
                    </form>
                )}

                {/* 按住说话提示/错误行 */}
                {holdToTalk && inputMode === "voice" && callState !== "CONNECTING" && callState !== "ENDED" && (
                    <div className="text-center ts-12 opacity-80 px-5">
                        {holdInput.recState === "recording" ? "松开发送"
                            : holdInput.recState === "transcribing" ? "识别中…"
                            : holdInput.error || "按住下方麦克风说话"}
                    </div>
                )}

                {/* Bottom controls */}
                <div
                    className="flex justify-center items-center gap-[40px] p-5"
                    style={{ paddingBottom: "max(30px, env(safe-area-inset-bottom))" }}
                >
                    {callState !== "ENDED" && callState !== "CONNECTING" ? holdToTalk ? (
                        <>
                            {/* 输入方式切换（按住说话模式不需要持续开麦，静音位改放 Aa 切换） */}
                            <button
                                onClick={handleInputModeToggle}
                                className="ui-call-btn ui-call-btn-muted"
                                aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            >
                                {inputMode === "voice" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* 按住说话主按钮（文字模式下点按切回语音） */}
                            <button
                                className="ui-call-mic ui-call-mic-lg"
                                style={{ touchAction: "none" }}
                                data-state={
                                    inputMode === "text" ? "text"
                                        : holdInput.recState === "recording" ? "speaking"
                                        : callState === "IDLE" ? "idle"
                                        : "busy"
                                }
                                aria-label={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                                title={inputMode === "text" ? "切换到语音输入" : "按住说话"}
                                {...(inputMode === "voice" ? holdInput.pressHandlers : { onClick: handleInputModeToggle })}
                            >
                                {inputMode === "text" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Hangup */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                                aria-label="挂断"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                        </>
                    ) : androidTextInputOnly ? (
                        <button
                            onClick={handleHangup}
                            className="ui-call-btn ui-call-btn-danger"
                            aria-label="挂断"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    ) : (
                        <>
                            {/* Mute button */}
                            <button
                                onClick={() => setIsMuted(!isMuted)}
                                className="ui-call-btn ui-call-btn-muted"
                                {...(isMuted ? { "data-checked": "" } : {})}
                            >
                                {isMuted ? (
                                    /* Muted: mic with diagonal */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <line x1="1" y1="1" x2="23" y2="23" />
                                        <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                                        <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .76-.13 1.48-.35 2.15" />
                                        <line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" />
                                    </svg>
                                ) : (
                                    /* Active mic */
                                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Mic button — input mode toggle with voice-state indicator */}
                            <button
                                onClick={handleInputModeToggle}
                                className="ui-call-mic ui-call-mic-lg"
                                data-state={
                                    inputMode === "text" ? "text"
                                        : callState === "USER_SPEAKING" ? "speaking"
                                        : callState === "IDLE" ? (isMuted ? "idle-muted" : "idle")
                                        : "busy"
                                }
                                aria-label={androidTextInputOnly ? "文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                                title={androidTextInputOnly ? "安卓浏览器使用文字输入" : inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                            >
                                {inputMode === "text" ? (
                                    <span className="ui-call-input-text-icon">Aa</span>
                                ) : (
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                        <line x1="12" y1="19" x2="12" y2="22" />
                                    </svg>
                                )}
                            </button>

                            {/* Hangup button */}
                            <button
                                onClick={handleHangup}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                        </>
                    ) : callState === "CONNECTING" && initiator === "character" ? (
                        /* Incoming call: accept + decline */
                        <>
                            <button
                                onClick={() => {
                                    pushChatMessage({
                                        sessionId: session.id,
                                        role: "user",
                                        content: `[我拒绝了语音通话]`,
                                    });
                                    onEnd();
                                }}
                                className="ui-call-btn ui-call-btn-danger"
                            >
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                    <line x1="23" y1="1" x2="1" y2="23" />
                                </svg>
                            </button>
                            <button
                                onClick={() => setCallState("IDLE")}
                                className="ui-call-btn ui-call-btn-success"
                            >
                                {/* Phone pick-up icon */}
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
                                </svg>
                            </button>
                        </>
                    ) : callState === "CONNECTING" ? (
                        /* User-initiated: show cancel only */
                        <button
                            onClick={() => {
                                pushChatMessage({
                                    sessionId: session.id,
                                    role: "user",
                                    content: `[我取消了语音通话]`,
                                });
                                onEnd();
                            }}
                            className="ui-call-btn ui-call-btn-danger"
                        >
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                                <line x1="23" y1="1" x2="1" y2="23" />
                            </svg>
                        </button>
                    ) : (
                        /* ENDED state: show nothing, will auto-close */
                        <div className="ts-14 opacity-70">通话已结束</div>
                    )}
                </div>
            </div>

            {!androidTextInputOnly && showSttWarning && (
                <CallSttWarningDialog
                    onClose={() => setShowSttWarning(false)}
                    onNeverShow={handleNeverShowSttWarning}
                />
            )}

        </div>
    );
}
