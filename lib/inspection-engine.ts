import type { Character } from "./character-types";
import type { ApiConfig } from "./settings-types";
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";
import { saveMemoryEntry, loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import {
  formatClock,
  inspectionNpcId,
  type InspectionChatMessage,
  type InspectionMemoCategory,
  type InspectionNpc,
  type InspectionPhotoTone,
} from "./inspection-storage";

export type InspectionGeneratedBundle = {
  conversations: Record<string, { direction: "incoming" | "outgoing"; text: string }[]>;
  memos: { category: InspectionMemoCategory; title: string; body: string }[];
  photos: { title: string; caption: string; location?: string; timeLabel?: string; tone?: InspectionPhotoTone }[];
  npcs: InspectionNpc[];
};

type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

const TONES: InspectionPhotoTone[] = ["silver", "graphite", "mist", "shadow"];

/** 查岗固定请求超时，避免接口卡住导致刷新按钮一直不可用 */
const INSPECTION_LLM_TIMEOUT_MS = 25000;

async function callInspectionLLM(
  config: ApiConfig,
  messages: ChatTurn[],
  options: { temperature?: number; max_tokens?: number; label?: string },
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECTION_LLM_TIMEOUT_MS);
  try {
    const result = await simpleLLMCall(config, messages, { ...options, signal: controller.signal });
    return result.content ?? null;
  } finally {
    clearTimeout(timer);
  }
}

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

/** 取该角色的核心记忆 + 与手机内容相关的长期记忆，拼成提示词片段 */
async function buildMemoryBlock(characterId: string, context: string): Promise<string> {
  try {
    const config = loadMemoryConfig();
    const task = Promise.all([
      retrieveCoreMemoriesForPrompt(characterId, config),
      retrieveMemoriesForPrompt(characterId, context, config),
    ]).then(([core, longTerm]) => (
      [formatCoreMemories(core), formatLongTermMemories(longTerm)].filter(Boolean).join("\n").slice(0, 1600)
    ));
    // 记忆检索可能走向量接口，限时避免拖慢刷新
    const timeout = new Promise<string>(resolve => {
      setTimeout(() => resolve(""), 4000);
    });
    return await Promise.race([task, timeout]);
  } catch {
    return "";
  }
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
  const memory = await buildMemoryBlock(owner.id, "对方 关系 手机 秘密 信任");
  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你要扮演下面这个角色，判断对方想查看你的手机时，你是否同意。",
        "只输出 JSON：{\"allow\": true/false, \"reason\": \"一句中文回应，不超过 40 字\"}",
        "不要输出解释、不要 markdown。同意与否要符合人设与你们的关系。",
        personaBlock(owner),
        memory ? `你与对方的记忆：\n${memory}` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: "对方突然说：我想看看你的手机。你同意吗？用你的口吻回应。",
    },
  ];
  try {
    const content = await callInspectionLLM(config, messages, {
      temperature: 0.8,
      max_tokens: 160,
      label: "inspection-permission",
    });
    const parsed = extractJsonObject(content || "");
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
  if (!config) return null;

  const memory = await buildMemoryBlock(owner.id, "好友 聊天 计划 说不出口的话 相册 日常 关系 工作");
  const friendLines = friends
    .slice(0, 6)
    .map(friend => `- ${friend.id}｜${friend.name}`)
    .join("\n") || "（暂无已有好友）";
  const refreshStamp = new Date().toLocaleString("zh-CN", { hour12: false });

  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你在为一个虚拟手机 App 生成「角色手机」里的隐私内容，供用户查看。",
        "只输出一个 JSON 对象，不要解释、不要 markdown 代码块：",
        "{\"npcs\":[{\"name\":\"\",\"relation\":\"\"}],",
        "\"friends\":[{\"friendId\":\"\",\"npcName\":\"\",\"messages\":[{\"direction\":\"incoming|outgoing\",\"text\":\"\"}]}],",
        "\"memos\":[{\"category\":\"plan|unsaid\",\"title\":\"\",\"body\":\"\"}],",
        "\"photos\":[{\"title\":\"\",\"caption\":\"\",\"location\":\"\",\"timeLabel\":\"\",\"tone\":\"silver|graphite|mist|shadow\"}]}",
        "规则：",
        "1. outgoing = 这个角色自己发出的消息；incoming = 好友发来的消息。",
        "2. 已有好友（给出 friendId）每人 3~4 条消息；另外生成 2~3 个与这个角色人设 / 记忆相关的手机好友，写进 npcs，并在 friends 里用 npcName 给他们各写 3~4 条消息。",
        "3. NPC 必须是这个人生活中真实会认识的人（同事、旧友、家人、常去的店老板等），关系自然；不要出现与角色无关的陌生人，也不要编造用户不认识的重名。",
        "4. memos 共 6 条：category=plan 是「计划」（待办、约好的事），category=unsaid 是「说不出口的话」（没敢发给某人的心里话）。",
        "5. photos 共 6 条：普通的手机相册条目，标题短、caption 一句描述，tone 是色调。",
        "6. 所有内容必须贴合角色人设与下面的记忆；记忆里没有的事实不要凭空编造，可以合理补全日常细节。",
        "7. 内容要像这一部真实的手机，不要出现真实隐私、联系方式或长段落。",
        "8. 每次刷新都要产出与上一次不同的新内容，不要复用旧句子。",
        personaBlock(owner),
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "这个角色手机里已有的好友（friendId｜名字）：",
        friendLines,
        "",
        memory ? `关于这个角色和你们的记忆：\n${memory}` : "（暂无可用记忆）",
        "",
        `本次刷新时间：${refreshStamp}`,
        "请按上面的 JSON 结构输出内容。",
      ].join("\n"),
    },
  ];

  try {
    const content = await callInspectionLLM(config, messages, {
      temperature: 0.95,
      max_tokens: 1600,
      label: "inspection-bundle",
    });
    const parsed = extractJsonObject(content || "");
    if (!parsed) return null;

    const npcs: InspectionNpc[] = [];
    if (Array.isArray(parsed.npcs)) {
      for (const raw of parsed.npcs) {
        if (!raw || typeof raw !== "object") continue;
        const item = raw as Record<string, unknown>;
        const name = cleanLine(item.name, 12);
        if (!name) continue;
        const id = inspectionNpcId(name);
        if (npcs.some(npc => npc.id === id)) continue;
        npcs.push({ id, name, relation: cleanLine(item.relation, 30) });
        if (npcs.length >= 3) break;
      }
    }
    const npcIdsByName = new Map(npcs.map(npc => [npc.name, npc.id]));
    const validFriendIds = new Set([...friends.map(friend => friend.id), ...npcs.map(npc => npc.id)]);
    const conversations: InspectionGeneratedBundle["conversations"] = {};
    if (Array.isArray(parsed.friends)) {
      for (const entry of parsed.friends) {
        if (!entry || typeof entry !== "object") continue;
        const item = entry as Record<string, unknown>;
        const friendId = cleanLine(item.friendId, 60);
        const npcName = cleanLine(item.npcName, 20);
        const resolvedId = validFriendIds.has(friendId) ? friendId : (npcIdsByName.get(npcName) ?? "");
        if (!resolvedId || !Array.isArray(item.messages)) continue;
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
        if (list.length > 0) conversations[resolvedId] = list;
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

    if (
      Object.keys(conversations).length === 0
      && memos.length === 0
      && photos.length === 0
      && npcs.length === 0
    ) return null;
    return { conversations, memos, photos, npcs };
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
    const content = await callInspectionLLM(config, messages, {
      temperature: 0.9,
      max_tokens: 160,
      label: "inspection-friend-reply",
    });
    const reply = cleanLine(content, 160);
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
  const memory = await buildMemoryBlock(owner.id, `${pageLabel} ${context} 对方 秘密`);
  const messages: ChatTurn[] = [
    {
      role: "system",
      content: [
        "你在扮演下面这个角色。对方正在翻看你的手机，你能看到 TA 当前在看什么。",
        "针对当前页面用一句话回应，可以嘴硬、尴尬、撒娇、心虚或无所谓，符合人设。",
        "如果下面的记忆和当前页面有关，可以自然地提到，但不要生硬复述。",
        "只输出这一句话，不要引号、不要旁白、不要解释，不超过 30 个字。",
        personaBlock(owner),
        memory ? `相关记忆：\n${memory}` : "",
      ].filter(Boolean).join("\n"),
    },
    {
      role: "user",
      content: `对方正在看：${pageLabel}。${context ? `页面内容：${context}` : ""}`,
    },
  ];
  try {
    const content = await callInspectionLLM(config, messages, {
      temperature: 0.9,
      max_tokens: 100,
      label: "inspection-comment",
    });
    return cleanLine(content, 60) || null;
  } catch {
    return null;
  }
}

function shuffle<T>(list: T[]): T[] {
  const next = [...list];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

/** 本地兜底：没配置 API 时也能看到一份合理内容；每次刷新随机组合，刷新能看到变化 */
export function buildFallbackBundle(owner: Character, friends: Character[]): InspectionGeneratedBundle {
  const planPool = [
    { title: "周末的时间", body: "把周六下午空出来，想去找你。" },
    { title: "要记得买", body: "常喝的那款咖啡豆快没了，顺便买点牛奶。" },
    { title: "还没回的消息", body: "有一条消息看到了没回，想着当面说比较好。" },
    { title: "下次一起", body: "那家店想去很久了，等你有空。" },
    { title: "该收拾了", body: "房间乱得有点过分，周末大扫除。" },
    { title: "早睡计划", body: "从今天开始一点前睡，先坚持三天。" },
  ];
  const unsaidPool = [
    { title: "其实很在意", body: "今天看到你和别人聊得开心，有点不是滋味，但又不想显得小气。" },
    { title: "想说但算了", body: "本来想问你周末有没有空，打了又删掉了。" },
    { title: "关于那天", body: "那天说话可能有点重，其实不是那个意思。" },
    { title: "有点想你", body: "这句话打好几次了，还是没发出去。" },
    { title: "别太累", body: "想让你少熬一点夜，又怕自己管太多。" },
    { title: "照片没删", body: "那张合照一直留在相册里，没舍得删。" },
  ];
  const photoPool = [
    { title: "傍晚", caption: "窗外颜色很好看，随手拍的。", location: "窗边", timeLabel: "18:42", tone: "silver" as const },
    { title: "咖啡", caption: "今天第三杯了。", location: "楼下", timeLabel: "15:10", tone: "graphite" as const },
    { title: "回家路上", caption: "路灯亮起来的那一瞬间。", location: "街角", timeLabel: "20:06", tone: "mist" as const },
    { title: "书桌", caption: "摊了一桌子，懒得收。", location: "家", timeLabel: "23:17", tone: "shadow" as const },
    { title: "雨天", caption: "忘记带伞的一天。", location: "公司楼下", timeLabel: "09:05", tone: "silver" as const },
    { title: "夜宵", caption: "说好只吃一点的。", location: "巷口", timeLabel: "22:38", tone: "graphite" as const },
    { title: "天空", caption: "抬头的时候刚好有云散开。", location: "天台", timeLabel: "17:21", tone: "mist" as const },
    { title: "新杯子", caption: "买了很久，今天才拆。", location: "家", timeLabel: "13:46", tone: "shadow" as const },
    { title: "地铁", caption: "人很多，站了一路。", location: "地铁站", timeLabel: "08:32", tone: "graphite" as const },
    { title: "花", caption: "路过花店，顺手带了一支。", location: "花店", timeLabel: "16:08", tone: "silver" as const },
  ];

  const memos = [
    ...shuffle(planPool).slice(0, 3).map(item => ({ category: "plan" as const, ...item })),
    ...shuffle(unsaidPool).slice(0, 3).map(item => ({ category: "unsaid" as const, ...item })),
  ];
  const photos = shuffle(photoPool).slice(0, 6);

  const conversations: InspectionGeneratedBundle["conversations"] = {};
  friends.slice(0, 6).forEach(friend => {
    const variants: { direction: "incoming" | "outgoing"; text: string }[][] = [
      [
        { direction: "incoming", text: `${owner.name}，周末出来吗？` },
        { direction: "outgoing", text: "看情况，最近有点忙。" },
        { direction: "incoming", text: "行吧，忙完记得说一声。" },
      ],
      [
        { direction: "outgoing", text: "上次那家店叫什么来着？" },
        { direction: "incoming", text: "你怎么又忘了，我发你定位。" },
        { direction: "outgoing", text: "收到，谢了。" },
      ],
      [
        { direction: "incoming", text: "你最近是不是没睡好？" },
        { direction: "outgoing", text: "有一点，过两天就好了。" },
        { direction: "incoming", text: "别硬撑。" },
      ],
      [
        { direction: "incoming", text: `${friend.name}：照片我修好了，回头发你。` },
        { direction: "outgoing", text: "不急，你慢慢弄。" },
      ],
      [
        { direction: "outgoing", text: "晚上有空吗，想找你聊两句。" },
        { direction: "incoming", text: "有啊，怎么了？" },
        { direction: "outgoing", text: "没什么，见面说。" },
      ],
      [
        { direction: "incoming", text: "你又把东西落我这了。" },
        { direction: "outgoing", text: "明天顺路去拿。" },
      ],
    ];
    conversations[friend.id] = variants[Math.floor(Math.random() * variants.length)];
  });
  return { conversations, memos, photos, npcs: [] };
}

const COMMENT_FALLBACK: Record<string, string[]> = {
  chat: ["……聊天记录也要一条条看？", "看就看，别笑我。", "都翻到这儿了，还装没看见。"],
  moments: ["动态就那些，没什么好看的。", "那条是随手发的，别当真。", "你翻得比我自己还仔细。"],
  memos: ["备忘录别看太久，有点丢人。", "计划那栏……你就当没看见吧。", "说不出口的话，现在被你看见了。"],
  photos: ["相册你随便翻吧，反正也没几张。", "那张拍得不好，删掉行不行。", "怎么翻到这张了。"],
};

export function buildFallbackComment(page: string): string {
  const list = COMMENT_FALLBACK[page];
  if (list && list.length > 0) return list[Math.floor(Math.random() * list.length)];
  return "……看够了吗？";
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
