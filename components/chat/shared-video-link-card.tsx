"use client";

import { useEffect, useRef, useState } from "react";

type SharedVideoNativeBridge = {
    resolveShortVideoShareUrl?: (url: string, requestId: string) => boolean;
    deleteCachedShortVideo?: (cacheId: string) => boolean;
};

type SharedVideoWindow = Window & { AndroidShell?: SharedVideoNativeBridge };

type ResolveDetail = {
    requestId?: string;
    ok?: boolean;
    cacheId?: string;
    contentUri?: string;
    message?: string;
};

type PlayerState =
    | { kind: "loading" }
    | { kind: "ready"; contentUri: string; cacheId: string }
    | { kind: "browser" }
    | { kind: "ended" }
    | { kind: "error"; message: string };

export function isShortVideoShareUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        const host = url.hostname.toLowerCase();
        const path = url.pathname.toLowerCase();
        const matchesDomain = (root: string) => host === root || host.endsWith("." + root);

        if (matchesDomain("douyin.com") || matchesDomain("iesdouyin.com")) {
            return host === "v.douyin.com" || path.includes("/video/") || path.includes("/share/video/");
        }
        if (matchesDomain("kuaishou.com")) {
            return host === "v.kuaishou.com" || path.includes("/short-video/") || path.includes("/fw/");
        }
        if (matchesDomain("xhslink.com") || matchesDomain("xhslink.cn")) return true;
        if (matchesDomain("xiaohongshu.com")) {
            return path.includes("/explore/") || path.includes("/discovery/item/");
        }
        return false;
    } catch {
        return false;
    }
}

function platformName(rawUrl: string): string {
    try {
        const host = new URL(rawUrl).hostname.toLowerCase();
        if (host.includes("douyin")) return "抖音";
        if (host.includes("kuaishou")) return "快手";
        if (host.includes("xiaohongshu") || host.includes("xhslink")) return "小红书";
    } catch {
        // Fall back to generic label.
    }
    return "短视频";
}

/** Android APK: extract a public MP4 into app-private cache. Other browsers keep the original link. */
export function SharedVideoLinkCard({ url }: { url: string }) {
    const [attempt, setAttempt] = useState(0);
    const [state, setState] = useState<PlayerState>({ kind: "loading" });
    const cacheIdRef = useRef<string | null>(null);
    const name = platformName(url);

    useEffect(() => {
        let active = true;
        const native = (window as SharedVideoWindow).AndroidShell;
        cacheIdRef.current = null;

        if (!native?.resolveShortVideoShareUrl) {
            setState({ kind: "browser" });
            return () => { active = false; };
        }

        const requestId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 11);
        setState({ kind: "loading" });
        const onResolved = (event: Event) => {
            const detail = (event as CustomEvent<ResolveDetail>).detail;
            if (!active || !detail || detail.requestId !== requestId) return;
            if (detail.ok && detail.cacheId && detail.contentUri) {
                cacheIdRef.current = detail.cacheId;
                setState({ kind: "ready", cacheId: detail.cacheId, contentUri: detail.contentUri });
            } else {
                setState({ kind: "error", message: detail.message || "平台没有返回可直接播放的公开视频地址。" });
            }
        };
        window.addEventListener("floatshell-shared-video-ready", onResolved);

        try {
            const accepted = native.resolveShortVideoShareUrl(url, requestId);
            if (!accepted && active) {
                setState({ kind: "error", message: "原生解析没有接受这个链接，请直接打开原分享页面。" });
            }
        } catch {
            setState({ kind: "error", message: "无法调用 APK 的视频解析能力，请更新到支持该功能的版本。" });
        }

        return () => {
            active = false;
            window.removeEventListener("floatshell-shared-video-ready", onResolved);
            const id = cacheIdRef.current;
            cacheIdRef.current = null;
            if (id) {
                try { native.deleteCachedShortVideo?.(id); } catch { /* Native TTL cleanup is the fallback. */ }
            }
        };
    }, [url, attempt]);

    const clearCache = () => {
        const id = cacheIdRef.current;
        cacheIdRef.current = null;
        if (id) {
            try { (window as SharedVideoWindow).AndroidShell?.deleteCachedShortVideo?.(id); } catch { /* Ignore cleanup errors. */ }
        }
    };

    return (
        <div
            className="chat-shared-video-card"
            style={{
                width: "min(320px, 76vw)",
                maxWidth: "100%",
                overflow: "hidden",
                border: "1px solid var(--c-card-border, rgba(120, 100, 70, .20))",
                borderRadius: 14,
                background: "var(--c-card, rgba(120, 100, 70, .06))",
                color: "var(--c-text, inherit)",
            }}
        >
            {state.kind === "ready" ? (
                <video
                    key={state.contentUri}
                    src={state.contentUri}
                    controls
                    playsInline
                    preload="metadata"
                    onEnded={() => { clearCache(); setState({ kind: "ended" }); }}
                    onError={() => {
                        clearCache();
                        setState({ kind: "error", message: "本地视频无法播放或缓存已失效，请重新解析或打开原链接。" });
                    }}
                    style={{ display: "block", width: "100%", maxHeight: 380, background: "#000" }}
                />
            ) : (
                <div style={{ padding: "12px 13px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 650 }}>
                        <span aria-hidden="true" style={{ display: "inline-grid", placeItems: "center", width: 28, height: 28, borderRadius: 9, background: "var(--c-soft, rgba(120, 100, 70, .12))" }}>▶</span>
                        <span>{name}分享视频</span>
                        {state.kind === "loading" && <span style={{ marginLeft: "auto", opacity: .7, fontWeight: 450 }}>正在解析…</span>}
                    </div>
                    {state.kind === "browser" && (
                        <p style={{ margin: "9px 0 0", fontSize: 12, lineHeight: 1.55, opacity: .75 }}>
                            当前不是带原生桥的安卓 APK，网页无法直接读取平台视频流；可打开原分享链接观看。
                        </p>
                    )}
                    {state.kind === "error" && (
                        <p role="status" style={{ margin: "9px 0 0", fontSize: 12, lineHeight: 1.55, opacity: .78 }}>
                            {state.message} 平台登录限制、签名链接或防盗链可能导致解析失败。
                        </p>
                    )}
                    {state.kind === "ended" && (
                        <p style={{ margin: "9px 0 0", fontSize: 12, lineHeight: 1.55, opacity: .75 }}>
                            播放结束，临时缓存已清理。需要重看时可以重新解析。
                        </p>
                    )}
                    {state.kind === "loading" && (
                        <p style={{ margin: "9px 0 0", fontSize: 12, lineHeight: 1.55, opacity: .72 }}>
                            仅尝试解析无需登录即可访问的公开视频；不会下载账号私密、付费或受保护的视频。
                        </p>
                    )}
                </div>
            )}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 11px", borderTop: "1px solid var(--c-card-border, rgba(120, 100, 70, .14))", fontSize: 11 }}>
                <span style={{ opacity: .66, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name} · 临时缓存</span>
                <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                    {state.kind !== "ready" && state.kind !== "loading" && state.kind !== "browser" && (
                        <button type="button" onClick={() => setAttempt(value => value + 1)} style={{ border: 0, background: "transparent", color: "var(--c-accent, #9a7658)", padding: 0, fontSize: 11 }}>重新解析</button>
                    )}
                    <a href={url} target="_blank" rel="noreferrer" className="chat-markdown-link" style={{ fontSize: 11 }}>原链接</a>
                </div>
            </div>
        </div>
    );
}
