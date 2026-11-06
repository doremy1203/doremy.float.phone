// lib/debug-store.ts
// Lightweight global store: ChatRoom writes current session+messages, DebugPromptPanel reads.

import type { ChatSession, ChatMessage } from "./chat-storage";
import type { LLMContentPart } from "./llm-prompt-assembler";

export type DebugChatState = { session: ChatSession; messages: ChatMessage[] } | null;
export type DebugPromptSnapshot = {
    id: string;
    timestamp: string;
    requestKind: "completion" | "native-tools" | "native-tools-stream";
    provider: string;
    providerKind: string;
    model: string;
    appId: string;
    appTags?: string[];
    sessionId?: string;
    characterName?: string;
    presetName?: string;
    messages: { role: string; content: string | LLMContentPart[]; marker?: string }[];
    tools?: { name: string; description?: string }[];
};

let _state: DebugChatState = null;
const _listeners = new Set<() => void>();
let _promptSnapshot: DebugPromptSnapshot | null = null;
const _promptSnapshotsByApp = new Map<string, DebugPromptSnapshot>();
const _promptListeners = new Set<() => void>();

export function setDebugChatState(s: DebugChatState): void {
    _state = s;
    _listeners.forEach(fn => fn());
}

export function getDebugChatState(): DebugChatState {
    return _state;
}

export function subscribeDebugChatState(fn: () => void): () => void {
    _listeners.add(fn);
    return () => { _listeners.delete(fn); };
}

export function setDebugPromptSnapshot(snapshot: DebugPromptSnapshot): void {
    _promptSnapshot = snapshot;
    // Keep the latest real request per APP in memory so switching between the six
    // dedicated preview tabs does not erase another APP's last request.
    _promptSnapshotsByApp.set(snapshot.appId, snapshot);
    _promptListeners.forEach(fn => fn());
}

export function getDebugPromptSnapshot(): DebugPromptSnapshot | null {
    return _promptSnapshot;
}

export function getDebugPromptSnapshotByApp(appId: string): DebugPromptSnapshot | null {
    return _promptSnapshotsByApp.get(appId) ?? null;
}

export function subscribeDebugPromptSnapshot(fn: () => void): () => void {
    _promptListeners.add(fn);
    return () => { _promptListeners.delete(fn); };
}
