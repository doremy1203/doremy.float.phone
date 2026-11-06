# 相对对照仓库的代码差异台账

> 更新基线：2026-11-06。对照仓库 `doremy1203/doremy.float.phone` 的 `main`（`8f4f7f1337f17513f401af9b0711c617cfee54f7`）。
>
> 这是 Git tree 文件路径与 blob SHA 的快照比较：本仓库 130 个路径在源仓库快照中不存在；源仓库有 2 个路径在本仓库快照中不存在；194 个同路径文件的 blob SHA 不同。它不等于独立功能数量，也不等于完整逐行语义审查。以下只列出能从当前代码入口确认的主要方向。

## 1. 生活系统

本仓库新增了 `components/life/life-engine-app.tsx` 及 `lib/life/*` 多个模块，并新增：
- `app/life/page.tsx`、生活重置与日程诊断 API；
- `supabase/functions/life-scheduler/index.ts`；
- `public/ai-phone-push/life-scheduler.mjs`；
- 生活系统诊断、观察、日程协调和通知回复队列相关代码；
- `scripts/test-life-*.mjs` 回归脚本。

当前 UI 覆盖七日日程、角色/玩家活动与地点、生活场景、邀约、共同经历、生活观察和诊断入口。

**重要限制：** 当前 `components/life/life-engine-app.tsx` 与 `lib/life/life-proactive-scheduler.ts` 都将主动消息总开关设为 `false`；`lib/life/life-schedule-cloud.ts` 上传的 `proactiveEnabled` 也为 `false`。所以当前不能宣称生活系统会在后台自动生成并主动发送角色消息。云端 `life-scheduler` 的日程评估代码存在，但只有用户自己的 Supabase Schema、Edge Function、Cron 和密钥完成部署后才可能执行；消息生成/投递另有独立条件。

## 2. 照片墙与媒体档案室

本仓库新增：
- `components/photo-wall-app.tsx`；
- `components/photo-wall/photo-wall-canvas.tsx`、`photo-wall-sticker.tsx`；
- `lib/photo-wall-storage.ts`、`photo-wall-world.ts`、`photo-wall-templates.ts`、`photo-wall-export.ts` 等；
- `components/archive-room-app.tsx`。

照片墙代码包含照片素材、位置/缩放/旋转、画布世界尺寸、模板、贴纸/涂鸦、背景与 PNG 导出等实现。媒体档案室读取媒体缓存，检查聊天和照片墙引用，并提供媒体筛选与重复项扫描。删除前仍应检查引用关系；这不代表所有大图和机型手势已通过实机验收。

## 3. 一起看与视频处理

本仓库新增或扩展：
- `components/watch-together-app.tsx`；
- `lib/watch-resolver.ts` 与 `app/api/watch-resolver/*`；
- `app/api/resolve-short-link/route.ts`；
- `lib/video-transcript.ts`、`lib/video-keyframe-analysis.ts`、`lib/gemini-video-understanding.ts`；
- `tools/video-resolver`、`tools/video-transcriber`、`tools/cloudflare-video-transcriber`。

一起看包含链接识别、播放入口、观看记录、时间点讨论、字幕/转写文本处理和 AI 视频理解调用。站内解析服务使用服务端缓存；本地解析/转写工具需用户另行安装部署。不同平台链接可能受登录、Cookie、风控、地区、DRM 和接口变化影响，不保证通用解析成功。

## 4. 现实桥、设备诊断与 Android 增量

本仓库新增的可确认文件包括：
- `lib/device-compatibility.ts`、`components/settings/device-compatibility-settings.tsx`；
- `components/settings/module-diagnostics.tsx`、`performance-diagnostics.tsx`、`runtime-diagnostics.tsx`；
- `android-shell/app/src/main/java/app/floatphone/shell/AmbientLightMonitorService.kt`；
- `NativeRealityBridge.kt`、`PhoneWidgetConfigActivity.kt`；
- `android-shell/DIAGNOSTICS.md`。

Manifest 中注册了环境光监测前台服务和电源事件接收器；设备动作、感知、日历、健康、截屏、小组件等接口需结合实际 APK 版本与权限检查。接口声明或诊断面板显示“支持”只说明检测到桥方法，不代表某个动作已在所有设备上成功执行。

当前 `android-shell/app/build.gradle` 配置为 versionName `1.0.29`、versionCode `28`、minSdk `26`、targetSdk `34`、compileSdk `36`。版本升级应以该文件为准。

## 5. 聊天、记忆、推送、备份与小组件改动

与源仓库同路径但内容不同的文件包括：
- `lib/llm-prompt-assembler.ts`、`lib/short-term-assembler.ts`、`lib/memory-injector.ts` 等提示词和记忆链路；
- `lib/chat-engine.ts`、`lib/chat-storage.ts`、`components/chat/*` 等聊天链路；
- `lib/personal-push-cloud.ts`、`lib/push-bridge-*.ts`、`supabase/functions/push-*` 等推送链路；
- `lib/widget/*`、`components/widget/*`、Android 小组件代码；
- 备份、媒体缓存、设置和设备桥接代码。

这些是文件差异定位结果，不在此把每个文件变化都推断成一项新功能。角色 ID 规范见[角色 ID 契约](./character-id-contract.md)；推送和 Android 链路请结合诊断文档逐项验证。

## 6. 工程与验证

本仓库新增多条工作流，包括聊天消息链路、生活系统、全局兼容性、组件输出、视频解析和 Android APK 构建相关工作流。新增测试脚本包括：
- `npm run test:life`
- `npm run test:photo-wall`
- `npm run test:character-id`
- `npm run test:widget-output`

其他检查命令见根目录 `package.json`。测试脚本存在不等于已执行；执行成功也只覆盖脚本明确检查的范围。
