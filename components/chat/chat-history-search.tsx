"use client";

import { useMemo, useState } from "react";
import { CalendarDays, FileSearch, Search, X } from "lucide-react";
import { loadChatMessages, loadChatSessions, loadChatContacts, type ChatMessage } from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";

type HistoryKind = "all" | "text" | "image" | "video" | "audio" | "file" | "rich";
type HistoryHit = { message: ChatMessage; sessionId: string; sessionName: string };

function classify(message: ChatMessage): Exclude<HistoryKind, "all"> {
    const type = message.mediaType || "";
    if (type === "image" || /image/.test(type)) return "image";
    if (type === "video" || /video/.test(type)) return "video";
    if (type === "audio" || /audio|voice/.test(type)) return "audio";
    if (type === "media_file" || /file|document|attachment/.test(type) || message.mediaUrl && !message.mediaType) return "file";
    if (type && !["text"].includes(type)) return "rich";
    return "text";
}

function previewOf(message: ChatMessage): string {
    const text = (message.content || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 180);
    const kind = classify(message);
    return ({ image: "图片消息", video: "视频消息", audio: "音频 / 语音消息", file: "文件或附件", rich: "卡片 / 特殊消息", text: "文本消息" } as const)[kind];
}

export function ChatHistorySearch({ onClose, onJump, fixedSessionId }: {
    onClose: () => void;
    onJump: (sessionId: string, messageId: string) => void;
    /** When opened from inside a chat room, keep the search scoped to that conversation. */
    fixedSessionId?: string;
}) {
    const [query, setQuery] = useState("");
    const [from, setFrom] = useState("");
    const [to, setTo] = useState("");
    const [kind, setKind] = useState<HistoryKind>("all");
    const [sessionFilter, setSessionFilter] = useState(fixedSessionId ?? "all");

    const hits = useMemo(() => {
        const sessions = loadChatSessions();
        const contacts = loadChatContacts();
        const characters = loadCharacters();
        // 联系人通过 characterId 关联会话，而不是 contact.id；角色档案作为第二层兜底。
        const contactNames = new Map(contacts.map(contact => [contact.characterId, contact.nickname || ""]));
        const characterNames = new Map(characters.map(character => [character.id, character.name]));
        const getSessionName = (session: ReturnType<typeof loadChatSessions>[number]) => {
            if (session.isGroup) return session.groupName?.trim() || "未命名群聊";
            return session.alias?.trim()
                || contactNames.get(session.contactId)?.trim()
                || characterNames.get(session.contactId)?.trim()
                || "未命名角色私聊";
        };
        const names = new Map(sessions.map(session => [session.id, getSessionName(session)]));
        const needle = query.trim().toLocaleLowerCase();
        const start = from ? new Date(from + "T00:00:00").getTime() : -Infinity;
        const end = to ? new Date(to + "T23:59:59.999").getTime() : Infinity;
        const results: HistoryHit[] = [];
        for (const session of sessions) {
            if (sessionFilter !== "all" && session.id !== sessionFilter) continue;
            for (const message of loadChatMessages(session.id)) {
                const time = new Date(message.createdAt).getTime();
                if (!Number.isFinite(time) || time < start || time > end) continue;
                if (kind !== "all" && classify(message) !== kind) continue;
                const searchable = [message.content, message.role, message.mediaType, message.mediaData?.label, message.mediaData?.musicTitle, message.mediaData?.musicArtist, message.mediaData?.fileName].filter(Boolean).join(" ").toLocaleLowerCase();
                if (needle && !searchable.includes(needle)) continue;
                if (message.isRetracted) continue;
                results.push({ message, sessionId: session.id, sessionName: names.get(session.id) || "聊天" });
            }
        }
        return results.sort((a, b) => b.message.createdAt.localeCompare(a.message.createdAt)).slice(0, 300);
    }, [query, from, to, kind, sessionFilter]);

    const inputStyle: React.CSSProperties = { width: "100%", minWidth: 0, borderRadius: 12, border: "1px solid var(--c-border, #e4e4e7)", background: "var(--c-card, #fff)", color: "var(--c-text, #27272a)", padding: "10px 12px", fontSize: 14 };
    const labelStyle: React.CSSProperties = { display: "grid", gap: 5, fontSize: 12, color: "var(--c-subtext, #71717a)" };
    const kinds: { id: HistoryKind; label: string }[] = [
        { id: "all", label: "全部类型" }, { id: "text", label: "文字" }, { id: "image", label: "图片" },
        { id: "video", label: "视频" }, { id: "audio", label: "音频/语音" }, { id: "file", label: "文件" }, { id: "rich", label: "卡片/其他" },
    ];

    return <div role="dialog" aria-modal="true" aria-label="聊天记录检索" style={{ position: "absolute", inset: 0, zIndex: 300, display: "flex", flexDirection: "column", background: "var(--c-page-body-bg, #f7f7f8)", color: "var(--c-text, #27272a)" }}>
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "max(12px, env(safe-area-inset-top)) 14px 12px", borderBottom: "1px solid var(--c-border, #e4e4e7)" }}>
            <FileSearch size={21} />
            <strong style={{ flex: 1, fontSize: 17 }}>聊天记录检索</strong>
            <button type="button" aria-label="关闭" onClick={onClose} style={{ border: 0, background: "transparent", padding: 8, color: "inherit" }}><X size={21} /></button>
        </header>
        <div style={{ padding: 14, display: "grid", gap: 10, borderBottom: "1px solid var(--c-border, #eee2e9)" }}>
            <label style={{ ...labelStyle, position: "relative" }}>
                <span>关键词</span>
                <span style={{ position: "relative" }}><Search size={17} style={{ position: "absolute", left: 11, top: 11, opacity: .55 }} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索聊天内容、附件描述、音乐标题…" style={{ ...inputStyle, paddingLeft: 36 }} /></span>
            </label>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 9 }}>
                <label style={labelStyle}><span><CalendarDays size={12} style={{ display: "inline", marginRight: 4 }} />开始日期</span><input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} style={inputStyle} /></label>
                <label style={labelStyle}><span><CalendarDays size={12} style={{ display: "inline", marginRight: 4 }} />结束日期</span><input type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} style={inputStyle} /></label>
            </div>
            {!fixedSessionId && <label style={labelStyle}><span>聊天对象</span><select value={sessionFilter} onChange={e => setSessionFilter(e.target.value)} style={inputStyle}><option value="all">所有聊天</option>{loadChatSessions().map(session => <option key={session.id} value={session.id}>{session.isGroup ? session.groupName?.trim() || "未命名群聊" : session.alias?.trim() || loadChatContacts().find(contact => contact.characterId === session.contactId)?.nickname?.trim() || loadCharacters().find(character => character.id === session.contactId)?.name?.trim() || "未命名角色私聊"}</option>)}</select></label>}
            <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}><div style={{ display: "flex", flex: 1, minWidth: 0, gap: 7, overflowX: "auto", paddingBottom: 2 }}>{kinds.map(item => <button key={item.id} type="button" onClick={() => setKind(item.id)} style={{ whiteSpace: "nowrap", borderRadius: 999, padding: "7px 11px", border: "1px solid var(--c-border, #e7dce3)", background: kind === item.id ? "var(--c-text-title, #52525b)" : "var(--c-card, #fff)", color: kind === item.id ? "#fff" : "var(--c-text, #332832)", fontSize: 12 }}>{item.label}</button>)}</div><button type="button" onClick={() => { setQuery(""); setFrom(""); setTo(""); setKind("all"); if (!fixedSessionId) setSessionFilter("all"); }} style={{ flexShrink: 0, border: "1px solid var(--c-border, #e7dce3)", background: "var(--c-card, #fff)", color: "var(--c-subtext, #80717e)", borderRadius: 999, padding: "7px 10px", fontSize: 11 }}>重置</button></div>
        </div>
        <div style={{ padding: "10px 14px", fontSize: 12, opacity: .72 }}>{hits.length ? `找到 ${hits.length} 条记录${hits.length === 300 ? "（仅展示最新 300 条，请缩小筛选范围）" : ""}` : "没有符合条件的记录"}</div>
        <div style={{ overflowY: "auto", overscrollBehavior: "contain", padding: "0 12px 20px", flex: 1 }}>
            {hits.map(({ message, sessionId, sessionName }) => <button key={sessionId + ":" + message.id} type="button" onClick={() => onJump(sessionId, message.id)} style={{ display: "block", textAlign: "left", width: "100%", border: "1px solid var(--c-border, #e4e4e7)", background: "var(--c-card, #fff)", color: "inherit", borderRadius: 13, padding: "11px 12px", marginBottom: 8 }}>
                <span style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}><b style={{ fontSize: 13 }}>{sessionName}</b><time style={{ fontSize: 11, opacity: .62, flexShrink: 0 }}>{new Date(message.createdAt).toLocaleString()}</time></span>
                <span style={{ display: "block", fontSize: 12, opacity: .65, margin: "4px 0" }}>{message.role === "user" ? "我" : message.role === "assistant" ? "角色" : message.role === "system" ? "系统" : "工具"} · {kinds.find(item => item.id === classify(message))?.label}</span>
                <span style={{ display: "block", fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" }}>{previewOf(message)}</span>
            </button>)}
        </div>
    </div>;
}
