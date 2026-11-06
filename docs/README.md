# 文档导航与维护约定

本目录同时包含面向使用者的说明、架构/数据边界说明、部署脚本和历史开发台账。请优先从根目录 [README](../README.md) 进入，不要把所有文件都当作普通用户教程。

## 按读者查找

### 普通使用者

- [隐私、数据流与 Android 权限说明](./隐私与权限说明.md)：本地数据、外部服务请求、权限和隐私边界。
- [Android Shell 诊断](../android-shell/DIAGNOSTICS.md)：闪退、白屏、WebView 错误、日志收集。
- [Fork 与 APK 设备验收指南](../DEVICE_SETUP_GUIDE.md)：Fork、构建、安装、功能验收和升级数据安全。

### 自部署者

- [根目录环境变量模板](../.env.example)：变量名称和用途的当前入口；实际部署还需检查 Netlify/Supabase 控制台配置。
- [云端生活日程说明](./cloud-life-scheduler.md)：生活日程快照、Edge Function、Cron 和当前主动消息开关状态。
- [站点云一键初始化 SQL](./supabase-all-in-one.sql)：账号、审核、便签墙、游戏/应用市场、举报、联机和现实桥相关站点表；不会部署个人推送云，也不会自动开放成年审核申请。
- [账号与激活码 SQL](./account-supabase.sql)：账号、会话和激活码基础表。
- [个人云推送 SQL](./personal-push-supabase.sql)：个人推送、生活日程运行态与 Cron；新部署优先走应用内「云服务部署」。
- [旧版站点共享推送 SQL](./push-supabase.sql)：仅旧站点共享推送部署；不要用于新用户个人云。
- [特调独立云 SQL](./mixology-supabase.sql)：仅供独立特调 Supabase 项目使用。
- [市场/内容 SQL](./custom-app-market-supabase.sql)、[游戏大厅 SQL](./game-hall-supabase.sql)、[黑市 SQL](./black-market-supabase.sql)、[内容审核 SQL](./moderation-supabase.sql)、[便签墙 SQL](./notewall-supabase.sql)、[联机对战 SQL](./online-play-supabase.sql)：按对应功能和数据库项目分别部署。
- [现实桥定时扫描迁移](./reality-bridge-schedule-cron.sql)、[旧推送 10 秒扫描迁移](./push-cron-10s-migration.sql)、[快捷指令续跑迁移](./push-shortcut-resume-migration.sql)：历史/旧版迁移脚本，执行前必须核对目标项目和现有 Cron，不用于新建个人云。
- [Supabase 空间清理脚本](./supabase-cleanup.sql)：高风险维护脚本；仅在确认目标站点库、表结构和备份后按需选段执行。
- [Supabase 出站优化](./supabase-egress-optimization.sql)、[预防性出站优化](./supabase-egress-preventive.sql)、[存储审计](./supabase-storage-audit.sql)：维护/诊断脚本，不是初始化步骤。

### 开发者与维护者

- [角色 ID 契约](./character-id-contract.md)：Character ID、contact ID 和会话数据边界。
- [代码差异台账](./fork-changes-overview.md)：本仓库相对指定对照快照的文件差异概览，不是逐行审计或功能验收报告。
- [开发进度与验证清单](./开发进度与验证清单.md)：开发记录和测试覆盖线索；其中带日期的状态需重新对照当前代码确认。
- [公开分享发布门禁](./公开分享发布门禁.md)：发布前检查项；门禁文档不代表所有检查已通过。
- [历史开发差异台账](./从诊断开始的开发差异台账.md)：2026-10-24 的阶段性对照记录，基线已过期，仅供追溯历史，不应用作当前版本结论。
- [Android Shell 诊断](../android-shell/DIAGNOSTICS.md)：跨网页、原生和服务端链路的证据收集方式。

### 专题技术资料与历史记录

以下资料不属于通用入门教程。使用前请先核对当前源码、配置和部署状态：

- **通话专题**：
  - [常驻通话体验说明](./always-on-call-guide.md)：体验目标与链路设计参考。
  - [全局通话与原生浮窗移植指南](./call-feature-porting-guide.md)：较早阶段的实现/移植记录；类名、接口和步骤必须以当前网页与 Android 源码为准。
  - [通话功能增量更新记录](./call-feature-updates.md)：2026-10-08 的历史增量快照，不代表当前版本逐项验收。
  - [自定义 APP 通话音频接入说明](./custom-app-call-audio.md)：自定义应用接入通话留档的专项参考。
- **云服务与可选集成**：
  - [Supabase 更新部署移植指南](./supabase-deploy-update-porting-guide.md)：旧项目迁移分析快照；来源仓库名和文件清单已过时，当前操作必须以本仓库部署 UI/API 为准。
  - [微信云端助手部署指南](./weixin-cloud-assistant.md)：可选微信助手的独立部署流程，不属于网页部署的自动组成部分。
  - [资源集市说明](./resource-hub.md)：资源市场的外部仓库/CDN 依赖说明；外部仓库结构和可用性可能变化。
  - [成年审核与激活码部署说明](./verify-setup.md)：历史部署说明；当前新申请开关关闭，仅供重新开放时核对，已有申请仍可查询。
- **功能专项与设计记录**：
  - [内置答疑 App 调研报告](./qa-app-design-research.md)：设计调研与方案记录，不应当作当前功能清单。
  - [工坊 App 验收报告](./工坊-验收报告.md)：历史验收记录；其中 mock、浏览器和模型测试不能替代当前线上 GitHub 权限或真实部署验证。
  - [小红书发布版更新说明](./release-notes-xhs.md)：历史宣传文案，不是当前版本发布说明。
  - [本次功能同步说明](./本次功能同步说明.md)：阶段性历史快照；当前状态以源码和最新发布门禁为准。
- **可选视频工具**：
  - [本地视频解析服务](../tools/video-resolver/README.md)：需单独安装运行。
  - [本地视频转写服务](../tools/video-transcriber/README.md)：需单独安装运行。
  - [Cloudflare 视频转写 Worker](../tools/cloudflare-video-transcriber/README.md)：需单独配置并部署。
  - [上游转写工具原始说明](../tools/video-transcriber/UPSTREAM_README.md)：保留的上游文档快照，不代表本项目服务封装的全部行为。
- **自定义应用**：
  - [在线广场自定义应用说明](../custom-apps/online-plaza/README.md)。
  - [微信本地助手说明](../tools/weixin-local-assistant/README.md)。

## 文档可信度规则

文档描述功能时，必须区分以下状态：

- **代码入口存在**：能在当前分支找到实现代码。
- **本地测试覆盖**：有对应脚本或自动化测试；必须注明测试范围。
- **服务已部署**：需要部署平台/个人项目的实际证据，不能从仓库代码推断。
- **设备已验证**：需要具体型号、Android/WebView 版本、APK 版本和测试步骤。
- **尚未验证/不可用**：明确写出限制，不用“支持”模糊带过。

修改功能时同步检查 README、使用/部署说明、隐私与权限、诊断和版本记录。不要把一次构建成功写成全功能验收，不要把历史测试记录写成当前状态。

## 清理原则

只删除已确认过期、重复且没有有效链接入口的文档。部署 SQL、迁移说明、架构契约和诊断手册即使较旧，也可能被自动化脚本或用户部署流程引用；删除前必须搜索仓库引用并核对实际执行入口。不要仅因文件名含“旧版”“临时”或日期就删除。
