export type CharacterTimeContext = {
  systemTime: string;
  systemWeekday: string;
  systemTimeZone: string;
  characterTime: string;
  characterWeekday: string;
  characterTimeZone: string;
  timeContext: string;
  hasDifference: boolean;
};

export type GroupTimeMember = {
  name: string;
  timeZone?: string | null;
};

const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];

type DateParts = {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
};

function readTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function getSystemTimeZone(): string {
  return readTimeZone();
}

export function normalizeTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const timeZone = value.trim();
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return timeZone;
  } catch {
    return undefined;
  }
}

function getDateParts(date: Date, timeZone: string): DateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const values: Partial<DateParts> = {};
  for (const part of formatter.formatToParts(date)) {
    if (
      part.type === "year"
      || part.type === "month"
      || part.type === "day"
      || part.type === "hour"
      || part.type === "minute"
      || part.type === "second"
    ) {
      values[part.type] = part.value;
    }
  }
  return {
    year: values.year || "0000",
    month: values.month || "01",
    day: values.day || "01",
    hour: values.hour || "00",
    minute: values.minute || "00",
    second: values.second || "00",
  };
}

export function formatZonedPromptTimestamp(date: Date, timeZone: string, includeTimeZone = false): string {
  const parts = getDateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}${includeTimeZone ? ` ${timeZone}` : ""}`;
}

export function formatZonedChineseDateTime(date: Date, timeZone: string): string {
  const parts = getDateParts(date, timeZone);
  return `${Number(parts.year)}年${Number(parts.month)}月${Number(parts.day)}日${parts.hour}:${parts.minute}`;
}

export function getZonedWeekday(date: Date, timeZone: string): string {
  try {
    const label = new Intl.DateTimeFormat("zh-CN", { timeZone, weekday: "long" }).format(date);
    return label || WEEKDAYS[0];
  } catch {
    return WEEKDAYS[date.getDay()];
  }
}

export function hasTimeZoneDifference(date: Date, characterTimeZone: string, systemTimeZone = getSystemTimeZone()): boolean {
  const systemParts = getDateParts(date, systemTimeZone);
  const characterParts = getDateParts(date, characterTimeZone);
  return systemParts.year !== characterParts.year
    || systemParts.month !== characterParts.month
    || systemParts.day !== characterParts.day
    || systemParts.hour !== characterParts.hour
    || systemParts.minute !== characterParts.minute;
}

export function buildCharacterTimeContext(timeZone?: string | null, now = new Date(), enabled = true): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  if (!enabled) {
    return { systemTime: "", systemWeekday: "", systemTimeZone: "", characterTime: "", characterWeekday: "", characterTimeZone: "", timeContext: "全局时间感知已关闭：不要根据系统当前时间推断时段或角色作息，也不要虚构具体时间。", hasDifference: false };
  }
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const hasDifference = normalizedTimeZone ? hasTimeZoneDifference(now, normalizedTimeZone, systemTimeZone) : false;

  if (!normalizedTimeZone || !hasDifference) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: [
        `当前系统时间（权威实时基准）：${systemTime} ${systemTimeZone}，${systemWeekday}`,
        "时间与状态判定规则：以上时间是本轮生成时的真实当前时间；优先依据它判断现在是早晨、白天、晚上还是深夜。",
        "角色日程只是计划，不代表角色此刻一定正在做该事；不要仅凭睡眠时段就断言角色正在睡觉。",
        "如果角色此刻正在生成、回复或发出消息（包括主动消息、定时消息和离线推送），不要同时声称自己正在熟睡或完全无法回应；应按当前时间与角色设定自然解释。",
        "不要把历史消息时间、计划时间或上一次对话时的时间误当成现在；时间不确定时不要编造具体时刻。",
      ].join("\n"),
      hasDifference: false,
    };
  }

  const characterTime = formatZonedChineseDateTime(now, normalizedTimeZone);
  const characterWeekday = getZonedWeekday(now, normalizedTimeZone);
  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime,
    characterWeekday,
    characterTimeZone: normalizedTimeZone,
    timeContext: [
      `当前系统时间（权威实时基准）：${systemTime} ${systemTimeZone}，${systemWeekday}`,
      `角色本地时间：${characterTime} ${normalizedTimeZone}，${characterWeekday}`,
      "判断角色作息、问候、深夜/清晨/工作时间时，优先使用角色本地时间；它与系统时间代表同一时刻，只是时区不同。",
      "角色日程只是计划，不代表角色此刻一定正在做该事；不要仅凭睡眠时段就断言角色正在睡觉。",
      "如果角色此刻正在生成、回复或发出消息（包括主动消息、定时消息和离线推送），不要同时声称自己正在熟睡或完全无法回应；应按当前时间与角色设定自然解释。",
      "不要把历史消息时间、计划时间或上一次对话时的时间误当成现在；时间不确定时不要编造具体时刻。",
    ].join("\n"),
    hasDifference: true,
  };
}

export function buildGroupTimeContext(members: GroupTimeMember[], now = new Date(), enabled = true): CharacterTimeContext {
  const systemTimeZone = getSystemTimeZone();
  if (!enabled) {
    return { systemTime: "", systemWeekday: "", systemTimeZone: "", characterTime: "", characterWeekday: "", characterTimeZone: "", timeContext: "全局时间感知已关闭：不要根据系统当前时间推断时段或角色作息，也不要虚构具体时间。", hasDifference: false };
  }
  const systemTime = formatZonedChineseDateTime(now, systemTimeZone);
  const systemWeekday = getZonedWeekday(now, systemTimeZone);
  const rows = members
    .map(member => {
      const timeZone = normalizeTimeZone(member.timeZone);
      if (!timeZone || !hasTimeZoneDifference(now, timeZone, systemTimeZone)) return null;
      return `${member.name}：${formatZonedChineseDateTime(now, timeZone)} ${timeZone}，${getZonedWeekday(now, timeZone)}`;
    })
    .filter((row): row is string => Boolean(row));

  if (rows.length === 0) {
    return {
      systemTime,
      systemWeekday,
      systemTimeZone,
      characterTime: "",
      characterWeekday: "",
      characterTimeZone: "",
      timeContext: `当前系统时间：${systemTime}，${systemWeekday}`,
      hasDifference: false,
    };
  }

  return {
    systemTime,
    systemWeekday,
    systemTimeZone,
    characterTime: "",
    characterWeekday: "",
    characterTimeZone: "",
    timeContext: [
      `当前系统时间：${systemTime} ${systemTimeZone}，${systemWeekday}`,
      "群成员本地时间：",
      ...rows,
      "判断每个角色作息、问候、深夜/清晨/工作时间时，优先使用该角色自己的本地时间。",
    ].join("\n"),
    hasDifference: true,
  };
}
