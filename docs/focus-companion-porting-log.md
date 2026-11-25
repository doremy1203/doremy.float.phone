# 角色陪伴专注内置化：移植日志与链路诊断

> 对应方案：[focus-companion-builtin-migration-plan.md](./focus-companion-builtin-migration-plan.md)（M1 里程碑）
> 分支：`feat/focus-companion-builtin`（基于 main `8686c06`，PR 合并后本文件回填 CI 结果）

## 1. 改动清单

| 文件 | 性质 | 说明 |
|---|---|---|
| `custom-apps/focus-companion/index.html` | 新增（源码真身） | v1.9.4 市场包 HTML + 14 处内置化修复（见 §3），是 `focus-companion-source.ts` 的唯一来源 |
| `custom-apps/focus-companion/manifest.json` | 新增（源码真身） | 与市场包 1:1；id 保持 `doris.focus.companion`，老数据无缝延续 |
| `custom-apps/focus-companion/presets.json` | 新增（源码真身） | 1 条角色行为预设，已改写进 `builtin-app-prompts.ts`（本文件留档溯源） |
| `scripts/build-focus-companion-dist.mjs` | 新增 | 生成器：源码 → `lib/builtin-apps/focus-companion-{source,meta}.ts`；含 29 项权限联合类型校验 |
| `lib/builtin-apps/focus-companion-source.ts` | 生成 | 入口 HTML，9 个字符串块 `join("")`（约 0.96M chars） |
| `lib/builtin-apps/focus-companion-meta.ts` | 生成 | manifest（5 工具/2 指令/2 plusActions/1 后台事件）+ `buildFocusCompanionApp()` |
| `lib/builtin-apps/registry.ts` | 修改 | 内置版注册 + 市场同 id 版过滤 + `isFocusCompanionInstalled()` |
| `lib/desktop-config.ts` | 修改 | IconId `"focuscompanion"` + ICONS 条目 + PAGE_3_DEFAULT |
| `components/icon-glyph.tsx` | 修改 | `mdiTimerOutline` 字形 |
| `components/desktop-shell.tsx` | 修改 | 9 个触点（§4） |
| `lib/builtin-app-prompts.ts` | 修改 | 新增 `focus_companion_proactive` 提示词（市场版 presets.json 1:1 迁入，tags 留空=全局生效与市场版一致；老用户由 `mergeMissingBuiltinAppPrompts` 自动补齐，**无需升 BUILTIN_PRESET_VERSION**） |
| `docs/custom-app-to-builtin-porting-guide.md` | 新增 | 通用转换指南 |
| `docs/focus-companion-builtin-migration-plan.md` | 新增 | 专项方案（锁机/APK 优化/壁纸 bug 修复设计） |
| `docs/README.md` | 修改 | 索引补三条 |

## 2. 运行时链路（诊断视角）

```
custom-apps/focus-companion/index.html          ← 源码真身（改这里）
  └─ scripts/build-focus-companion-dist.mjs     ← 权限校验 + 生成
       ├─ lib/builtin-apps/focus-companion-source.ts   （HTML 本体，动态 import）
       └─ lib/builtin-apps/focus-companion-meta.ts     （manifest）
             ├─ lib/builtin-apps/registry.ts            loadAllCustomApps() 注入（工具/指令/事件注册表，市场版让位）
             ├─ lib/desktop-config.ts + icon-glyph.tsx  桌面图标（第三页 + 老用户一次性补位迁移）
             ├─ lib/builtin-app-prompts.ts              角色行为预设（预设编辑器可关）
             └─ components/desktop-shell.tsx            挂载/冷启动/后台工具/后台聊天事件
                  └─ CustomAppRunner → srcDoc iframe → window.AiPhone（宿主桥）
```

- **动态 import**：`FOCUS_COMPANION_ENTRY_HTML` 经 `await import()` 单独成 chunk（构建产物 `chunks/5409-*.js` 1160KB），主 bundle 不含 HTML 实体；`DesktopShell` 挂载时预载 + `openBuiltinFocusCompanion()` 二次兜底，后台工具/聊天事件走 `focusCompanionAppRef`。
- **市场版共存规则**：`registry.loadAllCustomApps()` 过滤运行列表；`openBuiltinFocusCompanion()`/`getInstalledCustomIconIds()` 让市场版接管/去重图标；后台聊天事件仅在未装市场版时注入内置版——与 heartcraft 行为完全一致。
- **后台事件**：manifest `extensions.events` 的 `chat.message.created`（解析 `[陪睡:…]`/`[约专注:…]`）依赖桌面壳 `desktop-shell.tsx` 的内置 app 注入点（1930 行区），已接。

## 3. 应用内修复（index.html，v1.9.4 → 内置版）

### 3.1 壁纸自动生图 bug（迁移方案 §8）
- **根因 A（设计缺口）**：`customWallUse` 只管显示优先级，生图闸门只查 `wallGenOff` → 上传自定义壁纸后生图照旧。
- **根因 B（真 bug）**：奖励壁纸（原 2781 行）只查 `rewardWallpaper`，**漏查 `wallGenOff`** —— 关了总开关照样生图。
- **修复**：新增统一闸门 `canGenWall()`（`wallGenOff` + `customWallUse && !wallGenWithCustom` 两条件），接入全部四条生图路径：`ensureWall`（专注节奏）、`genWallpaper`（单张补生成）、`genSleepWallpaper`（睡眠）、奖励壁纸；新增设置 `wallGenWithCustom`（默认 false）；上传自定义壁纸后 toast 明示「AI 生成已自动暂停」。

### 3.2 设置页壁纸模式化
原「让 AI 生成壁纸」单 chip → 四选一模式：🚫 全部不生成 / 🤖 只用 AI / 🖼 只用我的壁纸 / ✨ AI+我的壁纸（`wallMode()` + `wallMode` action，`wallToggleGen` 移除）。

### 3.3 APK 导出/保存链路（W1-W3）
- `blobDownload` → 先走宿主 `media.download`（APK 原生分块写盘），失败自动落回 `<a download>`；备份导出、学习档案导出、背书 `.rcbak` 三处统一。
- 保存图片面板新增「💾 存进小手机媒体库」（`media.save`）；「下载」按钮接 `media.download`；「复制图片」失败时自动落媒体库（WebView `ClipboardItem` 常不可用）。
- `window.open` 大图预览保留（仅网页环境有效，APK 用媒体库按钮）。

### 3.4 明确不做（本里程碑）
- W4 原生闹钟（`ShellBridge.setAlarm`）：需宿主代理三件套（权限+映射+runner 分支），归入 M2 与 L1 锁机一起做。
- 计时器改造：现有 `Date.now()` 基准 + 恢复重算已无漂移，保持。

## 4. desktop-shell.tsx 触点清单（审计用）

1. import：`focus-companion-meta`（`buildFocusCompanionApp`）+ registry（`isFocusCompanionInstalled`）
2. 模块级：`FOCUS_COMPANION_META_APP`（空 HTML stub）、`loadFocusCompanionEntryHtml()`（动态 import + Promise 缓存）、`FOCUS_COMPANION_ICON_MIGRATION_KEY`
3. state：`focusCompanionApp` + `focusCompanionAppRef` + 挂载预载 effect
4. `isFocusCompanionMarketOverride()` + `getInstalledCustomIconIds()` 去重市场版图标
5. `migrateFocusCompanionIcon()`（第三页空位一次性补位，进迁移链 `withHeartcraft → withFocus → withMemo`）
6. 后台工具执行器：stub → 完整 HTML 替换（`focusCompanionAppRef`）
7. 后台聊天事件：未装市场版时注入内置版 + 前台打开时排除
8. `openBuiltinFocusCompanion()`（市场版优先；HTML 未就绪时先 notice 再异步挂载）+ 聊天卡片冷启动兜底 + `openApp("focuscompanion")` 分发
9. `activeApp === "focuscompanion"` 挂载块（`CustomAppForegroundBoundary` + `CustomAppRunner`）

## 5. 本地验证矩阵（2026-11-21，Windows / Node v24.21.0）

| 检查 | 命令 | 结果 |
|---|---|---|
| 权限联合类型校验 | `node scripts/build-focus-companion-dist.mjs` | ✅ 29/29 在 `CustomAppPermission`（57）内 |
| SDK 一致性 | `npm run check:sdk` | ✅ 无 ❌ 级不一致（5 条既有提醒，与本分支无关） |
| 应用 JS 语法 | 主脚本抽出 `node --check` | ✅（17086 行） |
| ESLint | `npm run lint` | ✅ 688 warnings / 0 errors —— 与 main 基线**完全持平**（预算 ≤689） |
| TypeScript | `npx tsc --noEmit` | ✅ 无错误 |
| 生产构建 | `npm run build` | ✅ 成功；`chunks/5409-*.js` 1160KB 独立异步 chunk（动态 import 生效） |
| check:weixin / check:push | ✅ / ✅ |
| test:photo-wall | ✅ |
| test:life (TZ=UTC) | ✅ 14 个脚本全过 |
| test:life (TZ=America/New_York) | ⚠️ `test-character-id-integration.mjs` 断言失败 —— **main 基线同样失败，失败日志逐字节一致**（Windows + Node 24 的 TZ 环境差异；CI 为 Linux + Node 22，main 上两个时区均绿）。与本次改动无关 |

## 6. CI 记录

- **PR #86**（feat/focus-companion-builtin → main）：仓库 5 个响应 PR 的 workflow（chat-message-chain / custom-app-media / life-engine / widget / diary validation）全部带 paths 过滤，本分支不涉及对应路径 → PR 阶段无 CI。真正的门禁是合并后的 `Validate global comp`（paths 命中 desktop-shell.tsx / lib/** / scripts/**），其完整 job 已在本地 1:1 复跑（§5）。
- **合并 main 后**：（待回填）

## 7. 回滚

- 单 PR revert 即可整体回滚（registry 两行过滤放开后市场版自动接管运行与数据）。
- 用户数据无需迁移：id 未变，`ai_phone_custom_app_data_v1:doris.focus.companion/*` 原地保留。
- `focus_companion_proactive` 提示词补齐是幂等追加，revert 后用户预设中残留一条可手动关掉，无副作用。

## 8f. M2-锁机（feat/focus-lock-m2，PR #87）

- **main CI**：PR #86 squash 合并（ec47d1e）后两条 validate **ALL GREEN** ✅（日志 §6 承诺兑现）。
- **L1 提醒锁**：权限 `device.assist` + 动作 `device.dnd.set`/`device.brightness.set`/`shell.notify`（SDK `AiPhone.device.dndSet/brightnessSet/notify`）；专注开始开勿扰、tick 检测会话结束自动恢复；离开落系统通知。设置页「🔒 锁机（分级）」卡。
- **申请制白名单（§7.5 M2 版）**：`wl_passes` + `wl.review` 审批提示词（JSON 强约束）；申请卡→批复卡→通行证入库；到期回收/信任分（按时+5）；askAwayExcuse 改读通行证；旧手填白名单转未签发档案。
- **查岗 M2 版（§7.6）**：签发时在窗口内随机排查岗（宿主任务系统通知）；页面活着弹「拍照自证」层；照片经 media.pick → sendImageCard 发进聊天室由 TA 亲判；超时未交=被抓（通行证作废+信任分-10+TA 台词）。
- L2/L3/截图判卷/自动踢回前台：随 APK 升级（M3/M4），锁机卡内已标注。

## 8e. 全量文字治理 + 版本统一 v1.10.0

**方法**：全 app 588 个文字块导出逐条定性（303 个 ≥40 字长块）——约 6 成为数据/状态行保留；真正的目标是 31 处说明性内容。
**落地**：
- 与实现不符修正 6 处（壁纸「下载方式只有一个」、通知「不设角标不落系统栏」、预约/晨间缺系统闹钟描述、关于卡 v2.2.0 与 manifest 1.9.4 打架等）；
- me 页 16 卡 → 5 直显（惩罚/壁纸/晨间/预约/帮助）+ 4 折叠（⚙️考核参数 / 💾数据与备份 / 🧰进阶功能 / 📨聊天室·角色工具·权限）；
- 帮助中心：新增「🆕 本次更新 · v1.10.0」卡与旧内容明确区隔；旧「（本版新增/改名）」标记摘除；📅/🗓 两节合并为一节；「📜 旧版本更新记录」从 me 页关于卡整体迁入；
- 版本统一 manifest 1.9.4 → 1.10.0；操作页 16 处长说明压缩为 L1（running/rewards/invite/sleep/appt/goals/me）。
- 验证：me 折叠 4/4 配对 · help 26/26 配对 · node --check ✓ · lint 688=基线 ✓ · build ✓。

## 8d. M2b-2：晨间闭环与语音闹钟的系统闹钟兜底

**问题**：晨间闭环/语音闹钟依赖宿主任务与页内轮询，早上页面必死 → 永远补跑（用户实测「根本触发不了」）。
**修复**：`bookSystemAlarm()` 提为通用函数；`scheduleAlarm`/`scheduleMorning` 增加 `silent` 参数（用户保存时立系统时钟闹钟 + shell.notify，boot 重排静默防重复立）；两处设置卡与帮助中心小节文案更新。
**审计**：全部「页面存活依赖」机制盘点见迁移方案 §9.4 —— 已修 4 项，M3 候选 2 项（全屏唤醒统一件、后台音频前台服务），设计使然不改 4 项。

## 8c. UI 精简与美化（方案见 focus-companion-ui-polish-plan.md，三批已落地）

- 诊断修正：help 视图实际为 9592 字符源码 / 26 个机制小节（此前日志里的「12.8 万字符」是正则溢出捕获到后续代码的误报）。
- **Batch A（CSS-only）**：间距 token（--sp-1..4 + 色彩语义角色变量）、卡片标题加重加字距、`.tiny b` 加粗降噪、键盘焦点可见性、帮助手风琴样式。
- **Batch B+C**：help 改「帮助中心」（26 节全部 `<details>` 折叠 + 顶部快速上手）；入口收敛 album 8→4 / help 5→1 / prompts 5→4 / appt 5→4；me 页 🧰 卡长文压缩为一句。
- 验证：details/summary 26 对齐 · node --check ✓ · lint 688=基线 ✓ · build ✓。

## 8b. M2b 增量：数据兼容防御归并 + 白名单统一决策

- **数据兼容**（回应「旧数据能不能自动合并」）：内置版与市场版 id 相同，数据 key 前缀一致，**本来就不需要合并**；仍按 heartcraft 模式加了 `ensureFocusCompanionBuiltinDataMigrated()` 防御性归并（从数据 key 前缀找回 id 漂移的旧包并按行归并，幂等、canonical 获胜），`CustomAppRunner` 的存储就绪门控泛化为两个内置 HTML 应用共用（挂载前迁移完成，避免读到半态数据）。
- **白名单统一**（回应「白名单有重复」）：确认旧 `settings.whitelist` 是中途离开豁免申诉清单（askAwayExcuse:1544）；决策 = 通行证（`wl_passes`）成为唯一事实源并接管豁免申诉，旧手填条目只读兼容为「未签发档案」，UI 收进通行证档案卡。已写入迁移方案 §7.5。

## 8. M2a 增量：预约到点唤醒（同分支追加提交）

### 改动
- **宿主**：`lib/custom-app-types.ts`（权限 `"device.alarm.set"`）、`lib/custom-app-storage.ts`（白名单）、`lib/custom-app-host-api.ts`（`HOST_ACTION_PERMISSIONS` 加 `shell.notify`/`device.alarm.set` + `runCustomAppDeviceAlarmSet`/`runCustomAppShellNotify` + 任务动作分发 case）、`components/app-market/custom-app-runner.tsx`（SDK `AiPhone.device.alarmSet()` + dispatch 分支）、`scripts/check-custom-app-sdk-consistency.mjs`（NAMESPACES 加 device）
- **应用**（custom-apps/focus-companion/index.html，8 处补丁）：预约创建挂 `bookSystemAlarmForAppt`（系统时钟闹钟，`apptSysAlarm` 默认开）；预约催促与专注进度提醒的宿主任务追加 `shell.notify`（系统通知栏）；`checkAppointments` 到点弹「现在开始/再赖会儿」确认层（`document.hidden` 拦后台）；设置卡加「⏰ 系统闹钟兜底」；manifest 声明 `device.alarm.set`（29→30）
- **设计**：全屏唤醒（自建 AlarmManager + USE_FULL_SCREEN_INTENT + BAL 豁免自动拉前台）定稿于迁移方案 §9.3，M3 随 APK 重打实现

### 诊断结论（为什么之前老迟到）
催促任务只在页面存活时执行 + 应用内通知页面冻结时看不见 + 壳 setAlarm 只是系统时钟 intent。M2a 把三层都补上：系统时钟闹钟（页面死了也响）、系统通知栏（页面活着但用户不在 app 里）、到点确认弹层（用户在 app 里）。

### 验证
check:sdk ✅（仍为既有 5 条提醒，无新增）· lint 688=基线 ✅ · tsc ✅ · build ✅ · 应用 JS 语法 ✅

## 8. 后续里程碑（未包含在本 PR）

- M2：L1 提醒锁 + 申请制白名单（§7.5 审批卡）+ 查岗 M2 版（画像启发式 + 自证拍照）+ ~~W4 原生闹钟代理~~（系统闹钟兜底已随 M2a 落地，见 §8）
- M3：L2 看守锁（覆盖页）+ 壳侧随机查岗调度 / 截图判卷（需重打 APK）
- M4：L3 死锁（Device Admin + 承诺书 + 防绕过）
- M5：Widget + 健康睡眠报告叠加
