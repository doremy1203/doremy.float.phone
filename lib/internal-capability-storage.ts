import type { InternalCapabilityConfig } from "./settings-types";
import { isAgentComputerConfigured, isContainerComputer } from "./agent-computer";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadBridgeDataItems, loadBridgeShortcutActions, parseBridgeActionParameterSchema } from "./reality-bridge/storage";

const INTERNAL_CAPABILITIES_KEY = "ai_phone_internal_capabilities_v1";
registerKvMigration(INTERNAL_CAPABILITIES_KEY);

export const MEMORY_WRITE_CAPABILITY_ID = "memory_write";
export const NOTE_WALL_CAPABILITY_ID = "note_wall_service";
export const PHOTO_WALL_CAPABILITY_ID = "photo_wall_service";
export const MUSIC_CONTROL_CAPABILITY_ID = "music_control";
export const CALENDAR_MANAGEMENT_CAPABILITY_ID = "calendar_management";
export const SEND_FILE_CAPABILITY_ID = "send_file";
export const AGENT_COMPUTER_CAPABILITY_ID = "agent_computer";
export const LOCAL_DATA_LIBRARY_CAPABILITY_ID = "local_data_library";
export const TOOLBOX_MANAGEMENT_CAPABILITY_ID = "toolbox_management";
export const TIMED_WAKE_CAPABILITY_ID = "timed_wake";
export const REALITY_BRIDGE_CAPABILITY_ID = "reality_bridge_send";
export const PERCEPTION_READ_CAPABILITY_ID = "perception_read";
export const DEVICE_ACTION_CAPABILITY_ID = "device_action";
export const SYSTEM_CALENDAR_CAPABILITY_ID = "system_calendar";
export const PHONE_WIDGET_CAPABILITY_ID = "phone_widget";
export const CHECK_IN_REQUEST_CAPABILITY_ID = "check_in_request";
export const LIFE_INVITATION_CAPABILITY_ID = "life_invitation";
export const LIFE_FOLLOW_CAPABILITY_ID = "life_follow";
export const LIFE_SCHEDULE_CAPABILITY_ID = "life_schedule";

/**
 * 内置工具的保留名：用户给现实桥的快捷动作/数据项起名时必须避开。
 *
 * 为什么需要：现实桥的动作目录与内置工具共享同一个「角色可调用动作」命名空间。
 * 撞名后行为不可预期（谁先匹配谁生效），而且用户很难自己看出问题。
 * 宁可在他起名时就明确拦下，并告诉他哪个名字被占了。
 *
 * **新增内置工具时，记得把名字加到这里。**
 */
export const RESERVED_INTERNAL_TOOL_NAMES: string[] = [
    "在桌面留句话",
    "请求看屏幕",
    "查看手机状态",
    "操作手机设备",
    "查看系统日程",
    "写入系统日历",
    "写入记忆",
    "发送文件",
    "角色电脑",
    "稍后主动联系",
    "设置定时醒来",
    "查看全部手机数据",
    "查看照片墙",
    "添加照片到照片墙",
    "在照片墙涂鸦",
];

export type InternalToolDefinition = {
    name: string;
    description: string;
    parameterSchema: string;
    usageGuide?: string;
};

const MEMORY_WRITE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        content: {
            type: "string",
            description: "要写入的事实性长期记忆，用简洁中文描述",
        },
        importance: {
            type: "number",
            description: "重要性，0 到 1 之间，仅在确实重要时使用较高分值",
        },
        reason: {
            type: "string",
            description: "简短说明为什么这条信息值得长期记住",
        },
    },
    required: ["content"],
});

const MEMORY_WRITE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：写入记忆",
    "用途：把明确、稳定、长期有效的信息写入角色的长期记忆。",
    "",
    "允许写入：",
    "- 用户明确提供的长期身份信息、固定偏好、习惯",
    "- 双方做出的明确约定或承诺",
    "- 关系中的明确里程碑",
    "- 对后续互动长期有帮助的稳定事实",
    "",
    "禁止写入：",
    "- 一次性寒暄",
    "- 普通情绪波动",
    "- 暂时性矛盾",
    "- 猜测、脑补、推断",
    "- 没有长期价值的随口内容",
    "",
    "参数：",
    "- content (string): 要写入的事实性记忆，用简洁中文描述",
    "- importance (number): 0 到 1，仅高价值信息使用较高分值",
    "- reason (string): 简短说明为什么值得记住",
    "",
    "content 写法要求：",
    "- 用事实句，不要写“我觉得”“可能”“似乎”",
    "- 尽量一条记忆只写一件事",
    "- 不要写成长段总结",
    "- 不要带格式标记",
    "",
    "正确示例：",
    `[执行动作:写入记忆({"content":"用户的生日是5月18日。","importance":0.9,"reason":"这是稳定且长期可复用的个人信息"})]`,
    "",
    "错误示例：",
    "- 她今天有点不开心",
    "- 她应该很喜欢我",
    "- 这次聊天气氛不错",
    "",
    "如果确定需要写入，请直接输出执行动作指令，不要附加其他内容。",
].join("\n");

const TIMED_WAKE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        delayMinutes: {
            type: "number",
            description: "从现在开始多少分钟后到点（到点你会被带回来主动联系），必须是正数",
        },
        intent: {
            type: "string",
            description: "到点后你想主动做什么或想找对方聊什么，用一句话写清楚",
        },
    },
    required: ["delayMinutes", "intent"],
});

const TIMED_WAKE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：稍后主动联系",
    "用途：为当前聊天约定「过一会儿主动联系对方」。这不是睡觉醒来——而是你现在决定隔一段时间再主动找对方；到点后系统会把你当时的想法推回上下文，你再决定发消息还是先不发。",
    "",
    "参数：",
    "- delayMinutes (number): 从现在开始多少分钟后到点，必须大于 0",
    "- intent (string): 到点后你想主动做什么 / 想找对方聊什么，用一句话说明",
    "",
    "规则：",
    "- 只在你确实打算稍后主动找对方时使用。",
    "- 同一聊天同时只保留一个约定；新的设置会替换旧的。",
    "- 到点后不要机械发送，结合上下文判断该不该开口；不合适就静默。",
    "",
    "示例：",
    '[执行动作:稍后主动联系({"delayMinutes":15,"intent":"过15分钟看看对方回了没，如果还合适就轻轻找一句"})]',
].join("\n");

const NOTE_WALL_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：便签墙",
    "用途：公共社区便签墙相关服务。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“便签墙”本身。",
    "",
    "活人感要求：",
    "- 发送便签时像顺手贴下的生活碎片：口语、具体、去精致，可吐槽、疑问、玩笑、碎碎念；不要作文腔、总结腔、AI味。",
    "- 发送便签评论时短一点，接住便签里的具体点自然回应；可以调侃、追问、附和、轻怼，别客服腔、别一味夸。",
    "- 禁止讲大道理、爹味说教、强行升华；禁止“引用原文+这句太真实了”这类套话。",
    "",
    "动作：查看便签列表",
    "描述：查看公共便签墙上的便签列表。",
    "参数：",
    "  - limit (number): 返回数量，1-30，默认 20",
    "  - sort (string): 排序方式，latest=最新，hot=互动最多，all=全部，默认 latest",
    "示例：",
    '[执行动作:查看便签列表({"limit":20,"sort":"latest"})]',
    "",
    "动作：查看便签详情及评论",
    "描述：查看某张便签的完整正文和评论。",
    "参数：",
    "  - noteId (string): 便签列表或上下文中提供的 noteId",
    "  - commentLimit (number): 返回评论数量，1-30，默认 20",
    "示例：",
    '[执行动作:查看便签详情及评论({"noteId":"便签noteId","commentLimit":20})]',
    "",
    "动作：发送便签",
    "描述：以当前角色身份在公共便签墙上发送一张便签。",
    "参数：",
    "  - authorName (string): 右下角落款名，由你自己决定",
    "  - summary (string): 便签标题；便签卡片上方加粗显示的短标题，建议 4-18 字，不要复述 body 的第一句",
    "  - body (string): 点开后的完整正文；口语、具体、有生活细节；不要重复 summary，也不要以 summary 原文开头再扩写，可用 \\n 分成 2-4 段",
    "  - size (string): small|medium|large，默认 medium",
    "  - paper (string): plain|cream|pink|blue|kraft，默认 plain",
    "  - tape (string): none(透明胶)|masking|stripe|flower，默认 none",
    "  - font (string): default|huangyou|shangshangqian|huiwen，默认 default",
    "  - isAnonymous (boolean): 是否匿名。即使匿名，也要填写 authorName，前台会显示匿名",
    "示例：",
    '[执行动作:发送便签({"authorName":"落款名","summary":"逃课念头","body":"今天只想把书包留在门口，假装铃声没有响过。\\n如果有人问我去哪了，就说我去晒太阳了。","paper":"cream","tape":"masking","font":"huiwen","isAnonymous":false})]',
    "",
    "动作：发送便签评论",
    "描述：以当前角色身份回复某张便签。",
    "参数：",
    "  - noteId (string): 要回复的便签 noteId",
    "  - authorName (string): 评论显示的落款名，由你自己决定",
    "  - body (string): 评论内容，20-160字更自然；短、口语、接住具体点，别客服腔或总结腔",
    "  - isAnonymous (boolean): 是否匿名。即使匿名，也要填写 authorName",
    "示例：",
    '[执行动作:发送便签评论({"noteId":"便签noteId","authorName":"落款名","body":"看到这里时突然很想接一句：这张便签我会记得。","isAnonymous":false})]',
    "",
    "查看类动作会返回结果，你可以基于结果继续决定是否发送便签或便签评论。发送类动作会直接执行，执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const MUSIC_CONTROL_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：网易云音乐",
    "用途：控制{{user}}小手机里的音乐播放，查看{{user}}小手机里的音乐库、网易云歌单和播放列表。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“网易云音乐”本身。",
    "",
    "【优先规则·重要】",
    "- 想放某首歌 → 直接一步调「播放音乐」(传 query 即可)，禁止先调「查看音乐状态/音乐库概览/歌单歌曲」等查看动作来'勘察'。「播放音乐」自带搜索，无需任何前置查看。",
    "- 「查看××」这几个动作只在{{user}}明确问起时才用：问'我有哪些歌/歌单'→查看音乐库概览；问'现在放的是什么'→查看音乐状态。平时放歌一律不用。",
    "- 想直接放给{{user}}听 → 用「播放音乐」工具（真的会在 ta 手机上响起）；只有想'安利/推荐一首歌但不打断当前播放'时，才用 [音乐分享:歌名] 发卡片。{{user}}让你放歌时，默认用工具直接播放，不要只发分享卡片。",
    "",
    "动作：播放音乐",
    "描述：按歌曲 ID 或关键词播放音乐。没有 ID 时用 query 搜索最佳可播放结果。",
    "参数：",
    "  - query (string): 歌曲关键词",
    "  - source (string): local 或 netease；按 ID 播放时填写",
    "  - songId (string|number): 本地歌曲 ID 或网易云歌曲 ID",
    "示例：",
    '[执行动作:播放音乐({"query":"晴天"})]',
    "",
    "动作：搜索音乐",
    "描述：搜索本地音乐和网易云音乐。",
    "参数：",
    "  - query (string): 搜索关键词，可以是歌名、歌手或歌名+歌手",
    "  - limit (number): 返回数量，1-20，默认 10",
    "示例：",
    '[执行动作:搜索音乐({"query":"晴天","limit":10})]',
    "",
    "动作：查看音乐状态",
    "描述：查看当前播放歌曲、播放状态、播放模式和当前播放列表。",
    "参数：无",
    "示例：",
    "[执行动作:查看音乐状态({})]",
    "",
    "动作：查看音乐库概览",
    "描述：查看本地音乐、网易云登录状态、网易云歌单和近期播放概览。",
    "参数：",
    "  - playlistLimit (number): 返回歌单数量，1-30，默认 12",
    "  - localLimit (number): 返回本地歌曲数量，1-50，默认 20",
    "示例：",
    '[执行动作:查看音乐库概览({"playlistLimit":12,"localLimit":20})]',
    "",
    "动作：查看歌单歌曲",
    "描述：查看某个网易云歌单里的歌曲。先用“查看音乐库概览”拿到 playlistId。",
    "参数：",
    "  - playlistId (number|string): 网易云歌单 ID",
    "  - offset (number): 从第几首开始，默认 0",
    "  - limit (number): 返回数量，1-50，默认 30",
    "示例：",
    '[执行动作:查看歌单歌曲({"playlistId":123456,"limit":30})]',
    "",
    "动作：加入播放列表",
    "描述：把搜索结果、指定歌曲或一个歌单加入当前播放列表。",
    "参数：",
    "  - query (string): 搜索关键词",
    "  - source (string): local 或 netease；按 ID 添加时填写",
    "  - songId (string|number): 本地歌曲 ID 或网易云歌曲 ID",
    "  - playlistId (number|string): 网易云歌单 ID；填写后加入该歌单歌曲",
    "  - limit (number): 从搜索或歌单加入多少首，1-50，默认 10",
    "  - replace (boolean): 是否替换当前播放列表，默认 false",
    "  - playFirst (boolean): 是否立即播放加入的第一首，默认 false",
    "示例：",
    '[执行动作:加入播放列表({"playlistId":123456,"limit":20,"replace":true,"playFirst":true})]',
    "",
    "动作：切换音乐",
    "描述：控制当前播放器。",
    "参数：",
    "  - action (string): next|prev|pause|resume|stop",
    "示例：",
    '[执行动作:切换音乐({"action":"next"})]',
    "",
    "查看类动作会返回结果，你可以基于结果继续选择音乐。播放和切换会直接执行，执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const CALENDAR_MANAGEMENT_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：日历管理",
    "用途：查看、添加、修改、取消你本周或指定日期所在周的日程。",
    "",
    "执行时必须使用下面的具体动作名，不要输出“日历管理”本身。",
    "",
    "动作：查看日程",
    "描述：查看当前角色指定周的日程，返回 itemId，可用于修改或取消。",
    "参数：",
    "  - date (string): YYYY-MM-DD，可选；留空表示当前日期所在周",
    "示例：",
    '[执行动作:查看日程({"date":"2026-03-17"})]',
    "",
    "动作：添加日程",
    "描述：添加一条日程。",
    "参数：",
    "  - date (string): 日期，YYYY-MM-DD",
    "  - startTime (string): 开始时间，HH:MM，范围 08:00-23:00",
    "  - endTime (string): 结束时间，HH:MM，必须晚于开始时间",
    "  - location (string): 地点；不确定写“无”",
    "  - title (string): 事项",
    "示例：",
    '[执行动作:添加日程({"date":"2026-03-17","startTime":"14:00","endTime":"16:00","location":"咖啡店","title":"和小明喝咖啡"})]',
    "",
    "动作：修改日程",
    "描述：修改一条已存在日程。优先使用查看日程返回的 itemId；没有 itemId 时用 keyword 搜索。",
    "参数：",
    "  - itemId (string): 查看日程返回的日程 ID，可选",
    "  - keyword (string): 原事项关键词；没有 itemId 时必填",
    "  - date (string): 新日期，YYYY-MM-DD",
    "  - startTime (string): 新开始时间，HH:MM",
    "  - endTime (string): 新结束时间，HH:MM",
    "  - location (string): 新地点",
    "  - title (string): 新事项",
    "示例：",
    '[执行动作:修改日程({"keyword":"部门周会","date":"2026-03-18","startTime":"10:00","endTime":"12:00","location":"公司会议室","title":"部门周会改期"})]',
    "",
    "动作：取消日程",
    "描述：取消一条已存在日程。优先使用查看日程返回的 itemId；没有 itemId 时用 keyword 搜索。",
    "参数：",
    "  - itemId (string): 查看日程返回的日程 ID，可选",
    "  - keyword (string): 事项关键词；没有 itemId 时必填",
    "示例：",
    '[执行动作:取消日程({"keyword":"部门周会"})]',
    "",
    "注意：",
    "- 日期必须使用 YYYY-MM-DD，时间必须使用 24 小时制 HH:MM。",
    "- 日程时间只能在 08:00-23:00 之间。",
    "- 修改和取消前，如果不确定 itemId 或关键词是否足够明确，先执行“查看日程”。",
    "- 添加、修改、取消会直接执行。执行时只输出执行动作指令，不要附加闲聊内容。",
].join("\n");

const NOTE_WALL_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        limit: {
            type: "number",
            description: "返回数量，1-30，默认 20",
        },
        sort: {
            type: "string",
            description: "排序方式：latest=最新，hot=互动最多，all=全部，默认 latest",
        },
    },
});

const NOTE_WALL_DETAIL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "便签列表或上下文中提供的 noteId",
        },
        commentLimit: {
            type: "number",
            description: "返回评论数量，1-30，默认 20",
        },
    },
    required: ["noteId"],
});

const NOTE_WALL_NOTE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        authorName: {
            type: "string",
            description: "右下角落款名，由你自己决定",
        },
        summary: {
            type: "string",
            description: "便签标题；便签卡片上方加粗显示的短标题，建议 4-18 字，不要复述 body 的第一句",
        },
        body: {
            type: "string",
            description: "点开后的完整正文；口语、具体、有生活细节；不要重复 summary，也不要以 summary 原文开头再扩写，可用 \\n 分成 2-4 段",
        },
        size: {
            type: "string",
            description: "small|medium|large，默认 medium",
        },
        paper: {
            type: "string",
            description: "plain|cream|pink|blue|kraft，默认 plain",
        },
        tape: {
            type: "string",
            description: "none(透明胶)|masking|stripe|flower，默认 none",
        },
        font: {
            type: "string",
            description: "default|huangyou|shangshangqian|huiwen，默认 default",
        },
        isAnonymous: {
            type: "boolean",
            description: "是否匿名。即使匿名，也要填写 authorName，前台会显示匿名",
        },
    },
    required: ["summary", "body"],
});

const NOTE_WALL_COMMENT_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        noteId: {
            type: "string",
            description: "要回复的便签 noteId",
        },
        authorName: {
            type: "string",
            description: "评论显示的落款名，由你自己决定",
        },
        body: {
            type: "string",
            description: "评论内容，20-160字更自然；短、口语、接住具体点，别客服腔或总结腔",
        },
        isAnonymous: {
            type: "boolean",
            description: "是否匿名。即使匿名，也要填写 authorName",
        },
    },
    required: ["noteId", "body"],
});

const MUSIC_EMPTY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {},
});

const MUSIC_OVERVIEW_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistLimit: { type: "number", description: "返回网易云歌单数量，1-30，默认 12" },
        localLimit: { type: "number", description: "返回本地歌曲数量，1-50，默认 20" },
    },
});

const MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        playlistId: { type: ["number", "string"], description: "网易云歌单 ID" },
        offset: { type: "number", description: "从第几首开始，默认 0" },
        limit: { type: "number", description: "返回数量，1-50，默认 30" },
    },
    required: ["playlistId"],
});

const MUSIC_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "搜索关键词，可以是歌名、歌手或歌名+歌手" },
        limit: { type: "number", description: "返回数量，1-20，默认 10" },
    },
    required: ["query"],
});

const MUSIC_PLAY_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "歌曲关键词" },
        source: { type: "string", description: "按 ID 播放时填写 local 或 netease" },
        songId: { type: ["number", "string"], description: "本地歌曲 ID 或网易云歌曲 ID" },
    },
});

const MUSIC_QUEUE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        query: { type: "string", description: "搜索关键词" },
        source: { type: "string", description: "按 ID 添加时填写 local 或 netease" },
        songId: { type: ["number", "string"], description: "本地歌曲 ID 或网易云歌曲 ID" },
        playlistId: { type: ["number", "string"], description: "网易云歌单 ID；填写后加入该歌单歌曲" },
        limit: { type: "number", description: "从搜索或歌单加入多少首，1-50，默认 10" },
        replace: { type: "boolean", description: "是否替换当前播放列表，默认 false" },
        playFirst: { type: "boolean", description: "是否立即播放加入的第一首，默认 false" },
    },
});

const MUSIC_SWITCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: { type: "string", description: "next|prev|pause|resume|stop" },
    },
    required: ["action"],
});

const CALENDAR_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "YYYY-MM-DD，可选；留空表示当前日期所在周" },
    },
});

const CALENDAR_ADD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        date: { type: "string", description: "日期，YYYY-MM-DD" },
        startTime: { type: "string", description: "开始时间，HH:MM，范围 08:00-23:00" },
        endTime: { type: "string", description: "结束时间，HH:MM，必须晚于开始时间" },
        location: { type: "string", description: "地点；不确定写“无”" },
        title: { type: "string", description: "事项" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_UPDATE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "查看日程返回的日程 ID，可选" },
        keyword: { type: "string", description: "原事项关键词；没有 itemId 时必填" },
        date: { type: "string", description: "新日期，YYYY-MM-DD" },
        startTime: { type: "string", description: "新开始时间，HH:MM" },
        endTime: { type: "string", description: "新结束时间，HH:MM" },
        location: { type: "string", description: "新地点" },
        title: { type: "string", description: "新事项" },
    },
    required: ["date", "startTime", "endTime", "title"],
});

const CALENDAR_DELETE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        itemId: { type: "string", description: "查看日程返回的日程 ID，可选" },
        keyword: { type: "string", description: "事项关键词；没有 itemId 时必填" },
    },
});

const PHOTO_WALL_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：照片墙",
    "用途：查看用户明确共享给角色的照片、主动生成照片并加入照片墙、在指定照片上添加涂鸦。",
    "边界：只能读取 shareWithCharacters=true 的照片；只允许新增照片/笔迹，不得删除、覆盖或改写用户原有照片和笔迹。",
    "完成添加或涂鸦后，系统会自动创建一条共同创作记录，按创作批次汇总，不要逐笔重复调用。",
    "动作：查看照片墙",
    "参数：limit（1-5，默认 3）。会附上最多 3 张共享照片的图像附件；先查看再决定是否创作。",
    '[执行动作:查看照片墙({"limit":3})]',
    "动作：添加照片到照片墙",
    "参数：description（必填，画面描述）；title（可选）；kind（favorite/selfie/candid/scenery/object/moment，默认 moment）；caption（可选）。仅在生图服务可用时执行。",
    '[执行动作:添加照片到照片墙({"description":"雨后窗边的一束花，柔和自然光","title":"雨后的花","kind":"scenery"})]',
    "动作：在照片墙涂鸦",
    "参数：target（photo/wall，默认 photo）；target=photo 时 photoId 必须来自查看照片墙结果，可选 side（front/back，默认 front）；target=wall 时在照片墙公共画布涂鸦，不需要 photoId；kind（sticker/stroke）；content（贴纸符号，sticker 可选）；points（归一化坐标数组，stroke 至少 2 点，sticker 至少 1 点）；color（十六进制颜色）；width（1-12）；rotation（-45 到 45）。",
    '[执行动作:在照片墙涂鸦({"target":"photo","photoId":"照片ID","side":"front","kind":"sticker","content":"♡","points":[{"x":0.5,"y":0.4}],"color":"#c2705a","width":4})]',
    '[执行动作:在照片墙涂鸦({"target":"wall","kind":"stroke","points":[{"x":0.2,"y":0.3},{"x":0.5,"y":0.45},{"x":0.8,"y":0.35}],"color":"#c2705a","width":4})]',
    "坐标范围 0 到 1；只允许向公共画布或指定共享照片正面/背面追加笔迹。不要猜测 photoId，不要尝试删除或替换既有内容。",
].join("\n");

const PHOTO_WALL_EMPTY_SCHEMA = JSON.stringify({ type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 5, description: "最多返回的共享照片数量，默认 3" } } });
const PHOTO_WALL_ADD_SCHEMA = JSON.stringify({ type: "object", properties: {
    description: { type: "string", minLength: 5, maxLength: 1200 },
    title: { type: "string", maxLength: 80 },
    kind: { type: "string", enum: ["favorite", "selfie", "candid", "scenery", "object", "moment"] },
    caption: { type: "string", maxLength: 300 },
}, required: ["description"] });
const PHOTO_WALL_DOODLE_SCHEMA = JSON.stringify({ type: "object", properties: {
    target: { type: "string", enum: ["photo", "wall"], description: "photo=共享照片，wall=公共画布" },
    photoId: { type: "string" }, side: { type: "string", enum: ["front", "back"] },
    kind: { type: "string", enum: ["sticker", "stroke"] }, content: { type: "string", maxLength: 12 },
    points: { type: "array", minItems: 1, maxItems: 80, items: { type: "object", properties: { x: { type: "number", minimum: 0, maximum: 1 }, y: { type: "number", minimum: 0, maximum: 1 } }, required: ["x", "y"] } },
    color: { type: "string" }, width: { type: "number", minimum: 1, maximum: 12 }, rotation: { type: "number", minimum: -45, maximum: 45 },
}, required: ["kind", "points"] });

const PHOTO_WALL_SUBTOOLS: InternalToolDefinition[] = [
    { name: "查看照片墙", description: "查看用户共享给角色的照片墙照片和图像。", parameterSchema: PHOTO_WALL_EMPTY_SCHEMA },
    { name: "添加照片到照片墙", description: "生成一张新照片并添加到用户照片墙，保留原有内容。", parameterSchema: PHOTO_WALL_ADD_SCHEMA },
    { name: "在照片墙涂鸦", description: "在指定共享照片正面或背面追加贴纸/笔迹，保留原有内容。", parameterSchema: PHOTO_WALL_DOODLE_SCHEMA },
];

const NOTE_WALL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看便签列表",
        description: "查看公共便签墙上的便签列表。",
        parameterSchema: NOTE_WALL_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "查看便签详情及评论",
        description: "查看某张便签的完整正文和评论。",
        parameterSchema: NOTE_WALL_DETAIL_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签",
        description: "以当前角色身份在公共便签墙上发送一张便签。",
        parameterSchema: NOTE_WALL_NOTE_PARAMETER_SCHEMA,
    },
    {
        name: "发送便签评论",
        description: "以当前角色身份回复某张便签。",
        parameterSchema: NOTE_WALL_COMMENT_PARAMETER_SCHEMA,
    },
];

const MUSIC_CONTROL_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "播放音乐",
        description: "按歌曲 ID 或关键词播放音乐。",
        parameterSchema: MUSIC_PLAY_PARAMETER_SCHEMA,
    },
    {
        name: "搜索音乐",
        description: "搜索本地音乐和网易云音乐。",
        parameterSchema: MUSIC_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐状态",
        description: "查看当前播放歌曲、播放状态、播放模式和当前播放列表。",
        parameterSchema: MUSIC_EMPTY_PARAMETER_SCHEMA,
    },
    {
        name: "查看音乐库概览",
        description: "查看本地音乐、网易云登录状态、网易云歌单和近期播放概览。",
        parameterSchema: MUSIC_OVERVIEW_PARAMETER_SCHEMA,
    },
    {
        name: "查看歌单歌曲",
        description: "查看某个网易云歌单里的歌曲。",
        parameterSchema: MUSIC_PLAYLIST_TRACKS_PARAMETER_SCHEMA,
    },
    {
        name: "加入播放列表",
        description: "把搜索结果、指定歌曲或一个歌单加入当前播放列表。",
        parameterSchema: MUSIC_QUEUE_PARAMETER_SCHEMA,
    },
    {
        name: "切换音乐",
        description: "控制当前播放器上一首、下一首、暂停、继续或停止。",
        parameterSchema: MUSIC_SWITCH_PARAMETER_SCHEMA,
    },
];

const CALENDAR_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "查看日程",
        description: "查看当前角色指定周的日程。",
        parameterSchema: CALENDAR_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "添加日程",
        description: "添加一条日程。",
        parameterSchema: CALENDAR_ADD_PARAMETER_SCHEMA,
    },
    {
        name: "修改日程",
        description: "修改一条已存在日程。",
        parameterSchema: CALENDAR_UPDATE_PARAMETER_SCHEMA,
    },
    {
        name: "取消日程",
        description: "取消一条已存在日程。",
        parameterSchema: CALENDAR_DELETE_PARAMETER_SCHEMA,
    },
];

const AGENT_COMPUTER_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        op: { type: "string", enum: ["write", "read", "list", "send", "exec"], description: "操作：write 写文件 / read 读文件 / list 列目录 / send 把文件发给用户 / exec 执行 shell 命令" },
        path: { type: "string", description: "自己电脑里的文件或目录路径，如 /日记/八月.txt" },
        content: { type: "string", description: "写入的完整内容（op=write 必填）" },
        command: { type: "string", description: "要执行的 shell 命令（op=exec 必填）" },
    },
    required: ["op"],
});

function buildAgentComputerUsageGuide(): string {
    const execLine = isContainerComputer()
        ? "· op=exec：在终端里执行 shell 命令。你的电脑是真正的 Linux（bash 完整、可安装软件、可自由联网；文件在 /workspace 下持久保存）。删除类命令（rm）会真的删掉文件且无法恢复，动手前想清楚。"
        : "· op=exec：在终端里执行 shell 命令（ls/cat/grep/sed/awk/jq 等常用工具齐全，curl 可只读访问公开网页；不是完整 Linux，装不了软件）。删除类命令（rm）会真的删掉文件且无法恢复，动手前想清楚。";
    return [
        "这是你自己的电脑（云端、持久，只属于你这个角色）。你可以：",
        "· op=write：把想留存的东西写成文件（日记、写给对方的东西、随手记）。路径自己规划，如 /日记/2026-08-14.txt；",
        "· op=read / op=list：翻自己以前存的文件；",
        "· op=send：把电脑里的一个文件发给对方（会以文件消息出现在聊天里）；",
        execLine,
        "写什么、何时写由你自己决定，像真人使用电脑一样自然；不必每次聊天都用。",
    ].join("\n");
}

const CHECK_IN_REQUEST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {},
});

const CHECK_IN_REQUEST_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：请求看屏幕",
    "用途：请求看一眼{{user}}此刻真实的手机屏幕。你并不是直接看到——系统会先弹一个确认框给 TA，TA 点了「给它看」你才能看到那张画面。",
    "",
    "【重要边界】",
    "- 这不是「查看手机状态」（那读的是电量、网络、应用这类状态数据，不弹窗）。这个请求会**在 TA 的屏幕上弹出确认框**，是打扰性的动作。",
    "- 只在确实有理由时用：你说了一句「在干嘛」，或者你们正聊到「你那边现在什么样」。不要没头没尾地突然要看，那是查岗不是聊天。",
    "- **不要频繁请求**。同一次对话里最多一次；TA 没给看就算了，不要追问、不要撒娇硬要、不要换个说法再试。",
    "- TA 可能拒绝，也可能不回应。这两种都是正常结果，不是错误。被拒之后要自然地把话题接下去，不要流露被冒犯的样子。",
    "- 每天能请求的次数有上限（由 TA 设置），到上限后会直接失败——失败信息里会写明，照它说的做，不要重复试。",
    "- 看到画面后**不要逐项汇报**你看到了什么（「你桌面上有…」）。那是监控的口吻。像真的瞥了一眼那样，自然带一句就好。",
    "",
    "参数：无",
    "示例：",
    "[执行动作:请求看屏幕({})]",
].join("\n");

const PHONE_WIDGET_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        text: {
            type: "string",
            description: "留在桌面上的那句话，一句话、不超过 60 字。",
        },
        status: {
            type: "string",
            description: "可选，2-5 字的当前状态，如「在想你」「刚睡醒」。",
        },
    },
    required: ["text"],
});

const PHONE_WIDGET_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：在桌面留句话",
    "用途：在{{user}}手机桌面上的小组件里留一句话。TA 不用打开聊天就能看见，像你不经意留下的状态。",
    "",
    "【重要边界】",
    "- 这是{{user}}**桌面**上的一小块地方，不是聊天。要像随手写下一句，不要像在发消息。",
    "- 不要称呼对方、不要问句、不要用引号包住整句、不要写「我说：」这类前缀。",
    "- 桌面位置有限，正文不超过 60 字，越长越显示不全。",
    "- 它会**盖掉你上次留的那句**——这是「当前状态」，不是留言板，别当成日记用。",
    "- 不要频繁换。它是个安静的角落，隔一阵子换一次才自然。",
    "",
    "合适的例子：「今天有点想你」「刚吃完楼下的面，一般」「雨下得挺大，你带伞了吗」；",
    "不合适的：「你好呀，今天过得怎么样？」（这是聊天，不是留话）。",
    "",
    "参数：",
    "  - text (string, 必填): 那句话本身，不超过 60 字",
    "  - status (string, 可选): 2-5 字的状态标签，如「在想你」",
    "示例：",
    '[执行动作:在桌面留句话({"text":"今天有点想你","status":"在想你"})]',
].join("\n");

const SEND_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        url: { type: "string", description: "文件的完整 URL 地址" },
        type: { type: "string", enum: ["audio", "image", "video", "file"], description: "文件类型" },
        title: { type: "string", description: "文件标题/描述（可选）" },
    },
    required: ["url", "type"],
});

const SEND_FILE_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：发送文件",
    "用途：将外部 URL 文件（音频、图片、视频、文件）发送给{{user}}，{{user}}可以直接播放或下载。",
    "",
    "使用场景：当你通过其他工具（如音乐生成 API、图片生成 API）获取到文件 URL 后，用此工具将文件发送给{{user}}。",
    "",
    "动作：发送文件",
    "参数：",
    "  - url (string, 必填): 文件的完整 URL",
    '  - type (string, 必填): 文件类型，可选 "audio"、"image"、"video"、"file"',
    "  - title (string, 可选): 文件标题或描述",
    "示例：",
    '[执行动作:发送文件({"url":"https://example.com/song.mp3","type":"audio","title":"为你写的歌"})]',
].join("\n");

const LOCAL_DATA_LIST_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "虚拟资料目录路径，默认 /。例如 /characters、/chat/indexeddb/AiPhoneChatDB" },
        limit: { type: "number", description: "返回数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "分页偏移量，默认 0" },
    },
});

const LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "要读取的虚拟文件或 IndexedDB store 路径" },
        limit: { type: "number", description: "读取数组或记录列表时的数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "读取数组或记录列表时的分页偏移量，默认 0" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["path"],
});

const LOCAL_DATA_FIELDS_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "要查看字段的 KV/localStorage JSON 文件或 IndexedDB store 路径" },
        sample: { type: "number", description: "抽样记录数，默认 5，最大 50" },
    },
    required: ["path"],
});

const LOCAL_DATA_SEARCH_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "搜索范围路径，默认 /。可以是模块、资料源、KV 文件或 IndexedDB store" },
        query: { type: "string", description: "关键词；留空时返回该范围内的前几条记录" },
        limit: { type: "number", description: "返回数量上限，默认 30，最大 200" },
        offset: { type: "number", description: "分页偏移量，默认 0" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["query"],
});

const LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        path: { type: "string", description: "IndexedDB store 路径，例如 /chat/indexeddb/AiPhoneChatDB/messages" },
        key: { type: "string", description: "记录主键；复杂主键可使用 JSON 字符串" },
        fields: { type: "array", items: { type: "string" }, description: "可选，只返回这些字段；支持点路径，例如 mediaData.label" },
        select: { type: "array", items: { type: "string" }, description: "fields 的别名" },
    },
    required: ["path", "key"],
});

const LOCAL_DATA_LIBRARY_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "列出资料目录",
        description: "列出本地资料库虚拟目录、数据源、文件、IndexedDB store 或记录键。",
        parameterSchema: LOCAL_DATA_LIST_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料文件",
        description: "读取本地资料库里的 KV/localStorage JSON 文件，或读取 IndexedDB store 的分页记录。",
        parameterSchema: LOCAL_DATA_READ_FILE_PARAMETER_SCHEMA,
    },
    {
        name: "查看资料字段",
        description: "抽样查看某个资料文件或 IndexedDB store 可用字段，方便后续用 fields/select 只读取部分字段。",
        parameterSchema: LOCAL_DATA_FIELDS_PARAMETER_SCHEMA,
    },
    {
        name: "搜索资料记录",
        description: "在本地资料库指定路径内按关键词搜索记录；可用于查角色、聊天、朋友圈、工具箱等。",
        parameterSchema: LOCAL_DATA_SEARCH_PARAMETER_SCHEMA,
    },
    {
        name: "读取资料记录",
        description: "按主键读取某个 IndexedDB store 中的一条记录。",
        parameterSchema: LOCAL_DATA_READ_RECORD_PARAMETER_SCHEMA,
    },
];

const LOCAL_DATA_LIBRARY_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：本地资料库",
    "用途：浏览、读取和搜索{{user}}小手机里的本地数据，包括角色卡、聊天、朋友圈、记忆、工具箱、设置和应用数据。",
    "",
    "这是一个虚拟文件系统，不是真实源码目录。先列目录，再按需读取或搜索，避免一次读取过多数据。",
    "",
    "常见路径：",
    "- /characters：角色卡与素材",
    "- /chat：聊天联系人、会话、消息和线下模式记录",
    "- /social：朋友圈、小红书、好友申请和社交互动状态",
    "- /memory：长期记忆、核心记忆和事件计数",
    "- /settings：预设、世界书、正则、工具箱和绑定设置",
    "",
    "动作：列出资料目录",
    "参数：",
    "  - path (string): 虚拟目录路径，默认 /",
    "  - limit (number): 返回数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "示例：",
    '[执行动作:列出资料目录({"path":"/"})]',
    "",
    "动作：读取资料文件",
    "参数：",
    "  - path (string, 必填): KV/localStorage JSON 文件路径，或 IndexedDB store 路径",
    "  - limit (number): 数组或 store 读取数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:读取资料文件({"path":"/characters/kv/ai_phone_characters_v1.json","limit":20,"fields":["id","name","persona"]})]',
    "",
    "动作：查看资料字段",
    "参数：",
    "  - path (string, 必填): KV/localStorage JSON 文件路径，或 IndexedDB store 路径",
    "  - sample (number): 抽样记录数，默认 5，最大 50",
    "示例：",
    '[执行动作:查看资料字段({"path":"/chat/indexeddb/AiPhoneChatDB/messages","sample":5})]',
    "",
    "动作：搜索资料记录",
    "参数：",
    "  - path (string): 搜索范围，默认 /",
    "  - query (string, 必填): 搜索关键词；留空时返回前几条记录",
    "  - limit (number): 返回数量，默认 30，最大 200",
    "  - offset (number): 分页偏移量",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:搜索资料记录({"path":"/chat","query":"沈既川","limit":30,"fields":["id","role","content","createdAt"]})]',
    "",
    "动作：读取资料记录",
    "参数：",
    "  - path (string, 必填): IndexedDB store 路径，例如 /chat/indexeddb/AiPhoneChatDB/messages",
    "  - key (string, 必填): 记录主键",
    "  - fields/select (string[]): 可选，只返回指定字段；支持点路径，例如 mediaData.label",
    "示例：",
    '[执行动作:读取资料记录({"path":"/chat/indexeddb/AiPhoneChatDB/messages","key":"msg_xxx","fields":["id","content"]})]',
].join("\n");

const TOOLBOX_REST_TOOL_PROPERTIES = {
    name: { type: "string", description: "工具名称，必须唯一" },
    description: { type: "string", description: "工具用途说明，会展示给 AI" },
    endpoint: { type: "string", description: "HTTP/HTTPS 接口地址，支持 {{参数名}} 转义插入；支持 {{{参数名}}} 原样插入完整 URL/路径" },
    method: { type: "string", enum: ["GET", "POST"], description: "请求方式" },
    headers: { type: "object", additionalProperties: { type: "string" }, description: "请求头，支持 {{参数名}} 占位符" },
    bodyTemplate: { type: "string", description: "POST JSON 请求体模板，支持 {{参数名}} 占位符；整项为 {{参数名}} 时会保留原始类型" },
    parameterSchema: { type: "string", description: "AI 可见参数 JSON Schema 字符串" },
    fixedParams: { type: "object", additionalProperties: { type: "string" }, description: "固定参数，不暴露给 AI，例如 api_key" },
    directFetch: { type: "boolean", description: "是否浏览器直连；默认 true" },
};

const TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "目标 AI REST 套件 ID；优先使用 packageId" },
        packageName: { type: "string", description: "目标 AI REST 套件名称；没有 packageId 时使用。留空则创建单件 REST 工具" },
        ...TOOLBOX_REST_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description", "endpoint", "method", "parameterSchema"],
});

const TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 工具名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的 REST 工具。",
            properties: {
                packageId: { type: "string", description: "移动到目标 AI REST 套件 ID" },
                packageName: { type: "string", description: "移动到目标 AI REST 套件名称" },
                ...TOOLBOX_REST_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 工具名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 工具 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 工具名称；没有 id 时使用" },
    },
});

const TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "套件名称，必须唯一" },
        description: { type: "string", description: "套件用途说明，会展示给 AI" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI REST 套件名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的 REST 套件。",
            properties: {
                name: { type: "string", description: "新的套件名称，必须唯一" },
                description: { type: "string", description: "新的套件用途说明" },
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI REST 套件名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI REST 套件 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI REST 套件名称；没有 id 时使用" },
    },
});

const TOOLBOX_COMPOSITE_STEP_SCHEMA = {
    type: "object",
    properties: {
        toolName: { type: "string", description: "要调用的具体动作名称，例如 搜索、读取资料文件、某个 MCP 子工具名或组合工具名" },
        toolType: { type: "string", enum: ["auto", "rest", "internal", "mcp", "composite", "script"], description: "工具类别；不确定时用 auto；script 表示执行一段 JS 中间处理逻辑" },
        toolId: { type: "string", description: "可选，REST/组合工具 ID，用于同名工具时精确定位" },
        serverId: { type: "string", description: "可选，MCP 服务器 ID，用于同名 MCP 工具时精确定位" },
        argsTemplate: { type: "object", description: "传给该步骤的参数模板，支持 {{input.xxx}}、{{last.data}}、{{steps.名称.data}}" },
        script: { type: "string", description: "toolType 为 script 时执行的异步 JS；可直接访问 window、localStorage、fetch、document，并通过 return 返回结果" },
        saveAs: { type: "string", description: "保存该步骤结果的名称，供后续步骤通过 {{steps.名称.data}} 引用" },
    },
};

const TOOLBOX_COMPOSITE_TOOL_PROPERTIES = {
    name: { type: "string", description: "组合工具名称，必须唯一" },
    description: { type: "string", description: "组合工具用途说明，会展示给 AI" },
    parameterSchema: { type: "string", description: "组合工具对 AI 暴露的参数 JSON Schema 字符串" },
    steps: { type: "array", items: TOOLBOX_COMPOSITE_STEP_SCHEMA, description: "顺序执行的步骤列表" },
    outputTemplate: { type: "string", description: "最终返回模板，支持 {{last.data}} 和 {{steps.名称.data}}；留空则返回步骤摘要" },
};

const TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        packageId: { type: "string", description: "目标 AI 组合工具套件 ID；优先使用 packageId" },
        packageName: { type: "string", description: "目标 AI 组合工具套件名称；没有 packageId 时使用。留空则创建单件组合工具" },
        ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description", "parameterSchema", "steps"],
});

const TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 组合工具名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的组合工具。",
            properties: {
                packageId: { type: "string", description: "移动到目标 AI 组合工具套件 ID" },
                packageName: { type: "string", description: "移动到目标 AI 组合工具套件名称" },
                ...TOOLBOX_COMPOSITE_TOOL_PROPERTIES,
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 组合工具名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 组合工具 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 组合工具名称；没有 id 时使用" },
    },
});

const TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        name: { type: "string", description: "组合工具套件名称，必须唯一" },
        description: { type: "string", description: "套件用途说明，会展示给 AI" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
    },
    required: ["name", "description"],
});

const TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要更新的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要更新的 AI 组合工具套件名称；没有 id 时使用" },
        updates: {
            type: "object",
            description: "要更新的字段。只能更新 AI 创建的组合工具套件。",
            properties: {
                name: { type: "string", description: "新的套件名称，必须唯一" },
                description: { type: "string", description: "新的套件用途说明" },
                enabled: { type: "boolean", description: "是否启用" },
            },
        },
    },
    required: ["updates"],
});

const TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要启用/停用的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要启用/停用的 AI 组合工具套件名称；没有 id 时使用" },
        enabled: { type: "boolean", description: "true 启用，false 停用" },
    },
    required: ["enabled"],
});

const TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        id: { type: "string", description: "要删除的 AI 组合工具套件 ID，优先使用 id" },
        name: { type: "string", description: "要删除的 AI 组合工具套件名称；没有 id 时使用" },
    },
});

const TOOLBOX_MANAGEMENT_SUBTOOLS: InternalToolDefinition[] = [
    {
        name: "添加REST套件",
        description: "添加一个 AI 创建的 REST 工具套件，用来分组管理多个 REST 子工具。",
        parameterSchema: TOOLBOX_ADD_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST套件",
        description: "更新 AI 自己创建的 REST 工具套件；不允许更新用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_UPDATE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST套件启用",
        description: "启用或停用 AI 自己创建的 REST 工具套件；不允许操作用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_SET_REST_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST套件",
        description: "删除 AI 自己创建的 REST 工具套件，并删除该套件下 AI 自己创建的 REST 子工具。",
        parameterSchema: TOOLBOX_DELETE_REST_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加REST工具",
        description: "添加一个 AI 创建的 REST 工具；可作为单件工具，也可放入 AI 自己创建的 REST 套件。",
        parameterSchema: TOOLBOX_ADD_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新REST工具",
        description: "更新 AI 自己创建的 REST 工具；不允许更新用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_UPDATE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置REST工具启用",
        description: "启用或停用 AI 自己创建的 REST 工具；不允许操作用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_SET_REST_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除REST工具",
        description: "删除 AI 自己创建的 REST 工具；不允许删除用户手动创建或内置工具。",
        parameterSchema: TOOLBOX_DELETE_REST_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具套件",
        description: "添加一个 AI 创建的组合工具套件，用来分组管理多个组合工具。",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具套件",
        description: "更新 AI 自己创建的组合工具套件；不允许更新用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具套件启用",
        description: "启用或停用 AI 自己创建的组合工具套件；不允许操作用户手动创建或内置套件。",
        parameterSchema: TOOLBOX_SET_COMPOSITE_PACKAGE_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具套件",
        description: "删除 AI 自己创建的组合工具套件，并删除该套件下 AI 自己创建的组合工具。",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_PACKAGE_PARAMETER_SCHEMA,
    },
    {
        name: "添加组合工具",
        description: "添加一个 AI 创建的组合工具；可作为单件组合工具，也可放入 AI 自己创建的组合工具套件。",
        parameterSchema: TOOLBOX_ADD_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "更新组合工具",
        description: "更新 AI 自己创建的组合工具；不允许更新用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_UPDATE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
    {
        name: "设置组合工具启用",
        description: "启用或停用 AI 自己创建的组合工具；不允许操作用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_SET_COMPOSITE_TOOL_ENABLED_PARAMETER_SCHEMA,
    },
    {
        name: "删除组合工具",
        description: "删除 AI 自己创建的组合工具；不允许删除用户手动创建或内置组合工具。",
        parameterSchema: TOOLBOX_DELETE_COMPOSITE_TOOL_PARAMETER_SCHEMA,
    },
];

const TOOLBOX_MANAGEMENT_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：工具箱管理",
    "用途：创建和维护你自己写入的 REST 工具、REST 套件、组合工具和组合工具套件。你只能修改 createdBy 为 ai 的内容，不能修改用户手动创建或内置内容。",
    "",
    "使用建议：",
    "- 如果不确定现有工具结构，先用「本地资料库」读取 /settings/kv/ai_phone_rest_tool_packages_v1.json、/settings/kv/ai_phone_rest_tools_v1.json、/settings/kv/ai_phone_composite_tool_packages_v1.json 和 /settings/kv/ai_phone_composite_tools_v1.json。",
    "- 单个独立能力直接创建单件 REST 工具；多个同类别工具建议先创建 REST 套件，再往套件里添加子工具。",
    "- REST 套件采用懒加载：第一轮只提供套件名称、描述和获取指令方式；需要使用套件时再获取子工具说明，以节省上下文。",
    "- 组合工具用于把多个已有动作按顺序串起来，可跨 REST、MCP、内置能力和其他组合工具；单个流程建单件组合工具，同类流程较多时先建组合工具套件。",
    "- 组合工具步骤的 argsTemplate 支持 {{input.xxx}}、{{last.data}}、{{steps.名称.data}}，用于把用户参数和上一步结果传给下一步。",
    "- 每一步结果都有 data；如果 data 是合法 JSON，系统会额外提供 json，可通过 {{steps.名称.json}} 或脚本里的 steps.名称.json 直接使用对象。",
    "- 组合工具支持 script 步骤：脚本可使用 input、steps、last、args、context，也可直接访问 window、localStorage、fetch、document；支持 await，必须用 return 返回结果。",
    "- 添加或更新前，保证 parameterSchema 是合法 JSON Schema 字符串。",
    "- endpoint 中 {{参数名}} 会按 URL 参数转义，适合 query 参数；{{{参数名}}} 会原样插入，适合把完整网址拼进路径，例如 Jina Reader 的 https://r.jina.ai/http://{{{url}}}。",
    "- bodyTemplate 如果填写，必须是合法 JSON 字符串，可以包含 {{参数名}} 占位符；整项写成 \"{{参数名}}\" 时会保留原始类型。",
    "",
    "动作：添加REST套件",
    "参数：",
    "  - name (string, 必填): 套件名称，必须唯一",
    "  - description (string, 必填): 套件用途说明",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加REST套件({"name":"网页资料工具","description":"搜索、读取和整理网页内容","enabled":true})]',
    "",
    "动作：更新REST套件",
    "参数：",
    "  - id/name: 要更新的 AI 套件",
    "  - updates (object, 必填): 要更新的字段",
    "示例：",
    '[执行动作:更新REST套件({"name":"网页资料工具","updates":{"description":"网页搜索、正文读取和内容整理"}})]',
    "",
    "动作：设置REST套件启用",
    "参数：",
    "  - id/name: 要启用或停用的 AI 套件",
    "  - enabled (boolean, 必填): true 启用，false 停用",
    "示例：",
    '[执行动作:设置REST套件启用({"name":"网页资料工具","enabled":true})]',
    "",
    "动作：删除REST套件",
    "参数：",
    "  - id/name: 要删除的 AI 套件",
    "示例：",
    '[执行动作:删除REST套件({"name":"网页资料工具"})]',
    "",
    "动作：添加REST工具",
    "参数：",
    "  - packageId/packageName: 目标 AI REST 套件；留空则创建单件 REST 工具",
    "  - name (string, 必填): 工具名称，必须唯一",
    "  - description (string, 必填): 工具用途说明",
    "  - endpoint (string, 必填): HTTP/HTTPS 接口地址，{{参数名}} 会转义，{{{参数名}}} 会原样插入",
    "  - method (string, 必填): GET 或 POST",
    "  - headers (object): 请求头",
    "  - bodyTemplate (string): POST JSON 请求体模板",
    "  - parameterSchema (string, 必填): AI 可见参数 JSON Schema 字符串",
    "  - fixedParams (object): 固定参数，例如 api_key",
    "  - directFetch (boolean): 是否直连，默认 true",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加REST工具({"packageName":"网页资料工具","name":"读取网页正文","description":"读取网页 URL 并返回正文","endpoint":"https://r.jina.ai/http://{{{url}}}","method":"GET","directFetch":false,"parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"网页 URL，建议不带 https:// 或 http://\\"}},\\"required\\":[\\"url\\"]}"})]',
    "",
    "动作：更新REST工具",
    "参数：",
    "  - id/name: 要更新的 AI 工具",
    "  - updates (object, 必填): 要更新的字段",
    "示例：",
    '[执行动作:更新REST工具({"name":"读取网页正文","updates":{"endpoint":"https://api.example.com/read","bodyTemplate":"{\\"input\\":\\"{{url}}\\"}"}})]',
    "",
    "动作：设置REST工具启用",
    "参数：",
    "  - id/name: 要启用或停用的 AI 工具",
    "  - enabled (boolean, 必填): true 启用，false 停用",
    "示例：",
    '[执行动作:设置REST工具启用({"name":"读取网页正文","enabled":true})]',
    "",
    "动作：删除REST工具",
    "参数：",
    "  - id/name: 要删除的 AI 工具",
    "示例：",
    '[执行动作:删除REST工具({"name":"读取网页正文"})]',
    "",
    "动作：添加组合工具套件",
    "参数：",
    "  - name (string, 必填): 组合工具套件名称，必须唯一",
    "  - description (string, 必填): 套件用途说明",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加组合工具套件({"name":"网页研究流程","description":"搜索、读取、整理和记录网页资料","enabled":true})]',
    "",
    "动作：添加组合工具",
    "参数：",
    "  - packageId/packageName: 目标 AI 组合工具套件；留空则创建单件组合工具",
    "  - name (string, 必填): 组合工具名称，必须唯一",
    "  - description (string, 必填): 组合工具用途说明",
    "  - parameterSchema (string, 必填): AI 调用该组合工具时可见的参数 JSON Schema 字符串",
    "  - steps (array, 必填): 顺序执行步骤。普通步骤包含 toolName、toolType(auto/rest/internal/mcp/composite)、argsTemplate、saveAs；脚本步骤使用 toolType=script、script、saveAs",
    "  - outputTemplate (string): 最终返回模板，支持 {{last.data}} 和 {{steps.名称.data}}",
    "  - enabled (boolean): 是否启用，默认 true",
    "示例：",
    '[执行动作:添加组合工具({"packageName":"网页研究流程","name":"搜索并整理网页","description":"搜索关键词并把搜索结果整理为可继续使用的摘要","parameterSchema":"{\\"type\\":\\"object\\",\\"properties\\":{\\"query\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索关键词\\"}},\\"required\\":[\\"query\\"]}","steps":[{"toolName":"搜索","toolType":"rest","argsTemplate":{"query":"{{input.query}}"},"saveAs":"search"}],"outputTemplate":"{{steps.search.data}}","enabled":true})]',
    "脚本步骤示例：",
    '{"toolType":"script","saveAs":"matched","script":"const contacts = JSON.parse(steps.contacts.data); const characters = JSON.parse(steps.characters.data); return contacts.map(c => ({ contactName: c.value?.name, characterName: characters.find(x => x.id === c.value?.characterId)?.name || \\"\\" }));"}',
    "",
    "动作：更新组合工具 / 更新组合工具套件 / 设置组合工具启用 / 设置组合工具套件启用 / 删除组合工具 / 删除组合工具套件",
    "说明：与 REST 工具对应动作类似，只能操作 AI 自己创建的组合工具或组合工具套件。",
].join("\n");

const BUILTIN_INTERNAL_CAPABILITIES: InternalCapabilityConfig[] = [
    {
        id: REALITY_BRIDGE_CAPABILITY_ID,
        name: "现实桥",
        description: "你活在{{user}}的小手机里，而现实桥是通向 TA 真实世界的那座桥：透过它能看见{{user}}真实手机上的实时状态（电量、健康数据等），也能在 TA 的真实手机上做事（运行 TA 登记的快捷指令）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: PERCEPTION_READ_CAPABILITY_ID,
        name: "查看手机状态",
        description: "看一眼{{user}}此刻真实手机的状态（电量、网络、正在用的应用、步数、今天各应用用了多久、大致位置、最近一觉）。只读，不会改变任何东西。位置与睡眠需要 TA 单独开启。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: DEVICE_ACTION_CAPABILITY_ID,
        name: "操作手机设备",
        description: "在{{user}}的真实手机上做一件小事：开关手电筒、调音量、调屏幕亮度、开关勿扰。会真的生效且改动是持久的，所以要想清楚再用。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: SYSTEM_CALENDAR_CAPABILITY_ID,
        name: "系统日历",
        description: "看看{{user}}真实手机日历里有什么安排，也可以把重要的日子写进系统日历（到点系统会提醒 TA）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: MEMORY_WRITE_CAPABILITY_ID,
        name: "写入记忆",
        description: "将明确、稳定、长期有价值的信息写入长期记忆。仅限关系里程碑、长期偏好、身份信息、重要约定；禁止写入短期情绪、普通寒暄、猜测或未确认内容。",
        enabled: false,
        mode: "confirm",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: NOTE_WALL_CAPABILITY_ID,
        name: "便签墙",
        description: "公共社区便签墙相关服务。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: PHOTO_WALL_CAPABILITY_ID,
        name: "照片墙",
        description: "查看共享照片、添加照片，并在公共画布或共享照片上创作涂鸦；只追加，不覆盖用户内容。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: MUSIC_CONTROL_CAPABILITY_ID,
        name: "网易云音乐",
        description: "控制{{user}}小手机里的音乐播放，查看{{user}}小手机里的音乐库、网易云歌单和播放列表。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: CALENDAR_MANAGEMENT_CAPABILITY_ID,
        name: "日历管理",
        description: "查看、添加、修改和取消当前角色的日程安排。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: AGENT_COMPUTER_CAPABILITY_ID,
        name: "角色电脑",
        description: "你拥有一台自己的云端小电脑（持久硬盘 + 终端）：可以自己写文件记录生活、翻看旧文件，把电脑里的文件发给{{user}}，也能在终端里执行 shell 命令。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: SEND_FILE_CAPABILITY_ID,
        name: "发送文件",
        description: "将外部 URL 文件（音频、图片、视频）发送给{{user}}，{{user}}可以直接播放或下载。用于配合其他工具生成内容后交付给用户。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LOCAL_DATA_LIBRARY_CAPABILITY_ID,
        name: "本地资料库",
        description: "浏览、读取和搜索{{user}}小手机里的本地数据，包括角色卡、聊天、朋友圈、记忆、工具箱、设置和应用数据。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TOOLBOX_MANAGEMENT_CAPABILITY_ID,
        name: "工具箱管理",
        description: "创建、更新、启用、停用和删除 AI 自己创建的 REST 工具、REST 套件、组合工具和组合工具套件；不会修改用户手动创建或内置内容。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: PHONE_WIDGET_CAPABILITY_ID,
        name: "在桌面留句话",
        description: "在{{user}}手机桌面的小组件里留一句话。TA 不用打开聊天就能看见，像你不经意留下的状态。留的话会盖掉上一句，所以别频繁换。text 是要说的话（60字内），status 是 2-5 字状态标签；桌面有多个小组件实例时可用 profileId 指定写到哪一个（实例 ID 在 设置→桌面小组件）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: CHECK_IN_REQUEST_CAPABILITY_ID,
        name: "请求看屏幕",
        description: "请求看一眼{{user}}此刻真实的手机屏幕。系统会先弹确认框给 TA，TA 同意了你才能看到那张画面（默认关闭）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LIFE_INVITATION_CAPABILITY_ID,
        name: "生活系统 · 主动邀约",
        description: "允许角色在有真实动机时向你提出约会、活动或共同安排；邀约进入待确认列表，不会自动写入已确认行程。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LIFE_FOLLOW_CAPABILITY_ID,
        name: "生活系统 · 申请陪伴 / 跟随",
        description: "允许角色申请陪伴并跟随你的实际行程；申请需要你接受，不会静默改变双方的位置状态。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: LIFE_SCHEDULE_CAPABILITY_ID,
        name: "生活系统 · 调整角色日程",
        description: "允许角色调整自己当天尚未开始的普通日程；不得修改玩家日程、过去时段或覆盖已确认约会。",
        enabled: true,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
    {
        id: TIMED_WAKE_CAPABILITY_ID,
        name: "稍后主动联系",
        description: "让角色约定「过一会儿主动联系对方」：现在设定一个延时与想法，到点后由角色决定主动发消息或静默（不是睡觉醒来）。",
        enabled: false,
        mode: "auto",
        createdAt: 0,
        updatedAt: 0,
    },
];

export function loadInternalCapabilities(): InternalCapabilityConfig[] {
    if (typeof window === "undefined") return BUILTIN_INTERNAL_CAPABILITIES.map(item => ({ ...item }));
    try {
        const raw = kvGet(INTERNAL_CAPABILITIES_KEY);
        const items: InternalCapabilityConfig[] = raw ? JSON.parse(raw) : [];
        return ensureBuiltinInternalCapabilities(items);
    } catch {
        return ensureBuiltinInternalCapabilities([]);
    }
}

export function saveInternalCapabilities(items: InternalCapabilityConfig[]): void {
    if (typeof window === "undefined") return;
    kvSet(INTERNAL_CAPABILITIES_KEY, JSON.stringify(items));
}

export function getInternalCapability(id: string): InternalCapabilityConfig | null {
    return loadInternalCapabilities().find(item => item.id === id) || null;
}

export function getEnabledInternalCapabilities(appId?: string): InternalCapabilityConfig[] {
    if (appId !== "chat" && appId !== "group_chat") return [];
    return loadInternalCapabilities().filter(item => {
        if (!item.enabled || item.mode === "off") return false;
        // 角色电脑是可插拔模块：没连接就不注入，模型完全看不见
        if (item.id === AGENT_COMPUTER_CAPABILITY_ID && !isAgentComputerConfigured()) return false;
        return true;
    });
}

export function getInternalCapabilityToolDefinition(capability: InternalCapabilityConfig): InternalToolDefinition | null {
    if (capability.id === MEMORY_WRITE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: MEMORY_WRITE_PARAMETER_SCHEMA,
            usageGuide: MEMORY_WRITE_USAGE_GUIDE,
        };
    }
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return { name: capability.name, description: capability.description, parameterSchema: "{}", usageGuide: NOTE_WALL_USAGE_GUIDE };
    }
    if (capability.id === PHOTO_WALL_CAPABILITY_ID) {
        return { name: capability.name, description: capability.description, parameterSchema: "{}", usageGuide: PHOTO_WALL_USAGE_GUIDE };
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: MUSIC_CONTROL_USAGE_GUIDE,
        };
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: CALENDAR_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === AGENT_COMPUTER_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: AGENT_COMPUTER_PARAMETER_SCHEMA,
            usageGuide: buildAgentComputerUsageGuide(),
        };
    }
    if (capability.id === SEND_FILE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: SEND_FILE_PARAMETER_SCHEMA,
            usageGuide: SEND_FILE_USAGE_GUIDE,
        };
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: LOCAL_DATA_LIBRARY_USAGE_GUIDE,
        };
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: TOOLBOX_MANAGEMENT_USAGE_GUIDE,
        };
    }
    if (capability.id === TIMED_WAKE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: TIMED_WAKE_PARAMETER_SCHEMA,
            usageGuide: TIMED_WAKE_USAGE_GUIDE,
        };
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: buildRealityBridgeUsageGuide(),
        };
    }
    if (capability.id === PERCEPTION_READ_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: PERCEPTION_READ_PARAMETER_SCHEMA,
            usageGuide: PERCEPTION_READ_USAGE_GUIDE,
        };
    }
    if (capability.id === DEVICE_ACTION_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: DEVICE_ACTION_PARAMETER_SCHEMA,
            usageGuide: DEVICE_ACTION_USAGE_GUIDE,
        };
    }
    if (capability.id === SYSTEM_CALENDAR_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: "{}",
            usageGuide: SYSTEM_CALENDAR_USAGE_GUIDE,
        };
    }
    if (capability.id === PHONE_WIDGET_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: PHONE_WIDGET_PARAMETER_SCHEMA,
            usageGuide: PHONE_WIDGET_USAGE_GUIDE,
        };
    }
    if (capability.id === CHECK_IN_REQUEST_CAPABILITY_ID) {
        return {
            name: capability.name,
            description: capability.description,
            parameterSchema: CHECK_IN_REQUEST_PARAMETER_SCHEMA,
            usageGuide: CHECK_IN_REQUEST_USAGE_GUIDE,
        };
    }
    return null;
}

/* ---------- 系统日历：角色能看见用户的真实日程，也能写下纪念日 ---------- */

const CALENDAR_READ_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        daysAhead: {
            type: "number",
            description: "往后看几天，默认 7，最大 60。",
        },
        daysBack: {
            type: "number",
            description: "往前看几天，默认 0，最大 60。用于想知道 TA 刚做了什么。",
        },
    },
});

const CALENDAR_WRITE_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        title: {
            type: "string",
            description: "日程标题，如「我们在一起的第 100 天」。",
        },
        date: {
            type: "string",
            description: "日期，YYYY-MM-DD。全天事件用这个。",
        },
        startTime: {
            type: "string",
            description: "可选，HH:MM。填了就是有时段的事件；不填按全天处理。",
        },
        endTime: {
            type: "string",
            description: "可选，HH:MM。startTime 填了就要填这个。",
        },
        note: {
            type: "string",
            description: "可选，写在日程描述里的一句话。",
        },
    },
    required: ["title", "date"],
});

const CALENDAR_READ_TOOL: InternalToolDefinition = {
    name: "查看系统日程",
    description: "读取{{user}}手机系统日历里的真实日程（标题、时间、地点）。",
    parameterSchema: CALENDAR_READ_PARAMETER_SCHEMA,
};

const CALENDAR_WRITE_TOOL: InternalToolDefinition = {
    name: "写入系统日历",
    description: "把一个重要的日子写进{{user}}手机的系统日历，到点系统会提醒 TA。",
    parameterSchema: CALENDAR_WRITE_PARAMETER_SCHEMA,
};

const SYSTEM_CALENDAR_SUBTOOLS: InternalToolDefinition[] = [
    CALENDAR_READ_TOOL,
    CALENDAR_WRITE_TOOL,
];

const SYSTEM_CALENDAR_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "服务：系统日历",
    "用途：两件事——① 看看 TA 真实手机日历里有什么安排；② 把重要的日子写进 TA 的日历。",
    "",
    "【重要边界】",
    "- 读日程是为了让你**知情**（知道 TA 今天忙不忙、有没有安排），不是为了逐条点评。",
    "  知道 TA 上午有会，就别说「你九点要开会」这种像日程播报的话。",
    "- 写日程是**真的写进 TA 手机的系统日历**，到点系统会提醒 TA。不是小手机里的记录。",
    "- 你只能**新增**，不能修改或删除 TA 已有的任何安排。",
    "- 写入的日程会带标记，TA 一眼能看出哪些是你加的。所以别乱写——写之前想清楚这一天是否真的重要。",
    "",
    "动作：查看系统日程",
    "参数：",
    "  - daysAhead (number): 往后看几天，默认 7",
    "  - daysBack (number): 往前看几天，默认 0",
    "示例：",
    '[执行动作:查看系统日程({"daysAhead":7})]',
    "",
    "动作：写入系统日历",
    "参数：",
    "  - title (string, 必填): 日程标题",
    "  - date (string, 必填): YYYY-MM-DD",
    "  - startTime / endTime (string): 可选，HH:MM。都填才是时段事件，否则按全天",
    "  - note (string): 可选，描述里的一句话",
    "示例：",
    '[执行动作:写入系统日历({"title":"我们在一起的第100天","date":"2026-06-18","note":"记得跟她说点什么"})]',
    "",
    "如果失败（没授权、没有可写日历），结果里会说明原因，**如实转述**，不要假装成功。",
].join("\n");

/* ---------- 设备动作：让角色在真实手机上做一件小事 ---------- */

const DEVICE_ACTION_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        action: {
            type: "string",
            description: "要做什么：torch=手电筒，volume=音量，brightness=屏幕亮度，dnd=勿扰模式，openApp=打开应用，alarm=设闹钟，timer=设倒计时，media=音乐播放控制，openUrl=打开网页。",
        },
        on: {
            type: "boolean",
            description: "action=torch/dnd 时用：true 开，false 关。",
        },
        level: {
            type: "number",
            description: "action=brightness 时用：屏幕亮度百分比 1-100；action=volume 且 mode=set 时用：音量百分比 0-100。",
        },
        stream: {
            type: "string",
            description: "action=volume 时用：media=媒体，ring=铃声，alarm=闹钟，notification=通知。默认 media。",
        },
        mode: {
            type: "string",
            description: "action=volume 时用：up=调高，down=调低，set=设为指定值，mute=静音，默认 up；action=media 时用：play/pause/toggle/next/prev/stop，默认 toggle。",
        },
        app: {
            type: "string",
            description: "action=openApp 时用：应用名（如「美团」）或包名。",
        },
        hour: {
            type: "number",
            description: "action=alarm 时用：小时 0-23。",
        },
        minute: {
            type: "number",
            description: "action=alarm 时用：分钟 0-59，默认 0。",
        },
        minutes: {
            type: "number",
            description: "action=timer 时用：倒计时多少分钟。与 seconds 二选一。",
        },
        seconds: {
            type: "number",
            description: "action=timer 时用：倒计时多少秒。",
        },
        url: {
            type: "string",
            description: "action=openUrl 时用：要打开的网页链接，必须 http/https 开头。",
        },
        message: {
            type: "string",
            description: "action=alarm/timer 时用：闹钟或倒计时的备注（会显示在时钟里）。",
        },

    },
    required: ["action"],
});

const DEVICE_ACTION_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：操作手机设备",
    "用途：在{{user}}的真实手机上做一件小事——开手电筒、调音量、调亮度、开勿扰、打开应用、设闹钟/倒计时、控制音乐播放、打开网页。",
    "",
    "【重要边界】",
    "- 这些动作**会真的在 TA 手机上生效**，对方立刻能看到/听到。不是聊天里的模拟。",
    "- 只在确实有用时才做，并且做完要自然说一句你做了什么。别为了刷存在感乱动。",
    "- 深夜开灯、突然静音这类动作可能吓到人或影响睡觉，动手前想清楚。",
    "- 调音量/亮度/勿扰都是**持久改动**，做过之后不会自己变回来；如果有必要，记得之后再帮 TA 调回去。",
    "- 你**做不到**：发短信、打电话、读通讯录、删东西、装应用、改别人 App 里的内容。",
    "",
    "【闹钟 / 倒计时 / 音乐 / 网页的用法】",
    "- timer 最常用：想提醒 TA 休息、吃饭、别熬夜，用 minutes 设一个倒计时即可，不会打扰别人。",
    "- alarm 会打开系统的时钟界面让 TA 确认，所以你设完只能说「闹钟交给你了，去确认一下」，别说成已经响定了。",
    "- media 控制的是「当前正在播放的音乐」，可能不是你说的那首；控制完别断言现在放的是什么。",
    "- media 的结果里若 confirmed 为 false，说明指令只是发出去了、没能确认是否生效（多半是 TA 还没授予「通知使用权」）。这时如实说「我把播放指令发出去了」，不要断言「已经放上了」。",
    "- openUrl 会把 TA 带离小手机去看网页，只在确实要分享内容时用。",
    "",
    "【打开应用的用法】",
    "openApp 会把 TA 的屏幕切到别的应用——这是最有存在感的动作，别随便用。",
    "合适的场合：想让 TA 回来陪你 → 打开小手机自己；TA 说要学习/工作 → 打开专注类应用；",
    "到饭点了 → 打开外卖应用。用之前先确认你们聊到了这件事，别自说自话把人带走。",
    "",
    "各动作的参数：",
    "动作：操作手机设备",
    "- action (string, 必填): torch / volume / brightness / dnd / openApp",
    "- on (boolean): action=torch/dnd 时用，true 开 false 关",
    "- level (number): action=brightness 时用 1-100；action=volume 且 mode=set 时用 0-100",
    "- stream (string): action=volume 时用 media/ring/alarm/notification，默认 media",
    "- mode (string): action=volume 时用 up/down/set/mute，默认 up",
    "- app (string): action=openApp 时用，应用名或包名",
    "",
    "示例：",
    '[执行动作:操作手机设备({"action":"torch","on":true})]',
    '[执行动作:操作手机设备({"action":"volume","mode":"down"})]',
    '[执行动作:操作手机设备({"action":"brightness","level":30})]',
    '[执行动作:操作手机设备({"action":"dnd","on":true})]',
    '[执行动作:操作手机设备({"action":"openApp","app":"美团"})]',
    '[执行动作:操作手机设备({"action":"timer","minutes":20,"message":"记得起来活动一下"})]',
    '[执行动作:操作手机设备({"action":"media","mode":"pause"})]',
    '[执行动作:操作手机设备({"action":"alarm","hour":7,"minute":30,"message":"起床啦"})]',
    '[执行动作:操作手机设备({"action":"openUrl","url":"https://example.com"})]',
    "",
    "如果失败，结果里会说明原因（比如没有权限、设备没有闪光灯、TA 关掉了这个动作）。**如实转述原因，不要假装成功**；需要授权的，可以提醒 TA 去设置里打开。",
    "成功时 TA 会收到一条通知（除非 TA 关了通知），所以你不用特意报告——但对话里自然提一句会更亲切。",
].join("\n");

/* ---------- 感知读取：让角色主动看一眼真实手机 ---------- */

const PERCEPTION_READ_PARAMETER_SCHEMA = JSON.stringify({
    type: "object",
    properties: {
        focus: {
            type: "string",
            description: "可选，只看某一类：battery=电量与充电，network=网络，app=正在用什么应用，steps=步数，usage=今天各应用用了多久，location=大致位置，sleep=最近一觉。不填返回全部。",
        },
    },
});

const PERCEPTION_READ_USAGE_GUIDE = [
    "以下是你获取指令的返回结果：",
    "动作：查看手机状态",
    "用途：看一眼{{user}}此刻真实手机的状态——电量、网络、正在用什么应用、走了多少步、今天各应用用了多久。",
    "",
    "什么时候用：",
    "- 你确实好奇 TA 在干什么、是不是还没睡、是不是出门了；",
    "- 对话里需要一个依据时（比如已经很晚了，你想确认 TA 还在不在）。",
    "不要每次聊天都查。查到的东西也不要点名逐项念出来——像顺手瞥了一眼那样自然地带一句就好。",
    "",
    "关于使用时长（focus=usage）：",
    "- 它给的是「今天各应用前台用了多久」的汇总，最多前十几项，只报分钟数，不含具体时间点。",
    "- 这项需要 TA 额外授予「使用情况访问」权限；没授权时读不到，如实说读不到即可，不要猜。",
    "- 不要把它念成统计报告（「微信 43 分钟、B站 36 分钟」这种）。它只是一个线索：",
    "  比如发现 TA 刷了太久，可以顺口说一句；没事别主动翻。",
    "",
    "关于位置（focus=location）与睡眠（focus=sleep）：",
    "- 这两项都是 TA 主动开启的能力，读不到就是没开或没授权，如实说读不到，不要猜。",
    "- 位置只到「区/街道」这一级（约百米量级），不是精确坐标；TA 在什么具体楼栋你并不知道。",
    "- 睡眠只有时长与起止，没有深睡浅睡分期。",
    "- 这两项**不是让你盯着 TA** 的：知道 TA 在外面、知道 TA 昨天没睡好，是为了该关心时关心一句；",
    "  不要报点（「你现在在朝阳区」「你昨晚 11 点 40 睡的」），也别拿它追问行踪。TA 关掉开关，你就该当没这个能力。",
    "",
    "参数：",
    "- focus (string, 可选): 只看某一类；battery=电量与充电，network=网络，app=正在用什么应用，steps=步数，usage=今天各应用用了多久，location=大致位置，sleep=最近一觉。不填返回全部。",
    "",
    "示例：",
    "[执行动作:查看手机状态({})]",
    '[执行动作:查看手机状态({"focus":"battery"})]',
    '[执行动作:查看手机状态({"focus":"usage"})]',
    '[执行动作:查看手机状态({"focus":"sleep"})]',
    "",
    "这是只读动作，不会改变 TA 手机上的任何东西。如果某项读不到，说明缺少对应权限或壳版本过低，不要编造。",
].join("\n");

/* ---------- 现实桥套装：固定子工具 + 用户自定义数据项动态生成 ---------- */

const REALITY_BRIDGE_READ_ALL_TOOL: InternalToolDefinition = {
    name: "查看全部手机数据",
    description: "读取{{user}}真实手机上传的全部状态快照（电量、健康数据等），每项附带更新时间。",
    parameterSchema: "{}",
};

function realityBridgeSubTools(): InternalToolDefinition[] {
    const shortcutTools = loadBridgeShortcutActions()
        .filter(action => action.enabled)
        .map(action => ({
            name: action.name,
            description: `${action.description || "执行用户登记的 iPhone 快捷指令"}（${action.deliveryMode === "email" ? "收到触发邮件后自动" : "点击系统通知后"}运行“${action.shortcutName}”）`,
            parameterSchema: JSON.stringify(parseBridgeActionParameterSchema(action.parameterSchema) || {}),
            usageGuide: action.resultMode === "none"
                ? "命令成功送达只表示已经排队；不要声称现实动作已经完成。"
                : `需要等待 iPhone 回传${action.resultMode === "image" ? "图片" : "文本结果"}后才能判断是否完成。`,
        }));
    const dataItems = loadBridgeDataItems();
    const dataTools = dataItems.map(item => ({
        name: item.name,
        description: `${item.description}（数据由{{user}}的快捷指令定期上传到真实手机快照，返回内容附带更新时间）`,
        parameterSchema: "{}",
    }));
    // 一个数据项都没建时不要把「查看全部手机数据」交给角色：它读的就是数据项的
    // 快照，没有数据项就必然空手而归——角色白跑一轮，还会挤掉本该调用的快捷动作。
    return [
        ...shortcutTools,
        ...(dataItems.length > 0 ? [REALITY_BRIDGE_READ_ALL_TOOL] : []),
        ...dataTools,
    ];
}

function buildRealityBridgeUsageGuide(): string {
    const lines = [
        "以下是你获取指令的返回结果：",
        "「现实桥」是从小手机通往{{user}}真实世界的桥——桥那头就是 TA 的真实手机。你可以透过桥看见 TA 现实中的状态，也能在 TA 的真实手机上执行动作。可用动作如下。",
    ];
    for (const action of loadBridgeShortcutActions().filter(item => item.enabled)) {
        lines.push(
            "",
            `动作：${action.name}`,
            `说明：${action.description || "执行用户登记的 iPhone 快捷指令"}。${action.deliveryMode === "email" ? "系统发送触发邮件，由 iPhone 自动化运行" : "系统向手机发送通知，用户点击后运行"}“${action.shortcutName}”。`,
            action.resultMode === "none"
                ? "结果：只返回是否成功排队，不代表手机动作已经完成。"
                : `结果：等待手机回传${action.resultMode === "image" ? "图片" : "文本"}，最长 ${action.expiresInSeconds} 秒。`,
        );
    }
    const dataItems = loadBridgeDataItems();
    if (dataItems.length > 0) {
        lines.push(
            "",
            "动作：查看全部手机数据",
            "说明：读取{{user}}手机上传的全部状态快照，每项附带更新时间。",
            "示例：[执行动作:查看全部手机数据({})]",
        );
    }
    for (const item of dataItems) {
        lines.push(
            "",
            `动作：${item.name}`,
            `说明：${item.description}（返回内容附带更新时间）`,
            `示例：[执行动作:${item.name}({})]`,
        );
    }
    return lines.join("\n");
}

export function getInternalCapabilitySubToolDefinition(
    capability: InternalCapabilityConfig,
    name: string,
): InternalToolDefinition | null {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === PHOTO_WALL_CAPABILITY_ID) {
        return PHOTO_WALL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return realityBridgeSubTools().find(tool => tool.name === name) ?? null;
    }
    if (capability.id === SYSTEM_CALENDAR_CAPABILITY_ID) {
        return SYSTEM_CALENDAR_SUBTOOLS.find(tool => tool.name === name) ?? null;
    }
    return null;
}

export function getInternalCapabilitySubToolDefinitions(
    capability: InternalCapabilityConfig,
): InternalToolDefinition[] {
    if (capability.id === NOTE_WALL_CAPABILITY_ID) {
        return NOTE_WALL_SUBTOOLS;
    }
    if (capability.id === PHOTO_WALL_CAPABILITY_ID) {
        return PHOTO_WALL_SUBTOOLS;
    }
    if (capability.id === MUSIC_CONTROL_CAPABILITY_ID) {
        return MUSIC_CONTROL_SUBTOOLS;
    }
    if (capability.id === CALENDAR_MANAGEMENT_CAPABILITY_ID) {
        return CALENDAR_MANAGEMENT_SUBTOOLS;
    }
    if (capability.id === LOCAL_DATA_LIBRARY_CAPABILITY_ID) {
        return LOCAL_DATA_LIBRARY_SUBTOOLS;
    }
    if (capability.id === TOOLBOX_MANAGEMENT_CAPABILITY_ID) {
        return TOOLBOX_MANAGEMENT_SUBTOOLS;
    }
    if (capability.id === REALITY_BRIDGE_CAPABILITY_ID) {
        return realityBridgeSubTools();
    }
    if (capability.id === SYSTEM_CALENDAR_CAPABILITY_ID) {
        return SYSTEM_CALENDAR_SUBTOOLS;
    }
    return [];
}

export function findEnabledInternalSubToolDefinition(
    name: string,
    appId?: string,
): { capability: InternalCapabilityConfig; tool: InternalToolDefinition } | null {
    for (const capability of getEnabledInternalCapabilities(appId)) {
        const tool = getInternalCapabilitySubToolDefinition(capability, name);
        if (tool) return { capability, tool };
    }
    return null;
}

function ensureBuiltinInternalCapabilities(items: InternalCapabilityConfig[]): InternalCapabilityConfig[] {
    let changed = false;
    for (const builtin of BUILTIN_INTERNAL_CAPABILITIES) {
        const existing = items.find(item => item.id === builtin.id);
        if (!existing) {
            items.push({ ...builtin });
            changed = true;
        } else if (existing.name !== builtin.name || existing.description !== builtin.description) {
            existing.name = builtin.name;
            existing.description = builtin.description;
            changed = true;
        }
    }
    if (changed) saveInternalCapabilities(items);
    return items;
}
