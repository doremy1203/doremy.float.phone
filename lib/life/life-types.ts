/**
 * Virtual Life Engine domain model.
 *
 * Life-scene is intentionally separate from online chat and long-form story mode.
 * Persistent entities are kept serializable so they can use the existing KV layer.
 */
export type LifeInteractionMode = "online-chat" | "life-scene" | "story-mode";
export type LifeOwnerType = "player" | "character";
export type LifeEventStatus = "planned" | "confirmed" | "active" | "completed" | "cancelled";

/** Legacy adapter shape; actors now always use the shared real-world clock. */
export type LifeActorClock = {
  ownerType: LifeOwnerType;
  ownerId: string;
  realAnchorAt: string;
  updatedAt: string;
};

export type LifeEngineSettings = {
  playerDisplayName: string;
  enabled: boolean;
  autoGenerateWeeklyPlans: boolean;
  generateSpecialEvents: boolean;
  enableCoincidences: boolean;
  enableCharacterAutonomy: boolean;
  enableScheduleChangeTool: boolean;
  enableFollowRequestTool: boolean;
  enableInvitations: boolean;
  saveConfirmedEventsToMemory: boolean;
  /** 默认随机选择一名在场角色回应；关闭后使用指定角色。 */
  randomSceneResponses?: boolean;
  showActionNarration: boolean;
  keepDialogueConcise: boolean;
  allowCharactersToStaySilent: boolean;
  /** Allow ordinary online chat replies while the character's life schedule says they are asleep. */
  allowOnlineChatDuringSleep: boolean;
  /** 连续纯行动回合上限：0=不允许，1=最多 1 连，2=最多 2 连。 */
  maxConsecutiveActionOnly?: 0 | 1 | 2;
  /** 生活输出格式异常时是否自动修复重试一次。 */
  enableLifeFormatRepair?: boolean;
  /** 角色按日程移动时偶尔临时改去别处；只改变实际位置，不改日程。默认开启。 */
  enableSpontaneousDeviation?: boolean;
  /** 每个角色每天「临时起意」的次数上限（1~5）。默认 2。 */
  deviationDailyLimit?: number;
  revealExactLocations: "ask-only" | "clues" | "open";
  sceneTheme: "warm-paper" | "night-sky" | "sage" | "rose" | "lavender" | "ocean" | "matcha" | "peach" | "midnight" | "custom";
  accentColor: string;
  accentColorMode?: "theme" | "custom";
  panelOpacity: number;
  dialogueFontSize: number;
  narrationFontSize: number;
  /** CSS font-family for dialogue; accepts a system font name or CSS font stack. */
  dialogueFontFamily: string;
  /** Optional Life app-wide background image; locations can override it in scene chat. */
  globalBackgroundImage?: string;
  globalBackgroundBlur?: number;
  globalBackgroundBrightness?: number;
  globalBackgroundOverlay?: number;
  /** CSS font-family for narration and scene cards. */
  narrationFontFamily: string;
  /** Inner padding for life-scene dialogue bubbles, in pixels. */
  bubblePadding: number;
  /** Vertical gap between life-scene messages, in pixels. */
  messageGapPx: number;
  /** Vertical gap between narration and dialogue within a turn, in pixels. */
  narrationGapPx: number;
  /** Dialogue messages combined into one life timeline record. */
  sceneRecordBatchSize?: number;
  dialogueBubbleStyle: "rounded" | "soft" | "square";
  /** User CSS overrides for the life scene chat only. */
  customSceneCss?: string;
  compactLayout: boolean;
  showTimeline: boolean;
  showLocationHints: boolean;
  recordLocationChanges: boolean;
  recordSceneMessages: boolean;
  recordCharacterActions: boolean;
  recordScheduleChanges: boolean;
  recordToolCalls: boolean;
  recordSocialActivity: boolean;
  recordDiaryActivity: boolean;
  recordChatActivity: boolean;
  enableAmbientDetails: boolean;
  /** Let present characters occasionally initiate short life-scene dialogue. */
  enableProactiveSceneMessages?: boolean;
  /** Minimum real-time minutes between proactive turns in an active scene. */
  proactiveSceneIntervalMinutes?: number;
  /** Maximum real-time minutes between proactive turns; the next interval is randomized within the range. */
  proactiveSceneIntervalMaxMinutes?: number;
  /** Request a browser/system notification for a proactive scene message. */
  enableLifeMessageNotifications?: boolean;
  /** Minimum minutes without player input before a life-scene character may initiate. */
  proactiveSceneSilenceMinutes?: number;
  autoGenerateSceneImages: boolean;
  sceneImageCount: 1 | 2 | 3 | 4;
  sceneImageStyle: string;
  sceneImagePrompt: string;
};
export const DEFAULT_LIFE_ENGINE_SETTINGS: LifeEngineSettings = {
  playerDisplayName: "我",
  enabled: true,
  autoGenerateWeeklyPlans: true,
  generateSpecialEvents: true,
  enableCoincidences: true,
  enableCharacterAutonomy: true,
  enableScheduleChangeTool: true,
  enableFollowRequestTool: true,
  enableInvitations: true,
  saveConfirmedEventsToMemory: true,
  randomSceneResponses: true,
  enableSpontaneousDeviation: true,
  deviationDailyLimit: 2,
  showActionNarration: true,
  keepDialogueConcise: true,
  allowCharactersToStaySilent: true,
  allowOnlineChatDuringSleep: true,
  maxConsecutiveActionOnly: 1,
  enableLifeFormatRepair: true,
  revealExactLocations: "clues",
  sceneTheme: "warm-paper",
  accentColor: "#b88768",
  accentColorMode: "theme",
  panelOpacity: 96,
  dialogueFontSize: 13,
  narrationFontSize: 12,
  dialogueFontFamily: "",
  narrationFontFamily: "",
  bubblePadding: 6,
  messageGapPx: 4,
  narrationGapPx: 4,
  sceneRecordBatchSize: 10,
  dialogueBubbleStyle: "rounded",
  customSceneCss: "",
  compactLayout: false,
  showTimeline: true,
  showLocationHints: true,
  recordLocationChanges: true,
  recordSceneMessages: true,
  recordCharacterActions: true,
  recordScheduleChanges: true,
  recordToolCalls: true,
  recordSocialActivity: true,
  recordDiaryActivity: true,
  recordChatActivity: true,
  enableAmbientDetails: true,
  enableProactiveSceneMessages: true,
  proactiveSceneIntervalMinutes: 5,
  proactiveSceneIntervalMaxMinutes: 15,
  enableLifeMessageNotifications: true,
  proactiveSceneSilenceMinutes: 10,
  autoGenerateSceneImages: false,
  sceneImageCount: 1,
  sceneImageStyle: "温暖自然的生活感，电影级构图，表情与动作自然，保持角色外观一致",
  sceneImagePrompt: "",
};

export type LifeScheduleSlot = {
  id: string;
  ownerType: LifeOwnerType;
  ownerId: string;
  startAt: string;
  endAt: string;
  title: string;
  plannedLocationId?: string | null;
  plannedLocationName?: string | null;
  /** User explicitly deleted this destination; schedule sync must not recreate it. */
  plannedLocationDeleted?: boolean;
  kind: "habit" | "work" | "study" | "meal" | "commute" | "free-time" | "appointment" | "special";
  source: "weekly-generation" | "manual" | "event" | "character-tool";
  updatedAt: string;
};

export type LifeLocationSourceRef = {
  sourceKey: string;
  kind: "character-card" | "worldbook" | "manual";
  characterId?: string;
  characterName?: string;
  worldBookId?: string;
  worldBookName?: string;
  entryUid?: string;
  entryComment?: string;
  relation?: "own-home" | "shared-home" | "workplace" | "frequent" | "mentioned" | "unknown";
  importedAt: string;
};

export type LifeLocationFieldOrigin = "user" | "source" | "ai";

export type LifeLocation = {
  id: string;
  name: string;
  /** Provenance for imported/generated location profiles; additive for legacy state. */
  sourceRefs?: LifeLocationSourceRef[];
  /** Tracks which profile fields may be refreshed without overwriting user edits. */
  fieldOrigins?: Partial<Record<"description" | "atmosphere" | "layout" | "props" | "aliases", LifeLocationFieldOrigin>>;
  description?: string;
  /** Alternate names used to match generated itinerary places back to this canonical location. */
  aliases?: string[];
  /** User-managed grouping metadata; does not affect AI location matching. */
  category?: "住宅" | "商业" | "公共" | "自然" | "其他";
  folderId?: string;
  /** Per-character habits at this location, keyed by character ID. */
  characterHabits?: Record<string, string>;
  /** Character IDs explicitly sharing the player's home. */
  residents?: string[];
  /** User-authored atmosphere cues used by the live scene prompt and location cards. */
  atmosphere?: string;
  /** Stable spatial layout: where the door, seats, windows, counters, etc. are. */
  layout?: string;
  /** Persistent props/objects that can be referenced by later actions and dialogue. */
  props?: string[];
  /** Optional per-location chat-room background image (compressed data URL). */
  backgroundImage?: string;
  backgroundBlur?: number;
  backgroundBrightness?: number;
  backgroundOverlay?: number;
  visibility: "public" | "private";
};

export type LifeActorState = {
  ownerType: LifeOwnerType;
  ownerId: string;
  activity: string;
  scheduleSlotId?: string | null;
  actualLocationId?: string | null;
  actualLocationName?: string | null;
  /** Optional real-world time when a manually chosen location stay ends and the planned itinerary resumes. */
  actualLocationUntil?: string | null;
  /**
   * Where the current actual location came from. Schedule movement, timed stays,
   * appointments and companion travel are not manual overrides even when the
   * actual place temporarily differs from the planned one.
   */
  locationSource?: "schedule" | "manual" | "stay" | "appointment" | "companion" | "spontaneous";
  /**
   * 临时起意的持久化计数：记录最近一次触发日期与当天已触发次数，
   * 跨多次 settle 累计，避免每次结算都重新掷骰。
   */
  deviationDayKey?: string;
  deviationCount?: number;
  /**
   * Set only when the user explicitly picks a manual location. Settlement never
   * refreshes it, so the manual override 2-hour TTL can actually expire.
   */
  manualSetAt?: string;
  /** User pinned the manual location: it never expires until manually changed again. */
  manualPinned?: boolean;
  /** Online chat temporarily wakes a sleeping character for 20 minutes; schedule remains unchanged. */
  onlineChatAwakeUntil?: string | null;
  updatedAt: string;
};

export type LifeSceneParticipant = {
  ownerType: LifeOwnerType;
  ownerId: string;
  activity: string;
  awarenessByActorId: Record<string, "unaware" | "suspects" | "aware">;
};

export type LifeSceneMessage = {
  id: string;
  sceneId: string;
  speakerType: LifeOwnerType;
  speakerId: string;
  speakerName: string;
  role: "player" | "character" | "system";
  action?: string;
  dialogue: string;
  createdAt: string;
  /** 场景消息来源：现场回复 / 角色自主 / 离线推送。只做追溯，不改变渲染。 */
  channel?: "life_scene" | "life_autonomy" | "life_offline";
  /** Reference to a scene gallery image; keeps image bytes in the media store, not the chat log. */
  imageId?: string;
  replyToMessageId?: string;
};

export type LifeSceneImage = {
  id: string;
  sceneId: string;
  mediaRef: string;
  prompt: string;
  participantIds: string[];
  createdAt: string;
  status: "active" | "archived";
  alt?: string;
};

export type LifeSceneState = {
  id: string;
  locationId: string;
  locationName: string;
  startedAt: string;
  updatedAt: string;
  status: "active" | "paused" | "completed";
  /** Legacy event association only; never identifies a separate chat room. */
  eventId?: string;
  participants: LifeSceneParticipant[];
  lastSettledEventIds: string[];
  images?: LifeSceneImage[];
  /** AI-maintained summary of what is currently true in this specific scene; separate from the location dossier and raw chat log. */
  currentDescription?: string;
  /** Last scene-state fingerprint successfully auto-rendered; prevents duplicate cost after reopening. */
  lastAutoImageFingerprint?: string;
};

export type LifeEvent = {
  id: string;
  kind: "encounter" | "invitation" | "activity" | "life-change" | "memory";
  status: LifeEventStatus;
  startsAt?: string;
  endsAt?: string;
  locationId?: string;
  locationName?: string;
  participantIds: string[];
  title: string;
  details?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  settlementKey?: string;
};

export type LifeInvitation = {
  id: string;
  /** Who initiated the invitation; old saved records omit this and are treated as character-origin. */
  proposedBy?: "player" | "character";
  responseReason?: string;
  kind?: "appointment" | "follow-request";
  durationMinutes?: number;
  characterId: string;
  playerId: string;
  proposedAt: string;
  locationId?: string;
  locationName?: string;
  activity: string;
  /** Why the inviter wants to meet; shown separately from the event/activity. */
  reason?: string;
  status: "proposed" | "confirmed" | "declined" | "cancelled" | "completed";
  confirmedAt?: string;
  updatedAt: string;
  eventId?: string;
};

export type LifeTimelineCategory = "location" | "scene" | "action" | "dialogue" | "schedule" | "tool" | "social" | "diary" | "chat" | "system";

export type LifeTimelineEntry = {
  id: string;
  category: LifeTimelineCategory;
  occurredAt: string;
  /** Real persistence time, used for incremental memory sync; occurredAt follows real-world time. */
  recordedAt?: string;
  title: string;
  details?: string;
  actorId?: string;
  actorName?: string;
  locationName?: string;
  sceneId?: string;
  /** Related scene message id, chat session id, post id, diary id, or tool call id. */
  sourceId?: string;
  /** Optional user-requested illustration for this life record, stored in the existing media cache. */
  imageMediaRef?: string;
};

export type LifeMemoryFact = {
  id: string;
  eventId: string;
  occurredAt: string;
  participants: string[];
  fact: string;
  interpretations?: Record<string, string>;
};

export type VirtualLifeState = {
  schemaVersion: 1;
  /** Version of role-card-aware weekly schedule templates already applied. */
  scheduleProfileVersion?: number;
  /** 气泡间距默认值迁移版本：旧默认 3/4px 升到 6px。 */
  bubbleStyleVersion?: number;
  /** One-time migration marker for legacy scene message action/dialogue parsing. */
  sceneMessageFormatVersion?: number;
  settings: LifeEngineSettings;
  locations: LifeLocation[];
  /** User-created folders for organizing the location library. */
  locationFolders?: Array<{ id: string; name: string }>;
  actorStates: LifeActorState[];
  schedules: LifeScheduleSlot[];
  scenes: LifeSceneState[];
  sceneMessages: LifeSceneMessage[];
  events: LifeEvent[];
  invitations: LifeInvitation[];
  memories: LifeMemoryFact[];
  timeline: LifeTimelineEntry[];
  updatedAt: string;
};

export function createEmptyVirtualLifeState(now = new Date().toISOString()): VirtualLifeState {
  return {
    schemaVersion: 1,
    scheduleProfileVersion: 3,
    bubbleStyleVersion: 1,
    settings: { ...DEFAULT_LIFE_ENGINE_SETTINGS },
    locations: [],
    locationFolders: [],
    actorStates: [],
    schedules: [],
    scenes: [],
    sceneMessages: [],
    events: [],
    invitations: [],
    memories: [],
    timeline: [],
    updatedAt: now,
  };
}
