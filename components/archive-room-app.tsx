"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import { Archive, ArrowLeft, AudioLines, Check, File, Image as ImageIcon, LoaderCircle, RefreshCw, Search, Trash2, Video, X, Copy, HardDrive, ShieldAlert, Star } from "lucide-react";
import { deleteMediaRef, listMediaCacheSummaries, loadMediaBlob, loadMediaObjectUrl, type MediaCacheSummary } from "@/lib/media-cache-storage";
import { loadChatSessions, loadChatMessages } from "@/lib/chat-storage";
import { loadPhotoWallState } from "@/lib/photo-wall-storage";

type ArchiveItem = MediaCacheSummary & { ref: string; usedBy: string[]; objectUrl?: string };
type ArchiveMeta = { label?: string; note?: string; favorite?: boolean };
const ARCHIVE_META_KEY = "ai_phone_archive_meta_v1";

type AverageImageHash = { high: number; low: number };
async function averageImageHash(blob: Blob): Promise<AverageImageHash | null> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = 8; canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    const luminance: number[] = [];
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const value = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      luminance.push(value); sum += value;
    }
    const average = sum / luminance.length;
    let high = 0; let low = 0;
    for (let i = 0; i < luminance.length; i += 1) {
      const bit = luminance[i] >= average ? 1 : 0;
      if (i < 32) high = (high << 1) | bit;
      else low = (low << 1) | bit;
    }
    return { high: high >>> 0, low: low >>> 0 };
  } catch { return null; }
  finally { bitmap?.close(); }
}
function popcount32(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0F0F0F0F;
  return (Math.imul(v, 0x01010101) >>> 24);
}
function imageHashDistance(a: AverageImageHash, b: AverageImageHash): number {
  return popcount32(a.high ^ b.high) + popcount32(a.low ^ b.low);
}

function loadArchiveMeta(): Record<string, ArchiveMeta> { try { const raw = typeof window !== "undefined" ? window.localStorage.getItem(ARCHIVE_META_KEY) : null; const parsed = raw ? JSON.parse(raw) : {}; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, ArchiveMeta> : {}; } catch { return {}; } }
function saveArchiveMeta(value: Record<string, ArchiveMeta>) { try { window.localStorage.setItem(ARCHIVE_META_KEY, JSON.stringify(value)); } catch { /* metadata must never block media access */ } }
type Props = { onClose: () => void; onNotice?: (message: string) => void };
const refFor = (id: string) => `media-store://${id}`;
const bytesLabel = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const dateLabel = (value: number) => new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ArchiveRoomApp({ onClose, onNotice }: Props) {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [tab, setTab] = useState<"all" | "duplicates">("all");
  const [filter, setFilter] = useState<"all" | "image" | "audio" | "video" | "file">("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [scanningDuplicates, setScanningDuplicates] = useState(false);
  const [duplicateIds, setDuplicateIds] = useState<Set<string>>(new Set());
  const [exactDuplicateIds, setExactDuplicateIds] = useState<Set<string>>(new Set());
  const [visualDuplicateIds, setVisualDuplicateIds] = useState<Set<string>>(new Set());
  const [duplicateGroups, setDuplicateGroups] = useState<string[][]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [meta, setMeta] = useState<Record<string, ArchiveMeta>>(() => loadArchiveMeta());
  const [recommendedDeleteIds, setRecommendedDeleteIds] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const summaries = await listMediaCacheSummaries();
      const sessions = loadChatSessions();
      const used = new Map<string, Set<string>>();
      for (const session of sessions) {
        for (const msg of loadChatMessages(session.id)) {
          const refs = [msg.mediaUrl, ...(Array.isArray(msg.mediaData?.imageRefs) ? msg.mediaData.imageRefs as string[] : [])];
          for (const ref of refs) {
            if (typeof ref !== "string" || !ref.startsWith("media-store://")) continue;
            const id = ref.slice("media-store://".length);
            if (!used.has(id)) used.set(id, new Set());
            used.get(id)!.add(session.groupName || session.alias || session.contactId || session.id);
          }
        }
      }
      // Include photo wall references too: archive cleanup must not silently break a saved photo.
      for (const photo of loadPhotoWallState().photos) {
        if (!photo.mediaRef.startsWith("media-store://")) continue;
        const id = photo.mediaRef.slice("media-store://".length);
        if (!used.has(id)) used.set(id, new Set());
        used.get(id)!.add(`照片墙：${photo.title || "未命名照片"}`);
      }
      setItems(summaries.map(item => ({ ...item, ref: refFor(item.id), usedBy: [...(used.get(item.id) || [])] })).sort((a, b) => b.createdAt - a.createdAt));
      setSelected([]);
    } catch (error) {
      onNotice?.("读取媒体库失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setLoading(false); }
  }, [onNotice]);

  useEffect(() => { void refresh(); }, [refresh]);

  const stats = useMemo(() => items.reduce((acc, item) => {
    acc.count += 1; acc.bytes += item.bytes; acc[item.category] += 1; return acc;
  }, { count: 0, bytes: 0, image: 0, audio: 0, video: 0, file: 0 }), [items]);

  const scanDuplicates = async () => {
    if (scanningDuplicates) return;
    setScanningDuplicates(true);
    try {
      const hashGroups = new Map<string, string[]>();
      const imageHashes = new Map<string, AverageImageHash>();
      // 逐个读取、计算内容摘要和低分辨率视觉摘要，避免同时将所有 Blob 放入内存。
      for (const item of items) {
        const loaded = await loadMediaBlob(item.ref);
        if (!loaded) continue;
        const digest = await crypto.subtle.digest("SHA-256", await loaded.blob.arrayBuffer());
        const hash = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
        const ids = hashGroups.get(hash) || [];
        ids.push(item.id);
        hashGroups.set(hash, ids);
        if (item.category === "image" || loaded.blob.type.startsWith("image/")) {
          const visualHash = await averageImageHash(loaded.blob);
          if (visualHash) imageHashes.set(item.id, visualHash);
        }
      }
      const exactGroups = [...hashGroups.values()].filter(group => group.length > 1);
      const exactIds = new Set(exactGroups.flat());
      // Average-hash is a review aid for re-encoded/resized copies. It never makes an
      // item eligible for automatic deletion; only exact SHA-256 copies can be recommended.
      const imageIds = [...imageHashes.keys()];
      const visualParent = new Map<string, string>(imageIds.map(id => [id, id] as [string, string]));
      const findVisualRoot = (id: string): string => {
        const p = visualParent.get(id) ?? id;
        if (p === id) return id;
        const root = findVisualRoot(p);
        visualParent.set(id, root);
        return root;
      };
      for (let i = 0; i < imageIds.length; i += 1) {
        for (let j = i + 1; j < imageIds.length; j += 1) {
          const left = imageIds[i]; const right = imageIds[j];
          const a = imageHashes.get(left); const b = imageHashes.get(right);
          if (!a || !b || imageHashDistance(a, b) > 5) continue;
          const rootA = findVisualRoot(left); const rootB = findVisualRoot(right);
          if (rootA !== rootB) visualParent.set(rootB, rootA);
        }
      }
      const visualBuckets = new Map<string, string[]>();
      for (const id of imageIds) {
        const root = findVisualRoot(id);
        const ids = visualBuckets.get(root) ?? [];
        ids.push(id);
        visualBuckets.set(root, ids);
      }
      const visualGroups = [...visualBuckets.values()].filter(group => group.length > 1);
      const combinedParent = new Map<string, string>();
      const findCombinedRoot = (id: string): string => {
        const p = combinedParent.get(id) ?? id;
        if (p === id) return id;
        const root = findCombinedRoot(p);
        combinedParent.set(id, root);
        return root;
      };
      const connectGroup = (group: string[]) => {
        if (!group.length) return;
        if (!combinedParent.has(group[0])) combinedParent.set(group[0], group[0]);
        for (const id of group.slice(1)) {
          if (!combinedParent.has(id)) combinedParent.set(id, id);
          const a = findCombinedRoot(group[0]); const b = findCombinedRoot(id);
          if (a !== b) combinedParent.set(b, a);
        }
      };
      exactGroups.forEach(connectGroup);
      visualGroups.forEach(connectGroup);
      const combinedBuckets = new Map<string, string[]>();
      for (const id of combinedParent.keys()) {
        const root = findCombinedRoot(id);
        const ids = combinedBuckets.get(root) ?? [];
        ids.push(id);
        combinedBuckets.set(root, ids);
      }
      const groups = [...combinedBuckets.values()].filter(group => group.length > 1);
      const byId = new Map(items.map(item => [item.id, item]));
      // Prefer keeping favorites and files referenced by chat/photo wall. Only recommend
      // deleting an unreferenced exact copy; perceptual matches require human review.
      const candidates = exactGroups.flatMap(group => {
        const sorted = group.slice().sort((a, b) => {
          const left = byId.get(a); const right = byId.get(b);
          const leftFavorite = meta[a]?.favorite === true;
          const rightFavorite = meta[b]?.favorite === true;
          if (leftFavorite !== rightFavorite) return leftFavorite ? -1 : 1;
          const leftReferenced = (left?.usedBy.length ?? 0) > 0;
          const rightReferenced = (right?.usedBy.length ?? 0) > 0;
          if (leftReferenced !== rightReferenced) return leftReferenced ? -1 : 1;
          return (right?.bytes ?? 0) - (left?.bytes ?? 0) || (right?.createdAt ?? 0) - (left?.createdAt ?? 0);
        });
        return sorted.slice(1).filter(id => meta[id]?.favorite !== true && (byId.get(id)?.usedBy.length ?? 0) === 0);
      });
      const visualIds = new Set(visualGroups.flat().filter(id => !exactIds.has(id)));
      setDuplicateGroups(groups);
      setDuplicateIds(new Set(groups.flat()));
      setExactDuplicateIds(exactIds);
      setVisualDuplicateIds(visualIds);
      setRecommendedDeleteIds(new Set(candidates));
      setSelected([]);
      setTab("duplicates");
      const protectedCount = exactGroups.reduce((count, group) => {
        const hasCandidate = group.some(id => candidates.includes(id));
        return count + (hasCandidate ? 0 : 1);
      }, 0);
      const visualOnlyGroups = visualGroups.filter(group => group.some(id => !exactIds.has(id))).length;
      onNotice?.(groups.length
        ? "扫描完成：" + exactGroups.length + " 组文件内容完全相同，另有 " + visualOnlyGroups + " 组视觉相似图片供人工核对。已为未收藏且未被引用的完全重复副本提供 " + candidates.length + " 个推荐删除项；" + protectedCount + " 组没有安全推荐项。视觉相似项不会自动推荐删除。"
        : "没有发现内容完全相同或视觉相似的媒体文件。");
    } catch (error) {
      onNotice?.("重复扫描失败：" + (error instanceof Error ? error.message : String(error)));
    } finally { setScanningDuplicates(false); }
  };

  const duplicateGroupLabelById = useMemo(() => {
    const labels = new Map<string, number>();
    duplicateGroups.forEach((group, index) => group.forEach(id => labels.set(id, index + 1)));
    return labels;
  }, [duplicateGroups]);

  const visibleItems = useMemo(() => items.filter(item => {
    if (tab === "duplicates" && !duplicateIds.has(item.id)) return false;
    if (filter !== "all" && item.category !== filter) return false;
    const itemMeta = meta[item.id];
    if (query && !item.id.toLowerCase().includes(query.toLowerCase()) && !(itemMeta?.label || "").toLowerCase().includes(query.toLowerCase()) && !(itemMeta?.note || "").toLowerCase().includes(query.toLowerCase()) && !item.usedBy.some(name => name.toLowerCase().includes(query.toLowerCase()))) return false;
    return true;
  }), [items, tab, duplicateIds, filter, query, meta]);

  const toggle = (id: string) => { setConfirmDelete(false); setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); };
  const patchMeta = (id: string, patch: Partial<ArchiveMeta>) => {
    const next = { ...meta, [id]: { ...(meta[id] ?? {}), ...patch } };
    setMeta(next); saveArchiveMeta(next);
  };
  const exportSelected = async () => {
    if (!selected.length) return;
    try {
      const zip = new JSZip();
      let exported = 0;
      for (const item of items.filter(entry => selected.includes(entry.id))) {
        const stored = await loadMediaBlob(item.ref);
        if (!stored) continue;
        const extension = stored.mimeType.split("/")[1]?.split(";")[0]?.replace("jpeg", "jpg") || "bin";
        zip.file(`${item.category}/${item.id}.${extension}`, stored.blob);
        exported += 1;
      }
      if (!exported) { onNotice?.("所选项目没有可导出的文件。"); return; }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `档案室导出-${new Date().toISOString().slice(0, 10)}.zip`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
      onNotice?.(`已导出 ${exported} 个文件。`);
    } catch (error) {
      onNotice?.("导出失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };

  const deleteSelected = async () => {
    const targets = items.filter(item => selected.includes(item.id));
    const favorited = targets.filter(item => meta[item.id]?.favorite === true);
    if (favorited.length) { onNotice?.(`所选项目中有 ${favorited.length} 个已收藏文件；为防止误删，已阻止本次删除。请取消收藏后再操作。`); setConfirmDelete(false); return; }
    const photoWallProtected = targets.filter(item => item.usedBy.some(name => name.startsWith("照片墙：")));
    if (photoWallProtected.length) {
      onNotice?.(`所选项目中有 ${photoWallProtected.length} 个仍被照片墙使用。请先在照片墙中移除对应照片，再清理媒体文件，避免留下失效记录。`);
      return;
    }
    const referenced = targets.filter(item => item.usedBy.length > 0);
    if ((referenced.length || targets.length > 1) && !confirmDelete) {
      setConfirmDelete(true);
      onNotice?.(`准备删除 ${targets.length} 个媒体文件${referenced.length ? `，其中 ${referenced.length} 个仍被聊天消息引用` : ""}。再次点击确认后才会执行；引用媒体可能无法显示。收藏项不会被删除。`);
      return;
    }
    try {
      await Promise.all(targets.map(item => deleteMediaRef(item.ref)));
      setConfirmDelete(false);
      onNotice?.(`已删除 ${targets.length} 个媒体文件。`);
      await refresh();
    } catch (error) {
      onNotice?.("删除失败：" + (error instanceof Error ? error.message : String(error)));
    }
  };

  return <div className="pointer-events-auto isolate absolute inset-0 z-[1000] flex flex-col overflow-hidden bg-[#f6f4f0] text-stone-800">
    <header
      className="relative z-[1001] flex shrink-0 items-center gap-3 border-b border-stone-200 bg-white/95 px-4 pb-3"
      style={{ paddingTop: "max(12px, var(--page-header-safe-top, 48px))" }}
    >
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onClose(); }} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 touch-manipulation place-items-center rounded-2xl border border-stone-200 bg-white shadow-sm" aria-label="返回"><ArrowLeft size={18}/></button>
      <div className="min-w-0 flex-1"><div className="text-lg font-semibold tracking-wide">档案室</div><div className="text-xs text-stone-500">媒体资产与留存管理</div></div>
      <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); void refresh(); }} disabled={loading} className="relative z-[1002] pointer-events-auto grid h-11 w-11 shrink-0 touch-manipulation place-items-center rounded-2xl border border-stone-200 bg-white shadow-sm disabled:opacity-50" aria-label="刷新"><RefreshCw size={16} className={loading ? "animate-spin" : ""}/></button>
    </header>
    <main className="min-h-0 flex-1 overflow-y-auto p-4">
      <section className="rounded-3xl bg-gradient-to-br from-[#e8e0d3] via-[#f4eee5] to-[#d9e3db] p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3"><div><div className="text-sm text-stone-600">已索引媒体</div><div className="mt-1 text-3xl font-semibold">{stats.count.toLocaleString()} <span className="text-sm font-normal text-stone-500">个文件</span></div><div className="mt-1 text-sm text-stone-600">索引媒体大小合计 {bytesLabel(stats.bytes)}</div></div><div className="rounded-2xl bg-white/65 p-3"><HardDrive size={26}/></div></div>
        <div className="mt-5 grid grid-cols-4 gap-2">{([{key:"image",label:"图片",Icon:ImageIcon},{key:"audio",label:"语音",Icon:AudioLines},{key:"video",label:"视频",Icon:Video},{key:"file",label:"文件",Icon:File}] as const).map(({key,label,Icon})=><button key={key} onClick={()=>{setFilter(key);setTab("all");}} className={`rounded-2xl border p-3 text-left ${filter===key?"border-stone-500 bg-white/80":"border-white/70 bg-white/40"}`}><Icon size={17}/><div className="mt-2 text-lg font-semibold">{stats[key]}</div><div className="text-xs text-stone-500">{label}</div></button>)}</div>
      </section>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <button onClick={() => {setTab("all");setFilter("all");}} className={`rounded-2xl border p-4 text-left ${tab==="all"?"border-stone-400 bg-white":"border-stone-200 bg-white/60"}`}><Archive size={19}/><div className="mt-2 font-semibold">媒体库</div><div className="mt-1 text-xs text-stone-500">浏览、筛选与批量管理</div></button>
        <button onClick={() => void scanDuplicates()} disabled={scanningDuplicates || loading} className="rounded-2xl border border-stone-200 bg-white/60 p-4 text-left disabled:opacity-60">{scanningDuplicates?<LoaderCircle size={19} className="animate-spin"/>:<Copy size={19}/>}<div className="mt-2 font-semibold">重复文件扫描</div><div className="mt-1 text-xs text-stone-500">精确重复 + 视觉相似候选</div></button>
      </div>
      {tab==="duplicates"&&<div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900"><ShieldAlert size={16} className="mb-1"/>这里展示内容完全相同的文件和视觉相似图片的全部候选，可逐张勾选。绿色「推荐删除」只来自内容哈希完全一致且未收藏、未被引用的副本；视觉相似项仅供人工核对，绝不会自动推荐删除。<div className="mt-2 flex flex-wrap items-center gap-2"><button type="button" onClick={()=>{setSelected(visibleItems.filter(item=>recommendedDeleteIds.has(item.id)&&meta[item.id]?.favorite!==true).map(item=>item.id));setConfirmDelete(false);}} className="rounded-lg border border-amber-300 bg-white/80 px-3 py-2 font-medium">选择推荐删除项（{visibleItems.filter(item=>recommendedDeleteIds.has(item.id)&&meta[item.id]?.favorite!==true).length}）</button><button type="button" onClick={()=>{setSelected(visibleItems.filter(item=>meta[item.id]?.favorite!==true).map(item=>item.id));setConfirmDelete(false);}} className="rounded-lg border border-amber-300 bg-white/80 px-3 py-2">选择未收藏项</button></div></div>}
      <div className="mt-5 flex items-center gap-2 rounded-2xl border border-stone-200 bg-white px-3 py-2"><Search size={16} className="shrink-0 text-stone-400"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索文件 ID 或关联会话" className="min-w-0 flex-1 bg-transparent text-sm outline-none"/>{query&&<button onClick={()=>setQuery("")}><X size={15}/></button>}</div>
      <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1">{([{key:"all",label:"全部"},{key:"image",label:"图片"},{key:"audio",label:"语音"},{key:"video",label:"视频"},{key:"file",label:"其他"}] as const).map(x=><button key={x.key} onClick={()=>setFilter(x.key)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${filter===x.key?"bg-stone-800 text-white":"bg-white text-stone-600"}`}>{x.label}</button>)}</div>
      <div className="mt-3 flex items-center justify-between gap-2 text-xs text-stone-500"><span>{visibleItems.length} 个项目{selected.length? ` · 已选 ${selected.length}`:""}</span><div className="flex items-center gap-3"><button type="button" onClick={()=>{setSelected(visibleItems.filter(item=>meta[item.id]?.favorite!==true).map(item=>item.id));setConfirmDelete(false);}} className="font-medium text-stone-700">选中未收藏</button><button onClick={()=>{setSelected(selected.length===visibleItems.length?[]:visibleItems.map(x=>x.id));setConfirmDelete(false);}} className="font-medium text-stone-700">{selected.length===visibleItems.length&&visibleItems.length?"取消全选":"选择当前列表"}</button></div></div>
      <div className="mt-2 space-y-2 pb-24">{loading?<div className="py-12 text-center text-sm text-stone-500"><LoaderCircle className="mx-auto mb-2 animate-spin"/>正在扫描媒体索引…</div>:visibleItems.length===0?<div className="rounded-2xl border border-dashed border-stone-300 bg-white/50 px-4 py-12 text-center text-sm text-stone-500">{tab==="duplicates"?"没有重复项，或尚未完成扫描。":"当前范围没有找到媒体文件。"}</div>:visibleItems.map(item=><MediaRow key={item.id} item={item} checked={selected.includes(item.id)} onToggle={()=>toggle(item.id)} meta={meta[item.id] ?? {}} onPatch={patch=>patchMeta(item.id,patch)} recommended={recommendedDeleteIds.has(item.id)} exactDuplicate={exactDuplicateIds.has(item.id)} visualSimilar={visualDuplicateIds.has(item.id)} duplicateGroup={tab === "duplicates" ? duplicateGroupLabelById.get(item.id) : undefined}/>)}</div>
    </main>
    {selected.length>0&&<footer className="flex shrink-0 items-center gap-3 border-t border-stone-200 bg-white/95 px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]"><div className="min-w-0 flex-1 text-sm"><div className="font-semibold">已选择 {selected.length} 项</div><div className="text-xs text-stone-500">约 {bytesLabel(items.filter(x=>selected.includes(x.id)).reduce((n,x)=>n+x.bytes,0))}</div></div><button onClick={()=>void exportSelected()} className="flex items-center gap-2 rounded-xl border border-stone-300 px-3 py-2.5 text-sm font-medium text-stone-700">导出 ZIP</button><button onClick={()=>{setSelected([]);setConfirmDelete(false);}} className="rounded-xl px-3 py-2 text-sm text-stone-600">取消</button><button onClick={()=>void deleteSelected()} className="flex items-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-medium text-white"><Trash2 size={16}/>{confirmDelete?"确认删除":"删除所选"}</button></footer>}
  </div>;
}

function MediaRow({ item, checked, onToggle, meta, onPatch, recommended, exactDuplicate, visualSimilar, duplicateGroup }: { item: ArchiveItem; checked: boolean; onToggle: () => void; meta: ArchiveMeta; onPatch: (patch: Partial<ArchiveMeta>) => void; recommended: boolean; exactDuplicate: boolean; visualSimilar: boolean; duplicateGroup?: number }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let active = true;
    let current = "";
    if (item.category === "image" || item.category === "video" || item.category === "audio") {
      void loadMediaObjectUrl(item.ref).then(value => { if (value && active) { current = value; setUrl(value); } else if (value) URL.revokeObjectURL(value); });
    }
    return () => { active = false; if (current) URL.revokeObjectURL(current); };
  }, [item.ref, item.category]);
  const Icon = item.category === "image" ? ImageIcon : item.category === "audio" ? AudioLines : item.category === "video" ? Video : File;
  return <article className={"flex items-start gap-3 rounded-2xl border p-3 " + (checked ? "border-stone-500 bg-stone-50" : "border-stone-200 bg-white")}>
    <button type="button" onClick={onToggle} className={"mt-1 grid h-6 w-6 shrink-0 place-items-center rounded-full border " + (checked ? "border-stone-800 bg-stone-800 text-white" : "border-stone-300 text-transparent")} aria-label={checked ? "取消选择" : "选择"}><Check size={14}/></button>
    <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl bg-stone-100">{item.category==="image"&&url?<img src={url} alt={meta.label || ""} className="h-full w-full object-contain"/>:item.category==="video"&&url?<video src={url} muted preload="metadata" className="h-full w-full object-contain"/>:<Icon size={22} className="text-stone-500"/>}</div>
    <div className="min-w-0 flex-1">
      <div className="flex items-start gap-2"><div className="min-w-0 flex-1 break-words text-sm font-medium">{meta.label?.trim() || item.id}</div><button type="button" onClick={()=>onPatch({favorite:!meta.favorite})} aria-label={meta.favorite?"取消收藏":"收藏文件"} title={meta.favorite?"取消收藏":"收藏文件"} className={"shrink-0 rounded-lg p-1 " + (meta.favorite?"text-amber-600":"text-stone-400")}><Star size={17} fill={meta.favorite?"currentColor":"none"}/></button></div>
      <div className="mt-1 break-all text-[10px] text-stone-400">ID: {item.id}</div>
      {duplicateGroup !== undefined && <div className="mt-1 text-[10px] font-medium text-stone-500">重复候选组 {duplicateGroup}</div>}
      <div className="mt-1 text-xs text-stone-500">{bytesLabel(item.bytes)} · {dateLabel(item.createdAt)} · {item.category==="audio"?"语音":item.category==="image"?"图片":item.category==="video"?"视频":"文件"}</div>
      {item.category === "audio" && url && <audio controls preload="none" src={url} className="mt-2 h-8 w-full max-w-[240px]"/>}
      <div className={item.usedBy.length ? "mt-1 break-words text-xs text-emerald-700" : "mt-1 break-words text-xs text-amber-700"}>{item.usedBy.length ? "关联 " + item.usedBy.length + " 个会话 / 记录" : "未发现已知引用（不代表一定可删除）"}</div>
      {meta.favorite && <div className="mt-1.5 flex flex-wrap items-center gap-2"><span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700"><Star size={10} fill="currentColor"/>已收藏</span><span className="text-[10px] text-amber-700">批量删除会自动保护</span></div>}
      {exactDuplicate && <div className="mt-1 text-[10px] font-medium text-emerald-700">文件内容完全相同（SHA-256）</div>}
      {visualSimilar && <div className="mt-1 text-[10px] font-medium text-amber-700">视觉相似候选 · 需人工核对，不自动推荐删除</div>}
      {recommended && !meta.favorite && <div className="mt-1 text-[10px] font-medium text-emerald-700">推荐删除候选（仍需你选择并确认）</div>}
      <input value={meta.label ?? ""} onChange={event=>onPatch({label:event.target.value})} placeholder={item.category==="audio"?"给语音标注内容 / 角色 / 场景…":"给文件起一个容易识别的名字…"} aria-label="文件备注名称" className="mt-2 w-full rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 text-xs outline-none focus:border-stone-400"/>
      <textarea value={meta.note ?? ""} onChange={event=>onPatch({note:event.target.value})} rows={1} placeholder="备注：内容、来源、为什么要保留……" aria-label="文件备注" className="mt-2 w-full resize-y rounded-lg border border-stone-200 bg-stone-50 px-2.5 py-2 text-xs outline-none focus:border-stone-400"/>
    </div>
  </article>;
}
