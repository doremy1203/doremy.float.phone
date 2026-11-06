"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, Plus } from "lucide-react";
import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { PhotoWallSticker } from "@/components/photo-wall/photo-wall-sticker";
import { DEFAULT_PHOTO_STICKER_SIZE, DEFAULT_WALL_STICKER_SIZE, resolveStickerSize, stickerSizeFromBrushWidth } from "@/lib/photo-wall-doodle-sizing";
import {
  createPhotoWallId,
  type PhotoWallDoodle,
  type PhotoWallFrameStyle,
  type PhotoWallPhoto,
  type PhotoWallPlacement,
} from "@/lib/photo-wall-storage";

/** 相框留白比例：宝丽来下缘更宽，留给手写感。 */
const FRAME_PADDING: Record<PhotoWallFrameStyle, { x: number; y: number; bottom: number }> = {
  polaroid: { x: 0.055, y: 0.045, bottom: 0.16 },
  thin: { x: 0.018, y: 0.018, bottom: 0.03 },
  wood: { x: 0.05, y: 0.05, bottom: 0.09 },
  tape: { x: 0.03, y: 0.03, bottom: 0.06 },
  none: { x: 0, y: 0, bottom: 0 },
};

const FRAME_BG: Record<PhotoWallFrameStyle, string> = {
  polaroid: "#fffdf8",
  thin: "#f6f1e6",
  wood: "#a97c52",
  tape: "#fbf6ea",
  none: "transparent",
};
const FRAME_LABEL: Record<PhotoWallFrameStyle, string> = {
  polaroid: "拍立得",
  thin: "细框",
  wood: "木框",
  tape: "胶带",
  none: "无框",
};

const BRUSH_COLORS = ["#c2705a", "#a77b77", "#b08a54", "#5d6b8a", "#8a6b8a", "#3c3a36"];

/** 固定在舒服的阅读尺寸；画布变大时照片不跟着膨胀。 */

/** 没有摆放坐标的老照片，给一个稳定但错落的默认落点。 */
export function fallbackPlacement(index: number): PhotoWallPlacement {
  const col = index % 3;
  const row = Math.floor(index / 3);
  const wobble = ((index * 37) % 11) - 5;
  return {
    x: Math.min(0.88, Math.max(0.12, 0.2 + col * 0.3 + wobble * 0.004)),
    y: Math.min(0.9, Math.max(0.1, 0.14 + row * 0.27 + wobble * 0.003)),
    scale: 1,
    rotation: wobble,
    z: index + 1,
    frame: "polaroid",
    frameColor: "#fffdf8",
  };
}

type Props = {
  photos: PhotoWallPhoto[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChangePlacement: (id: string, placement: PhotoWallPlacement) => void;
  /**
   * 拖动/缩放「松手」时回调一次。
   * 无界画布靠它决定要不要扩容：拖动过程中不能扩，否则本组件的
   * 拖拽基准（base + 初始矩形）会失效，照片会跳。
   */
  onPlacementSettled?: (id: string, placement: PhotoWallPlacement) => void;
  /** 一次拖动开始前回调：上层据此压一条撤销快照（拖动中每帧都在写坐标，不能在里面压栈）。 */
  onDragBegin?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onChangeDoodles: (id: string, doodles: PhotoWallDoodle[], side?: "front" | "back") => void;
  wallDoodles?: PhotoWallDoodle[];
  onChangeWallDoodles?: (doodles: PhotoWallDoodle[]) => void;
  backgroundImage?: string;
  /** 背景图绑定的世界盒子：无界画布扩容后按它铺，避免整张图被拉伸。 */
  backgroundBox?: { width: number; height: number };
  wallWorld?: { width: number; height: number };
  onOpenDetail: (photo: PhotoWallPhoto) => void;
  readOnly?: boolean;
  fitHeight?: boolean;
  canvasZoom?: number;
  mode?: "view" | "move" | "doodle";
  onModeChange?: (mode: "view" | "move" | "doodle") => void;
  brushColor?: string;
  brushWidth?: number;
  stickerSize?: number;
  sticker?: string | null;
  onStickerChange?: (sticker: string | null) => void;
  stickerRotation?: number;
  eraser?: boolean;
  onEraserChange?: (enabled: boolean) => void;
};

type DragState = {
  id: string;
  pointerId: number;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  base: PhotoWallPlacement;
  wallWidth: number;
  wallHeight: number;
  /** CSS pixels per world pixel, including canvas zoom and phone-shell scaling. */
  wallScale: number;
  moved: boolean;
};

/**
 * 视口内缩略图缓存。缓存 Promise 而不只是最终 URL，避免批量照片同时进入视口时
 * 对同一 mediaRef 重复读取、重复解码；整墙导出仍走原图读取链路。
 */
const wallThumbCache = new Map<string, string>();
const wallThumbPending = new Map<string, Promise<string>>();
const MAX_PARALLEL_THUMB_LOADS = 3;
let activeThumbLoads = 0;
const thumbLoadQueue: Array<() => void> = [];

async function withThumbLoadSlot<T>(work: () => Promise<T>): Promise<T> {
  if (activeThumbLoads >= MAX_PARALLEL_THUMB_LOADS) {
    await new Promise<void>(resolve => thumbLoadQueue.push(resolve));
  }
  activeThumbLoads += 1;
  try {
    return await work();
  } finally {
    activeThumbLoads -= 1;
    thumbLoadQueue.shift()?.();
  }
}

async function loadWallThumbUrl(mediaRef: string): Promise<string> {
  const cached = wallThumbCache.get(mediaRef);
  if (cached) return cached;
  const pending = wallThumbPending.get(mediaRef);
  if (pending) return pending;

  const task = withThumbLoadSlot(async () => {
    const full = await loadMediaObjectUrl(mediaRef);
    if (!full) return "";
    let bitmap: ImageBitmap | null = null;
    try {
      const response = await fetch(full);
      if (!response.ok) throw new Error("照片资源读取失败");
      const blob = await response.blob();
      bitmap = await createImageBitmap(blob);
      const longest = Math.max(bitmap.width, bitmap.height);
      let url = full;
      if (longest > 2048) {
        // This is only a display derivative; the original Blob remains untouched for detail
        // view and export. Keep enough pixels for zooming on high-DPR phones without decoding
        // every original camera image at full size at once.
        const scale = 2048 / longest;
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = Math.max(1, Math.round(bitmap.width * scale));
        thumbCanvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = thumbCanvas.getContext("2d");
        if (!context) throw new Error("无法创建照片缩略图");
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
        const thumb = await new Promise<Blob | null>(resolve => thumbCanvas.toBlob(resolve, "image/webp", 0.94));
        if (thumb) url = URL.createObjectURL(thumb);
      }
      if (url !== full) URL.revokeObjectURL(full);
      wallThumbCache.set(mediaRef, url);
      return url;
    } catch {
      // 缩略图失败时保留原图 URL；不能因压缩失败让照片永久空白。
      wallThumbCache.set(mediaRef, full);
      return full;
    } finally {
      bitmap?.close();
    }
  }).finally(() => {
    wallThumbPending.delete(mediaRef);
  });
  wallThumbPending.set(mediaRef, task);
  return task;
}



export function PhotoWallCanvas({ photos, selectedId, onSelect, onChangePlacement, onPlacementSettled, onDragBegin, onUndo, onRedo, canUndo, canRedo, onChangeDoodles, wallDoodles = [], onChangeWallDoodles, backgroundImage, backgroundBox, wallWorld, onOpenDetail, readOnly = false, fitHeight = false, canvasZoom = 1, mode: controlledMode, onModeChange, brushColor: controlledBrushColor, brushWidth: controlledBrushWidth, stickerSize: controlledStickerSize, sticker: controlledSticker, onStickerChange, stickerRotation: controlledStickerRotation = 0, eraser: controlledEraser, onEraserChange }: Props) {
  const wallRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const strokeRef = useRef<{ id: string; pointerId: number; photoId: string; side: "front" | "back"; anchorElement?: HTMLElement } | null>(null);
  const wallStrokeRef = useRef<{ id: string; pointerId: number } | null>(null);
  const wallDraftPointsRef = useRef<{ x: number; y: number }[]>([]);
  const suppressClickRef = useRef(false);
  const multiTouchRef = useRef(false);
  const [flippedPhotoIds, setFlippedPhotoIds] = useState<Set<string>>(new Set());

  // Edit state is controlled by the parent so controls stay outside the zoomed canvas.
  const [internalMode, setInternalMode] = useState<"view" | "move" | "doodle">("view");
  const [internalBrushColor] = useState(BRUSH_COLORS[0]);
  const [internalBrushWidth] = useState(3);
  const [internalSticker, setInternalSticker] = useState<string | null>(null);
  const [internalEraser, setInternalEraser] = useState(false);
  const mode = controlledMode ?? internalMode;
  const brushColor = controlledBrushColor ?? internalBrushColor;
  const brushWidth = controlledBrushWidth ?? internalBrushWidth;
  const stickerSize = controlledStickerSize ?? stickerSizeFromBrushWidth(brushWidth);
  const sticker = controlledSticker === undefined ? internalSticker : controlledSticker;
  const eraser = controlledEraser ?? internalEraser;
  const [draftPoints, setDraftPoints] = useState<{ x: number; y: number }[]>([]);
  useEffect(() => {
    if (!readOnly) return;
    setInternalMode("view"); onModeChange?.("view");
    setInternalSticker(null); onStickerChange?.(null);
    setInternalEraser(false); onEraserChange?.(false);
    setDraftPoints([]); wallStrokeRef.current = null; wallDraftPointsRef.current = [];
    dragRef.current = null; strokeRef.current = null;
  }, [readOnly, onModeChange, onStickerChange, onEraserChange]);

  useEffect(() => {
    const onGestureStart = () => {
      multiTouchRef.current = true;
      // A second pointer cancels, rather than commits, any in-progress stroke or photo drag.
      dragRef.current = null;
      strokeRef.current = null;
      wallStrokeRef.current = null;
      wallDraftPointsRef.current = [];
      setDraftPoints([]);
      suppressClickRef.current = true;
    };
    const onGestureEnd = () => {
      multiTouchRef.current = false;
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    };
    window.addEventListener("photo-wall-pinch-start", onGestureStart);
    window.addEventListener("photo-wall-pinch-end", onGestureEnd);
    window.addEventListener("photo-wall-pan-start", onGestureStart);
    window.addEventListener("photo-wall-pan-end", onGestureEnd);
    return () => {
      window.removeEventListener("photo-wall-pinch-start", onGestureStart);
      window.removeEventListener("photo-wall-pinch-end", onGestureEnd);
      window.removeEventListener("photo-wall-pan-start", onGestureStart);
      window.removeEventListener("photo-wall-pan-end", onGestureEnd);
    };
  }, []);

  const ordered = useMemo(() => photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0)), [photos]);
  const placementOf = useCallback(
    (photo: PhotoWallPhoto, index: number) => photo.placement ?? fallbackPlacement(index),
    [],
  );

  const selectedPhoto = ordered.find(photo => photo.id === selectedId) ?? null;

  /** 背景跟着画布一起缩放：画布多大，背景就铺多大。
   * 有 backgroundBox（世界坐标盒子）时按盒子尺寸、锚定左上角铺放，与整墙导出的绘制
   * 规则一致（photo-wall-export.ts 同款）；无盒子才退回 cover 铺满。此前这里恒用 cover，
   * 画布扩容后实时背景被拉伸变形，导出却不变形，所见非所得。 */
  const backgroundSizing = backgroundBox
    ? { size: `${Math.max(1, backgroundBox.width)}px ${Math.max(1, backgroundBox.height)}px`, position: "top left" as const }
    : { size: "cover", position: "center" as const };

  const commit = useCallback((id: string, next: PhotoWallPlacement) => onChangePlacement(id, next), [onChangePlacement]);
  /** 松手时用来把「最终落点」交回给上层做扩容判断。 */
  const settledRef = useRef<{ id: string; placement: PhotoWallPlacement } | null>(null);

  /* ── 拖动 / 缩放 ───────────────────────────────── */
  const beginDrag = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number, dragMode: "move" | "resize") => {
    if (multiTouchRef.current) return;
    // A pointer-down outside move mode must not open the edit modal.
    // Opening details is exclusively handled by the frame margin click.
    if (mode !== "move") return;
    if (dragMode === "move" && event.button !== undefined && event.button !== 0) return;
    const wall = wallRef.current;
    if (!wall) return;
    const currentPlacement = placementOf(photo, index);
    if (currentPlacement.locked) {
      onSelect(photo.id);
      return;
    }
    const rect = wall.getBoundingClientRect();
    const wallScale = rect.width > 0 && wall.offsetWidth > 0 ? rect.width / wall.offsetWidth : 1;
    // 不在 pointerdown 时抢占指针，否则普通轻触的 click 会落到墙容器上，
    // 照片卡片收不到 click，用户就无法翻面。只有真正开始拖动时再捕获。
    dragRef.current = {
      id: photo.id,
      pointerId: event.pointerId,
      mode: dragMode,
      startX: event.clientX,
      startY: event.clientY,
      base: placementOf(photo, index),
      wallWidth: rect.width || 1,
      wallHeight: rect.height || 1,
      wallScale,
      moved: false,
    };
    onSelect(photo.id);
  };

  const handlePointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved) {
      // A tiny finger/mouse jitter must still count as a tap so the card flips.
      if (Math.abs(dx) + Math.abs(dy) <= 8) return;
      drag.moved = true;
      onDragBegin?.();
      const wall = wallRef.current;
      if (wall && !wall.hasPointerCapture(event.pointerId)) wall.setPointerCapture(event.pointerId);
    }
    if (drag.mode === "move") {
      const nextX = Math.min(0.98, Math.max(0.02, drag.base.x + dx / drag.wallWidth));
      const nextY = Math.min(0.98, Math.max(0.02, drag.base.y + dy / drag.wallHeight));
      settledRef.current = { id: drag.id, placement: { ...drag.base, x: nextX, y: nextY } };
      commit(drag.id, settledRef.current.placement);
    } else {
      // A photo is 240 world-pixels wide per scale unit. Divide by the actual
      // rendered world scale so resizing feels the same at every canvas zoom level.
      const delta = ((dx + dy) / 2) / Math.max(1, 240 * drag.wallScale);
      const scale = Math.min(3, Math.max(0.35, drag.base.scale + delta));
      settledRef.current = { id: drag.id, placement: { ...drag.base, scale } };
      commit(drag.id, settledRef.current.placement);
    }
  };

  const endDrag = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    suppressClickRef.current = drag.moved;
    dragRef.current = null;
    if (drag.moved) {
      const settled = settledRef.current;
      settledRef.current = null;
      if (settled && settled.id === drag.id) onPlacementSettled?.(settled.id, settled.placement);
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
    }
  };

  /* ── 涂鸦绘制 ─────────────────────────────────── */
  /**
   * 手机壳兼容性缩放（--compat-layout-scale）作用于 .phone-shell-wrap：client 像素 =
   * 布局像素 × k。涂鸦要把屏幕位移换算回照片自身坐标，必须除回 k；画布本体没有旋转，
   * 用它的 getBoundingClientRect 与 offsetWidth 同源相除即可得到精确 k。
   */
  const wallShellScale = () => {
    const wall = wallRef.current;
    if (!wall || wall.offsetWidth <= 0) return 1;
    // wallRef 自身已经应用了 canvasZoom；直接用 rect.width / offsetWidth
    // 会把画布缩放也误算成手机壳缩放，后续再乘 canvasZoom 时就会重复缩放
    // （例如 200% 视图下按 4 倍尺寸计算），导致照片涂鸦落点偏移。
    const renderedScale = wall.getBoundingClientRect().width / wall.offsetWidth;
    return renderedScale / Math.max(0.01, canvasZoom);
  };
  const pointOn = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number, anchorElement?: HTMLElement) => {
    const element = anchorElement ?? event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    const placement = placementOf(photo, index);
    // 用未旋转的布局尺寸 × 画布缩放 × 壳缩放：getBoundingClientRect 给的是旋转后的外接矩形，
    // 照片一倾斜就会算大，笔画自然落不准；漏算壳缩放则任何设备上 k≠1 时整体漂移。
    const shell = wallShellScale();
    const width = Math.max(1, element.offsetWidth * canvasZoom * shell);
    const height = Math.max(1, element.offsetHeight * canvasZoom * shell);
    // Invert visual rotation to store the stroke in the photo's own coordinates.
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const angle = placement.rotation * Math.PI / 180;
    return {
      x: Math.min(1, Math.max(0, (dx * Math.cos(angle) + dy * Math.sin(angle)) / width + 0.5)),
      y: Math.min(1, Math.max(0, (-dx * Math.sin(angle) + dy * Math.cos(angle)) / height + 0.5)),
      placement,
    };
  };

  const doodlePointerDown = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number, anchorElement?: HTMLElement) => {
    if (mode !== "doodle" || multiTouchRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    // Capture on the actual interaction layer before hit-testing so the gesture cannot fall
    // through to a photo's click-to-edit handler when the finger crosses a frame edge.
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* WebView fallback */ }
    const point = pointOn(event, photo, index, anchorElement);
    const side: "front" | "back" = flippedPhotoIds.has(photo.id) ? "back" : "front";
    const existing = side === "back" ? (photo.backDoodles ?? []) : (photo.doodles ?? []);
    if (eraser) {
      const hit = [...existing].reverse().find(doodle => {
        const threshold = doodle.kind === "sticker"
          ? Math.max(0.035, resolveStickerSize(doodle, DEFAULT_PHOTO_STICKER_SIZE) * 0.65 / 240)
          : 0.035;
        return doodle.points.some(item => Math.hypot(item.x - point.x, item.y - point.y) < threshold);
      });
      if (hit) onChangeDoodles(photo.id, existing.filter(item => item.id !== hit.id), side);
      return;
    }
    if (sticker) {
      onChangeDoodles(photo.id, [
        ...existing,
        { id: createPhotoWallId(), kind: "sticker", content: sticker, rotation: controlledStickerRotation, color: brushColor, width: brushWidth, size: stickerSize, points: [{ x: point.x, y: point.y }], createdAt: new Date().toISOString(), authorType: "user", authorName: "我" },
      ], side);
      return;
    }
    onSelect(photo.id);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const id = createPhotoWallId();
    strokeRef.current = { id, pointerId: event.pointerId, photoId: photo.id, side, anchorElement };
    setDraftPoints([{ x: point.x, y: point.y }]);
  };

  const doodlePointerMove = (event: React.PointerEvent, photo: PhotoWallPhoto, index: number) => {
    if (!strokeRef.current || strokeRef.current.pointerId !== event.pointerId || strokeRef.current.photoId !== photo.id || multiTouchRef.current) return;
    const point = pointOn(event, photo, index, strokeRef.current.anchorElement);
    setDraftPoints(prev => {
      const last = prev[prev.length - 1];
      if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.004) return prev;
      return [...prev, { x: point.x, y: point.y }];
    });
  };

  const doodlePointerUp = (event: React.PointerEvent, photo: PhotoWallPhoto) => {
    const stroke = strokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId || stroke.photoId !== photo.id) return;
    strokeRef.current = null;
    const points = draftPoints;
    setDraftPoints([]);
    if (points.length < 2) return;
    const existing = stroke.side === "back" ? (photo.backDoodles ?? []) : (photo.doodles ?? []);
    onChangeDoodles(photo.id, [
      ...existing,
      { id: stroke.id, kind: "stroke", color: brushColor, width: brushWidth, points, createdAt: new Date().toISOString(), authorType: "user", authorName: "我" },
    ], stroke.side);
  };

  const wallPoint = (event: React.PointerEvent) => {
    const rect = wallRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0.5, y: 0.5 };
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height))) };
  };
  /** 橡皮：只擦掉点中的那一笔/那个贴纸，不动其他内容。 */
  const eraseWallDoodleAt = (point: { x: number; y: number }) => {
    const hit = [...wallDoodles].reverse().find(doodle => {
      if (doodle.kind === "sticker") {
        const center = doodle.points[0];
        if (!center) return false;
        const dx = (center.x - point.x) * (wallWorld?.width ?? 2400);
        const dy = (center.y - point.y) * (wallWorld?.height ?? 3000);
        return Math.hypot(dx, dy) <= resolveStickerSize(doodle, DEFAULT_WALL_STICKER_SIZE) * 0.65;
      }
      return doodle.points.some(item => Math.hypot(item.x - point.x, item.y - point.y) < 0.02);
    });
    if (hit) onChangeWallDoodles?.(wallDoodles.filter(item => item.id !== hit.id));
  };

  const wallDoodlePointerDown = (event: React.PointerEvent) => {
    if (readOnly || mode !== "doodle" || multiTouchRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    // The wall's own pointer stream owns drawing; photo/frame click handlers must never receive it.
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* WebView fallback */ }
    const point = wallPoint(event);
    if (eraser) { eraseWallDoodleAt(point); return; }
    if (sticker) {
      onChangeWallDoodles?.([...wallDoodles, { id: createPhotoWallId(), kind: "sticker", content: sticker, rotation: controlledStickerRotation, color: brushColor, width: brushWidth, size: stickerSize, points: [point], createdAt: new Date().toISOString(), authorType: "user", authorName: "我" }]);
      return;
    }
    (event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId);
    wallStrokeRef.current = { id: createPhotoWallId(), pointerId: event.pointerId };
    wallDraftPointsRef.current = [point];
    setDraftPoints([point]);
  };
  const wallDoodlePointerMove = (event: React.PointerEvent) => {
    if (!wallStrokeRef.current || wallStrokeRef.current.pointerId !== event.pointerId || mode !== "doodle" || multiTouchRef.current) return;
    const point = wallPoint(event);
    const last = wallDraftPointsRef.current[wallDraftPointsRef.current.length - 1];
    if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.003) return;
    wallDraftPointsRef.current = [...wallDraftPointsRef.current, point];
    setDraftPoints(wallDraftPointsRef.current);
  };
  const wallDoodlePointerUp = (event: React.PointerEvent) => {
    const stroke = wallStrokeRef.current;
    if (!stroke || stroke.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    wallStrokeRef.current = null;
    const points = wallDraftPointsRef.current;
    wallDraftPointsRef.current = [];
    setDraftPoints([]);
    if (points.length >= 2) onChangeWallDoodles?.([...wallDoodles, { id: stroke.id, kind: "stroke", color: brushColor, width: brushWidth, points, createdAt: new Date().toISOString(), authorType: "user", authorName: "我" }]);
  };
  /* ── 选中照片的小工具条 ──────────────────────── */
  const nudge = (photo: PhotoWallPhoto, index: number, patch: Partial<PhotoWallPlacement>) => {
    const base = placementOf(photo, index);
    // Lock protects placement/size/rotation. Framing remains a presentation choice.
    if (base.locked && patch.locked === undefined && patch.frame === undefined && patch.frameColor === undefined) return;
    onDragBegin?.();
    commit(photo.id, { ...base, ...patch } as PhotoWallPlacement);
  };

  const bringToFront = (photo: PhotoWallPhoto, index: number) => {
    const maxZ = ordered.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
    nudge(photo, index, { z: maxZ + 1 });
  };

  return <div className={fitHeight ? "relative flex h-full w-full items-center justify-center" : "relative"} style={wallWorld ? { width: wallWorld.width, height: wallWorld.height } : undefined}>
    <div
      ref={wallRef}
      data-photo-wall-mode={mode}
      className={"photo-wall-surface absolute left-0 top-0 select-none overflow-hidden rounded-[2px] border border-[#eee3d8] shadow-[inset_0_1px_0_rgba(255,255,255,.95),0_4px_12px_rgba(88,70,48,.06)]"}
      style={{ width: wallWorld?.width ?? 2400, height: wallWorld?.height ?? 3000, transform: "none", transformOrigin: "top left", aspectRatio: fitHeight ? "4 / 5" : undefined, touchAction: readOnly ? "auto" : "none", backgroundSize: backgroundImage ? backgroundSizing.size : undefined, backgroundPosition: backgroundSizing.position, backgroundRepeat: backgroundImage ? "no-repeat" : undefined, backgroundImage: backgroundImage ? 'linear-gradient(rgba(255,250,242,.13),rgba(255,250,242,.13)),url("' + backgroundImage + '")' : "repeating-linear-gradient(0deg,rgba(130,98,70,.018) 0,rgba(130,98,70,.018) 1px,transparent 1px,transparent 4px),radial-gradient(ellipse at 24% 15%,rgba(255,255,255,.9),transparent 62%),linear-gradient(145deg,#fffaf2 0%,#faf3ea 48%,#f5ece2 100%)" }}
      onPointerMove={readOnly ? undefined : handlePointerMove}
      onPointerUp={readOnly ? undefined : endDrag}
      onPointerCancel={readOnly ? undefined : endDrag}
      onTouchStart={event => { if (event.touches.length > 1) { multiTouchRef.current = true; dragRef.current = null; } }}
      onTouchEnd={() => { /* 双指结束后由 pinch-end 的冷却计时统一恢复单指输入。 */ }}
      onClick={event => { if (event.target === event.currentTarget) onSelect(null); }}
    >
      {ordered.length === 0 && !readOnly && <div className="pointer-events-none absolute inset-0 grid place-items-center text-[#a99a86]"><div className="text-center"><ImagePlus size={26} className="mx-auto"/><p className="mt-2 text-xs">这面墙还空着</p></div></div>}

      {/* The top input layer owns wall/photo drawing; keep one pointer-routing path. */}
      {ordered.map((photo, index) => {
        const placement = placementOf(photo, index);
        const isSelected = photo.id === selectedId;
        return <WallPhotoFrame
          key={photo.id}
          photo={photo}
          placement={placement}
          canvasZoom={canvasZoom}
          selected={isSelected}
          flipped={flippedPhotoIds.has(photo.id)}
          onToggleFlip={() => {
            if (mode !== "view") return;
            if (multiTouchRef.current) { suppressClickRef.current = true; return; }
            if (suppressClickRef.current) { suppressClickRef.current = false; return; }
            setFlippedPhotoIds(current => { const next = new Set(current); if (next.has(photo.id)) next.delete(photo.id); else next.add(photo.id); return next; });
          }}
          doodleMode={mode === "doodle"}
          placementMode={mode === "move"}
          draftPoints={isSelected && strokeRef.current?.photoId === photo.id ? draftPoints : []}
          onPointerDownResize={(event) => { if (!readOnly) beginDrag(event, photo, index, "resize"); }}
          onOpenDetail={() => onOpenDetail(photo)}
          readOnly={readOnly}
        />;
      })}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="整面照片墙涂鸦画布"
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ zIndex: 9999, pointerEvents: "none", touchAction: "none", overflow: "visible" }}>
        {mode === "doodle" && !readOnly && <rect x="0" y="0" width="100" height="100" fill="transparent" />}
        {wallDoodles.filter(doodle => doodle.kind === "stroke").map(doodle =>
          <polyline key={doodle.id} points={doodle.points.map(point => (point.x * 100) + "," + (point.y * 100)).join(" ")} fill="none" stroke={doodle.color} strokeWidth={Math.max(0.6, doodle.width / 2)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>)}
        {mode === "doodle" && wallStrokeRef.current && draftPoints.length > 1 && <polyline points={draftPoints.map(point => (point.x * 100) + "," + (point.y * 100)).join(" ")} fill="none" stroke={brushColor} strokeWidth={Math.max(0.6, brushWidth / 2)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>}
      </svg>
      {/* 贴纸用独立 HTML 图层：固定宽高比，不随画布宽高比拉伸。 */}
      <div className="pointer-events-none absolute inset-0" style={{ zIndex: 10000 }} aria-hidden="true">
        {wallDoodles.filter(doodle => doodle.kind === "sticker").map(doodle => {
          const size = resolveStickerSize(doodle, DEFAULT_WALL_STICKER_SIZE);
          return <PhotoWallSticker key={doodle.id} doodle={doodle} size={size} />;
        })}
      </div>

      <div
        aria-label={mode === "move" ? "照片摆放操作层" : "照片与背面留言涂鸦层"}
        data-photo-wall-input-layer={mode}
        className="absolute inset-0"
        style={{ zIndex: 2147483000, pointerEvents: !readOnly && mode !== "view" ? "auto" : "none", touchAction: "none" }}
        onPointerDown={event => {
          if (readOnly || mode === "view" || multiTouchRef.current) return; // 双指手势优先；不允许第二根手指重新起笔。
          event.preventDefault();
          event.stopPropagation();
          // elementsFromPoint is inconsistent in some Android WebViews when a full-wall
          // transparent input layer sits above transformed photo cards. Resolve the hit using
          // the actual rendered card rectangles, front-to-back, then obtain that card's anchor.
          const wall = wallRef.current;
          const resizeTarget = Array.from(wall?.querySelectorAll<HTMLElement>("[data-photo-wall-resize]") ?? []).find(element => {
            const rect = element.getBoundingClientRect();
            return event.clientX >= rect.left && event.clientX <= rect.right
              && event.clientY >= rect.top && event.clientY <= rect.bottom;
          });
          const renderedCards = Array.from(wall?.querySelectorAll<HTMLElement>("[data-photo-wall-photo-id]") ?? []);
          // Rotated photos have an axis-aligned bounding box larger than their visible shape.
          // Hit-test in the photo's own rotated coordinate space so the empty corners remain
          // genuine wall canvas and receive wall-level doodles instead of being misrouted.
          const hitsPhotoShape = (element: HTMLElement) => {
            const rect = element.getBoundingClientRect();
            const transform = window.getComputedStyle(element).transform;
            let angle = 0;
            if (transform && transform !== "none") {
              const match = transform.match(/^matrix\(([^)]+)\)$/);
              if (match) {
                const values = match[1].split(",").map(Number);
                if (values.length >= 2 && Number.isFinite(values[0]) && Number.isFinite(values[1])) angle = Math.atan2(values[1], values[0]);
              }
            }
            const dx = event.clientX - (rect.left + rect.width / 2);
            const dy = event.clientY - (rect.top + rect.height / 2);
            const localX = dx * Math.cos(angle) + dy * Math.sin(angle);
            const localY = -dx * Math.sin(angle) + dy * Math.cos(angle);
            const shell = wallShellScale();
            const width = Math.max(1, element.offsetWidth * canvasZoom * shell);
            const height = Math.max(1, element.offsetHeight * canvasZoom * shell);
            return Math.abs(localX) <= width / 2 && Math.abs(localY) <= height / 2;
          };
          const hit = renderedCards.slice().reverse().find(hitsPhotoShape);
          const photoElement = hit;
          const photoId = photoElement?.dataset.photoWallPhotoId;
          const photoAnchor = photoElement?.querySelector<HTMLElement>("[data-photo-wall-photo-anchor]") ?? undefined;
          const index = ordered.findIndex(photo => photo.id === photoId);
          const photo = index >= 0 ? ordered[index] : null;
          if (mode === "move") {
            if (photo) beginDrag(event, photo, index, resizeTarget ? "resize" : "move");
          } else if (photo) {
            onSelect(photo.id);
            doodlePointerDown(event, photo, index, photoAnchor ?? photoElement);
          } else {
            wallDoodlePointerDown(event);
          }
        }}
        onPointerMove={event => {
          if (readOnly || mode !== "doodle") return;
          if (strokeRef.current) {
            event.preventDefault();
            event.stopPropagation();
            const index = ordered.findIndex(photo => photo.id === strokeRef.current?.photoId);
            const photo = index >= 0 ? ordered[index] : null;
            if (photo) doodlePointerMove(event, photo, index);
          } else if (wallStrokeRef.current) {
            event.preventDefault();
            event.stopPropagation();
            wallDoodlePointerMove(event);
          }
        }}
        onPointerUp={event => {
          if (readOnly || mode === "view") return;
          if (mode === "doodle") {
            event.preventDefault();
            event.stopPropagation();
            if (strokeRef.current) {
              const index = ordered.findIndex(photo => photo.id === strokeRef.current?.photoId);
              const photo = index >= 0 ? ordered[index] : null;
              if (photo) doodlePointerUp(event, photo);
            } else if (wallStrokeRef.current) wallDoodlePointerUp(event);
          }
          // Move mode intentionally bubbles to wallRef so endDrag can commit the final position.
        }}
        onPointerCancel={event => {
          // pointercancel means the browser/another finger interrupted this gesture:
          // discard the draft; never persist a half-finished stroke.
          if (readOnly) return;
          if (strokeRef.current?.pointerId === event.pointerId) strokeRef.current = null;
          if (wallStrokeRef.current?.pointerId === event.pointerId) wallStrokeRef.current = null;
          wallDraftPointsRef.current = [];
          setDraftPoints([]);
          dragRef.current = null;
          suppressClickRef.current = true;
        }}
        onClick={event => { if (!readOnly && mode !== "view") { event.preventDefault(); event.stopPropagation(); } }}
        onDoubleClick={event => { if (!readOnly && mode !== "view") { event.preventDefault(); event.stopPropagation(); } }}
      />
    </div>

  </div>;
}

type FrameProps = {
  photo: PhotoWallPhoto;
  placement: PhotoWallPlacement;
  canvasZoom: number;
  selected: boolean;
  flipped: boolean;
  placementMode: boolean;
  onToggleFlip: () => void;
  doodleMode: boolean;
  draftPoints: { x: number; y: number }[];
  onPointerDownResize: (event: React.PointerEvent) => void;
  onOpenDetail: () => void;
  readOnly: boolean;
};

function WallPhotoFrame({ photo, placement, canvasZoom, selected, flipped, placementMode, onToggleFlip, doodleMode, draftPoints, onPointerDownResize, onOpenDetail, readOnly }: FrameProps) {
  const [src, setSrc] = useState("");
  const [originalSrc, setOriginalSrc] = useState("");
  const originalUrlRef = useRef("");
  const [failed, setFailed] = useState(false);
  const [inView, setInView] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    // Observe against the actual photo-wall viewport, not the outer browser viewport.
    // The world stage is transformed and may be much larger than the phone screen.
    const viewport = node.closest<HTMLElement>("[data-photo-wall-viewport]");
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) setInView(entry.isIntersecting);
    }, { root: viewport, rootMargin: "600px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!inView || src) return;
    let active = true;
    setFailed(false);
    void loadWallThumbUrl(photo.mediaRef).then(value => {
      if (!active) return;
      if (value) setSrc(value); else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [photo.mediaRef, inView, src]);

  // Keep the lightweight derivative for ordinary viewing, but switch to the original
  // when zoom + device pixel ratio means the thumbnail would visibly lose detail.
  const needsOriginal = canvasZoom * placement.scale * 240 * (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1) > 2048;
  useEffect(() => {
    if (!inView || !needsOriginal || originalUrlRef.current) return;
    let active = true;
    void loadMediaObjectUrl(photo.mediaRef).then(value => {
      if (!active) { if (value) URL.revokeObjectURL(value); return; }
      if (value) { originalUrlRef.current = value; setOriginalSrc(value); }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [photo.mediaRef, inView, needsOriginal]);

  // Keep the original URL cached across zoom toggles; release it only when this frame unmounts.
  useEffect(() => () => {
    if (originalUrlRef.current) URL.revokeObjectURL(originalUrlRef.current);
  }, []);

  const frame = placement.frame;
  const pad = FRAME_PADDING[frame];
  const width = String(240 * placement.scale) + "px";
  const visibleDoodles = flipped ? (photo.backDoodles ?? []) : (photo.doodles ?? []);
  const drawingIsEnabled = doodleMode && !readOnly;
  const movingIsEnabled = placementMode && !readOnly;

  return <div
    ref={rootRef}
    data-photo-wall-photo
    data-photo-wall-photo-id={photo.id}
    className="absolute"
    style={{
      left: String(placement.x * 100) + "%",
      top: String(placement.y * 100) + "%",
      width,
      transform: "translate(-50%, -50%) rotate(" + placement.rotation + "deg)",
      zIndex: placement.z,
      touchAction: readOnly ? "pan-x pan-y" : "none",
    }}
    onClick={event => {
      event.stopPropagation();
      // Dragging and drawing are handled only by the canvas-wide input layer.
      if (placementMode || doodleMode) { event.preventDefault(); return; }
      // Face clicks flip in view mode; clicks on the matte open the editable photo details.
      if ((event.target as HTMLElement).closest("[data-photo-wall-photo-image]")) return;
      onOpenDetail();
    }}
    onDoubleClick={event => { event.stopPropagation(); event.preventDefault(); }}
  >
    <div
      data-photo-wall-photo-anchor="true"
      className={"relative " + (selected && placementMode ? "outline outline-2 outline-offset-2 outline-[#87565b]" : "")}
      style={{
        background: FRAME_BG[frame] === "transparent" ? "transparent" : (placement.frameColor || FRAME_BG[frame]),
        padding: String(pad.y * 100) + "% " + String(pad.x * 100) + "% " + String(pad.bottom * 100) + "%",
        borderRadius: frame === "thin" ? 1 : frame === "none" ? 2 : 1,
        boxShadow: frame === "none" ? "0 3px 8px rgba(70,55,38,.14)" : "0 4px 12px rgba(70,55,38,.13)",
      }}
    >
      {flipped ? (
        <div
          data-photo-wall-photo-image
          role="button"
          tabIndex={0}
          aria-label="点击翻回照片正面"
          className="relative flex w-full flex-col overflow-hidden rounded-sm bg-[#fffaf2] p-2.5 text-[#6b5947]"
          style={{ aspectRatio: "1 / 1", borderRadius: frame === "none" ? 2 : 1 }}
          onClick={event => {
            event.preventDefault(); event.stopPropagation();
            if (!placementMode && !doodleMode) onToggleFlip();
          }}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (!placementMode && !doodleMode) onToggleFlip(); } }}
        >
          <div className="border-b border-[#dfcfbe] pb-1 text-[7px] tracking-[.2em] text-[#a58f77]">THE BACK · 背面</div>
          <div className="mt-1 break-words text-[9px] font-semibold leading-snug">{photo.title || "未命名的瞬间"}</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-[8px] leading-relaxed">{photo.backNote?.trim() || "还没有写下手记。点击相框可编辑背面内容。"}</p>
          {photo.caption?.trim() && <p className="mt-1 break-words border-t border-[#e8dccd] pt-1 text-[7px] leading-snug">{photo.caption}</p>}
          {photo.annotations.length > 0 && <div className="mt-auto border-t border-[#e8dccd] pt-1">{photo.annotations.slice(-2).map(note => <p key={note.id} className="mt-0.5 break-words text-[7px] leading-snug"><span className="font-semibold">{note.authorName}：</span>{note.content}</p>)}</div>}
        </div>
      ) : (
        <>
          <div
            data-photo-wall-photo-image
            role="button"
            tabIndex={0}
            aria-label={"点击翻看照片：" + (photo.title || "未命名的瞬间")}
            className="relative overflow-hidden bg-[#e7dfd2]"
            style={{ aspectRatio: "1 / 1", borderRadius: frame === "none" ? 2 : 1 }}
            onClick={event => {
              event.preventDefault(); event.stopPropagation();
              if (!placementMode && !doodleMode) onToggleFlip();
            }}
            onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); if (!placementMode && !doodleMode) onToggleFlip(); } }}
          >
            {src ? <img src={needsOriginal && originalSrc ? originalSrc : src} alt={photo.title} draggable={false} className="pointer-events-none h-full w-full object-contain" /> : failed ? <div className="grid h-full place-items-center text-[9px] text-[#a06050]">图片无法显示</div> : <div className="grid h-full place-items-center text-[#a99a86]"><ImagePlus size={16}/></div>}
            {frame === "tape" && <>
              <span className="pointer-events-none absolute -left-2 -top-2 h-4 w-10 -rotate-12 bg-[#f3e9cf]/85 shadow-sm" />
              <span className="pointer-events-none absolute -right-2 -top-2 h-4 w-10 rotate-12 bg-[#f3e9cf]/85 shadow-sm" />
            </>}
          </div>
          {frame === "polaroid" && <div className="mt-1 truncate text-center font-serif text-[9px] text-[#8d7c66]">{photo.title}</div>}
        </>
      )}

      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 z-10 h-full w-full" style={{ overflow: "visible" }}>
        {visibleDoodles.filter(doodle => doodle.kind === "stroke").map(doodle =>
          <polyline key={doodle.id} points={doodle.points.map(point => String(point.x * 100) + "," + String(point.y * 100)).join(" ")} fill="none" stroke={doodle.color} strokeWidth={doodle.width} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
        {drawingIsEnabled && draftPoints.length > 1 && <polyline points={draftPoints.map(point => String(point.x * 100) + "," + String(point.y * 100)).join(" ")} fill="none" stroke="#c2705a" strokeWidth={3} strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
      </svg>



      <div className="pointer-events-none absolute inset-0 z-20" aria-hidden="true">
        {visibleDoodles.filter(doodle => doodle.kind === "sticker").map(doodle => {
          const size = resolveStickerSize(doodle, DEFAULT_PHOTO_STICKER_SIZE) * placement.scale;
          return <PhotoWallSticker key={doodle.id} doodle={doodle} size={size} />;
        })}
      </div>

      {selected && movingIsEnabled && !placement.locked && <button
        type="button"
        aria-label="拖动调整大小"
        data-photo-wall-resize="true"
        onPointerDown={event => { event.preventDefault(); event.stopPropagation(); onPointerDownResize(event); }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); }}
        className="absolute -bottom-2 -right-2 z-30 grid h-6 w-6 place-items-center rounded-full border border-white bg-[#87565b] text-white shadow"
      ><Plus size={12}/></button>}
    </div>
  </div>;
}
