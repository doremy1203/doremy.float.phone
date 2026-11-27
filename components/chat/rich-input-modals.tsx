"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { CallSttWarningDialog, hideCallSttWarningPermanently, isCallSttWarningHidden } from "./call-stt-warning-dialog";
import { isAndroidBrowser } from "./voice-input-platform";
import { extractReadableFileText, isSupportedReadableFile, SUPPORTED_FILE_ACCEPT } from "@/lib/file-text";
import { resolveCloudSttConfig, startCallRecording, transcribeAudioBlob, isCallRecordingSupported, type ActiveCallRecording, type CloudSttConfig } from "@/lib/stt-cloud";
import { isNativeSpeechAvailable, startNativeSpeech, stopNativeSpeech, cancelNativeSpeech } from "@/lib/native-speech";

// ── Photo Input Modal ─────────────────────────────

interface PhotoInputModalProps {
    onSend: (description: string, imageDataUrls: string[], mergeForDisplay: boolean) => void;
    onClose: () => void;
}

export function PhotoInputModal({ onSend, onClose }: PhotoInputModalProps) {
    const [desc, setDesc] = useState("");
    const [imageDataUrls, setImageDataUrls] = useState<string[]>([]);
    const [mergeForDisplay, setMergeForDisplay] = useState(false);
    const [reading, setReading] = useState(false);
    const [readError, setReadError] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = Array.from(e.target.files || []).filter(file => file.type.startsWith("image/"));
        e.target.value = "";
        if (!files.length) return;
        setReading(true);
        setReadError("");
        try {
            const loaded = await Promise.all(files.map(file => new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取图片"));
                reader.onerror = () => reject(new Error("读取图片失败"));
                reader.readAsDataURL(file);
            })));
            setImageDataUrls(prev => [...prev, ...loaded].slice(0, 9));
            if (imageDataUrls.length + loaded.length > 9) setReadError("最多发送 9 张图片，超出的图片未加入。");
        } catch (error) {
            setReadError(error instanceof Error ? error.message : "图片读取失败，请重新选择。");
        } finally { setReading(false); }
    };

    const canSend = imageDataUrls.length > 0 && !reading;
    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog" style={{ maxWidth: 420, width: "min(92vw, 420px)" }}>
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">发送照片</div>
                <div className="mt-1 text-center ts-12 text-[var(--c-icon)]">一次最多选择 9 张，可逐条发送，也可合并成可滑动相册</div>
                {imageDataUrls.length > 0 && <div className="mt-3 grid grid-cols-3 gap-2">
                    {imageDataUrls.map((src, index) => (
                        <div key={index} className="relative aspect-square overflow-hidden rounded-xl bg-[var(--c-input)]">
                            <img src={src} alt={`待发送图片 ${index + 1}`} className="h-full w-full object-cover" />
                            <button type="button" onClick={() => setImageDataUrls(prev => prev.filter((_, i) => i !== index))} className="absolute right-1 top-1 grid h-6 w-6 place-items-center rounded-full bg-black/65 text-white" aria-label="移除图片">×</button>
                        </div>
                    ))}
                </div>}
                {imageDataUrls.length < 9 && <button type="button" onClick={() => fileInputRef.current?.click()} className="mt-3 flex min-h-[116px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--c-icon)]/45 bg-[var(--c-input)]/35 px-4 py-5 text-[var(--c-icon)] transition-colors hover:bg-[var(--c-input)]/60">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    <span className="text-sm font-medium">{imageDataUrls.length ? "继续添加图片" : "选择图片"}</span>
                    <span className="text-xs opacity-70">一次最多 9 张 · 也可以继续添加</span>
                </button>}
                <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
                <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="添加描述（选填）" rows={2} className="mt-3 w-full resize-none rounded-xl border border-[var(--c-border)] bg-[var(--c-input)] p-3 text-sm outline-none" />
                {readError && <div role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">{readError}</div>}
                {imageDataUrls.length > 1 && (
                    <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-[var(--c-text)]">
                        <input type="checkbox" checked={mergeForDisplay} onChange={e => setMergeForDisplay(e.target.checked)} className="h-4 w-4 accent-[var(--c-primary)]" />
                        <span>发送后合并展示</span>
                        <span className="text-xs text-[var(--c-icon)]">作为一条可横向滑动的多图消息</span>
                    </label>
                )}
                <div className="mt-3 flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1">取消</button>
                    <button onClick={() => { if (canSend) onSend(desc.trim(), imageDataUrls, mergeForDisplay); }} disabled={!canSend} className="ui-btn ui-btn-success flex-1 disabled:opacity-50">{reading ? "读取中…" : `发送 ${imageDataUrls.length ? `(${imageDataUrls.length})` : ""}`}</button>
                </div>
            </div>
        </div>
    );
}

// ── Generic File Modal ────────────────────────────

interface FileInputModalProps {
    onSend: (fileName: string, mime: string, dataUrl: string, extra: { text: string; truncated: boolean; size: number }) => void;
    onClose: () => void;
}

export function FileInputModal({ onSend, onClose }: FileInputModalProps) {
    const [file, setFile] = useState<File | null>(null);
    const [dataUrl, setDataUrl] = useState("");
    const [fileText, setFileText] = useState("");
    const [textTruncated, setTextTruncated] = useState(false);
    const [error, setError] = useState("");
    const [reading, setReading] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const maxBytes = 25 * 1024 * 1024;
    const forbidden = /\.(apk|exe|bat|cmd|sh|msi|dll|so|bin)$/i;

    const pick = async (next: File | null) => {
        setError("");
        setDataUrl("");
        setFileText("");
        setTextTruncated(false);
        setFile(null);
        if (!next) return;
        if (next.size > maxBytes) { setError("文件不能超过 25MB"); return; }
        if (forbidden.test(next.name)) { setError("暂不支持发送可执行文件"); return; }
        if (!isSupportedReadableFile(next.name, next.type)) {
            setError("只支持 txt / md / csv / json / xml / yaml / html / docx / pdf；压缩包、音视频请用对应入口发送");
            return;
        }
        setReading(true);
        const value = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("读取文件失败"));
            reader.onerror = () => reject(new Error("读取文件失败"));
            reader.readAsDataURL(next);
        }).catch(err => { setError(err instanceof Error ? err.message : "读取文件失败"); return ""; });
        if (!value) { setReading(false); return; }
        try {
            const extracted = await extractReadableFileText(next.name, next.type, value);
            if (!extracted) throw new Error("这个格式暂时无法读取文字");
            setFile(next);
            setDataUrl(value);
            setFileText(extracted.text);
            setTextTruncated(extracted.truncated);
        } catch (err) {
            setError(err instanceof Error ? err.message : "文档解析失败");
        } finally {
            setReading(false);
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog" style={{ maxWidth: 420, width: "min(92vw, 420px)" }}>
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">发送文档</div>
                <div className="mt-1 text-center ts-12 text-[var(--c-icon)]">支持 txt / md / csv / json / xml / yaml / html / docx / pdf，最大 25MB；会抽取文字给角色读，也能在对话里预览。扫描版 PDF 没有文字层，暂时读不出内容</div>
                <button type="button" disabled={reading} onClick={() => inputRef.current?.click()} className="mt-4 flex min-h-[116px] w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--c-icon)]/45 bg-[var(--c-input)]/35 px-4 py-5 text-[var(--c-icon)] transition-colors hover:bg-[var(--c-input)]/60 disabled:opacity-50">
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    <span className="text-sm font-medium">{reading ? "正在读取文档…" : file ? file.name : "选择文档"}</span>
                    <span className="text-xs opacity-70">{file ? `${(file.size / 1024).toFixed(1)} KB · ${file.type || "文档"}${textTruncated ? " · 内容已截断" : ""}` : "只显示支持的格式"}</span>
                </button>
                <input ref={inputRef} type="file" accept={SUPPORTED_FILE_ACCEPT} className="hidden" onChange={e => { void pick(e.target.files?.[0] ?? null); e.target.value = ""; }} />
                {error && <div role="alert" className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs leading-relaxed text-rose-700">{error}</div>}
                {fileText && <div className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--c-input)] px-3 py-2 text-[11px] leading-relaxed text-[var(--c-icon)]">{fileText.slice(0, 1200)}{fileText.length > 1200 ? "\n…" : ""}</div>}
                <div className="mt-4 flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1">取消</button>
                    <button onClick={() => { if (file && dataUrl) onSend(file.name, file.type || "application/octet-stream", dataUrl, { text: fileText, truncated: textTruncated, size: file.size }); }} disabled={!file || !dataUrl || reading} className="ui-btn ui-btn-success flex-1 disabled:opacity-50">发送</button>
                </div>
            </div>
        </div>
    );
}

// ── Red Packet Modal ─────────────────────────────

interface RedPacketModalProps {
    mode: "red_packet" | "transfer";
    isGroup?: boolean;
    onSend: (amount: number, label: string, count?: number) => void;
    onClose: () => void;
}

export function RedPacketModal({ mode, isGroup, onSend, onClose }: RedPacketModalProps) {
    const [amount, setAmount] = useState("");
    const [label, setLabel] = useState("");
    const [count, setCount] = useState("1");

    const isRedPacket = mode === "red_packet";
    const title = isRedPacket ? "发红包" : "转账";
    const defaultLabel = isRedPacket ? "恭喜发财，大吉大利" : "";
    // Brand-specific colors: WeChat red packet / transfer (CSS variables)
    const color = isRedPacket ? "var(--c-redpacket)" : "var(--c-transfer)";

    const handleSend = () => {
        const num = parseFloat(amount);
        if (!num || num <= 0) return;
        const cnt = isRedPacket ? (isGroup ? Math.max(1, parseInt(count, 10) || 1) : 1) : undefined;
        onSend(num, label.trim() || defaultLabel, cnt);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="w-[300px] bg-[var(--c-card)] rounded-2xl overflow-hidden"
            >
                {/* Brand-colored header -- kept as inline style */}
                <div
                    className="p-5 flex flex-col items-center gap-2"
                    style={{ background: color }}
                >
                    <div className="ts-28">{isRedPacket ? "🧧" : "💰"}</div>
                    <div className="text-white ts-16 font-semibold">{title}</div>
                </div>
                <div className="p-5 flex flex-col gap-3.5">
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">金额</div>
                        <div className="flex items-center gap-2">
                            <span
                                className="ts-24 font-bold"
                                style={{ color }}
                            >¥</span>
                            <input
                                value={amount}
                                onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
                                placeholder="0.00"
                                type="text"
                                inputMode="decimal"
                                className="flex-1 py-2 border-none ts-28 font-bold outline-none text-center bg-transparent"
                                style={{ borderBottom: `2px solid ${color}` }}
                                        />
                        </div>
                    </div>
                    {isRedPacket && isGroup && (
                        <div>
                            <div className="ts-12 text-[var(--c-icon)] mb-1.5">个数</div>
                            <input
                                value={count}
                                onChange={e => setCount(e.target.value.replace(/[^0-9]/g, ""))}
                                placeholder="1"
                                type="text"
                                inputMode="numeric"
                                className="ui-input w-full"
                            />
                        </div>
                    )}
                    <div>
                        <div className="ts-12 text-[var(--c-icon)] mb-1.5">
                            {isRedPacket ? "留言" : "备注"}
                        </div>
                        <input
                            value={label}
                            onChange={e => setLabel(e.target.value)}
                            placeholder={defaultLabel || "添加备注"}
                            className="ui-input w-full"
                        />
                    </div>
                    <div className="flex gap-3 mt-1">
                        <button
                            onClick={onClose}
                            className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1"
                        >取消</button>
                        <button
                            onClick={handleSend}
                            disabled={!parseFloat(amount)}
                            className="flex-1 py-2.5 rounded-lg border-none text-white ts-14 font-semibold"
                            style={{
                                background: parseFloat(amount) ? color : "var(--c-icon)",
                                cursor: parseFloat(amount) ? "pointer" : "default",
                            }}
                        >{isRedPacket ? "塞入红包" : "确认转账"}</button>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── Location Input Modal ─────────────────────────────

interface LocationInputModalProps {
    onSend: (locationName: string) => void;
    onClose: () => void;
}

export function LocationInputModal({ onSend, onClose }: LocationInputModalProps) {
    const [loc, setLoc] = useState("");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                className="modal-dialog"
            >
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">分享位置</div>
                <div
                    className="w-full h-[100px] rounded-xl flex items-center justify-center relative ui-map-gradient"
                >
                    <div className="ui-map-grid" />
                    <div className="text-4xl relative z-1">📍</div>
                </div>
                <input
                    value={loc}
                    onChange={e => setLoc(e.target.value)}
                    placeholder="输入地点名称..."
                    className="ui-input w-full"
                    onKeyDown={e => { if (e.key === "Enter" && loc.trim()) onSend(loc.trim()); }}
                />
                <div className="flex gap-3 w-full">
                    <button
                        onClick={onClose}
                        className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1"
                    >取消</button>
                    <button
                        onClick={() => { if (loc.trim()) onSend(loc.trim()); }}
                        disabled={!loc.trim()}
                        className="ui-btn ui-btn-success flex-1"
                    >发送</button>
                </div>
            </div>
        </div>
    );
}

// ── Text Photo Modal ─────────────────────────────

interface TextPhotoModalProps {
    onSend: (text: string) => void;
    onClose: () => void;
}

export function TextPhotoModal({ onSend, onClose }: TextPhotoModalProps) {
    const [text, setText] = useState("");

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">文字图片</div>
                <div className="w-full h-[100px] rounded-xl flex items-center justify-center ui-placeholder-gradient">
                    <span className="ts-13 text-[var(--c-text)] opacity-60 px-4 text-center leading-relaxed">
                        {text.trim() || "输入文字，生成图片"}
                    </span>
                </div>
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder="描述图片内容..."
                    className="ui-input w-full"
                    rows={3}
                    style={{ resize: "none" }}
                />
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1">取消</button>
                    <button
                        onClick={() => { if (text.trim()) onSend(text.trim()); }}
                        disabled={!text.trim()}
                        className="ui-btn ui-btn-success flex-1"
                    >发送</button>
                </div>
            </div>
        </div>
    );
}

// ── System Instruction Modal ─────────────────────────────

interface SystemInstructionModalProps {
    onSend: (text: string) => void;
    onClose: () => void;
}

export function SystemInstructionModal({ onSend, onClose }: SystemInstructionModalProps) {
    const [text, setText] = useState("");
    const trimmed = text.trim();

    const submit = () => {
        if (!trimmed) return;
        onSend(trimmed);
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">系统指令注入</div>
                <label className="w-full flex flex-col gap-2">
                    <span className="menu-label">指令内容</span>
                    <textarea
                        value={text}
                        onChange={e => setText(e.target.value)}
                        onKeyDown={e => {
                            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                                e.preventDefault();
                                submit();
                            }
                        }}
                        aria-label="系统指令内容"
                        className="ui-input w-full min-h-[160px]"
                        rows={6}
                        style={{ resize: "vertical" }}
                    />
                </label>
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1">取消</button>
                    <button
                        onClick={submit}
                        disabled={!trimmed}
                        className="ui-btn ui-btn-primary flex-1"
                    >注入</button>
                </div>
            </div>
        </div>
    );
}

// ── Voice Record Modal ─────────────────────────────

interface VoiceRecordModalProps {
    characterId: string;
    onSend: (text: string, audioDataUrl?: string) => void;
    onClose: () => void;
}

export function VoiceRecordModal({ characterId, onSend, onClose }: VoiceRecordModalProps) {
    const nativeSpeechRef = useRef(isAndroidBrowser() && isNativeSpeechAvailable());
    const nativeSpeech = nativeSpeechRef.current;
    const androidCloudSttRef = useRef<CloudSttConfig | null>(
        typeof window !== "undefined" && isAndroidBrowser() ? resolveCloudSttConfig(characterId) : null,
    );
    const androidCloudStt = androidCloudSttRef.current;
    const androidTextInputOnlyRef = useRef(isAndroidBrowser() && !nativeSpeech && !androidCloudStt);
    const androidTextInputOnly = androidTextInputOnlyRef.current;
    const [state, setState] = useState<"idle" | "recording" | "processing" | "done">("idle");
    const [inputMode, setInputMode] = useState<"voice" | "text">(() => androidTextInputOnly ? "text" : "voice");
    const [interim, setInterim] = useState("");
    const [finalText, setFinalText] = useState("");
    const [manualText, setManualText] = useState("");
    const [audioDataUrl, setAudioDataUrl] = useState<string | null>(null);
    const [showSttWarning, setShowSttWarning] = useState(false);
    const sttRef = useRef<{ stop: () => void; abort: () => void } | null>(null);
    const recorderRef = useRef<MediaRecorder | null>(null);
    const chunksRef = useRef<Blob[]>([]);
    const streamRef = useRef<MediaStream | null>(null);
    const androidRecordingRef = useRef<ActiveCallRecording | null>(null);
    const nativeSpeechActiveRef = useRef(false);
    const nativeSpeechTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const gotFinalRef = useRef(false);

    const showSttCompatibilityWarning = useCallback(() => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (isCallSttWarningHidden()) {
            setInputMode("text");
            return;
        }
        setShowSttWarning(true);
    }, [androidTextInputOnly]);

    const handleNeverShowSttWarning = useCallback(() => {
        hideCallSttWarningPermanently();
        setShowSttWarning(false);
        setInputMode("text");
    }, []);

    const clearNativeSpeechTimer = useCallback(() => {
        if (nativeSpeechTimerRef.current) {
            clearTimeout(nativeSpeechTimerRef.current);
            nativeSpeechTimerRef.current = null;
        }
    }, []);

    const startRecording = useCallback(async () => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        setState("idle");
        setInterim("");
        setFinalText("");
        setAudioDataUrl(null);
        chunksRef.current = [];
        gotFinalRef.current = false;

        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }

        // Android 优先用系统原生 SpeechRecognizer：不经过用户的语音模型/API，
        // 说完直接拿系统转写文字，发成语音条。
        if (isAndroidBrowser() && nativeSpeech) {
            setState("recording");
            setInterim("🎙️ 正在听…");
            nativeSpeechActiveRef.current = true;
            clearNativeSpeechTimer();
            nativeSpeechTimerRef.current = setTimeout(() => {
                if (!nativeSpeechActiveRef.current) return;
                nativeSpeechActiveRef.current = false;
                cancelNativeSpeech();
                setState("idle");
                setInterim("没有识别到内容，再试一次");
            }, 60_000);
            const started = startNativeSpeech("zh-CN", event => {
                if (!nativeSpeechActiveRef.current) return;
                if (event.type === "partial" && event.text) {
                    setInterim(event.text);
                    return;
                }
                if (event.type === "final") {
                    clearNativeSpeechTimer();
                    nativeSpeechActiveRef.current = false;
                    const text = String(event.text || "").trim();
                    if (!text) {
                        setState("idle");
                        setInterim(event.message || "没有识别到内容");
                        return;
                    }
                    setFinalText(text);
                    setInterim("");
                    setState("done");
                    return;
                }
                if (event.type === "error") {
                    clearNativeSpeechTimer();
                    nativeSpeechActiveRef.current = false;
                    setState("idle");
                    setInterim(event.code === "language"
                        ? "系统语音服务没有中文语言包；可以先用键盘上的麦克风说话，或在「设置 → 语音」配置云端 STT。"
                        : (event.message || "系统语音识别失败"));
                }
            });
            if (!started.ok) {
                clearNativeSpeechTimer();
                nativeSpeechActiveRef.current = false;
                setState("idle");
                setInterim(started.reason || "系统语音识别启动失败");
            }
            return;
        }

        // Android WebView 没有 Web Speech API：改用壳里已有的录音 + 云端 STT，
        // 这样发出去的是用户真实声音，同时角色也能读到转写文字。
        if (isAndroidBrowser() && androidCloudStt) {
            if (!isCallRecordingSupported()) {
                setInterim("当前环境不支持录音");
                showSttCompatibilityWarning();
                return;
            }
            try {
                const recording = await startCallRecording();
                androidRecordingRef.current = recording;
                setState("recording");
                setInterim("🎙️ 正在录音…");
            } catch (error) {
                setInterim(error instanceof Error ? error.message : "录音失败");
                showSttCompatibilityWarning();
            }
            return;
        }

        // Start STT (browser Web Speech API) before opening the mic. Unsupported
        // Android browsers should show the fallback prompt without flashing recording UI.
        const { createSTTSession } = await import("@/lib/stt-service");
        const stt = createSTTSession({
            onInterim: (t) => setInterim(t),
            onFinal: (t) => { gotFinalRef.current = true; setFinalText(t); setState("done"); recorderRef.current?.stop(); },
            onError: (e) => { setInterim(e); setState("idle"); recorderRef.current?.stop(); showSttCompatibilityWarning(); },
            onEnd: () => { if (!gotFinalRef.current) { setState("idle"); recorderRef.current?.stop(); } },
            onNoSpeech: () => { setInterim("未检测到语音"); setState("idle"); recorderRef.current?.stop(); showSttCompatibilityWarning(); },
        }, "zh-CN");

        if (!stt.isSupported) {
            showSttCompatibilityWarning();
            return;
        }

        if (!navigator.mediaDevices?.getUserMedia) {
            setInterim("无法访问麦克风");
            showSttCompatibilityWarning();
            return;
        }

        let stream: MediaStream | null = null;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            setInterim("无法访问麦克风");
            showSttCompatibilityWarning();
            return;
        }
        streamRef.current = stream;

        // Start recorder
        const recorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm" });
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
        recorder.onstop = () => {
            stream!.getTracks().forEach(t => t.stop());
            if (chunksRef.current.length > 0) {
                const blob = new Blob(chunksRef.current, { type: "audio/webm" });
                const reader = new FileReader();
                reader.onload = () => setAudioDataUrl(reader.result as string);
                reader.readAsDataURL(blob);
            }
        };
        recorder.start();

        sttRef.current = stt;
        setState("recording");
        setInterim("🎙️ 正在听...");
        stt.start();
    }, [androidTextInputOnly, characterId, showSttCompatibilityWarning]);

    const stopRecording = async () => {
        if (nativeSpeechActiveRef.current) {
            clearNativeSpeechTimer();
            stopNativeSpeech();
            setState("processing");
            setInterim("识别中...");
            nativeSpeechTimerRef.current = setTimeout(() => {
                if (!nativeSpeechActiveRef.current) return;
                nativeSpeechActiveRef.current = false;
                cancelNativeSpeech();
                setState("idle");
                setInterim("没有识别到内容，再试一次");
            }, 8_000);
            return;
        }
        const androidRecording = androidRecordingRef.current;
        if (androidRecording) {
            androidRecordingRef.current = null;
            setState("processing");
            setInterim("识别中...");
            try {
                const blob = await androidRecording.stop();
                if (!blob) throw new Error("没有录到声音");
                if (!androidCloudStt) throw new Error("没有可用的语音识别配置");
                const text = await transcribeAudioBlob(blob, androidCloudStt);
                if (!text.trim()) throw new Error("没有识别到内容");
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("录音读取失败"));
                    reader.onerror = () => reject(new Error("录音读取失败"));
                    reader.readAsDataURL(blob);
                });
                setAudioDataUrl(dataUrl);
                setFinalText(text.trim());
                setInterim("");
                setState("done");
            } catch (error) {
                setState("idle");
                setInterim(error instanceof Error ? error.message : "语音识别失败");
                showSttCompatibilityWarning();
            }
            return;
        }
        sttRef.current?.stop();
        recorderRef.current?.stop();
        setState("processing");
        setInterim("识别中...");
    };

    useEffect(() => () => {
        sttRef.current?.abort();
        recorderRef.current?.stop();
        streamRef.current?.getTracks().forEach(t => t.stop());
        androidRecordingRef.current?.cancel();
        androidRecordingRef.current = null;
        nativeSpeechActiveRef.current = false;
        clearNativeSpeechTimer();
        cancelNativeSpeech();
    }, [clearNativeSpeechTimer]);

    const switchInputMode = () => {
        if (androidTextInputOnly) {
            setInputMode("text");
            return;
        }
        if (inputMode === "voice") {
            sttRef.current?.abort();
            androidRecordingRef.current?.cancel();
            androidRecordingRef.current = null;
            nativeSpeechActiveRef.current = false;
            clearNativeSpeechTimer();
            cancelNativeSpeech();
            if (recorderRef.current && recorderRef.current.state !== "inactive") {
                recorderRef.current.stop();
            }
            streamRef.current?.getTracks().forEach(t => t.stop());
            setState("idle");
            setInterim("");
            setInputMode("text");
        } else {
            setInputMode("voice");
        }
    };

    const canSend = inputMode === "text" ? !!manualText.trim() : state === "done" && !!finalText.trim();

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog relative">
                {!androidTextInputOnly && (
                    <button
                        type="button"
                        className="voice-input-mode-toggle"
                        onClick={switchInputMode}
                        aria-label={inputMode === "voice" ? "切换到文字输入" : "切换到语音输入"}
                        title={inputMode === "voice" ? "文字输入" : "语音输入"}
                    >
                        {inputMode === "voice" ? "Aa" : (
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                                <line x1="12" y1="19" x2="12" y2="22" />
                            </svg>
                        )}
                    </button>
                )}
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">语音消息</div>
                <div className="w-full min-h-[80px] flex flex-col items-center justify-center gap-3 py-4">
                    {inputMode === "text" ? (
                        <>
                            <textarea
                                value={manualText}
                                onChange={e => setManualText(e.target.value)}
                                className="voice-text-mode-input"
                                placeholder="输入语音条内容..."
                                rows={3}
                            />
                            {androidTextInputOnly && (
                                <div className="px-3 text-center text-[11px] leading-relaxed text-[var(--c-icon)]">
                                    这台设备没有可用的系统语音识别，也没配置云端 STT。可以先在「设置 → 语音」配置 OpenAI 兼容的 STT，或直接输入文字语音条。
                                </div>
                            )}
                        </>
                    ) : state === "idle" && (
                        <button onClick={startRecording} className="w-[64px] h-[64px] rounded-full bg-[var(--c-success)] flex items-center justify-center">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            </svg>
                        </button>
                    )}
                    {state === "recording" && (
                        <button onClick={stopRecording} className="w-[64px] h-[64px] rounded-full bg-[var(--c-danger)] flex items-center justify-center" style={{ animation: "voicecall-pulse 1.5s ease-in-out infinite" }}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="white"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                        </button>
                    )}
                    {state === "processing" && (
                        <div className="w-[64px] h-[64px] rounded-full bg-[var(--c-input)] flex items-center justify-center">
                            <svg width="24" height="24" viewBox="0 0 24 24" className="animate-spin" fill="none" stroke="var(--c-icon)" strokeWidth="2"><path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" /></svg>
                        </div>
                    )}
                    {state === "done" && (
                        <div className="ts-14 text-[var(--c-text)] text-center px-4 leading-relaxed">{finalText}</div>
                    )}
                    {state === "idle" && interim && (
                        <span className="ts-13 text-rose-600 text-center px-4 leading-relaxed">{interim}</span>
                    )}
                    {(state === "recording" || state === "processing") && (
                        <span className="ts-13 text-[var(--c-icon)]">{interim || "点击停止录音"}</span>
                    )}
                    {inputMode === "voice" && nativeSpeech && state === "idle" && (
                        <span className="px-3 text-center text-[11px] leading-relaxed text-[var(--c-icon)]">点麦克风开始说话，停止后由系统语音识别转成文字，再发成语音条；不经过你自己的语音模型/API。</span>
                    )}
                    {inputMode === "voice" && !nativeSpeech && androidCloudStt && state === "idle" && (
                        <span className="px-3 text-center text-[11px] leading-relaxed text-[var(--c-icon)]">点麦克风开始录音；停止后会先转写成文字给角色读，同时把真实录音一起发出去。</span>
                    )}
                </div>
                <div className="flex gap-3 w-full">
                    <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost flex-1">取消</button>
                    <button
                        onClick={() => {
                            if (!canSend) return;
                            if (inputMode === "text") onSend(manualText.trim());
                            else onSend(finalText.trim(), audioDataUrl || undefined);
                        }}
                        disabled={!canSend}
                        className="ui-btn ui-btn-success flex-1"
                    >发送</button>
                </div>
                {!androidTextInputOnly && showSttWarning && (
                    <CallSttWarningDialog
                        title="语音消息提示"
                        message="当前浏览器可能不支持语音识别、系统麦克风权限未开启，或麦克风没有输入。你可以点击右上角 Aa，改用文字输入来发送语音条内容。"
                        onClose={() => setShowSttWarning(false)}
                        onNeverShow={handleNeverShowSttWarning}
                    />
                )}
            </div>
        </div>
    );
}
