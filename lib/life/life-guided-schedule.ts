export type GuidedScheduleActor = {
  ownerType: "player" | "character";
  ownerId: string;
  name: string;
  now: Date;
  dayStart: Date;
  dayEnd: Date;
  existing: Array<{
    id: string;
    startAt: string;
    endAt: string;
    title: string;
    source: "weekly-generation" | "manual" | "event" | "character-tool";
    kind: "habit" | "work" | "study" | "meal" | "commute" | "free-time" | "appointment" | "special";
    plannedLocationName?: string | null;
  }>;
};

export type GuidedScheduleOperation = "add" | "move" | "update" | "cancel";

export type GuidedScheduleDraftInput = {
  ownerType: "player" | "character";
  ownerId: string;
  startAt: string;
  endAt: string;
  title: string;
  locationName: string;
  operation: GuidedScheduleOperation;
  existingScheduleId?: string;
  reason?: string;
};

export type GuidedScheduleParseResult = {
  drafts: GuidedScheduleDraftInput[];
  conflicts: string[];
  rejected: string[];
};

function normalizeName(value: unknown): string {
  return typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, "").trim() : "";
}

export function parseGuidedScheduleResponse(
  raw: string,
  contexts: GuidedScheduleActor[],
): GuidedScheduleParseResult {
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("AI 未返回有效 JSON，原日程未改变。");
  const decoded = JSON.parse(raw.slice(first, last + 1)) as { schedules?: unknown; reason?: unknown };
  if (!Array.isArray(decoded.schedules)) throw new Error("AI 返回缺少 schedules 数组。");

  const drafts: GuidedScheduleDraftInput[] = [];
  const conflicts: string[] = [];
  const rejected: string[] = [];
  const overlaps = (a: number, b: number, x: number, y: number) => a < y && b > x;
  // A complete re-plan may move one slot into another slot's old time. Exclude
  // every explicitly moved/updated/cancelled ID from the old-slot conflict pool;
  // the final atomic commit validates the resulting complete schedule set.
  const scheduledToChange = new Set<string>(decoded.schedules.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    const operation = typeof item.operation === "string" ? item.operation.trim().toLowerCase() : "";
    const existingId = typeof item.existingScheduleId === "string" ? item.existingScheduleId.trim() : "";
    return existingId && ["move", "update", "cancel"].includes(operation) ? [existingId] : [];
  }));

  for (const [index, value] of decoded.schedules.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      rejected.push(`第 ${index + 1} 条不是对象`);
      continue;
    }
    const item = value as Record<string, unknown>;
    const actorId = typeof item.actorId === "string" ? item.actorId.trim() : "";
    const actorTypeRaw = typeof item.actorType === "string" ? item.actorType.trim().toLowerCase() : "";
    const actorType = actorTypeRaw === "player" || actorTypeRaw === "用户" || actorTypeRaw === "玩家"
      ? "player"
      : actorTypeRaw === "character" || actorTypeRaw === "角色" || actorTypeRaw === "人物"
        ? "character"
        : "";
    if (actorTypeRaw && !actorType) {
      rejected.push(`第 ${index + 1} 条对象类型无效`);
      continue;
    }
    const actorName = normalizeName(item.actorName);
    let context = actorId
      ? contexts.find(candidate => candidate.ownerId === actorId && (!actorType || candidate.ownerType === actorType))
      : undefined;
    if (!actorId && actorName) {
      const matches = contexts.filter(candidate =>
        normalizeName(candidate.name) === actorName && (!actorType || candidate.ownerType === actorType));
      if (matches.length === 1) context = matches[0];
    }
    if (!context) {
      rejected.push(`第 ${index + 1} 条对象无法唯一映射（actorId/actorType/actorName 不匹配）`);
      continue;
    }
    if (actorType && context.ownerType !== actorType) {
      rejected.push(`第 ${index + 1} 条对象类型与 ID 不一致`);
      continue;
    }
    if (actorName && normalizeName(context.name) !== actorName) {
      rejected.push(`第 ${index + 1} 条角色名称与 actorId 不一致`);
      continue;
    }

    const operationRaw = typeof item.operation === "string" ? item.operation.trim().toLowerCase() : "add";
    const operation = (["add", "move", "update", "cancel", "keep"].includes(operationRaw) ? operationRaw : "") as
      "add" | "move" | "update" | "cancel" | "keep" | "";
    if (!operation) {
      rejected.push(`第 ${index + 1} 条操作类型无效`);
      continue;
    }
    if (operation === "keep") continue;

    const existingScheduleId = typeof item.existingScheduleId === "string" ? item.existingScheduleId.trim() : "";
    const existing = existingScheduleId ? context.existing.find(slot => slot.id === existingScheduleId) : undefined;
    if (operation !== "add" && (!existingScheduleId || !existing)) {
      rejected.push(`第 ${index + 1} 条缺少有效的 existingScheduleId`);
      continue;
    }
    if (existing && (new Date(existing.endAt) <= context.now || new Date(existing.startAt) <= context.now || existing.source === "event")) {
      rejected.push(`第 ${index + 1} 条试图调整已开始、已过去或已确认的固定日程`);
      continue;
    }

    const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 240) : "";
    if (operation === "cancel") {
      if (!existing) continue;
      drafts.push({
        ownerType: context.ownerType,
        ownerId: context.ownerId,
        startAt: existing.startAt,
        endAt: existing.endAt,
        title: existing.title,
        locationName: existing.plannedLocationName || "",
        operation,
        existingScheduleId,
        reason,
      });
      continue;
    }

    const dayOffset = Number(item.dayOffset);
    const title = typeof item.title === "string" ? item.title.trim().slice(0, 100) : "";
    const startMatch = /^(\d{1,2}):(\d{2})$/.exec(String(item.start ?? ""));
    const endMatch = /^(\d{1,2}):(\d{2})$/.exec(String(item.end ?? ""));
    if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 6 || !title || !startMatch || !endMatch) {
      rejected.push(`第 ${index + 1} 条时间或标题格式无效`);
      continue;
    }
    const sh = Number(startMatch[1]), sm = Number(startMatch[2]);
    const eh = Number(endMatch[1]), em = Number(endMatch[2]);
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) {
      rejected.push(`第 ${index + 1} 条时间超出有效范围`);
      continue;
    }
    const startAt = new Date(context.dayStart);
    startAt.setDate(startAt.getDate() + dayOffset);
    startAt.setHours(sh, sm, 0, 0);
    const endAt = new Date(context.dayStart);
    endAt.setDate(endAt.getDate() + dayOffset);
    endAt.setHours(eh, em, 0, 0);
    if (endAt <= startAt || startAt < context.now || endAt > context.dayEnd) {
      rejected.push(`第 ${index + 1} 条不在未来七日有效时间范围内`);
      continue;
    }
    const startMs = startAt.getTime(), endMs = endAt.getTime();
    const conflict = context.existing.find(slot =>
      slot.kind !== "free-time"
      && slot.id !== existingScheduleId
      && !scheduledToChange.has(slot.id)
      && overlaps(startMs, endMs, new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime()));
    if (conflict) {
      conflicts.push(`${context.name}：${title}（与「${conflict.title}」冲突；请重新规划）`);
      continue;
    }
    if (drafts.some(slot => slot.ownerType === context!.ownerType && slot.ownerId === context!.ownerId
      && slot.operation !== "cancel"
      && overlaps(startMs, endMs, new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime()))) {
      conflicts.push(`${context.name}：${title}（与本次生成安排冲突）`);
      continue;
    }
    drafts.push({
      ownerType: context.ownerType,
      ownerId: context.ownerId,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      title,
      locationName: typeof item.location === "string" ? item.location.trim().slice(0, 80) : "",
      operation,
      existingScheduleId: operation === "add" ? undefined : existingScheduleId,
      reason,
    });
  }
  return { drafts, conflicts, rejected };
}
