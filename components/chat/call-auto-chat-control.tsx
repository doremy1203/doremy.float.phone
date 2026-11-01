"use client";

// 通话「自动搭话」的悬浮按钮 + 设置面板（可拖动，位置记在本地）。
//
// 语音通话屏里这套 UI 原本是内联写死的；视频 / 群聊通话要补同样的能力，
// 于是抽成组件。外观与交互同语音那套保持一致：一个小胶囊按钮，点开是设置面板，
// 按住可拖动（默认靠右上，避开左上角的缩小键）。

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import {
    type CallAutoChatConfig,
    type CallAutoChatStatus,
    MAX_TURNS_LIMIT,
    MIN_INTERVAL_SECONDS,
    readCallAutoChatStatus,
} from "@/lib/call-auto-chat";

/** 面板里的数字输入框（深底浅字，随面板走） */
const NUM_INPUT_STYLE: CSSProperties = {
    width: 66,
    padding: "4px 6px",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(255,255,255,0.1)",
    color: "#fff",
    fontSize: 12,
    textAlign: "center",
};

/** 默认落点（可拖动，拖动后位置记在本地）。
 *  默认靠右上：放左上会与「缩小通话」返回键叠在一起，返回键被挡住点不到。 */
const DEFAULT_POS: { x: number | null; y: number } = { x: null, y: 104 };
const POS_KEY = "call-auto-chat-btn-pos-v1";

function readPos(): { x: number | null; y: number } {
    if (typeof window === "undefined") return { ...DEFAULT_POS };
    try {
        const raw = window.localStorage.getItem(POS_KEY);
        if (!raw) return { ...DEFAULT_POS };
        const parsed = JSON.parse(raw) as { x?: number | null; y?: number };
        return {
            x: typeof parsed.x === "number" ? parsed.x : null,
            y: typeof parsed.y === "number" ? parsed.y : DEFAULT_POS.y,
        };
    } catch {
        return { ...DEFAULT_POS };
    }
}

/** 倒计时短文案（按钮上用，整数秒） */
function remainShort(status: CallAutoChatStatus | null, now: number): string {
    if (!status) return "";
    if (!status.deadlineAt) return "重排中";
    return `${Math.ceil(Math.max(0, (status.deadlineAt - now) / 1000))}s`;
}

/** 倒计时精确文案（面板里用） */
function remainText(status: CallAutoChatStatus, now: number): string {
    if (!status.deadlineAt) return "待重排";
    const left = (status.deadlineAt - now) / 1000;
    return left > 0 ? `${left.toFixed(1)} 秒后` : "已到点，下一秒触发";
}

/** 心跳健康度：上次心跳距今多久。超过 3 秒说明网页定时器被系统冻结了 */
function heartbeatText(status: CallAutoChatStatus, now: number): { text: string; ok: boolean } {
    if (!status.tickedAt) return { text: "未启动", ok: false };
    const age = (now - status.tickedAt) / 1000;
    if (age > 3) return { text: `停滞 ${age.toFixed(0)} 秒（后台被冻结）`, ok: false };
    return { text: "正常", ok: true };
}

type CallAutoChatControlProps = {
    config: CallAutoChatConfig;
    /** 改一项设置（内部会存盘并广播，节拍随之复位） */
    onUpdate: (patch: Partial<CallAutoChatConfig>) => CallAutoChatConfig;
};

export function CallAutoChatControl({ config, onUpdate }: CallAutoChatControlProps) {
    const [showPanel, setShowPanel] = useState(false);
    const [pos, setPos] = useState(readPos);
    // 运行状态：由 useCallAutoChat 的心跳每秒登记，这里轮询读取（只读，不参与判定）
    const [status, setStatus] = useState<CallAutoChatStatus | null>(null);
    const [now, setNow] = useState(() => Date.now());
    const boxRef = useRef<HTMLDivElement | null>(null);

    // 500ms 轮询：倒计时与心跳年龄得一直在动，才看得出「卡住了」和「在走」
    useEffect(() => {
        const pull = () => {
            setNow(Date.now());
            setStatus(readCallAutoChatStatus());
        };
        pull();
        const timer = window.setInterval(pull, 500);
        return () => window.clearInterval(timer);
    }, []);
    const dragRef = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number; moved: boolean } | null>(null);

    const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        // 点在展开的面板内部（勾选框、数字框）时不拖动
        if ((event.target as HTMLElement).closest("[data-auto-chat-panel]")) return;
        const box = boxRef.current;
        if (!box) return;
        const rect = box.getBoundingClientRect();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = {
            id: event.pointerId,
            sx: event.clientX,
            sy: event.clientY,
            ox: rect.left,
            oy: rect.top,
            moved: false,
        };
    }, []);

    const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.sx;
        const dy = event.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (!drag.moved) return;
        const width = boxRef.current?.offsetWidth ?? 120;
        const maxX = Math.max(0, window.innerWidth - width);
        setPos({
            x: Math.min(Math.max(0, drag.ox + dx), maxX),
            y: Math.max(0, drag.oy + dy),
        });
    }, []);

    const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (!drag || drag.id !== event.pointerId) return;
        dragRef.current = null;
        if (!drag.moved) {
            // 没移动 = 轻点：开合面板
            setShowPanel(v => !v);
            return;
        }
        try {
            window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
        } catch {
            /* 存不下就算了，不影响这次拖动 */
        }
    }, [pos]);

    // 只在面板显示时才有内容，否则按钮角标也空着
    const remain = remainShort(status, now);
    const heartbeat = status ? heartbeatText(status, now) : null;
    const turnsLabel = status
        ? (status.maxTurns > 0 ? `${status.turns}/${status.maxTurns}` : `${status.turns}/不限`)
        : "";

    return (
        <div
            ref={boxRef}
            style={{
                position: "absolute",
                zIndex: 30,
                top: pos.y,
                ...(pos.x == null ? { right: 12 } : { left: pos.x }),
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-end",
                gap: 6,
                touchAction: "none",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerUp}
        >
            <button
                type="button"
                aria-label="自动搭话设置"
                title={
                    config.enabled
                        ? `自动搭话：静默 ${config.minSeconds}~${config.maxSeconds} 秒随机开口`
                        : "自动搭话：已关闭"
                }
                style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "6px 10px", borderRadius: 999, border: "none",
                    background: config.enabled ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.18)",
                    color: config.enabled ? "#1b1b22" : "#fff",
                    fontSize: 12, fontWeight: 600, cursor: "pointer",
                    backdropFilter: "blur(8px)",
                }}
            >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
                </svg>
                {config.enabled
                    ? (remain ? `自动搭话 ${remain}` : `自动搭话 ${config.minSeconds}~${config.maxSeconds}s`)
                    : "自动搭话 关"}
            </button>

            {showPanel && (
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
                    {/* 实时状态：手机上开不了控制台，问题都在这块看 */}
                    {status && (
                        <div
                            data-auto-chat-status=""
                            style={{
                                display: "flex", flexDirection: "column", gap: 5,
                                padding: "8px 9px", borderRadius: 10,
                                background: "rgba(255,255,255,0.07)",
                                border: "1px solid rgba(255,255,255,0.12)",
                                lineHeight: 1.5,
                            }}
                        >
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span style={{ opacity: 0.62 }}>下次开口</span>
                                <span style={{ fontWeight: 600 }}>{remainText(status, now)}</span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span style={{ opacity: 0.62 }}>心跳</span>
                                <span style={{ color: heartbeat?.ok ? "#8ee6a8" : "#ffb46b", fontWeight: 600 }}>
                                    {heartbeat?.text ?? "未启动"}
                                </span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span style={{ opacity: 0.62 }}>本轮自动搭话</span>
                                <span>{turnsLabel}{status.emptyTurns > 0 ? `（空转 ${status.emptyTurns}）` : ""}</span>
                            </div>
                            <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                <span style={{ opacity: 0.62 }}>通话状态</span>
                                <span>{status.state === "IDLE" ? "安静（可开口）" : status.state}</span>
                            </div>
                            <div style={{ opacity: 0.78, color: "#ffdcb0" }}>{status.reason}</div>
                            {status.events.length > 0 && (
                                <div style={{ display: "flex", flexDirection: "column", gap: 2, opacity: 0.55, fontSize: 11 }}>
                                    {status.events.slice(-3).map((line, index) => (
                                        <div key={`${line}-${index}`}>{line}</div>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}

                    <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span style={{ fontWeight: 600 }}>自动搭话</span>
                        <input
                            type="checkbox"
                            checked={config.enabled}
                            onChange={(e) => onUpdate({ enabled: e.target.checked })}
                            style={{ width: 18, height: 18, accentColor: "#fff" }}
                        />
                    </label>

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span>静默下限</span>
                        <input
                            type="number"
                            min={MIN_INTERVAL_SECONDS}
                            defaultValue={config.minSeconds}
                            title={`最小 ${MIN_INTERVAL_SECONDS} 秒`}
                            onBlur={(e) => {
                                const next = onUpdate({ minSeconds: Number(e.target.value) });
                                e.target.value = String(next.minSeconds);
                            }}
                            style={NUM_INPUT_STYLE}
                        />
                    </div>

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span>静默上限</span>
                        <input
                            type="number"
                            min={config.minSeconds}
                            defaultValue={config.maxSeconds}
                            title="不小于静默下限"
                            onBlur={(e) => {
                                const next = onUpdate({ maxSeconds: Number(e.target.value) });
                                e.target.value = String(next.maxSeconds);
                            }}
                            style={NUM_INPUT_STYLE}
                        />
                    </div>

                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <span>条数上限</span>
                        <input
                            type="number"
                            min={0}
                            max={MAX_TURNS_LIMIT}
                            defaultValue={config.maxTurns}
                            title="0 = 不限"
                            onBlur={(e) => {
                                const next = onUpdate({ maxTurns: Number(e.target.value) });
                                e.target.value = String(next.maxTurns);
                            }}
                            style={NUM_INPUT_STYLE}
                        />
                    </div>

                    <div style={{ opacity: 0.62, lineHeight: 1.5 }}>
                        静默时长在上下限之间随机取值；条数上限填 0 = 不限。你开口后重新计数。
                    </div>

                    <div style={{ opacity: 0.5, lineHeight: 1.5 }}>
                        状态每秒刷新：剩余秒数在走 = 正常；心跳「停滞」= 页面被系统冻结（切回前台自动恢复）；
                        显示「已达上限」= 要等你开口才会重新计数。
                    </div>
                </div>
            )}
        </div>
    );
}
