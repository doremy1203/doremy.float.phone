// lib/turn-coordinator.ts
//
// 单机自用场景下的“谁现在可以说话”总调度。
//
// 背景：普通回复、生活现场、追问、冷场、定时唤醒、查岗、经期关怀
// 都能写同一个角色的上下文。以前它们各自触发，没有统一互斥，导致：
//   · 用户刚发消息，旧主动 turn 还在生成/执行工具；
//   · 生活现场和线上冷场同时说话；
//   · 通话挂断的结尾回复被通话 abort 误杀。
//
// 这个模块只负责三件事：
//   1. 按 characterId + sessionId 保证同一时刻只有一个 active turn；
//   2. 高优先级抢占低优先级，并 abort 低优先级的 AbortSignal；
//   3. 给调用方一个 turnId / isCurrent()，写库前可以再确认一次。
//
// 它不直接改聊天库、不直接调 LLM，避免和 chat-engine 形成循环依赖。

export type TurnKind =
    | "user_reply"
    | "call"
    | "call_end"
    | "life_scene"
    | "followup"
    | "idle_reconnect"
    | "timed_wake"
    | "check_in"
    | "period_care";

/**
 * 通话/通话结尾是交互阻塞态，不参与主动队列：
 * 通话期间所有主动消息让路；用户回复也不抢占通话。
 * 主动队列严格按用户确定的顺序。
 */
export const TURN_PRIORITY: Record<TurnKind, number> = {
    call: 110,
    call_end: 110,
    user_reply: 100,
    life_scene: 90,
    followup: 80,
    idle_reconnect: 70,
    timed_wake: 60,
    check_in: 50,
    period_care: 40,
};

export type TurnHandle = {
    turnId: string;
    kind: TurnKind;
    priority: number;
    signal: AbortSignal;
    startedAt: number;
    /** 该 turn 是否仍是当前 active turn。写库/执行工具前再确认一次。 */
    isCurrent: () => boolean;
    /** 结束该 turn；如果不是当前 turn 则无副作用。 */
    end: () => void;
    /** 主动中断该 turn（abort signal），但不从 map 移除；通常随后调 end()。 */
    abort: () => void;
};

type ActiveTurn = {
    turnId: string;
    kind: TurnKind;
    priority: number;
    characterId: string;
    sessionId: string;
    startedAt: number;
    controller: AbortController;
    observeOnly: boolean;
};

const activeByCharacter = new Map<string, ActiveTurn>();
let turnSequence = 0;

// A character is one person across channels. Key by character rather than session so
// a life-scene turn cannot race the same character's direct-chat turn in another session.
/**
 * 互斥键：一般是 Character.id（一个角色跨渠道只有一个人）。
 * 群聊没有单一角色，beginTurn 会传 `session:<sessionId>` 进来，
 * 于是同一群的生成天然按会话互斥，且不会和各成员的私聊 turn 互相抢锁。
 */
function characterKey(characterId: string): string {
    return characterId;
}

function makeTurnId(kind: TurnKind): string {
    turnSequence += 1;
    return `${kind}_${Date.now().toString(36)}_${turnSequence.toString(36)}`;
}

/**
 * 尝试开始一个 turn。
 *
 * 返回 null 表示当前有同级/更高优先级的 turn，调用方应直接放弃。
 * 返回 handle 时，调用方必须把 handle.signal 传给 LLM/工具，并在 finally 调 handle.end()。
 */
export function beginTurn(input: {
    kind: TurnKind;
    characterId: string;
    sessionId: string;
    /** true 时只记录/观察，不 abort 现有 turn（灰度/诊断用）。 */
    observeOnly?: boolean;
}): TurnHandle | null {
    const { kind, characterId, sessionId, observeOnly = false } = input;
    // 群聊没有单一 characterId（一个群 = 多个角色共用一轮回复），调用方传空串。
    // 此时以会话为互斥键：同一群同一时刻只允许一轮生成，避免重复触发；
    // 直接 return null 会把群聊的「请求回复」整条链路静默吞掉。
    const ownerKey = characterId || (sessionId ? `session:${sessionId}` : "");
    if (!ownerKey || !sessionId) return null;
    const key = characterKey(ownerKey);
    const priority = TURN_PRIORITY[kind];
    const current = activeByCharacter.get(key);

    if (current) {
        // 同优先级：新 user_reply 顶掉旧 user_reply；call_end 顶掉 call；新 call 顶掉旧 call_end。
        // 其余同优先级直接拒绝，避免重复主动消息。
        const samePriorityUserReply = current.priority === priority && current.kind === "user_reply" && kind === "user_reply";
        const callEndReplacesCall = current.priority === priority && current.kind === "call" && kind === "call_end";
        const callReplacesCallEnd = current.priority === priority && current.kind === "call_end" && kind === "call";
        if (current.priority > priority || (current.priority === priority && !samePriorityUserReply && !callEndReplacesCall && !callReplacesCallEnd)) return null;
        if (!observeOnly && !current.observeOnly) {
            current.controller.abort();
        }
    }

    const turnId = makeTurnId(kind);
    const controller = new AbortController();
    const turn: ActiveTurn = {
        turnId,
        kind,
        priority,
        characterId,
        sessionId,
        startedAt: Date.now(),
        controller,
        observeOnly,
    };
    activeByCharacter.set(key, turn);

    const isCurrent = () => activeByCharacter.get(key)?.turnId === turnId;
    const end = () => {
        if (activeByCharacter.get(key)?.turnId !== turnId) return;
        activeByCharacter.delete(key);
    };

    return {
        turnId,
        kind,
        priority,
        signal: controller.signal,
        startedAt: turn.startedAt,
        isCurrent,
        end,
        abort: () => controller.abort(),
    };
}

/** 取消该会话所属的 active turn（用户发消息/开始通话时用）。 */
export function abortTurnsForSession(sessionId: string, exceptTurnId?: string): number {
    let count = 0;
    for (const [key, turn] of activeByCharacter) {
        if (turn.sessionId !== sessionId) continue;
        if (exceptTurnId && turn.turnId === exceptTurnId) continue;
        turn.controller.abort();
        activeByCharacter.delete(key);
        count += 1;
    }
    return count;
}

/** 取消该角色所有 active turn（切换角色/删除会话时用）。 */
export function abortTurnsForCharacter(characterId: string, exceptTurnId?: string): number {
    let count = 0;
    for (const [key, turn] of activeByCharacter) {
        if (turn.characterId !== characterId) continue;
        if (exceptTurnId && turn.turnId === exceptTurnId) continue;
        turn.controller.abort();
        activeByCharacter.delete(key);
        count += 1;
    }
    return count;
}

export function getActiveTurn(characterId: string, sessionId: string): TurnHandle | null {
    // Kept in the public signature for compatibility; ownership is now character-wide.
    void sessionId;
    const turn = activeByCharacter.get(characterKey(characterId));
    if (!turn) return null;
    return {
        turnId: turn.turnId,
        kind: turn.kind,
        priority: turn.priority,
        signal: turn.controller.signal,
        startedAt: turn.startedAt,
        isCurrent: () => activeByCharacter.get(characterKey(characterId))?.turnId === turn.turnId,
        end: () => {
            if (activeByCharacter.get(characterKey(characterId))?.turnId === turn.turnId) {
                activeByCharacter.delete(characterKey(characterId));
            }
        },
        abort: () => turn.controller.abort(),
    };
}

/** 测试/诊断用：当前所有 active turn 的快照。 */
export function listActiveTurns(): Array<{
    turnId: string;
    kind: TurnKind;
    priority: number;
    characterId: string;
    sessionId: string;
    startedAt: number;
}> {
    return [...activeByCharacter.values()].map(turn => ({
        turnId: turn.turnId,
        kind: turn.kind,
        priority: turn.priority,
        characterId: turn.characterId,
        sessionId: turn.sessionId,
        startedAt: turn.startedAt,
    }));
}
