export const CHARACTER_LANGUAGE_OPTIONS = [
  { value: "zh", label: "中文", nativeLabel: "简体中文", keywords: "中文 汉语 普通话 chinese zh cn" },
  { value: "en", label: "英文", nativeLabel: "English", keywords: "英文 英语 english en" },
  { value: "ko", label: "韩语", nativeLabel: "한국어", keywords: "韩语 韩文 korean 한국어 ko kr" },
  { value: "ja", label: "日语", nativeLabel: "日本語", keywords: "日语 日文 japanese 日本語 ja jp" },
] as const;

export type CharacterLanguage = typeof CHARACTER_LANGUAGE_OPTIONS[number]["value"];
export const DEFAULT_CHARACTER_LANGUAGE: CharacterLanguage = "zh";

export function normalizeCharacterLanguage(value: unknown): CharacterLanguage {
  return CHARACTER_LANGUAGE_OPTIONS.some(option => option.value === value)
    ? value as CharacterLanguage
    : DEFAULT_CHARACTER_LANGUAGE;
}

export function getCharacterLanguageOption(value: unknown): typeof CHARACTER_LANGUAGE_OPTIONS[number] {
  const language = normalizeCharacterLanguage(value);
  return CHARACTER_LANGUAGE_OPTIONS.find(option => option.value === language)!;
}

export type Character = {
  id: string;
  name: string;
  avatar: string | null; // data URL 或外部 URL
  persona: string;       // 人设
  briefPersona?: string; // 简量版人设：注入到同世界有关系角色的「角色关系」marker，供对方了解 TA（防 OOC）
  briefPersonaUpdatedAt?: string; // 简介生成时间；早于 updatedAt 时编辑器提示「设定已更新，建议重新生成」
  wechatID?: string;     // 手机号格式的微信号
  personality?: string;    // 角色性格
  language?: CharacterLanguage; // 角色聊天语言；旧角色缺省按中文处理
  timeZone?: string;       // IANA 时区，例如 America/New_York；空值表示跟随系统时间
  tags?: string[];
  createdAt: string;
  updatedAt: string;

  // 画布坐标与渲染属性
  canvasX?: number;
  canvasY?: number;
  canvasRot?: number;
  canvasZIndex?: number;
  polaroidStyle?: number; // 用户选择的拍立得样式索引
  polaroidSize?: "random" | "small" | "medium" | "large";
  polaroidImageX?: number;
  polaroidImageY?: number;
  polaroidImageZoom?: number;
};

export type CanvasBgItem = {
  id: string;
  type: 'a4' | 'yellow-note' | 'blue-note' | 'torn' | 'grid' | 'scrap';
  x: number;
  y: number;
  rot: number;
  zIndex: number;
  worldId?: string; // 所属世界画布；缺省 = 默认世界（存量数据零迁移）
};
