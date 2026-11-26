import type { Character } from "./character-types";
import type { ApiConfig } from "./settings-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { saveMemoryEntry } from "./memory-storage";
import {
  formatClock,
  type InspectionChatMessage,
  type InspectionMemoCategory,
  type InspectionPhotoTone,
} from "./inspection-storage";

export type InspectionGeneratedBundle = {
  conversations: Record<string, { direction: "incoming" | "outgoing"; text: string }[]>;
  memos: { category: InspectionMemoCategory; title: string; body: string }[];
  photos: { title: string; caption: string; location?: string; timeLabel?: string; tone?: InspectionPhotoTone }[];
};

type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

const TONES: InspectionPhotoTone[] = ["silver", "graphite", "mist", "shadow"];

/** 查岗使用该角色「聊天」绑定的 API；没配置时回落到第一条可用 API */
export function resolveInspectionApiConfig(characterId: string): ApiConfig | null {
  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "chat");
    if (slot?.apiConfigId) {
      const bound = loadApiConfigs().find(c => c.id === slot.apiConfigId);
      if (bound) return bound;
    }
  } catch {
    /* 绑定缺失时继续找全局 API */
  }
  return loadApiConfigs()[0] ?? null;
}

function personaBlock(character: Character): string {
  const persona = (character.persona || "").trim().slice(0, 600);
  const personality = (character.personality || "").trim().slice(0, 160);
  return [
    `角色名：${character.name}`,
    personality ? `性格：${personality}` : "",
    persona ? `人设：${persona}` : "",
  ].filter(Boolean).join("\n");
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function cleanLine(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 让角色决定是否同意被查岗；失败时默认同意并给出兜底理由 */
export async function decideInspectionPermission(owner: Character): Promise<{ allow: boolean; reason: string }> {
  const config = resolveInspectionApiConfig(owner.id);
  if (!config) {
    return { allow: true, reason: "……你翻吧，别乱删东西就行。" };
  }
  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你要扮演下面这个角色，判断对方想查看你的手机时，你是否同意。",
        "只输出 JSON：{\"allow\": true/false, \"reason\": \"一句中文回应，不超过 40 字\"}",
        "不要输出解释、不要 markdown。同意与否要符合人设与你们的关系。",
        personaBlock(owner),
      ].join("\n"),
    },
    {
      role: "user",
      content: "对方突然说：我想看看你的手机。你同意吗？用你的口吻回应。",
    },
  ];
  try {
    const result = await simpleLLMCall(config, messages, {
      temperature: 0.8,
      max_tokens: 160,
      label: "inspection-permission",
    });
    const parsed = extractJsonObject(result.content || "");
    if (!parsed) return { allow: true, reason: "……给，看吧。" };
    const reason = cleanLine(parsed.reason, 60);
    return {
      allow: parsed.allow !== false,
      reason: reason || (parsed.allow === false ? "不给看。" : "……看吧。"),
    };
  } catch {
    return { allow: true, reason: "……给，看吧。" };
  }
}

/** 生成角色手机里的好友聊天、备忘录、相册；失败返回 null（调用方用本地兜底） */
export async function generateInspectionBundle(
  owner: Character,
  friends: Character[],
): Promise<InspectionGeneratedBundle | null> {
  const config = resolveInspectionApiConfig(owner.id);
  if (!config || friends.length === 0) return null;

  const friendLines = friends
    .slice(0, 6)
    .map(friend => `- ${friend.id}｜${friend.name}`)
    .join("\n");

  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你在为一个虚拟手机 App 生成「角色手机」里的隐私内容，供用户查看。",
        "只输出一个 JSON 对象，不要解释、不要 markdown 代码块：",
        "{\"friends\":[{\"friendId\":\"\",\"messages\":[{\"direction\":\"incoming|outgoing\",\"text\":\"\"}]}],",
        "\"memos\":[{\"category\":\"plan|unsaid\",\"title\":\"\",\"body\":\"\"}],",
        "\"photos\":[{\"title\":\"\",\"caption\":\"\",\"location\":\"\",\"timeLabel\":\"\",\"tone\":\"silver|graphite|mist|shadow\"}]}",
        "规则：",
        "1. outgoing = 这个角色自己发出的消息；incoming = 好友发来的消息。",
        "2. 每个好友 3~4 条消息，像真实日常聊天，口语化，可用表情。",
        "3. memos 共 6 条：category=plan 是「计划」（待办、约好的事），category=unsaid 是「说不出口的话」（没敢发给某人的心里话）。",
        "4. photos 共 6 条：普通的手机相册条目，标题短、caption 一句描述，tone 是色调。",
        "5. 内容必须贴合角色人设，不要出现真实隐私、联系方式或长段落。",
        personaBlock(owner),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "这个角色手机里的好友列表（friendId｜名字）：",
        friendLines,
        "",
        "请按上面的 JSON 结构输出内容。",
      ].join("\n"),
    },
  ];

  try {
    const result = await simpleLLMCall(config, messages, {
      temperature: 0.95,
      max_tokens: 1600,
      label: "inspection-bundle",
    });
    const parsed = extractJsonObject(result.content || "");
    if (!parsed) return null;

    const validFriendIds = new Set(friends.map(friend => friend.id));
    const conversations: InspectionGeneratedBundle["conversations"] = {};
    if (Array.isArray(parsed.friends)) {
      for (const entry of parsed.friends) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const friendId = cleanLine(item.friendId, 60);
        if (!validFriendIds.has(friendId) || !Array.isArray(item.messages)) continue;
        const list = item.messages
          .map(raw => {
            if (!raw || typeof raw !== "object") return null;
            const msg = raw as Record<string, unknown>;
            const text = cleanLine(msg.text, 120);
            if (!text) return null;
            return {
              direction: msg.direction === "outgoing" ? "outgoing" as const : "incoming" as const,
              text,
            };
          })
          .filter((msg): msg is { direction: "incoming" | "outgoing"; text: string } => !!msg)
          .slice(0, 6);
        if (list.length > 0) conversations[friendId] = list;
      }
    }

    const memos = Array.isArray(parsed.memos)
      ? parsed.memos
        .map(raw => {
          if (!raw || typeof raw !== "object") return null;
          const item = raw as Record<string, unknown>;
          const title = cleanLine(item.title, 40);
          const body = cleanLine(item.body, 200);
          if (!title && !body) return null;
          return {
            category: item.category === "unsaid" ? "unsaid" as const : "plan" as const,
            title: title || "未命名",
            body,
          };
        })
        .filter((item): item is { category: InspectionMemoCategory; title: string; body: string } => !!item)
        .slice(0, 8)
      : [];

    const photos = Array.isArray(parsed.photos)
      ? parsed.photos
        .map(raw => {
          if (!raw || typeof raw !== "object") return null;
          const item = raw as Record<string, unknown>;
          const title = cleanLine(item.title, 40);
          const caption = cleanLine(item.caption, 120);
          if (!title && !caption) return null;
          const tone = TONES.includes(item.tone as InspectionPhotoTone)
            ? item.tone as InspectionPhotoTone
            : "silver";
          return {
            title: title || "无题",
            caption,
            location: cleanLine(item.location, 40),
            timeLabel: cleanLine(item.timeLabel, 24),
            tone,
          };
        })
        .filter((item): item is { title: string; caption: string; location: string; timeLabel: string; tone: InspectionPhotoTone } => !!item)
        .slice(0, 9)
      : [];

    if (Object.keys(conversations).length === 0 && memos.length === 0 && photos.length === 0) return null;
    return { conversations, memos, photos };
  } catch {
    return null;
  }
}

/** 好友收到消息后的回复 */
export async function generateFriendReply(
  owner: Character,
  friend: Character,
  thread: InspectionChatMessage[],
  text: string,
): Promise<string | null> {
  const config = resolveInspectionApiConfig(owner.id) ?? resolveInspectionApiConfig(friend.id);
  if (!config) return null;
  const recent = thread
    .slice(-6)
    .map(msg => `${msg.direction === "outgoing" ? owner.name : friend.name}：${msg.text}`)
    .join("\n");

  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你在扮演下面这个角色，正在手机上收到一条消息。",
        "只输出回复正文，不要加引号、不要旁白、不要解释，一到两句话，口语化。",
        personaBlock(friend),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `现在拿手机的人用的是「${owner.name}」的账号，正在给你发消息。`,
        recent ? `最近的聊天记录：\n${recent}` : "",
        `对方刚发来：${text}`,
        "请用你的口吻回复。",
      ].filter(Boolean).join("\n"),
    },
  ];

  try {
    const result = await simpleLLMCall(config, messages, {
      temperature: 0.9,
      max_tokens: 160,
      label: "inspection-friend-reply",
    });
    const reply = cleanLine(result.content, 160);
    return reply || null;
  } catch {
    return null;
  }
}

/** 角色针对当前浏览页面的实时发言 */
export async function generateInspectionComment(
  owner: Character,
  pageLabel: string,
  context: string,
): Promise<string | null> {
  const config = resolveInspectionApiConfig(owner.id);
  if (!config) return null;
  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你在扮演下面这个角色。对方正在翻看你的手机，你能看到 TA 当前在看什么。",
        "针对当前页面用一句话回应，可以嘴硬、尴尬、撒娇、心虚或无所谓，符合人设。",
        "只输出这一句话，不要引号、不要旁白、不要解释，不超过 30 个字。",
        personaBlock(owner),
      ].join("\n"),
    },
    {
      role: "user",
      content: `对方正在看：${pageLabel}。${context ? `页面内容：${context}` : ""}`,
    },
  ];
  try {
    const result = await simpleLLMCall(config, messages, {
      temperature: 0.9,
      max_tokens: 100,
      label: "inspection-comment",
    });
    return cleanLine(result.content, 60) || null;
  } catch {
    return null;
  }
}

/** 本地兜底：没配置 API 时也能看到一份合理内容 */
export function buildFallbackBundle(owner: Character, friends: Character[]): InspectionGeneratedBundle {
  const plans = [
    { title: "周末的时间", body: `把周六下午空出来，想去找${owner.name === "我" ? "你" : "你"}。` },
    { title: "要记得买", body: "常喝的那款咖啡豆快没了，顺便买点牛奶。" },
    { title: "还没回的消息", body: "有一条消息看到了没回，想着当面说比较好。" },
  ];
  const unsaid = [
    { title: "其实很在意", body: "今天看到你和别人聊得开心，有点不是滋味，但又不想显得小气。" },
    { title: "想说但算了", body: "本来想问你周末有没有空，打了又删掉了。" },
    { title: "关于那天", body: "那天说话可能有点重，其实不是那个意思。" },
  ];
  const memos = [
    ...plans.map(item => ({ category: "plan" as const, ...item })),
    ...unsaid.map(item => ({ category: "unsaid" as const, ...item })),
  ];
  const photos = [
    { title: "傍晚", caption: "窗外颜色很好看，随手拍的。", location: "窗边", timeLabel: "18:42", tone: "silver" as const },
    { title: "咖啡", caption: "今天第三杯了。", location: "楼下", timeLabel: "15:10", tone: "graphite" as const },
    { title: "回家路上", caption: "路灯亮起来的那一瞬间。", location: "街角", timeLabel: "20:06", tone: "mist" as const },
    { title: "书桌", caption: "摊了一桌子，懒得收。", location: "家", timeLabel: "23:17", tone: "shadow" as const },
    { title: "雨天", caption: "忘记带伞的一天。", location: "公司楼下", timeLabel: "09:05", tone: "silver" as const },
    { title: "夜宵", caption: "说好只吃一点的。", location: "巷口", timeLabel: "22:38", tone: "graphite" as const },
  ];
  const conversations: InspectionGeneratedBundle["conversations"] = {};
  friends.slice(0, 6).forEach((friend, index) => {
    const variants = [
      [
        { direction: "incoming" as const, text: `${owner.name}，周末出来吗？` },
        { direction: "outgoing" as const, text: "看情况，最近有点忙。" },
        { direction: "incoming" as const, text: "行吧，忙完记得说一声。" },
      ],
      [
        { direction: "outgoing" as const, text: "上次那家店叫什么来着？" },
        { direction: "incoming" as const, text: "你怎么又忘了，我发你定位。" },
      ],
      [
        { direction: "incoming" as const, text: "你最近是不是没睡好？" },
        { direction: "outgoing" as const, text: "有一点，过两天就好了。" },
        { direction: "incoming" as const, text: "别硬撑。" },
      ],
    ];
    conversations[friend.id] = variants[index % variants.length];
  });
  return { conversations, memos, photos };
}

const COMMENT_FALLBACK: Record<string, string> = {
  chat: "……聊天记录也要一条条看？",
  moments: "动态就那些，没什么好看的。",
  memos: "备忘录别看太久，有点丢人。",
  photos: "相册你随便翻吧，反正也没几张。",
};

export function buildFallbackComment(page: string): string {
  return COMMENT_FALLBACK[page] || "……看够了吗？";
}

/** 把查岗过程中的互动写入该角色的长期记忆（参与后续检索与看法更新） */
export async function saveInspectionMemory(
  characterId: string,
  content: string,
  importance = 0.55,
): Promise<void> {
  const text = content.trim();
  if (!characterId || !text) return;
  const now = new Date().toISOString();
  try {
    await saveMemoryEntry({
      id: `mem_inspection_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      characterId,
      sourceApp: "checkphone",
      type: "long_term",
      content: text.slice(0, 400),
      importance,
      createdAt: now,
      updatedAt: now,
      metadata: { origin: "inspection", time: formatClock(new Date()) },
    });
  } catch {
    /* 记忆写入失败不影响查岗流程 */
  }
}
