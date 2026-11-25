# doris.focus.companion（角色陪伴专注）内置化迁移与优化方案

> 目标：把市场自定义 app `doris.focus.companion` v1.9.4（zip 单文件 1.1MB / 17307 行）转成内置 app，并借内置化完成一批 APK 原生增强。
> 通用流程见 [自定义 App → 内置 App 转换指南](./custom-app-to-builtin-porting-guide.md)，本文只写专项决策。
> 分析基线：main `8686c06`（2026-11-21），zip `doris.focus.companion-1120.zip`（v1.9.4）。

## 0. 迁移可行性结论（一段话）

**这个 app 是迄今最适合内置化的候选**：它已经是标准 SDK 客户端（`window.AiPhone || window.AiPhoneApp`，index.html:299），manifest 完整声明了 29 个权限 + 5 个聊天工具 + 2 条富媒体指令 + 2 个 plusActions + 1 个后台事件（zip manifest.json `extensions`），数据 100% 走 `AiPhone.db`（无 localStorage，23 张 collection、129 处调用），迁移 = 照抄 heartcraft 三件套 + registry + 桌面挂载，app 代码改动集中在「加固与优化」而不是「改造」。

## 1. 仓库现状（2026-11-21 核查）

- main 最新提交 `8686c06`（#85），最新 push 的 `Validate global comp` **success**。
- 最近 3 个 PR #83/#84/#85 全部 **MERGED**。#84 合并进 main 时 global comp 短暂红过一次，#85 已修复。
- 迁移涉及的文件（`lib/builtin-apps/*`、`lib/desktop-config.ts`、`components/desktop-shell.tsx`）**不在 #83/#84/#85 的热点区**，但 desktop-shell.tsx 会被我们改动——开工前先 pull 最新。
- 冲突规避区（近期 PR 高频改动，不要碰）：`lib/reality-bridge/*`、`lib/push-bridge-*`、`lib/personal-push-cloud.ts`、`supabase/functions/push-bridge/`、`public/ai-phone-push/`、`components/reality-bridge-app.tsx`、`components/life/life-engine-app.tsx`、`android-shell .../NativeRealityBridge.kt`、`CallControlService.kt`。

## 2. App 现状盘点（zip v1.9.4）

| 维度 | 内容 |
|---|---|
| 页面 | 首页(专注)/睡眠/数据/我的 四主栏 + 6 个分组页（计划与邀请/学习档案/激励中心/报告与趋势/奖励与账本/内容库）+ 背书分组 + running/reward/lock 等过程页，`TITLES` 约 45 个视图（index.html:1108-1136） |
| 数据 | 23 张 collection：settings/sessions/private_mem/public_mem/punishments/gifts/ledger/sleep_logs/alarms/album/qbank/rewards/sleep_session/stories/gen_log/favorites/appointments/todos/invites/qa_logs/notes/rc_books/rc_cards/rc_logs（index.html:306-317） |
| AI 用途 | 出题/批改/错题归因、壁纸生图 ×3 类（专注/睡眠/奖励）、哄睡台词、故事、惩罚台词、答疑助手、背书卡片生成；每次调用留档 gen_log |
| 聊天耦合 | 5 个共享工具（focus-stats/sleep-last/add-todo/make-appt/invite-sleep，`AiPhone.tools.handle` 注册于 index.html:17091+）、`[陪睡:…]`/`[约专注:…]` 指令解析（16325+）、`chat.message.created` 后台监听（17220）、`chat.sendCard`/`requestReply`/`writeHistory` |
| 激励经济 | wallet.pay（惩罚扣款/礼物）、专注币、心愿、连坐、账本 |
| 提示词 | 应用内 PROMPT_DEFS 约 90+ 条（本地覆盖式编辑器，`prompts` 视图）+ presets.json 1 条角色主动行为 preset |
| 计时 | `Date.now()` 基准 + 1s tick + 恢复重算（不漂移）；闹钟 `setInterval(20s)` 仅页面存活时有效 |

## 3. 内置化七步（专项取值）

| 步骤 | 本 app 的取值 |
|---|---|
| 1. source | `lib/builtin-apps/focus-companion-source.ts`。**1.1MB 超过 heartcraft 的 600KB，必须动态 import**（openApp 分支与后台事件接入点两处 `await import()` + Promise 缓存），否则主 bundle 直接胖 1MB。生成脚本按指南 Step 1。 |
| 2. meta | `lib/builtin-apps/focus-companion-meta.ts`。id **保持 `doris.focus.companion` 不变**（老数据无缝延续）。zip manifest 里 icon.png 实际缺失，补一枚图标 dataUrl 进 `assets`。 |
| 3. registry | `registry.ts` 过滤市场同 id 版 + `getBuiltinCustomApp` 分支。 |
| 4. 桌面 | IconId `"focuscompanion"`，放 PAGE_1；desktop-shell 四处照抄 heartcraft。 |
| 5. 后台事件 | `chat.message.created`（解析角色主动发的两张卡）——desktop-shell.tsx:1873 接入点同步。 |
| 6. 数据迁移 | id 不变 → 数据 key 前缀（`ai_phone_custom_app_data_v1:doris.focus.companion/*`）本来就是同一份，**无需合并、天然共享**。仍内置防御性归并 `ensureFocusCompanionBuiltinDataMigrated()`（heartcraft 同款）：兜住装过 id 漂移的旧包的极少数情况，按行归并进 canonical id，幂等不覆盖。 |
| 7. preset 注入 | presets.json 的 `focus-companion-proactive`（1 条，角色主动约专注/陪睡的行为约束）改写进 `APP_PROMPT_DEFINITIONS`，tags 建议 `["focus_companion"]`，`appTags` 链路（llm-prompt-assembler.ts:616）保证只在本 app 调用时生效；同步 builtin-preset prompt_order + 升 `BUILTIN_PRESET_VERSION`（会重置用户预设副本，发版说明里要写）。应用内 90+ 提示词**保留应用内编辑器**（自成体系、和 UI 绑定深），不建议全量迁入宿主预设——预设页会爆炸。 |

## 4. 内置化后的深度接入优化（本次迁移的增值部分）

### 4.1 提示词与模型链路（已通，做两个小升级）
- AI 调用自动获得宿主级联配置（`resolveCustomAppApiConfig`：custom_app 槽位 → 角色槽位 → 全局默认），**API key 永不进 iframe**——app 现有「请先配置生图 API」的兜底文案可改为引导宿主设置页。
- 建议给 manifest 加 `promptProfiles`（`custom-app-host-api.ts:656-683`）：出题/批改类调用排除角色扮演类长预设（history/output 裁剪），省 token 且防人设污染判卷。

### 4.2 聊天与监督闭环（已通，补齐面）
- `chat.requestReply`（已有 6 处）+ `tasks.schedule` 组合：专注结束时请角色「主动评价」；惩罚触发时请角色宣布（punish.line 提示词已有）。
- plusActions 已注册「专注邀约/睡眠陪伴」，聊天 + 面板直接可达（launchContext 已带角色）。

### 4.3 记忆系统升级（新增价值）
- 现只用 `memory.addTimeline`（syncTimeline）。内置化后补：`memory.search`（周报/月报引用历史时间线）、`memory.readLongTerm`（角色了解你的学习习惯）、学习档案页给错题写 `memory.add`（角色下次聊天能提到你上次错的点）。

### 4.4 语音能力（新增价值）
- 已用 tts/readProfiles。补：**背书模块接 `voice.stt`**（口语背诵——读出答案判分，比打字快）；睡眠页接 `voice.record`（鼾声/梦话检测可后置）。宿主代播链路（`custom-app-host-api.ts:619-664`）已在壳里验证过。

### 4.5 现实桥/健康数据（最大增值点，只读不改桥）
- 消费 `AiPhone.bridge.readState` + `REALITY_BRIDGE_DATA_EVENT`（runner:1999 广播），把**真实步数/使用时长/睡眠数据**接进报告：
  - 睡眠报告页叠加宿主 `HealthBridge.readSleep`（MainActivity.kt:2084）数据 →「设备记录你 0:43 才睡」级别的报告（需要宿主在 bridge state 里透出，见 §7 桥接件）。
  - 专注锁机期间消费 `getPerceptionSnapshot`（:1744，含前台应用名）供角色「查岗」台词。
- **规则**：只读，不写桥；桥规则编辑器属热点区不要动。

### 4.6 通知/推送分层
- 页面开着：`notifications.create`（横幅）。
- 壳前台但 app 未开：宿主 `window.AndroidShell.notify`（lib/shell-notify.ts）——经宿主代理 actions。
- 杀进程：`tasks.schedule` 的到期回调 + 个人云推送（push-client → PushService.kt WebSocket），现状已可用；专注会话开始时登记一个「专注结束」task，到点即系统通知。

### 4.7 Widget（后置 P2）
- 「专注倒计时/今日专注币」做 Android 桌面小组件：`PhoneWidgetSecure.setProfiles`（MainActivity.kt:2778）由宿主侧接，app 侧只需把状态经宿主 action 上报。列入锁机里程碑之后。

## 5. Web-only 功能清单（APK 不适用/不稳，逐一替换）

| # | 现状（index.html 行号） | APK 上的问题 | 替换方案 |
|---|---|---|---|
| W1 | `<a download>` + Blob 导出：备份 blobDownload:9832、学习档案导出:13181、背书 .rcbak:15384 | WebView 不接下载管理器，**点击无反应** | 改 `AiPhone.media.save`（宿主走原生存档/分块桥 beginChunkedFile:2587），导出后 toast 媒体路径；分享走系统分享（宿主代理） |
| W2 | 图片复制 `navigator.clipboard.write(ClipboardItem)`:2600 | WebView 权限弹窗不稳 | 主路径 `media.save`；长按图片存媒体库 |
| W3 | `window.open`+`document.write` 看大图:2607-2609 | 弹窗被 WebView 拦 | 改为媒体库查看（album 已有查看器） |
| W4 | 闹钟 `setInterval(checkAlarm, 20000)`:9787 仅页面存活有效 | app 未开=闹钟失效 | **改调宿主原生闹钟** `ShellBridge.setAlarm`（:1910，已存在！），网页环境回退 setInterval |
| W5 | 专注/睡眠计时依赖页面存活 | WebView 后台冻结定时器 | 计时基准已是 Date.now()（恢复不漂移，此项可保留）；但「到点提醒/自动结束」改 `tasks.schedule` 宿主任务 + 壳前台服务（BackgroundEnhancementManager:2359） |
| W6 | `document.execCommand('copy')` 降级路径:5102 等 | 可用但 deprecated | 保留（有 toast 兜底），不阻塞 |
| W7 | `media.pick` 文件导入 | WebView file input 可用但体验差 | 已走宿主 API，确认 APK 真机路径 |

**反向清单（锁机属 APK-only，网页环境降级为应用内锁）见 §7。**

## 6. 页面与性能优化（迁移时顺手做）

1. **加载**：动态 import source（§3 步骤 1）；`CustomAppRunner` 对同一 app 的 srcDoc 做模块级缓存（HTML 字符串不变，别每次挂载重算资源改写）。
2. **渲染**：app 内 `render()` 是全量 innerHTML 重建（17k 行），已有滚动/焦点保持补丁；album 图片已做 40ms 延迟填充。优化项：hub 页签切换改为缓存各 hub DOM + `display:none` 切换（重构量中等，P1）。
3. **主题联动**：宿主主题变量经 launchContext 传入，app 的 `sleep-theme` 机制保留。
4. **键盘/视口**：APK WebView iframe 内 100vh 与软键盘收起需真机回归（iframe resize 事件已由宿主边界处理，验收清单加一项）。
5. **保活**：锁机/专注期间建议 `setBackgroundEnhancementMode(true)`（壳已有），结束即关。

## 7. 锁机功能设计（新增，APK 主场）

### 7.1 市面严格锁机软件的机制盘点（本方案的参照系）

| 产品 | 核心机制 | 借鉴点 |
|---|---|---|
| Forest | 承诺制：中途退出→树死→扣代币 | 「退出即惩罚」+ 预授权扣款 |
| One Sec | 强制延迟+呼吸页，打断冲动 | 「冷静期」：退出锁机要先等 5 分钟 |
| 番茄ToDo 严苛模式 | 系统级强锁：倒计时内禁退出，强行退出有惩罚 | 前台服务倒计时 + 退出惩罚 |
| AppBlock / StayFree | 无障碍服务监控前台应用，非白名单即封锁/限额 | 前台应用检测 + 全屏封锁页 |
| Digital Wellbeing 专注模式 | 系统级灰置禁用选中 app | 依赖系统权限，我们用覆盖页模拟 |
| Android 屏幕固定 | startLockTask 钉死单应用 | 提示用户开启「屏幕固定+解除需 PIN」作为最高强度档 |
| 寿命锁/连坐类 | 社交承诺（同伴连坐） | 本 app 独有的「角色连坐+心愿惩罚」——比社死更温柔但同样有痛感 |

### 7.2 现有资源（零成本可复用）

- **壳侧**：无障碍连接检测 `isAccessibilityConnected`:2301、悬浮窗 `requestOverlayPermission`/`CallOverlayService`:2287（全屏覆盖页现成架构）、使用统计 `readUsageStats`:1763、`openApp`:1905、勿扰 `setDnd`:1898、亮度 `setBrightness`:1894、原生闹钟 `setAlarm`:1910、截屏查岗 `captureScreenshot`:2330 + `scheduleBackgroundCheckIn`/`CheckInService`:2372、感知快照 `getPerceptionSnapshot`:1744（含前台应用）、后台保活 `setBackgroundEnhancementMode`:2359、前台通知 `notify`:2126。
- **app 侧**：应用内惩罚锁 `S.lock`（quiz/pay/gift 三类，renderLock:4652）、惩罚库+补救机制、**旧白名单 `settings.whitelist`**（手填名称，唯一用途是专注中途离开时的豁免申诉「我去的是白名单应用」，askAwayExcuse:1544）、wallet.pay 自动扣款、角色监督台词 punishTexts、连坐/心愿经济。
- **沙盒边界**：app iframe 不能直调 AndroidShell（nonce 拒绝），全部经宿主代理（指南 §5 三件套）。

### 7.3 分级设计：L0→L3（强度递进，用户逐级解锁授权）

**L0 应用内锁（已有，网页/APK 通用）**
现状即 L0。改进点：锁屏页显示「TA 在看着你」的角色立绘 + 倒计时；quiz 惩罚接宿主出题链路。

**L1 提醒锁（壳 assist，MVP）**
专注开始（可选开关，默认询问）：
- `setDnd(true)` + `setBrightness(低)` + 前台服务常驻通知（倒计时进度）；
- 离开小手机 → 感知快照检测 → 角色来一条系统通知（「你跑去 XX 了？我看着呢」）+ app 内记录违规次数（喂给惩罚/连坐）；
- 网页环境：自动降级 L0。

**L2 看守锁（无障碍+覆盖页，核心档）**
- 前置授权引导页：无障碍服务 + 悬浮窗权限（壳已有申请函数）；
- 无障碍服务监控前台应用：**通行证白名单**（§7.5，向 TA 申请签发；通话/来电系统级放行）外一律弹**全屏封锁覆盖页**（复用 CallOverlayService 架构：角色立绘 + 锁倒计时 + 四个出口按钮）：
  1. 「我错了」→ 记违规 + 角色台词，返回；
  2. 「答题换 10 分钟」→ 复用 quiz 出题链路（限制每日次数，防刷）；
  3. 「向 TA 申请通行证」→ 打开申请表单（§7.5，审批走聊天室）；
  4. 「提前结束」→ 触发惩罚链（见 L3 惩罚执行）+ 冷静期。
- 通话场景放行：检测到通话应用/来电自动暂停封锁（参照 CallControlService 的通话检测）。

**L3 死锁（承诺制，严格档）**
- **承诺书 UI**：开始前显示预授权内容（扣款金额/加练题数/连坐对象），指纹/密码确认；
- **惩罚预授权**：主动退出未达时长 → 自动执行（wallet.pay 扣款进账本 + 错题加练 + 心愿扣减 + 角色失望台词 + chat.requestReply 让 TA 说一句）；
- **防绕过**（市面软件全部痛点，逐条覆盖）：
  1. 改系统时间：计时基准改 `SystemClock.elapsedRealtime()`（壳侧），双钟比对，异常即惩罚；
  2. 杀进程/强停：锁会话状态写壳侧 SharedPreferences（新 FocusLockService 持有）+ `AlarmManager.setExactAndAllowWhileIdle` 兜底到点恢复（RECEIVE_BOOT_COMPLETED 开机还原锁状态）；
  3. 卸载重装：Device Admin 激活后 `DevicePolicyManager` 可做卸载保护（卸载需先取消激活→弹确认）；Device Admin 同时提供 `lockNow()`（一键锁屏）与密码策略；
  4. 关无障碍：检测无障碍断开 → 立即 L1 通知 + 视同违规；
  5. 冲动退出：退出必须过「冷静期 5 分钟 + 答题」双闸（One Sec 模式）；
  6. 最高强度：引导用户开「屏幕固定」（锁进小手机，解除需锁屏 PIN）——系统级，零开发成本，设置页放引导卡片。
- **查岗（本 app 特色，强烈建议做）**：锁机期间 `scheduleBackgroundCheckIn`/`captureScreenshot` 让 TA 定期查岗，截图+感知快照喂给角色，TA 在聊天室点评（照片只进聊天室不落公开存储，延续现有隐私边界）。

### 7.4 数据与桥接链路

```
app iframe ── AiPhone(新 device.* actions，宿主代理) ──> 宿主 desktop-shell
                │                                            │ lib/device-action/bridge.ts 新封装
                │                                            ▼
                └── 降级路径：AiPhone.db 存锁会话镜像      AndroidShell(new FocusLockBridge)
   壳侧：FocusLockService（前台服务）+ FocusLockBridge（SharedPreferences 会话态）
         + AlarmManager 精确闹钟 + BootReceiver 开机还原 + AccessibilityService 前台监控
         + FocusBlockOverlayService（覆盖页，复用 CallOverlayService 权限与主题注入）
宿主→app：事件 `device.lock.changed`（经 REALITY_BRIDGE_DATA_EVENT 同款广播，runner:1999 模式）
```

宿主/壳改动清单（固定三件套 + 壳）：
1. `lib/custom-app-types.ts`：权限加 `device.lock`、`device.alarm`（或并入现有 device 组）；
2. `lib/custom-app-host-api.ts`：`HOST_ACTION_PERMISSIONS` 映射 `device.lock.start/stop/status`；
3. `custom-app-runner.tsx`：handleBridgeRequest 分支 → `lib/device-action/bridge.ts` 新封装（非壳环境返回 `{supported:false}` 供降级）；
4. `MainActivity.kt`：`FocusLockBridge` 方法组（start/stop/status/onLockEvent 回调 WebView）——**需要重打 APK**（CI `Build Android Shell` workflow 已就绪）；
5. app 侧：设置页「锁机」卡（分级开关+授权引导+承诺书）、running 页锁状态徽标、惩罚链对接。

### 7.5 白名单申请制（角色审批签发通行证）

**原则：白名单不再是静态设置清单，而是 TA 签发的临时通行证。锁机期间要用任何白名单应用，都得向 TA 申请，TA 批了才生效。**

**与旧白名单的关系（避免两套并存）**：应用里本来有一个手填的 `settings.whitelist`（唯一用途：专注中途离开时说「我去的是白名单应用」换一次豁免，`askAwayExcuse`:1544，每场限 3 次）。统一规则：
- **通行证成为唯一事实源**：`wl_passes` 里 `status=active` 的条目 = 中途离开豁免的合法依据（有签发时间/时长/用途可查，TA 能对质）；`askAwayExcuse` 改读通行证列表，不再读手填清单。
- **旧手填条目只读兼容**：老数据里的 `settings.whitelist` 保留在存储里并显示为「未签发的档案」，不丢但不再直接生效；要继续用就向 TA 申请一次（理由栏预填旧条目）。
- **入口合并**：设置页旧的「白名单」编辑 UI 收进通行证档案卡，不再提供手填新增。

**申请入口（三处）**
1. L2 封锁覆盖页第四个按钮「向 TA 申请通行证」（被拦时当场申请）；
2. 锁屏页 / running 页「申请通行证」；
3. 设置页通行证档案卡。

**申请单**（聊天卡 `apply_for_whitelist`，走 `extensions.chat.directives` 同款卡协议）
- 应用：包名+应用名（APK 经壳枚举已安装应用/使用统计带出；网页降级为手填名称）；
- 用途：预设理由 chips（查单词 / 查攻略 / 回个消息 / 导航）+ 自由文本；
- 时长：10/15/20/30 分钟单选（上限 30，超出 TA 自动砍）；
- 自愿条款：默认勾选「接受随机查岗，被抓现行接受惩罚」——这就是 L3 承诺书在白名单上的微缩版，预授权的法律基础。

**审批链路（复用聊天室，角色是审批人）**
1. app `chat.sendCard` 发申请卡 → `chat.requestReply` 请 TA 审批；
2. 审批判定走 `AiPhone.ai.chat`（自动用 custom_app 槽位模型配置），专用审批提示词进 `APP_PROMPT_DEFINITIONS`（tags `["focus_companion"]`）。输入：申请单 + 本次专注已进行时长/任务完成度 + 近 7 天违规记录 + 信任分 + 当前通行证余量 + 角色人设上下文；输出强约束 JSON：`{decision: approve|reject|counter, grantedMinutes, conditions[], reply}`（解析失败重试一次，仍失败按 reject 兜底并在卡片说明）；
3. TA 以**批复卡**回聊天室：`approve`（通行证生效）/ `counter`（「只准查词典，15 分钟，超时按违规」）/ `reject`（人设化拒绝台词 + 理由）；批复卡上的按钮只有「收到」（写回历史防重复弹卡）——**审批权在 TA，用户没有自批入口**。

**通行证数据模型**（新 collection `wl_passes`）
```
{ id, package, appName, reason, grantedMinutes, conditions: string[],
  issuedAt, expireAt, sessionId,               // 会话级：锁机结束全部过期回收
  status: active|expired|revoked|violated,
  checkin: { mode: 'photo'|'screenshot'|'both', minGapMin, maxGapMin, lastCheckAt },
  trustScore, violations: [] }
```
- **信任分**：良好用完 +5，被抓现行 -15，写入审批提示词变量——低信任的 TA 会倾向 counter 缩时长或直接 reject；申诉成功返还。
- **常驻豁免（可选）**：TA 可在批复时给词典类「长期通行证」标记， punished 后收回；默认严格制=每次申请。

**防滥用**：单次会话申请上限（默认 3 次，超出 TA 自动驳回）、被拒后 10 分钟冷却、被抓 → 通行证立即 revoke + 本次会话禁再申请同应用、审批提示词明确「同类理由重复申请要警惕」。

### 7.6 通行证使用期随机查岗（被抓现行 → 惩罚）

**间隔设置**：TA 批复通行证时拟定默认间隔，用户可在设置里限定范围（min/max 分钟，如 5-15）；壳侧调度每次在该区间取**随机值**，抽查完再掷下一次直到通行证过期——随机化防「掐表回专注」规避。

**调度与采集**
- M2（纯 web）：`tasks.schedule` 随机时刻抽查；采集前台应用（宿主代理 `getPerceptionSnapshot`:1744，含前台应用名）+ `readUsageStats`:1763 使用画像；
- M3（壳侧）：`FocusLockService` 用 `AlarmManager.setExactAndAllowWhileIdle` 持续掷随机时刻（WebView 冻结也照抽）+ 可选 `captureScreenshot`:2330，经 `device.lock.checkin` 事件推回。

**判定管线（三通道，成本从低到高，可叠加）**
1. **使用画像启发式**（零成本先跑）：连续前台时长超阈值、无切出切回（查词典是短促多次）、实际行为与申请理由不符（申请「查单词」却连刷 15 分钟）→ 疑似在玩；
2. **截图判卷**（可选开关，需视觉模型）：截图 → `AiPhone.ai.chat` 带图判卷（宿主聊天引擎已支持图片消息），提示词只回 `{verdict: studying|playing|unclear, note}`，unclear 不罚；
3. **自证拍照**（兜底且最有人格味，M2 即可用）：TA 在聊天室发查岗卡 + `requestReply` 催：「10 分钟内拍一张你正在干嘛的照」→ 用户 `media.pick` 拍照回传 → 角色判卷；超时未交 = 违规。

**被抓现行惩罚链（申请单已预授权，自动执行不确认）**
1. 通行证立刻 `revoked`，壳侧踢出当前应用（`openApp` 回小手机）+ 覆盖页锁定 + 违规 +1；
2. 按惩罚库执行（quiz/pay/gift），wallet.pay 自动扣款进账本；
3. TA 发「抓包卡」到聊天室：证据截图 + `punishTexts` 池台词（证据只进聊天室，不进公开存储，延续现有隐私边界）；
4. `trustScore` -15、本次会话白名单冻结、冷却期后才可再申请；连坐/心愿扣减照常。

**误伤救济**：查岗卡带「申诉」按钮 → 用户提交说明 → TA 复核（`memory.addTimeline` 留痕，成功则不扣分不撤惩罚但 TA 可以嘴硬两句）——监督有威严，也有人情味。

### 7.7 实施里程碑

| 里程碑 | 内容 | 是否重打 APK |
|---|---|---|
| M1 | 内置化主体（§3 七步）+ 壁纸修复（§8）+ W1-W4 替换 | 否 |
| M2 | L1 提醒锁（纯 web 层串已有壳方法）+ 惩罚链打通 + **申请制白名单与查岗 M2 版**（§7.5 审批卡 + §7.6 画像启发式/自证拍照 + tasks.schedule 随机抽查） | 否 |
| M3 | L2 看守锁（覆盖页 + 无障碍监控）+ **壳侧随机查岗调度 / 踢出应用 / 截图判卷** | 是（新增服务） |
| M4 | L3 死锁（Device Admin + 承诺书 + 防绕过） | 是 |
| M5 | Widget + 健康睡眠报告叠加 | 是（widget） |

## 8. 壁纸自动生成 bug：诊断与修复

### 8.1 现象
用户已上传自定义壁纸，app 仍持续自动生图（消耗生图额度）。

### 8.2 根因（zip v1.9.4，两类叠加）

**根因 A · 设计缺口（主因）：自定义壁纸与生图开关是两套独立逻辑**
- 上传自定义壁纸只影响**显示优先级**：`renderWall`（index.html:2275-2279）——`customWallUse=true` 时铺全局背景，但仅此而已；
- 生图的唯一总闸是 `wallGenOff`（设置里另一颗独立 chip「让 AI 生成壁纸」，:6440）：专注壁纸 `ensureWall`:2369、睡眠壁纸 `genSleepWallpaper`:3093 都只查它；
- 即：**上传壁纸 ≠ 停止生图**。图照常在后台生成、存进壁纸库，而前台显示的一直是你的自定义壁纸 → 用户感知「我明明自定义了，它还在偷偷生图」。设置页文案（:6438）只说了「专注/睡眠中的专属壁纸仍优先显示」，没有提示生图继续。
- 触发链齐全：专注开始生成第 1 张（ensureWall ①），每完成一项任务解锁并预生成下一张（②③节奏，:2358-2414）；睡眠开始即自动生成（:3025）；boot 时还会对上次没留下壁纸的睡眠会话**静默补生成**（:16121）。

**根因 B · 真 bug：奖励壁纸漏掉总闸**
- 奖励壁纸生成处（:2781）只查 `cfg('rewardWallpaper')`（默认 true）+ API 可用性，**不查 `wallGenOff`**——即使你在设置里关掉了「让 AI 生成壁纸」，领取奖励时照样生图。这是三链路中唯一漏闸的。

### 8.3 修复方案（随 M1 落地）

```js
/* 1. 统一生图闸门（新增，替换三处散查） */
function canGenWall() {
  if (cfg('wallGenOff')) return false;
  if (cfg('customWallUse') && !cfg('wallGenWithCustom')) return false;  // 新设置项，默认 false
  return true;
}
// ensureWall:2369 / genSleepWallpaper:3093 / 奖励壁纸:2781 → 全部改走 canGenWall()
```

```js
/* 2. 上传自定义壁纸时的联动询问（wallCustomSet 处，:2504 附近） */
S.settings.customWallUse = true;
if (!cfg('wallGenOff')) toast('已启用自定义壁纸。AI 壁纸生成仍开着——要我顺便关掉吗？（设置→壁纸可随时改）');
```

```js
/* 3. 设置页「壁纸」卡重构为三选一（:6436-6440）：
   [AI 生成] [只用我的壁纸(不生图)] [AI 生成+我的壁纸兜底]
   三个 radio 写 wallGenOff/wallGenWithCustom 两个位，文案明说「生成会消耗生图额度」。 */
```

4. 兜底清理：boot 静默补生成（:16121）在闸门内自然被拦；「生成记录」页给后台静默生成的条目加「后台生成」标记，可追溯。

### 8.4 结论回答你的疑问
**不是链路问题，是设计缺口 + 一处漏闸**：你上传自定义壁纸并不会关掉生图（真正的总开关是设置里那颗独立的「让 AI 生成壁纸」chip，藏得深、和壁纸上传不在一个心智位置）；同时奖励壁纸漏掉了这个总开关。迁移时按 8.3 统一闸门即可根治。

## 9. 到点唤醒设计（M2a 已落地 + M3 全屏唤醒规划）

> 需求：角色预约的专注老是迟到 —— 要系统闹钟提醒，最好能自动唤醒拉起前台强制开始。

### 9.1 链路诊断（为什么老迟到）

| 层 | 现状 | 洞 |
|---|---|---|
| 催促调度 | `scheduleAppt` 已走 `tasks.schedule`（宿主任务，页面活着时由 desktop-shell 的 `runDueCustomAppTasks` 执行） | WebView 后台冻结/页面关闭 → 任务不跑 |
| 通知落点 | `notifications.create` → `createCustomAppNotification` 只进**应用内通知中心**（kv 存储 + 站内横幅） | 就算任务跑了，APK 通知栏/锁屏什么都看不到 |
| 壳 setAlarm | `ACTION_SET_ALARM`（打开系统时钟让用户确认），不是自建 AlarmManager | 不能直接当唤醒器用 |

### 9.2 已落地（M2a，纯 web 层，随 PR #86）

1. **系统闹钟兜底**：宿主新增 `device.alarm.set` action（三件套：权限 `"device.alarm.set"` + `HOST_ACTION_PERMISSIONS` + runner 分支 + `runCustomAppDeviceAlarmSet` 包装 `lib/device-action/bridge.ts` 的 `setAlarm`，SDK 暴露 `AiPhone.device.alarmSet()`）。预约创建（`createAppt`，覆盖邀约/工具/编辑/失约补救全部路径）时在开始时间立系统时钟闹钟（默认开，设置卡可关；取消/改期不撤旧闹钟，文案已说明）。
2. **催促落系统通知栏**：宿主任务动作新增 `shell.notify`（`runCustomAppShellNotify` → `lib/shell-notify.ts sendShellNotification` → `window.AndroidShell.notify`，权限 `notifications.write`）。预约催促（scheduleAppt）与专注中进度提醒（scheduleNotices）都追加了这条动作 —— 页面活着但用户在别处时，通知栏/锁屏直接可见；网页/无壳 no-op。
3. **到点确认弹层**：`checkAppointments` 检测到新催促点跨过时（页面前台、无锁、未在专注中）弹「⏰ 该开始了」sheet：[▶️ 现在开始]（复用 `apptStart`，自动 closeAllSheets）/ [💤 再赖会儿]；后台隐藏 iframe 由 `document.hidden` 拦截，回前台靠 20 秒补判接着催。

### 9.3 M3 全屏唤醒（需重打 APK，Kotlin 设计已定稿）

- **自建 AlarmManager**：`FocusWakeReceiver` + `AlarmManager.setAlarmClock`（`setExactAndAllowWhileIdle` 之上的系统级表达，通知栏显示闹钟图标、Doze 下必达）；锁会话态写 SharedPreferences + BootReceiver 还原。
- **全屏意图通知**：通知渠道 `focus_wake` 声明 `USE_FULL_SCREEN_INTENT`（Android 14 需用户在设置里给「闹钟和提醒」特殊权限 —— app 设置页加引导卡 + `openSystemSettings('alarm')`）；锁屏时直接全屏显示「TA 等你开始」+ 响铃 + 震动，点击进小手机预约页。
- **自动拉起前台**：壳持有 `SYSTEM_ALERT_WINDOW`（悬浮窗）→ 满足 Android 10+ 的 BAL（后台启动 Activity）豁免，Receiver 可直接 `startActivity` 拉起 WebView 到前台；无障碍服务（CallControlService）已激活时同样豁免，双保险。
- **宿主接口**：新增 `device.wake.schedule({at, title, body})` / `device.wake.cancel({id})`（三件套 + 壳 FocusWakeBridge），替换 9.2-1 的系统时钟闹钟（系统时钟那条保留为降级路径）。
- **强制开始闭环**：拉起后直达预约页 + 到点弹层 + 「3 次催促没开始就开罚」惩罚链（已有）→ 迟到从「提醒失败」变成「一定会被 TA 抓住」。

### 9.4 页面存活依赖机制 · 全面审计（M2b-2 已补齐两项）

| 机制 | 原依赖 | 症状 | 处置 |
|---|---|---|---|
| 预约专注催促 | 宿主任务（页面活） | 人不在 app 前催促全哑 | ✅ M2a：系统闹钟兜底 + shell.notify + 到点确认弹层 |
| **晨间闭环（TA叫早）** | 宿主任务 | 早上没人开手机 → 永远补跑 | ✅ M2b-2：保存时立系统时钟闹钟 + shell.notify（boot 重排静默，防重复立） |
| **语音闹钟** | 页内 20s 轮询 + 宿主任务 | 同上 | ✅ M2b-2：同款系统闹钟兜底 + shell.notify；页内语音唤醒保留（页面开着时体验更好） |
| 专注中进度提醒 | 宿主任务 | 冻结时丢提醒 | ✅ M2a：追加 shell.notify |
| 睡前故事后台播放 | WebView 音频 | 锁屏/切后台即停（help 已注明） | M3：壳侧前台服务媒体播放 |
| 睡眠静止判定 | 页面存活 | —— | 设计使然（要测的就是屏幕交互），不改 |
| 专注计时恢复 | Date.now() 基准 | —— | 无漂移，不改 |
| 惩罚超时自动执行 | 页内 timer | —— | 用户被困锁定页（页面必活），合理 |
| TA 离线主动消息 | 宿主 push-bridge | —— | 热点区（#83/#84），不在 app 内改 |

**M3 唤醒统一件**：FocusWakeReceiver（setAlarmClock + USE_FULL_SCREEN_INTENT + BAL 豁免自动拉前台）一次覆盖晨间/闹钟/预约三个场景，替换系统时钟兜底。

## 10. 机型适配：main/test 两方案对比与合成策略（诊断结论，待实施）

### 10.1 根因
- main：`--phone-screen-width` 默认**固定 390×844**（tokens.css），仅 `@media (max-width:500px)+触屏` 才全屏 → **CSS 视口 >500px 的设备（大屏手机/折叠屏展开/平板）全部落进固定壳** → "别人手机不兼容"。
- test：`--shell-zoom` 缩放体系（触屏一律全屏 + ≥520 短边等比放大 + stable 灰度 + 首屏防闪内联脚本 + `--status-bar-drop` 状态栏校准旋钮）。**用户实测缺陷：min(宽比,高比) 等比 → 必然一轴留白 = "撑不满/盖不到刘海"**；且 drop 默认 0 需手动校准。

### 10.2 照片墙安全性论证（慎改的答案）
- 画布世界尺寸 `wallWorld` 是**用户存库数据**（默认 2400×3000，与屏幕宽度完全解耦，photo-wall-storage.ts:114）；
- 涂鸦/贴纸存世界坐标，渲染经 `renderedScale = rect.width/offsetWidth` 换算 —— canvas.tsx:355 **注释里明确建模了"画布缩放 × 壳缩放"**；
- 有专属回归测试 `test:photo-wall`（sticker sizing）。
- **结论：任何缩放方案都不碰已存照片墙数据**；唯一要保证的是缩放后壳内逻辑宽仍按 390 设计稿等效（canvasZoom 与壳缩放换算已支持）。

### 10.3 合成方案（宽度驱动铺满）
- **≤520 短边手机：维持 main 现状（100vw/100dvh），零变化** —— 你的手机、照片墙现有行为都不动。
- **≥520 触屏（平板/折叠屏/大屏手机）+ beta 灰度**：`z = innerWidth / 390`（**宽度驱动**，弃 test 的 min() —— 消除"撑不满"），壳宽 `100vw/z`、高 `100dvh/z`（高度靠 UI 弹性拉伸），`viewportFit: "cover"`（两分支都有）+ 保留 main 的 `env(safe-area-inset-top)` 状态栏定位（**不跟 test 删**）+ 移植 `--status-bar-drop` 校准旋钮。
- **老 WebKit 探针**（zoom:var 不生效 → data-zoom-fallback → 回退固定壳）照 test 移植。
- **stable 渠道默认不缩放**（test 灰度机制照搬），转正时改缺省。

### 10.4 移植面与风险
| 文件 | 工作量 | 风险 |
|---|---|---|
| `lib/mobile-shell.ts` | 整文件移植（109 行，改 zoom 公式为宽度驱动） | 低 |
| `app/layout.tsx` | 内联脚本移植（首屏防闪 + 探针） | 低 |
| `styles/phone-shell.css` | zoom 块移植 + main 的 500px 断点扩为触屏全量 | 中（332 行 diff，含 test 其他改动需甄别） |
| `components/desktop-shell.tsx` | **getShellZoom/getGridGeometry/pointerToGridCell 按本分支结构重建** —— test 与本分支该文件分叉 969 行，不能整搬 | 高（需映射重写 + 拖拽矩阵回归） |
| 验证 | 视口矩阵模拟（390/412/600×1000 折叠/768 平板/桌面）× 照片墙涂鸦回归 × `test:photo-wall` | — |

## 10. 风险与回滚

- bundle 体积：动态 import 后主包仅 +meta；若未来再超 2MB，考虑把 source 移到 `public/` 用 fetch+Cache-Control 加载（牺牲离线首开，暂不推荐）。
- 市场版共存期：registry 过滤保证不双注册；回滚 = revert registry 两行 + 重新发布市场版。
- 预设版本：`BUILTIN_PRESET_VERSION` 递增会重置用户预设副本——选在版本公告里说明。
- 锁机权限敏感：Device Admin/无障碍引导页要写清用途与退出方式（对应 docs/隐私与权限说明.md 更新）。
