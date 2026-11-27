# 内置应用制作规范

> 适用：在 `desktop-shell` 里直接渲染的 **React 内置应用**。
> 不适用：应用市场/资源集市里的 **自定义应用（custom app）**——那是沙盒 iframe + `window.AiPhone` SDK，走另一套权限协议。
>
> 参考范本：聊天 App（`components/chat/phone-chat-app.tsx` + `chat-room.tsx`），它是当前功能最全、同步面最广的内置应用。本文按它的结构反推标准。
>
> 相关文档：
> - [自定义 App → 内置 App 转换指南](./custom-app-to-builtin-porting-guide.md)
> - [自定义 App 通话音频接入](./custom-app-call-audio.md)
> - [角色陪伴专注内置化迁移方案](./focus-companion-builtin-migration-plan.md)

## 0. 先分清两种“应用”

| | React 内置应用 | 自定义应用（custom app） |
|---|---|---|
| 运行位置 | 主页面内，直接渲染 React 组件 | 沙盒 iframe，注入 `window.AiPhone` |
| 数据访问 | 可直接 import `lib/*`，读写 IndexedDB/KV | 只能通过 `AiPhone.*` 宿主 API + 权限 |
| UI | 完整 React/CSS，可复用宿主组件 | 单文件 HTML，不透明源 |
| 安装 | 编译期注册，不可卸载 | 市场/资源集市安装，可卸载 |
| 适合 | 钱包、匿名提问箱、聊天、日历、专注这类要深度同步的 | 第三方小工具、可分发玩法 |
| 权限 | 无 manifest 权限表；靠代码审查和模块边界 | `manifest.permissions` 逐 action 校验 |

**不要用 custom app 做钱包/共同金库/亲属卡。** 它无法原子地同时改钱包、账本、聊天和购物订单；只能靠新增大量宿主 API 拼，最终既慢又容易不一致。

---

## 1. 内置应用注册：五处必须一起改

以新增 `wallet` 为例。

### 1.1 `lib/desktop-config.ts`

```ts
export type IconId =
  | "chat"
  // ...
  | "wallet";

export const PAGE_1_DEFAULT: IconId[] = [
  "chat", "wallet", /* ... */
];

export const ICONS: Record<IconId, IconMeta> = {
  // ...
  wallet: { id: "wallet", label: "钱包", tone: "var(--c-icon-amber)", placeholder: false },
};
```

### 1.2 `components/desktop-shell.tsx` 的 `openApp`

```ts
if (builtinIconId === "wallet") setActiveApp("wallet");
```

如果有需要预加载的状态/初始页，也在这里处理。

### 1.3 `components/desktop-shell.tsx` 的 `activeApp` 渲染分支

```tsx
if (activeApp === "wallet") {
  return <WalletApp onClose={() => setActiveApp(null)} />;
}
```

内置 React 应用直接返回组件，**不要**套 `CustomAppRunner` / `CustomAppForegroundBoundary`。

### 1.4 组件契约

```ts
export type WalletAppProps = {
  onClose: () => void;
  initialTab?: "home" | "family" | "joint" | "ledger";
};
```

约定：
- `onClose` 必须关闭应用回桌面。
- 可接收 `initialTab` / `initialId` 这类深链参数；聊天卡片、通知、捷径都靠它冷启动。
- 如果应用会长时间停留，内部自己管理 tab/子页，不要频繁重建整个 App。
- 返回键/左滑返回由 App 自己处理，和聊天室的 `onBack` 一致。

### 1.5 深链/通知/卡片

- 聊天卡片、通知、push 要能 `openApp("wallet")` 并带 `initialTab`。
- 如果从聊天里的钱包卡片进入，必须带 launch context，关闭后回到原会话（参考聊天 App 的 `initialSessionId`）。

---

## 2. 用聊天 App 反推结构

### 2.1 壳层

`components/chat/phone-chat-app.tsx`
- 负责 App 级 tab：消息 / 联系人 / 朋友圈 / 我。
- 负责 hydrate、初始会话、外部 `CHAT_OPEN_SESSION_EVENT`。
- 具体会话交给 `ChatRoom`。

`components/chat/chat-room.tsx`
- 负责单个会话：消息列表、输入、媒体、工具调用、语音、钱包、通话入口。
- props：`session`、`onBack`、`onDeleted`、`isActive`。
- 外部事件通过 `window` CustomEvent 进入，不直接跨组件改 state。

内置应用应照这个分层：
- `XxxApp` 管 App 级导航/列表；
- `XxxDetail`/`XxxRoom` 管单条记录；
- 数据层在 `lib/`，不在组件里直接拼 SQL/IDB。

### 2.2 数据层

聊天：
- `lib/chat-storage.ts`：会话、消息、联系人、App 设置、hydrate、push/update/delete。
- `lib/chat-engine.ts`：请求、prompt、工具、流式、上下文。
- `lib/llm-prompt-assembler.ts`：预设、世界书、记忆、状态栏、正则。
- `lib/short-term-assembler.ts`：短期记忆/时间线统一。
- `lib/memory-*`：长期/核心记忆。

内置应用标准：
- 新建 `lib/<app>-storage.ts`，导出 `hydrateXxx`、`loadXxx`、`saveXxx`、`create/update/delete`。
- 所有写操作发 `window.dispatchEvent(new CustomEvent("xxx-updated"))`，其他界面订阅刷新。
- 数据必须可导出/备份；在 `lib/data-management/modules.ts` 注册。
- 版本化：数据结构加 `version`，迁移函数幂等。

### 2.3 和聊天同步

内置应用写聊天必须走聊天仓储，不要直接写 `AiPhoneChatDB`：

```ts
pushChatMessage(sessionId, message);
updateChatMessage(sessionId, messageId, patch);
```

发卡片/角色回复：
- `chat.sendCard` 是 custom app 的 API；React 内置应用直接调用聊天引擎/卡片构造。
- 需要角色回话时，用 `CHAT_REQUEST_REPLY_EVENT` 或 `requestReply` 等价入口，不要自己拼 LLM 请求。

必须同步的字段：
- `ChatMessage.mediaType`、`mediaData`、`mediaUrl`、`imageRefs`、`voiceDuration`、`sourceApp`、`sourceDetail`。
- 群聊/单聊的 `session.isGroup`、`characterId`、`contactId`。
- 消息顺序 `order/createdAt`；批量写入后调用 `reindex...`（如适用）。

### 2.4 和记忆/prompt 同步

聊天上下文不是把文本塞进消息就完事。需要按现有管线：

- 短期：`prepareShortTermContext` / `short-term-assembler`，把新来源投影成 `NativeTimelineEntry`，加 `FEATURE_ORDER` 权重。
- 长期：`memory-summarizer` 决定哪些来源可总结；临时/预览内容不要进长期。
- 世界书/预设/正则：通过 `loadPresets`、`loadRegexes`、`loadBindingConfig` 解析，不要硬编码。
- 角色状态：`getLatestCharacterStateValues` / `parseStateValues`，不要自己解析 XML。
- 共同记忆/公共问答：写入 `SharedQaMemory` 后，在 prompt 组装里加独立 block；匿名身份不要进目标 prompt。

结论：**任何“角色应该记住”的内容，都必须过短期/长期/世界书管线，不能只写自己的 KV。**

### 2.5 和角色/绑定同步

- 角色列表/头像/关系：`lib/character-storage.ts`、`loadCharacters`。
- API/预设/世界书绑定：`loadBindingConfig`、`resolveBinding`。
- 用户身份/头像：`resolveUserIdentity`、`resolveUserAvatar`。
- 音色：`resolveVoiceConfig` / `voice.readProfiles`。

### 2.6 和钱包/经济同步

钱包/账本属于高危同步面：
- 所有扣款必须走 `lib/wallet-storage.ts` 的 `payWithWalletAccount` / `payWithWalletBalance`。
- 角色账本走 `lib/economy/character-ledger.ts`。
- 不要在两套 state 里各记一次余额；账本流水是唯一真相。
- 写钱必须二次确认/明确来源；失败要回滚。

### 2.7 和媒体同步

- 图片/语音/文件统一 `storeMediaBase64` / `storeMediaBlob` 存 `media-store://`。
- 消息里只存 ref，不存 base64（聊天旧数据兼容除外）。
- 自定义 APP 的 `__media_refs` 要登记，否则档案室会当孤儿/误删。
- 删除媒体前检查引用；按 `media-reference-usage` 的规则处理。

### 2.8 和日历/生活/现实桥同步

- 日历：`lib/calendar-storage.ts`，不要直接改 IndexedDB。
- 生活系统：`loadVirtualLifeState` / `saveVirtualLifeState`，事件走 `appendLifeTimelineEntry`。
- 现实桥：`reality-bridge/storage` + `engine`，规则动作走现有 action/tool 分发。
- 通知/任务：`notifications` + `tasks.schedule`，后台执行要能在页面不在时纯数据运行。

---

## 2.9 提示词：不要硬编码在组件里

内置应用的角色提示词分三层，不要把所有文案写死在 React 组件：

1. **稳定规则** → `lib/builtin-app-prompts.ts` 的 `APP_PROMPT_DEFINITIONS`。
   - 用 `tags` 限定只在某类 AI 请求生效；调用 AI 时传对应 `appTags`（`llm-prompt-assembler.ts` 按子集匹配）。
   - 用户可以在「预设管理器」里编辑/关闭；这是首选。
2. **App 自己的可编辑提示词** → App 数据里的 prompts 配置 + 设置页编辑器（参考专注 App 的 prompts 页）。
   - 适合提示词很多、和 UI 强绑定的 App；仍要允许用户改，不能只写常量。
3. **动态上下文** → 本轮消息/工具结果/`buildXxxContext` 拼接。
   - 只拼事实数据，不要在动态 block 里写一段不可编辑的角色规则。
   - 例如公共匿名提问箱：数据行可以动态生成；「你应该怎么提问/回答」的规则应放预设或 App 提示词编辑器。

判断标准：
- 用户能不能改这句话？能改 → 预设/App 提示词编辑器。
- 只是数据或协议格式（JSON 字段名、分隔符）→ 可以写在代码里。
- 组件 JSX 里只放 UI 标签，不放角色台词/行为规则。

具体落点：
- 全局预设：`lib/builtin-app-prompts.ts` 的 15 条文案常量 + `APP_PROMPT_DEFINITIONS`（`identifier/name/content/tags`）→ `createBuiltinAppPrompts()` 生成 `role:"system"` 条目，`builtin-preset.ts` 展开进 `prompts` 与 `prompt_order`。
- 作用域：调用 AI 时传 `appTags`，`llm-prompt-assembler` 只注入 tags 全部 ⊆ activeTags 的条目；无 tags 的条目恒注入。
- 老用户：`mergeMissingBuiltinAppPrompts` 只补缺失项；升 `BUILTIN_PRESET_VERSION` 会用出厂内容整份重写，用户改动/关闭状态会丢，非必要不升。
- App 内编辑器：专注 App 的 `PROMPT_DEFS` / `promptRaw` / `promptText` / `promptTags` / `pGen` / `VIEWS.prompts` 是范本；heartcraft 的 `DEF_PROMPT` / `promptOf` / `saveSettings` / `PL` 同类。默认值可内嵌，但必须允许用户覆盖，且统一走变量替换。
- 新 React 内置 App：长规则进 `APP_PROMPT_DEFINITIONS`；App 内只保留动态上下文与协议格式。钱包/匿名提问箱这类没有 AI 生成页的 App，不要把角色行为规则写进 React 组件。

## 2.10 角色工具组：新增能力必须“可发现”

角色工具箱不是只有一种工具。当前来源：

| 来源 | 形态 | 适合 | 创建/入口 |
|---|---|---|---|
| 内置能力 | internal capability + 子工具 | 手机/应用内真实动作、聊天/记忆/钱包 | 设置→工具，代码注册 |
| REST 工具 | 单个 HTTP | 一次 API 调用 | 设置→工具；REST 套件分组 |
| REST 套件 | 分组，不可执行 | 把多个 REST 工具收在一起 | `RestToolPackageConfig` |
| 组合工具 | 多步 workflow | 串联 REST/内置/MCP/脚本 | `CompositeToolConfig` |
| 组合套件 | 分组，不可执行 | 把多个 workflow 收在一起 | `CompositeToolPackageConfig` |
| MCP | 远端工具发现 | 外部 MCP server | 设置→工具→MCP |
| 自定义 APP 工具 | manifest.extensions.tools | 市场/资源集市 App | 需 `chat.tools` |
| life 工具 | `life_*` | 生活模拟 | 生活设置 |
| 角色电脑 | 单工具多 op | 文件/命令/交付 | `agent_computer` |

**套件 ≠ workflow**：套件只是分组，本身不能执行，靠懒展开列出子工具；组合工具才是顺序执行多步（`steps`、`argsTemplate`、`outputTemplate`、`script`），嵌套上限 2。所谓 workflow 目前就是内置组合套件，不是独立类型。

执行与生命周期：
- 统一 `EnabledTool` + `getEnabledTools`；文本协议先注入目录，原生协议由 `buildNativeChatTools` 生成。执行入口 `executeToolCalls`，大致顺序 life → internal → rest → composite → mcp → custom_app。
- REST：单件或套件；`directFetch` 直连约 120s，代理走 `/api/tool-proxy` 约 120s；`fixedParams/headers/bodyTemplate` 可隐藏密钥。
- 组合工具：`step.toolType` 支持 auto/rest/internal/mcp/composite/script；`argsTemplate` 支持 `{{input.x}}/{{steps.k.data}}/{{last.data}}`；任一步失败立即中止并返回已完成媒体；结果统一截断约 2000 字。
- MCP：schema 取 `discoveredTools.inputSchema`；有 OAuth/直连/代理模式。
- 自定义 APP：manifest `extensions.tools` + `chat.tools` 权限；后台隐藏运行默认 5 分钟、最高 30 分钟。
- 内置能力：`enabled + mode(off/confirm/auto)` 双重门控；只有 `memory_write` 的 confirm 走 pendingApproval，其他 confirm 目前仍是说明性字段。
- 套件懒展开：子工具自身 enabled 且套件 enabled 才可见；套件本身不要写可执行逻辑。

新增一个内置能力组（如角色锁应用）的完整清单：

1. `lib/internal-capability-storage.ts`
   - 能力 ID 常量
   - `BUILTIN_INTERNAL_CAPABILITIES` 条目（名称/描述/默认开关）
   - 参数 schema + 子工具数组
   - **`getInternalCapabilityToolDefinition` 顶层分支**（返回 `{name, description, parameterSchema:"{}", usageGuide}`）
   - `getInternalCapabilitySubToolDefinition(s)` 两个查找分支
   - `RESERVED_INTERNAL_TOOL_NAMES` 加组名和所有子工具名
2. `lib/tool-executor.ts`
   - import 能力 ID
   - `executeInternalTool` 分派（必须在现实桥之前）
   - handler：校验能力 enabled/mode、角色上下文、参数、失败原因
3. 设置页 `toolbox-settings.tsx` 自动列出，无需另注册；聊天/原生工具目录自动展开
4. 测试：文本协议 `[执行动作:...]`、原生 tool call、关闭能力、参数缺失、权限/余额不足

**最容易漏的一步**：只加子工具、不在 `getInternalCapabilityToolDefinition` 加顶层分支，工具不会出现在角色目录里，只能靠精确名碰运气。新增工具组后必须验证目录里能看到。

当前已注册的角色工具组：
- **角色收支**：记录收入/支出/查看账本/查看亲属卡/使用亲属卡/开亲属卡/查看共同小金库/存入共同小金库
- **匿名提问箱**：匿名提问/回答/查看
- **角色锁应用**：查看可锁应用/锁应用/给临时通行证/解锁应用/查看应用锁/告诉应用锁密码（通行证仅锁定角色本人可发，1-5 分钟；密码是否给由好感度阈值决定，未到阈值不要编造）

工具 description 应该写“什么时候调用、参数含义、失败会怎样”，不要写角色台词；角色怎么说话放预设/App 提示词编辑器。

## 2.11 通知与横幅

按场景选，不要所有消息都弹系统通知：

| 场景 | 用法 |
|---|---|
| App 内轻量操作反馈（已保存/已复制） | `window.dispatchEvent(new CustomEvent("global-notice", { detail: "..." }))` → 顶部短横幅，约 2.2s |
| 需要用户注意的成功/错误/说明 | `app-global-notice`，`{kind:"success"|"error"|"info", message}` → `GlobalNoticeHost` 居中卡片，错误 7s |
| 后台/锁屏/离开 App 仍需知道 | `sendBrowserNotification(title, body, ...)` 或原生 `shell.notify` |
| 通知中心留档 | `notifications.create` |
| 角色主动找用户、需要点进会话 | 聊天卡片/消息 + `requestReply`，不要只弹系统通知 |
| custom app | `AiPhone.ui.toast` / `AiPhone.notifications` / `AiPhone.device.notify` |

具体行为：
- `sendBrowserNotification` 只在浏览器/PWA、用户开启通知且 `document.hidden` 时发；壳内直接 return，APK 用 `shell.notify`/`device.notify`。
- `shell.notify` 走原生通知栏/锁屏，网页/旧壳 no-op；custom app 需要 `notifications.write` 或 `ui.notification` 权限。
- `ui.showNotification` / `notifications.create` 只写应用内通知中心+角标，不弹系统通知；不要和 `shell.notify` 同时调用，否则重复。
- React 即时反馈：`onNotice` → `.phone-shell-notice` 顶部条（约 2.2s）；`global-notice` 同路。
- 重要成功/错误：`app-global-notice` → `GlobalNoticeHost` 居中卡片；错误 7s，其余 4.2s。
- 角色主动找用户/需要点进会话：`dispatchChatMessageNotice` 或聊天卡片；不要只发系统通知。
- 目前没有统一 Banner 组件：顶部条是 desktop-shell 内联 + 各自 CSS；新 App 优先复用 `global-notice`/`app-global-notice`，不要再造一套。

钱包/小金库建议：
- 存入成功：顶部 `global-notice`。
- 余额不足/额度超限：`app-global-notice` error，明确原因。
- 定时存入成功/失败、亲属卡大额消费：`sendBrowserNotification`（用户可能没看钱包）或壳内 `shell.notify`。
- 角色主动说“我往小金库存了钱”：聊天卡片/消息。

## 3. 界面标准

聊天 App 的 UI 规则可直接复用：

- 颜色只用主题变量：`var(--c-text)`、`var(--c-icon)`、`var(--c-primary)`、`var(--c-card)`、`var(--c-border)`、`var(--c-input)`。
- 页面结构：顶部 app bar + 可滚动内容 + 底部 tab/输入；不要自己写死安全区。
- 移动端：`100dvh`、`env(safe-area-inset-*)`、键盘避让；输入框不能被键盘顶飞。
- 列表：首屏 skeleton/loading，空状态，错误状态；长列表分页/虚拟化。
- 返回：`onClose`/`onBack` 必须可达；不要用浏览器 history 代替 App 栈。
- 状态栏色调：桌面壳会按 `activeApp` 调整，新增 App 不要自己改全局色调。
- 性能：大列表 `memo`，事件订阅 cleanup，避免每秒全 App rerender。

---

## 4. 存储与备份标准

- 新数据键前缀：`ai_phone_<domain>_v1`；不要复用别的模块 key。
- 新 IndexedDB 表要加版本迁移；旧数据缺失字段按默认值兼容。
- 备份模块注册：
  - `lib/data-management/modules.ts` 加模块；
  - 导出/导入要包含新表；
  - 恢复后触发 hydrate/refresh 事件。
- 删除/清空要给二次确认；删数据不能留下悬空引用。

---

## 5. 原生能力标准

React 内置应用可以直接 import 宿主封装，但不要散落调用 `window.AndroidShell`：

- 设备动作：`lib/device-action/*`。
- 截屏/查岗：`lib/screenshot/*`。
- 通知：`lib/shell-notify` / browser notification。
- 权限：先查能力/授权状态，失败给明确原因，不静默。
- 后台/锁屏：需要原生服务时，写 Kotlin service + `MainActivity` 桥 + TS wrapper，三步齐全。

---

## 6. 安全与数据边界

- 钱包/亲属卡/共同金库：所有写操作要用户确认；不允许角色工具直接扣用户钱，除非用户已授权额度。
- 匿名提问箱：`askerId` 永不进目标角色 prompt；只暴露 alias。
- 公共问答进共同记忆前要脱敏；私密问答不进长期记忆。
- 文件：限制 25MB、禁可执行文件；下载走宿主代理。
- 语音：原音存媒体库，转写文本进 prompt；不要假装模型“听懂了”音频。
- 任何“角色自主”写操作都要有审计/可见记录，不能悄悄改用户数据。

---

## 7. 新增内置应用检查清单

- [ ] `IconId`、`ICONS`、默认页、`openApp`、`activeApp` 五处注册。
- [ ] 组件有 `onClose`，深链参数可用，返回不丢桌面状态。
- [ ] 数据层有 hydrate/load/save/事件/迁移。
- [ ] 写入聊天走 `pushChatMessage`/`updateChatMessage`，不直写 DB。
- [ ] 需要角色记住的内容过短期/长期/世界书管线。
- [ ] 媒体走 `media-store://`，登记引用，删除前检查。
- [ ] 钱包/账本走唯一资金服务，原子更新。
- [ ] 日历/生活/现实桥走各自 storage/engine。
- [ ] 备份模块注册，导入导出可恢复。
- [ ] 移动端键盘/滚动/安全区正常。
- [ ] `npx tsc --noEmit` 通过；涉及 custom SDK 时跑 `npm run check:sdk`。
- [ ] 旧数据/空数据/损坏数据都有兜底。
- [ ] 真机验证：打开/关闭/后台/重启/切会话/深链冷启动。

---

## 8. 对本次钱包/匿名提问箱的建议

### 钱包 App

建议做 **React 内置应用**，不做 custom app：

- 新 `IconId: "wallet"` + `components/wallet-app.tsx`。
- 页面：总览 / 亲属卡 / 共同小金库 / 角色账本 / 流水。
- 直接复用 `wallet-storage`、`character-ledger`、`wallet-panel` 的卡片 UI。
- 聊天里的钱包面板保留为快捷入口，点“查看全部”打开钱包 App。
- 所有扣款走 `payWithWalletAccount`，共同金库/亲属卡单独台账，不复制余额。

### 匿名提问箱

同样建议 **React 内置应用**：

- 新 `IconId: "anonymous_qa"` + `components/anonymous-qa-app.tsx`。
- 数据：`AiPhoneQaDB` 或 `lib/anonymous-qa-storage.ts`。
- 公共 feed + 我的提问 + 角色提问 + 未答。
- 角色主动提问用后台任务/工具；公开回答进 `SharedQaMemory`，再进 prompt block。
- custom app 做不到“公共问答进所有角色共同记忆”这一层，不要用沙盒做。

### 用户语音消息

不单独做 App；改聊天输入/消息气泡：

- `VoiceRecordModal` 录音 → `storeMediaBase64` 存媒体库 → 消息 `voiceRef/transcript`。
- STT 失败时给“语音条（未转写）”，不要阻塞发送。
- 气泡播放原音 + 显示转写；角色 prompt 只用转写。
