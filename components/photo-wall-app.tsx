"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Camera, Check, Download, Feather, Heart, ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, X } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import { appendCustomAppTimelineEntry } from "@/lib/custom-app-storage";
import { loadImageGenerationSettings } from "@/lib/settings-storage";
import type { Character } from "@/lib/character-types";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import { loadMediaBlob, loadMediaObjectUrl, storeMediaBlob, deleteMediaRef, retainMediaRef, releaseMediaRef } from "@/lib/media-cache-storage";
import { loadVirtualLifeState, saveVirtualLifeState } from "@/lib/life/life-storage";
import { generateChatCompletion, flattenCompletionResult, readCompressedImageDataUrl } from "@/lib/chat-engine";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import {
  createPhotoWallId, DEFAULT_PHOTO_WALL_SETTINGS, loadPhotoWallState, savePhotoWallState, normalizeWorld,
  type PhotoWallCreationRecord, type PhotoWallDoodle, type PhotoWallPhoto, type PhotoWallPlacement, type PhotoWallState, type PhotoWallTemplate, type PhotoWallWorld,
} from "@/lib/photo-wall-storage";
import { PhotoWallCanvas, fallbackPlacement } from "@/components/photo-wall/photo-wall-canvas";
import { resizeWorldPreservingPositions, wallWorldOf } from "@/lib/photo-wall-world";
import { buildTemplateSlots, listAllTemplates, loadCustomTemplates, loadTemplateFill, saveCustomTemplates, saveTemplateFill } from "@/lib/photo-wall-templates";
import { downloadPhotoWallPng } from "@/lib/photo-wall-export";
import { parseCharacterWallDoodles } from "@/lib/photo-wall-character-doodle";
import { stickerSizeFromBrushWidth } from "@/lib/photo-wall-doodle-sizing";

type Props = { onClose: () => void; onNotice?: (message: string) => void };
type Filter = "all" | "mine" | "characters";

const KIND_LABEL: Record<PhotoWallPhoto["kind"], string> = {
  favorite: "珍藏", selfie: "自拍", candid: "不经意的你", scenery: "沿途风景", object: "喜欢的小物", moment: "共同瞬间",
};
const KIND_OPTIONS: PhotoWallPhoto["kind"][] = ["favorite", "selfie", "candid", "scenery", "object", "moment"];
const DEFAULT_WALL_BRUSH_PALETTE = ["#c2705a", "#a77b77", "#b08a54", "#5d6b8a", "#8a6b8a", "#3c3a36"];
const DAY_MS = 24 * 60 * 60 * 1000;
const PHOTO_WALL_PROMPT_KEY = "ai_phone_photo_wall_prompt_v1";
const PHOTO_WALL_ACTIVE_TEMPLATE_KEY = "ai_phone_photo_wall_active_template_v1";
const PHOTO_WALL_CHARACTER_KEY = "ai_phone_photo_wall_selected_character_v1";
const PHOTO_WALL_GROUP_REFERENCES_KEY = "ai_phone_photo_wall_group_reference_characters_v1";
function readPhotoWallGroupReferences(): string[] { try { const value = typeof window !== "undefined" ? JSON.parse(window.localStorage.getItem(PHOTO_WALL_GROUP_REFERENCES_KEY) || "[]") : []; return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []; } catch { return []; } }
const DEFAULT_PHOTO_WALL_PROMPT = [
  "请生成一张真实相机拍摄的私人生活照片，而不是插画、海报或拼贴。",
  "角色：{characterName}",
  "角色设定：{characterPersona}",
  "照片类型：{photoType}",
  "近期生活片段：{lifeEvent}",
  "参考图要求：{referenceText}",
  "画面风格：温柔、文艺、自然光、低饱和胶片色彩、细微颗粒、构图克制、真实生活细节。",
  "不要出现文字、水印、拼接边框或不自然的手指。",
].join("\n");
function readPhotoWallPrompt(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_PROMPT_KEY) || DEFAULT_PHOTO_WALL_PROMPT : DEFAULT_PHOTO_WALL_PROMPT; } catch { return DEFAULT_PHOTO_WALL_PROMPT; } }
function readPhotoWallTemplate(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_ACTIVE_TEMPLATE_KEY) || "builtin-grid" : "builtin-grid"; } catch { return "builtin-grid"; } }
function readPhotoWallCharacter(): string { try { return typeof window !== "undefined" ? window.localStorage.getItem(PHOTO_WALL_CHARACTER_KEY) || "" : ""; } catch { return ""; } }

function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "某个日子";
  return new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}
function formatDateTimeInput(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

async function readExifCapturedAt(file: File): Promise<string | undefined> {
  if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return undefined;
  try {
    const view = new DataView(await file.slice(0, 1024 * 1024).arrayBuffer());
    if (view.byteLength < 12 || view.getUint16(0, false) !== 0xffd8) return undefined;
    const ascii = (start: number, length: number) => {
      let value = "";
      for (let i = 0; i < length && start + i < view.byteLength; i += 1) value += String.fromCharCode(view.getUint8(start + i));
      return value;
    };
    let offset = 2;
    while (offset + 4 < view.byteLength) {
      if (view.getUint8(offset) !== 0xff) { offset += 1; continue; }
      const marker = view.getUint8(offset + 1);
      const length = view.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > view.byteLength) break;
      const dataStart = offset + 4;
      if (marker === 0xe1 && ascii(dataStart, 6) === "Exif\0\0") {
        const tiff = dataStart + 6;
        const order = ascii(tiff, 2);
        const little = order === "II";
        if (!little && order !== "MM") return undefined;
        const u16 = (at: number) => view.getUint16(at, little);
        const u32 = (at: number) => view.getUint32(at, little);
        const ifd0 = tiff + u32(tiff + 4);
        const entryCount = u16(ifd0);
        let exifOffset = 0;
        for (let i = 0; i < entryCount; i += 1) {
          const entry = ifd0 + 2 + i * 12;
          if (entry + 12 > view.byteLength) break;
          if (u16(entry) === 0x8769) { exifOffset = u32(entry + 8); break; }
        }
        if (!exifOffset) return undefined;
        const exifIfd = tiff + exifOffset;
        const exifCount = u16(exifIfd);
        for (let i = 0; i < exifCount; i += 1) {
          const entry = exifIfd + 2 + i * 12;
          if (entry + 12 > view.byteLength) break;
          const tag = u16(entry);
          if ((tag === 0x9003 || tag === 0x9004) && u16(entry + 2) === 2) {
            const count = u32(entry + 4);
            const textStart = count <= 4 ? entry + 8 : tiff + u32(entry + 8);
            const raw = ascii(textStart, Math.min(count, 32)).replace(/\0.*$/, "").trim();
            const match = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
            if (!match) return undefined;
            return match[1] + "-" + match[2] + "-" + match[3] + "T" + match[4] + ":" + match[5] + ":" + match[6];
          }
        }
        return undefined;
      }
      if (marker === 0xda || marker === 0xd9) break;
      offset += 2 + length;
    }
  } catch { /* Photos without EXIF are normal; use manual capture time instead. */ }
  return undefined;
}

type PhotoAlbum = { id: string; title: string; coverPhotoId: string; pages: string[][] };
const PHOTO_ALBUMS_KEY = "ai_phone_photo_albums_v1";
function loadPhotoAlbums(): PhotoAlbum[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(PHOTO_ALBUMS_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(item => item && typeof item.id === "string" && typeof item.title === "string").map(item => ({
      id: String(item.id),
      title: String(item.title).slice(0, 80),
      coverPhotoId: typeof item.coverPhotoId === "string" ? item.coverPhotoId : "",
      pages: Array.isArray(item.pages) && item.pages.length
        ? item.pages.map((page: unknown) => Array.isArray(page) ? page.slice(0, 9).map(String) : [])
        : [[]],
    }));
  } catch { return []; }
}

function getPhotoBackText(photo: PhotoWallPhoto): string {
  const manual = photo.backNote?.trim() ?? "";
  const legacyNotes = (photo.annotations ?? []).map(note => {
    const date = new Date(note.createdAt);
    const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("zh-CN");
    return `${note.authorName}${when ? `（${when}）` : ""}：${note.content.trim()}`;
  }).filter(Boolean);
  return [manual, ...legacyNotes].filter(Boolean).join("\n\n");
}
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

/**
 * Preserve the uploaded original byte-for-byte. Display thumbnails are generated lazily
 * by PhotoWallCanvas; resizing here permanently loses detail in both photos and backgrounds,
 * and makes the exported wall impossible to zoom into cleanly.
 */
async function optimizeUpload(file: File): Promise<Blob> {
  return file;
}

const RECORD_HEART_PATH = "M0,6 C-1.4,3.8 -6,1 -6,-2 C-6,-5 -3,-6 0,-4 C3,-6 6,-5 6,-2 C6,1 1.4,3.8 0,6 Z";

function DoodleMark({ doodle, size }: { doodle: import("@/lib/photo-wall-storage").PhotoWallDoodle; size: number }) {
  const x = (doodle.points[0]?.x ?? 0.5) * 100;
  const y = (doodle.points[0]?.y ?? 0.5) * 100;
  if (doodle.content === "heart" || doodle.content === "❤") {
    return <g transform={`translate(${x} ${y}) rotate(${doodle.rotation ?? 0}) scale(${size / 10})`}><path d={RECORD_HEART_PATH} fill={doodle.color}/></g>;
  }
  return <g transform={`translate(${x} ${y}) rotate(${doodle.rotation ?? 0})`}><text x={0} y={0} fill={doodle.color} fontSize={size} textAnchor="middle" dominantBaseline="middle">{doodle.content || "✦"}</text></g>;
}

function CreationLayerPreview({ photo, doodles, label, side, onOpen }: { photo?: PhotoWallPhoto; doodles: PhotoWallDoodle[]; label: string; side?: "front" | "back"; onOpen?: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    if (!photo?.mediaRef) { setSrc(""); return; }
    void loadMediaObjectUrl(photo.mediaRef).then(value => {
      if (!active) { if (value) URL.revokeObjectURL(value); return; }
      if (value) { url = value; setSrc(value); }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [photo?.mediaRef]);
  const body = <div className="relative aspect-square min-h-[132px] overflow-hidden border border-[#e4d2c1] bg-[#f4ecdf]">
    {side === "back" && photo
      ? <div className="h-full overflow-hidden bg-[#fffaf0] p-3 text-[10px] leading-relaxed text-[#8b715e]"><div className="mb-2 border-b border-dashed border-[#d9c7b2] pb-1 font-serif text-xs">{photo.title || "照片背面"}</div><p className="whitespace-pre-wrap break-words">{photo.backNote || "留给这张照片背面的几句话……"}</p></div>
      : src ? <img src={src} alt={photo?.title || label} loading="lazy" className="h-full w-full object-contain"/> : <div className="grid h-full place-items-center px-2 text-center text-[11px] text-[#9b8774]">{photo ? "照片暂不可读取" : "照片墙自由画布"}</div>}
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
      {doodles.map(doodle => doodle.kind === "stroke"
        ? <polyline key={doodle.id} points={doodle.points.map(point => (point.x * 100) + "," + (point.y * 100)).join(" ")} fill="none" stroke={doodle.color} strokeWidth={Math.max(0.65, doodle.width / 3)} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
        : <g key={doodle.id}><DoodleMark doodle={doodle} size={9}/></g>)}
    </svg>
  </div>;
  return photo && onOpen
    ? <button type="button" onClick={onOpen} className="block w-full text-left"><span className="mb-1 block truncate text-[10px] text-[#8e7766]">{label}</span>{body}</button>
    : <div><span className="mb-1 block truncate text-[10px] text-[#8e7766]">{label}</span>{body}</div>;
}

function PhotoThumbnail({ photo, onOpen }: { photo: PhotoWallPhoto; onOpen: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true;
    let url = "";
    void loadMediaObjectUrl(photo.mediaRef).then(value => {
      if (!active) { if (value) URL.revokeObjectURL(value); return; }
      if (value) { url = value; setSrc(value); }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [photo.mediaRef]);
  return <button type="button" onClick={onOpen} aria-label={`查看照片：${photo.title || "未命名的瞬间"}`} className="group relative block w-full text-left">
    <div className="relative aspect-square overflow-hidden bg-[#e9e3d8]">
      {src ? <img src={src} alt={photo.title} loading="lazy" className="h-full w-full object-contain transition duration-500 group-hover:scale-[1.01]" /> : <div className="grid h-full place-items-center text-[#9c907f]"><ImagePlus size={25}/></div>}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" style={{overflow:"visible"}}>
        {(photo.doodles ?? []).map(doodle => doodle.kind === "stroke" ? <polyline key={doodle.id} points={doodle.points.map(point=>`${point.x*100},${point.y*100}`).join(" ")} fill="none" stroke={doodle.color} strokeWidth={Math.max(0.8,doodle.width/2)} strokeLinecap="round" strokeLinejoin="round"/> : <g key={doodle.id}><DoodleMark doodle={doodle} size={12}/></g>)}
      </svg>
      
    </div>
  </button>;
}
export function PhotoWallApp({ onClose, onNotice }: Props) {
  const recordPhotoWallMemory = useCallback((summary: string, characterId?: string) => {
    try {
      const ids = characterId ? [characterId] : loadCharacters().map(character => character.id);
      for (const id of ids) {
        appendCustomAppTimelineEntry({ id: "photo_wall", name: "照片墙" }, {
          characterId: id, summary: summary.slice(0, 500), appLabel: "照片墙",
        });
      }
    } catch { /* 记忆失败不影响照片墙 */ }
  }, []);
  const [state, setState] = useState<PhotoWallState>(() => loadPhotoWallState());
  const [characters, setCharacters] = useState<Character[]>([]);

  // 照片墙是所有角色共同可见的公共墙。将每条创作记录幂等投影到生活系统共享事件，
  // 并把当时所有角色列为参与者；挂载时也会补齐旧版本已经存在的创作记录。
  useEffect(() => {
    const records = state.creationRecords ?? [];
    if (!records.length) return;
    const lifeState = loadVirtualLifeState();
    const allCharacterIds = characters.map(character => character.id).filter(Boolean);
    let events = lifeState.events;
    let memories = lifeState.memories;
    let changed = false;
    for (const record of records) {
      const eventId = "photo-wall-" + record.id;
      const linkedPhotos = record.photoIds
        .map(photoId => state.photos.find(photo => photo.id === photoId))
        .filter((photo): photo is PhotoWallPhoto => Boolean(photo));
      const photoTitles = linkedPhotos.map(photo => photo.title).filter(Boolean).slice(0, 8);
      const fact = [
        record.authorName + "在公共照片墙完成了一次共同创作",
        record.narrative,
        photoTitles.length ? "涉及照片：" + photoTitles.join("、") : "",
      ].filter(Boolean).join("；");
      const participants = [...new Set(["player", ...allCharacterIds, ...(record.authorId ? [record.authorId] : [])])];
      const oldEvent = events.find(item => item.id === eventId);
      const oldMemory = memories.find(item => item.id === eventId);
      const sameParticipants = (left: string[] | undefined) =>
        Boolean(left && left.length === participants.length && participants.every(id => left.includes(id)));
      if (oldEvent?.details === fact && sameParticipants(oldEvent.participantIds)
        && oldMemory?.fact === fact && sameParticipants(oldMemory.participants)) continue;
      const event = {
        id: eventId,
        kind: "memory" as const,
        status: "completed" as const,
        participantIds: participants,
        title: "照片墙共同创作",
        details: fact,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
        completedAt: record.createdAt,
      };
      const memory = { id: eventId, eventId, occurredAt: record.createdAt, participants, fact };
      events = [event, ...events.filter(item => item.id !== eventId)];
      memories = [memory, ...memories.filter(item => item.id !== eventId)];
      changed = true;
    }
    if (changed) saveVirtualLifeState({ ...lifeState, events, memories });
  }, [state.creationRecords, state.photos, characters]);
  const [filter, setFilter] = useState<Filter>("all");
  const [wallView, setWallView] = useState<"timeline" | "memories" | "album" | "panorama" | "edit" | "settings" | "creations">("panorama");
  const [settingsReturnView, setSettingsReturnView] = useState<"panorama" | "edit">("panorama");
  const [panoramaZoom, setPanoramaZoom] = useState(100);
  const panoramaMinZoomRef = useRef(5);
  const [timelineStartDate, setTimelineStartDate] = useState("");
  const [timelineEndDate, setTimelineEndDate] = useState("");
  const [timelineGrouping, setTimelineGrouping] = useState<"photo" | "day" | "week" | "month" | "year">("month");
  const pinchStartRef = useRef<{ distance: number; zoom: number } | null>(null);
  const pinchLastMidpointRef = useRef<{ x: number; y: number } | null>(null);
  const pinchPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchModeRef = useRef(false);
  const singleTouchRef = useRef<{ x: number; y: number; startedOnPhoto: boolean; panStarted: boolean } | null>(null);
  const panoramaViewportRef = useRef<HTMLDivElement>(null);
  const worldStageRef = useRef<HTMLDivElement>(null);
  const panoramaZoomRef = useRef(100);
  /**
   * 画布不再用原生滚动：viewport 固定不动，内部 wrapper 用 translate(x,y) scale(zoom) 定位。
   * pan.x/pan.y 是 wrapper 左上角相对 viewport 左上角的屏幕像素偏移（可正可负）。
   * 单指拖动空白区域、双指缩放锚点补偿都只改这一份状态，不再有「滚动」和「transform」两条并行的写入路径。
   */
  const panRef = useRef({ x: 0, y: 0 });
  const [, setPanVersion] = useState(0);
  /** 读屏幕上真正生效的 transform，而不是读 state。pinch 开始时用它对齐。 */
  const readStageTransform = useCallback((): { x: number; y: number; zoom: number } => {
    const stage = worldStageRef.current;
    if (!stage) return { ...panRef.current, zoom: panoramaZoomRef.current };
    try {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(stage).transform === "none" ? "" : getComputedStyle(stage).transform);
      const zoom = Number.isFinite(matrix.a) && matrix.a > 0 ? matrix.a * 100 : panoramaZoomRef.current;
      const x = Number.isFinite(matrix.e) ? matrix.e : panRef.current.x;
      const y = Number.isFinite(matrix.f) ? matrix.f : panRef.current.y;
      return { x, y, zoom };
    } catch {
      return { ...panRef.current, zoom: panoramaZoomRef.current };
    }
  }, []);
  /** 一次写入 pan+zoom：ref、DOM transform、React 镜像同帧，避免新 pan+旧 zoom。 */
  const applyTransform = useCallback((x: number, y: number, zoom: number) => {
    const safeZoom = Math.max(1, Math.min(300, zoom));
    panRef.current = { x, y };
    panoramaZoomRef.current = safeZoom;
    const stage = worldStageRef.current;
    if (stage) stage.style.transform = "translate(" + x + "px," + y + "px) scale(" + (safeZoom / 100) + ")";
    setPanVersion(value => value + 1);
    setPanoramaZoom(safeZoom);
  }, []);
  const applyPan = useCallback((x: number, y: number) => {
    applyTransform(x, y, panoramaZoomRef.current);
  }, [applyTransform]);
  /** 在视口真正测量出有效尺寸、算出正确的居中 pan 之前，画布先不渲染；
   * 避免用初始的 pan={0,0}/zoom=100% 错误地渲染出第一帧（内容可能落在视口外）。 */
  const [viewportReady, setViewportReady] = useState(false);
  /** 整个组件生命周期只在真正第一次测量到视口尺寸时居中一次；
   * 之后切换 wallView 或扩容都不应该把用户已经平移/缩放到的视角弹飞。 */
  const hasCenteredRef = useRef(false);
  /** 世界尺寸来自持久化状态：扩容后照片比例不变，只换分母。 */
  const world = wallWorldOf(state);
  const [wallCanvasMode, setWallCanvasMode] = useState<"view" | "move" | "doodle">("view");
  const [wallBrushColor, setWallBrushColor] = useState("#c2705a");
  const [wallColorDraft, setWallColorDraft] = useState("#c2705a");
  const [wallBrushPalette, setWallBrushPalette] = useState<string[]>(() => {
    try {
      const saved = typeof window !== "undefined" ? JSON.parse(window.localStorage.getItem("photo_wall_brush_palette_v1") || "[]") : [];
      return Array.isArray(saved) ? Array.from(new Set([...DEFAULT_WALL_BRUSH_PALETTE, ...saved.filter((value): value is string => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value))])).slice(0, 20) : DEFAULT_WALL_BRUSH_PALETTE;
    } catch { return DEFAULT_WALL_BRUSH_PALETTE; }
  });
  const [wallBrushWidth, setWallBrushWidth] = useState(3);
  const [wallStickerSize, setWallStickerSize] = useState(36);
  const [wallSizeDraft, setWallSizeDraft] = useState("36");
  const [wallSticker, setWallSticker] = useState<string | null>(null);
  // Brush thickness and sticker size are independent world-space values.
  useEffect(() => { setWallSizeDraft(String(wallSticker ? wallStickerSize : wallBrushWidth)); }, [wallSticker, wallBrushWidth, wallStickerSize]);
  const [wallStickerRotation, setWallStickerRotation] = useState(0);
  const [wallEraser, setWallEraser] = useState(false);
  const [wallWidthDraft, setWallWidthDraft] = useState(String(world.width));
  const [wallHeightDraft, setWallHeightDraft] = useState(String(world.height));
  useEffect(() => {
    try { window.localStorage.setItem("photo_wall_brush_palette_v1", JSON.stringify(wallBrushPalette)); } catch { /* optional palette persistence */ }
  }, [wallBrushPalette]);
  /**
   * 缩放锚点公式：anchor 是「手指/鼠标在 viewport 里的屏幕坐标」，要求缩放前后
   * anchor 对应的世界坐标点在屏幕上的位置不变。
   *   worldX = (anchorX - pan.x) / zoom   // 缩放前，anchor 对应的世界坐标（像素）
   *   newPanX = anchorX - worldX * newZoom // 反解新的 pan，使同一个世界点仍落在 anchorX
   * pan 和 zoom 在同一次调用里一起算出来、一起写入，不再分两条路径（一条同步改 scroll，
   * 一条等 layout effect 才改 scroll）错序更新，这是之前锚点漂移、缩放和双指平移打架的根源。
   */
  const applyZoom = useCallback((nextZoom: number, anchor?: { x: number; y: number }) => {
    const clamped = Math.max(panoramaMinZoomRef.current, Math.min(300, Math.round(nextZoom)));
    const previous = panoramaZoomRef.current;
    const viewport = panoramaViewportRef.current;
    if (!previous || previous === clamped) { applyTransform(panRef.current.x, panRef.current.y, clamped); return; }
    if (viewport) {
      // Anchor coordinates are viewport-local layout pixels, never rect pixels.
      // getBoundingClientRect includes the phone-shell compatibility transform.
      const anchorX = anchor?.x ?? viewport.clientWidth / 2;
      const anchorY = anchor?.y ?? viewport.clientHeight / 2;
      const pan = panRef.current;
      const worldX = (anchorX - pan.x) / (previous / 100);
      const worldY = (anchorY - pan.y) / (previous / 100);
      applyTransform(anchorX - worldX * (clamped / 100), anchorY - worldY * (clamped / 100), clamped);
    } else {
      applyTransform(panRef.current.x, panRef.current.y, clamped);
    }
  }, [applyTransform]);
  const [wallBackgroundUrl, setWallBackgroundUrl] = useState("");
  const wallBackgroundInputRef = useRef<HTMLInputElement>(null);
  // 每次进入全景/编辑时都按真实可用视口重新适配；画布比例与导出一致。
  // ResizeObserver 处理手机 WebView 首帧尺寸为 0 或地址栏收缩导致的空白。
  useEffect(() => {
    if (wallView !== "edit" && wallView !== "panorama") return;
    const viewport = panoramaViewportRef.current;
    if (!viewport) return;
    const fitCanvas = () => {
      if (pinchModeRef.current) return;
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (!width || !height) return;
      const fit = Math.min(width / Math.max(1, world.width), height / Math.max(1, world.height)) * 100;
      const fittedZoom = Math.max(5, Math.min(180, Math.floor(fit)));
      panoramaMinZoomRef.current = fittedZoom;
      if (!hasCenteredRef.current) {
        hasCenteredRef.current = true;
        panoramaZoomRef.current = fittedZoom;
        setPanoramaZoom(fittedZoom);
        // 只在整个组件生命周期里真正第一次测量到视口时居中一次，等价于旧版 margin:0 auto 的默认效果；
        // 之后切 tab 或扩容重新触发这个 effect 都不会再把用户已经平移/缩放好的视角弹飞。
        const scale = fittedZoom / 100;
        applyPan((width - world.width * scale) / 2, (height - world.height * scale) / 2);
        setViewportReady(true);
      } else if (panoramaZoomRef.current < fittedZoom) {
        // If the viewport becomes smaller (rotation, shell resize, browser chrome), raise the
        // minimum zoom while keeping the world point under the viewport center anchored.
        // Updating zoom alone leaves pan in the old coordinate scale and can crop the wall.
        applyZoom(fittedZoom);
      }
    };
    fitCanvas();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fitCanvas) : null;
    observer?.observe(viewport);
    window.addEventListener("resize", fitCanvas);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", fitCanvas);
    };
  }, [wallView, world.width, world.height, applyPan, applyZoom]);
  useEffect(() => {
    if (wallView !== "edit" && wallView !== "panorama") return;
    const viewport = panoramaViewportRef.current;
    if (!viewport) return;
    const touchDistance = (touches: TouchList) => Math.max(1, Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY));
    const pointsDistance = (points: { x: number; y: number }[]) => Math.max(1, Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y));
    const supportsPointerEvents = typeof window !== "undefined" && "PointerEvent" in window;
    /**
     * 手机壳的兼容性缩放（--compat-layout-scale）作用在整个 .phone-shell-wrap 上，
     * 使 client 坐标 = 布局坐标 × k。pan/zoom 状态是布局像素，而事件的 clientX/Y 是
     * 屏幕像素；k≠1 的设备（UI 缩放 75–125% / 手动屏幕适配）必须先除回 k，否则
     * 双指缩放锚点、单指平移速度都会按比例漂移。getBoundingClientRect 与 clientWidth
     * 同源相除即可得到当前真实 k（默认 1，成本可忽略）。
     */
    const shellScale = () => {
      const rect = viewport.getBoundingClientRect();
      return {
        x: rect.width > 0 && viewport.clientWidth > 0 ? rect.width / viewport.clientWidth : 1,
        y: rect.height > 0 && viewport.clientHeight > 0 ? rect.height / viewport.clientHeight : 1,
      };
    };
    /** 单指平移：只有「浏览模式 + 落点是空白画布」才启动，摆照片/涂鸦/翻面都要原样把单指交给画布自己处理。 */
    const singlePanEligible = (clientX: number, clientY: number) => {
      if (wallCanvasMode !== "view") return false;
      const photoUnderFinger = Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-photo-wall-photo-id]")
      ).some(element => {
        const rect = element.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
      });
      return !photoUnderFinger;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !(event.target instanceof Node) || !viewport.contains(event.target)) return;
      const firstPointer = pinchPointersRef.current.size === 0;
      pinchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (firstPointer) {
        singleTouchRef.current = {
          x: event.clientX, y: event.clientY,
          startedOnPhoto: !singlePanEligible(event.clientX, event.clientY), panStarted: false,
        };
      }
      if (pinchPointersRef.current.size < 2) return;
      const points = [...pinchPointersRef.current.values()].slice(0, 2);
      const actual = readStageTransform();
      panRef.current = { x: actual.x, y: actual.y };
      panoramaZoomRef.current = actual.zoom;
      pinchStartRef.current = { distance: pointsDistance(points), zoom: actual.zoom };
      pinchLastMidpointRef.current = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      pinchModeRef.current = true; singleTouchRef.current = null;
      window.dispatchEvent(new Event("photo-wall-pinch-start"));
      if (event.cancelable) event.preventDefault(); event.stopPropagation();
    };
    const onPointerMove = (event: PointerEvent) => {
      const pointers = pinchPointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2 && pinchModeRef.current && pinchStartRef.current) {
        if (event.cancelable) event.preventDefault(); event.stopPropagation();
        const points = [...pointers.values()].slice(0, 2), rect = viewport.getBoundingClientRect();
        const midpoint = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
        const previousMidpoint = pinchLastMidpointRef.current ?? midpoint;
        pinchLastMidpointRef.current = midpoint;
        // 用「上一帧中点下的世界坐标」直接反算本帧 pan + zoom，
        // 一次性写入两者，避免先平移再缩放时 React/WebView 布局时序造成落点漂移。
        const pan = panRef.current;
        const previousZoom = Math.max(0.01, panoramaZoomRef.current / 100);
        const nextZoomValue = Math.max(panoramaMinZoomRef.current, Math.min(300, Math.round(
          pinchStartRef.current.zoom * pointsDistance(points) / Math.max(1, pinchStartRef.current.distance),
        )));
        const nextScale = nextZoomValue / 100;
        const anchorScale = shellScale();
        const previousLocalX = (previousMidpoint.x - rect.left) / anchorScale.x;
        const previousLocalY = (previousMidpoint.y - rect.top) / anchorScale.y;
        const currentLocalX = (midpoint.x - rect.left) / anchorScale.x;
        const currentLocalY = (midpoint.y - rect.top) / anchorScale.y;
        const worldX = (previousLocalX - pan.x) / previousZoom;
        const worldY = (previousLocalY - pan.y) / previousZoom;
        applyTransform(currentLocalX - worldX * nextScale, currentLocalY - worldY * nextScale, nextZoomValue);
        return;
      }
      // 单指：只有「浏览模式 + 起点是空白画布」才走自定义平移；摆照片/涂鸦/翻面继续交给画布自身的指针逻辑。
      if (pointers.size === 1 && !pinchModeRef.current) {
        const touch = singleTouchRef.current;
        if (!touch || touch.startedOnPhoto) return;
        if (event.cancelable) event.preventDefault();
        if (!touch.panStarted) {
          touch.panStarted = true;
          window.dispatchEvent(new Event("photo-wall-pan-start"));
        }
        const dx = event.clientX - touch.x, dy = event.clientY - touch.y;
        touch.x = event.clientX; touch.y = event.clientY;
        const pan = panRef.current;
        const anchorScale = shellScale();
        applyPan(pan.x + dx / anchorScale.x, pan.y + dy / anchorScale.y);
      }
    };
    const onPointerEnd = (event: PointerEvent) => {
      const pointers = pinchPointersRef.current;
      if (!pointers.has(event.pointerId)) return;
      const wasPinching = pinchModeRef.current, wasPanning = singleTouchRef.current?.panStarted === true;
      pointers.delete(event.pointerId);
      // Keep the multi-touch lock until every finger is lifted. The remaining finger
      // must not unexpectedly resume drawing or dragging after a pinch ends.
      if (pointers.size === 0) {
        if (wasPinching) window.dispatchEvent(new Event("photo-wall-pinch-end"));
        if (wasPanning) window.dispatchEvent(new Event("photo-wall-pan-end"));
        pinchModeRef.current = false; pinchStartRef.current = null; pinchLastMidpointRef.current = null;
        singleTouchRef.current = null;
      }
    };

    const onTouchStart = (event: TouchEvent) => {
      if (supportsPointerEvents) return;
      if (event.touches.length >= 2) {
        if (!pinchModeRef.current) {
          const actual = readStageTransform();
          panRef.current = { x: actual.x, y: actual.y };
          panoramaZoomRef.current = actual.zoom;
          pinchStartRef.current = { distance: touchDistance(event.touches), zoom: actual.zoom };
          pinchModeRef.current = true;
          pinchLastMidpointRef.current = { x: (event.touches[0].clientX + event.touches[1].clientX) / 2, y: (event.touches[0].clientY + event.touches[1].clientY) / 2 };
          window.dispatchEvent(new Event("photo-wall-pinch-start"));
        }
        singleTouchRef.current = null;
        if (event.cancelable) event.preventDefault();
        return;
      }
      if (event.touches.length === 1) {
        singleTouchRef.current = {
          x: event.touches[0].clientX, y: event.touches[0].clientY,
          startedOnPhoto: !singlePanEligible(event.touches[0].clientX, event.touches[0].clientY), panStarted: false,
        };
      }
    };
    const onTouchMove = (event: TouchEvent) => {
      if (supportsPointerEvents) return;
      if (event.touches.length >= 2) {
        if (event.cancelable) event.preventDefault();
        if (!pinchStartRef.current) pinchStartRef.current = { distance: touchDistance(event.touches), zoom: panoramaZoomRef.current };
        if (!pinchModeRef.current) {
          pinchModeRef.current = true;
          window.dispatchEvent(new Event("photo-wall-pinch-start"));
        }
        const midpoint = {
          x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
          y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
        };
        const previousMidpoint = pinchLastMidpointRef.current ?? midpoint;
        pinchLastMidpointRef.current = midpoint;
        const pan = panRef.current;
        const rect = viewport.getBoundingClientRect();
        const previousZoom = Math.max(0.01, panoramaZoomRef.current / 100);
        const nextZoomValue = Math.max(panoramaMinZoomRef.current, Math.min(300, Math.round(
          pinchStartRef.current.zoom * touchDistance(event.touches) / Math.max(1, pinchStartRef.current.distance),
        )));
        const nextScale = nextZoomValue / 100;
        const anchorScale = shellScale();
        const previousLocalX = (previousMidpoint.x - rect.left) / anchorScale.x;
        const previousLocalY = (previousMidpoint.y - rect.top) / anchorScale.y;
        const currentLocalX = (midpoint.x - rect.left) / anchorScale.x;
        const currentLocalY = (midpoint.y - rect.top) / anchorScale.y;
        const worldX = (previousLocalX - pan.x) / previousZoom;
        const worldY = (previousLocalY - pan.y) / previousZoom;
        applyTransform(currentLocalX - worldX * nextScale, currentLocalY - worldY * nextScale, nextZoomValue);
        return;
      }
      if (event.touches.length === 1) {
        const touch = singleTouchRef.current;
        if (!touch || touch.startedOnPhoto || pinchModeRef.current) return;
        if (event.cancelable) event.preventDefault();
        if (!touch.panStarted) {
          touch.panStarted = true;
          window.dispatchEvent(new Event("photo-wall-pan-start"));
        }
        const dx = event.touches[0].clientX - touch.x, dy = event.touches[0].clientY - touch.y;
        touch.x = event.touches[0].clientX; touch.y = event.touches[0].clientY;
        const pan = panRef.current;
        const anchorScale = shellScale();
        applyPan(pan.x + dx / anchorScale.x, pan.y + dy / anchorScale.y);
      }
    };
    const onTouchEnd = (event: TouchEvent) => {
      if (supportsPointerEvents) return;
      // 双指手势期间只要还有手指留在屏幕上，就保持锁定，绝不把剩余手指
      // 重新解释成画笔/照片拖动。
      if (event.touches.length === 0) {
        if (pinchModeRef.current) window.dispatchEvent(new Event("photo-wall-pinch-end"));
        if (singleTouchRef.current?.panStarted) window.dispatchEvent(new Event("photo-wall-pan-end"));
        pinchModeRef.current = false; pinchStartRef.current = null; pinchLastMidpointRef.current = null;
        singleTouchRef.current = null;
      }
    };
    // Window capture keeps tracking both fingers even if one leaves a photo frame.
    window.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", onPointerEnd, true);
    window.addEventListener("pointercancel", onPointerEnd, true);
    if (!supportsPointerEvents) {
      viewport.addEventListener("touchstart", onTouchStart, { passive: false, capture: true });
      viewport.addEventListener("touchmove", onTouchMove, { passive: false, capture: true });
      viewport.addEventListener("touchend", onTouchEnd, { passive: false, capture: true });
      viewport.addEventListener("touchcancel", onTouchEnd, { passive: false, capture: true });
    }
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
      pinchPointersRef.current.clear(); pinchStartRef.current = null; pinchLastMidpointRef.current = null; pinchModeRef.current = false; singleTouchRef.current = null;
      if (!supportsPointerEvents) {
        viewport.removeEventListener("touchstart", onTouchStart, true);
        viewport.removeEventListener("touchmove", onTouchMove, true);
        viewport.removeEventListener("touchend", onTouchEnd, true);
        viewport.removeEventListener("touchcancel", onTouchEnd, true);
      }
    };
  }, [wallView, wallCanvasMode, state.photos.length, filter, applyZoom, applyPan]);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string>(() => readPhotoWallCharacter());
  const [groupReferenceCharacterIds, setGroupReferenceCharacterIds] = useState<string[]>(() => readPhotoWallGroupReferences());
  const [selectedPhotoId, setSelectedPhotoId] = useState<string | null>(null); // Modal editor only
  const [wallActivePhotoId, setWallActivePhotoId] = useState<string | null>(null); // Canvas selection only
  const wallSelectedPhoto = state.photos.find(photo => photo.id === wallActivePhotoId) ?? null;
  const [albums, setAlbums] = useState<PhotoAlbum[]>(() => loadPhotoAlbums());
  const [activeAlbumId, setActiveAlbumId] = useState<string | null>(null);
  const [activeAlbumPage, setActiveAlbumPage] = useState(0);
  const [albumEditMode, setAlbumEditMode] = useState(false);
  const activeAlbum = albums.find(album => album.id === activeAlbumId) ?? null;
  useEffect(() => {
    try { window.localStorage.setItem(PHOTO_ALBUMS_KEY, JSON.stringify(albums)); } catch { /* Album metadata is optional. */ }
  }, [albums]);
  useEffect(() => {
    const backgroundRef = state.wallBackgroundRef;
    if (backgroundRef) void retainMediaRef(backgroundRef, "photo-wall-background").catch(error => console.warn("[照片墙] 背景引用保护失败", error));
  }, [state.wallBackgroundRef]);

  useEffect(() => {
    let active = true;
    let loadedUrl = "";
    const backgroundRef = state.wallBackgroundRef;
    if (!backgroundRef) { setWallBackgroundUrl(""); return; }
    void loadMediaObjectUrl(backgroundRef).then(url => {
      if (!active) { if (url) URL.revokeObjectURL(url); return; }
      loadedUrl = url || "";
      setWallBackgroundUrl(loadedUrl);
    }).catch(() => { if (active) setWallBackgroundUrl(""); });
    return () => { active = false; if (loadedUrl) URL.revokeObjectURL(loadedUrl); };
  }, [state.wallBackgroundRef]);
  const [timelineFlippedPhotoIds, setTimelineFlippedPhotoIds] = useState<Set<string>>(new Set());
  const [photoViewOnly, setPhotoViewOnly] = useState(false);
  const [editNote, setEditNote] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editTags, setEditTags] = useState("");
  const [editCapturedAt, setEditCapturedAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [newKind, setNewKind] = useState<PhotoWallPhoto["kind"]>("favorite");
  const [referencePhotoId, setReferencePhotoId] = useState("");
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showChatPicker, setShowChatPicker] = useState(false);
  const [chatCandidates, setChatCandidates] = useState<Array<{ key: string; ref: string; title: string; sessionName: string; createdAt: string }>>([]);
  const [characterCommenterId, setCharacterCommenterId] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const autoRunRef = useRef(false);

  // 拖动照片时每帧都写 localStorage 会明显卡手，这里把落盘延后合并。
  const saveTimerRef = useRef<number | null>(null);
  // 拖动是高频回调，且 setState 的更新函数必须是纯函数（StrictMode 会执行两次），
  // 所以不能把写盘副作用塞进更新函数里。用 ref 保存最新状态快照供回调同步读取。
  const stateRef = useRef(state);
  stateRef.current = state;
  const [activeTemplateId, setActiveTemplateId] = useState<string>(() => readPhotoWallTemplate());
  const [templateFill, setTemplateFill] = useState<boolean>(() => loadTemplateFill());
  const [generationPromptTemplate, setGenerationPromptTemplate] = useState<string>(() => readPhotoWallPrompt());
  const [templateName, setTemplateName] = useState("");
  const [customTemplates, setCustomTemplates] = useState<PhotoWallTemplate[]>(() => loadCustomTemplates());
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  useEffect(() => {
    const handleAppBack = (event: Event) => {
      const detail = (event as CustomEvent<{ handled?: boolean }>).detail;
      if (showAddMenu) { setShowAddMenu(false); if (detail) detail.handled = true; return; }
      if (showChatPicker) { setShowChatPicker(false); if (detail) detail.handled = true; return; }
      if (selectedPhotoId) { setSelectedPhotoId(null); if (detail) detail.handled = true; return; }
      if (wallView === "album" && activeAlbumId) { setActiveAlbumId(null); if (detail) detail.handled = true; return; }
      if (wallView === "settings" || wallView === "timeline" || wallView === "memories" || wallView === "album" || wallView === "creations") { setWallView(wallView === "settings" ? settingsReturnView : "panorama"); if (detail) detail.handled = true; return; }
      if (wallView === "edit") { onClose(); if (detail) detail.handled = true; }
    };
    window.addEventListener("floatphone-app-back", handleAppBack);
    return () => window.removeEventListener("floatphone-app-back", handleAppBack);
  }, [wallView, showAddMenu, showChatPicker, selectedPhotoId, settingsReturnView, activeAlbumId]);

  const scheduleSave = useCallback((_next: PhotoWallState) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      savePhotoWallState(stateRef.current);
      saveTimerRef.current = null;
    }, 200);
  }, []);

  // 关闭照片墙、切到后台或页面进入 pagehide 时，立即冲刷防抖保存。
  // 移动端后台计时器可能被挂起，不能只依赖 200ms timeout。
  useEffect(() => {
    const flushPendingSave = () => {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      savePhotoWallState(stateRef.current);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flushPendingSave();
    };
    window.addEventListener("pagehide", flushPendingSave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", flushPendingSave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      flushPendingSave();
    };
  }, []);

  /** 统一落盘入口：先更新状态快照与 React 状态，再合并写盘。 */
  const commitPhotos = useCallback((nextPhotos: PhotoWallPhoto[]) => {
    const next: PhotoWallState = { ...stateRef.current, photos: nextPhotos };
    stateRef.current = next;
    setState(next);
    scheduleSave(next);
  }, [scheduleSave]);

  /** 结构性变更（扩画布）要立刻落盘，不能等防抖——否则一滚回去就又是旧世界。 */
  const applyImmediate = useCallback((next: PhotoWallState) => {
    stateRef.current = next;
    setState(next);
    savePhotoWallState(next);
  }, []);

  /* ── 撤销 / 重做 ──────────────────────────────────────────────
     只存引用快照：照片对象是不可变的，整墙涂鸦也是数组替换，
     所以一份快照几乎不占内存，不需要深拷贝，也不会复制媒体数据。 */
  type WallSnapshot = { photos: PhotoWallPhoto[]; wallDoodles?: PhotoWallDoodle[]; world: PhotoWallWorld };
  const historyRef = useRef<WallSnapshot[]>([]);
  const futureRef = useRef<WallSnapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);
  const snapshotOf = useCallback((source: PhotoWallState): WallSnapshot => ({
    photos: source.photos,
    wallDoodles: source.wallDoodles,
    world: wallWorldOf(source),
  }), []);
  const pushHistory = useCallback((source: PhotoWallState) => {
    historyRef.current.push(snapshotOf(source));
    if (historyRef.current.length > 80) historyRef.current.shift();
    futureRef.current = [];
    setHistoryVersion(value => value + 1);
  }, [snapshotOf]);
  const undo = useCallback(() => {
    const previous = historyRef.current.pop();
    if (!previous) return;
    const current = stateRef.current;
    futureRef.current.push(snapshotOf(current));
    applyImmediate({ ...current, photos: previous.photos, wallDoodles: previous.wallDoodles, world: previous.world });
    setHistoryVersion(value => value + 1);
  }, [applyImmediate, snapshotOf]);
  const redo = useCallback(() => {
    const next = futureRef.current.pop();
    if (!next) return;
    const current = stateRef.current;
    historyRef.current.push(snapshotOf(current));
    applyImmediate({ ...current, photos: next.photos, wallDoodles: next.wallDoodles, world: next.world });
    setHistoryVersion(value => value + 1);
  }, [applyImmediate, snapshotOf]);
  const canUndo = historyRef.current.length > 0;
  const canRedo = futureRef.current.length > 0;
  void historyVersion; // 快照栈变化时触发一次重渲染，好让按钮的禁用态跟上

  /**
   * 拖动/缩放/旋转：只改这一张照片的摆放，位置用 0~1 比例存，换屏幕不会错位。
   * 注意这里**不扩容**——拖动中途改世界尺寸会让画布的拖拽基准失效，照片会跳。
   */
  const changePlacement = useCallback((photoId: string, placement: PhotoWallPlacement) => {
    commitPhotos(stateRef.current.photos.map(photo => photo.id === photoId ? { ...photo, placement } : photo));
  }, [commitPhotos]);

  /**
   * 松手后判一次扩容：落点贴到世界外圈就往那一侧扩。
   * 扩容把所有比例按像素重算 + 补偿滚动，所以照片和涂鸦在屏幕上不动，
   * 只是可滚动范围变大——「无限画布」就是这一步攒出来的。
   */
  const settlePlacement = useCallback((photoId: string, placement: PhotoWallPlacement) => {
    // 世界扩容会把照片/涂鸦重映射，但背景图盒子目前没有偏移量，扩容后
    // 背景和照片会分离。先停止自动扩容，保证画布与照片/涂鸦始终同坐标。
    commitPhotos(stateRef.current.photos.map(photo => photo.id === photoId ? { ...photo, placement } : photo));
  }, [commitPhotos]);

  /** 相框涂鸦即时保存画面；同一段涂鸦模式内的笔迹合并成一份创作记录。 */
  const doodleSessionRecordIdRef = useRef<string | null>(null);
  const handleWallCanvasModeChange = useCallback((nextMode: "view" | "move" | "doodle") => {
    if (nextMode === wallCanvasMode) return;
    if (wallCanvasMode === "doodle" && nextMode !== "doodle") {
      // The creation record itself is projected into the shared-events timeline.
      doodleSessionRecordIdRef.current = null;
    }
    if (nextMode === "doodle") doodleSessionRecordIdRef.current = null;
    setWallCanvasMode(nextMode);
  }, [wallCanvasMode]);
  const changeDoodles = useCallback((photoId: string, doodles: PhotoWallDoodle[], side: "front" | "back" = "front") => {
    const current = stateRef.current;
    const photo = current.photos.find(item => item.id === photoId);
    const existing = side === "back" ? (photo?.backDoodles ?? []) : (photo?.doodles ?? []);
    const existingIds = new Set(existing.map(item => item.id));
    const added = doodles.filter(item => !existingIds.has(item.id));
    const addedByUser = added.filter(item => item.authorType === "user");
    pushHistory(current);
    commitPhotos(current.photos.map(item => item.id === photoId
      ? side === "back" ? { ...item, backDoodles: doodles } : { ...item, doodles }
      : item));
    if (addedByUser.length) {
      const latest = stateRef.current;
      const recordId = wallCanvasMode === "doodle" ? doodleSessionRecordIdRef.current : null;
      const previous = recordId ? (latest.creationRecords ?? []).find(item => item.id === recordId) : undefined;
      if (previous) {
        applyImmediate({ ...latest, creationRecords: (latest.creationRecords ?? []).map(item => {
          if (item.id !== recordId) return item;
          const layers = item.layers ?? [];
          const layerIndex = layers.findIndex(layer => layer.kind === "photo" && layer.photoId === photoId && layer.side === side);
          const nextLayers = layerIndex >= 0
            ? layers.map((layer, index) => index === layerIndex && layer.kind === "photo" ? { ...layer, doodles: [...layer.doodles, ...addedByUser] } : layer)
            : [...layers, { kind: "photo" as const, photoId, side, doodles: addedByUser }];
          return { ...item, photoIds: [...new Set([...item.photoIds, photoId])], layers: nextLayers,
            doodles: [...item.doodles, ...addedByUser],
            narrative: `我在照片墙涂鸦模式里留下了${item.doodles.length + addedByUser.length}笔心意。` };
        }) });
      } else {
        const record: PhotoWallCreationRecord = {
          id: createPhotoWallId(), createdAt: new Date().toISOString(), authorType: "user",
          authorName: "我", narrative: wallCanvasMode === "doodle"
            ? `我在照片墙涂鸦模式里留下了${addedByUser.length}笔心意。`
            : `我在「${photo?.title || "这张照片"}」的${side === "back" ? "背面留言纸" : "正面相框"}上留下了${addedByUser.length}笔涂鸦。`,
          photoIds: [photoId], layers: [{ kind: "photo", photoId, side, doodles: addedByUser }], doodles: addedByUser,
        };
        if (wallCanvasMode === "doodle") doodleSessionRecordIdRef.current = record.id;
        applyImmediate({ ...latest, creationRecords: [...(latest.creationRecords ?? []), record] });
      }
    }
    // The completed creation record is the canonical shared event. Avoid one timeline
    // entry per stroke; a doodle session is summarized when the user exits doodle mode.
  }, [applyImmediate, commitPhotos, pushHistory, wallCanvasMode]);

  /** 套用模板骨架：照片按顺序吸附进槽位，套完仍然可以自由拖动。 */
  const applyTemplate = useCallback((templateId: string) => {
    const current = stateRef.current;
    const ordered = current.photos.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!ordered.length) { onNotice?.("墙上还没有照片。"); return; }
    // 锁定照片是固定锚点：不参与模板重排，位置/大小/旋转/层级全部保持。
    const editable = ordered.filter(photo => !photo.placement?.locked);
    if (!editable.length) { onNotice?.("所有照片都已锁定，没有可套用模板的照片。"); return; }
    const slots = buildTemplateSlots(templateId, editable.length, undefined, templateFill);
    if (!slots.length) return;
    pushHistory(current);
    const slotById = new Map(editable.map((photo, index) => [photo.id, { slot: slots[index], z: index + 1 }]));
    commitPhotos(current.photos.map(photo => {
      if (photo.placement?.locked) return photo;
      const arrangement = slotById.get(photo.id);
      if (!arrangement?.slot) return photo;
      const base = photo.placement;
      return { ...photo, placement: { ...arrangement.slot, z: arrangement.z, frame: base?.frame ?? "polaroid", locked: base?.locked ?? false, frameColor: base?.frameColor ?? "#fffdf8" } as PhotoWallPlacement };
    }));
    setActiveTemplateId(templateId);
    try { window.localStorage.setItem(PHOTO_WALL_ACTIVE_TEMPLATE_KEY, templateId); } catch { /* current placements remain saved */ }
    onNotice?.("已按模板重新摆放；新照片也会沿用这个摆放轨迹。");
    // 不要在这里强制切到 edit：全景/编辑的视口高度不同，会让画布看起来突然变尺寸。
  }, [commitPhotos, onNotice, pushHistory, templateFill]);

  /** 将当前墙面坐标保存为可重复使用的自定义模板。 */
  const saveCurrentLayoutAsTemplate = useCallback(() => {
    const current = stateRef.current;
    if (!current.photos.length) { onNotice?.("先放入几张照片，再保存摆放模板。"); return; }
    const name = templateName.trim();
    if (!name) { onNotice?.("请先给这个模板起个名字。"); return; }
    const ordered = current.photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0));
    const slots = ordered.map((photo, index) => {
      const placement = photo.placement ?? fallbackPlacement(index);
      return { x: placement.x, y: placement.y, scale: placement.scale, rotation: placement.rotation };
    });
    const template: PhotoWallTemplate = { id: createPhotoWallId(), name: name.slice(0, 32), builtin: false, slots };
    const next = [...customTemplates.filter(item => item.id !== template.id), template].slice(-40);
    saveCustomTemplates(next);
    setCustomTemplates(next);
    setTemplateName("");
    onNotice?.("已保存模板「" + template.name + "」，之后可以重复套用。");
  }, [customTemplates, onNotice, templateName]);

  const deleteCustomTemplate = useCallback((templateId: string) => {
    const next = customTemplates.filter(item => item.id !== templateId);
    saveCustomTemplates(next);
    setCustomTemplates(next);
    if (editingTemplateId === templateId) setEditingTemplateId(null);
    onNotice?.("已删除自定义摆放模板。");
  }, [customTemplates, editingTemplateId, onNotice]);

  const updateTemplateSlot = useCallback((templateId: string, slotIndex: number, key: "x" | "y" | "scale" | "rotation", value: number) => {
    if (!Number.isFinite(value)) return;
    const next = customTemplates.map(template => {
      if (template.id !== templateId) return template;
      const slots = template.slots.map((slot, index) => {
        if (index !== slotIndex) return slot;
        const limits = key === "x" || key === "y" ? [0.06, 0.94] : key === "scale" ? [0.35, 3] : [-45, 45];
        const bounded = Math.min(limits[1], Math.max(limits[0], value));
        return { ...slot, [key]: Math.round(bounded * 100) / 100 };
      });
      return { ...template, slots };
    });
    setCustomTemplates(next);
    saveCustomTemplates(next);
  }, [customTemplates]);

  /** 整墙导出 PNG：canvas 重绘，不受滚动位置和屏幕尺寸影响。 */
  const exportWall = async () => {
    if (exportBusy) return;
    const targets = photos;
    if (!targets.length) { onNotice?.("墙上还没有照片可以导出。"); return; }
    setExportBusy(true);
    try {
      const ok = await downloadPhotoWallPng(targets, {
        aspect: world.width / world.height, world,
        wallDoodles: stateRef.current.wallDoodles ?? [],
        backgroundRef: stateRef.current.wallBackgroundRef,
        backgroundBox: stateRef.current.wallBackgroundBox,
      });
      onNotice?.(ok ? "已开始下载整墙 PNG。" : "导出失败：没有生成有效图片。");
    } catch (error) { onNotice?.("导出失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setExportBusy(false); }
  };

  const persist = useCallback((input: PhotoWallState) => {
    // 所有新照片和背面留言都必须形成可回溯的公共墙事件；模板布局分支也不能漏记。
    const previous = stateRef.current;
    let next = input;
    const linkedPhotoIds = new Set((next.creationRecords ?? []).flatMap(record => record.photoIds));
    const newlyAddedPhotos = next.photos.filter(photo =>
      !previous.photos.some(item => item.id === photo.id) && !linkedPhotoIds.has(photo.id)
    );
    const changedNotes = next.photos.filter(photo => {
      const old = previous.photos.find(item => item.id === photo.id);
      return Boolean(old && old.backNote !== photo.backNote);
    });
    const generatedRecords: PhotoWallCreationRecord[] = [];
    if (newlyAddedPhotos.length) {
      const createdAt = new Date().toISOString();
      const names = newlyAddedPhotos.slice(0, 8).map(photo => photo.title || "未命名照片");
      generatedRecords.push({
        id: createPhotoWallId(), createdAt,
        authorType: newlyAddedPhotos.every(photo => photo.ownerType === "character") ? "character" : "user",
        authorId: newlyAddedPhotos.length === 1 ? newlyAddedPhotos[0].ownerId : undefined,
        authorName: newlyAddedPhotos.length === 1 ? newlyAddedPhotos[0].ownerName : "共同创作参与者",
        narrative: "有 " + newlyAddedPhotos.length + " 张新照片加入公共照片墙：" + names.join("、"),
        photoIds: newlyAddedPhotos.map(photo => photo.id), layers: [], doodles: [],
      });
    }
    for (const photo of changedNotes) {
      generatedRecords.push({
        id: createPhotoWallId(), createdAt: new Date().toISOString(),
        authorType: photo.ownerType, authorId: photo.ownerId, authorName: photo.ownerName,
        narrative: photo.ownerName + "更新了公共照片墙中「" + (photo.title || "一张照片") + "」背面的留言：" + photo.backNote.slice(0, 240),
        photoIds: [photo.id], layers: [], doodles: [],
      });
    }
    if (generatedRecords.length) {
      next = { ...next, creationRecords: [...(next.creationRecords ?? []), ...generatedRecords] };
    }
    // 必须同步快照：commitPhotos 依赖 stateRef 读最新状态，
    // 否则上传/保存背面后紧接着拖动会用旧快照把新照片覆盖掉。
    stateRef.current = next;
    setState(next);
    savePhotoWallState(next);
  }, []);
  const refreshCharacters = useCallback(() => {
    const list = loadCharacters();
    setCharacters(list);
    setSelectedCharacterId(current => list.some(char => char.id === current) ? current : list[0]?.id ?? "");
    setCharacterCommenterId(current => list.some(char => char.id === current) ? current : list[0]?.id ?? "");
  }, []);
  useEffect(() => {
    refreshCharacters();
    const refresh = () => {
      const next = loadPhotoWallState();
      stateRef.current = next;
      setState(next);
    };
    window.addEventListener("photo-wall-updated", refresh);
    window.addEventListener("characters-updated", refreshCharacters);
    return () => { window.removeEventListener("photo-wall-updated", refresh); window.removeEventListener("characters-updated", refreshCharacters); };
  }, [refreshCharacters]);

  const photos = useMemo(() => state.photos.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [state.photos]);
  const timelinePhotos = useMemo(() => {
    const start = timelineStartDate ? new Date(timelineStartDate + "T00:00:00").getTime() : Number.NEGATIVE_INFINITY;
    const end = timelineEndDate ? new Date(timelineEndDate + "T23:59:59.999").getTime() : Number.POSITIVE_INFINITY;
    return photos.filter(photo => {
      const captureTime = photo.capturedAt ? new Date(photo.capturedAt).getTime() : Number.NaN;
      // Unknown capture dates stay visible with no filter, but can never be matched using upload time.
      if (!Number.isFinite(captureTime)) return !timelineStartDate && !timelineEndDate;
      return captureTime >= start && captureTime <= end;
    }).sort((a, b) => {
      const aTime = a.capturedAt ? new Date(a.capturedAt).getTime() : Number.NaN;
      const bTime = b.capturedAt ? new Date(b.capturedAt).getTime() : Number.NaN;
      if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : b.createdAt.localeCompare(a.createdAt);
      if (!Number.isFinite(bTime)) return -1;
      return bTime - aTime;
    });
  }, [photos, timelineStartDate, timelineEndDate]);

  const timelineGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; items: PhotoWallPhoto[] }>();
    if (timelineGrouping === "photo") return timelinePhotos.map(photo => ({
      key: "photo:" + photo.id,
      label: photo.capturedAt ? formatDate(photo.capturedAt) : "拍摄时间未记录 · " + (photo.title || "未命名照片"),
      items: [photo],
    }));
    const localKey = (date: Date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
    for (const photo of timelinePhotos) {
      const date = photo.capturedAt ? new Date(photo.capturedAt) : null;
      let key = "", label = "";
      if (!date || !Number.isFinite(date.getTime())) {
        key = "capture-time-unknown";
        label = "拍摄时间未记录";
      } else if (timelineGrouping === "day") {
        key = localKey(date);
        label = date.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
      } else if (timelineGrouping === "week") {
        const start = new Date(date); start.setHours(0, 0, 0, 0);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = new Date(start); end.setDate(end.getDate() + 6);
        key = "week:" + localKey(start);
        label = localKey(start) + " — " + localKey(end);
      } else if (timelineGrouping === "year") {
        key = String(date.getFullYear());
        label = key + " 年";
      } else {
        key = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
        label = date.getFullYear() + " 年 " + (date.getMonth() + 1) + " 月";
      }
      const group = groups.get(key) ?? { key, label, items: [] };
      group.items.push(photo);
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [timelinePhotos, timelineGrouping]);
  /**
   * 整墙涂鸦在「一笔画完」时才回调，所以在这里扩容是安全的：
   * 不会边画边改画布，也不会把正在画的那笔截断。
   */
  const changeWallDoodles = useCallback((wallDoodles: PhotoWallDoodle[]) => {
    const current = stateRef.current;
    const existingIds = new Set((current.wallDoodles ?? []).map(item => item.id));
    const addedByUser = wallDoodles.filter(item => !existingIds.has(item.id) && item.authorType === "user");
    pushHistory(current);
    const appendUserRecord = (source: PhotoWallState): PhotoWallState => {
      if (!addedByUser.length) return source;
      const photoIds = new Set<string>();
      for (const doodle of addedByUser) {
        const center = doodle.kind === "sticker"
          ? (doodle.points[0] ?? { x: 0.5, y: 0.5 })
          : doodle.points.reduce((sum, point) => ({ x: sum.x + point.x / doodle.points.length, y: sum.y + point.y / doodle.points.length }), { x: 0, y: 0 });
        const nearest = source.photos.map((photo, index) => {
          const placement = photo.placement ?? fallbackPlacement(index);
          return { id: photo.id, distance: Math.hypot(placement.x - center.x, placement.y - center.y) };
        }).sort((a, b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance <= 0.24) photoIds.add(nearest.id);
      }
      if (!photoIds.size && wallActivePhotoId && source.photos.some(photo => photo.id === wallActivePhotoId)) photoIds.add(wallActivePhotoId);
      const recordId = wallCanvasMode === "doodle" ? doodleSessionRecordIdRef.current : null;
      const previous = recordId ? (source.creationRecords ?? []).find(item => item.id === recordId) : undefined;
      if (previous) return { ...source, creationRecords: (source.creationRecords ?? []).map(item => {
        if (item.id !== recordId) return item;
        const layers = item.layers ?? [];
        const wallIndex = layers.findIndex(layer => layer.kind === "wall");
        const nextLayers = wallIndex >= 0
          ? layers.map((layer, index) => index === wallIndex && layer.kind === "wall" ? { ...layer, doodles: [...layer.doodles, ...addedByUser] } : layer)
          : [...layers, { kind: "wall" as const, doodles: addedByUser }];
        return { ...item, photoIds: [...new Set([...item.photoIds, ...photoIds])], layers: nextLayers, doodles: [...item.doodles, ...addedByUser],
          narrative: `我在这次涂鸦里亲手添了${item.doodles.length + addedByUser.length}笔心意。` };
      }) };
      const record: PhotoWallCreationRecord = {
        id: createPhotoWallId(), createdAt: new Date().toISOString(), authorType: "user", authorName: "我",
        narrative: wallCanvasMode === "doodle" ? `我在这次涂鸦里亲手添了${addedByUser.length}笔心意。` : `我在照片墙上亲手添了${addedByUser.length}笔涂鸦，把这一点小心意也留了下来。`,
        photoIds: [...photoIds], layers: [{ kind: "wall", doodles: addedByUser }], doodles: addedByUser,
      };
      if (wallCanvasMode === "doodle") doodleSessionRecordIdRef.current = record.id;
      return { ...source, creationRecords: [...(source.creationRecords ?? []), record] };
    };
    // 涂鸦过程中不要扩容：扩容会重映射照片/涂鸦，但背景图盒子没有偏移量，
    // 会出现“画布和照片分离”。保持世界固定，笔迹始终落在同一画布上。
    persist(appendUserRecord({ ...current, wallDoodles }));
    // The session's creation record is projected once into shared events; no per-stroke event.
  }, [persist, pushHistory, wallActivePhotoId, wallCanvasMode]);
  const visiblePhotos = useMemo(() => photos.filter(photo => {
    if (filter === "mine") return photo.ownerType === "user";
    if (filter === "characters") return photo.ownerType === "character";
    return true;
  }), [photos, filter]);
  const selectedPhoto = photos.find(photo => photo.id === selectedPhotoId) ?? null;

  const applyWallDimensions = () => {
    const current = stateRef.current;
    const nextWorld = normalizeWorld({ width: Number(wallWidthDraft), height: Number(wallHeightDraft) });
    const previousWorld = wallWorldOf(current);
    if (nextWorld.width === previousWorld.width && nextWorld.height === previousWorld.height) { onNotice?.("画布尺寸没有变化。"); return; }
    pushHistory(current);
    persist(resizeWorldPreservingPositions(current, nextWorld));
    setWallCanvasMode("view");
    onNotice?.("画布尺寸已调整为 " + nextWorld.width + " × " + nextWorld.height + "。已有照片和涂鸦的像素位置保持不变。");
  };

  const patchWallSelectedPlacement = (patch: Partial<PhotoWallPlacement>) => {
    const current = stateRef.current;
    const photoIndex = current.photos.findIndex(photo => photo.id === wallActivePhotoId);
    if (photoIndex < 0) return;
    const photo = current.photos[photoIndex];
    const base = photo.placement ?? fallbackPlacement(photoIndex);
    const presentationOnly = patch.frame !== undefined || patch.frameColor !== undefined || patch.locked !== undefined;
    if (base.locked && !presentationOnly) { onNotice?.("这张照片已锁定，请先解锁再调整位置或大小。"); return; }
    pushHistory(current);
    const maxZ = current.photos.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
    const nextPlacement = { ...base, ...patch } as PhotoWallPlacement;
    if (patch.z === -1) nextPlacement.z = maxZ + 1;
    changePlacement(photo.id, nextPlacement);
  };

  useEffect(() => {
    setWallWidthDraft(String(world.width));
    setWallHeightDraft(String(world.height));
  }, [world.width, world.height]);

  useEffect(() => {
    if (wallView === "edit") return;
    setWallCanvasMode("view"); setWallSticker(null); setWallEraser(false); setWallActivePhotoId(null); setSelectedPhotoId(null);
  }, [wallView]);
  const selectedCharacter = characters.find(char => char.id === selectedCharacterId) ?? null;
  const toggleTimelineFlip = (photoId: string) => setTimelineFlippedPhotoIds(current => { const next = new Set(current); if (next.has(photoId)) next.delete(photoId); else next.add(photoId); return next; });
  const commenter = characters.find(char => char.id === characterCommenterId) ?? characters[0] ?? null;

  /**
   * 新照片的落点：跟着你当前看到的位置走。
   * 无界画布变大后，新照片仍需落在当前视野附近；默认模板为整齐网格，
   * 避免用户未选择模板时批量添加的照片互相叠压。
   */
  const placementAnchor = useCallback((): { x: number; y: number } => {
    const viewport = panoramaViewportRef.current;
    const current = wallWorldOf(stateRef.current);
    const zoom = Math.max(0.05, panoramaZoomRef.current / 100);
    if (!viewport || !viewport.clientWidth) return { x: 0.5, y: 0.5 };
    // 视口固定不滚动，画布用 translate(pan) scale(zoom) 定位；
    // 把视口中心的屏幕坐标逆变换回画布坐标系，再换算成 0~1 的世界比例，
    // 这样用户平移/缩放画布后，新照片依然会落在当前视野中心。
    const pan = panRef.current;
    const screenCenterX = viewport.clientWidth / 2;
    const screenCenterY = viewport.clientHeight / 2;
    const x = (screenCenterX - pan.x) / zoom / Math.max(1, current.width);
    const y = (screenCenterY - pan.y) / zoom / Math.max(1, current.height);
    return { x: Math.min(0.9, Math.max(0.1, x)), y: Math.min(0.9, Math.max(0.1, y)) };
  }, []);

  const addPhoto = useCallback((photo: PhotoWallPhoto) => {
    const current = stateRef.current;
    pushHistory(current);
    const combined = [photo, ...current.photos.filter(item => item.id !== photo.id)];
    const explicitTemplate = Boolean(activeTemplateId) && activeTemplateId !== "builtin-scatter";
    if (explicitTemplate) {
      // 新照片加入后按总数重新计算整套骨架；只给新照片分配尾槽会让形状越长越缺边。
      const ordered = combined.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const editable = ordered.filter(item => !item.placement?.locked);
      const slots = buildTemplateSlots(activeTemplateId, editable.length, undefined, templateFill);
      const slotById = new Map(editable.map((item, index) => [item.id, { slot: slots[index], z: index + 1 }]));
      const rearranged = combined.map(item => {
        if (item.placement?.locked) return item;
        const arrangement = slotById.get(item.id);
        if (!arrangement?.slot) return item;
        const base = item.placement;
        return { ...item, placement: { ...arrangement.slot, z: arrangement.z, frame: base?.frame ?? "polaroid", locked: base?.locked ?? false, frameColor: base?.frameColor ?? "#fffdf8" } as PhotoWallPlacement };
      });
      persist({ ...current, photos: rearranged });
    } else {
      const order = current.photos.length;
      const anchor = placementAnchor();
      const jitter = ((order % 5) - 2) * 0.018;
      const maxZ = current.photos.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
      const placed = { ...photo, placement: photo.placement ?? { x: Math.min(0.92, Math.max(0.08, anchor.x + jitter)), y: Math.min(0.92, Math.max(0.08, anchor.y + jitter)), scale: 1, rotation: Math.round(jitter * 300), z: maxZ + 1, frame: "polaroid" as const, frameColor: "#fffdf8" } };
      const record: PhotoWallCreationRecord = {
        id: createPhotoWallId(), createdAt: new Date().toISOString(), authorType: photo.ownerType,
        authorId: photo.ownerId, authorName: photo.ownerName,
        narrative: (photo.ownerType === "character" ? photo.ownerName + "把一张照片放进了共同照片墙：" : "用户把一张照片放进了共同照片墙：") + (photo.title || "未命名的瞬间"),
        photoIds: [photo.id], layers: [], doodles: [],
      };
      persist({ ...current, photos: [placed, ...current.photos.filter(item => item.id !== photo.id)], creationRecords: [...(current.creationRecords ?? []), record] });
    }
    setSelectedPhotoId(photo.id);
  }, [persist, activeTemplateId, placementAnchor, templateFill, pushHistory]);

  const openChatPicker = async () => {
    setShowAddMenu(false);
    setBusy(true); setBusyLabel("正在翻找聊天里珍藏的照片…");
    try {
      const candidates: Array<{ key: string; ref: string; title: string; sessionName: string; createdAt: string }> = [];
      for (const session of loadChatSessions()) {
        for (const message of loadChatMessages(session.id)) {
          const imageMessage = message.mediaType === "image" || (message.mediaType === "media_file" && message.mediaData?.fileType === "image");
          const refs = [message.mediaUrl, ...(Array.isArray(message.mediaData?.imageRefs) ? message.mediaData.imageRefs as string[] : [])];
          if (!imageMessage && !refs.some(ref => typeof ref === "string" && (ref.startsWith("media-store://") || ref.startsWith("data:image/")))) continue;
          for (const [index, ref] of refs.entries()) {
            if (typeof ref !== "string" || !(ref.startsWith("media-store://") || ref.startsWith("data:image/") || /^https?:\/\//i.test(ref))) continue;
            candidates.push({
              key: `${message.id}-${index}-${ref.slice(0, 32)}`, ref,
              title: message.content?.trim().slice(0, 48) || "聊天里的照片",
              sessionName: session.groupName || session.alias || session.contactId || session.id,
              createdAt: message.createdAt,
            });
          }
        }
      }
      const unique = candidates.filter((item, index, all) => all.findIndex(other => other.ref === item.ref) === index).slice(-120).reverse();
      setChatCandidates(unique);
      setShowChatPicker(true);
      if (!unique.length) onNotice?.("还没有找到可收藏的聊天图片。");
    } catch (error) { onNotice?.("读取聊天照片失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const importChatPhoto = async (candidate: { key: string; ref: string; title: string; sessionName: string; createdAt: string }) => {
    setBusy(true); setBusyLabel("正在把这张聊天照片收进照片墙…");
    try {
      let mediaRef = candidate.ref;
      if (!mediaRef.startsWith("media-store://")) {
        const response = await fetch(mediaRef);
        if (!response.ok) throw new Error("图片读取失败");
        const blob = await response.blob();
        mediaRef = await storeMediaBlob(blob, blob.type || "image/jpeg", "image");
      }
      const photo: PhotoWallPhoto = {
        id: createPhotoWallId(), mediaRef, createdAt: new Date().toISOString(),
        capturedAt: candidate.createdAt, ownerType: "user", ownerName: "我", kind: "favorite",
        title: candidate.title || "聊天里的照片", caption: `来自聊天：${candidate.sessionName}`,
        backNote: "", tags: ["聊天收藏", candidate.sessionName], annotations: [], shareWithCharacters: true, source: "chat-favorite",
      };
      addPhoto(photo);
      setShowChatPicker(false);
      onNotice?.("已把聊天照片收藏到照片墙。");
    } catch (error) { onNotice?.("收藏聊天照片失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const uploadFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter(file => file.type.startsWith("image/"));
    if (!list.length) { onNotice?.("请选择图片文件。"); return; }
    setBusy(true); setBusyLabel("正在处理照片（0/" + list.length + "）…");
    const created: PhotoWallPhoto[] = [];
    const failed: string[] = [];
    try {
      // 不再静默截断为 20 张。每张图片独立处理，单张损坏/超限不应让整批已上传照片丢失。
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        setBusyLabel("正在处理照片（" + (index + 1) + "/" + list.length + "）：" + file.name.slice(0, 24));
        try {
          const blob = await optimizeUpload(file);
          const mime = blob.type || file.type || "image/jpeg";
          const ref = await storeMediaBlob(blob, mime, "image");
          const capturedAt = await readExifCapturedAt(file);
          created.push({
            id: createPhotoWallId(), mediaRef: ref, createdAt: new Date().toISOString(), capturedAt,
            ownerType: "user", ownerName: "我", kind: "favorite", title: file.name.replace(/\\.[^.]+$/, "").slice(0, 60) || "一张喜欢的照片",
            caption: "", backNote: "", tags: [], annotations: [], shareWithCharacters: true, source: "upload",
          });
        } catch (error) {
          failed.push(file.name + "：" + (error instanceof Error ? error.message : String(error)));
        }
      }
      if (created.length) {
        const current = stateRef.current;
        if (activeTemplateId && activeTemplateId !== "builtin-scatter") {
          const combined = [...created, ...current.photos];
          const ordered = combined.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          const editable = ordered.filter(item => !item.placement?.locked);
          const slots = buildTemplateSlots(activeTemplateId, editable.length, undefined, templateFill);
          const slotById = new Map(editable.map((item, index) => [item.id, { slot: slots[index], z: index + 1 }]));
          const rearranged = combined.map(item => {
            if (item.placement?.locked) return item;
            const arrangement = slotById.get(item.id);
            if (!arrangement?.slot) return item;
            const base = item.placement;
            return { ...item, placement: { ...arrangement.slot, z: arrangement.z, frame: base?.frame ?? "polaroid", locked: base?.locked ?? false, frameColor: base?.frameColor ?? "#fffdf8" } as PhotoWallPlacement };
          });
          persist({ ...current, photos: rearranged });
        } else {
          const maxZ = current.photos.reduce((max, item) => Math.max(max, item.placement?.z ?? 0), 0);
          // 批量上传与单张 addPhoto 一致：以当前视野中心为锚点做小网格抖动散开，
          // 不再落到固定 scatter 槽位——用户平移到画布远端后上传，照片就落在眼前。
          const anchor = placementAnchor();
          const placedCreated = created.map((photo, index) => {
            const col = index % 3, row = Math.floor(index / 3) % 3;
            const jx = (col - 1) * 0.055 + ((index % 2) - 0.5) * 0.014;
            const jy = (row - 1) * 0.055 + ((Math.floor(index / 2) % 2) - 0.5) * 0.014;
            return { ...photo, placement: { x: Math.min(0.92, Math.max(0.08, anchor.x + jx)), y: Math.min(0.92, Math.max(0.08, anchor.y + jy)), scale: 1, rotation: Math.round(((index % 5) - 2) * 3), z: maxZ + index + 1, frame: "polaroid" as const, frameColor: "#fffdf8" } as PhotoWallPlacement };
          });
          const record: PhotoWallCreationRecord = {
            id: createPhotoWallId(), createdAt: new Date().toISOString(), authorType: "user", authorName: "我",
            narrative: "用户一次上传了 " + created.length + " 张照片到共同照片墙。",
            photoIds: created.map(photo => photo.id), layers: [], doodles: [],
          };
          persist({ ...current, photos: [...placedCreated, ...current.photos], creationRecords: [...(current.creationRecords ?? []), record] });
        }
        setSelectedPhotoId(created[0]?.id ?? null);
      }
      if (failed.length) onNotice?.("已收藏 " + created.length + " 张；" + failed.length + " 张失败。失败项：" + failed.slice(0, 3).join("；") + (failed.length > 3 ? "；…" : ""));
      else onNotice?.("已收藏 " + created.length + " 张照片。");
    } catch (error) { onNotice?.("收藏失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  const uploadCanvasBackground = async (file: File) => {
    if (!file.type.startsWith("image/")) { onNotice?.("背景需要是图片文件。"); return; }
    setBusy(true); setBusyLabel("正在设置画布背景…");
    let newRef = "";
    try {
      const blob = await optimizeUpload(file);
      newRef = await storeMediaBlob(blob, blob.type || file.type || "image/jpeg", "image");
      await retainMediaRef(newRef, "photo-wall-background");
      const current = stateRef.current;
      const oldRef = current.wallBackgroundRef;
      // 记下上传时的世界尺寸：之后往四边长，背景按原比例停在它该在的区域，不会被拉糊。
      persist({ ...current, wallBackgroundRef: newRef, wallBackgroundBox: wallWorldOf(current) });
      if (oldRef && oldRef !== newRef) {
        await releaseMediaRef(oldRef, "photo-wall-background").catch(() => undefined);
        await deleteMediaRef(oldRef).catch(() => undefined);
      }
      onNotice?.("画布背景已保存，并已在媒体库建立引用保护。");
    } catch (error) {
      if (newRef) {
        await releaseMediaRef(newRef, "photo-wall-background").catch(() => undefined);
        await deleteMediaRef(newRef).catch(() => undefined);
      }
      onNotice?.("设置背景失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setBusy(false); setBusyLabel(""); }
  };

  const clearCanvasBackground = () => {
    const oldRef = stateRef.current.wallBackgroundRef;
    persist({ ...stateRef.current, wallBackgroundRef: undefined, wallBackgroundBox: undefined });
    if (oldRef) void releaseMediaRef(oldRef, "photo-wall-background").then(() => deleteMediaRef(oldRef)).catch(error => console.warn("[照片墙] 清理旧背景失败", error));
    onNotice?.("已移除画布背景，照片和涂鸦不会受影响。");
  };

  const generatePhoto = async (owner: Character | null, kind: PhotoWallPhoto["kind"], daily = false) => {
    if (busy) return;
    if (!owner) { onNotice?.("请先导入至少一张角色卡。"); return; }
    setBusy(true); setBusyLabel(daily ? "角色正在把今天的片刻留进照片墙…" : "正在显影这张照片…");
    try {
      const life = loadVirtualLifeState();
      const recent = life.timeline
        .filter(entry => {
          const at = Date.parse(entry.occurredAt);
          return Number.isFinite(at) && Date.now() - at >= 0 && Date.now() - at < 7 * DAY_MS;
        })
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
        .slice(0, 24);
      const belongsToCharacter = (entry: typeof recent[number]) => !entry.actorId || entry.actorId === owner.id;
      const warmMoment = recent.find(entry => belongsToCharacter(entry) && /开心|幸福|温暖|陪伴|拥抱|约会|惊喜|庆祝|一起|喜欢|安心|成功|完成|笑|礼物|咖啡|晚餐|散步|旅行|纪念/.test([entry.title, entry.details || ""].join(" ")));
      const event = warmMoment ?? recent.find(belongsToCharacter) ?? recent[0];
      const eventText = event
        ? `优先把这段真实生活片段转化成值得珍藏的照片：${event.title}${event.locationName ? `，地点是${event.locationName}` : ""}${event.details ? `。细节：${event.details}` : ""}。如果它带有温暖、幸福、亲密、轻松或小小成就的情绪，请抓住这种感觉；不必把事件逐字画出来，也不要凭空制造重大剧情。`
        : "没有明确的近期事件，请描绘一个自然、温暖、安静、可信的小日常，优先呈现陪伴、轻松或小确幸，不要凭空制造重大剧情。";
      const kindPrompt: Record<PhotoWallPhoto["kind"], string> = {
        favorite: "角色自己珍藏的一张照片，带有私人的情绪和生活痕迹。",
        selfie: "角色自然随手拍下的自拍，不摆拍，像发给亲近之人的私密日常。",
        candid: "从角色视角拍下用户不经意的生活瞬间，温柔、尊重、不带窥视或性化意味；没有用户参考图时，不要擅自编造清晰且具体的用户外貌。",
        scenery: "角色很喜欢的一处风景，带有真实摄影质感与个人审美。",
        object: "一件让角色想起用户的小物件、食物、书页或窗边光线。",
        moment: "一张像共同回忆的生活照片，强调温暖细节而非戏剧性。",
      };
      let referenceImageDataUrl: string | undefined;
      const refPhoto = referencePhotoId ? state.photos.find(photo => photo.id === referencePhotoId) : undefined;
      if (refPhoto) {
        const stored = await loadMediaBlob(refPhoto.mediaRef);
        if (stored) referenceImageDataUrl = await blobToDataUrl(stored.blob);
      }
      const referenceText = referenceImageDataUrl
        ? "请参考用户额外提供的这张照片中的视觉信息，但不要机械复制原图构图；角色与用户的身份分别以各自的人物身份参考为准。"
        : "";
      const description = (generationPromptTemplate.trim() || DEFAULT_PHOTO_WALL_PROMPT)
        .split("{characterName}").join(owner.name)
        .split("{characterPersona}").join((owner.persona || owner.personality || "").slice(0, 700))
        .split("{photoType}").join(kindPrompt[kind])
        .split("{lifeEvent}").join(eventText)
        .split("{referenceText}").join(referenceText);
      const participantIds = kind === "selfie"
        ? [owner.id]
        : kind === "candid"
          ? [owner.id, "__user__"]
          : kind === "moment"
            ? Array.from(new Set([owner.id, ...groupReferenceCharacterIds, "__user__"]))
            : [];
      const result = await generateImageFromConfiguredApi({
        description, characterId: owner.id, appId: "photo_wall",
        participantIds,
        useReferenceImage: true,
        referenceImageDataUrl,
      });
      if (!result) throw new Error("没有可用的生图方案。请在系统设置中启用并配置图片生成服务。");
      const title = kind === "selfie" ? `${owner.name}的今日自拍` : kind === "candid" ? "你不经意的样子" : kind === "scenery" ? "路过的好天气" : kind === "object" ? "想起你的东西" : kind === "moment" ? "想留住的瞬间" : `${owner.name}的私藏`;
      const photo: PhotoWallPhoto = {
        id: createPhotoWallId(), mediaRef: result.mediaRef, createdAt: new Date().toISOString(),
        ownerType: "character", ownerId: owner.id, ownerName: owner.name, kind,
        title, caption: event?.title ? `记在这里：${event.title}` : "有些瞬间没有特别的理由，只是想留住。",
        backNote: "", tags: [KIND_LABEL[kind]], annotations: [], shareWithCharacters: true,
        referencePhotoId: refPhoto?.id, generationPrompt: result.prompt, source: event ? "life-event" : "generated",
      };
      addPhoto(photo);
      onNotice?.(`${owner.name}把一张照片放进了照片墙。`);
      return photo;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (daily) {
        const current = loadPhotoWallState();
        persist({ ...current, settings: { ...current.settings, lastDailyGenerationError: message } });
      }
      onNotice?.("生成照片失败：" + message);
      return null;
    } finally { setBusy(false); setBusyLabel(""); }
  };

  const runDailyGeneration = useCallback(async () => {
    if (autoRunRef.current || busy) return;
    const current = loadPhotoWallState();
    const today = dayKey();
    if (!current.settings.dailyGenerationEnabled || current.settings.lastDailyGenerationDay === today || characters.length === 0) return;
    autoRunRef.current = true;
    const count = current.settings.dailyPhotoCount;
    let generated = 0;
    let lastError = "";
    try {
      for (let index = 0; index < count; index += 1) {
        const fresh = loadPhotoWallState();
        // 尊重设置页「让谁生成照片」的选择；未选择时才在全部角色间轮换。
        const preferred = characters.find(char => char.id === selectedCharacterId);
        const owner = preferred ?? characters[(new Date().getDate() + index) % characters.length];
        const kinds: PhotoWallPhoto["kind"][] = ["selfie", "candid", "scenery", "object", "moment"];
        const kind = kinds[(new Date().getDate() + index * 2) % kinds.length];
        const result = await generatePhoto(owner, kind, true);
        if (!result) { lastError = fresh.settings.lastDailyGenerationError || "未知原因"; break; }
        generated += 1;
        if (index < count - 1) await new Promise(resolve => window.setTimeout(resolve, 900));
      }
      // 无论成败都把今天标记为已尝试：失败也无限重试只会反复白烧生图 API；
      // 失败原因保留在 lastDailyGenerationError 里，成功后清除。
      const fresh = loadPhotoWallState();
      persist({ ...fresh, settings: { ...fresh.settings, lastDailyGenerationDay: today, lastDailyGenerationAt: generated ? new Date().toISOString() : fresh.settings.lastDailyGenerationAt, lastDailyGenerationError: generated ? undefined : (lastError || fresh.settings.lastDailyGenerationError) } });
      if (generated) onNotice?.(`今日照片已显影：${generated} 张。`);
    } finally { autoRunRef.current = false; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, persist, state.settings.dailyGenerationEnabled, state.settings.dailyPhotoCount, selectedCharacterId]);

  useEffect(() => {
    if (!state.settings.dailyGenerationEnabled || characters.length === 0) return;
    const timer = window.setTimeout(() => { void runDailyGeneration(); }, 1600);
    return () => window.clearTimeout(timer);
  }, [state.settings.dailyGenerationEnabled, state.settings.dailyPhotoCount, state.settings.lastDailyGenerationDay, characters.length, runDailyGeneration]);

  const saveBack = () => {
    if (!selectedPhoto) return;
    const currentState = stateRef.current;
    const latestPhoto = currentState.photos.find(photo => photo.id === selectedPhoto.id) ?? selectedPhoto;
    const nextPhoto = { ...latestPhoto, title: editTitle.trim() || "未命名的瞬间", backNote: editNote, capturedAt: editCapturedAt ? new Date(editCapturedAt).toISOString() : undefined, annotations: [], tags: editTags.split(/[,，#\n]/).map(tag => tag.trim()).filter(Boolean).slice(0, 20) };
    persist({ ...currentState, photos: currentState.photos.map(photo => photo.id === nextPhoto.id ? nextPhoto : photo) });
    setPhotoViewOnly(true);
    onNotice?.("照片背面的内容已保存。");
  };

  const askCharacterToWrite = async () => {
    if (!selectedPhoto || !commenter || busy) return;
    setBusy(true); setBusyLabel(`${commenter.name}正在认真看这张照片…`);
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === commenter.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `photo-wall-${commenter.id}`, contactId: contact?.id ?? commenter.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-16);
      const instruction = [
        `照片标题：${selectedPhoto.title}。`,
        `照片背面已有内容：${editNote || getPhotoBackText(selectedPhoto) || selectedPhoto.caption || "还没有写下记录"}。`,
        `标签：${selectedPhoto.tags.join("、") || "没有标签"}。`,
        `照片类型：${KIND_LABEL[selectedPhoto.kind]}；拍摄者：${selectedPhoto.ownerName}。`,
        "请据此写一条照片背面的批注。",
      ].join("\n");
      const promptMessage: ChatMessage = {
        id: createPhotoWallId(), sessionId: session.id, role: "user", content: instruction,
        status: "sent", createdAt: new Date().toISOString(),
      };
      const storedPhoto = await loadMediaBlob(selectedPhoto.mediaRef).catch(() => null);
      const attachedImages = storedPhoto ? [await readCompressedImageDataUrl(storedPhoto.blob)] : [];
      const result = await generateChatCompletion(session, [...history, promptMessage], {
        appId: "photo_wall", appTags: ["photo_wall", "annotation"], toolsAllowed: false,
        attachedImages,
      });
      const content = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
      if (!content) throw new Error("角色没有生成批注，请稍后再试。");
      const fresh = loadPhotoWallState();
      const existing = fresh.photos.find(photo => photo.id === selectedPhoto.id) ?? selectedPhoto;
      const baseText = editNote.trim() || getPhotoBackText(existing);
      const nextBackNote = [baseText, `${commenter.name}：${content}`].filter(Boolean).join("\n\n");
      persist({ ...fresh, photos: fresh.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, backNote: nextBackNote, annotations: [] } : photo) });
      recordPhotoWallMemory("照片背面写了：" + nextBackNote.slice(0, 300), selectedPhoto.ownerType === "character" ? selectedPhoto.ownerId : undefined);
      setEditNote(nextBackNote);
      setPhotoViewOnly(false);
      onNotice?.(`${commenter.name}已经把一句话写进照片背面。`);
    } catch (error) { onNotice?.("请角色写批注失败：" + (error instanceof Error ? error.message : String(error))); }
    finally { setBusy(false); setBusyLabel(""); }
  };

  /** 角色直接写入现有画布数据；不模拟触屏，也不改变手动涂鸦/手势状态。 */
  const askCharacterToDecorateWall = async () => {
    const artist = selectedCharacter;
    if (!artist || busy) return;
    const before = stateRef.current;
    if (!before.photos.length) { onNotice?.("先在照片墙收录几张照片，再邀请角色装饰。"); return; }
    setBusy(true);
    setBusyLabel(`${artist.name}正在给照片墙添上小小的心意…`);
    try {
      const sessions = loadChatSessions();
      const contact = loadChatContacts().find(item => item.characterId === artist.id);
      const session = sessions.find(item => !item.isGroup && item.contactId === contact?.id)
        ?? ({ id: `photo-wall-${artist.id}`, contactId: contact?.id ?? artist.id, unreadCount: 0, updatedAt: new Date().toISOString(), isPinned: false, isGroup: false } as ChatSession);
      const history = loadChatMessages(session.id).slice(-12);
      const layout = before.photos.slice(0, 40).map((photo, index) => ({
        index,
        title: photo.title || "未命名照片",
        owner: photo.ownerName,
        kind: KIND_LABEL[photo.kind],
        placement: photo.placement ? {
          x: Number(photo.placement.x.toFixed(3)),
          y: Number(photo.placement.y.toFixed(3)),
          scale: Number(photo.placement.scale.toFixed(2)),
          rotation: photo.placement.rotation,
        } : null,
      }));
      const instruction = [
        `你的名字：${artist.name}。`,
        `角色设定：${(artist.persona || artist.personality || "").slice(0, 500)}`,
        `画布尺寸：${wallWorldOf(before).width} × ${wallWorldOf(before).height}。`,
        `墙上照片（placement 的 x/y 是照片布局锚点，仅用于估计位置）：${JSON.stringify(layout)}`,
        "请按要求创作装饰涂鸦 JSON。",
      ].join("\n");
      const promptMessage: ChatMessage = {
        id: createPhotoWallId(), sessionId: session.id, role: "user", content: instruction,
        status: "sent", createdAt: new Date().toISOString(),
      };
      const result = await generateChatCompletion(session, [...history, promptMessage], {
        appId: "photo_wall", appTags: ["photo_wall", "doodle"], toolsAllowed: false,
      });
      const { doodles: created, summary: characterSummary, createdAt } = parseCharacterWallDoodles(flattenCompletionResult(result), artist);
      const latest = stateRef.current;
      const photoIds = new Set<string>();
      for (const doodle of created) {
        const center = doodle.kind === "sticker"
          ? (doodle.points[0] ?? { x: 0.5, y: 0.5 })
          : doodle.points.reduce((sum, point) => ({ x: sum.x + point.x / doodle.points.length, y: sum.y + point.y / doodle.points.length }), { x: 0, y: 0 });
        const nearest = latest.photos.map((photo, index) => {
          const placement = photo.placement ?? fallbackPlacement(index);
          return { id: photo.id, distance: Math.hypot(placement.x - center.x, placement.y - center.y) };
        }).sort((a, b) => a.distance - b.distance)[0];
        if (nearest && nearest.distance <= 0.24) photoIds.add(nearest.id);
      }
      const fallbackPhotoId = wallActivePhotoId ?? selectedPhotoId;
      if (!photoIds.size && fallbackPhotoId && latest.photos.some(photo => photo.id === fallbackPhotoId)) photoIds.add(fallbackPhotoId);
      const narrative = characterSummary || `${artist.name}今天在照片墙上留下了${created.length}个小装饰。每一笔都被认真收进了我们的共同回忆里。`;
      const record: PhotoWallCreationRecord = {
        id: createPhotoWallId(), createdAt, authorType: "character", authorId: artist.id,
        authorName: artist.name, narrative, photoIds: [...photoIds], layers: [{ kind: "wall", doodles: created }], doodles: created,
      };
      changeWallDoodles([...(latest.wallDoodles ?? []), ...created]);
      const afterDoodles = stateRef.current;
      persist({ ...afterDoodles, creationRecords: [...(afterDoodles.creationRecords ?? []), record] });
      // The creation record is the single source for this completed co-creation event.
      onNotice?.(`${artist.name}留下了 ${created.length} 个小装饰；创作过程已保存到「共创记录」。`);
    } catch (error) {
      onNotice?.("请角色装饰照片墙失败：" + (error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
      setBusyLabel("");
    }
  };

  const deleteSelectedPhoto = async () => {
    if (!selectedPhoto || !window.confirm("确定把这张照片从照片墙移除吗？这会删除图片文件，但不会删除其他照片或聊天记录。")) return;
    try {
      const currentState = stateRef.current;
      const ref = selectedPhoto.mediaRef;
      const sharedByAnotherPhoto = currentState.photos.some(photo => photo.id !== selectedPhoto.id && photo.mediaRef === ref);
      pushHistory(currentState);
      persist({ ...currentState, photos: currentState.photos.filter(photo => photo.id !== selectedPhoto.id) });
      // Chat favorites intentionally share the original media ref with the chat.
      // Never delete a shared blob when removing only its photo-wall card.
      if (!sharedByAnotherPhoto && selectedPhoto.source !== "chat-favorite") await deleteMediaRef(ref);
      setSelectedPhotoId(null);
      onNotice?.("照片已移除。");
    } catch (error) { onNotice?.("移除失败：" + (error instanceof Error ? error.message : String(error))); }
  };

  const openPhoto = (photo: PhotoWallPhoto, viewOnly = true) => {
    setPhotoViewOnly(viewOnly);
    setWallActivePhotoId(photo.id);
    setSelectedPhotoId(photo.id);
    setEditTitle(photo.title); setEditNote(getPhotoBackText(photo)); setEditTags(photo.tags.join("、"));
    setEditCapturedAt(formatDateTimeInput(photo.capturedAt));
  };

  return <div className="photo-wall-app pointer-events-auto isolate absolute inset-0 z-[1000] flex min-w-0 flex-col overflow-hidden bg-[radial-gradient(ellipse_at_top,#fffdf8_0%,#f4f0e7_58%,#e9e1d4_100%)] text-[#51483d]" style={{ fontFamily: '"Noto Serif SC", "Songti SC", serif' }}>
    <header
      className="relative z-10 flex shrink-0 items-center gap-3 border-b border-[#ded5c7]/80 bg-white/75 px-4 pb-3 shadow-[0_8px_28px_rgba(94,76,53,.06)] backdrop-blur-xl"
      style={{ paddingTop: "max(12px, var(--page-header-safe-top, 48px))" }}
    >
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); if (showAddMenu) setShowAddMenu(false); else if (showChatPicker) setShowChatPicker(false); else if (selectedPhotoId) setSelectedPhotoId(null); else if (wallView === "album" && activeAlbumId) setActiveAlbumId(null); else if (wallView === "settings" || wallView === "timeline" || wallView === "memories" || wallView === "album" || wallView === "creations") setWallView(wallView === "settings" ? settingsReturnView : "panorama"); else onClose(); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 cursor-pointer touch-manipulation place-items-center rounded-2xl border border-[#ded5c7] bg-white/80 text-[#7b6a58] shadow-sm transition hover:-translate-y-0.5 hover:bg-white active:scale-95" aria-label="返回上一级"><ArrowLeft size={17}/></button>
      <div className="min-w-0 flex-1"><div className="whitespace-nowrap font-serif text-lg tracking-[.04em]">{wallView === "settings" ? "墙面与显影设置" : wallView === "creations" ? "共同创作记录" : wallView === "album" ? (activeAlbum?.title || "相册") : wallView === "memories" ? "全部记忆" : wallView === "timeline" ? "时间轴" : "照片墙"}</div><div className="mt-0.5 truncate whitespace-nowrap text-[10px] tracking-[.1em] text-[#a09380]">{wallView === "settings" ? "WALL & DEVELOPING" : `A LITTLE ARCHIVE OF US · ${photos.length} PHOTOS`}</div></div>
      {(wallView === "edit" || wallView === "panorama") && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowAddMenu(false); setSettingsReturnView(wallView === "edit" ? "edit" : "panorama"); setWallView("settings"); }} className="relative z-[1002] pointer-events-auto min-h-10 shrink-0 cursor-pointer touch-manipulation border-b border-[#bda28d] px-2 py-1 text-sm tracking-wider text-[#79545a] transition active:opacity-60">设置</button>}
      {wallView === "edit" && <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowAddMenu(value => !value); }} className="relative z-[1002] pointer-events-auto grid h-10 w-10 shrink-0 cursor-pointer touch-manipulation place-items-center border border-[#d8c4b4] bg-[#fffaf2] text-[#87565b] transition active:scale-95" aria-label="添加照片"><Plus size={18}/></button>}
      {(wallView === "edit" || wallView === "panorama" || wallView === "memories" || wallView === "timeline") && <button type="button" onClick={() => void exportWall()} disabled={exportBusy || !photos.length} className="grid h-10 w-10 shrink-0 place-items-center border border-[#d8c4b4] bg-[#fffaf3]/80 text-[#795b52] disabled:opacity-40" aria-label="导出整墙 PNG"><Download size={17}/></button>}
      {wallView === "panorama" && <button type="button" onClick={() => setWallView("edit")} className="shrink-0 border-b border-[#bda28d] px-2 py-2 text-sm text-[#79545a]">编辑墙面</button>}
      {(wallView === "memories" || wallView === "timeline" || wallView === "creations") && <button type="button" onClick={() => setWallView("edit")} className="shrink-0 border-b border-[#bda28d] px-2 py-2 text-sm text-[#79545a]">编辑</button>}
      {wallView === "edit" && <span className="shrink-0 text-xs tracking-wide text-[#87565b]">画布</span>}
    </header>

    {wallView !== "settings" && <nav className="absolute bottom-0 left-0 right-0 z-20 flex shrink-0 items-center justify-center gap-7 border-t border-[#d8c4b4] bg-[#f8f0e6]/96 px-3 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 backdrop-blur">
      <button type="button" onClick={() => setWallView("panorama")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="panorama"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>全景墙</button>
      <button type="button" onClick={() => setWallView("timeline")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="timeline"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>时间轴</button>
      <button type="button" onClick={() => { setWallView("album"); setActiveAlbumId(null); setAlbumEditMode(false); }} className={`border-b-2 px-1 py-2 text-sm ${wallView==="album"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>相册</button>
      <button type="button" onClick={() => setWallView("creations")} className={`border-b-2 px-1 py-2 text-sm ${wallView==="creations"?"border-[#87565b] text-[#87565b]":"border-transparent text-[#85735f]"}`}>共创记录</button>
    </nav>}
    {wallView === "edit" && showAddMenu && <div className="absolute right-3 z-30 w-[min(17rem,calc(100vw-1.5rem))] border border-[#d7c2b1] bg-[#fffaf2] p-1 shadow-[0_16px_44px_rgba(60,42,32,.22)]" style={{top:"calc(max(12px, var(--page-header-safe-top, 48px)) + 64px)"}}>
      <button onClick={() => { setShowAddMenu(false); fileRef.current?.click(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] last:border-b-0 hover:bg-[#f3e9df]"><ImagePlus size={17}/>收藏我的照片</button>
      <button onClick={() => { setShowAddMenu(false); void openChatPicker(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Heart size={17}/>从聊天收藏照片</button>
      <button onClick={() => { setShowAddMenu(false); if (!selectedCharacter) { setSettingsReturnView("edit"); setWallView("settings"); onNotice?.("请先在「今日照片与生成设置」中明确选择要生成照片的角色。"); return; } void generatePhoto(selectedCharacter, "moment"); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Sparkles size={17}/>请角色生成一张</button>
      <button onClick={() => { setShowAddMenu(false); wallBackgroundInputRef.current?.click(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><ImagePlus size={17}/>上传画布背景</button>
      {state.wallBackgroundRef && <button onClick={() => { setShowAddMenu(false); clearCanvasBackground(); }} className="flex min-h-11 w-full items-center gap-3 border-b border-[#eadfd3] px-3 py-2.5 text-left text-sm leading-5 text-[#8f5a54] hover:bg-[#f3e9df]"><X size={17}/>移除当前背景</button>}
      <button onClick={() => { setShowAddMenu(false); setSettingsReturnView("edit"); setWallView("settings"); }} className="flex min-h-11 w-full items-center gap-3 px-3 py-2.5 text-left text-sm leading-5 text-[#5d4942] hover:bg-[#f3e9df]"><Camera size={17}/>今日照片与生成设置</button>
    </div>}
    <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={event => { if (event.target.files) void uploadFiles(event.target.files); event.currentTarget.value = ""; }}/>
    <input ref={wallBackgroundInputRef} type="file" accept="image/*" className="hidden" onChange={event => { const file = event.currentTarget.files?.[0]; if (file) void uploadCanvasBackground(file); event.currentTarget.value = ""; }}/>

    <main className={wallView === "edit" || wallView === "panorama" ? "min-h-0 flex flex-1 flex-col overflow-hidden" : "min-h-0 flex-1 overflow-y-auto overscroll-contain"} style={{ paddingBottom: wallView === "edit" || wallView === "panorama" ? 0 : "calc(58px + env(safe-area-inset-bottom, 0px))" }}>
      {wallView === "settings" ? <div className="min-h-full bg-[#f5ede3] px-4 pb-10 pt-5 sm:px-7" style={{backgroundImage:"repeating-linear-gradient(0deg,rgba(122,84,68,.025) 0,rgba(122,84,68,.025) 1px,transparent 1px,transparent 5px)"}}>
        <div className="mx-auto max-w-3xl">
          <p className="text-[10px] tracking-[.24em] text-[#a18172]">A QUIET CORNER FOR YOUR WALL</p>
          <h1 className="mt-2 font-serif text-2xl font-normal text-[#503d38]">把墙面布置成你喜欢的样子</h1>
          <p className="mt-2 text-xs leading-6 text-[#8b7569]">模板只保存摆放骨架，不会覆盖照片内容；应用后仍可回到画布继续拖动、缩放和涂鸦。</p>
          <p className="mt-2 rounded-xl border border-[#e2c9a8] bg-[#fdf6e9] px-3 py-2.5 text-[11px] leading-5 text-[#7c5f46]">备份提示：「设置 → 数据管理」的云备份默认不包含媒体文件本体（excludeMedia）。恢复备份后，若本机媒体库没有对应图片，照片墙里的照片会显示为缺失。需要完整迁移照片墙时，请使用包含媒体库的完整备份，或先导出整墙 PNG 留底。</p>
          <section className="mt-5 border-y border-[#d9c6b6] bg-[#fffaf2]/75 px-4 py-4 shadow-[0_8px_24px_rgba(83,55,39,.05)]">
            <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-lg text-[#5a403b]">日常显影</h2><span className="text-[10px] tracking-[.12em] text-[#a18172]">DAILY DEVELOPING</span></div>
            <p className="mt-2 text-xs leading-6 text-[#8b7569]">每天首次打开照片墙时，可依据最近生活记录生成照片。仅在应用运行时触发；图片由你配置的生图服务生成，可能产生 API 费用。</p>
            <label className="mt-4 flex min-h-11 items-center justify-between gap-4 border-b border-[#eadfd3] py-3 text-sm text-[#5d4942]"><span>每日自动生成</span><input type="checkbox" checked={state.settings.dailyGenerationEnabled} onChange={event => persist({ ...state, settings: { ...state.settings, dailyGenerationEnabled: event.target.checked } })} className="h-4 w-4 accent-[#87565b]"/></label>
            <div className="flex min-h-11 items-center justify-between gap-4 border-b border-[#eadfd3] py-3 text-sm text-[#5d4942]"><span>每天最多生成</span><select value={state.settings.dailyPhotoCount} onChange={event => persist({ ...state, settings: { ...state.settings, dailyPhotoCount: Number(event.target.value) as 1 | 2 | 3 } })} className="max-w-[45%] border-b border-[#d7c2b1] bg-transparent px-2 py-1 text-right"><option value={1}>1 张</option><option value={2}>2 张</option><option value={3}>3 张</option></select></div>
            <label className="mt-4 block text-xs text-[#8b7569]">让谁生成照片<select value={selectedCharacterId} onChange={event => { const value = event.target.value; setSelectedCharacterId(value); try { window.localStorage.setItem(PHOTO_WALL_CHARACTER_KEY, value); } catch { /* explicit selection still applies for this session */ } }} className="mt-2 w-full border-b border-[#d7c2b1] bg-transparent px-2 py-2 text-sm text-[#5d4942]"><option value="">请选择角色</option>{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></label>
            <div className="mt-4 border-t border-[#e5d6c7] pt-3">
              <p className="text-xs text-[#8b7569]">合照角色参考图（仅用于「想留住的瞬间」）</p>
              <p className="mt-1 text-[10px] leading-5 text-[#9a8776]">先在系统设置 → 生图 → Character Identity 给每个角色上传参考图并启用；勾选后会把这些角色的脸部参考合并到一张带标签的参考板中。</p>
              <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {characters.map(char => {
                  const reference = loadImageGenerationSettings().characterReferences?.[char.id];
                  const hasReference = Boolean(reference?.assetId && reference.enabled !== false);
                  const checked = groupReferenceCharacterIds.includes(char.id);
                  return <label key={char.id} className="flex min-w-0 items-center gap-2 border-b border-[#eadfd3] py-2 text-xs text-[#6d594b]">
                    <input type="checkbox" checked={checked} disabled={!hasReference} onChange={event => {
                      const next = event.target.checked ? Array.from(new Set([...groupReferenceCharacterIds, char.id])) : groupReferenceCharacterIds.filter(id => id !== char.id);
                      setGroupReferenceCharacterIds(next);
                      try { window.localStorage.setItem(PHOTO_WALL_GROUP_REFERENCES_KEY, JSON.stringify(next)); } catch { /* keep session selection */ }
                    }} className="h-4 w-4 shrink-0 accent-[#87565b]"/>
                    <span className="min-w-0 flex-1 truncate">{char.name}</span>
                    <span className="shrink-0 text-[10px] text-[#a08c74]">{hasReference ? "参考图已启用" : "先上传参考图"}</span>
                  </label>;
                })}
              </div>
            </div>
            <label className="mt-4 block text-xs text-[#8b7569]">角色照片生成提示词（可编辑；支持 {`{characterName}`}、{`{characterPersona}`}、{`{photoType}`}、{`{lifeEvent}`}、{`{referenceText}`} 变量）<textarea value={generationPromptTemplate} onChange={event => setGenerationPromptTemplate(event.target.value)} rows={7} placeholder={DEFAULT_PHOTO_WALL_PROMPT} className="mt-2 w-full resize-y rounded-xl border border-[#e6dccd] bg-[#fcf9f2] p-3 text-xs leading-6 text-[#655647]"/></label>
            <div className="mt-2 flex gap-2"><button type="button" onClick={() => { try { window.localStorage.setItem(PHOTO_WALL_PROMPT_KEY, generationPromptTemplate); onNotice?.("角色照片生成提示词已保存，将用于下一次生成。"); } catch { onNotice?.("保存提示词失败，请检查本地存储空间。"); } }} className="rounded-xl bg-[#87565b] px-3 py-2 text-xs text-white">保存提示词</button><button type="button" onClick={() => setGenerationPromptTemplate(DEFAULT_PHOTO_WALL_PROMPT)} className="rounded-xl border border-[#d7c2b1] px-3 py-2 text-xs text-[#79545a]">恢复默认</button></div>
            <div className="flex flex-wrap items-center gap-2 border-b border-[#eadfd3] py-3 text-xs"><span className="text-[#8b7569]">生成参考图</span><select value={referencePhotoId} onChange={event => setReferencePhotoId(event.target.value)} className="min-w-0 flex-1 border-b border-[#d7c2b1] bg-transparent px-2 py-2"><option value="">使用角色外观参考设置</option>{photos.map(photo => <option key={photo.id} value={photo.id}>{photo.title}</option>)}</select></div>
            {state.settings.lastDailyGenerationAt && <p className="mt-3 text-[11px] leading-5 text-[#93836e]">上次显影：{formatDate(state.settings.lastDailyGenerationAt)}{state.settings.lastDailyGenerationError ? ` · 上次有错误：${state.settings.lastDailyGenerationError}` : ""}</p>}
            <button disabled={busy || !selectedCharacter} onClick={() => void generatePhoto(selectedCharacter, "moment")} className="mt-4 border border-[#87565b] bg-[#87565b] px-4 py-2.5 text-xs tracking-wide text-[#fff8f0] disabled:opacity-50"><Sparkles size={13} className="mr-1 inline"/>现在生成一张</button>
          </section>
          <section className="mt-6 border-y border-[#d9c6b6] bg-[#fffaf2]/75 px-4 py-4">
            <div className="flex items-center justify-between gap-3"><h2 className="font-serif text-lg text-[#5a403b]">摆放模板</h2><span className="text-[10px] text-[#a18172]">LAYOUT STUDIES</span></div>
            <p className="mt-2 text-xs leading-5 text-[#8b7569]">选一个构图骨架，照片会按相对位置排列；原始照片与内容不会被删除。</p>
            <label className="mt-3 flex items-center justify-between gap-3 border-y border-[#e5d6c7] py-2.5 text-xs text-[#6d594b]">
              <span className="min-w-0"><span className="block">填充内部</span><span className="mt-0.5 block text-[10px] leading-4 text-[#9a8776]">从中心向外铺满形状，而不是只摆边缘；任意形状都适用，照片重叠面积不超过较小照片的 20%。</span></span>
              <input type="checkbox" checked={templateFill} onChange={event => { const next = event.target.checked; setTemplateFill(next); saveTemplateFill(next); }} className="h-4 w-4 shrink-0 accent-[#87565b]"/>
            </label>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
              {listAllTemplates().map(template => <div key={template.id} className="min-w-0 border-b border-[#eadfd3] py-2.5">
                <button type="button" onClick={() => applyTemplate(template.id)} className="block w-full text-left font-serif text-sm leading-5 text-[#5d4942] hover:text-[#87565b]">{template.name}</button>
                <div className="mt-2 flex items-center gap-3 text-[11px] text-[#9a8174]">
                  {!template.builtin && <><button type="button" onClick={() => setEditingTemplateId(current => current === template.id ? null : template.id)} className="underline decoration-[#d7c2b1] underline-offset-4" aria-label={"编辑模板骨架 " + template.name}>编辑骨架</button><button type="button" onClick={() => deleteCustomTemplate(template.id)} className="underline decoration-[#d7c2b1] underline-offset-4">删除</button></>}
                  {template.builtin && <span>内置模板</span>}
                </div>
              </div>)}
            </div>
            <div className="mt-3 flex flex-col gap-2 border-t border-[#eadfd3] pt-3 sm:flex-row">
              <input value={templateName} onChange={event => setTemplateName(event.target.value.slice(0, 32))} placeholder="给当前布局命名" className="min-w-0 flex-1 border-b border-[#d7c2b1] bg-transparent px-1 py-2 text-sm text-[#5d4942] outline-none focus:border-[#87565b]"/>
              <button type="button" onClick={saveCurrentLayoutAsTemplate} disabled={!photos.length} className="shrink-0 border border-[#d7c2b1] px-3 py-2 text-xs text-[#79545a] disabled:opacity-40"><Check size={12} className="mr-1 inline"/>保存当前布局为模板</button>
            </div>
            {editingTemplateId && customTemplates.find(template => template.id === editingTemplateId) && (() => { const template=customTemplates.find(item=>item.id===editingTemplateId)!; return <div className="mt-4 border-t border-[#d9c6b6] pt-4"><div className="flex items-center justify-between gap-2"><div className="min-w-0"><p className="font-serif text-sm text-[#5d4942]">编辑骨架 · {template.name}</p><p className="mt-1 text-[10px] leading-5 text-[#8b7569]">调整槽位相对位置、大小与倾斜角度。</p></div><button type="button" onClick={() => setEditingTemplateId(null)} aria-label="关闭骨架编辑" className="px-2 py-1 text-[#87565b]"><X size={13}/></button></div><div className="mt-3 max-h-56 space-y-3 overflow-y-auto pr-1">{template.slots.map((slot,index)=><div key={index} className="border-b border-[#eadfd3] pb-3"><div className="mb-2 text-[11px] text-[#8b7569]">照片槽位 {index+1}</div><div className="grid grid-cols-2 gap-x-3 gap-y-2">{([["x","横向",0.06,0.94,0.01],["y","纵向",0.06,0.94,0.01],["scale","大小",0.35,3,0.05],["rotation","旋转",-45,45,1]] as const).map(([key,label,min,max,step])=><label key={key} className="min-w-0 text-[10px] text-[#8f7c66]"><span className="mb-1 flex items-center justify-between gap-1"><span>{label}</span><span className="font-mono text-[#6d5b47]">{slot[key].toFixed(2)}</span></span><input type="range" min={min} max={max} step={step} value={slot[key]} onChange={event=>updateTemplateSlot(template.id,index,key,Number(event.target.value))} className="w-full accent-[#87565b]"/></label>)}</div></div>)}</div></div>; })()}
          </section>
        </div>
      </div> : (wallView === "edit" || wallView === "panorama") ? <>
      {wallView === "edit" && <div className="mx-4 flex min-h-10 items-center justify-between border-b border-[#d9c6b6] px-1 py-2 sm:mx-7"><span className="font-serif text-sm tracking-wide text-[#5d4942]">在墙上，慢慢摆好这些瞬间</span><span className="text-[10px] text-[#a18172]">{visiblePhotos.length} 张 · 可拖动微调</span></div>}
      {wallView === "edit" && <nav className="sticky top-0 z-10 flex min-h-11 items-center gap-5 overflow-x-auto border-b border-[#e4dbce]/80 bg-[#f7efe5]/95 px-4 py-2 sm:px-7">
        {([{id:"all",label:"全部照片"},{id:"mine",label:"我收藏的"},{id:"characters",label:"角色留下的"}] as {id:Filter;label:string}[]).map(item => <button key={item.id} onClick={() => setFilter(item.id)} className={`shrink-0 border-b-2 px-0.5 py-2 text-xs font-medium tracking-wide transition duration-200 ${filter===item.id?"border-[#87565b] text-[#87565b]":"border-transparent text-[#8d7e6b] hover:text-[#70434a]"}`}>{item.label}</button>)}
      </nav>}
      <section className={wallView === "panorama" ? "flex flex-1 min-h-0 flex-col overflow-hidden p-0" : "flex flex-1 min-h-0 flex-col overflow-hidden px-3 pb-0 pt-3 sm:px-6"}>
        {wallView === "edit" && <>
          <div className="relative z-20 mb-2 flex min-h-10 shrink-0 min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap border-b border-[#e2d2c3] bg-[#f7efe5] px-1 py-2">
            <p className="shrink-0 font-serif text-sm text-[#5d4942]">自由画布</p><span className="shrink-0 text-[10px] text-[#9b8774]">{visiblePhotos.length} 张</span>
            <button type="button" onClick={undo} disabled={!canUndo} className="shrink-0 border border-[#d8c6b5] px-2 py-1.5 text-[10px] text-[#7d6d5a] disabled:opacity-30">撤销</button>
            <button type="button" onClick={redo} disabled={!canRedo} className="shrink-0 border border-[#d8c6b5] px-2 py-1.5 text-[10px] text-[#7d6d5a] disabled:opacity-30">重做</button>
            <button type="button" onClick={() => { setWallCanvasMode(wallCanvasMode === "move" ? "view" : "move"); setWallSticker(null); setWallEraser(false); }} aria-pressed={wallCanvasMode === "move"} className={wallCanvasMode === "move" ? "shrink-0 border border-[#87565b] bg-[#87565b] px-2.5 py-1.5 text-[11px] text-white" : "shrink-0 border border-[#d8c6b5] px-2.5 py-1.5 text-[11px] text-[#7d6d5a]"}>{wallCanvasMode === "move" ? "完成摆放" : "摆照片"}</button>
            <button type="button" onClick={() => { setWallCanvasMode(wallCanvasMode === "doodle" ? "view" : "doodle"); setWallSticker(null); setWallEraser(false); }} aria-pressed={wallCanvasMode === "doodle"} className={wallCanvasMode === "doodle" ? "shrink-0 border border-[#a77b77] bg-[#a77b77] px-2.5 py-1.5 text-[11px] text-white" : "shrink-0 border border-[#d8c6b5] px-2.5 py-1.5 text-[11px] text-[#7d6d5a]"}>{wallCanvasMode === "doodle" ? "退出涂鸦" : "涂鸦"}</button>
            <button type="button" onClick={() => void askCharacterToDecorateWall()} disabled={busy || !selectedCharacter || !visiblePhotos.length} title={selectedCharacter ? `邀请 ${selectedCharacter.name} 装饰照片墙` : "请先在设置中选择角色"} className="shrink-0 border border-[#d8c6b5] bg-[#fffaf2] px-2.5 py-1.5 text-[11px] text-[#87565b] disabled:opacity-35"><Sparkles size={12} className="mr-1 inline"/>角色涂鸦</button>
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-[#8b7665]">宽<input type="number" min={1200} max={12000} step={100} value={wallWidthDraft} onChange={event => setWallWidthDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") applyWallDimensions(); }} aria-label="画布宽度" className="w-[62px] border-b border-[#d8c6b5] bg-transparent px-1 py-1 text-[11px] text-[#5d4942] outline-none"/></label>
            <label className="flex shrink-0 items-center gap-1 text-[10px] text-[#8b7665]">高<input type="number" min={1200} max={12000} step={100} value={wallHeightDraft} onChange={event => setWallHeightDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter") applyWallDimensions(); }} aria-label="画布高度" className="w-[62px] border-b border-[#d8c6b5] bg-transparent px-1 py-1 text-[11px] text-[#5d4942] outline-none"/></label>
            <button type="button" onClick={applyWallDimensions} className="shrink-0 border border-[#d8c6b5] px-2.5 py-1.5 text-[10px] text-[#7d6d5a]">应用尺寸</button>
          </div>
          {wallCanvasMode === "doodle" && <div className="relative z-20 mb-2 flex max-h-[28dvh] shrink-0 flex-wrap items-center gap-2 overflow-y-auto border-b border-[#e6d9cb] bg-[#fffaf2] px-2 py-2">
            {wallBrushPalette.map(color => <button key={color} type="button" aria-label={"画笔颜色 "+color} title={"画笔颜色 "+color} onClick={() => { setWallBrushColor(color); setWallColorDraft(color); setWallSticker(null); setWallEraser(false); }} className={wallBrushColor===color&&!wallSticker&&!wallEraser?"h-5 w-5 border border-[#6b5c4a] ring-2 ring-[#e7d6c6]":"h-5 w-5 border border-white/70"} style={{background:color}}/>)}
            <label className="flex items-center gap-1 text-[10px] text-[#8b7665]">色号
              <input type="color" value={/^#[0-9a-f]{6}$/i.test(wallColorDraft) ? wallColorDraft : wallBrushColor} onChange={event => { setWallColorDraft(event.target.value); setWallBrushColor(event.target.value); setWallSticker(null); setWallEraser(false); }} aria-label="选择涂鸦颜色" className="h-6 w-7 cursor-pointer border-0 bg-transparent p-0"/>
              <input type="text" value={wallColorDraft} onChange={event => setWallColorDraft(event.target.value)} placeholder="#c2705a" aria-label="输入涂鸦颜色十六进制色号" className="w-[78px] border-b border-[#d8c6b5] bg-transparent px-1 py-1 text-[10px] uppercase text-[#5d4942] outline-none"/>
            </label>
            <button type="button" onClick={() => {
              const value = wallColorDraft.trim().startsWith("#") ? wallColorDraft.trim().toLowerCase() : "#" + wallColorDraft.trim().toLowerCase();
              if (!/^#[0-9a-f]{6}$/i.test(value)) { onNotice?.("色号格式应为 #RRGGBB，例如 #d98ca3。"); return; }
              setWallBrushColor(value); setWallColorDraft(value); setWallBrushPalette(current => current.includes(value) ? current : [...current, value].slice(-20)); setWallSticker(null); setWallEraser(false);
            }} className="border border-[#d8c6b5] px-2 py-1 text-[10px] text-[#7d6d5a]">添加色号</button>
            <button type="button" onClick={() => {
              const value = wallColorDraft.trim().startsWith("#") ? wallColorDraft.trim().toLowerCase() : "#" + wallColorDraft.trim().toLowerCase();
              if (!/^#[0-9a-f]{6}$/i.test(value)) { onNotice?.("色号格式应为 #RRGGBB，例如 #d98ca3。"); return; }
              const oldIndex = Math.max(0, wallBrushPalette.indexOf(wallBrushColor));
              setWallBrushPalette(current => { const next = [...current]; if (!next.length) return [value]; next[Math.min(oldIndex, next.length - 1)] = value; return Array.from(new Set(next)).slice(0, 20); });
              setWallBrushColor(value); setWallColorDraft(value); setWallSticker(null); setWallEraser(false);
            }} className="border border-[#d8c6b5] px-2 py-1 text-[10px] text-[#7d6d5a]">替换当前色块</button>
            <span className="text-[10px] text-[#8b7665]">{wallSticker ? "贴纸大小" : "画笔粗细"}</span>
            {[2,3,5,8].map(width => { const presetStickerSize = stickerSizeFromBrushWidth(width); const active = wallSticker ? wallStickerSize === presetStickerSize : wallBrushWidth === width; return <button key={width} type="button" onClick={() => { if (wallSticker) { setWallStickerSize(presetStickerSize); setWallSizeDraft(String(presetStickerSize)); } else { setWallBrushWidth(width); setWallSizeDraft(String(width)); } }} aria-label={wallSticker ? `贴纸大小 ${presetStickerSize} 像素` : `画笔粗细 ${width}`} title={wallSticker ? `贴纸大小：${presetStickerSize}px` : `画笔粗细：${width}`} aria-pressed={active} className={active?"border border-[#6b5c4a] bg-[#6b5c4a] px-2 py-1 text-[10px] text-white":"border border-[#d8c6b5] px-2 py-1 text-[10px] text-[#7d6d5a]"}>{wallSticker ? presetStickerSize : width}</button>; })}
            <label className="inline-flex items-center gap-1 text-[10px] text-[#8b7665]">
              自定义
              <input type="number" inputMode="numeric" min={wallSticker ? 12 : 1} max={wallSticker ? 144 : 64} step={wallSticker ? 1 : 0.5}
                value={wallSizeDraft}
                onChange={event => setWallSizeDraft(event.target.value)}
                onBlur={() => {
                  const parsed = Number(wallSizeDraft);
                  const min = wallSticker ? 12 : 1;
                  const max = wallSticker ? 144 : 64;
                  if (!Number.isFinite(parsed) || wallSizeDraft.trim() === "") {
                    setWallSizeDraft(String(wallSticker ? wallStickerSize : wallBrushWidth));
                    return;
                  }
                  const next = Math.max(min, Math.min(max, parsed));
                  if (wallSticker) setWallStickerSize(next);
                  else setWallBrushWidth(next);
                  setWallSizeDraft(String(next));
                }}
                aria-label={wallSticker ? "自定义贴纸大小（像素）" : "自定义画笔粗细"}
                className="w-[54px] border-b border-[#d8c6b5] bg-transparent px-1 py-1 text-[10px] text-[#5d4942] outline-none"/>
              <span>{wallSticker ? "px" : "单位"}</span>
            </label>
            {["heart","✦","✿","☾","☘","♪","★","⌘"].map(item => <button key={item} type="button" aria-label={item === "heart" ? "心形贴纸" : item} onClick={() => {setWallSticker(wallSticker===item?null:item);setWallEraser(false)}} aria-pressed={wallSticker===item} className={wallSticker===item?"bg-[#6b5c4a] px-1.5 py-1 text-white":"bg-white/70 px-1.5 py-1 text-[#7d6d5a]"}>{item === "heart" ? <svg viewBox="-8 -8 16 16" width="14" height="14" aria-hidden="true"><path d="M0,6 C-1.4,3.8 -6,1 -6,-2 C-6,-5 -3,-6 0,-4 C3,-6 6,-5 6,-2 C6,1 1.4,3.8 0,6 Z" fill="currentColor"/></svg> : item}</button>)}
            <span className="ml-1 inline-flex items-center gap-1 border border-[#d8c6b5] bg-white/70 px-1.5 py-1 text-[10px] text-[#7d6d5a]">
              贴纸角度
              <button type="button" aria-label="贴纸左转 15 度" onClick={() => setWallStickerRotation(value => Math.max(-180, value - 15))} className="px-1 text-[12px]">−</button>
              <span className="min-w-8 text-center tabular-nums">{wallStickerRotation}°</span>
              <button type="button" aria-label="贴纸右转 15 度" onClick={() => setWallStickerRotation(value => Math.min(180, value + 15))} className="px-1 text-[12px]">+</button>
            </span>
            <button type="button" onClick={() => {setWallEraser(!wallEraser);setWallSticker(null)}} aria-pressed={wallEraser} className={wallEraser?"bg-[#a06a58] px-2 py-1 text-[10px] text-white":"border border-[#d8c6b5] px-2 py-1 text-[10px] text-[#7d6d5a]"}>橡皮</button>
            <button type="button" onClick={() => {if(wallSelectedPhoto) changeDoodles(wallSelectedPhoto.id,[])}} disabled={!wallSelectedPhoto?.doodles?.length} className="border-b border-[#e0c8bd] px-1 py-1 text-[10px] text-[#a06a58] disabled:opacity-35">清空照片涂鸦</button>
            <button type="button" onClick={() => changeWallDoodles([])} disabled={!(state.wallDoodles?.length)} className="border-b border-[#e0c8bd] px-1 py-1 text-[10px] text-[#a06a58] disabled:opacity-35">清空墙面涂鸦</button>
          </div>}
          {wallCanvasMode === "move" && wallSelectedPhoto && <div className="mb-2 flex flex-wrap items-center gap-1.5 border-b border-[#e6d9cb] bg-[#fffaf2]/85 px-2 py-2">
            <span className="mr-1 max-w-[100px] truncate text-[10px] text-[#8b7665]">{wallSelectedPhoto.title || "已选照片"}</span>
            <button type="button" onClick={() => patchWallSelectedPlacement({scale:Math.max(.35,(wallSelectedPhoto.placement?.scale??1)-.12)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">缩小 −</button>
            <button type="button" onClick={() => patchWallSelectedPlacement({scale:Math.min(3,(wallSelectedPhoto.placement?.scale??1)+.12)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">放大 +</button>
            <button type="button" onClick={() => patchWallSelectedPlacement({rotation:Math.max(-45,(wallSelectedPhoto.placement?.rotation??0)-3)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">左转</button>
            <button type="button" onClick={() => patchWallSelectedPlacement({rotation:Math.min(45,(wallSelectedPhoto.placement?.rotation??0)+3)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">右转</button>
            {([{key:"polaroid",label:"拍立得",color:"#fffdf8"},{key:"thin",label:"细框",color:"#fffdf8"},{key:"wood",label:"木框",color:"#d8c1a0"},{key:"tape",label:"胶带",color:"#fff4d7"},{key:"none",label:"无框",color:"transparent"}] as {key:PhotoWallPlacement["frame"];label:string;color:string}[]).map(frame=><button key={frame.key} type="button" aria-pressed={(wallSelectedPhoto.placement?.frame??"polaroid")===frame.key} onClick={() => patchWallSelectedPlacement({frame:frame.key,frameColor:frame.color})} className={(wallSelectedPhoto.placement?.frame??"polaroid")===frame.key?"border border-[#87565b] bg-[#f4e6e6] px-2 py-1 text-[10px] text-[#87565b]":"border border-[#d7c2b1] px-2 py-1 text-[10px] text-[#7d6d5a]"}>{frame.label}</button>)}
            <button type="button" onClick={() => patchWallSelectedPlacement({locked:!wallSelectedPhoto.placement?.locked})} className={wallSelectedPhoto.placement?.locked?"border border-[#87565b] bg-[#87565b] px-2 py-1 text-[10px] text-white":"border border-[#d7c2b1] px-2 py-1 text-[10px] text-[#7d6d5a]"}>{wallSelectedPhoto.placement?.locked?"解锁":"锁定"}</button>
            <button type="button" onClick={() => patchWallSelectedPlacement({z:-1})} className="border border-[#d7c2b1] px-2 py-1 text-[10px]">置顶</button>
          </div>}
          {wallCanvasMode === "view" && wallSelectedPhoto && <div className="relative z-40 mb-2 flex shrink-0 items-center justify-between gap-2 border-b border-[#e6d9cb] px-2 py-1.5"><span className="min-w-0 truncate text-[10px] text-[#8b7665]">已选：{wallSelectedPhoto.title||"未命名的瞬间"}</span><button type="button" onClick={() => openPhoto(wallSelectedPhoto)} className="shrink-0 border border-[#d7c2b1] px-2.5 py-1.5 text-[10px] text-[#7d6d5a]">查看详情</button></div>}
        </>}
        {wallView === "panorama" && wallCanvasMode === "move" && wallSelectedPhoto && <div data-photo-wall-panorama-placement-toolbar className="relative z-30 flex shrink-0 flex-wrap items-center gap-1.5 border-b border-[#e6d9cb] bg-[#fffaf2]/95 px-2 py-2">
          <span className="mr-1 max-w-[88px] truncate text-[10px] text-[#8b7665]">{wallSelectedPhoto.title || "已选照片"}</span>
          <button type="button" onClick={() => patchWallSelectedPlacement({scale:Math.max(.35,(wallSelectedPhoto.placement?.scale??1)-.12)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">缩小 −</button>
          <button type="button" onClick={() => patchWallSelectedPlacement({scale:Math.min(3,(wallSelectedPhoto.placement?.scale??1)+.12)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">放大 +</button>
          <button type="button" onClick={() => patchWallSelectedPlacement({rotation:Math.max(-45,(wallSelectedPhoto.placement?.rotation??0)-3)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">左转</button>
          <button type="button" onClick={() => patchWallSelectedPlacement({rotation:Math.min(45,(wallSelectedPhoto.placement?.rotation??0)+3)})} className="border-b border-[#d7c2b1] px-2 py-1 text-[11px]">右转</button>
          <button type="button" onClick={() => patchWallSelectedPlacement({locked:!wallSelectedPhoto.placement?.locked})} className={wallSelectedPhoto.placement?.locked?"border border-[#87565b] bg-[#87565b] px-2 py-1 text-[10px] text-white":"border border-[#d7c2b1] px-2 py-1 text-[10px] text-[#7d6d5a]"}>{wallSelectedPhoto.placement?.locked?"解锁":"锁定"}</button>
          <button type="button" onClick={() => setWallCanvasMode("view")} className="ml-auto border border-[#d7c2b1] px-2 py-1 text-[10px] text-[#7d6d5a]">完成</button>
        </div>}
        {busy && <div className="mb-3 flex shrink-0 items-center gap-2 border border-[#e4d8c6] bg-[#faf7f0] px-3 py-2.5 text-xs text-[#83725d]"><LoaderCircle size={15} className="animate-spin"/>{busyLabel || "请稍候…"}</div>}
        <div
          ref={panoramaViewportRef}
          data-photo-wall-viewport
          className="relative min-h-[320px] flex-1 w-full overflow-hidden bg-[#e9dfd2]"
          style={{ touchAction: "none", overscrollBehavior: "contain", height: "100%", flexBasis: 0 }}
        >

          <div
            ref={worldStageRef}
            data-photo-wall-world-stage
            className="absolute left-0 top-0"
            style={{
              // Explicit world dimensions are essential: this is the positioning stage
              // for the entire canvas, not a shrink-to-fit overlay.
              width: world.width,
              height: world.height,
              // Avoid forcing a huge 2400–12000px world into a single GPU-composited 3D layer.
              transform: "translate(" + panRef.current.x + "px," + panRef.current.y + "px) scale(" + (panoramaZoomRef.current / 100) + ")",
              transformOrigin: "top left",
              touchAction: "none",
              overflow: "visible",
            }}
          >
            <PhotoWallCanvas photos={visiblePhotos} selectedId={wallActivePhotoId} onSelect={setWallActivePhotoId}
              onChangePlacement={changePlacement} onPlacementSettled={settlePlacement}
              onDragBegin={() => pushHistory(stateRef.current)} onUndo={undo} onRedo={redo}
              canUndo={canUndo} canRedo={canRedo} onChangeDoodles={(id, doodles, side) => changeDoodles(id, doodles, side)}
              wallDoodles={state.wallDoodles ?? []} onChangeWallDoodles={changeWallDoodles}
              backgroundImage={wallBackgroundUrl} backgroundBox={state.wallBackgroundBox}
              wallWorld={world} canvasZoom={panoramaZoom / 100} readOnly={wallView === "panorama"}
              mode={wallCanvasMode} onModeChange={handleWallCanvasModeChange}
              brushColor={wallBrushColor} brushWidth={wallBrushWidth} stickerSize={wallStickerSize}
              sticker={wallSticker} onStickerChange={setWallSticker} stickerRotation={wallStickerRotation}
              eraser={wallEraser} onEraserChange={setWallEraser}
              onOpenDetail={photo => openPhoto(photo, false)} />
          </div>
        </div>
      </section>
      </> : wallView === "creations" ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4 sm:px-7" style={{WebkitOverflowScrolling:"touch"}}>
        <div className="mx-auto max-w-3xl">
          <div className="mb-5 border-b border-[#d8c4b4] pb-4">
            <p className="text-[10px] tracking-[.22em] text-[#a18172]">LITTLE THINGS WE MADE TOGETHER</p>
            <h2 className="mt-2 font-serif text-2xl font-normal text-[#5d4942]">把每一笔心意都留在这里</h2>
            <p className="mt-2 text-xs leading-6 text-[#8b7569]">这里保存每次角色创作的时间、作者、原始笔迹和关联照片。即使之后清理或修改墙面，记录里的笔迹快照也会保留。</p>
          </div>
          {(state.creationRecords ?? []).length ? <div className="space-y-5">
            {[...(state.creationRecords ?? [])].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(record => {
              const linkedPhotos = record.photoIds.map(id => state.photos.find(photo => photo.id === id)).filter((photo): photo is PhotoWallPhoto => Boolean(photo));
              return <details key={record.id} className="overflow-hidden border border-[#dfcbb8] bg-[#fffaf2] shadow-[0_8px_22px_rgba(92,68,48,.08)]">
                <summary className="cursor-pointer list-none px-4 py-3 text-[#5d4942]"><span className="font-serif text-sm">{record.authorName} 的小小创作</span><span className="mt-1 block text-[10px] text-[#a08c74]">{new Date(record.createdAt).toLocaleString("zh-CN",{month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"})} · {record.doodles.length} 笔心意 · 点按展开</span></summary>
                <article className="border-t border-[#eadbc9]">
                <header className="flex items-start gap-3 border-b border-[#eadbc9] px-4 py-3">
                  <span className="grid h-10 w-10 shrink-0 place-items-center border border-[#d9b9ae] bg-[#f8e9e6] font-serif text-[#87565b]">{record.authorName.slice(0,1)}</span>
                  <div className="min-w-0 flex-1">
                    <div className="font-serif text-sm text-[#5d4942]">{record.authorName} 的小小创作</div>
                    <time className="mt-1 block text-[10px] tracking-wide text-[#a08c74]">{new Date(record.createdAt).toLocaleString("zh-CN",{year:"numeric",month:"long",day:"numeric",hour:"2-digit",minute:"2-digit"})}</time>
                  </div>
                  <span className="shrink-0 border-b border-[#d8c4b4] px-1 py-1 text-[10px] text-[#a18172]">{record.doodles.length} 笔心意</span>
                </header>
                <div className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(140px,.72fr)]">
                  <div>
                    <p className="whitespace-pre-wrap break-words font-serif text-sm leading-7 text-[#665246]">{record.narrative}</p>
                    <div className="mt-4 flex flex-wrap gap-2 text-[10px] text-[#9b8774]">
                      <span className="border border-[#eadbc9] px-2 py-1">{record.authorType === "character" ? "角色创作" : "共同创作"}</span>
                      <span className="border border-[#eadbc9] px-2 py-1">{record.doodles.filter(item => item.kind === "stroke").length} 条笔迹</span>
                      <span className="border border-[#eadbc9] px-2 py-1">{record.doodles.filter(item => item.kind === "sticker").length} 个贴纸</span>
                    </div>
                  </div>
                  <div className="min-h-[130px] border border-[#e8d7c5] bg-[#f8f0e5] p-2">
                    {record.layers?.length ? <div className="grid grid-cols-2 gap-2">
                      {record.layers.map((layer, layerIndex) => {
                        const layerPhoto = layer.kind === "photo" ? linkedPhotos.find(photo => photo.id === layer.photoId) : undefined;
                        const label = layer.kind === "wall" ? "墙面涂鸦" : (layerPhoto?.title || "关联照片") + (layer.side === "back" ? " · 背面" : " · 正面");
                        return <CreationLayerPreview key={record.id + "-layer-" + layerIndex} photo={layerPhoto} side={layer.kind === "photo" ? layer.side : undefined} doodles={layer.doodles} label={label} onOpen={layerPhoto ? () => openPhoto(layerPhoto) : undefined}/>;
                      })}
                    </div> : <div className="grid grid-cols-2 gap-2">
                      {linkedPhotos.slice(0, 4).map(photo => <div key={photo.id} className="min-w-0"><PhotoThumbnail photo={photo} onOpen={() => openPhoto(photo)}/></div>)}
                      {!linkedPhotos.length && <div className="col-span-2 grid min-h-[126px] place-items-center text-[11px] text-[#9b8774]">旧版涂鸦记录</div>}
                      <p className="col-span-2 text-[9px] leading-relaxed text-[#a08c74]">{record.doodles.length ? "旧版记录未保存每张照片对应的笔迹坐标。这里单独展示关联照片，避免把不同照片上的笔迹叠在一起；原始笔迹仍完整保留在记录中。" : "本次创作没有附加涂鸦，关联照片单独展示。"}</p>
                    </div>}
                  </div>
                </div>
                <footer className="border-t border-[#eadbc9] px-4 py-3">
                  <div className="mb-2 text-[10px] tracking-wide text-[#a08c74]">关联照片</div>
                  {linkedPhotos.length ? <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{linkedPhotos.map(photo => <div key={photo.id} className="min-w-0"><PhotoThumbnail photo={photo} onOpen={() => openPhoto(photo)}/><p className="mt-1 truncate text-[10px] text-[#806b58]">{photo.title || "未命名的瞬间"}</p></div>)}</div> : <p className="text-xs text-[#9a8776]">这次创作没有准确匹配到单张照片，笔迹已单独保存。</p>}
                </footer>
                </article>
              </details>;
            })}
          </div> : <div className="grid min-h-[40dvh] place-items-center border border-dashed border-[#d8c4b4] bg-[#fffaf2]/60 px-5 text-center">
            <div><Feather size={30} className="mx-auto text-[#b18c7d]"/><h3 className="mt-3 font-serif text-lg text-[#6b5547]">还没有共同创作记录</h3><p className="mt-2 max-w-sm text-xs leading-6 text-[#9a8776]">在编辑墙面中点击「角色涂鸦」，角色留下的每一笔、创作时间和关联照片都会保存到这里。</p><button type="button" onClick={() => setWallView("edit")} className="mt-4 border-b border-[#bda28d] px-2 py-2 text-sm text-[#87565b]">去邀请角色创作</button></div>
          </div>}
        </div>
      </div> : wallView === "album" ? <PhotoAlbumView
        albums={albums}
        photos={photos}
        activeAlbumId={activeAlbumId}
        activePage={activeAlbumPage}
        editMode={albumEditMode}
        onSaveAlbums={setAlbums}
        onSelectAlbum={setActiveAlbumId}
        onSelectPage={setActiveAlbumPage}
        onSetEditMode={setAlbumEditMode}
        onOpenPhoto={photo => openPhoto(photo)}
        onNotice={onNotice}
      /> : wallView === "memories" ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-4 sm:px-7" style={{WebkitOverflowScrolling:"touch"}}>
        {photos.length ? <div className="mx-auto grid max-w-3xl grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {photos.map(photo => <article key={photo.id} className="min-w-0 border border-[#e3d3c1] bg-[#fffdf8] p-2 pb-3 shadow-[2px_5px_12px_rgba(70,55,40,.10)]">
            <PhotoThumbnail photo={photo} onOpen={() => openPhoto(photo)}/>
            <button type="button" onClick={() => openPhoto(photo)} className="mt-2 block w-full break-words text-center font-serif text-sm leading-5 text-[#655342]">{photo.title || "未命名的瞬间"}</button>
            <p className="mt-1 text-center text-[10px] tracking-wide text-[#a08c74]">{formatDate(photo.capturedAt || photo.createdAt)}</p>
          </article>)}
        </div> : <div className="grid min-h-[45dvh] place-items-center text-center text-[#8f806d]"><div><Feather size={28} className="mx-auto"/><p className="mt-3">还没有收录的回忆</p><button type="button" onClick={() => { setWallView("edit"); setShowAddMenu(true); }} className="mt-3 border-b border-[#bda28d] px-2 py-2 text-sm">添加第一张照片</button></div></div>}
      </div> : <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4 sm:px-7" style={{WebkitOverflowScrolling:"touch"}}>
        <div className="sticky top-0 z-20 mx-auto mb-4 flex max-w-4xl flex-wrap items-center gap-2 border-b border-[#d8c4b4] bg-[#f3eadc]/95 px-2 py-2 backdrop-blur">
          <span className="shrink-0 text-[11px] text-[#8b7665]">日期区间</span>
          <label className="flex items-center gap-1 text-[10px] text-[#8b7665]">从<input type="date" value={timelineStartDate} max={timelineEndDate || undefined} onChange={event => setTimelineStartDate(event.target.value)} aria-label="开始日期" className="min-w-0 rounded-lg border border-[#d8c4b4] bg-[#fffaf1] px-2 py-1.5 text-xs text-[#6d5946]"/></label>
          <label className="flex items-center gap-1 text-[10px] text-[#8b7665]">到<input type="date" value={timelineEndDate} min={timelineStartDate || undefined} onChange={event => setTimelineEndDate(event.target.value)} aria-label="结束日期" className="min-w-0 rounded-lg border border-[#d8c4b4] bg-[#fffaf1] px-2 py-1.5 text-xs text-[#6d5946]"/></label>
          <button type="button" onClick={() => { setTimelineStartDate(""); setTimelineEndDate(""); }} className="border-b border-[#d8c4b4] px-1.5 py-1 text-[10px] text-[#8b7665]">清除日期</button>
          <label className="flex items-center gap-1 text-[10px] text-[#8b7665]">分组<select value={timelineGrouping} onChange={event => setTimelineGrouping(event.target.value as typeof timelineGrouping)} aria-label="时间轴分组方式" className="rounded-lg border border-[#d8c4b4] bg-[#fffaf1] px-2 py-1.5 text-xs text-[#6d5946]"><option value="photo">每张</option><option value="day">每天</option><option value="week">每周</option><option value="month">每月</option><option value="year">每年</option></select></label>
          <span className="ml-auto shrink-0 text-[10px] text-[#a18e7a]">{timelinePhotos.length} 张</span>
        </div>
        {timelinePhotos.length === 0 ? <div className="grid min-h-[55dvh] place-items-center text-center text-[#8f806d]"><div><Feather size={28} className="mx-auto"/><p className="mt-3">这个日期范围里还没有照片</p><p className="mt-1 text-xs">可以调整日期，或清除日期重新查看全部。</p></div></div> : <div className="relative mx-auto max-w-5xl space-y-5 before:absolute before:bottom-0 before:left-2 before:top-2 before:w-px before:bg-[#d8c4ab]">
          {timelineGroups.map(group => <section key={group.key} className="relative pl-8">
            <header className="relative z-10 mb-3 flex items-center justify-between gap-2 border-b border-[#d8c4b4] bg-[#f3eadc]/95 px-2 py-2">
              <span aria-hidden="true" className="absolute -left-[26px] top-3 h-3 w-3 rounded-full border-2 border-[#b88c82] bg-[#f3eadc] shadow-[0_0_0_3px_rgba(243,234,220,.9)]"/>
              <h2 className="font-serif text-base text-[#75624d]">{group.label}</h2><span className="shrink-0 text-[10px] text-[#a18e7a]">{group.items.length} 张</span>
            </header>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 sm:gap-3 lg:grid-cols-6">
              {group.items.map(photo => <article key={photo.id} className="min-w-0 border border-[#e3d3c1] bg-[#fffdf8] p-1.5 pb-2 shadow-[1px_3px_8px_rgba(70,55,40,.09)]">
                {timelineFlippedPhotoIds.has(photo.id) ? <button type="button" onClick={() => toggleTimelineFlip(photo.id)} aria-label="翻回照片正面" className="flex aspect-square w-full flex-col overflow-y-auto bg-[#fffaf2] p-2 text-left text-[#6b5947]">
                  <span className="border-b border-[#dfcfbe] pb-1 text-[8px] tracking-wide text-[#a58f77]">照片背面</span><span className="mt-1 break-words font-serif text-[10px] leading-snug">{photo.title || "未命名"}</span><span className="mt-1 whitespace-pre-wrap break-words text-[9px] leading-snug">{photo.backNote?.trim() || "背面还没有手记"}</span>
                </button> : <div className="aspect-square w-full overflow-hidden bg-[#e9dfd0]"><PhotoThumbnail photo={photo} onOpen={() => toggleTimelineFlip(photo.id)} /></div>}
                <button type="button" onClick={() => openPhoto(photo)} className="mt-1.5 block w-full truncate text-left font-serif text-[10px] leading-4 text-[#655342]">{photo.title || "未命名的瞬间"}</button>
                <p className="mt-0.5 truncate text-[9px] text-[#a08c74]">{formatDate(photo.capturedAt || photo.createdAt)}</p>
              </article>)}
            </div>
          </section>)}
        </div>}
      </div>}
    </main>

    {showChatPicker && <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#332c24]/40 p-4 backdrop-blur-sm" onClick={() => setShowChatPicker(false)}>
      <section className="flex max-h-[82%] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border border-[#e3d7c6] bg-[#fffaf1] shadow-xl" onClick={event => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-[#e3d7c6] px-4 py-3"><div><h2 className="font-serif text-lg">从聊天里挑一张</h2><p className="mt-1 text-[10px] text-[#9b8a75]">收藏会保留原图，不会把同一张媒体重复复制</p></div><button onClick={() => setShowChatPicker(false)} aria-label="关闭"><X size={17}/></button></header>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {chatCandidates.length ? <div className="space-y-2">{chatCandidates.map(candidate => <button key={candidate.key} onClick={() => void importChatPhoto(candidate)} className="flex w-full items-center gap-3 rounded-xl border border-[#e6dccd] bg-[#fcf9f2] p-3 text-left hover:bg-white"><ChatCandidateThumb refId={candidate.ref}/><span className="min-w-0 flex-1"><span className="block truncate text-sm text-[#655647]">{candidate.title}</span><span className="mt-1 block truncate text-[10px] text-[#9a8973]">{candidate.sessionName} · {new Date(candidate.createdAt).toLocaleDateString("zh-CN")}</span></span><Plus size={15} className="shrink-0 text-[#87565b]"/></button>)}</div> : <p className="py-10 text-center text-xs text-[#9a8973]">没有找到可收藏的照片。</p>}
        </div>
      </section>
    </div>}

    {selectedPhoto && <div className="absolute inset-0 z-50 flex items-center justify-center bg-[#332c24]/48 p-3 backdrop-blur-md" onClick={() => setSelectedPhotoId(null)}>
      <div className="relative flex max-h-[92dvh] w-full max-w-3xl flex-col overflow-hidden rounded-[20px] border border-white/70 bg-[#fffaf1] shadow-[0_24px_80px_rgba(20,15,10,.28)] sm:flex-row" onClick={event => event.stopPropagation()}>
        <button onClick={() => setSelectedPhotoId(null)} className="absolute right-2 top-2 z-10 grid h-8 w-8 place-items-center rounded-full bg-[#f7f2e8]/90 text-[#7c6b58]" aria-label="关闭"><X size={16}/></button>
        <div className="flex h-[34dvh] max-h-[34dvh] min-h-[140px] shrink-0 items-center justify-center overflow-hidden bg-[#e7dfd2] p-2 sm:h-auto sm:max-h-none sm:min-h-0 sm:w-1/2">
          <PhotoLarge refId={selectedPhoto.mediaRef} title={selectedPhoto.title}/>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-5 pt-6 sm:px-6 sm:pt-8" style={{ WebkitOverflowScrolling: "touch" }}>
          <div className="text-[10px] tracking-[.25em] text-[#aa987f]">{selectedPhoto.ownerName.toUpperCase()} · {KIND_LABEL[selectedPhoto.kind]}</div>
          {photoViewOnly ? <h2 className="mt-3 font-serif text-xl text-[#5b4d3e]">{selectedPhoto.title || "未命名的瞬间"}</h2> : <input value={editTitle} onChange={event => setEditTitle(event.target.value)} className="mt-3 w-full border-b border-[#dfd3c1] bg-transparent pb-2 font-serif text-xl text-[#5b4d3e] outline-none focus:border-[#9e8b70]" placeholder="给这张照片起个名字"/>}
          <div className="mt-2 space-y-1 text-[10px] tracking-wider text-[#a39583]">
            <p>上传 / 收录时间：{formatDate(selectedPhoto.createdAt)}</p>
            <p>拍摄时间：{selectedPhoto.capturedAt ? formatDate(selectedPhoto.capturedAt) : "尚未记录；时间轴会归入“拍摄时间未记录”分组"}</p>
          </div>
          {!photoViewOnly && <label className="mt-3 block text-xs text-[#857460]">拍摄日期与时间
            <input type="datetime-local" value={editCapturedAt} onChange={event => setEditCapturedAt(event.target.value)} className="mt-1 w-full border-b border-[#dfd3c1] bg-transparent px-1 py-2 text-xs text-[#5b4d3e] outline-none"/>
            <span className="mt-1 block text-[10px] leading-5 text-[#a39583]">只修改拍摄时间；上传 / 收录时间保持不变。没有 EXIF 信息时可以手动补齐。</span>
          </label>}
          {photoViewOnly && <button type="button" onClick={() => { setPhotoViewOnly(false); setEditTitle(selectedPhoto.title); setEditNote(getPhotoBackText(selectedPhoto)); setEditTags(selectedPhoto.tags.join("、")); setEditCapturedAt(formatDateTimeInput(selectedPhoto.capturedAt)); }} className="mt-3 self-start rounded-full border border-[#cbbba6] px-3 py-2 text-xs text-[#796952]">编辑这张照片</button>}
          <div className="mt-5 border-t border-[#e3d7c6] pt-3 font-serif text-base text-[#655342]">照片背面 · 手记与留言</div>
          {photoViewOnly ? <p className="mt-2 whitespace-pre-wrap rounded-sm bg-[#fcf9f2] p-3 font-serif text-sm leading-6 text-[#655647]">{getPhotoBackText(selectedPhoto) || selectedPhoto.caption || "还没有写下手记或留言。"}</p> : <textarea value={editNote} onChange={event => setEditNote(event.target.value)} rows={7} placeholder="把手记、你留下的话和角色回应都写在这里；它们共用这张照片的背面。" className="mt-2 w-full resize-y rounded-sm border border-[#e6dccd] bg-[#fcf9f2] p-3 font-serif text-sm leading-6 text-[#655647] outline-none placeholder:text-[#c1b5a4] focus:border-[#b5a18a]"/>}
          <label className="mt-3 block text-[10px] tracking-[.2em] text-[#9a8973]">标签 · TAGS</label>
          {photoViewOnly ? <p className="mt-2 text-xs text-[#8d7a65]">{selectedPhoto.tags.length ? selectedPhoto.tags.map(tag => `#${tag}`).join("　") : "暂无标签"}</p> : <input value={editTags} onChange={event => setEditTags(event.target.value)} placeholder="用逗号分隔，比如：雨天、回家、幸福" className="mt-2 w-full rounded-sm border border-[#e6dccd] bg-[#fcf9f2] px-3 py-2 text-xs outline-none focus:border-[#b5a18a]"/>}
          {!photoViewOnly && <><label className="mt-3 flex items-center gap-2 text-xs text-[#857460]"><input type="checkbox" checked={selectedPhoto.shareWithCharacters} onChange={event => { const currentState = stateRef.current; persist({ ...currentState, photos: currentState.photos.map(photo => photo.id === selectedPhoto.id ? { ...photo, shareWithCharacters: event.target.checked } : photo) }); }} className="accent-[#87565b]"/>允许角色看到这张照片及背面记录</label>
          <div className="mt-4 flex gap-2"><button onClick={saveBack} className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#87565b] px-3 py-2.5 text-xs tracking-wider text-white"><Check size={14}/>保存背面</button><button onClick={() => void deleteSelectedPhoto()} className="grid h-10 w-10 place-items-center rounded-full border border-[#e3d7c6] text-[#9c7566]" aria-label="删除照片"><Trash2 size={15}/></button></div></>}
          {!photoViewOnly && <div className="mt-4 rounded-xl bg-[#eee7db] p-3">
            <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-[#85745f]">请角色也来看看</span><select value={characterCommenterId} onChange={event => setCharacterCommenterId(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-[#ded1bf] bg-[#faf6ee] px-2 py-2 text-xs">{characters.map(char => <option key={char.id} value={char.id}>{char.name}</option>)}</select></div>
            <button onClick={() => void askCharacterToWrite()} disabled={busy || !commenter || !selectedPhoto.shareWithCharacters} className="mt-2 flex w-full items-center justify-center gap-2 rounded-full bg-[#87565b] px-3 py-2.5 text-xs tracking-wider text-white disabled:opacity-40"><Heart size={13}/>请 TA 把一句话写进同一张背面</button>
            {!selectedPhoto.shareWithCharacters && <p className="mt-2 text-[10px] text-[#9a7967]">这张照片目前不对角色开放。打开上方分享开关后，角色才可以回应。</p>}
          </div>}
        </div>
      </div>
    </div>}
  </div>;
}


type PhotoAlbumViewProps = {
  albums: PhotoAlbum[];
  photos: PhotoWallPhoto[];
  activeAlbumId: string | null;
  activePage: number;
  editMode: boolean;
  onSaveAlbums: (next: PhotoAlbum[]) => void;
  onSelectAlbum: (id: string | null) => void;
  onSelectPage: (page: number) => void;
  onSetEditMode: (enabled: boolean) => void;
  onOpenPhoto: (photo: PhotoWallPhoto) => void;
  onNotice?: (message: string) => void;
};

function PhotoAlbumView({
  albums, photos, activeAlbumId, activePage, editMode, onSaveAlbums,
  onSelectAlbum, onSelectPage, onSetEditMode, onOpenPhoto, onNotice,
}: PhotoAlbumViewProps) {
  const active = albums.find(album => album.id === activeAlbumId) ?? null;

  const createAlbum = () => {
    const id = createPhotoWallId();
    const firstPage = photos.slice(0, 9).map(photo => photo.id);
    const album: PhotoAlbum = {
      id,
      title: "我们的相册",
      coverPhotoId: firstPage[0] ?? "",
      pages: [firstPage],
    };
    onSaveAlbums([...albums, album]);
    onSelectAlbum(id);
    onSelectPage(0);
    onSetEditMode(true);
  };

  const openAlbum = (id: string) => {
    onSelectAlbum(id);
    onSelectPage(0);
    onSetEditMode(false);
  };

  if (!active) {
    return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-5 sm:px-7" style={{ WebkitOverflowScrolling: "touch" }}>
      <div className="mx-auto max-w-4xl">
        <div className="mb-5 flex items-end justify-between gap-3 border-b border-[#d8c4b4] pb-3">
          <div><h2 className="font-serif text-xl text-[#5d4942]">把重要的时光装订起来</h2></div>
          <button type="button" onClick={createAlbum} className="shrink-0 border border-[#87565b] bg-[#87565b] px-3 py-2 text-xs text-white">＋ 新建相册</button>
        </div>
        {albums.length ? <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {albums.map(album => {
            const cover = photos.find(photo => photo.id === album.coverPhotoId) ?? photos.find(photo => album.pages.some(page => page.includes(photo.id))) ?? null;
            return <article key={album.id} className="min-w-0">
              <div className="relative border border-[#d4bfa9] bg-[#fffaf0] p-2 shadow-[3px_5px_12px_rgba(70,55,40,.12)]">
                <div className="aspect-[3/4] overflow-hidden border border-[#eadaca] bg-[#eee3d4]">
                  {cover ? <PhotoThumbnail photo={cover} onOpen={() => openAlbum(album.id)} /> : <button type="button" onClick={() => openAlbum(album.id)} className="grid h-full w-full place-items-center text-center text-xs text-[#a08c74]"><span>空白封面</span></button>}
                </div>
                <div className="pointer-events-none absolute bottom-5 left-3 right-3 border-t border-[#d8c4b4] pt-2 text-center font-serif text-sm text-[#6a5146]">{album.title}</div>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <button type="button" onClick={() => openAlbum(album.id)} className="min-w-0 truncate text-left text-xs text-[#6d5946]">{album.title}</button>
                <span className="shrink-0 text-[10px] text-[#a08c74]">{album.pages.length} 页</span>
              </div>
              <button type="button" onClick={() => { onSaveAlbums(albums.filter(item => item.id !== album.id)); if (activeAlbumId === album.id) onSelectAlbum(null); }} className="mt-1 text-[10px] text-[#a16d62] underline underline-offset-2">删除相册</button>
            </article>;
          })}
        </div> : <div className="grid min-h-[45dvh] place-items-center border border-dashed border-[#d8c4b4] text-center text-[#907c67]"><div><p className="font-serif text-lg">还没有装订相册</p><p className="mt-2 text-xs">新建后可编辑封面、逐页翻阅，并手动安排九宫格。</p></div></div>}
      </div>
    </div>;
  }

  const pageIds = active.pages[activePage] ?? [];
  const coverOptions = photos.map(photo => <option key={photo.id} value={photo.id}>{photo.title || "未命名的瞬间"}</option>);
  const updateAlbum = (updater: (current: PhotoAlbum) => PhotoAlbum) => {
    onSaveAlbums(albums.map(album => album.id === active.id ? updater(album) : album));
  };
  const updateSlot = (slotIndex: number, photoId: string) => updateAlbum(current => {
    const pages = current.pages.map(page => page.slice());
    while (pages.length <= activePage) pages.push([]);
    const slots = Array.from({ length: 9 }, (_, index) => index === slotIndex ? photoId : (pages[activePage][index] ?? ""));
    pages[activePage] = slots;
    return { ...current, pages };
  });
  const slotGrid = Array.from({ length: 9 }, (_, index) => {
    const photoId = pageIds[index] ?? "";
    const photo = photos.find(item => item.id === photoId) ?? null;
    return <article key={index} className="flex min-w-0 flex-col border border-[#e3d3c1] bg-[#fffdf8] p-1 shadow-[1px_3px_8px_rgba(70,55,40,.10)]">
      <div className="aspect-square min-h-0 overflow-hidden bg-[#e9dfd0]">
        {photo ? <PhotoThumbnail photo={photo} onOpen={() => onOpenPhoto(photo)} /> : <div className="grid h-full place-items-center text-[10px] text-[#b3a18b]">空白位置</div>}
      </div>
      {editMode && <select value={photoId} onChange={event => updateSlot(index, event.target.value)} aria-label={"相册第" + (activePage + 1) + "页第" + (index + 1) + "个照片位置"} className="mt-1 min-w-0 w-full border-t border-[#e5d7c6] bg-[#fffaf2] px-0.5 py-1.5 text-[10px] text-[#6d5946]">
        <option value="">留空</option>{coverOptions}
      </select>}
      {!editMode && photo && <button type="button" onClick={() => onOpenPhoto(photo)} className="mt-1 truncate text-left text-[10px] text-[#6d5946]">{photo.title || "未命名的瞬间"}</button>}
    </article>;
  });

  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-24 pt-4 sm:px-7" style={{ WebkitOverflowScrolling: "touch" }}>
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-[#d8c4b4] pb-3">
        <button type="button" onClick={() => onSelectAlbum(null)} className="border-b border-[#bda28d] px-1 py-1 text-xs text-[#79545a]">‹ 相册列表</button>
        <span className="min-w-0 flex-1 font-serif text-lg text-[#5d4942]">{active.title}</span>
        <button type="button" onClick={() => onSetEditMode(!editMode)} className={editMode ? "border border-[#87565b] bg-[#87565b] px-3 py-2 text-xs text-white" : "border border-[#d8c4b4] px-3 py-2 text-xs text-[#79545a]"}>{editMode ? "完成排版" : "编辑这一页"}</button>
      </div>
      {editMode && <div className="mb-3 grid gap-2 sm:grid-cols-2">
        <label className="text-[11px] text-[#8b7665]">相册名称<input value={active.title} maxLength={80} onChange={event => updateAlbum(current => ({ ...current, title: event.target.value }))} className="mt-1 w-full border-b border-[#d8c4b4] bg-transparent px-1 py-2 text-sm text-[#5d4942]"/></label>
        <label className="text-[11px] text-[#8b7665]">封面照片<select value={active.coverPhotoId} onChange={event => updateAlbum(current => ({ ...current, coverPhotoId: event.target.value }))} className="mt-1 w-full border-b border-[#d8c4b4] bg-transparent px-1 py-2 text-sm text-[#5d4942]"><option value="">自动使用第一页第一张</option>{coverOptions}</select></label>
      </div>}
      <div key={activePage} className="relative border border-[#d7c3ac] bg-[#fffaf0] p-2 shadow-[8px_12px_30px_rgba(70,45,30,.16)] sm:p-4" style={{ backgroundImage: "linear-gradient(90deg,rgba(124,88,64,.09),transparent 5%,transparent 95%,rgba(124,88,64,.05)),repeating-linear-gradient(0deg,rgba(145,113,85,.025) 0,rgba(145,113,85,.025) 1px,transparent 1px,transparent 5px)", transformOrigin: "left center", animation: "photoAlbumPageTurn .34s ease-out" }}>
        <div className="mb-3 flex items-center justify-between gap-3 border-b border-[#e8d9c8] pb-2 text-[10px] tracking-[.16em] text-[#aa927d]"><span>✦ ALBUM · {active.title}</span><span>PAGE {activePage + 1} / {active.pages.length}</span></div>
        <div className="grid grid-cols-3 gap-2 border-l border-[#e8d9c8] pl-2 sm:gap-3 sm:pl-3">{slotGrid}</div>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-[#e8d9c8] pt-3">
          <button type="button" disabled={activePage <= 0} onClick={() => onSelectPage(Math.max(0, activePage - 1))} className="border border-[#d8c4b4] px-3 py-2 text-xs text-[#79545a] disabled:opacity-30">‹ 上一页</button>
          
          <button type="button" disabled={activePage >= active.pages.length - 1} onClick={() => onSelectPage(Math.min(active.pages.length - 1, activePage + 1))} className="border border-[#d8c4b4] px-3 py-2 text-xs text-[#79545a] disabled:opacity-30">下一页 ›</button>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={() => { updateAlbum(current => ({ ...current, pages: [...current.pages, Array(9).fill("")] })); onSelectPage(active.pages.length); onSetEditMode(true); }} className="border border-[#d8c4b4] px-3 py-2 text-xs text-[#79545a]">＋ 添加一页</button>
        <button type="button" onClick={() => { onSaveAlbums(albums.filter(item => item.id !== active.id)); onSelectAlbum(null); onNotice?.("相册已删除，照片原件仍保留在照片墙。"); }} className="border border-[#e4c8bb] px-3 py-2 text-xs text-[#9c6c5f]">删除相册</button>
      </div>
    </div>
  </div>;
}

function ChatCandidateThumb({ refId }: { refId: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    if (!refId.startsWith("media-store://")) { setSrc(refId); return; }
    let active = true; let url = "";
    void loadMediaObjectUrl(refId).then(value => { if (!active) { if (value) URL.revokeObjectURL(value); return; } if (value) { url = value; setSrc(value); } });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [refId]);
  return <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-[#e7dfd2]">{src ? <img src={src} alt="" className="h-full w-full object-cover"/> : <ImagePlus size={16} className="text-[#a0917d]"/>}</span>;
}

function PhotoLarge({ refId, title }: { refId: string; title: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let active = true; let url = "";
    void loadMediaObjectUrl(refId).then(value => { if (!active) { if (value) URL.revokeObjectURL(value); return; } if (value) { url = value; setSrc(value); } });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [refId]);
  return src ? <img src={src} alt={title} className="max-h-full max-w-full object-contain" /> : <div className="grid h-24 w-24 place-items-center text-[#9a8a75]"><LoaderCircle size={22} className="animate-spin"/></div>;
}
