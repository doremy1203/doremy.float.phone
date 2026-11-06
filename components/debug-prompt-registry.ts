export type ExtraPromptAppId =
    | "checkphone"
    | "reading"
    | "dwelling"
    | "diary"
    | "notewall"
    | "xiaohongshu"
    | "cocreate"
    | "shopping"
    | "interview"
    | "adventure"
    | "life"
    | "photo_wall"
    | "checkin"
    | "watch_together"
    | "phone_widget"
    | "reality_bridge";

export type ExtraPromptAppDefinition = {
    id: ExtraPromptAppId;
    label: string;
    emptyText: string;
    /** Retained for future tabs that intentionally show only a real request snapshot. */
    snapshotOnly?: boolean;
    snapshotAppIds?: string[];
    snapshotTags?: string[];
};

export const EXTRA_PROMPT_APPS: ExtraPromptAppDefinition[] = [
    { id: "checkphone", label: "查手机", emptyText: "选择角色与查手机 APP 后点击「预览」" },
    { id: "reading", label: "阅读", emptyText: "选择角色、书籍、章节和任务后点击「预览」" },
    { id: "dwelling", label: "栖所", emptyText: "选择角色与栖所任务后点击「预览」" },
    { id: "diary", label: "日记", emptyText: "选择角色后点击「预览」查看日记 Prompt" },
    { id: "notewall", label: "便签墙", emptyText: "选择角色与便签墙任务后点击「预览」" },
    { id: "xiaohongshu", label: "小红书", emptyText: "选择角色与小红书任务后点击「预览」" },
    { id: "cocreate", label: "共创", emptyText: "选择共创模式后点击「预览」" },
    { id: "shopping", label: "购物", emptyText: "选择购物任务后点击「预览」" },
    { id: "interview", label: "在场", emptyText: "选择角色与在场任务后点击「预览」" },
    { id: "adventure", label: "冒险", emptyText: "选择角色与冒险存档后点击「预览」" },
    { id: "life", label: "生活系统", emptyText: "选择角色与生活回合类型后点击「预览」，查看当前生活状态和生活专属预设组装出的完整 Prompt。" },
    { id: "photo_wall", label: "照片墙", emptyText: "选择角色和照片批注/装饰涂鸦任务后点击「预览」，查看照片墙专属 Prompt。" },
    { id: "checkin", label: "签到", emptyText: "选择角色和查岗结果（同意、拒绝、超时或失败）后点击「预览」，查看对应事件与一次性指导语。" },
    { id: "watch_together", label: "一起看", emptyText: "选择角色与陪看即时回应/观后感任务后点击「预览」，查看一起看专属 Prompt。" },
    { id: "phone_widget", label: "桌面小组件", emptyText: "选择角色后点击「预览」，查看桌面状态生成使用的角色预设和触发消息。" },
    { id: "reality_bridge", label: "现实桥梁", emptyText: "选择绑定了现实桥规则的角色后点击「预览」，查看离线回复库生成使用的 Prompt。" },
];

export const EXTRA_PROMPT_APP_LABELS = Object.fromEntries(
    EXTRA_PROMPT_APPS.map((item) => [item.id, item.label]),
) as Record<ExtraPromptAppId, string>;
