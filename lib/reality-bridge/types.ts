/** 现实桥：iPhone 快捷指令 ↔ 小手机 的双向数据管道。 */

export type BridgeItem = {
  id: string;
  /** 用户在快捷指令里自定的类型名，规则按它匹配 */
  type: string;
  /** 原始数据（文本或任意 JSON 序列化后的字符串） */
  payload: string;
  createdAt: string;
};

export type BridgeProcessMode = "raw" | "template" | "ai";

export type BridgeRuleActions = {
  /** 写进与某角色的聊天：role 决定聊天室里怎么显示；
   *  historyRole 可选，决定在角色记忆（prompt 历史）里算谁说的，缺省跟随 role */
  chat?: {
    characterId: string;
    role: "user" | "assistant" | "system";
    historyRole?: "user" | "assistant" | "system";
    requestReply: boolean;
  };
  /** 写入角色记忆 */
  memory?: { characterId: string; type: "long_term" | "core" };
  /** 写入角色时间线 */
  timeline?: { characterId: string };
  /** 浏览器系统通知 */
  notify?: boolean;
  /** 写入用户日历（今天，标题=加工结果）。
   *  新版：以触发时刻为锚点，direction=past 记录刚过去的 durationMinutes 分钟，future 记录接下来的；
   *  旧版规则仍带 startTime/endTime 固定时段，引擎兼容执行。 */
  calendar?: { startTime?: string; endTime?: string; direction?: "past" | "future"; durationMinutes?: number };
  /** 以卡片形式发进聊天 */
  card?: { characterId: string };
  /** 执行一个已配置的快捷动作：创建命令并推送运行通知，点通知即执行；
   *  App 被杀时由个人云的联动执行器代发（仅推送模式的快捷动作） */
  shortcut?: { actionId: string };
  /** 回传 iPhone 发件箱 */
  outbox?: { type: string };
  /** 广播 bridge.data 事件给已订阅的自定义 APP */
  broadcast?: boolean;
  /** 在本机上真的做一件事（手电筒、音量、打开应用……）。
   *  与「快捷动作」的区别：这条不经过云端、不用 iPhone 参与，直接在安卓壳里执行；
   *  args 里的字符串值支持 {payload}/{type} 占位；执行受「设置 → 操作设备」
   *  里的逐动作开关约束，没开的动作会被拒绝并如实记进流水。 */
  deviceAction?: { action: string; args?: Record<string, unknown> };
  /** 调用任意一个已启用的工具/动作：内置能力、工具箱里的 REST 与组合工具、MCP 工具、
   *  自定义 APP 工具都能在这里被规则直接调用。
   *  args 里的字符串值支持 {payload}/{type} 占位；characterId 可选，决定
   *  「写入记忆」这类需要角色上下文的工具以谁的身份执行（缺省跟随 chat 动作的角色）。 */
  tool?: { name: string; args?: Record<string, unknown>; characterId?: string };
};

export type BridgeRule = {
  id: string;
  name: string;
  /** 匹配的数据类型；"*" 匹配全部 */
  matchType: string;
  /**
   * 只在这个词出现在信号正文里时才触发（空 = 不限）。
   *
   * 为什么需要它：信号类型太粗——「长时间使用」这一条会同时罩住刷抖音、
   * 刷 B 站、看小说，用户想「只有刷抖音才提醒我」就配不出来。而应用名
   * 恰好就在 payload 里（如「抖音 已连续使用 20 分钟」），所以按 payload
   * 做一层关键词过滤就够，不必给每种应用各造一个信号类型。
   *
   * 多个词用 | 或 , 分隔，命中任一即触发（如「抖音|快手」）。
   */
  payloadFilter?: string;
  enabled: boolean;
  process: {
    mode: BridgeProcessMode;
    /** template 模式：{payload} / {type} 占位 */
    template?: string;
    /** ai 模式：加工提示词，{payload} / {type} 占位 */
    prompt?: string;
  };
  /** 离线回复库：一行一条，角色可提前准备，断网时由本机随机选用。 */
  offlineReplies?: string[];
  actions: BridgeRuleActions;
  /** 触发间隔（分钟）：间隔内再次收到同信号只存档不执行；0/缺省 = 每次都触发 */
  cooldownMinutes?: number;
  /**
   * 延迟执行：信号收到后先等这么多分钟，再执行动作。0/缺省 = 立刻执行。
   *
   * 为什么需要它：「先安静一会儿再说」是很自然的需求——角色发现你熬夜，
   * 不该立刻弹消息，而是十分钟后再提醒；外卖到了，隔五分钟再问他吃没吃。
   * 延迟队列落 IndexedDB，App 中途关掉再打开，到点照样执行。
   */
  delayMinutes?: number;
  /**
   * 定时触发：不依赖任何外部信号，到点自己执行。
   *
   * 为什么需要它：在这之前，每一条规则都必须等一个「外面来的」信号，
   * 于是安卓用户配不出「每天早上说句早安」这种最基本的事——那得靠 iPhone
   * 快捷指令的定时自动化，而安卓没有那条线。定时触发把这件事收回本机。
   *
   * 配了 schedule 的规则不参与信号名匹配（matchType 被忽略）。
   * 触发只在小手机开着或后台保活时发生——完全关闭时没有任何东西在跑。
   */
  schedule?: {
    kind: "daily" | "weekly" | "interval";
    /** daily/weekly 用：HH:MM */
    time?: string;
    /** weekly 用：0=周日 … 6=周六 */
    weekday?: number;
    /** interval 用：每隔多少分钟 */
    minutes?: number;
  };
  createdAt: string;
};

export type BridgeFeedEntry = {
  id: string;
  type: string;
  payload: string;
  /** 加工后的文本（未加工时等于 payload） */
  processed?: string;
  /** 命中的规则名列表 */
  rules: string[];
  /** 执行的动作摘要 */
  actions: string[];
  error?: string;
  receivedAt: string;
};

export type BridgeOutboxEntry = {
  id: string;
  type: string;
  payload: string;
  createdAt: string;
  /** 来源：rule=规则回传 / tool=角色工具 / manual=手动测试 / app=自定义APP */
  source: "rule" | "tool" | "manual" | "app";
};

export const BRIDGE_INBOX_PREFIX = "bridge-inbox/";
export const BRIDGE_OUTBOX_QUEUE_PATH = "bridge-outbox/queue.json";
/** 状态快照目录：快捷指令覆盖写 bridge-state/<key>.json，角色工具按需读取 */
export const BRIDGE_STATE_PREFIX = "bridge-state/";
export const REALITY_BRIDGE_DATA_EVENT = "reality-bridge-data";
export const REALITY_BRIDGE_APP_EVENT_NAME = "bridge.data";
