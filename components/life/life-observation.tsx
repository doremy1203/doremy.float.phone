"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Clock3, RefreshCw, Settings2, Eye, ChevronLeft, ImagePlus } from "lucide-react";
import type { Character } from "@/lib/character-types";
import { loadChatContacts, loadChatMessages, loadChatSessions, type ChatMessage } from "@/lib/chat-storage";
import { simpleLLMCall } from "@/lib/api-helpers";
import { loadApiConfigs, resolveAuxiliaryApiConfig, loadImageGenerationSettings } from "@/lib/settings-storage";
import { kvGet, kvSet, hydrateKvDb } from "@/lib/kv-db";
import { getActorClock, resolveActorLifeNow } from "@/lib/life/life-runtime";
import { loadVirtualLifeState } from "@/lib/life/life-storage";
import { generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import type { LifeScheduleSlot, LifeTimelineEntry } from "@/lib/life/life-types";
import { recordLifeDiagnostic } from "@/lib/life/life-diagnostics";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { renderUserNameMacro } from "@/lib/user-macro";

type ObservationEntry = {
  id: string;
  characterId: string;
  characterName: string;
  fromAt: string;
  toAt: string;
  createdAt: string;
  content: string;
  title?: string;
  eventTime?: string;
  locationName?: string;
  people?: string[];
  imageMediaRef?: string;
  imagePrompt?: string;
};
type CharacterObservationConfig = { enabled: boolean; intervalMinutes: number; lastGeneratedAt?: string; coveredUntil?: string };
type ObservationData = {
  settings: { retentionDays: number; maxBackfillDays: number };
  characters: Record<string, CharacterObservationConfig>;
  entries: ObservationEntry[];
};
const KEY = "ai_phone_life_observation_v1";
const DEFAULT_DATA: ObservationData = { settings: { retentionDays: 90, maxBackfillDays: 3 }, characters: {}, entries: [] };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
const fmt = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const makeId = () => "observation-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);

function loadData(): ObservationData {
  try {
    const raw = kvGet(KEY);
    if (!raw) return structuredClone(DEFAULT_DATA);
    const parsed = JSON.parse(raw) as Partial<ObservationData>;
    return {
      settings: {
        retentionDays: clamp(Number(parsed.settings?.retentionDays ?? 90), 1, 3650),
        maxBackfillDays: clamp(Number(parsed.settings?.maxBackfillDays ?? 3), 1, 30),
      },
      characters: parsed.characters && typeof parsed.characters === "object" ? parsed.characters : {},
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch { return structuredClone(DEFAULT_DATA); }
}
function saveData(data: ObservationData): ObservationData {
  const cutoff = Date.now() - clamp(data.settings.retentionDays, 1, 3650) * 86_400_000;
  const saved = { ...data, entries: data.entries.filter(entry => new Date(entry.createdAt).getTime() >= cutoff) };
  kvSet(KEY, JSON.stringify(saved));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("life-observation-updated"));
  return saved;
}
function relevantContext(characterId: string, from: number, to: number) {
  const state = loadVirtualLifeState();
  const schedules = state.schedules.filter(slot => slot.ownerType === "character" && slot.ownerId === characterId
    && new Date(slot.endAt).getTime() > from && new Date(slot.startAt).getTime() < to)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const timeline = state.timeline.filter(entry => entry.actorId === characterId
    && new Date(entry.occurredAt).getTime() >= from && new Date(entry.occurredAt).getTime() <= to)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const clock = getActorClock(state, "character", characterId);
  return { schedules, timeline, virtualNow: resolveActorLifeNow(clock), state };
}
function formatSchedule(slot: LifeScheduleSlot) {
  return `- ${fmt(slot.startAt)}–${fmt(slot.endAt)}｜${slot.title}｜地点：${slot.plannedLocationName || "未指定"}｜类型：${slot.kind}`;
}
function formatTimeline(entry: LifeTimelineEntry) {
  return `- ${fmt(entry.occurredAt)}｜${entry.title}${entry.locationName ? "｜地点：" + entry.locationName : ""}${entry.details ? "｜细节：" + entry.details : ""}`;
}

export function LifeObservation({ characters, active = false, onNotice }: { characters: Character[]; active?: boolean; onNotice?: (message: string) => void }) {
  const userDisplayName = resolveUserIdentity()?.name?.trim() || "用户";
  const [data, setData] = useState<ObservationData>(DEFAULT_DATA);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [imageBusyId, setImageBusyId] = useState<string | null>(null);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const busyRef = useRef(new Set<string>());
  const dataRef = useRef(data);
  dataRef.current = data;
  const selectedCharacter = characters.find(character => character.id === selectedId) ?? null;
  const selectedConfig = selectedId ? data.characters[selectedId] ?? { enabled: false, intervalMinutes: 180 } : null;
  const selectedEntries = useMemo(() => data.entries.filter(entry => entry.characterId === selectedId).sort((a, b) => b.toAt.localeCompare(a.toAt)), [data.entries, selectedId]);

  const refresh = useCallback(() => setData(loadData()), []);
  useEffect(() => {
    let alive = true;
    const urls: Record<string, string> = {};
    void Promise.all(data.entries.filter(entry => entry.imageMediaRef).map(async entry => {
      const url = await loadMediaObjectUrl(entry.imageMediaRef!);
      if (url) urls[entry.id] = url;
    })).then(() => {
      if (!alive) { Object.values(urls).forEach(url => URL.revokeObjectURL(url)); return; }
      setImageUrls(previous => { Object.values(previous).forEach(url => URL.revokeObjectURL(url)); return urls; });
    });
    return () => { alive = false; };
  }, [data.entries.map(entry => entry.id + ":" + (entry.imageMediaRef ?? "")).join("|")]);
  useEffect(() => {
    let alive = true;
    void hydrateKvDb().then(() => { if (alive) refresh(); });
    const onUpdate = () => refresh();
    window.addEventListener("virtual-life-state-updated", onUpdate);
    window.addEventListener("life-observation-updated", onUpdate);
    return () => { alive = false; window.removeEventListener("virtual-life-state-updated", onUpdate); window.removeEventListener("life-observation-updated", onUpdate); };
  }, [refresh]);

  const updateData = (updater: (current: ObservationData) => ObservationData) => {
    setData(current => {
      const next = updater(current);
      const saved = saveData(next);
      dataRef.current = saved;
      return saved;
    });
  };
  const tell = (message: string) => { setNotice(message); onNotice?.(message); };

  const generateForCharacter = useCallback(async (character: Character, manual = false) => {
    if (busyRef.current.has(character.id)) return;
    const latestData = loadData();
    const config = latestData.characters[character.id] ?? { enabled: false, intervalMinutes: 180 };
    if (!manual && !config.enabled) return;
    const { schedules, timeline, virtualNow, state } = relevantContext(character.id, 0, Date.now() + 1);
    // 观察只能写**已发生**的事情：虚拟时钟可以因倍速跑到现实前面，
    // 但观察窗口的上限永远是现实当前时间，绝不允许把卡片写到未来。
    const nowMs = Math.min(virtualNow.getTime(), Date.now());
    const maxBackfillMs = clamp(latestData.settings.maxBackfillDays, 1, 30) * 86_400_000;
    const defaultStart = nowMs - maxBackfillMs;
    const previousCovered = config.coveredUntil ? new Date(config.coveredUntil).getTime() : defaultStart;
    const fromMs = Math.max(previousCovered, defaultStart);
    if (fromMs >= nowMs - 60_000) {
      if (manual) tell("目前没有需要补写的新行程；之后有新行程时再打开即可继续记录。");
      return;
    }
    const coveredSchedules = schedules.filter(slot => new Date(slot.endAt).getTime() > fromMs && new Date(slot.startAt).getTime() < nowMs);
    const coveredTimeline = timeline.filter(entry => new Date(entry.occurredAt).getTime() >= fromMs && new Date(entry.occurredAt).getTime() <= nowMs);
    if (!coveredSchedules.length && !coveredTimeline.length) {
      updateData(current => ({ ...current, characters: { ...current.characters, [character.id]: { ...config, coveredUntil: new Date(nowMs).toISOString(), lastGeneratedAt: new Date().toISOString() } } }));
      if (manual) tell("这段时间没有可用的行程或生活事件记录，已推进观察时间；可以在角色日常里先补全行程。");
      return;
    }
    const contact = loadChatContacts().find(item => item.characterId === character.id);
    const session = loadChatSessions().find(item => item.contactId === contact?.id && !item.isGroup) ?? {
      id: "life-observation-" + character.id,
      contactId: contact?.id ?? character.id,
      unreadCount: 0,
      updatedAt: new Date().toISOString(),
      isPinned: false,
      isGroup: false,
      alias: character.name,
    };
    busyRef.current.add(character.id);
    setBusyId(character.id);
    try {
      const recent = session.id.startsWith("life-observation-")
        ? []
        : loadChatMessages(session.id, 8).filter(message => message.status !== "failed" && !message.isRetracted);
      const scheduleText = coveredSchedules.map(formatSchedule).join("\n") || "（这段时间没有排定的行程）";
      const timelineText = coveredTimeline.map(formatTimeline).join("\n") || "（没有额外的已记录事件）";
      const worldContext = [
        character.persona ? "角色设定：" + character.persona : "",
        character.personality ? "性格：" + character.personality : "",
        (character.tags ?? []).length ? "标签：" + (character.tags ?? []).join("、") : "",
        state.locations.map(location => location.characterHabits?.[character.id] ? `${location.name}的习惯：${location.characterHabits[character.id]}` : "").filter(Boolean).join("\n"),
      ].filter(Boolean).join("\n");
      const prompt: ChatMessage = {
        id: makeId(), sessionId: session.id, role: "user", status: "sent", createdAt: new Date().toISOString(),
        content: [
          "【生活系统·观察TA的生活】请把这段时间拆成多个独立的重要事件卡片，而不是一大段长文。只输出 JSON 对象，包含 events 数组；每项包含 time（时间段）、location（地点）、people（人物数组）、title（事件标题）、description（具体描写）。每个事件必须是一个独立、可单独配图的连续场景；按时间顺序排列，通常生成2—8张，事件不足时不要凑数。不要把计划冒充已发生的事实，不要假装玩家在场，不要编造重大事件。所有事件的 time 必须是这段时间内已经过去的具体时刻，禁止出现任何未来时间。",
           "当前用户显示名称：" + (userDisplayName) + "。如果记录确实提到当前用户，请在 JSON 中使用字面占位符 {{user}}，不要写死显示名称；不要把 {{user}} 用来指代其他人物。",
          "时间范围：" + new Date(fromMs).toISOString() + " 至 " + new Date(nowMs).toISOString(),
          "每张卡片首先总结一个行程/活动的结果：这段时间角色在哪里、做了什么、事情进展到哪一步；不要按聊天消息逐条复述，也不要把 timeline 的每条记录改写成一句话。",
          "每个行程总结下，只挑选有画面感的关键时刻展开成生活片段：动作、光线、声音、手边物品、未被注意的小习惯、短暂迟疑或情绪变化。让场景有连续空间感与氛围，像生活切片，而不是聊天摘要或流水账。",
          "可合理补写轻微、符合人设的日常细节，但必须标记为生活描写而非已确认事实；不得编造重大事件、对话、用户在场或角色不可能知道的信息。行程是计划而非已发生事实，实际记录优先。",
          "每张卡片都要有明确的场景核心和总结，细节为场景服务；避免重复同一件事，按时间顺序排列，并自然落在当前时间附近，留下仍在继续的生活状态。",
          worldContext,
          "【角色行程】\n" + scheduleText,
          "【已记录的现实/互动事件】\n" + timelineText,
          "【最近私聊仅供人设语气参考，不要把私聊内容当作本时间段发生的事件】\n" + recent.slice(-4).map(item => (item.role === "assistant" ? character.name : "{{user}}") + "：" + item.content).join("\n"),
        ].filter(Boolean).join("\n\n"),
      };
      const config = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") ?? loadApiConfigs()[0];
      if (!config) throw new Error("没有可用的 API 配置");
      let rawContent = "";
      for (let attempt = 0; attempt < 2 && !rawContent; attempt += 1) {
        const result = await simpleLLMCall(config, [
          { role: "system", content: "你是生活观察记录器。只输出严格 JSON 对象：{\"events\":[...]}。不要解释、不要 markdown、不要线下聊天 XML。" },
          { role: "user", content: String(prompt.content) + (attempt ? "\n\n上次输出不是合法 JSON。请只返回 JSON 对象。" : "") },
        ], { temperature: 0.4 });
        rawContent = String(result.content ?? "").trim();
      }
      if (!rawContent) throw new Error("模型返回了空内容");
      const cleaned = rawContent.replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
      let events: Array<{ time?: string; location?: string; people?: string[]; title?: string; description?: string }> = [];
      try {
        const first = cleaned.indexOf("{"), last = cleaned.lastIndexOf("}");
        if (first >= 0 && last > first) {
          const parsed = JSON.parse(cleaned.slice(first, last + 1)) as { events?: unknown };
          if (Array.isArray(parsed.events)) events = parsed.events.filter((item): item is { time?: string; location?: string; people?: string[]; title?: string; description?: string } => Boolean(item && typeof item === "object" && typeof (item as { description?: unknown }).description === "string"));
        }
      } catch { /* 旧模型未按 JSON 返回时，继续用分段回退以保留内容。 */ }
      if (!events.length) throw new Error("模型没有按 JSON 返回 events；请重试，不会保存散文兜底");
      const createdAt = new Date().toISOString();
      const entries: ObservationEntry[] = events.slice(0, 12).map(event => ({
        id: makeId(), characterId: character.id, characterName: character.name,
        fromAt: new Date(fromMs).toISOString(), toAt: new Date(nowMs).toISOString(), createdAt,
        title: String(event.title || "生活片段").slice(0, 80), eventTime: String(event.time || "").slice(0, 100), locationName: String(event.location || "").slice(0, 100),
        people: Array.isArray(event.people) ? event.people.filter(item => typeof item === "string").slice(0, 8).map(item => item === "用户" || item === userDisplayName ? "{{user}}" : item) : [],
        content: String(event.description || "").trim()
          .replace(/用户/g, "{{user}}"),
      })).filter(entry => entry.content);
      if (!entries.length) throw new Error("模型没有返回可保存的事件卡片");
      updateData(current => {
        const currentConfig = current.characters[character.id] ?? config;
        return { ...current, entries: [...current.entries, ...entries], characters: { ...current.characters, [character.id]: { ...currentConfig, lastGeneratedAt: createdAt, coveredUntil: new Date(nowMs).toISOString() } } };
      });
      recordLifeDiagnostic({ source: "生活观察", event: "生活片段补写完成", status: "ok", detail: "已为 " + character.name + " 生成 " + entries.length + " 张事件卡片。", meta: { characterId: character.id, fromAt: new Date(fromMs).toISOString(), toAt: new Date(nowMs).toISOString(), manual } });
      tell("已为「" + character.name + "」生成 " + entries.length + " 张独立生活事件卡片。");
    } catch (error) {
      recordLifeDiagnostic({ source: "生活观察", event: "生活片段补写失败", status: "error", detail: error instanceof Error ? error.message : String(error), meta: { characterId: character.id, manual } });
      tell(error instanceof Error ? "生活描写生成失败：" + error.message : "生活描写生成失败，请检查模型配置。");
    } finally {
      busyRef.current.delete(character.id);
      setBusyId(current => current === character.id ? null : current);
    }
  }, [onNotice]);

  // Auto-generation runs while the life system is open. Browser/Android background
  // suspension is not treated as a reliable scheduler; opening a dossier catches up.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const current = loadData();
      const now = Date.now();
      for (const character of characters) {
        const config = current.characters[character.id] ?? { enabled: false, intervalMinutes: 180 };
        if (!config.enabled || busyRef.current.has(character.id)) continue;
        const last = config.lastGeneratedAt ? new Date(config.lastGeneratedAt).getTime() : now - clamp(config.intervalMinutes, 15, 10080) * 60_000;
        if (now - last >= clamp(config.intervalMinutes, 15, 10080) * 60_000) void generateForCharacter(character, false);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [characters, generateForCharacter]);

  const openCharacter = (character: Character) => {
    setSelectedId(character.id);
    const config = data.characters[character.id] ?? { enabled: false, intervalMinutes: 180 };
    if (!config.coveredUntil) {
      const state = loadVirtualLifeState();
      const now = resolveActorLifeNow(getActorClock(state, "character", character.id));
      const start = new Date(now.getTime() - data.settings.maxBackfillDays * 86_400_000).toISOString();
      updateData(current => ({ ...current, characters: { ...current.characters, [character.id]: { ...config, coveredUntil: start } } }));
    }
    void generateForCharacter(character, true);
  };
  const generateEntryImage = async (entry: ObservationEntry) => {
    if (imageBusyId) return;
    if (!loadImageGenerationSettings().enabled) { tell("请先到「系统设置 → 图像生成 API」启用并配置生图服务。"); return; }
    setImageBusyId(entry.id);
    try {
      const result = await generateImageFromConfiguredApi({
        description: [
          "根据以下生活观察记录生成一张写实感/插画感的单帧生活场景图。画面只呈现一个连续场景，不要拼贴、漫画分格、字幕或水印。角色外观应尽量遵循角色卡与已配置的角色参考图。",
          "角色：" + entry.characterName,
          "生活时间：" + fmt(entry.fromAt) + " 至 " + fmt(entry.toAt),
          "生活记录：\n" + renderUserNameMacro(entry.content, userDisplayName).slice(0, 5000),
          "请优先选择记录中最有画面感的一个片段，保持人物动作、地点、光线和氛围与文字一致。",
        ].join("\n\n"),
        characterId: entry.characterId,
        appId: "life",
      });
      if (!result) throw new Error("生图服务没有返回图片，请检查 API 配置。");
      updateData(current => ({ ...current, entries: current.entries.map(item => item.id === entry.id ? { ...item, imageMediaRef: result.mediaRef, imagePrompt: result.prompt } : item) }));
      tell("已为这段生活记录生成场景图。");
    } catch (error) {
      tell("场景图生成失败：" + (error instanceof Error ? error.message : "请检查生图 API 配置。"));
    } finally { setImageBusyId(null); }
  };
  const clearCharacter = (characterId: string) => updateData(current => ({ ...current, entries: current.entries.filter(entry => entry.characterId !== characterId) }));
  const deleteEntry = (entryId: string) => updateData(current => ({ ...current, entries: current.entries.filter(entry => entry.id !== entryId) }));
  const regenerateEntry = (entry: ObservationEntry) => {
    updateData(current => ({
      ...current,
      entries: current.entries.filter(item => item.id !== entry.id),
      characters: {
        ...current.characters,
        [entry.characterId]: { ...(current.characters[entry.characterId] ?? { enabled: false, intervalMinutes: 180 }), coveredUntil: entry.fromAt },
      },
    }));
    if (selectedCharacter) window.setTimeout(() => void generateForCharacter(selectedCharacter, true), 50);
  };

  return <section hidden={!active} className="min-w-0 max-w-full space-y-4 break-words [overflow-wrap:anywhere]">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--life-accent)]">Life Observer</p><h2 className="mt-1 text-xl font-semibold text-stone-800">观察 TA 的生活</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-stone-500">从角色自己的行程与已记录事件出发，补写你没有亲眼看到的生活片段。点进角色才生成，不会一口气为所有角色生成长文。</p></div>
      <button type="button" onClick={() => setSettingsOpen(value => !value)} className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"><Settings2 size={16}/>观察设置</button>
    </div>
    {settingsOpen && <div className="rounded-2xl border border-stone-200 bg-white/80 p-4">
      <h3 className="font-medium text-stone-800">全局记录策略</h3>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="text-sm">最多向前补写几天<input type="number" min={1} max={30} value={data.settings.maxBackfillDays} onChange={event => updateData(current => ({ ...current, settings: { ...current.settings, maxBackfillDays: clamp(Number(event.target.value), 1, 30) } }))} className="mt-1 block w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
        <label className="text-sm">生活记录保留天数<input type="number" min={1} max={3650} value={data.settings.retentionDays} onChange={event => updateData(current => ({ ...current, settings: { ...current.settings, retentionDays: clamp(Number(event.target.value), 1, 3650) } }))} className="mt-1 block w-full rounded-xl border border-stone-200 bg-white px-3 py-2.5"/></label>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-stone-500">清理按记录生成时间计算；缩短保留期会在下次保存时清除过期记录。补写上限按角色自己的虚拟生活时间计算。</p>
    </div>}
    {!selectedCharacter ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {characters.map(character => {
        const config = data.characters[character.id] ?? { enabled: false, intervalMinutes: 180 };
        const count = data.entries.filter(entry => entry.characterId === character.id).length;
        return <article key={character.id} className="rounded-2xl border border-white/80 bg-white/75 p-4 shadow-sm">
          <div className="flex items-start gap-3">
            {character.avatar ? <img src={character.avatar} alt="" className="h-12 w-12 rounded-full object-cover"/> : <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-[#b88768]/15 text-lg text-[#8f634b]">{character.name.slice(0,1)}</div>}
            <div className="min-w-0 flex-1"><h3 className="font-semibold text-stone-800">{character.name}</h3><p className="mt-1 text-xs text-stone-500">{count ? `已有 ${count} 段生活记录` : "还没有生成生活记录"}</p><p className="mt-1 text-xs text-stone-400">{config.enabled ? `自动描写已开启 · 每 ${config.intervalMinutes} 分钟` : "自动描写未开启"}</p></div>
            <button type="button" onClick={() => openCharacter(character)} className="inline-flex shrink-0 items-center gap-1 rounded-xl bg-[var(--life-accent)] px-3 py-2 text-sm text-white"><Eye size={15}/>观察</button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-100 pt-3">
            <label className="flex items-center gap-2 text-xs text-stone-600"><input type="checkbox" checked={config.enabled} onChange={event => updateData(current => ({ ...current, characters: { ...current.characters, [character.id]: { ...(current.characters[character.id] ?? { intervalMinutes: 180 }), enabled: event.target.checked, intervalMinutes: current.characters[character.id]?.intervalMinutes ?? 180 } } }))}/>自动生成</label>
            <label className="flex items-center gap-2 text-xs text-stone-500">间隔
              <select value={config.intervalMinutes} onChange={event => updateData(current => ({ ...current, characters: { ...current.characters, [character.id]: { ...(current.characters[character.id] ?? { enabled: false }), intervalMinutes: clamp(Number(event.target.value), 15, 10080) } } }))} className="rounded-lg border border-stone-200 bg-white px-2 py-1.5">
                {[15,30,60,120,180,360,720,1440].map(value => <option key={value} value={value}>{value < 60 ? value + " 分钟" : value < 1440 ? value / 60 + " 小时" : "1 天"}</option>)}
              </select>
            </label>
          </div>
        </article>;
      })}
      {!characters.length && <p className="rounded-2xl bg-white/70 p-5 text-sm text-stone-500">还没有角色。先在小手机里创建或导入角色卡。</p>}
    </div> : <div className="space-y-3">
      <div className="flex items-center justify-between gap-3"><button type="button" onClick={() => setSelectedId(null)} className="inline-flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"><ChevronLeft size={16}/>角色列表</button><div className="flex gap-2"><button type="button" disabled={busyId === selectedCharacter.id} onClick={() => void generateForCharacter(selectedCharacter, true)} className="inline-flex items-center gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm disabled:opacity-50"><RefreshCw size={15} className={busyId === selectedCharacter.id ? "animate-spin" : ""}/>继续补写</button></div></div>
      <article className="rounded-2xl border border-white/80 bg-white/75 p-4">
        <div className="flex items-center gap-3">{selectedCharacter.avatar ? <img src={selectedCharacter.avatar} alt="" className="h-12 w-12 rounded-full object-cover"/> : <div className="grid h-12 w-12 place-items-center rounded-full bg-[#b88768]/15 text-lg">{selectedCharacter.name.slice(0,1)}</div>}<div><h3 className="text-lg font-semibold text-stone-800">{selectedCharacter.name} 的生活观察记录</h3><p className="text-xs text-stone-500">{selectedEntries.length} 段记录 · {selectedEntries[0] ? "最近记录至 " + fmt(selectedEntries[0].toAt) : "首次观察"}</p></div></div>
        <div className="mt-3 flex items-start gap-2 rounded-xl bg-[#f7efe5] p-3 text-xs leading-relaxed text-stone-600"><Clock3 size={15} className="mt-0.5 shrink-0"/>点开后会按上次覆盖的时间继续补写到角色当前虚拟时间；超出「最多补写天数」的旧时段会跳过，避免一次生成过长。</div>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-stone-100 bg-white/80 p-3"><div className="min-w-0"><p className="text-sm font-medium text-stone-700">自动生活描写</p><p className="mt-0.5 text-xs text-stone-500">每隔设定时间生成一次；仅在应用处于前台时自动触发，进入角色页面时也会补齐新行程。</p></div><input type="checkbox" aria-label="开启该角色自动生活描写" checked={selectedConfig?.enabled ?? false} onChange={event => updateData(current => ({ ...current, characters: { ...current.characters, [selectedCharacter.id]: { ...(current.characters[selectedCharacter.id] ?? { intervalMinutes: 180 }), enabled: event.target.checked } } }))}/></div>
      </article>
      {busyId === selectedCharacter.id && <div className="rounded-xl bg-white/80 p-3 text-sm text-stone-600">正在整理行程、时间线并生成生活描写……</div>}
      {selectedEntries.map(entry => <article key={entry.id} className="rounded-2xl border border-stone-200/70 bg-white/85 p-4 shadow-sm"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 pb-2"><div className="flex items-center gap-2 text-xs font-semibold text-[var(--life-accent)]"><BookOpen size={15}/>{entry.eventTime || (fmt(entry.fromAt) + " — " + fmt(entry.toAt))}</div><div className="flex items-center gap-3"><button type="button" disabled={imageBusyId === entry.id} onClick={() => void generateEntryImage(entry)} className="inline-flex items-center gap-1 text-xs text-[var(--life-accent)] disabled:opacity-50"><ImagePlus size={14}/>{imageBusyId === entry.id ? "正在生成…" : entry.imageMediaRef ? "重新生成场景图" : "生成场景图"}</button><button type="button" onClick={() => regenerateEntry(entry)} className="text-xs text-stone-500 hover:text-[var(--life-accent)]">重新生成这段</button><button type="button" onClick={() => deleteEntry(entry.id)} className="text-xs text-stone-400 hover:text-red-600">删除</button></div></div><div className="mt-3 border-l-2 border-[var(--life-accent)]/35 pl-3"><h3 className="font-serif text-base font-semibold text-stone-800">{entry.title || "生活片段"}</h3>{(entry.locationName || entry.people?.length) && <p className="mt-1 text-[11px] text-stone-500">{entry.locationName ? "地点：" + entry.locationName : ""}{entry.locationName && entry.people?.length ? " · " : ""}{entry.people?.length ? "人物：" + entry.people.map(person => renderUserNameMacro(person, userDisplayName)).join("、") : ""}</p>}<p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-stone-700">{renderUserNameMacro(entry.content, userDisplayName)}</p></div>{entry.imageMediaRef && (imageUrls[entry.id] ? <img src={imageUrls[entry.id]} alt={entry.characterName + "的生活场景图"} className="mt-3 max-h-[420px] w-full rounded-xl object-contain bg-stone-100"/> : <p className="mt-3 text-xs text-stone-400">场景图已保存，正在读取图片…</p>)}</article>)}
      {!selectedEntries.length && busyId !== selectedCharacter.id && <p className="rounded-2xl bg-white/70 p-5 text-sm text-stone-500">还没有生活描写。点击「继续补写」开始观察。</p>}
      <div className="flex flex-wrap gap-2"><button type="button" onClick={() => clearCharacter(selectedCharacter.id)} className="rounded-xl border border-red-100 bg-white px-3 py-2 text-xs text-red-600">清空该角色全部记录</button><button type="button" onClick={() => setSelectedId(null)} className="rounded-xl border border-stone-200 bg-white px-3 py-2 text-xs text-stone-600">返回角色列表</button></div>
    </div>}
    {notice && <div role="status" className="rounded-xl border border-stone-200 bg-white/80 px-3 py-2 text-sm text-stone-600">{notice}<button type="button" onClick={() => setNotice("")} className="ml-2 text-stone-400">×</button></div>}
  </section>;
}
