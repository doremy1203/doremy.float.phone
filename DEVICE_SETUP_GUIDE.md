# Fork、构建与 Android 设备验收指南

本文面向希望 Fork 本仓库、部署自己的网页并构建 Android APK 的使用者。它不承诺任意机型全功能兼容；请把“成功构建”“成功安装”和“功能实机验收”视为三个独立结果。

## 1. 先理解组成

- **网页应用**：Next.js 应用，Android Shell 通过 WebView 加载配置的线上站点。
- **Android Shell**：提供 WebView 外壳和原生桥接。当前源码版本见 `android-shell/app/build.gradle`。
- **云端服务**：Supabase SQL、Edge Functions、Cron 和 Secrets 按功能分别部署。Netlify 只负责网页构建/发布，不会自动升级你的 Supabase 项目。
- **模型服务**：聊天及其他 AI 功能依赖用户在应用内配置或部署环境提供的模型服务。

## 2. Fork 前准备

1. Fork 本仓库到自己的 GitHub 账号。
2. 确认默认分支和 Actions 权限；Fork 仓库可能需要在 Actions 页面手动启用工作流。
3. 建议先保持代码不变，完成一次基线构建和基础安装，再做个性化修改。
4. 阅读根目录 `.env.example`，只配置自己实际使用的服务。不要复制他人的密钥或数据库凭据。

## 3. 构建 Android APK

仓库工作流：`.github/workflows/android-shell.yml`，名称为 **Build Android Shell APK**。

### 站点地址

在仓库 Settings → Secrets and variables → Actions → Variables 中设置：

- `SHELL_SITE_URL`：APK 要加载的 HTTPS 站点地址。

手动运行工作流时，也可填写 `site_url` 输入项；该输入优先于仓库变量。请先确认该站点可访问且已经完成需要的网页部署。

### 运行工作流

1. 打开仓库 Actions。
2. 选择 **Build Android Shell APK**。
3. 点击 Run workflow，必要时填写 `site_url`。
4. 等待工作流完成，在该次运行的 Artifacts 下载产物。

工作流使用 Java 17 和 Gradle 8.11.1，并先执行 `scripts/check-android-permissions.mjs`。

### Debug 与 Release 的区别

- **float-shell-debug**：工作流始终构建并验证签名后上传。适合个人测试安装。
- **float-shell-release-signed**：只有配置完整的正式签名 Secrets 后才会构建并上传；没有密钥时不会发布未签名 Release APK。

正式签名需在 Actions Secrets 配置以下四项：

| Secret | 内容 |
|---|---|
| `SHELL_KEYSTORE_BASE64` | 自己的 keystore 文件 Base64 |
| `SHELL_KEYSTORE_PASSWORD` | keystore 密码 |
| `SHELL_KEY_ALIAS` | 密钥别名 |
| `SHELL_KEY_PASSWORD` | 密钥密码 |

配置了 `SHELL_KEYSTORE_BASE64` 后，其余三项必须同时存在，否则工作流会失败。请妥善保管原始 keystore 和密码；不要提交到仓库、Issue 或聊天记录。

**更新安装的关键是签名一致。** 新 APK 与已安装版本签名不一致时，Android 通常不允许覆盖安装。不要为了绕过签名错误直接卸载旧版，因为卸载会删除 WebView 沙箱内的数据。debug 与 release 是否可互相覆盖，以本次构建使用的签名配置和实际 APK 证书为准；不要仅凭文件名判断。

## 4. 安装与首次检查

1. 将 APK 传到 Android 设备并安装。系统可能要求允许当前来源安装应用。
2. 首次启动，确认 WebView 能打开构建时指定的站点。
3. 登录并确认聊天、角色列表等基础网页功能正常。
4. 根据实际使用的原生功能授予通知、悬浮窗等权限。
5. 若需要后台推送，先按 Android Shell README 检查个人 Supabase 推送部署，再检查设备后台策略。

国产 ROM 可能提供自启动、后台活动、电池优化或应用锁定等设置，但菜单名称因厂商和系统版本不同。不要把某个品牌的设置步骤当成所有机型的保证。

## 5. 按功能验收，而不是按品牌猜兼容

建议记录设备型号、Android 版本、WebView 版本、APK versionName/versionCode、站点地址和测试时间。按实际启用功能逐项测试：

| 能力 | 最小验收动作 | 注意事项 |
|---|---|---|
| 页面加载 | 冷启动、退后台再返回 | 记录白屏、加载错误和 WebView 版本 |
| 通知 | 前台、后台、锁屏分别发送测试消息 | 强制停止与普通退后台不是同一条件 |
| 通知回复 | 从通知输入回复，检查网页会话是否真正写入 | 仅看到通知或输入框不代表回复已持久化 |
| 通话浮窗 | 显示、拖动、点击、结束通话 | 需要对应权限和原生版本 |
| 桌面小组件 | 添加两个独立实例，分别修改内容 | 检查实例 ID/profileId 是否串用；启动器行为需实测 |
| 截屏/设备感知/动作 | 逐项授权并执行一次真实操作 | 接口存在或诊断显示支持，不等于硬件/API 调用成功 |
| 闹钟/定时任务 | 创建、触发、取消；按需求测试重启后行为 | 受 Android 版本、权限和后台限制影响 |
| 备份恢复 | 导出备份，在目标环境导入并核对内容 | 浏览器与 APK 的 WebView 数据沙箱不共享 |

未配置、未启用或未实际测试的项目请标记为“不适用 / 未配置 / 未验证”，不要标为通过。

## 6. 问题定位顺序

1. **配置**：APK 是否加载正确站点？云端 URL、函数、密钥是否属于自己的项目？
2. **权限**：通知、悬浮窗、精确闹钟或其他特殊访问是否已授予？
3. **系统策略**：后台活动、电池优化、网络和启动器是否限制相关行为？
4. **链路日志**：请求是否发出、服务端是否收到、原生桥是否回调、数据是否写入？
5. **代码问题**：只有前述条件已排除，才根据日志定位网页、Edge Function 或 Kotlin 实现。

Android 原生诊断步骤见 [android-shell/DIAGNOSTICS.md](./android-shell/DIAGNOSTICS.md)。分享日志前请删除 Cookie、Authorization、API Key、聊天内容和个人数据。

## 7. 数据迁移与升级

- 浏览器和 Android WebView 使用独立存储空间，不会自动共享本地聊天与角色数据。
- 卸载 APK、清除 App 数据或清除浏览器站点数据可能删除本地数据。
- Android Shell 1.0.28 起配置关闭系统自动备份（`allowBackup=false`）；跨设备迁移应使用应用内显式导出/导入，并在迁移前确认备份可恢复。
- 仅网页代码变化通常随线上站点部署生效；Kotlin、Manifest、原生桥、权限或原生资源变化需要重新构建 APK。
- 数据库结构、Edge Function、Cron 或 Secrets 变化需要单独更新个人云项目；重新构建 APK 不会自动完成云端迁移。

## 8. 提交有效问题报告

请提供：
- 仓库分支/Commit、APK 版本与 versionCode；
- 设备型号、Android 版本、WebView 版本；
- 网页部署地址（可脱敏域名）和相关功能开关；
- 清晰复现步骤、预期结果、实际结果和发生时间；
- 应用内运行诊断摘要或脱敏 Logcat 片段。

不要提交签名文件、密码、API Key、Cookie、Authorization 头、完整聊天记录或角色记忆。
