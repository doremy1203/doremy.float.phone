# Android Shell（FloatShell）

Android Shell 是一个原生 Android 应用外壳：使用 WebView 加载用户配置的线上 Float Phone 站点，并通过原生代码提供网页浏览器环境本身不具备或受限的设备能力。

> 本文根据当前 `android-shell` 源码、Gradle 配置和仓库构建工作流整理。源码中存在某个 Service、Receiver 或 Bridge，只能证明实现入口存在；实际可用性仍取决于 APK 版本、网页来源、权限、Android API、设备硬件、网络和厂商后台策略。

## 1. 网页与 APK 的更新边界

- 网页业务逻辑通常随线上站点部署更新，APK 无需因此自动重打。
- Kotlin、Manifest、原生桥、原生资源、通知/服务实现等变化需要重新构建 APK。
- Android WebView 的本地数据与手机 Chrome/其他浏览器隔离；卸载或清除 App 数据可能删除本地数据。
- Android Shell 1.0.28 起关闭系统自动备份（以 Manifest/Gradle 当前源码为准）；迁移请使用应用内显式导出/导入。

## 2. 当前源码版本

当前 `android-shell/app/build.gradle`：

| 配置 | 值 |
|---|---:|
| versionName | 1.0.29 |
| versionCode | 28 |
| minSdk | 26 |
| targetSdk | 34 |
| compileSdk | 36 |

请以目标分支的 Gradle 配置为准；本文版本号不是已发布 APK 的实时查询结果。

## 3. GitHub Actions 构建

工作流：`.github/workflows/android-shell.yml`（Build Android Shell APK）。

### 配置站点地址

在 GitHub 仓库 Settings → Secrets and variables → Actions → Variables 中设置：

- `SHELL_SITE_URL`：APK 启动时加载的 HTTPS 站点地址。

手动运行工作流时，可在 `site_url` 输入项临时覆盖该变量。站点应先完成网页部署并可正常访问。

### 构建产物

1. 打开 Actions → Build Android Shell APK。
2. 点击 Run workflow，按需填写站点地址。
3. 等待构建完成，在对应运行记录的 Artifacts 下载。

工作流使用 Java 17、Gradle 8.11.1，并先运行 Android Manifest/版本一致性检查。

- `float-shell-debug`：每次工作流构建并验证签名后上传，可用于开发测试。
- `float-shell-release-signed`：只有配置完整的正式签名 Secrets 才会构建和上传。没有密钥时不会上传未签名 Release 包。

### 正式签名 Secrets

| Secret | 含义 |
|---|---|
| `SHELL_KEYSTORE_BASE64` | keystore 文件的 Base64 内容 |
| `SHELL_KEYSTORE_PASSWORD` | keystore 密码 |
| `SHELL_KEY_ALIAS` | 密钥别名 |
| `SHELL_KEY_PASSWORD` | 密钥密码 |

设置了 `SHELL_KEYSTORE_BASE64` 后，其他三项必须同时存在，否则工作流会明确失败。签名密钥应离线备份，不能提交到仓库。

Android 覆盖安装要求签名证书匹配。不要通过卸载旧版来解决签名冲突，除非已经确认数据备份可恢复。debug 与 release 是否能互相覆盖，取决于实际构建使用的证书；请用 `apksigner verify --print-certs` 比较证书，不要依赖文件名推断。

## 4. 推送链路说明

当前 Android Shell 包含原生前台推送服务。源码链路大致为：

1. Shell 在 WebView/站点会话上下文中取得用户相关配置；
2. 原生服务连接 Supabase Realtime，并订阅用户个人频道 `shellpush:<userId>`；
3. 服务端 `push-generate` 生成消息后，按当前部署实现向对应频道广播；
4. 原生服务收到事件后交由 Android 通知通道展示。

该链路不是“安装 APK 即可离线推送”。至少需要：
- 个人 Supabase 项目部署了匹配版本的推送 SQL/Schema；
- `push-generate` Edge Function 已部署且 Secrets 正确；
- 设备已建立有效订阅/注册；
- 网络、通知权限和系统后台策略允许服务运行。

设置页的推送测试可用于检查当时的链路，但一次成功不保证长期后台存活。强制停止应用与普通退后台、清理最近任务是不同测试条件。厂商系统可能终止后台服务或限制网络。

### 后台连接通知

前台服务可能显示常驻的后台连接通知，这是 Android 前台服务的系统行为。用户可以在系统通知设置中调整对应通知渠道；不要在不理解影响的情况下关闭角色消息等业务通知渠道。

## 5. 原生能力范围

当前源码包含的模块入口包括：

- WebView：站内导航、外链、文件选择、下载和返回键等处理；
- 推送：前台连接服务、开机接收器及通知展示；
- 通知回复：原生回复接收队列和网页侧消费/持久化桥；
- 通话：来电 Activity、通话控制/浮窗服务及通知操作接收器；
- 桌面小组件：Provider、Renderer 和实例配置 Activity；
- 屏幕捕获：截图浮层服务与网页桥接；
- 设备感知/动作：位置、健康、日历、使用情况、设备动作等桥接入口；
- 现实桥：电源事件接收器，以及用户启用时使用的环境光监测服务；
- 运行诊断：启动恢复、WebView 渲染进程退出处理、网页加载错误和诊断摘要。

以上是代码模块范围，不是兼容性认证清单。部分功能依赖系统版本、设备硬件、特殊访问权限或网页端对应开关；请按目标设备逐项实测。

## 6. 安装与首次检查

1. 下载工作流 Artifact 中的 APK 并安装。
2. 首次启动确认 WebView 能访问 `SHELL_SITE_URL` 对应站点。
3. 登录并验证基础聊天页面。
4. 按需授予通知、悬浮窗及相关特殊访问权限。
5. 若要测试推送，先确认个人云端部署，再从应用设置执行推送测试。
6. 分别测试前台、后台、锁屏、普通退后台和重启后的行为；不要把强制停止当成普通后台状态。

设备适配、备份和验收建议见 [Fork 与 Android 设备验收指南](../DEVICE_SETUP_GUIDE.md)。

## 7. 诊断与反馈

遇到闪退、白屏或功能异常，先看 [DIAGNOSTICS.md](./DIAGNOSTICS.md)。

诊断摘要不会自动上传。公开反馈前应脱敏设备标识、站点信息和日志，绝不要提供 Cookie、Authorization 头、API Key、完整聊天记录或角色记忆。

## 8. 目录入口

```text
android-shell/
├── app/src/main/java/app/floatphone/shell/
│   ├── MainActivity.kt
│   ├── PushService.kt
│   ├── BootReceiver.kt
│   └── ...原生功能模块
├── app/src/main/AndroidManifest.xml
├── app/build.gradle
└── ...
```

实际文件和类名以当前分支为准。网页与原生之间的桥接方法应同时核对网页调用端和 Kotlin 接收端，不能只看其中一侧。
