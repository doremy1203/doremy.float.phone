"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { AlertCircle, Camera, ChevronDown, Image, Info, Plus, RefreshCw, ScanFace, Sparkles, Trash2, Upload } from "lucide-react";
import type { ImageGenerationSettings as ImageGenerationSettingsType, NovelAiPreset, OpenAiImagePreset } from "@/lib/settings-types";
import {
    DEFAULT_IMAGE_GENERATION_SETTINGS,
    DEFAULT_NOVELAI_PRESET,
    loadImageGenerationSettings,
    saveImageGenerationSettings,
} from "@/lib/settings-storage";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { getChatImageFromIndexedDB, saveChatImageToIndexedDB } from "@/lib/chat-asset-storage";
import { fileToUserAvatarDataUrl } from "@/lib/user-avatar-image";
import {
    fetchImageGenerationModels,
    fetchNovelAiModels,
    filterLikelyImageModels,
    generateImageFromConfiguredApi,
    loadImageGenerationCallRecords,
    clearImageGenerationCallRecords,
} from "@/lib/image-generation-service";
import { Alert } from "@/components/ui/feedback";
import { Input, Select, Textarea, Toggle } from "@/components/ui/form";
import { ConfirmDialog, ContentDialog } from "@/components/ui/modal";
import {
    NOVELAI_COMMON_MODELS,
    NOVELAI_NOISE_SCHEDULE_OPTIONS,
    NOVELAI_RESOLUTION_OPTIONS,
    NOVELAI_SAMPLER_OPTIONS,
} from "@/lib/novelai-image-config";

const SIZE_OPTIONS = ["auto", "1024x1024", "1024x1536", "1536x1024"];
const QUALITY_OPTIONS = ["auto", "low", "medium", "high"];

// Some relay APIs (e.g. dzzi 的 gpt-image-2) ignore the `size` param and pick
// their own aspect ratio. As a fallback we append a natural-language ratio hint
// to the prompt, which these models DO respect. The marker lets us replace the
// previously-appended hint instead of stacking them when the size changes.
const RATIO_HINT_MARKER = "【画面比例】";
const SIZE_RATIO_HINTS: Record<string, string> = {
    "1024x1024": "正方形 1:1 构图，square 1:1 composition",
    "1024x1536": "竖向 2:3 构图，vertical portrait composition",
    "1536x1024": "横向 3:2 构图，horizontal landscape composition",
};

// Remove any auto-appended ratio hint line(s), preserving the user's own text.
function stripRatioHint(text: string): string {
    return text.replace(new RegExp(`\\s*${RATIO_HINT_MARKER}[^\\n]*`, "g"), "").replace(/\s+$/, "");
}

// Return the prompt with the ratio hint for `size` appended (replacing any
// previous hint). `auto` strips the hint entirely.
function withRatioHint(extraPrompt: string, size: string): string {
    const base = stripRatioHint(extraPrompt);
    const hint = SIZE_RATIO_HINTS[size];
    if (!hint) return base;
    return base ? `${base}\n${RATIO_HINT_MARKER}${hint}` : `${RATIO_HINT_MARKER}${hint}`;
}
const IMAGE_HOSTING_PROVIDER_OPTIONS = [
    { value: "none", label: "不使用图床" },
    { value: "imgbb", label: "ImgBB" },
] as const;
const imageGenerationIconStyle = { "--icon-color": "#0EA5E9" } as CSSProperties;

type Status = { success: boolean; message: string };

export function ImageGenerationSettings() {
    const [settings, setSettings] = useState<ImageGenerationSettingsType>(DEFAULT_IMAGE_GENERATION_SETTINGS);
    const [characters, setCharacters] = useState<Character[]>([]);
    const [referencePreviews, setReferencePreviews] = useState<Record<string, string>>({});
    const [userReferencePreview, setUserReferencePreview] = useState<string | null>(null);
    const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
    const [cropCharacterId, setCropCharacterId] = useState<string | null>(null);
    const [cropDraft, setCropDraft] = useState({ x: 0.27, y: 0.12, size: 0.46 });
    const [cropViewport, setCropViewport] = useState({ width: 0, height: 0 });
    const cropContainerRef = useRef<HTMLDivElement | null>(null);
    const cropDragRef = useRef<{ pointerId: number; startX: number; startY: number; cropX: number; cropY: number } | null>(null);
    const characterListRef = useRef<HTMLDivElement | null>(null);
    const characterScrollDragRef = useRef<{
        pointerId: number;
        startY: number;
        startScrollTop: number;
        maxScroll: number;
        maxThumbTravel: number;
    } | null>(null);
    const [characterScrollMetrics, setCharacterScrollMetrics] = useState({ scrollTop: 0, clientHeight: 0, scrollHeight: 0 });
    const [models, setModels] = useState<string[]>([]);
    const [isFetchingModels, setIsFetchingModels] = useState(false);
    const [naiModels, setNaiModels] = useState<string[]>(NOVELAI_COMMON_MODELS);
    const [isFetchingNaiModels, setIsFetchingNaiModels] = useState(false);
    const [isTesting, setIsTesting] = useState(false);
    const [status, setStatus] = useState<Status | null>(null);
    const [naiTokenStatus, setNaiTokenStatus] = useState<Status | null>(null);
    const [testPreviewUrl, setTestPreviewUrl] = useState<string | null>(null);
    const [pendingDeletePresetId, setPendingDeletePresetId] = useState<string | null>(null);
    const [pendingDeleteOpenAiPresetId, setPendingDeleteOpenAiPresetId] = useState<string | null>(null);
    const [imageCallRecords, setImageCallRecords] = useState(loadImageGenerationCallRecords);
    const openaiPresets = useMemo<OpenAiImagePreset[]>(() => (
        settings.openaiPresets?.length ? settings.openaiPresets : [{
            id: "preset_openai_default",
            name: "默认方案",
            requestMode: settings.requestMode,
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.model,
            size: settings.size,
            quality: settings.quality,
            extraPrompt: settings.extraPrompt,
        }]
    ), [settings]);
    const activeOpenAiPresetId = settings.activeOpenAiPresetId && openaiPresets.some(p => p.id === settings.activeOpenAiPresetId)
        ? settings.activeOpenAiPresetId
        : openaiPresets[0].id;
    const activeOpenAiPreset = openaiPresets.find(p => p.id === activeOpenAiPresetId) || openaiPresets[0];

    useEffect(() => {
        const refresh = () => setImageCallRecords(loadImageGenerationCallRecords());
        window.addEventListener("image-generation-diagnostics-updated", refresh);
        refresh();
        return () => window.removeEventListener("image-generation-diagnostics-updated", refresh);
    }, []);

    useEffect(() => {
        // Sync the ratio hint to the saved size on load, so the hint is present
        // by default (not only after the user manually switches the size).
        const loaded = loadImageGenerationSettings();
        const loadedPresets = loaded.openaiPresets?.length ? loaded.openaiPresets : [{
            id: "preset_openai_default",
            name: "默认方案",
            requestMode: loaded.requestMode,
            apiKey: loaded.apiKey,
            baseUrl: loaded.baseUrl,
            model: loaded.model,
            size: loaded.size,
            quality: loaded.quality,
            extraPrompt: loaded.extraPrompt,
        } satisfies OpenAiImagePreset];
        const loadedActiveId = loaded.activeOpenAiPresetId && loadedPresets.some(preset => preset.id === loaded.activeOpenAiPresetId)
            ? loaded.activeOpenAiPresetId
            : loadedPresets[0].id;
        const loadedActivePreset = loadedPresets.find(preset => preset.id === loadedActiveId) || loadedPresets[0];
        const syncedExtra = withRatioHint(loadedActivePreset.extraPrompt, loadedActivePreset.size);
        if (syncedExtra !== loadedActivePreset.extraPrompt) {
            const nextPresets = loadedPresets.map(preset => preset.id === loadedActiveId
                ? { ...preset, extraPrompt: syncedExtra }
                : preset);
            const next = { ...loaded, openaiPresets: nextPresets, activeOpenAiPresetId: loadedActiveId, extraPrompt: syncedExtra };
            saveImageGenerationSettings(next);
            setSettings(next);
        } else {
            setSettings(loaded);
        }
        const loadedCharacters = loadCharacters();
        setCharacters(loadedCharacters);
        setSelectedCharacterId(loadedCharacters[0]?.id || null);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const refs = settings.characterReferences || {};
        Promise.all(Object.entries(refs).map(async ([characterId, ref]) => {
            const dataUrl = ref.assetId ? await getChatImageFromIndexedDB(ref.assetId) : null;
            return [characterId, dataUrl] as const;
        })).then(entries => {
            if (cancelled) return;
            const next: Record<string, string> = {};
            for (const [characterId, dataUrl] of entries) {
                if (dataUrl) next[characterId] = dataUrl;
            }
            setReferencePreviews(next);
        });
        return () => { cancelled = true; };
    }, [settings.characterReferences]);

    useEffect(() => {
        let cancelled = false;
        const assetId = settings.characterReferences?.["__user__"]?.assetId;
        if (!assetId) { setUserReferencePreview(null); return; }
        void getChatImageFromIndexedDB(assetId).then(dataUrl => { if (!cancelled) setUserReferencePreview(dataUrl); });
        return () => { cancelled = true; };
    }, [settings.characterReferences]);

    useEffect(() => {
        return () => {
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
        };
    }, [testPreviewUrl]);

    const syncCharacterScrollMetrics = useCallback(() => {
        const list = characterListRef.current;
        if (!list) return;
        setCharacterScrollMetrics({
            scrollTop: list.scrollTop,
            clientHeight: list.clientHeight,
            scrollHeight: list.scrollHeight,
        });
    }, []);

    useEffect(() => {
        const frame = window.requestAnimationFrame(syncCharacterScrollMetrics);
        window.addEventListener("resize", syncCharacterScrollMetrics);
        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener("resize", syncCharacterScrollMetrics);
        };
    }, [characters, syncCharacterScrollMetrics]);

    const persist = useCallback((next: ImageGenerationSettingsType) => {
        setSettings(next);
        saveImageGenerationSettings(next);
    }, []);

    const updateSettings = useCallback((patch: Partial<ImageGenerationSettingsType>) => {
        persist({ ...settings, ...patch });
    }, [persist, settings]);

    const updateOpenAiPreset = useCallback((patch: Partial<OpenAiImagePreset>) => {
        const nextPresets = openaiPresets.map(preset => preset.id === activeOpenAiPresetId ? { ...preset, ...patch } : preset);
        const active = nextPresets.find(preset => preset.id === activeOpenAiPresetId) || nextPresets[0];
        persist({ ...settings, openaiPresets: nextPresets, activeOpenAiPresetId, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const addOpenAiPreset = useCallback(() => {
        const newId = `preset_openai_${Date.now()}`;
        const newPreset = { ...activeOpenAiPreset, id: newId, name: `${activeOpenAiPreset.name || "默认方案"}（副本）` };
        persist({ ...settings, openaiPresets: [...openaiPresets, newPreset], activeOpenAiPresetId: newId, requestMode: newPreset.requestMode, apiKey: newPreset.apiKey, baseUrl: newPreset.baseUrl, model: newPreset.model, size: newPreset.size, quality: newPreset.quality, extraPrompt: newPreset.extraPrompt });
    }, [activeOpenAiPreset, openaiPresets, persist, settings]);

    const deleteOpenAiPreset = useCallback(() => {
        if (openaiPresets.length <= 1) return;
        const next = openaiPresets.filter(preset => preset.id !== activeOpenAiPresetId);
        const active = next[0];
        persist({ ...settings, openaiPresets: next, activeOpenAiPresetId: active.id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [activeOpenAiPresetId, openaiPresets, persist, settings]);

    const selectOpenAiPreset = useCallback((id: string) => {
        const active = openaiPresets.find(preset => preset.id === id);
        if (!active) return;
        persist({ ...settings, activeOpenAiPresetId: id, requestMode: active.requestMode, apiKey: active.apiKey, baseUrl: active.baseUrl, model: active.model, size: active.size, quality: active.quality, extraPrompt: active.extraPrompt });
    }, [openaiPresets, persist, settings]);

    // NovelAI 预设管理与状态
    const naiSettings = useMemo(() => {
        const nai = settings.novelai;
        const presets = nai?.presets && nai.presets.length > 0 ? nai.presets : [DEFAULT_NOVELAI_PRESET];
        const activePreset = presets.find(p => p.id === nai?.activePresetId) || presets[0];
        return {
            apiKey: nai?.apiKey || "",
            requestMode: nai?.requestMode || settings.requestMode,
            activePresetId: activePreset.id,
            presets,
            activePreset,
        };
    }, [settings.novelai, settings.requestMode]);

    const updateNovelAi = useCallback((patch: Partial<import("@/lib/settings-types").NovelAiSettings>) => {
        persist({
            ...settings,
            novelai: {
                apiKey: naiSettings.apiKey,
                requestMode: naiSettings.requestMode,
                activePresetId: naiSettings.activePresetId,
                presets: naiSettings.presets,
                ...patch,
            },
        });
    }, [naiSettings, persist, settings]);

    const updateActivePreset = useCallback((patch: Partial<NovelAiPreset>) => {
        const nextPresets = naiSettings.presets.map(p => {
            if (p.id === naiSettings.activePresetId) {
                return { ...p, ...patch };
            }
            return p;
        });
        updateNovelAi({ presets: nextPresets });
    }, [naiSettings, updateNovelAi]);

    const addPreset = useCallback(() => {
        const newId = `preset_nai_${Date.now()}`;
        const newPreset: NovelAiPreset = {
            ...naiSettings.activePreset,
            id: newId,
            name: `${naiSettings.activePreset.name} (副本)`,
        };
        updateNovelAi({
            presets: [...naiSettings.presets, newPreset],
            activePresetId: newId,
        });
    }, [naiSettings, updateNovelAi]);

    const deletePreset = useCallback((presetId: string) => {
        if (naiSettings.presets.length <= 1) return;
        const deletedIndex = naiSettings.presets.findIndex(p => p.id === presetId);
        if (deletedIndex < 0) return;
        const nextPresets = naiSettings.presets.filter(p => p.id !== presetId);
        const nextActivePreset = nextPresets[Math.min(deletedIndex, nextPresets.length - 1)];
        updateNovelAi({
            presets: nextPresets,
            activePresetId: nextActivePreset.id,
        });
    }, [naiSettings, updateNovelAi]);

    const updateImageHosting = useCallback((patch: Partial<ImageGenerationSettingsType["imageHosting"]>) => {
        persist({
            ...settings,
            imageHosting: {
                ...settings.imageHosting,
                ...patch,
            },
        });
    }, [persist, settings]);

    const likelyModels = useMemo(() => filterLikelyImageModels(models), [models]);

    const fetchModels = async () => {
        setStatus(null);
        if (!activeOpenAiPreset.apiKey.trim() || !activeOpenAiPreset.baseUrl.trim()) {
            setStatus({ success: false, message: "请先填写 Base URL 和 API Key。" });
            return;
        }
        setIsFetchingModels(true);
        try {
            const fetched = await fetchImageGenerationModels(activeOpenAiPreset);
            setModels(fetched);
            setStatus({
                success: true,
                message: fetched.length > 0 ? `已拉取 ${fetched.length} 个模型。` : "接口返回为空，可手动填写模型名。",
            });
        } catch (err) {
            setModels([]);
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingModels(false);
        }
    };

    const fetchNaiModels = async () => {
        setNaiTokenStatus(null);
        if (!naiSettings.apiKey.trim()) {
            setNaiTokenStatus({ success: false, message: "请先填写 NovelAI API Token。" });
            return;
        }
        setIsFetchingNaiModels(true);
        try {
            const fetched = await fetchNovelAiModels(naiSettings.apiKey);
            setNaiModels(fetched);
            setNaiTokenStatus({
                success: true,
                message: `NovelAI Token 有效，已加载 ${fetched.length} 个常用模型。`,
            });
        } catch (err) {
            setNaiTokenStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsFetchingNaiModels(false);
        }
    };

    const testGeneration = async () => {
        setStatus(null);
        setIsTesting(true);
        try {
            const result = await generateImageFromConfiguredApi({
                description: settings.provider === "novelai"
                    ? "1girl, solo, upper body, white coffee cup on the wooden table, soft window light"
                    : "一张放在桌面上的白色咖啡杯，柔和自然光，真实照片风格",
                settings: { ...settings, enabled: true },
            });
            if (!result) throw new Error("图像生成未返回结果。");
            if (testPreviewUrl) URL.revokeObjectURL(testPreviewUrl);
            setTestPreviewUrl(URL.createObjectURL(result.blob));
            setStatus({ success: true, message: "测试生图成功。" });
        } catch (err) {
            setStatus({ success: false, message: err instanceof Error ? err.message : String(err) });
        } finally {
            setIsTesting(false);
        }
    };

    const uploadReference = async (characterId: string, file: File) => {
        const assetId = await saveChatImageToIndexedDB(file);
        const current = settings.characterReferences?.[characterId];
        const faceCrop = current?.faceCrop || { x: 0.27, y: 0.12, size: 0.46 };
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: {
                    ...current,
                    assetId,
                    updatedAt: Date.now(),
                    enabled: true,
                    faceCrop,
                },
            },
        });
        setCropDraft(faceCrop);
        setCropCharacterId(characterId);
    };

    const updateCharacterReference = (
        characterId: string,
        patch: Partial<ImageGenerationSettingsType["characterReferences"][string]>,
    ) => {
        const current = settings.characterReferences?.[characterId];
        persist({
            ...settings,
            characterReferences: {
                ...(settings.characterReferences || {}),
                [characterId]: {
                    ...current,
                    ...patch,
                    updatedAt: Date.now(),
                },
            },
        });
    };

    const openFaceCrop = (characterId: string) => {
        const crop = settings.characterReferences?.[characterId]?.faceCrop || { x: 0.27, y: 0.12, size: 0.46 };
        setCropDraft(crop);
        setCropViewport({ width: 0, height: 0 });
        setCropCharacterId(characterId);
    };

    const updateCropViewport = () => {
        const rect = cropContainerRef.current?.getBoundingClientRect();
        if (rect) setCropViewport({ width: rect.width, height: rect.height });
    };

    const handleCropPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        cropDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            cropX: cropDraft.x,
            cropY: cropDraft.y,
        };
    };

    const handleCropPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = cropDragRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !cropViewport.width || !cropViewport.height) return;
        const side = cropDraft.size * Math.min(cropViewport.width, cropViewport.height);
        const maxX = Math.max(0, 1 - side / cropViewport.width);
        const maxY = Math.max(0, 1 - side / cropViewport.height);
        setCropDraft(current => ({
            ...current,
            x: Math.max(0, Math.min(maxX, drag.cropX + (event.clientX - drag.startX) / cropViewport.width)),
            y: Math.max(0, Math.min(maxY, drag.cropY + (event.clientY - drag.startY) / cropViewport.height)),
        }));
    };

    const handleCropPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (cropDragRef.current?.pointerId === event.pointerId) cropDragRef.current = null;
    };

    const handleCharacterScrollPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const list = characterListRef.current;
        const track = event.currentTarget.parentElement?.getBoundingClientRect();
        const thumb = event.currentTarget.getBoundingClientRect();
        if (!list || !track) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        characterScrollDragRef.current = {
            pointerId: event.pointerId,
            startY: event.clientY,
            startScrollTop: list.scrollTop,
            maxScroll: Math.max(0, list.scrollHeight - list.clientHeight),
            maxThumbTravel: Math.max(1, track.height - thumb.height),
        };
    };

    const handleCharacterScrollPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
        const drag = characterScrollDragRef.current;
        const list = characterListRef.current;
        if (!drag || !list || drag.pointerId !== event.pointerId) return;
        const delta = event.clientY - drag.startY;
        list.scrollTop = Math.max(0, Math.min(drag.maxScroll, drag.startScrollTop + delta / drag.maxThumbTravel * drag.maxScroll));
        syncCharacterScrollMetrics();
    };

    const handleCharacterScrollPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
        if (characterScrollDragRef.current?.pointerId === event.pointerId) characterScrollDragRef.current = null;
    };

    const selectedCharacter = characters.find(character => character.id === selectedCharacterId) || null;
    const activeCropPreview = cropCharacterId === "__user__" ? userReferencePreview : (cropCharacterId ? referencePreviews[cropCharacterId] : null);
    const selectedReference = selectedCharacterId ? settings.characterReferences?.[selectedCharacterId] : undefined;
    const characterListOverflows = characterScrollMetrics.scrollHeight > characterScrollMetrics.clientHeight + 1;
    const characterScrollThumbPercent = characterListOverflows
        ? Math.max(14, characterScrollMetrics.clientHeight / characterScrollMetrics.scrollHeight * 100)
        : 100;
    const characterScrollTopPercent = characterListOverflows
        ? (characterScrollMetrics.scrollTop / Math.max(1, characterScrollMetrics.scrollHeight - characterScrollMetrics.clientHeight))
            * (100 - characterScrollThumbPercent)
        : 0;

    return (
        <div className="flex flex-col gap-6 pb-8">
            <div className="flex items-center">
                <h2 className="m-0 mx-2 ts-28 font-bold italic leading-none text-black">Image Generation</h2>
            </div>

            <div className="menu-group">
                <div className="menu-item">
                    <span className="card-icon" style={imageGenerationIconStyle}>
                        <Sparkles size={22} strokeWidth={1.75} />
                    </span>
                    <span className="settings-tools-menu-copy">
                        <span className="menu-label appearance-menu-item-label">启用自动生图</span>
                        <span className="menu-desc settings-tools-menu-desc">角色输出照片标签时自动调用图像生成 API。</span>
                    </span>
                    <span className="menu-right settings-tools-menu-toggle">
                        <Toggle checked={settings.enabled} onChange={(enabled) => updateSettings({ enabled })} className="settings-toggle-control" />
                    </span>
                </div>
            </div>

            <div className="menu-group p-4 flex flex-col gap-4">
                <div className="flex flex-col gap-1">
                    <label className="menu-desc ml-1">生图提供方 / 引擎</label>
                    <Select
                        value={settings.provider || "openai"}
                        onChange={(event) => updateSettings({
                            provider: event.target.value as "openai" | "novelai",
                        })}
                    >
                        <option value="openai">OpenAI 兼容 (通用模型 / DALL-E / Flux / SD 中转等)</option>
                        <option value="novelai">NovelAI 原生接口 (官方 API)</option>
                    </Select>
                </div>

                {settings.provider === "novelai" && (
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">请求方式</label>
                        <Select
                            value={naiSettings.requestMode}
                            onChange={(event) => updateNovelAi({
                                requestMode: event.target.value as ImageGenerationSettingsType["requestMode"],
                            })}
                        >
                            <option value="server">服务端转发（推荐，可避免跨域报错）</option>
                            <option value="direct">浏览器直连（需接口允许 CORS 跨域）</option>
                        </Select>
                    </div>
                )}

                {settings.provider === "novelai" ? (
                    /* --- NovelAI 配置面板 --- */
                    <>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">NovelAI API Token</label>
                            <Input
                                type="password"
                                value={naiSettings.apiKey}
                                onChange={(event) => {
                                    updateNovelAi({ apiKey: event.target.value });
                                    setNaiTokenStatus(null);
                                }}
                                placeholder="pst-..."
                            />
                            <span className="menu-desc ml-1">可在 NovelAI 官网 Account 页面获取 Persistent API Token。</span>
                            {naiTokenStatus && (
                                <div role={naiTokenStatus.success ? "status" : "alert"} className="mt-2">
                                    <Alert variant={naiTokenStatus.success ? "success" : "danger"}>
                                        <AlertCircle size={16} className="mt-[2px] shrink-0" />
                                        <span className="break-all leading-[1.5]">{naiTokenStatus.message}</span>
                                    </Alert>
                                </div>
                            )}
                        </div>

                        {/* 预设管理栏 */}
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">NovelAI 参数预设</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                                    <button
                                        type="button"
                                        onClick={addPreset}
                                        className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                        title="复制当前为新预设"
                                    >
                                        <Plus size={14} />
                                        新建预设
                                    </button>
                                    {naiSettings.presets.length > 1 && (
                                        <button
                                            type="button"
                                            onClick={() => setPendingDeletePresetId(naiSettings.activePresetId)}
                                            className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"
                                            title="删除当前选中的预设"
                                        >
                                            <Trash2 size={14} />
                                            删除预设
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">切换当前预设</span>
                                    <Select
                                        value={naiSettings.activePresetId}
                                        onChange={(event) => updateNovelAi({ activePresetId: event.target.value })}
                                    >
                                        {naiSettings.presets.map(p => (
                                            <option key={p.id} value={p.id}>{p.name}</option>
                                        ))}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">预设名称</span>
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.name}
                                        onChange={(event) => updateActivePreset({ name: event.target.value })}
                                        placeholder="预设名称"
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 预设详细参数 */}
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型 (Model)</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={naiSettings.activePreset.model}
                                        onChange={(event) => updateActivePreset({ model: event.target.value })}
                                        placeholder="nai-diffusion-4-curated-preview"
                                        className={naiModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {naiModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="选择常见 NAI 模型"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateActivePreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">快速选择模型...</option>
                                                {naiModels.map(m => (
                                                    <option key={m} value={m}>{m}</option>
                                                ))}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchNaiModels}
                                    disabled={isFetchingNaiModels}
                                    className="ui-btn ui-btn-soft-action min-h-11 shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingNaiModels ? "animate-spin" : ""} />
                                    {isFetchingNaiModels ? "验证中" : "验证 Token"}
                                </button>
                            </div>
                            <span className="menu-desc ml-1 opacity-70">模型下拉列表内置于应用；“验证 Token”只检查凭证，不会发起生图。</span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">分辨率 (Resolution)</label>
                            <Select
                                value={naiSettings.activePreset.resolution}
                                onChange={(event) => updateActivePreset({ resolution: event.target.value })}
                            >
                                {NOVELAI_RESOLUTION_OPTIONS.map(opt => (
                                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                                ))}
                            </Select>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">采样器 (Sampler)</label>
                                <Select
                                    value={naiSettings.activePreset.sampler}
                                    onChange={(event) => updateActivePreset({ sampler: event.target.value })}
                                >
                                    {NOVELAI_SAMPLER_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">调度器 (Schedule)</label>
                                <Select
                                    value={naiSettings.activePreset.noiseSchedule || "karras"}
                                    onChange={(event) => updateActivePreset({ noiseSchedule: event.target.value })}
                                >
                                    {NOVELAI_NOISE_SCHEDULE_OPTIONS.map(opt => (
                                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                                    ))}
                                </Select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">步数 (Steps: {naiSettings.activePreset.steps})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={50}
                                    value={naiSettings.activePreset.steps}
                                    onChange={(event) => updateActivePreset({
                                        steps: Math.max(1, Math.min(50, parseInt(event.target.value, 10) || 28)),
                                    })}
                                />
                            </div>

                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">提示词相关度 (CFG Scale: {naiSettings.activePreset.scale})</label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={30}
                                    step={0.1}
                                    value={naiSettings.activePreset.scale}
                                    onChange={(event) => updateActivePreset({
                                        scale: Math.max(1, Math.min(30, parseFloat(event.target.value) || 6.0)),
                                    })}
                                />
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">画师串 / 正面质量提示词 (Positive / Quality)</label>
                            <Textarea
                                value={naiSettings.activePreset.positivePrompt}
                                onChange={(event) => updateActivePreset({ positivePrompt: event.target.value })}
                                placeholder="masterpiece, best quality, very aesthetic, artist:..."
                                rows={3}
                            />
                            <span className="menu-desc ml-1 opacity-70">
                                会作为基础风格与角色聊天的画面描述组合发送。
                            </span>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">负面提示词 (Undesired Content / Negative)</label>
                            <Textarea
                                value={naiSettings.activePreset.negativePrompt}
                                onChange={(event) => updateActivePreset({ negativePrompt: event.target.value })}
                                placeholder="lowres, bad anatomy, bad hands, blurry..."
                                rows={3}
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-2 pt-1">
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.qualityToggle !== false}
                                    onChange={(e) => updateActivePreset({ qualityToggle: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用质量词 (Quality+)</span>
                            </label>
                            <label className="flex min-h-11 items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={naiSettings.activePreset.smea === true}
                                    onChange={(e) => updateActivePreset({ smea: e.target.checked })}
                                    className="rounded border-[var(--c-card-border)]"
                                />
                                <span className="text-xs font-medium">启用 SMEA</span>
                            </label>
                        </div>
                    </>
                ) : (
                    /* --- OpenAI 模式配置面板 --- */
                    <>
                        <div className="flex flex-col gap-2 rounded-xl bg-[var(--c-input)]/40 p-3 border border-[var(--c-card-border)]">
                            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                                <label className="menu-label text-sm font-semibold">OpenAI API 配置预设</label>
                                <div className="grid grid-cols-2 gap-2 sm:flex">
                                    <button type="button" onClick={addOpenAiPreset} className="ui-btn ui-btn-soft-action min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Plus size={14} />新建预设</button>
                                    {openaiPresets.length > 1 && <button type="button" onClick={() => setPendingDeleteOpenAiPresetId(activeOpenAiPresetId)} className="ui-btn ui-btn-danger min-h-11 !px-3 !py-2 text-xs flex items-center gap-1"><Trash2 size={14} />删除预设</button>}
                                </div>
                            </div>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">当前预设</span>
                                    <Select value={activeOpenAiPresetId} onChange={(event) => selectOpenAiPreset(event.target.value)}>
                                        {openaiPresets.map(preset => <option key={preset.id} value={preset.id}>{preset.name.trim() || "未命名预设"}</option>)}
                                    </Select>
                                </div>
                                <div className="flex flex-col gap-1">
                                    <span className="menu-desc ml-1">预设备注</span>
                                    <Input type="text" value={activeOpenAiPreset.name} onChange={(event) => updateOpenAiPreset({ name: event.target.value })} placeholder="未命名预设" />
                                </div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">请求方式</label>
                            <Select value={activeOpenAiPreset.requestMode} onChange={(event) => updateOpenAiPreset({ requestMode: event.target.value as ImageGenerationSettingsType["requestMode"] })}>
                                <option value="server">服务端转发（推荐，可避免跨域报错）</option>
                                <option value="direct">浏览器直连（需接口允许 CORS 跨域）</option>
                            </Select>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">Base URL</label>
                            <Input
                                type="url"
                                value={activeOpenAiPreset.baseUrl}
                                onChange={(event) => updateOpenAiPreset({ baseUrl: event.target.value })}
                                placeholder="https://api.example.com/v1"
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">API Key</label>
                            <Input
                                type="password"
                                value={activeOpenAiPreset.apiKey}
                                onChange={(event) => updateOpenAiPreset({ apiKey: event.target.value })}
                                placeholder="sk-..."
                            />
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">模型名</label>
                            <div className="flex gap-2">
                                <div className="relative flex-1">
                                    <Input
                                        type="text"
                                        value={activeOpenAiPreset.model}
                                        onChange={(event) => updateOpenAiPreset({ model: event.target.value })}
                                        placeholder="gpt-image-2 / image2 / chatgpt-image-latest"
                                        className={likelyModels.length > 0 ? "w-full pr-9" : "w-full"}
                                    />
                                    {likelyModels.length > 0 && (
                                        <>
                                            <ChevronDown size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 opacity-60" />
                                            <select
                                                aria-label="选择拉取到的模型"
                                                value=""
                                                onChange={(event) => {
                                                    if (event.target.value) updateOpenAiPreset({ model: event.target.value });
                                                }}
                                                className="absolute inset-y-0 right-0 w-10 cursor-pointer opacity-0"
                                            >
                                                <option value="">选择拉取到的模型...</option>
                                                {likelyModels.map(model => <option key={model} value={model}>{model}</option>)}
                                            </select>
                                        </>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    onClick={fetchModels}
                                    disabled={isFetchingModels}
                                    className="ui-btn ui-btn-soft-action shrink-0"
                                >
                                    <RefreshCw size={16} className={isFetchingModels ? "animate-spin" : ""} />
                                    {isFetchingModels ? "拉取中" : "拉取模型"}
                                </button>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">尺寸</label>
                                <Select value={activeOpenAiPreset.size} onChange={(event) => {
                                        const size = event.target.value;
                                        updateOpenAiPreset({ size, extraPrompt: withRatioHint(activeOpenAiPreset.extraPrompt, size) });
                                    }}>
                                    {SIZE_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                            <div className="flex flex-col gap-1">
                                <label className="menu-desc ml-1">质量</label>
                                <Select value={activeOpenAiPreset.quality} onChange={(event) => updateOpenAiPreset({ quality: event.target.value })}>
                                    {QUALITY_OPTIONS.map(option => <option key={option} value={option}>{option}</option>)}
                                </Select>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">补充提示词</label>
                            <Textarea
                                value={activeOpenAiPreset.extraPrompt}
                                onChange={(event) => updateOpenAiPreset({ extraPrompt: event.target.value })}
                                placeholder="会和角色输出的图片描述一起发送给生图模型。"
                                rows={4}
                            />
                            <p className="menu-desc ml-1 opacity-70">
                                选择尺寸后会自动在末尾追加一句「{RATIO_HINT_MARKER}…」构图提示，用于纠正部分不认 size 参数的接口（如 gpt-image-2）。可手动修改或删除。
                            </p>
                        </div>
                    </>
                )}

                <div className="flex gap-3">
                    <button
                        type="button"
                        onClick={testGeneration}
                        disabled={isTesting}
                        className="ui-btn ui-btn-success flex-1"
                    >
                        <Image size={16} />
                        {isTesting ? "测试中..." : "测试生图"}
                    </button>
                </div>

                {status && (
                    <div role={status.success ? "status" : "alert"}>
                        <Alert variant={status.success ? "success" : "danger"}>
                            <AlertCircle size={16} className="mt-[2px] shrink-0" />
                            <span className="break-all leading-[1.5]">{status.message}</span>
                        </Alert>
                    </div>
                )}
                {testPreviewUrl && (
                    <img
                        src={testPreviewUrl}
                        alt="测试生图结果"
                        className="max-h-[220px] max-w-full self-start rounded-xl border border-[var(--c-card-border)] object-contain"
                    />
                )}
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">生图 API 调用记录</p>
                <div className="menu-group p-3 flex flex-col gap-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="menu-desc">本机保存最近 80 次请求；不记录 API Key 或请求头。</span>
                        <button type="button" onClick={() => { clearImageGenerationCallRecords(); setImageCallRecords([]); }} className="shrink-0 rounded-lg border border-[var(--c-card-border)] px-2 py-1 text-xs">清空</button>
                    </div>
                    {imageCallRecords.length === 0 ? <p className="py-3 text-center text-xs opacity-60">暂无生图调用记录。</p> : imageCallRecords.slice(0, 20).map(record => (
                        <details key={record.id} className="rounded-xl border border-[var(--c-card-border)] bg-[var(--c-card)] p-3">
                            <summary className="cursor-pointer list-none">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="text-xs font-semibold">{record.status === "success" ? "成功" : record.status === "failed" ? "失败" : "未执行"} · {record.appId || "未标记 APP"}</span>
                                    <span className="text-[10px] opacity-60">{new Date(record.startedAt).toLocaleString()} · {(record.durationMs / 1000).toFixed(1)}s</span>
                                </div>
                                <p className="mt-1 break-all text-[11px] opacity-75">{record.provider} / {record.model} · {record.participantNames.join("、") || "未指定角色"} · {record.usedReferenceImage ? "使用参考图" : "未使用参考图"}</p>
                    <p className="mt-1 text-[11px] opacity-70">实际加载参考图：{typeof record.referenceImageCount === "number" ? record.referenceImageCount + " 张" : "未知（请求在加载阶段失败或旧记录）"}{record.referenceImageLabels?.length ? " · " + record.referenceImageLabels.join("、") : ""}</p>
                            </summary>
                            <div className="mt-3 space-y-2 text-[11px]">
                                <p>角色 ID：{record.participantIds.join(", ") || "无"}</p>
                                <p>参考图模式：{record.referenceImageMode}</p>
                                {record.error && <p className="break-words text-rose-600">错误：{record.error}</p>}
                                <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 p-2">{record.prompt}</pre>
                            </div>
                        </details>
                    ))}
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Image Hosting</p>
                <div className="menu-group">
                    <div className="menu-item">
                        <span className="card-icon" style={imageGenerationIconStyle}>
                            <Upload size={22} strokeWidth={1.75} />
                        </span>
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">允许小卷上传图床</span>
                            <span className="menu-desc settings-tools-menu-desc">开启后，小卷的图像处理套件可以把本地素材上传到公开图床并拿 URL 写 CSS。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.allowMascotUpload}
                                onChange={(allowMascotUpload) => updateImageHosting({ allowMascotUpload })}
                                className="settings-toggle-control"
                            />
                        </span>
                    </div>
                </div>

                <div className="menu-group p-4 flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">图床提供方</label>
                        <Select
                            value={settings.imageHosting.provider}
                            onChange={(event) => updateImageHosting({
                                provider: event.target.value as ImageGenerationSettingsType["imageHosting"]["provider"],
                            })}
                        >
                            {IMAGE_HOSTING_PROVIDER_OPTIONS.map(option => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1">
                        <label className="menu-desc ml-1">ImgBB API Key</label>
                        <Input
                            type="password"
                            value={settings.imageHosting.imgbbApiKey}
                            onChange={(event) => updateImageHosting({ imgbbApiKey: event.target.value })}
                            placeholder="从 imgbb.com/api/1 获取"
                            disabled={settings.imageHosting.provider !== "imgbb"}
                        />
                        <span className="menu-desc ml-1">Key 只保存在当前项目设置里；小卷工具结果不会显示它。</span>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">默认过期秒数</label>
                            <Input
                                type="number"
                                min={0}
                                max={15552000}
                                value={settings.imageHosting.defaultExpirationSeconds}
                                onChange={(event) => updateImageHosting({
                                    defaultExpirationSeconds: Math.max(0, Number.parseInt(event.target.value, 10) || 0),
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">0 表示不过期。</span>
                        </div>
                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">上传上限 KB</label>
                            <Input
                                type="number"
                                min={64}
                                max={32768}
                                value={Math.round(settings.imageHosting.maxUploadBytes / 1024)}
                                onChange={(event) => updateImageHosting({
                                    maxUploadBytes: Math.max(64, Number.parseInt(event.target.value, 10) || 900) * 1024,
                                })}
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                            <span className="menu-desc ml-1">默认 900KB，适合 CSS 主题素材。</span>
                        </div>
                    </div>

                    <div className="menu-item !px-0 !py-0">
                        <span className="settings-tools-menu-copy">
                            <span className="menu-label appearance-menu-item-label">上传前自动转 WebP</span>
                            <span className="menu-desc settings-tools-menu-desc">减小 PNG/JPEG 体积；GIF 会保留原格式。</span>
                        </span>
                        <span className="menu-right settings-tools-menu-toggle">
                            <Toggle
                                checked={settings.imageHosting.autoConvertToWebp}
                                onChange={(autoConvertToWebp) => updateImageHosting({ autoConvertToWebp })}
                                className="settings-toggle-control"
                                disabled={settings.imageHosting.provider !== "imgbb"}
                            />
                        </span>
                    </div>
                </div>
            </div>

            <div className="flex flex-col gap-2">
                <p className="settings-menu-section-title">Character Identity</p>
                {settings.provider === "novelai" && (
                    <Alert variant="info">
                        <Info size={16} className="mt-[2px] shrink-0" />
                        <span className="leading-[1.5]">NovelAI 当前适配器只使用角色文字特征，不读取脸部参考图；为了避免多角色身份被模型融合，不会把多人参考图硬塞成一张。切回支持多图编辑的 OpenAI 兼容模型后，已保存的参考图仍会保留。</span>
                    </Alert>
                )}
                <div className="relative">
                    <div
                        ref={characterListRef}
                        className="menu-group max-h-[292px] overflow-y-auto overscroll-contain pr-3"
                        onScroll={syncCharacterScrollMetrics}
                    >
                        <button
                            type="button"
                            className={`menu-item w-full text-left ${selectedCharacterId === "__user__" ? "bg-[var(--c-input)]" : ""}`}
                            onClick={() => setSelectedCharacterId("__user__")}
                        >
                            <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                {userReferencePreview ? <img src={userReferencePreview} alt="" className="h-full w-full object-cover" /> : <span className="flex h-full w-full items-center justify-center"><Camera size={18} /></span>}
                            </span>
                            <span className="min-w-0 flex flex-1 flex-col">
                                <span className="menu-label truncate">用户本人</span>
                                <span className="menu-desc truncate">{userReferencePreview ? "用户身份参考已配置" : "上传用户本人参考图"}</span>
                            </span>
                        </button>
                        {characters.length === 0 ? (
                            <div className="ui-empty py-8">
                                <Camera size={22} />
                                <span className="menu-desc">暂无角色。</span>
                            </div>
                        ) : characters.map(character => {
                            const preview = referencePreviews[character.id];
                            const ref = settings.characterReferences?.[character.id];
                            return (
                                <button
                                    key={character.id}
                                    type="button"
                                    className={`menu-item w-full text-left ${selectedCharacterId === character.id ? "bg-[var(--c-input)]" : ""}`}
                                    onClick={() => setSelectedCharacterId(character.id)}
                                >
                                    <span className="h-11 w-11 shrink-0 overflow-hidden rounded-xl bg-[var(--c-input)]">
                                        {preview ? (
                                            <img src={preview} alt="" className="h-full w-full object-cover" />
                                        ) : character.avatar ? (
                                            <img src={character.avatar} alt="" className="h-full w-full object-cover" />
                                        ) : (
                                            <span className="flex h-full w-full items-center justify-center ts-13 font-semibold text-[var(--c-icon)]">
                                                {character.name.slice(0, 1)}
                                            </span>
                                        )}
                                    </span>
                                    <span className="min-w-0 flex flex-1 flex-col">
                                        <span className="menu-label truncate">{character.name}</span>
                                        <span className="menu-desc truncate">
                                            {preview ? (ref?.enabled === false ? "参考图已关闭" : "参考图已启用") : "未上传参考图"}
                                            {ref?.featurePrompt?.trim() ? " · 已设人物特征" : ""}
                                        </span>
                                    </span>
                                    <ChevronDown size={16} className={selectedCharacterId === character.id ? "-rotate-90 opacity-70" : "opacity-40"} />
                                </button>
                            );
                        })}
                    </div>
                    {characterListOverflows && (
                        <div className="pointer-events-auto absolute bottom-3 right-1 top-3 z-10 w-1.5 rounded-full bg-black/10">
                            <button
                                type="button"
                                aria-label="拖动角色列表滚动条"
                                className="absolute left-0 w-1.5 touch-none rounded-full bg-black/45 shadow-sm"
                                style={{
                                    height: `${characterScrollThumbPercent}%`,
                                    top: `${characterScrollTopPercent}%`,
                                }}
                                onPointerDown={handleCharacterScrollPointerDown}
                                onPointerMove={handleCharacterScrollPointerMove}
                                onPointerUp={handleCharacterScrollPointerUp}
                                onPointerCancel={handleCharacterScrollPointerUp}
                            />
                        </div>
                    )}
                </div>

                {(selectedCharacter || selectedCharacterId === "__user__") && (
                    <div className="menu-group p-4 flex flex-col gap-4">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <div className="menu-label truncate">{selectedCharacter?.name || "用户本人"} · 身份参考设定</div>
                                <div className="menu-desc">仅用于稳定人物身份，不会改动角色卡正文。</div>
                            </div>
                        </div>

                        <div className="flex flex-col gap-1">
                            <label className="menu-desc ml-1">专属人物特征提示词</label>
                            <Textarea
                                value={selectedReference?.featurePrompt || ""}
                                onChange={(event) => updateCharacterReference(selectedCharacterId || "__user__", { featurePrompt: event.target.value })}
                                placeholder="例如：黑色长卷发、灰蓝色眼睛、左眼下有一颗小痣、清冷气质……"
                                rows={4}
                            />
                            <span className="menu-desc ml-1">生成该角色图片时自动追加，OpenAI 与 NovelAI 均生效。</span>
                        </div>

                        {settings.provider === "novelai" && (
                            <div className="menu-item !px-0 !py-0">
                                <span className="settings-tools-menu-copy">
                                    <span className="menu-label appearance-menu-item-label">NovelAI 使用人物专属提示词</span>
                                    <span className="menu-desc settings-tools-menu-desc">关闭后 NAI 只使用当前画面描述与预设，不追加上方人物特征。</span>
                                </span>
                                <span className="menu-right settings-tools-menu-toggle">
                                    <Toggle
                                        checked={selectedReference?.novelAiFeaturePromptEnabled !== false}
                                        onChange={(novelAiFeaturePromptEnabled) => updateCharacterReference(selectedCharacterId || "__user__", { novelAiFeaturePromptEnabled })}
                                        className="settings-toggle-control"
                                    />
                                </span>
                            </div>
                        )}

                        <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-soft-action flex-1"
                                    onClick={() => {
                                        const input = document.createElement("input");
                                        input.type = "file";
                                        input.accept = "image/*";
                                        input.onchange = async () => {
                                            const file = input.files?.[0];
                                            if (file && selectedCharacterId) await uploadReference(selectedCharacterId, file);
                                        };
                                        input.click();
                                    }}
                                >
                                    <Upload size={16} />
                                    {(selectedCharacterId === "__user__" ? userReferencePreview : referencePreviews[selectedCharacterId || ""]) ? "更换参考图" : "上传参考图"}
                                </button>
                                {(selectedCharacterId === "__user__" ? userReferencePreview : referencePreviews[selectedCharacterId || ""]) && (
                                    <button type="button" className="ui-btn ui-btn-outline flex-1" onClick={() => selectedCharacterId && openFaceCrop(selectedCharacterId)}>
                                        <ScanFace size={16} />
                                        选取脸部
                                    </button>
                                )}
                        </div>
                        <label className="menu-item">
                            <span className="menu-label">身份参考图发送模式</span>
                            <select value={settings.referenceImageMode ?? "multi"} onChange={event => updateSettings({ referenceImageMode: event.target.value as "multi" | "collage" | "current" })} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5 text-xs">
                                <option value="multi">多图上传（推荐，支持多图的 OpenAI 兼容服务）</option>
                                <option value="collage">拼成一张带编号参考图（兼容只收单图的服务）</option>
                                <option value="current">仅当前主角色参考图</option>
                            </select>
                        </label>
                        <p className="menu-desc">OpenAI 兼容生图会自动传入出镜人员的参考图；若服务只认第一张，可切到「拼图」。NovelAI 暂不接收参考图片，但会使用上方填写的身份特征描述。</p>
                    </div>
                )}
            </div>

            {cropCharacterId && activeCropPreview && (
                <ContentDialog
                    title="选取脸部锁定区域"
                    confirmLabel="保存选区"
                    cancelLabel="取消"
                    onCancel={() => setCropCharacterId(null)}
                    onConfirm={() => {
                        updateCharacterReference(cropCharacterId, { faceCrop: cropDraft });
                        setCropCharacterId(null);
                    }}
                >
                    <div className="flex flex-col gap-3">
                        <p className="menu-desc">拖动方框覆盖脸部，生图时会优先使用选中的身份区域，尽量减少服装和背景干扰。</p>
                        <div ref={cropContainerRef} className="relative mx-auto w-fit max-h-[52vh] max-w-full overflow-hidden rounded-xl bg-black/80">
                            <img
                                src={activeCropPreview || ""}
                                alt="参考图脸部选取"
                                draggable={false}
                                className="block max-h-[52vh] max-w-full select-none object-contain"
                                onLoad={updateCropViewport}
                            />
                            {cropViewport.width > 0 && cropViewport.height > 0 && (
                                <button
                                    type="button"
                                    aria-label="拖动脸部选区"
                                    className="absolute cursor-move touch-none border-2 border-white bg-white/10 shadow-[0_0_0_999px_rgba(0,0,0,0.42)]"
                                    style={{
                                        left: cropDraft.x * cropViewport.width,
                                        top: cropDraft.y * cropViewport.height,
                                        width: cropDraft.size * Math.min(cropViewport.width, cropViewport.height),
                                        height: cropDraft.size * Math.min(cropViewport.width, cropViewport.height),
                                    }}
                                    onPointerDown={handleCropPointerDown}
                                    onPointerMove={handleCropPointerMove}
                                    onPointerUp={handleCropPointerUp}
                                    onPointerCancel={handleCropPointerUp}
                                >
                                    <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-2 py-1 text-xs text-white">拖到脸部</span>
                                </button>
                            )}
                        </div>
                        <label className="flex items-center gap-3 menu-desc">
                            选区大小
                            <input
                                type="range"
                                min="18"
                                max="80"
                                value={Math.round(cropDraft.size * 100)}
                                onChange={(event) => setCropDraft(current => ({ ...current, size: Number(event.target.value) / 100 }))}
                                className="flex-1"
                            />
                        </label>
                    </div>
                </ContentDialog>
            )}

            {pendingDeleteOpenAiPresetId && (
                <ConfirmDialog
                    title="确认删除预设？"
                    message={`预设“${openaiPresets.find(p => p.id === pendingDeleteOpenAiPresetId)?.name || "未命名预设"}”删除后无法恢复，其中的 API Key 也会一起删除。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deleteOpenAiPreset();
                        setPendingDeleteOpenAiPresetId(null);
                    }}
                    onCancel={() => setPendingDeleteOpenAiPresetId(null)}
                />
            )}
            {pendingDeletePresetId && (
                <ConfirmDialog
                    title="确认删除预设？"
                    message={`预设“${naiSettings.presets.find(p => p.id === pendingDeletePresetId)?.name || "未命名预设"}”删除后无法恢复。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deletePreset(pendingDeletePresetId);
                        setPendingDeletePresetId(null);
                    }}
                    onCancel={() => setPendingDeletePresetId(null)}
                />
            )}

            {pendingDeleteOpenAiPresetId && (
                <ConfirmDialog
                    title="确认删除 OpenAI 预设？"
                    message={`预设“${openaiPresets.find(preset => preset.id === pendingDeleteOpenAiPresetId)?.name || "未命名预设"}”及其中的 API 配置删除后无法恢复。`}
                    icon={Trash2}
                    variant="danger"
                    confirmLabel="确认删除"
                    cancelLabel="取消"
                    onConfirm={() => {
                        deleteOpenAiPreset();
                        setPendingDeleteOpenAiPresetId(null);
                    }}
                    onCancel={() => setPendingDeleteOpenAiPresetId(null)}
                />
            )}

        </div>
    );
}
