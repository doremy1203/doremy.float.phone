import type { LifeActorClock, LifeActorState, LifeEvent, LifeInvitation, LifeLocation, LifeOwnerType, LifeScheduleSlot, LifeSceneState, VirtualLifeState } from "./life-types";

export const lifeActorKey = (ownerType: LifeOwnerType, ownerId: string) => `${ownerType}:${ownerId}`;

/**
 * Compatibility adapter for older callers and persisted records.
 * Life actors no longer own independent clocks: every operation uses wall-clock time.
 */
export function getActorClock(_state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string): LifeActorClock {
  const now = new Date().toISOString();
  return { ownerType, ownerId, realAnchorAt: now, updatedAt: now };
}

export function resolveActorLifeNow(_legacyClock: LifeActorClock, realNow = new Date()): Date {
  return realNow;
}

export function findActorState(state: VirtualLifeState, ownerType: LifeActorState["ownerType"], ownerId: string) {
  return state.actorStates.find(actor => actor.ownerType === ownerType && actor.ownerId === ownerId);
}
export function upsertActorState(state: VirtualLifeState, nextActor: LifeActorState): VirtualLifeState {
  const actorStates = state.actorStates.filter(actor => !(actor.ownerType === nextActor.ownerType && actor.ownerId === nextActor.ownerId));
  actorStates.push({ ...nextActor, updatedAt: new Date().toISOString() });
  return { ...state, actorStates };
}

/**
 * Resolve the actual location consistently for UI snapshots and proactive scheduling.
 * A temporary or manually selected actual location wins; otherwise use the current schedule.
 */
export function resolveActorLocation(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  now = resolveActorLifeNow(getActorClock(state, ownerType, ownerId)),
): { id: string; name: string } | null {
  const actor = state.actorStates.find(item => item.ownerType === ownerType && item.ownerId === ownerId);
  const slot = getCurrentActorSchedule(state, ownerType, ownerId, now);
  const until = actor?.actualLocationUntil ? Date.parse(actor.actualLocationUntil) : Number.NaN;
  const temporaryOverride = Boolean(actor?.actualLocationId && Number.isFinite(until) && until > now.getTime());
  const manualOverride = Boolean(actor?.actualLocationId && actor.actualLocationUntil == null && actor.actualLocationId !== slot?.plannedLocationId);
  const useActual = temporaryOverride || manualOverride;
  const locationId = (useActual ? actor?.actualLocationId : slot?.plannedLocationId) || actor?.actualLocationId || "";
  if (!locationId) return null;
  const locationName = (useActual ? actor?.actualLocationName : slot?.plannedLocationName)
    || actor?.actualLocationName
    || state.locations.find(location => location.id === locationId)?.name
    || "当前地点";
  return { id: locationId, name: locationName };
}

/**
 * Move only future, automatically generated home slots when a character's residence changes.
 * Explicit manual locations, work/study/commute and non-home outings are never rewritten.
 */
export function synchronizeCharacterHomeSchedule(
  state: VirtualLifeState,
  input: { characterId: string; destinationHomeId: string; destinationHomeName: string; now: Date },
): { state: VirtualLifeState; synchronizedScheduleCount: number } {
  const { characterId, destinationHomeId, destinationHomeName, now } = input;
  const nowMs = now.getTime();
  if (!characterId || !destinationHomeId || !destinationHomeName || !Number.isFinite(nowMs)) {
    return { state, synchronizedScheduleCount: 0 };
  }
  const knownHomeNames = state.locations
    .filter(location => location.id === "home" || location.id.startsWith("home-"))
    .map(location => location.name.trim())
    .filter(Boolean);
  const isHomeSlot = (slot: LifeScheduleSlot): boolean => {
    if (slot.source === "manual") return false;
    const plannedId = slot.plannedLocationId ?? "";
    const plannedName = (slot.plannedLocationName ?? "").trim();
    const explicitHomeActivity = slot.source === "weekly-generation"
      && ["habit", "meal", "free-time"].includes(slot.kind)
      && /回家|在家|居家|家中|家里|家庭|家务|整理房间|打扫房间|睡前/.test(slot.title);
    return plannedId === "home" || plannedId.startsWith("home-")
      || knownHomeNames.includes(plannedName)
      || plannedName === "家" || plannedName === "家里" || plannedName === "家中"
      || plannedName === "自己的家"
      || explicitHomeActivity;
  };
  let synchronizedScheduleCount = 0;
  let schedulesChanged = false;
  const schedules = state.schedules.map(slot => {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId
      || slot.source === "manual" || new Date(slot.endAt).getTime() <= nowMs
      || !isHomeSlot(slot)) return slot;
    if (slot.plannedLocationId === destinationHomeId && (slot.plannedLocationName ?? "") === destinationHomeName) return slot;
    synchronizedScheduleCount += 1;
    schedulesChanged = true;
    return { ...slot, plannedLocationId: destinationHomeId, plannedLocationName: destinationHomeName, updatedAt: now.toISOString() };
  });
  const activeSlot = getCurrentActorSchedule(state, "character", characterId, now);
  const currentActor = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
  const currentActualId = currentActor?.actualLocationId ?? "";
  const currentActualName = (currentActor?.actualLocationName ?? "").trim();
  const actualIsHome = currentActualId === "home" || currentActualId.startsWith("home-")
    || knownHomeNames.includes(currentActualName)
    || currentActualName === "家" || currentActualName === "家里" || currentActualName === "家中";
  let actorStates = state.actorStates;
  if (activeSlot && isHomeSlot(activeSlot) && actualIsHome && currentActor
    && (currentActor.actualLocationId !== destinationHomeId || currentActor.actualLocationName !== destinationHomeName)) {
    actorStates = state.actorStates.map(actor => actor.ownerType === "character" && actor.ownerId === characterId
      ? { ...actor, actualLocationId: destinationHomeId, actualLocationName: destinationHomeName, actualLocationUntil: undefined, updatedAt: now.toISOString() }
      : actor);
  }
  if (!schedulesChanged && actorStates === state.actorStates) return { state, synchronizedScheduleCount };
  return { state: { ...state, schedules, actorStates }, synchronizedScheduleCount };
}

/**
 * Reserve a character's visit at a manually selected location and split overlapping
 * itinerary slots around the visit. The pre-visit and post-visit portions survive.
 */
export function reserveCharacterLocationStay(
  state: VirtualLifeState,
  input: { characterId: string; locationId: string; locationName: string; startAt: Date; endAt: Date; title: string },
): VirtualLifeState {
  const { characterId, locationId, locationName, startAt, endAt, title } = input;
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  if (!characterId || !locationId || !locationName || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return state;
  const startIso = startAt.toISOString();
  const endIso = endAt.toISOString();
  const updatedAt = new Date().toISOString();
  const retainedSlots: LifeScheduleSlot[] = [];
  for (const slot of state.schedules) {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId) {
      retainedSlots.push(slot);
      continue;
    }
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd) || slotEnd <= startMs || slotStart >= endMs) {
      retainedSlots.push(slot);
      continue;
    }
    if (slotStart < startMs) retainedSlots.push({ ...slot, endAt: startIso, updatedAt });
    if (slotEnd > endMs) retainedSlots.push({ ...slot, id: makeId("resume-after-location-stay"), startAt: endIso, updatedAt });
  }
  retainedSlots.push({
    id: makeId("companion-follow"),
    ownerType: "character",
    ownerId: characterId,
    startAt: startIso,
    endAt: endIso,
    title,
    plannedLocationId: locationId,
    plannedLocationName: locationName,
    kind: "free-time",
    source: "manual",
    updatedAt,
  });
  const existing = state.actorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
  const nextActor = {
    ...(existing ?? { ownerType: "character" as const, ownerId: characterId }),
    activity: title,
    actualLocationId: locationId,
    actualLocationName: locationName,
    actualLocationUntil: endIso,
    updatedAt,
  };
  return {
    ...state,
    schedules: retainedSlots,
    actorStates: [...state.actorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)), nextActor],
  };
}
export function upsertLifeEvent(state: VirtualLifeState, nextEvent: LifeEvent): VirtualLifeState {
  return { ...state, events: [...state.events.filter(event => event.id !== nextEvent.id), nextEvent].sort((a,b) => (a.startsAt || a.createdAt).localeCompare(b.startsAt || b.createdAt)) };
}
export function transitionLifeEvent(state: VirtualLifeState, eventId: string, nextStatus: LifeEvent["status"]): VirtualLifeState {
  const current = state.events.find(event => event.id === eventId);
  const allowed: Record<LifeEvent["status"], LifeEvent["status"][]> = { planned: ["confirmed","active","cancelled"], confirmed: ["active","cancelled"], active: ["completed","cancelled"], completed: [], cancelled: [] };
  if (!current || !allowed[current.status].includes(nextStatus)) return state;
  const now = new Date().toISOString();
  const updated = { ...current, status: nextStatus, updatedAt: now, ...(nextStatus === "completed" ? { completedAt: now } : {}), ...(nextStatus === "cancelled" ? { cancelledAt: now } : {}) };
  return { ...state, events: state.events.map(event => event.id === eventId ? updated : event) };
}
export function transitionInvitation(state: VirtualLifeState, invitationId: string, action: "confirm" | "decline" | "cancel"): VirtualLifeState {
  const current = state.invitations.find(invite => invite.id === invitationId);
  if (!current || current.status !== "proposed") return state;
  const now = new Date().toISOString(), status: LifeInvitation["status"] = action === "confirm" ? "confirmed" : action === "decline" ? "declined" : "cancelled";
  const next = { ...current, status, updatedAt: now, ...(action === "confirm" ? { confirmedAt: now } : {}) };
  return { ...state, invitations: state.invitations.map(invite => invite.id === invitationId ? next : invite) };
}
export function upsertLifeScene(state: VirtualLifeState, scene: LifeSceneState): VirtualLifeState {
  return { ...state, scenes: [...state.scenes.filter(item => item.id !== scene.id), scene] };
}
const makeId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;

/** Create an editable weekly baseline while preserving the owner's existing schedule blocks. */
export function generateWeeklyLifePlan(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  ownerName: string,
  weekStart: Date,
  defaultLocation?: { id: string; name: string },
  profile = "",
  includeSpecialEvents = true,
): VirtualLifeState {
  const currentLocations = state.locations ?? [];
  const playerHome = currentLocations.find(location => location.id === "home");
  // 家的解析泛化：角色可以住进玩家家、别的角色家（home-*）或自己独居。
  // 居住地 = 把该角色列为 residents 的 home 型地点；没有则视为独居（home-<id>）。
  const homeLocations = currentLocations.filter(location => location.id === "home" || location.id.startsWith("home-"));
  const livedHome = ownerType === "character" ? homeLocations.find(location => (location.residents ?? []).includes(ownerId)) : undefined;
  const livesWithPlayer = ownerType === "character" && Boolean(playerHome?.residents?.includes(ownerId));
  const personalHomeId = ownerType === "character" ? (livedHome ? livedHome.id : livesWithPlayer ? "home" : "home-" + ownerId) : "home";
  const personalHome: LifeLocation = currentLocations.find(location => location.id === personalHomeId) ?? {
    id: personalHomeId,
    name: ownerType === "character" ? ownerName + "的家" : "家",
    description: ownerType === "character" ? "角色自己的私人住处；可在玩家家的地点档案中设置同居。" : "你自己的家。",
    atmosphere: "熟悉、私密、可以放松的空间。",
    layout: "有自己的起居区域与休息空间。",
    props: ["沙发", "茶几", "水杯", "床头灯"],
    visibility: "private",
  };
  if (ownerType === "character") {
    const now = Date.now();
    const migratedSchedules = state.schedules.map(slot =>
      slot.ownerType === "character" && slot.ownerId === ownerId &&
      new Date(slot.endAt).getTime() > now &&
      ((slot.plannedLocationId && slot.plannedLocationId !== personalHomeId && (slot.plannedLocationId === "home" || slot.plannedLocationId.startsWith("home-"))) || (!slot.plannedLocationId && slot.plannedLocationName === "家"))
        ? { ...slot, plannedLocationId: personalHomeId, plannedLocationName: personalHome.name }
        : slot
    );
    const migratedLocations = currentLocations.some(location => location.id === personalHomeId) ? currentLocations : [...currentLocations, personalHome];
    if (migratedSchedules.some((slot,index) => slot !== state.schedules[index]) || migratedLocations !== currentLocations) {
      state = { ...state, schedules: migratedSchedules, locations: migratedLocations };
    }
  }
  const start = new Date(weekStart);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const ownerSlots = state.schedules.filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId);
  const weekSlots = ownerSlots.filter(slot => {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    return Number.isFinite(slotStart) && Number.isFinite(slotEnd)
      && slotStart < end.getTime() && slotEnd > start.getTime();
  });

  // Fast-path a fully covered week. Partial legacy weeks continue through the
  // normal generator, which preserves existing slots and fills only the gaps.
  const coverage = weekSlots
    .map(slot => ({
      start: Math.max(start.getTime(), new Date(slot.startAt).getTime()),
      end: Math.min(end.getTime(), new Date(slot.endAt).getTime()),
    }))
    .filter(range => range.end > range.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let coveredUntil = start.getTime();
  for (const range of coverage) {
    if (range.start > coveredUntil) break;
    coveredUntil = Math.max(coveredUntil, range.end);
    if (coveredUntil >= end.getTime()) return state;
  }

  const now = new Date().toISOString();
  const slots: LifeScheduleSlot[] = [];
  const profileText = profile.toLowerCase();
  const normalizeProfilePlace = (value: string) => value.toLocaleLowerCase().replace(/[\s\u3000·•/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "");
  const discoveredLocations: LifeLocation[] = [];
  const existingLocations = state.locations ?? [];
  let profilePreferredLocation: LifeLocation | undefined = existingLocations.find(location => Boolean(location.characterHabits?.[ownerId]?.trim()));
  const placeCue = /(?:常去|喜欢去|习惯去|经常去|偶尔去|常在|喜欢在|习惯在|经常在|工作地点(?:是|为)?|地点偏好[:：])\s*([^，。；;\n]{2,28})/g;
  const profilePlaceCandidates = [...profile.matchAll(placeCue)].map(match => (match[1] ?? "")
    .replace(/(看书|学习|散步|吃饭|喝咖啡|工作|上课|练习|休息|聊天|买花|买东西|逛街|读书|创作|然后|之后).*$/,"")
    .replace(/^[的在去到：:\s]+|[的了和及\s]+$/g,"").trim()).filter(name => name.length >= 2).slice(0, 5);
  for (const placeName of profilePlaceCandidates) {
    const key = normalizeProfilePlace(placeName);
    if (!key || /^(这里|那里|家里|家中|附近|外面|室内|户外|学校|公司|你身边|身旁|身边|周围|旁边|门口|屋内|房间)$/.test(key)) continue;
    const existing = [...existingLocations, ...discoveredLocations].find(location => {
      const names = [location.name, ...(location.aliases ?? [])].map(normalizeProfilePlace).filter(name => name.length >= 2);
      return names.includes(key) || names.some(name => key.length >= 3 && (key.includes(name) || name.includes(key)));
    });
    if (existing) {
      if (!profilePreferredLocation && existing.id !== "home") profilePreferredLocation = existing;
      continue;
    }
    const idBase = "place-" + key.slice(0, 32);
    let placeId = idBase, suffix = 2;
    while ([...state.locations, ...discoveredLocations].some(location => location.id === placeId)) placeId = idBase + "-" + suffix++;
    const discovered: LifeLocation = {
      id: placeId, name: placeName,
      description: "从角色卡或已绑定世界书中识别出的地点。请在地点库补充固定环境、空间布局与道具。",
      atmosphere: "", layout: "", props: [], aliases: [], visibility: "public",
    };
    discoveredLocations.push(discovered);
    if (!profilePreferredLocation) profilePreferredLocation = discovered;
  }
  const hash = [...ownerId].reduce((sum, char) => sum + char.charCodeAt(0), 0) + start.getDate();
  const specialDay = ownerType === "character" && includeSpecialEvents && hash % 3 !== 0 ? hash % 7 : -1;
  const has = (...patterns: RegExp[]) => patterns.some(pattern => pattern.test(profileText));
  const student = has(/学生|大学|学校|上课|课程|考试|study|student|school|university/);
  const creative = has(/自由职业|艺术家|作家|画家|摄影|音乐|创作|设计师|创业|freelance|artist|writer|designer|creator/);
  const researcher = has(/研究员|研究者|学者|教授|实验|科学家|研究魔法|法师|魔法师|炼金|scholar|researcher|scientist|wizard|mage/);
  const dutyRole = has(/骑士|守卫|警察|保镖|军人|巡逻|护卫|猎人|knight|guard|soldier|police|hunter/);
  const professional = has(/医生|护士|医师|教师|老师|厨师|店员|服务员|经理|职员|上班|工作|doctor|nurse|teacher|chef|employee|manager/);
  const fantasyRole = has(/魔法|法术|修仙|仙人|妖怪|精灵|兽人|吸血鬼|狼人|龙族|骑士|王子|公主|王国|宫廷|中世纪|fantasy|vampire|werewolf|elf|dragon|medieval/);
  const specialTitle = has(/摄影|拍照|相机|photo|photographer/) ? "外出拍摄 / 整理照片"
    : has(/音乐|唱歌|乐器|作曲|music|singer|musician/) ? "练习音乐 / 听现场"
    : has(/运动|健身|跑步|篮球|足球|sport|fitness|runner/) ? "运动与放松"
    : has(/读书|阅读|写作|书店|学习|学生|book|study|student|writer/) ? "阅读、写作或学习"
    : has(/烹饪|做饭|料理|烘焙|cook|chef|baker/) ? "试做新菜 / 料理时间"
    : has(/游戏|电竞|game|gamer/) ? "游戏与休息"
    : "按角色兴趣安排的私人时间";
  const specialLocation = profilePreferredLocation ?? (has(/摄影|拍照|相机|运动|健身|跑步|photo|sport|fitness/) ? { id: "park", name: "公园" }
    : has(/读书|阅读|写作|学习|学生|book|study|student|writer/) ? { id: "library", name: "图书馆" }
    : has(/音乐|唱歌|乐器|music|singer|musician/) ? { id: "studio", name: "音乐 / 创作空间" }
    : has(/烹饪|做饭|料理|烘焙|cook|chef|baker/) ? personalHome
    : has(/游戏|电竞|game|gamer/) ? personalHome
    : defaultLocation ?? personalHome);
  const leisureLocation = ownerType === "character" ? (profilePreferredLocation ?? personalHome) : personalHome;
  const add = (day: Date, sh: number, sm: number, eh: number, em: number, title: string, kind: LifeScheduleSlot["kind"], location?: { id: string; name: string }) => {
    const from = new Date(day);
    from.setHours(sh, sm, 0, 0);
    const to = new Date(day);
    to.setHours(eh, em, 0, 0);
    if (to <= from) to.setDate(to.getDate() + 1);
    const loc = location ?? defaultLocation;
    slots.push({
      id: makeId("slot"), ownerType, ownerId, startAt: from.toISOString(), endAt: to.toISOString(),
      title, kind, source: "weekly-generation",
      plannedLocationId: loc?.id ?? null, plannedLocationName: loc?.name ?? null, updatedAt: now,
    });
  };

  // Use calendar-day arithmetic rather than adding 24 hours, so daylight-saving
  // transitions cannot shift the generated local schedule by an hour.
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(start);
    day.setDate(start.getDate() + offset);
    const weekend = day.getDay() === 0 || day.getDay() === 6;
    add(day, 0, 0, 7, 0, "睡眠", "habit", personalHome);
    add(day, 7, 0, 7, 30, "起床、洗漱", "habit", personalHome);
    add(day, 7, 30, 8, 0, "早餐", "meal", personalHome);
    if (!weekend) {
      const daytimeLocation = ownerType === "player" ? { id: "work", name: "工作地点" }
        : student ? { id: "school", name: "学校" }
        : researcher ? { id: "library", name: "图书馆 / 研究空间" }
        : dutyRole ? { id: "park", name: "巡逻 / 户外活动地点" }
        : creative ? (has(/音乐|唱歌|乐器|music|musician/) ? { id: "studio", name: "音乐 / 创作空间" } : { id: "cafe", name: "街角咖啡店" })
        : professional ? { id: "work", name: "工作地点" }
        : personalHome;
      if (daytimeLocation.id !== "home") add(day, 8, 0, 9, 0, student ? "前往学校" : researcher ? "前往研究空间" : dutyRole ? "准备外出 / 巡逻" : creative ? "前往工作 / 创作地点" : "通勤 / 前往当天安排", "commute", { id: "transit", name: "通勤途中" });
      const daytime = ownerType === "player" ? "工作 / 学习（可按自己的现实安排修改）"
        : student ? ownerName + "上课 / 学习"
        : researcher ? ownerName + (fantasyRole ? "研究知识 / 练习术法" : "研究 / 阅读 / 实验")
        : dutyRole ? ownerName + (fantasyRole ? "履行职责 / 巡逻" : "值勤 / 巡逻 / 处理事务")
        : creative ? ownerName + "的创作 / 项目时间"
        : professional ? ownerName + "的工作时段"
        : ownerName + "的个人安排 / 自由活动";
      add(day, 9, 0, 12, 0, daytime, ownerType === "player" ? "free-time" : (student || researcher || dutyRole || creative || professional) ? "work" : "free-time", daytimeLocation);
      add(day, 12, 0, 13, 0, "午餐 / 用餐休息", "meal", daytimeLocation.id === "home" ? personalHome : { id: "canteen", name: "食堂 / 附近餐馆" });
      const afternoonTitle = ownerType === "player" ? "下午安排（可自行修改）"
        : student ? ownerName + "的课程 / 自习"
        : researcher ? ownerName + (fantasyRole ? "继续研究 / 训练" : "继续研究 / 整理成果")
        : dutyRole ? ownerName + (fantasyRole ? "执行职责 / 训练" : "下午值勤 / 处理事务")
        : creative ? ownerName + "的创作 / 项目时间"
        : professional ? ownerName + "的工作时段"
        : ownerName + "的个人安排 / 自由活动";
      add(day, 13, 0, 18, 0, afternoonTitle, ownerType === "player" ? "free-time" : (student || researcher || dutyRole || creative || professional) ? "work" : "free-time", daytimeLocation);
    } else {
      add(day, 8, 0, 9, 0, "慢慢开始的一天", "free-time", personalHome);
      add(day, 9, 0, 12, 0, ownerType === "player" ? "周末自由安排" : ownerName + "的周末安排", "free-time", leisureLocation);
      add(day, 12, 0, 13, 0, "午餐", "meal", personalHome);
      add(day, 13, 0, 18, 0, "休闲 / 个人计划", "free-time", leisureLocation);
    }
    add(day, 18, 0, 19, 0, "晚餐", "meal", personalHome);
    if (offset === specialDay) {
      add(day, 19, 0, 19, 30, "回家 / 稍作休息", "free-time", personalHome);
      add(day, 19, 30, 20, 30, specialTitle, "special", specialLocation);
      add(day, 20, 30, 22, 0, "晚间自由时间", "free-time", personalHome);
    } else {
      add(day, 19, 0, 22, 0, ownerType === "player" ? "自由时间" : ownerName + "的私人时间", "free-time", personalHome);
    }
    add(day, 22, 0, 24, 0, "睡眠", "habit", personalHome);
  }

  const occupied = weekSlots
    .map(slot => ({ start: new Date(slot.startAt).getTime(), end: new Date(slot.endAt).getTime() }))
    .filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const generated: LifeScheduleSlot[] = [];
  for (const template of slots) {
    const templateStart = new Date(template.startAt).getTime();
    const templateEnd = new Date(template.endAt).getTime();
    let cursor = templateStart;
    let part = 0;
    for (const range of occupied) {
      if (range.end <= cursor) continue;
      if (range.start >= templateEnd) break;
      if (range.start > cursor) {
        const partEnd = Math.min(range.start, templateEnd);
        if (partEnd > cursor) {
          generated.push({
            ...template,
            id: part === 0 && partEnd === templateEnd ? template.id : template.id + "-part-" + part,
            startAt: new Date(cursor).toISOString(),
            endAt: new Date(partEnd).toISOString(),
          });
          part++;
        }
      }
      cursor = Math.max(cursor, range.end);
      if (cursor >= templateEnd) break;
    }
    if (cursor < templateEnd) {
      generated.push({
        ...template,
        id: part === 0 && cursor === templateStart ? template.id : template.id + "-part-" + part,
        startAt: new Date(cursor).toISOString(),
        endAt: template.endAt,
      });
    }
  }

  if (generated.length === 0) return state;

  // The location library is the source of truth. Every generated itinerary slot
  // first resolves to an existing canonical place (name/alias/id); only genuinely
  // new places are added to the library. This prevents "library / study room"
  // from becoming a new duplicate every time a plan is generated.
  const normalizePlace = (value: string) => value.toLocaleLowerCase()
    .replace(/[\s\u3000·•/\\|｜、，,。.!！?？:：;；()（）\[\]【】_-]+/g, "");
  const canonicalAliases: Record<string, string[]> = {
    home: ["家", "家里", "住所", "住处", "home"],
    cafe: ["咖啡店", "咖啡馆", "街角咖啡店", "cafe", "coffee shop"],
    park: ["公园", "户外活动地点", "运动场地", "park"],
    library: ["图书馆", "研究空间", "研究室", "图书馆研究空间", "library"],
    school: ["学校", "校园", "教室", "school"],
    work: ["工作地点", "办公室", "工作室", "公司", "workplace", "office"],
    transit: ["通勤途中", "通勤", "路上", "交通途中", "transit"],
    canteen: ["食堂", "附近餐馆", "餐馆", "餐厅", "饭店", "canteen"],
    studio: ["音乐创作空间", "音乐空间", "创作空间", "录音室", "studio"],
  };
  const locations: LifeLocation[] = [...existingLocations, ...discoveredLocations];
  const resolveCanonical = (slot: LifeScheduleSlot): LifeScheduleSlot => {
    const rawName = (slot.plannedLocationName ?? "").trim();
    if (!rawName || /跟随玩家的实际地点|地点待定|未知地点/i.test(rawName)) return slot;
    const byId = locations.find(location => location.id === slot.plannedLocationId);
    const normalizedName = normalizePlace(rawName);
    const byName = locations.find(location => {
      const candidates = [location.name, ...(location.aliases ?? []), ...(canonicalAliases[location.id] ?? [])].map(normalizePlace);
      if (candidates.includes(normalizedName)) return true;
      // Match descriptive variants only when one side is a known canonical alias
      // and the other adds a qualifier such as "图书馆 / 研究空间".
      return candidates.some(alias => alias.length >= 2 && normalizedName.length > alias.length
        && (normalizedName.startsWith(alias) || normalizedName.endsWith(alias))
        && (/[\\/／、，,·]/.test(rawName) || /研究空间|附近餐馆|户外活动地点|创作空间/.test(rawName)));
    });
    let canonical = byId ?? byName;
    if (!canonical) {
      const slug = normalizedName.slice(0, 32) || "new-place";
      const baseId = "place-" + slug;
      let newId = baseId, suffix = 2;
      while (locations.some(location => location.id === newId)) newId = baseId + "-" + suffix++;
      canonical = {
        id: newId,
        name: rawName,
        description: "由角色日程首次发现的地点。请在地点库中补充环境描写、固定布局与可用道具。",
        atmosphere: "",
        layout: "",
        props: [],
        aliases: [],
        visibility: "public",
      };
      locations.push(canonical);
    }
    return { ...slot, plannedLocationId: canonical.id, plannedLocationName: canonical.name };
  };
  const canonicalGenerated = generated.map(resolveCanonical);
  return overlayScheduleSlotsOverFreeTime({ ...state, locations }, canonicalGenerated);
}
/**
 * Catch up one actor to the current real time. Every completed schedule slot is
 * settled idempotently, and the current slot updates their real activity/location.
 * This runs on app resume and scheduled real-time refreshes; it never advances another actor.
 */
/**
 * Keep schedule place references canonical and make every itinerary place discoverable
 * in the editable location library. Match existing names/aliases case-insensitively;
 * never overwrite user-authored location metadata or remove existing locations.
 */
export function syncScheduleLocationsToLibrary(state: VirtualLifeState): VirtualLifeState {
  const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  const locations = [...(state.locations ?? [])];
  const byId = new Map(locations.map(location => [location.id, location]));
  const findByName = (name: string) => {
    const key = normalize(name);
    return locations.find(location => normalize(location.name) === key
      || (location.aliases ?? []).some(alias => normalize(alias) === key));
  };
  let changed = false;
  const schedules = state.schedules.map(slot => {
    const name = (slot.plannedLocationName ?? "").trim();
    if (!name) return slot;
    let location = slot.plannedLocationId ? byId.get(slot.plannedLocationId) : undefined;
    if (!location) location = findByName(name);
    if (!location) {
      const base = "schedule-place-" + normalize(name).normalize("NFKD")
        .replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 48) || "place";
      let id = base;
      let suffix = 2;
      while (byId.has(id)) id = base + "-" + suffix++;
      location = {
        id, name, description: "由角色日程自动同步建立；可在地点库中继续编辑。",
        atmosphere: "", layout: "", props: [], visibility: "public" as const,
      };
      locations.push(location);
      byId.set(id, location);
      changed = true;
    }
    const canonicalName = location.name;
    if (slot.plannedLocationId !== location.id || slot.plannedLocationName !== canonicalName) {
      changed = true;
      return { ...slot, plannedLocationId: location.id, plannedLocationName: canonicalName };
    }
    return slot;
  });
  return changed ? { ...state, locations, schedules } : state;
}

export function settleActorTimelineToNow(
  state: VirtualLifeState,
  ownerType: LifeOwnerType,
  ownerId: string,
  realNow = new Date(),
): VirtualLifeState {
  // Synchronize places referenced by schedules before resolving today's active slot.
  // Only the slot active at realNow can affect position; future plans never teleport actors.
  state = syncScheduleLocationsToLibrary(state);
  const nowIso = realNow.toISOString();
  const formatScheduleTime = (value: string) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      : value;
  };
  let events = state.events;
  let memories = state.memories;
  let invitations = state.invitations;
  let scenes = state.scenes;
  const settledKeys = new Set(events.map(event => event.settlementKey).filter(Boolean));
  for (const slot of state.schedules) {
    if (slot.ownerType !== ownerType || slot.ownerId !== ownerId) continue;
    const endMs = new Date(slot.endAt).getTime();
    if (!Number.isFinite(endMs) || endMs > realNow.getTime()) continue;
    const settlementKey = "schedule:" + slot.id;
    if (settledKeys.has(settlementKey)) continue;
    const event: LifeEvent = {
      id: "life-slot-" + slot.id,
      kind: "activity",
      status: "completed",
      startsAt: slot.startAt,
      endsAt: slot.endAt,
      locationId: slot.plannedLocationId ?? undefined,
      locationName: slot.plannedLocationName ?? undefined,
      participantIds: [ownerId],
      title: slot.title,
      details: "日程时间：" + formatScheduleTime(slot.startAt) + " 至 " + formatScheduleTime(slot.endAt) + "。该时段已按个人时间线经过并结算；此记录只确认计划时段结束，不确认活动中的其他细节。",
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: nowIso,
      settlementKey,
    };
    events = [...events, event];
    settledKeys.add(settlementKey);
  }
  for (const event of [...events]) {
    if (event.kind !== "invitation" || (event.status !== "confirmed" && event.status !== "active") || !event.startsAt || !event.endsAt) continue;
    const allAtOrAfter = (iso: string) => event.participantIds.every(participantId => {
      const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
      return resolveActorLifeNow(getActorClock(state, participantType, participantId), realNow).getTime() >= new Date(iso).getTime();
    });
    const started = allAtOrAfter(event.startsAt);
    const ended = allAtOrAfter(event.endsAt);
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    // An event-linked scene remains the canonical scene even if a previous
    // partial save left its status out of sync with the event. Reuse it first
    // to avoid duplicate scene records during recovery.
    let matchingScene = scenes.find(scene => scene.eventId === event.id)
      ?? scenes.find(scene =>
        (scene.status === "active" || scene.status === "paused")
        && !scene.eventId
        && (event.locationId
          ? scene.locationId === event.locationId
          : event.locationName ? scene.locationName === event.locationName : true)
        && event.participantIds.every(participantId => scene.participants.some(participant =>
          participant.ownerId === participantId
          && participant.ownerType === (participantId === "player" ? "player" : "character")
        ))
      );

    // Catch-up must settle the whole real-time interval, even if the app was not
    // opened until after the appointment ended. Otherwise a confirmed event
    // would be incorrectly marked "missed" simply because no page timer ran.
    if (started && (event.status === "confirmed" || event.status === "active") && event.details !== "follow-player") {
      if (matchingScene) {
        // Reuse an already-recorded shared scene at the agreed location rather
        // than losing the event merely because the scene was opened manually.
        const attachedScene: LifeSceneState = {
          ...matchingScene,
          eventId: event.id,
          status: ended ? "completed" : "active",
          updatedAt: nowIso,
        };
        if (matchingScene.eventId !== event.id || matchingScene.status !== attachedScene.status) {
          matchingScene = attachedScene;
          scenes = scenes.map(scene => scene.id === attachedScene.id ? attachedScene : scene);
        }
      } else {
        const playerPresence = findActorState(state, "player", "player");
        const characterPresence = event.participantIds
          .filter(participantId => participantId !== "player")
          .map(participantId => findActorState(state, "character", participantId))
          .find(Boolean);
        const locationId = event.locationId ?? playerPresence?.actualLocationId ?? characterPresence?.actualLocationId ?? "home";
        const locationName = event.locationName
          ?? state.locations.find(location => location.id === locationId)?.name
          ?? playerPresence?.actualLocationName
          ?? characterPresence?.actualLocationName
          ?? "家";
        const participants = event.participantIds.map(participantId => {
          const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
          return {
            ownerType: participantType,
            ownerId: participantId,
            activity: event.title,
            awarenessByActorId: Object.fromEntries(
              event.participantIds.filter(otherId => otherId !== participantId).map(otherId => [otherId, "aware" as const]),
            ),
          };
        });
        matchingScene = {
          id: makeId("scene"),
          locationId,
          locationName,
          startedAt: event.startsAt,
          updatedAt: nowIso,
          status: ended ? "completed" : "active",
          eventId: event.id,
          participants,
          lastSettledEventIds: [],
        };
        scenes = [...scenes, matchingScene];
      }
      // If an already-active appointment is being recovered while it is still
      // underway, its scene takes precedence over any stale active scene. For
      // historical appointments (ended=true), do not disturb today's scene.
      if (!ended && event.status === "active" && matchingScene) {
        scenes = scenes.map(scene => scene.id !== matchingScene!.id && scene.status === "active"
          ? { ...scene, status: "paused" as const, updatedAt: nowIso }
          : scene);
      }
    }

    if (ended) {
      const actuallyOccurred = event.details === "follow-player"
        ? event.status === "active" && !!findActorState(state, "player", "player")?.actualLocationId
        : scenes.some(scene => scene.eventId === event.id);
      const nextStatus = actuallyOccurred ? "completed" as const : "cancelled" as const;
      const updated = { ...event, status: nextStatus, updatedAt: nowIso, ...(actuallyOccurred ? { completedAt: nowIso } : { cancelledAt: nowIso }), settlementKey: "invitation:" + event.id, details: actuallyOccurred ? event.details : "missed:no-shared-scene-before-end" };
      events = events.map(item => item.id === event.id ? updated : item);
      invitations = invitations.map(invite => invite.eventId === event.id ? { ...invite, status: actuallyOccurred ? "completed" as const : "cancelled" as const, updatedAt: nowIso } : invite);
      const memoryId = "memory-" + event.id;
      if (actuallyOccurred && state.settings.saveConfirmedEventsToMemory && !memories.some(memory => memory.id === memoryId)) {
        memories = [{
          id: memoryId, eventId: event.id, occurredAt: event.endsAt, participants: event.participantIds,
          fact: (event.details === "follow-player" ? "角色陪伴并跟随玩家完成了约定时段" : "双方共同完成约定活动") + "「" + event.title + "」" + (event.locationName ? "，地点：" + event.locationName : "") + "。",
        }, ...memories].slice(0, 500);
      }
    } else if (started && event.status === "confirmed") {
      if (event.details === "follow-player") {
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      } else if (matchingScene) {
        scenes = scenes.map(scene => scene.id === matchingScene.id
          ? { ...scene, eventId: event.id, status: "active" as const, updatedAt: nowIso }
          : scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: nowIso } : scene);
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      } else {
        // A confirmed appointment is a real transition, not just a label in the
        // calendar. If the actors have both reached its start time, create the
        // shared scene automatically rather than cancelling it later because
        // the user had not manually opened the destination.
        const playerPresence = findActorState(state, "player", "player");
        const characterPresence = event.participantIds
          .filter(participantId => participantId !== "player")
          .map(participantId => findActorState(state, "character", participantId))
          .find(Boolean);
        const locationId = event.locationId ?? playerPresence?.actualLocationId ?? characterPresence?.actualLocationId ?? "home";
        const locationName = event.locationName
          ?? state.locations.find(location => location.id === locationId)?.name
          ?? playerPresence?.actualLocationName
          ?? characterPresence?.actualLocationName
          ?? "家";
        const participants = event.participantIds.map(participantId => {
          const participantType: LifeOwnerType = participantId === "player" ? "player" : "character";
          return {
            ownerType: participantType,
            ownerId: participantId,
            activity: event.title,
            awarenessByActorId: Object.fromEntries(
              event.participantIds.filter(otherId => otherId !== participantId).map(otherId => [otherId, "aware" as const]),
            ),
          };
        });
        const newScene: LifeSceneState = {
          id: makeId("scene"),
          locationId,
          locationName,
          startedAt: event.startsAt,
          updatedAt: nowIso,
          status: "active",
          eventId: event.id,
          participants,
          lastSettledEventIds: [],
        };
        scenes = [
          ...scenes.map(scene => scene.status === "active" ? { ...scene, status: "paused" as const, updatedAt: nowIso } : scene),
          newScene,
        ];
        events = events.map(item => item.id === event.id ? { ...item, status: "active" as const, updatedAt: nowIso } : item);
      }
    }
    void characterId;
  }
  const current = getCurrentActorSchedule(state, ownerType, ownerId, realNow);
  const previous = findActorState(state, ownerType, ownerId);
  const slotChanged = !!current && previous?.scheduleSlotId !== current.id;
  // The current real-time slot drives routine movement. Respect a manual stay
  // only until its explicit expiry; never apply a future slot before its start time.
  const stayExpired = !!previous?.actualLocationUntil && new Date(previous.actualLocationUntil).getTime() <= realNow.getTime();
  const activeAppointment = current?.kind === "appointment" && current.source === "event"
    ? events.find(event =>
        event.kind === "invitation"
        && event.status === "active"
        && event.details !== "follow-player"
        && event.participantIds.includes(ownerId)
        && !!event.startsAt && !!event.endsAt
        && new Date(event.startsAt).getTime() <= realNow.getTime()
        && new Date(event.endsAt).getTime() > realNow.getTime()
      )
    : undefined;
  const nextActivity = activeAppointment
    ? current.title
    : stayExpired
      ? current?.title ?? previous?.activity ?? "自由活动"
      : current && slotChanged
        ? current.title
        : !current && previous?.scheduleSlotId
          ? "自由活动"
          : previous?.activity ?? current?.title ?? "自由活动";
  // A missing current slot must clear the old slot reference. Otherwise deleting
  // or editing a schedule can leave an actor permanently attached to stale activity.
  const manualStayActive = !!previous?.actualLocationUntil && new Date(previous.actualLocationUntil).getTime() > realNow.getTime();
  const scheduleMovementDue = !!current && !manualStayActive && (slotChanged || stayExpired || !previous?.actualLocationId);
  const nextLocationId = activeAppointment || scheduleMovementDue
    ? current?.plannedLocationId ?? previous?.actualLocationId ?? null
    : previous?.actualLocationId ?? current?.plannedLocationId ?? null;
  const nextLocationName = activeAppointment || scheduleMovementDue
    ? current?.plannedLocationName ?? previous?.actualLocationName ?? null
    : previous?.actualLocationName ?? current?.plannedLocationName ?? null;
  const nextLocationUntil = activeAppointment
    ? current?.endAt ?? previous?.actualLocationUntil ?? null
    : scheduleMovementDue ? null : previous?.actualLocationUntil ?? null;
  const nextSlotId = current?.id ?? null;
  const actorChanged = !previous || previous.activity !== nextActivity || (previous.actualLocationId ?? null) !== nextLocationId || (previous.actualLocationName ?? null) !== nextLocationName || (previous.actualLocationUntil ?? null) !== nextLocationUntil || (previous.scheduleSlotId ?? null) !== nextSlotId;
  const actorStates = actorChanged
    ? [...state.actorStates.filter(actor => !(actor.ownerType === ownerType && actor.ownerId === ownerId)), {
        ownerType, ownerId, activity: nextActivity, scheduleSlotId: nextSlotId,
        actualLocationId: nextLocationId, actualLocationName: nextLocationName,
        actualLocationUntil: nextLocationUntil, updatedAt: nowIso,
      }]
    : state.actorStates;
  let timeline = state.timeline;
  if (stayExpired && ownerType === "player" && nextLocationId && nextLocationName && previous?.actualLocationId !== nextLocationId) {
    const activeScene = scenes.find(scene => scene.status === "active");
    if (activeScene) {
      scenes = scenes.map(scene => scene.id === activeScene.id
        ? { ...scene, locationId: nextLocationId, locationName: nextLocationName, updatedAt: nowIso }
        : scene);
    }
    timeline = [...timeline, {
      id: makeId("timeline"),
      category: "location",
      occurredAt: realNow.toISOString(),
      recordedAt: nowIso,
      title: "按原计划前往" + nextLocationName,
      details: "临时停留时间已结束，生活行程恢复执行。",
      actorId: ownerId,
      actorName: state.settings.playerDisplayName || "我",
      locationName: nextLocationName,
      sceneId: activeScene?.id,
    }];
  }
  let finalActorStates = actorStates;
  for (const event of events) {
    if (event.kind !== "invitation" || event.status !== "active" || event.details !== "follow-player") continue;
    const characterId = event.participantIds.find(participantId => participantId !== "player");
    const playerState = finalActorStates.find(actor => actor.ownerType === "player" && actor.ownerId === "player");
    const characterState = finalActorStates.find(actor => actor.ownerType === "character" && actor.ownerId === characterId);
    if (!characterId || !playerState?.actualLocationId || !playerState.actualLocationName || !characterState) continue;
    if (characterState.actualLocationId === playerState.actualLocationId
      && characterState.activity === "正在陪伴玩家"
      && characterState.actualLocationUntil === event.endsAt) continue;
    finalActorStates = [
      ...finalActorStates.filter(actor => !(actor.ownerType === "character" && actor.ownerId === characterId)),
      {
        ...characterState,
        activity: "正在陪伴玩家",
        actualLocationId: playerState.actualLocationId,
        actualLocationName: playerState.actualLocationName,
        actualLocationUntil: event.endsAt,
        updatedAt: nowIso,
      },
    ];
  }
  if (events === state.events && memories === state.memories && invitations === state.invitations && scenes === state.scenes && finalActorStates === state.actorStates && timeline === state.timeline) return state;
  return { ...state, events, memories, invitations, scenes, actorStates: finalActorStates, timeline, updatedAt: nowIso };
}

export function getCurrentActorSchedule(state: VirtualLifeState, ownerType: LifeOwnerType, ownerId: string, at: Date) {
  const time = at.getTime();
  return state.schedules
    .filter(slot => slot.ownerType === ownerType && slot.ownerId === ownerId)
    .filter(slot => {
      const start = new Date(slot.startAt).getTime();
      const end = new Date(slot.endAt).getTime();
      return Number.isFinite(start) && Number.isFinite(end) && start <= time && end > time;
    })
    // If legacy data contains overlaps, the most recently started slot wins
    // deterministically instead of whichever item happened to be stored first.
    .sort((a, b) =>
      new Date(b.startAt).getTime() - new Date(a.startAt).getTime()
      || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
      || a.id.localeCompare(b.id)
    )[0];
}
export function makeLifeInvitation(state: VirtualLifeState, input: Omit<LifeInvitation,"id"|"status"|"updatedAt">): VirtualLifeState {
  const now = new Date().toISOString(), invitation: LifeInvitation = { ...input, id: makeId("invite"), status: "proposed", updatedAt: now };
  return { ...state, invitations: [invitation,...state.invitations] };
}
export function placeAppointmentInActorSchedule(state: VirtualLifeState, slot: LifeScheduleSlot): VirtualLifeState {
  const start = new Date(slot.startAt).getTime(), end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return state;
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime(), b = new Date(existing.endAt).getTime();
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    // Preserve unaffected time before and after the appointment instead of creating gaps.
    if (a < start) nextSlots.push({ ...existing, id: existing.id + "-before-" + slot.id, endAt: slot.startAt, updatedAt: new Date().toISOString() });
    if (b > end) nextSlots.push({ ...existing, id: existing.id + "-after-" + slot.id, startAt: slot.endAt, updatedAt: new Date().toISOString() });
  }
  nextSlots.push(slot);
  nextSlots.sort((a,b)=>a.startAt.localeCompare(b.startAt));
  return { ...state, schedules: nextSlots };
}

/**
 * Insert a user-authored schedule item without silently overwriting another
 * manual plan or a confirmed appointment. Generated baseline slots may be
 * split around it so the person's day remains continuous.
 */
export function insertManualLifeScheduleSlot(
  state: VirtualLifeState,
  slot: LifeScheduleSlot,
): { state: VirtualLifeState; conflict?: LifeScheduleSlot; error?: string } {
  const start = new Date(slot.startAt).getTime();
  const end = new Date(slot.endAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { state, error: "日程时间无效，结束时间必须晚于开始时间。" };
  }

  const overlapping = state.schedules.filter(existing => {
    if (existing.ownerType !== slot.ownerType || existing.ownerId !== slot.ownerId) return false;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && a < end && b > start;
  });
  const conflict = overlapping.find(existing =>
    existing.kind === "appointment" || existing.source === "manual" || existing.source === "event" || existing.source === "character-tool"
  );
  if (conflict) return { state, conflict };

  const now = new Date().toISOString();
  const nextSlots: LifeScheduleSlot[] = [];
  for (const existing of state.schedules) {
    const sameOwner = existing.ownerType === slot.ownerType && existing.ownerId === slot.ownerId;
    const a = new Date(existing.startAt).getTime();
    const b = new Date(existing.endAt).getTime();
    if (!sameOwner || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
      nextSlots.push(existing);
      continue;
    }
    if (a < start) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-before-" + slot.id,
        endAt: slot.startAt,
        updatedAt: now,
      });
    }
    if (b > end) {
      nextSlots.push({
        ...existing,
        id: existing.id + "-after-" + slot.id,
        startAt: slot.endAt,
        updatedAt: now,
      });
    }
  }
  nextSlots.push({ ...slot, updatedAt: now });
  return { state: { ...state, schedules: nextSlots.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

/**
 * AI-authored schedules may replace any free-time placeholder, regardless of
 * whether it came from weekly generation or a manual edit. Preserve only the
 * unaffected edges of an overlapped free-time slot.
 */
export function overlayScheduleSlotsOverFreeTime(
  state: VirtualLifeState,
  candidates: LifeScheduleSlot[],
): VirtualLifeState {
  let schedules = [...state.schedules];
  for (const candidate of candidates) {
    const start = new Date(candidate.startAt).getTime();
    const end = new Date(candidate.endAt).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const next: LifeScheduleSlot[] = [];
    for (const existing of schedules) {
      const sameOwner = existing.ownerType === candidate.ownerType && existing.ownerId === candidate.ownerId;
      const a = new Date(existing.startAt).getTime();
      const b = new Date(existing.endAt).getTime();
      if (!sameOwner || existing.kind !== "free-time" || !Number.isFinite(a) || !Number.isFinite(b) || b <= start || a >= end) {
        next.push(existing);
        continue;
      }
      if (a < start) next.push({ ...existing, id: existing.id + "-before-ai-" + candidate.id, endAt: candidate.startAt, updatedAt: new Date().toISOString() });
      if (b > end) next.push({ ...existing, id: existing.id + "-after-ai-" + candidate.id, startAt: candidate.endAt, updatedAt: new Date().toISOString() });
    }
    schedules = next;
  }
  schedules.push(...candidates);
  return { ...state, schedules: schedules.sort((a, b) => a.startAt.localeCompare(b.startAt)) };
}

/**
 * Apply a character-authored schedule change through one shared business rule.
 * It may reshape generated or previous character-tool slots, but never silently
 * overwrites user-authored plans or confirmed events.
 */
export function applyCharacterLifeScheduleChange(
  state: VirtualLifeState,
  characterId: string,
  input: { startAt: string; endAt: string; title: string; locationId?: string },
  realNow = new Date(),
): { state: VirtualLifeState; error?: string } {
  const startAt = new Date(input.startAt);
  const endAt = new Date(input.endAt);
  const title = input.title.trim().slice(0, 120);
  if (!title || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt) {
    return { state, error: "需要有效的活动内容和开始/结束时间，且结束时间必须晚于开始时间。" };
  }
  const characterNow = realNow;
  const sameDay = startAt.getFullYear() === characterNow.getFullYear()
    && startAt.getMonth() === characterNow.getMonth()
    && startAt.getDate() === characterNow.getDate()
    && endAt.getFullYear() === characterNow.getFullYear()
    && endAt.getMonth() === characterNow.getMonth()
    && endAt.getDate() === characterNow.getDate();
  if (!sameDay || startAt <= characterNow) {
    return { state, error: "只能调整角色当前现实日期中尚未开始的时段。" };
  }

  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  const conflict = state.schedules.find(slot => {
    if (slot.ownerType !== "character" || slot.ownerId !== characterId) return false;
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (!Number.isFinite(slotStart) || !Number.isFinite(slotEnd)) return false;
    return slot.kind !== "free-time"
      && (slot.kind === "appointment" || slot.source === "manual" || slot.source === "event")
      && slotStart < endMs
      && slotEnd > startMs;
  });
  if (conflict) return { state, error: "该时段与「" + conflict.title + "」冲突；没有覆盖用户安排或已确认约会。" };

  const locationId = input.locationId?.trim();
  const location = state.locations.find(item => item.id === locationId) ?? state.locations.find(item => item.id === "home");
  const schedules: LifeScheduleSlot[] = [];
  const updatedAt = realNow.toISOString();
  for (const slot of state.schedules) {
    const slotStart = new Date(slot.startAt).getTime();
    const slotEnd = new Date(slot.endAt).getTime();
    if (
      slot.ownerType !== "character"
      || slot.ownerId !== characterId
      || slot.kind === "appointment"
      || !Number.isFinite(slotStart)
      || !Number.isFinite(slotEnd)
      || slotEnd <= startMs
      || slotStart >= endMs
    ) {
      schedules.push(slot);
      continue;
    }
    if (slotStart < startMs) {
      schedules.push({ ...slot, id: slot.id + "-before-life-tool-" + startMs, endAt: startAt.toISOString(), updatedAt });
    }
    if (slotEnd > endMs) {
      schedules.push({ ...slot, id: slot.id + "-after-life-tool-" + endMs, startAt: endAt.toISOString(), updatedAt });
    }
  }
  schedules.push({
    id: "life-tool-plan-" + characterId + "-" + startMs,
    ownerType: "character",
    ownerId: characterId,
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    title,
    plannedLocationId: location?.id ?? null,
    plannedLocationName: location?.name ?? null,
    kind: "special",
    source: "character-tool",
    updatedAt,
  });
  return { state: { ...state, schedules: schedules.sort((a, b) => a.startAt.localeCompare(b.startAt)) } };
}

export function confirmLifeInvitation(state: VirtualLifeState, invitationId: string): VirtualLifeState {
  const invitation = state.invitations.find(item => item.id===invitationId && item.status==="proposed");
  if (!invitation) return state;
  const startAt = new Date(invitation.proposedAt);
  if (!Number.isFinite(startAt.getTime())) return state;
  const rawDuration = invitation.durationMinutes;
  const durationMinutes = typeof rawDuration === "number" && Number.isFinite(rawDuration)
    ? Math.max(15, Math.min(rawDuration, 24 * 60))
    : 60;
  const endsAt = new Date(startAt.getTime() + durationMinutes * 60_000).toISOString();
  const now = new Date().toISOString(), eventId = makeId("event");
  const event: LifeEvent = { id:eventId, kind:"invitation", status:"confirmed", startsAt:invitation.proposedAt, endsAt, locationId:invitation.locationId, locationName:invitation.locationName, participantIds:["player",invitation.characterId], title:invitation.activity, details:invitation.kind === "follow-request" ? "follow-player" : "confirmed-appointment", createdAt:now, updatedAt:now };
  const next = { ...invitation, status:"confirmed" as const, confirmedAt:now, updatedAt:now, eventId };
  return { ...state, invitations:state.invitations.map(item=>item.id===invitationId?next:item), events:[event,...state.events] };
}
