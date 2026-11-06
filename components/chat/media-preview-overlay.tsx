"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { downloadFile } from "@/lib/download-utils";
import { isMediaStoreRef, loadMediaBlob } from "@/lib/media-cache-storage";

/** 从 data:image/...;base64,xxx 解析出 Mime 与字节 */
function dataUrlToBlob(dataUrl: string): Blob | null {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const meta = dataUrl.slice(5, comma); // 去掉开头的 "data:"
    const payload = dataUrl.slice(comma + 1);
    const mime = (meta.split(";")[0] || "application/octet-stream").trim() || "application/octet-stream";
    try {
        if (/;base64/i.test(meta)) {
            const bin = atob(payload);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            return new Blob([bytes], { type: mime });
        }
        return new Blob([decodeURIComponent(payload)], { type: mime });
    } catch {
        return null;
    }
}

/**
 * 把预览里的图片地址解析成可落盘的真实字节。
 *
 * 聊天里的 AI 生图、语音等存的是 media-store:// 引用，也有内联 data: 地址；
 * 直接丢给 downloadUrl 会先 fetch → 失败 → 退回 window.open，
 * 在安卓壳里对 blob/data 地址发 ACTION_VIEW 什么都不会发生（"点了没反应"）。
 * 所以这里先把已知的特殊地址解析成 Blob，其余（http(s) 直链）才交给 downloadUrl。
 */
async function resolvePreviewBlob(url: string): Promise<Blob | null> {
    if (url.startsWith("data:")) return dataUrlToBlob(url);
    if (isMediaStoreRef(url)) {
        const found = await loadMediaBlob(url).catch(() => null);
        return found ? found.blob : null;
    }
    return null;
}

const ACTION_BUTTON_STYLE: CSSProperties = {
    color: "#fff",
    fontSize: "calc(14px*var(--app-text-scale,1))",
    opacity: 0.85,
    border: "none",
    cursor: "pointer",
    padding: "8px 20px",
    borderRadius: 20,
    background: "rgba(255,255,255,0.15)",
    backdropFilter: "blur(8px)",
};


type GalleryOriginRect = { left: number; top: number; width: number; height: number };
type GalleryPoint = { x: number; y: number };
type GalleryGesture = {
    mode: "pending" | "swipe" | "dismiss" | "drag" | "pinch" | "edgeBack";
    edge: "left" | "right" | null;
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    startScale: number;
    startOffset: GalleryPoint;
    startDistance: number;
    moved: boolean;
};

/** WeChat-style immersive multi-image viewer: swipe, pinch, double tap, drag, swipe-down close. */
function GalleryPreviewOverlay({
    images,
    initialIndex = 0,
    saveFilename = "图片.jpg",
    originRect,
    onClose,
}: {
    images: string[];
    initialIndex?: number;
    saveFilename?: string;
    originRect?: GalleryOriginRect | null;
    onClose: () => void;
}) {
    const [index, setIndex] = useState(() => Math.max(0, Math.min(images.length - 1, initialIndex)));
    const [scale, setScale] = useState(1);
    const [offset, setOffset] = useState<GalleryPoint>({ x: 0, y: 0 });
    const [dragX, setDragX] = useState(0);
    const [dismissY, setDismissY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const [saving, setSaving] = useState(false);
    const pointersRef = useRef(new Map<number, GalleryPoint>());
    const gestureRef = useRef<GalleryGesture | null>(null);
    const lastTapRef = useRef<{ at: number; x: number; y: number }>({ at: 0, x: 0, y: 0 });
    const overlayRef = useRef<HTMLDivElement | null>(null);
    const activeImageRef = useRef<HTMLImageElement | null>(null);
    const didOpenAnimationRef = useRef(false);
    const closeAnimationRef = useRef(false);
    const closeTimerRef = useRef<number | null>(null);

    const distance = (points: GalleryPoint[]) => Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const clampOffset = (next: GalleryPoint, nextScale: number): GalleryPoint => {
        const maxX = (nextScale - 1) * (typeof window !== "undefined" ? window.innerWidth : 400) / 2;
        const maxY = (nextScale - 1) * (typeof window !== "undefined" ? window.innerHeight : 800) / 2;
        return { x: Math.max(-maxX, Math.min(maxX, next.x)), y: Math.max(-maxY, Math.min(maxY, next.y)) };
    };
    const resetZoom = () => { setScale(1); setOffset({ x: 0, y: 0 }); setDismissY(0); };

    const animateOpen = useCallback(() => {
        if (!originRect || didOpenAnimationRef.current) return;
        const image = activeImageRef.current;
        const overlay = overlayRef.current;
        if (!image || !overlay || !image.complete || image.naturalWidth === 0) return;
        didOpenAnimationRef.current = true;
        const previousTransform = image.style.transform;
        image.style.transition = "none";
        image.style.transform = "none";
        const imageRect = image.getBoundingClientRect();
        image.style.transform = previousTransform;
        const tx = originRect.left + originRect.width / 2 - (imageRect.left + imageRect.width / 2);
        const ty = originRect.top + originRect.height / 2 - (imageRect.top + imageRect.height / 2);
        const scaleFromThumbnail = Math.max(0.04, Math.min(1, originRect.width / Math.max(1, imageRect.width), originRect.height / Math.max(1, imageRect.height)));
        image.style.transition = "none";
        image.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${scaleFromThumbnail})`;
        overlay.style.transition = "none";
        overlay.style.background = "rgba(0,0,0,0)";
        void overlay.offsetWidth;
        window.requestAnimationFrame(() => {
            if (closeAnimationRef.current) return;
            image.style.transition = "transform .28s cubic-bezier(.32,.72,0,1)";
            image.style.transform = "translate3d(0,0,0) scale(1)";
            overlay.style.transition = "background .28s ease";
            overlay.style.background = "#000";
        });
    }, [originRect]);

    const closeViewer = useCallback(() => {
        if (closeAnimationRef.current) return;
        const image = activeImageRef.current;
        const overlay = overlayRef.current;
        if (!originRect || !image || !overlay || !didOpenAnimationRef.current) {
            onClose();
            return;
        }
        closeAnimationRef.current = true;
        window.requestAnimationFrame(() => {
            const activeImage = activeImageRef.current ?? image;
            const activeOverlay = overlayRef.current ?? overlay;
            const previousTransform = activeImage.style.transform;
            activeImage.style.transition = "none";
            activeImage.style.transform = "none";
            const imageRect = activeImage.getBoundingClientRect();
            activeImage.style.transform = previousTransform;
            void activeImage.offsetWidth;
            const tx = originRect.left + originRect.width / 2 - (imageRect.left + imageRect.width / 2);
            const ty = originRect.top + originRect.height / 2 - (imageRect.top + imageRect.height / 2);
            const scaleToThumbnail = Math.max(0.04, Math.min(1, originRect.width / Math.max(1, imageRect.width), originRect.height / Math.max(1, imageRect.height)));
            activeImage.style.transition = "transform .25s cubic-bezier(.32,.72,0,1)";
            activeImage.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${scaleToThumbnail})`;
            activeOverlay.style.transition = "background .25s ease";
            activeOverlay.style.background = "rgba(0,0,0,0)";
            closeTimerRef.current = window.setTimeout(onClose, 270);
        });
    }, [originRect, onClose]);

    useEffect(() => {
        if (!originRect) return;
        const frame = window.requestAnimationFrame(animateOpen);
        return () => window.cancelAnimationFrame(frame);
    }, [animateOpen, originRect]);

    useEffect(() => () => {
        if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeViewer();
            else if (event.key === "ArrowLeft") {
                setIndex(current => Math.max(0, current - 1));
                resetZoom();
            } else if (event.key === "ArrowRight") {
                setIndex(current => Math.min(images.length - 1, current + 1));
                resetZoom();
            }
        };
        const onSwipeBack = (event: Event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            closeViewer();
        };
        window.addEventListener("keydown", onKey);
        document.addEventListener("phone-swipe-back", onSwipeBack, true);
        return () => {
            window.removeEventListener("keydown", onKey);
            document.removeEventListener("phone-swipe-back", onSwipeBack, true);
        };
    }, [images.length, closeViewer]);

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (closeAnimationRef.current) return;
        event.stopPropagation();
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* optional on older WebViews */ }
        const points = [...pointersRef.current.values()];
        if (points.length >= 2) {
            gestureRef.current = {
                mode: "pinch", edge: null, pointerId: event.pointerId, startX: points[0].x, startY: points[0].y,
                startTime: Date.now(), startScale: scale, startOffset: offset,
                startDistance: distance(points), moved: true,
            };
            setIsDragging(true);
            setDragX(0);
            setDismissY(0);
        } else {
            const edge: "left" | "right" | null = event.clientX <= 24
                ? "left"
                : event.clientX >= window.innerWidth - 24
                    ? "right"
                    : null;
            gestureRef.current = {
                mode: "pending", edge, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
                startTime: Date.now(), startScale: scale, startOffset: offset,
                startDistance: 0, moved: false,
            };
        }
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (closeAnimationRef.current || !pointersRef.current.has(event.pointerId)) return;
        pointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const points = [...pointersRef.current.values()];
        const gesture = gestureRef.current;
        if (!gesture) return;
        if (points.length >= 2) {
            if (gesture.mode !== "pinch") {
                gestureRef.current = { ...gesture, mode: "pinch", edge: null, startScale: scale, startOffset: offset, startDistance: distance(points), moved: true };
                setIsDragging(true);
                return;
            }
            const nextScale = Math.max(1, Math.min(4, gesture.startScale * distance(points) / Math.max(1, gesture.startDistance)));
            setScale(nextScale);
            setOffset(clampOffset(gesture.startOffset, nextScale));
            setIsDragging(true);
            event.preventDefault();
            return;
        }
        if (gesture.mode === "pinch") return;
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        if (gesture.mode === "pending") {
            if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
            const towardCenter = gesture.edge === "left" ? dx : gesture.edge === "right" ? -dx : 0;
            // At the actual screen edges, native-style back wins over gallery paging.
            // Elsewhere, horizontal movement changes photos as usual.
            const mode = gesture.edge && towardCenter > 8 && Math.abs(dx) >= Math.abs(dy) * 1.15
                ? "edgeBack"
                : gesture.startScale > 1.01 ? "drag" : (Math.abs(dx) >= Math.abs(dy) ? "swipe" : "dismiss");
            gestureRef.current = { ...gesture, mode, moved: true };
            setIsDragging(true);
        }
        const current = gestureRef.current;
        if (!current) return;
        if (current.mode === "edgeBack") {
            event.preventDefault();
            setDragX((current.edge === "left" ? dx : -dx) * 0.12);
        } else if (current.mode === "swipe") {
            let next = dx;
            if ((index === 0 && dx > 0) || (index === images.length - 1 && dx < 0)) next *= 0.28;
            setDragX(next);
            event.preventDefault();
        } else if (current.mode === "dismiss") {
            setDismissY(dy);
            setScale(Math.max(0.62, 1 - Math.abs(dy) / Math.max(500, window.innerHeight * 1.5)));
            event.preventDefault();
        } else if (current.mode === "drag") {
            setOffset(clampOffset({ x: current.startOffset.x + dx, y: current.startOffset.y + dy }, current.startScale));
            event.preventDefault();
        }
    };

    const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
        const gesture = gestureRef.current;
        pointersRef.current.delete(event.pointerId);
        if (pointersRef.current.size > 0) {
            if (gesture?.mode === "pinch") {
                gestureRef.current = null;
                setIsDragging(false);
            }
            return;
        }
        if (!gesture) return;
        const dx = event.clientX - gesture.startX;
        const dy = event.clientY - gesture.startY;
        const elapsed = Math.max(1, Date.now() - gesture.startTime);
        gestureRef.current = null;
        setIsDragging(false);
        if (gesture.mode === "pinch") {
            if (scale < 1.01) resetZoom();
            return;
        }
        if (gesture.mode === "edgeBack") {
            const towardCenter = gesture.edge === "left" ? dx : gesture.edge === "right" ? -dx : 0;
            if (towardCenter >= Math.max(76, window.innerWidth * 0.18) && towardCenter >= Math.abs(dy) * 1.35) {
                closeViewer();
            } else {
                setDragX(0);
            }
            return;
        }
        if (gesture.mode === "swipe") {
            const quick = Math.abs(dx) / elapsed > 0.5;
            if (Math.abs(dx) > window.innerWidth * 0.22 || quick) {
                const nextIndex = Math.max(0, Math.min(images.length - 1, index + (dx < 0 ? 1 : -1)));
                if (nextIndex !== index) {
                    setIndex(nextIndex);
                    resetZoom();
                }
            }
            setDragX(0);
            return;
        }
        if (gesture.mode === "dismiss") {
            if (dy > 86 || (dy > 24 && elapsed < 260)) {
                closeViewer();
                return;
            }
            resetZoom();
            return;
        }
        if (gesture.mode === "drag") return;
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) {
            const now = Date.now();
            const previous = lastTapRef.current;
            if (now - previous.at < 280 && Math.abs(event.clientX - previous.x) < 28 && Math.abs(event.clientY - previous.y) < 28) {
                lastTapRef.current = { at: 0, x: 0, y: 0 };
                if (scale > 1.01) resetZoom();
                else {
                    const nextScale = 2.2;
                    setScale(nextScale);
                    setOffset(clampOffset({ x: (window.innerWidth / 2 - event.clientX) * 0.85, y: (window.innerHeight / 2 - event.clientY) * 0.85 }, nextScale));
                }
            } else {
                lastTapRef.current = { at: now, x: event.clientX, y: event.clientY };
            }
        }
    };

    const onPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
        pointersRef.current.delete(event.pointerId);
        gestureRef.current = null;
        setIsDragging(false);
        setDragX(0);
        setDismissY(0);
        if (scale < 1) resetZoom();
    };

    const handleSave = async () => {
        const url = images[index];
        if (!url || saving) return;
        setSaving(true);
        try {
            let blob = await resolvePreviewBlob(url);
            if (!blob && url.startsWith("blob:")) {
                const response = await fetch(url);
                if (response.ok) blob = await response.blob();
            }
            const base = saveFilename.replace(/\.[^.]+$/, "") || "图片";
            const ext = /\.([a-z0-9]+)$/i.exec(saveFilename)?.[1] || "jpg";
            const filename = images.length > 1 ? `${base}_${index + 1}.${ext}` : saveFilename;
            if (blob) await downloadFile(blob, filename);
            else {
                const { downloadUrl } = await import("@/lib/download-utils");
                await downloadUrl(url, filename);
            }
        } finally {
            setSaving(false);
        }
    };

    if (typeof document === "undefined") return null;
    return createPortal(
        <div
            ref={overlayRef}
            className="chat-gallery-preview"
            role="dialog"
            aria-modal="true"
            aria-label={`图片浏览，第 ${index + 1} 张，共 ${images.length} 张`}
            onClick={event => event.stopPropagation()}
            style={{
                position: "fixed", inset: 0, zIndex: 100000, overflow: "hidden",
                background: originRect && !didOpenAnimationRef.current ? "rgba(0,0,0,0)" : `rgba(0,0,0,${Math.max(0.18, 1 - Math.abs(dismissY) / 720)})`,
                touchAction: "none", WebkitTapHighlightColor: "transparent",
            }}
        >
            <div
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                style={{ position: "absolute", inset: 0, overflow: "hidden", touchAction: "none" }}
            >
                <div style={{
                    display: "flex", height: "100%", width: `${images.length * 100}vw`,
                    transform: `translate3d(calc(-${index * 100}vw + ${dragX}px),0,0)`,
                    transition: isDragging ? "none" : "transform .28s cubic-bezier(.32,.72,0,1)",
                    willChange: "transform",
                }}>
                    {images.map((url, imageIndex) => (
                        <div key={`${imageIndex}-${url}`} style={{ flex: "0 0 100vw", width: "100vw", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
                            <img
                                ref={imageIndex === index ? activeImageRef : undefined}
                                onLoad={imageIndex === index ? animateOpen : undefined}
                                src={url}
                                alt={`第 ${imageIndex + 1} 张图片`}
                                draggable={false}
                                style={{
                                    maxWidth: "86vw", maxHeight: "80dvh", width: "auto", height: "auto", objectFit: "contain",
                                    userSelect: "none", pointerEvents: "none", willChange: "transform",
                                    transform: imageIndex === index ? `translate3d(${offset.x}px,${offset.y + dismissY}px,0) scale(${scale})` : "none",
                                    transition: isDragging ? "none" : "transform .24s ease",
                                }}
                            />
                        </div>
                    ))}
                </div>
            </div>
            <div style={{ position: "absolute", top: "max(env(safe-area-inset-top, 0px), 16px)", left: "50%", transform: "translateX(-50%)", padding: "6px 13px", borderRadius: 99, color: "rgba(255,255,255,.92)", background: "rgba(255,255,255,.10)", backdropFilter: "blur(12px)", fontSize: 14, letterSpacing: ".04em", pointerEvents: "none" }}>
                {index + 1} / {images.length}
            </div>
            <button
                type="button"
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); closeViewer(); }}
                aria-label="关闭图片浏览"
                style={{ position: "absolute", top: "max(env(safe-area-inset-top, 0px), 12px)", right: 14, width: 40, height: 40, display: "grid", placeItems: "center", border: "1px solid rgba(255,255,255,.15)", borderRadius: "50%", color: "white", background: "rgba(255,255,255,.12)", backdropFilter: "blur(12px)" }}
            >
                <X size={20}/>
            </button>
            <button
                type="button"
                disabled={saving}
                onPointerDown={event => event.stopPropagation()}
                onClick={event => { event.stopPropagation(); void handleSave(); }}
                style={{ position: "absolute", left: "50%", bottom: "max(env(safe-area-inset-bottom, 0px), 24px)", transform: "translateX(-50%)", padding: "9px 18px", border: "1px solid rgba(255,255,255,.18)", borderRadius: 99, color: "white", background: "rgba(255,255,255,.12)", backdropFilter: "blur(12px)", fontSize: 13 }}
            >
                {saving ? "保存中…" : "保存当前图片"}
            </button>
        </div>,
        document.body,
    );
}

/**
 * 全屏媒体预览层：图片（或未生成时的文字描述）+ 下方操作按钮排。
 * 聊天、朋友圈、小卷共用——聊天流里不放常驻小按钮，保存/重新生成都收在这里。
 */
export function MediaPreviewOverlay({
    imageUrl,
    galleryImages,
    initialIndex = 0,
    originRect,
    description,
    saveFilename,
    onRegenerate,
    regenerating,
    onClose,
}: {
    imageUrl?: string | null;
    galleryImages?: string[];
    initialIndex?: number;
    originRect?: GalleryOriginRect | null;
    description?: string;
    saveFilename?: string;
    onRegenerate?: () => void;
    regenerating?: boolean;
    onClose: () => void;
}) {
    // Keep hooks unconditional even when this component switches between single-image and collection mode.
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        // Full collections have their own horizontal swipe controller; ordinary previews
        // should close first when the phone's system back gesture is invoked.
        if (galleryImages && galleryImages.length > 1) return;
        const handleSwipeBack = (event: Event) => {
            if (event.defaultPrevented) return;
            event.preventDefault();
            onClose();
        };
        document.addEventListener("phone-swipe-back", handleSwipeBack, true);
        return () => document.removeEventListener("phone-swipe-back", handleSwipeBack, true);
    }, [galleryImages?.length, onClose]);
    if (galleryImages && galleryImages.length > 1) {
        return <GalleryPreviewOverlay images={galleryImages} initialIndex={initialIndex} originRect={originRect} saveFilename={saveFilename} onClose={onClose} />;
    }
    // 保存要重新拉一次图片，慢网络下会卡一下——按钮上给个状态
    if (typeof document === "undefined") return null;
    return createPortal(
        <div
            style={{ position: "fixed", inset: 0, zIndex: 10000, background: "rgba(0,0,0,0.85)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 16, padding: 24 }}
            onClick={onClose}
        >
            {imageUrl ? (
                <img src={imageUrl} alt="" style={{ maxWidth: "90vw", maxHeight: "75vh", objectFit: "contain" }} />
            ) : description ? (
                <div
                    style={{ color: "#fff", opacity: 0.9, maxWidth: "min(85vw, 420px)", maxHeight: "60vh", overflowY: "auto", fontSize: "calc(14px*var(--app-text-scale,1))", lineHeight: 1.8, fontStyle: "italic", whiteSpace: "pre-wrap" }}
                    onClick={e => e.stopPropagation()}
                >
                    {description}
                </div>
            ) : null}
            <div style={{ display: "flex", gap: 12 }} onClick={e => e.stopPropagation()}>
                {imageUrl && saveFilename && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        disabled={saving}
                        onClick={async e => {
                            e.stopPropagation();
                            e.preventDefault();
                            setSaving(true);
                            try {
                                // media-store:// / data: 先解析成真实字节再落盘；
                                // 其余（http(s) 直链）沿用 downloadUrl。
                                const blob = await resolvePreviewBlob(imageUrl);
                                if (blob) {
                                    await downloadFile(blob, saveFilename);
                                } else {
                                    const { downloadUrl } = await import("@/lib/download-utils");
                                    await downloadUrl(imageUrl, saveFilename);
                                }
                            } finally {
                                setSaving(false);
                            }
                        }}
                        style={ACTION_BUTTON_STYLE}
                    >
                        {saving ? "保存中…" : "保存图片"}
                    </button>
                )}
                {onRegenerate && (
                    <button
                        onPointerDown={e => e.stopPropagation()}
                        disabled={regenerating}
                        onClick={e => {
                            e.stopPropagation();
                            onRegenerate();
                        }}
                        style={ACTION_BUTTON_STYLE}
                    >
                        {regenerating ? "生成中..." : "重新生成"}
                    </button>
                )}
            </div>
        </div>,
        document.body,
    );
}
