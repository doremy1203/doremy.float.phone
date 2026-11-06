// lib/memory-storage.ts
// IndexedDB persistence for long-term memory entries + short-term events + localStorage config.

import type { MemoryEntry, MemoryConfig } from "./memory-types";
import { DEFAULT_MEMORY_CONFIG } from "./memory-types";
import { kvGet, kvSet, kvRemove, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";

// ── Long-term memory DB (unchanged from v1) ──

const DB_NAME = "ai_phone_memory_db_v1";
const DB_VERSION = 3;
const STORE_NAME = "memories";

const CONFIG_KEY = "ai_phone_memory_config_v1";

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function ensureMemoryIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_created")) {
        store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    }
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    return openIndexedDbAtLeast(DB_NAME, DB_VERSION, (db, _oldVersion, tx) => {
        let store: IDBObjectStore;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
            store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        } else {
            store = tx!.objectStore(STORE_NAME);
        }
        ensureMemoryIndexes(store);
    }).catch(() => null);
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// ── Long-term Entry CRUD ──

export async function saveMemoryEntry(entry: MemoryEntry): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function loadMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index("by_character");
            entries = await runRequest(idx.getAll(characterId));
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId);
        }
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return entries;
    } finally {
        db.close();
    }
}

export async function loadMemoryEntriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return entries.filter(entry => entry.type === type);
}

export async function deleteMemoryEntry(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteMemoryEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {
            store.delete(id);
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
}

export async function deleteCharacterMemories(characterId: string): Promise<void> {
    const entries = await loadMemoryEntries(characterId);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function deleteCharacterMemoriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<void> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function getAllCharacterIdsWithMemories(): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const entries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
        const ids = new Set<string>();
        for (const e of entries) ids.add(e.characterId);
        return Array.from(ids);
    } finally {
        db.close();
    }
}

export async function getMemoryCount(characterId: string): Promise<number> {
    const entries = await loadMemoryEntries(characterId);
    return entries.length;
}

export async function getMemoryCountByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<number> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    return entries.length;
}

// ── Config (localStorage for fast sync access) ──

export function loadMemoryConfig(): MemoryConfig {
    if (typeof window === "undefined") return { ...DEFAULT_MEMORY_CONFIG };
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_MEMORY_CONFIG };
        const parsed = JSON.parse(raw) as Partial<MemoryConfig>;
        const config: MemoryConfig = {
            ...DEFAULT_MEMORY_CONFIG,
            ...parsed,
            shortTermAllowedSources: {
                ...DEFAULT_MEMORY_CONFIG.shortTermAllowedSources,
                ...(parsed.shortTermAllowedSources ?? {}),
            },
            // 旧配置迁移：首次升级时沿用原来源选择，之后与短期来源开关独立。
            longTermAllowedSources: {
                ...DEFAULT_MEMORY_CONFIG.longTermAllowedSources,
                ...(parsed.longTermAllowedSources ?? parsed.shortTermAllowedSources ?? {}),
            },
            shortTermSourceLimits: {
                ...DEFAULT_MEMORY_CONFIG.shortTermSourceLimits,
                ...(parsed.shortTermSourceLimits ?? {}),
            },
            shortTermAppLimits: {
                ...DEFAULT_MEMORY_CONFIG.shortTermAppLimits,
                ...(parsed.shortTermAppLimits ?? {}),
            },
            shortTermLimitVersion: parsed.shortTermLimitVersion ?? 0,
        };
        // Migrate values that exactly match the previous built-in defaults. Other custom values are preserved; a custom value identical to an old default cannot be distinguished from that default.
        if ((parsed.shortTermLimitVersion ?? 0) < 2) {
            const limits = { ...(config.shortTermAppLimits ?? {}) };
            if (limits.chat === 30) limits.chat = 0;
            if (limits.group_chat === 24) limits.group_chat = 0;
            if (limits.life === 20) limits.life = 0;
            if (limits.phone_widget === 4) limits.phone_widget = 50;
            config.shortTermAppLimits = limits;
            config.shortTermLimitVersion = 2;
            kvSet(CONFIG_KEY, JSON.stringify(config));
        }
        return config;
    } catch {
        return { ...DEFAULT_MEMORY_CONFIG };
    }
}

export function saveMemoryConfig(config: MemoryConfig): void {
    if (typeof window === "undefined") return;
    kvSet(CONFIG_KEY, JSON.stringify(config));
}

// ── Per-character event counter (localStorage) ──

const EVENT_COUNTER_PREFIX = "ai_phone_mem_evt_count_";
const LAST_SUMMARY_TS_PREFIX = "ai_phone_mem_last_sum_";
const CORE_COUNTER_PREFIX = "ai_phone_mem_core_count_";
const LAST_CORE_SUMMARY_TS_PREFIX = "ai_phone_mem_last_core_sum_";
registerKvMigration(CONFIG_KEY);
registerDynamicPrefix(EVENT_COUNTER_PREFIX);
registerDynamicPrefix(LAST_SUMMARY_TS_PREFIX);
registerDynamicPrefix(CORE_COUNTER_PREFIX);
registerDynamicPrefix(LAST_CORE_SUMMARY_TS_PREFIX);

/**
 * Move memory and per-character summary metadata written under legacy
 * ChatContact.id values to the canonical Character.id. The entry rewrite is a
 * single IndexedDB transaction; source keys are removed only after copying.
 */
export async function migrateCharacterMemoryIdentities(
    mappings: Array<{ fromId: string; toId: string }>,
): Promise<{ migratedEntries: number; migratedMetadata: number; available: boolean }> {
    const map = new Map(mappings.filter(item => item.fromId && item.toId && item.fromId !== item.toId)
        .map(item => [item.fromId, item.toId]));
    if (map.size === 0) return { migratedEntries: 0, migratedMetadata: 0, available: true };
    const db = await openDb();
    if (!db) return { migratedEntries: 0, migratedMetadata: 0, available: false };
    let migratedEntries = 0;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const request = store.getAll();
        await new Promise<void>((resolve, reject) => {
            request.onsuccess = () => {
                try {
                    for (const entry of request.result as MemoryEntry[]) {
                        const nextCharacterId = map.get(entry.characterId);
                        if (!nextCharacterId) continue;
                        store.put({ ...entry, characterId: nextCharacterId });
                        migratedEntries += 1;
                    }
                } catch (error) {
                    reject(error);
                }
            };
            request.onerror = () => reject(request.error || new Error("读取旧角色记忆失败"));
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error("迁移角色记忆失败"));
            tx.onabort = () => reject(tx.error || new Error("角色记忆迁移事务中止"));
        });
    } finally {
        db.close();
    }

    let migratedMetadata = 0;
    const moveCounter = (prefix: string) => {
        for (const [fromId, toId] of map) {
            const oldValue = Number(kvGet(prefix + fromId) || 0);
            if (!oldValue) continue;
            const nextValue = Number(kvGet(prefix + toId) || 0);
            kvSet(prefix + toId, String(nextValue + oldValue));
            kvRemove(prefix + fromId);
            migratedMetadata += 1;
        }
    };
    const moveLatestTimestamp = (prefix: string) => {
        for (const [fromId, toId] of map) {
            const oldValue = kvGet(prefix + fromId);
            if (!oldValue) continue;
            const nextValue = kvGet(prefix + toId);
            if (!nextValue || oldValue > nextValue) kvSet(prefix + toId, oldValue);
            kvRemove(prefix + fromId);
            migratedMetadata += 1;
        }
    };
    moveCounter(EVENT_COUNTER_PREFIX);
    moveCounter(CORE_COUNTER_PREFIX);
    moveLatestTimestamp(LAST_SUMMARY_TS_PREFIX);
    moveLatestTimestamp(LAST_CORE_SUMMARY_TS_PREFIX);
    for (const [fromId, toId] of map) {
        const oldRaw = kvGet(SUMMARY_STATUS_PREFIX + fromId);
        if (!oldRaw) continue;
        const nextRaw = kvGet(SUMMARY_STATUS_PREFIX + toId);
        try {
            const oldStatus = JSON.parse(oldRaw) as { at?: string };
            const nextStatus = nextRaw ? JSON.parse(nextRaw) as { at?: string } : null;
            if (!nextStatus?.at || (oldStatus.at && oldStatus.at > nextStatus.at)) {
                kvSet(SUMMARY_STATUS_PREFIX + toId, oldRaw);
            }
        } catch {
            if (!nextRaw) kvSet(SUMMARY_STATUS_PREFIX + toId, oldRaw);
        }
        kvRemove(SUMMARY_STATUS_PREFIX + fromId);
        migratedMetadata += 1;
    }
    return { migratedEntries, migratedMetadata, available: true };
}

export type MemorySummaryStatus = {
    at: string;
    ok: boolean;
    error?: string;
    eventCount?: number;
};

const SUMMARY_STATUS_PREFIX = "ai_phone_memory_summary_status:";
registerDynamicPrefix(SUMMARY_STATUS_PREFIX);

export function saveMemorySummaryStatus(characterId: string, status: MemorySummaryStatus): void {
    if (typeof window === "undefined") return;
    kvSet(SUMMARY_STATUS_PREFIX + characterId, JSON.stringify(status));
}

export function loadMemorySummaryStatus(characterId: string): MemorySummaryStatus | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = kvGet(SUMMARY_STATUS_PREFIX + characterId);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<MemorySummaryStatus>;
        return typeof parsed?.at === "string" && typeof parsed?.ok === "boolean"
            ? { at: parsed.at, ok: parsed.ok, error: typeof parsed.error === "string" ? parsed.error : undefined, eventCount: typeof parsed.eventCount === "number" ? parsed.eventCount : undefined }
            : null;
    } catch { return null; }
}

export function getEventCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(EVENT_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementEventCounter(characterId: string): number {
    const next = getEventCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(EVENT_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetEventCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(EVENT_COUNTER_PREFIX + characterId, "0");
}

export function getLastSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getCoreMemoryCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(CORE_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementCoreMemoryCounter(characterId: string): number {
    const next = getCoreMemoryCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(CORE_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetCoreMemoryCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(CORE_COUNTER_PREFIX + characterId, "0");
}

export function getLastCoreSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CORE_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastCoreSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CORE_SUMMARY_TS_PREFIX + characterId, ts);
}
