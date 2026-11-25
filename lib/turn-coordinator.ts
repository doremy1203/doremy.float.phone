// 单机自用场景下的统一回合调度：同一角色跨会话互斥，群聊一次锁定全部参与角色。
export type TurnKind =
    | "user_reply" | "call" | "call_end" | "life_scene" | "followup"
    | "idle_reconnect" | "timed_wake" | "check_in" | "period_care";

export const TURN_PRIORITY: Record<TurnKind, number> = {
    call: 110, call_end: 110, user_reply: 100, life_scene: 90, followup: 80,
    idle_reconnect: 70, timed_wake: 60, check_in: 50, period_care: 40,
};

export type TurnHandle = {
    turnId: string; kind: TurnKind; priority: number; signal: AbortSignal;
    startedAt: number; isCurrent: () => boolean; end: () => void; abort: () => void;
};

type ActiveTurn = {
    turnId: string; kind: TurnKind; priority: number; characterId: string;
    characterIds: string[]; sessionId: string; startedAt: number;
    controller: AbortController; observeOnly: boolean;
};

const activeByCharacter = new Map<string, ActiveTurn>();
let turnSequence = 0;
function characterKey(characterId: string): string { return characterId; }
function makeTurnId(kind: TurnKind): string {
    turnSequence += 1;
    return `${kind}_${Date.now().toString(36)}_${turnSequence.toString(36)}`;
}
function uniqueTurns(turns: Iterable<ActiveTurn>): ActiveTurn[] {
    const seen = new Set<string>();
    return [...turns].filter(turn => !seen.has(turn.turnId) && !!seen.add(turn.turnId));
}
function removeTurn(turn: ActiveTurn): void {
    for (const id of turn.characterIds) {
        if (activeByCharacter.get(characterKey(id))?.turnId === turn.turnId) activeByCharacter.delete(characterKey(id));
    }
}
function canReplace(current: ActiveTurn, kind: TurnKind, priority: number): boolean {
    const samePriorityUserReply = current.priority === priority && current.kind === "user_reply" && kind === "user_reply";
    const callEndReplacesCall = current.priority === priority && current.kind === "call" && kind === "call_end";
    const callReplacesCallEnd = current.priority === priority && current.kind === "call_end" && kind === "call";
    return current.priority < priority || (current.priority === priority && (samePriorityUserReply || callEndReplacesCall || callReplacesCallEnd));
}

export function beginTurn(input: {
    kind: TurnKind; characterId: string; sessionId: string;
    /** 群聊回合需要同时占用所有参与角色的锁；普通会话继续只传 characterId。 */
    participantIds?: string[];
    observeOnly?: boolean;
}): TurnHandle | null {
    const { kind, characterId, sessionId, observeOnly = false } = input;
    const characterIds = [...new Set([characterId, ...(input.participantIds || [])].filter(Boolean))];
    if (!characterIds.length || !sessionId) return null;

    const priority = TURN_PRIORITY[kind];
    const conflicts = uniqueTurns(characterIds.map(id => activeByCharacter.get(characterKey(id))).filter((turn): turn is ActiveTurn => !!turn));
    if (conflicts.some(current => !canReplace(current, kind, priority))) return null;
    for (const current of conflicts) {
        if (!observeOnly && !current.observeOnly) current.controller.abort();
        // A displaced group turn must release every participant lock, not just the overlapping key.
        removeTurn(current);
    }

    const turnId = makeTurnId(kind);
    const controller = new AbortController();
    const turn: ActiveTurn = {
        turnId, kind, priority, characterId: characterIds[0], characterIds,
        sessionId, startedAt: Date.now(), controller, observeOnly,
    };
    for (const id of characterIds) activeByCharacter.set(characterKey(id), turn);

    const isCurrent = () => characterIds.every(id => activeByCharacter.get(characterKey(id))?.turnId === turnId);
    const end = () => { if (isCurrent()) removeTurn(turn); };
    return {
        turnId, kind, priority, signal: controller.signal, startedAt: turn.startedAt,
        isCurrent, end, abort: () => controller.abort(),
    };
}

export function abortTurnsForSession(sessionId: string, exceptTurnId?: string): number {
    const turns = uniqueTurns(activeByCharacter.values()).filter(turn => turn.sessionId === sessionId && turn.turnId !== exceptTurnId);
    for (const turn of turns) { turn.controller.abort(); removeTurn(turn); }
    return turns.length;
}

export function abortTurnsForCharacter(characterId: string, exceptTurnId?: string): number {
    const turn = activeByCharacter.get(characterKey(characterId));
    if (!turn || turn.turnId === exceptTurnId) return 0;
    turn.controller.abort(); removeTurn(turn);
    return 1;
}

export function getActiveTurn(characterId: string, sessionId: string): TurnHandle | null {
    void sessionId;
    const turn = activeByCharacter.get(characterKey(characterId));
    if (!turn) return null;
    const isCurrent = () => turn.characterIds.every(id => activeByCharacter.get(characterKey(id))?.turnId === turn.turnId);
    return {
        turnId: turn.turnId, kind: turn.kind, priority: turn.priority,
        signal: turn.controller.signal, startedAt: turn.startedAt, isCurrent,
        end: () => { if (isCurrent()) removeTurn(turn); },
        abort: () => turn.controller.abort(),
    };
}

export function listActiveTurns(): Array<{
    turnId: string; kind: TurnKind; priority: number; characterId: string;
    sessionId: string; startedAt: number;
}> {
    return uniqueTurns(activeByCharacter.values()).map(turn => ({
        turnId: turn.turnId, kind: turn.kind, priority: turn.priority,
        characterId: turn.characterId, sessionId: turn.sessionId, startedAt: turn.startedAt,
    }));
}
