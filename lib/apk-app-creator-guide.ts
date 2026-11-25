// APK 环境下的自定义 APP 开发指南（与网页版/浏览器版的差异）。
// 这是增量文档：通用 SDK / manifest / 包结构仍以 CUSTOM_APP_CREATOR_GUIDE_MD 为准。
// 工坊在 APK 壳内做 APP 时，应同时读 type=app 和 type=apk 两份指南。

export const APK_APP_CREATOR_GUIDE_MD = `# APK 环境开发指南（区别于网页版）

适用对象：在小手机 Android APK 壳（FloatShell / WebView）里运行的自定义 APP。
网页版、PWA、桌面浏览器也读这份文档，但要把所有原生能力当成「可选增强」，必须能降级。

## 1. 先判断运行环境

- APK 壳的 WebView UA 里带 \`FloatShell/\`，但**不要只靠 UA 做分支**。
- 统一用能力探测：
  ~~~js
  const canNative = (name) => Boolean(
    window.AiPhone && window.AiPhone.device &&
    typeof window.AiPhone.device[name] === "function"
  );
  ~~~
- \`AiPhone.device\` 的方法可能不存在，也可能返回 \`{ ok:false, reason }\` 或直接 reject。
  每个原生调用都要 \`try/catch\`，失败时给用户文字提示，并继续用纯前端方案。
- **不要直接访问 \`window.AndroidShell\`**：它只挂在宿主顶层页面，自定义 APP 的 iframe 里拿不到。
  所有设备能力统一走 \`AiPhone.device.*\`。

## 2. APK 里真正不能依赖的东西

自定义 APP 运行在 sandbox iframe 里（\`allow-scripts allow-downloads\`，没有 same-origin）：

- 不要用 \`localStorage\` / \`sessionStorage\` / \`IndexedDB\` 存业务数据：可能直接抛异常，也可能不持久。
  私有数据用 \`AiPhone.db.*\`；大文件用 \`AiPhone.media.put\` 换成 \`media-store://\` 引用。
- 不要用 Service Worker / Cache API / 后台页面。
- 不要假设有 Node、npm、构建工具、文件系统、子进程、WebSocket 服务端。
- 不要写「启动本地 HTTP 服务」这类方案；APK 只加载网页和宿主桥。
- 不要依赖远程 CDN 的脚本/字体/图片：可能被墙、离线或跨域失败。资源尽量放进 \`assets/\`。
- 不要把 blob URL 或 \`a[download]\` 当唯一保存方式：APK WebView 对 blob 下载支持不稳定。
  用 \`AiPhone.media.download\`（见第 5 节），宿主会走原生保存。

## 3. 网页版 vs APK：能力差异表

| 能力 | APK 壳 | 网页 / PWA | 开发建议 |
|---|---|---|---|
| 应用内数据 \`db.*\` | 可用 | 可用 | 两端统一用 |
| 媒体库 \`media.put/get\` | 可用 | 可用 | 大文件只存引用 |
| 保存到手机 \`media.download\` | 可用，走原生保存 | 走浏览器下载 | 不要用 blob anchor 兜底 |
| 系统通知 \`device.notify\` | 可用（需 notifications.write） | 可能不可用 | 失败时退回应用内通知 |
| 勿扰 \`device.dndSet\` | 可用（需 device.assist） | 不可用 | 先探测，失败提示 |
| 亮度 \`device.brightnessSet\` | 可用（需 device.assist） | 不可用 | 只做可选增强 |
| 已安装应用 \`device.appsList\` | 可用（需 device.assist） | 不可用 | 只用于选择器 |
| 看守锁 \`device.lockStart/Update/Stop\` | 可用（需 device.assist） | 不可用 | 必须处理 ok:false |
| 屏幕截图 \`device.screenshot\` | 可用（需 device.screenshot） | 不可用 | 必须用户主动触发 |
| 查岗浮层 / 悬浮窗 / 设备管理员 | 可用（需 device.assist） | 不可用 | 只做可选增强 |
| 闹钟 \`device.alarmSet\` | 可用（需 device.alarm.set） | 可能返回失败 | 失败时用应用内提醒 |
| 专注桌面组件 | 可用（需 device.assist） | 不可用 | 仅 APK 展示入口 |
| 后台定时 \`tasks.schedule\` | 可用，但 App 被杀/未打开时不执行，重开后补跑 | 同左 | 不要当精确后台任务 |
| 后台聊天事件 | 需 chat.read.background，且宿主存活 | 同左 | 不要假设永久后台 |
| AI / 生图 / 语音 | 用宿主配置的 API | 同左 | APP 不保存 API key |
| 联机房间 / 云端共享 | 需要站点 Supabase 配置 | 同左 | 失败要有单机降级 |

## 4. 原生能力的调用规范

### 4.1 权限

在 \`manifest.json\` 的 \`permissions\` 里只声明真正用到的权限：

- \`device.assist\`：勿扰、亮度、已安装应用列表、看守锁、查岗浮层、悬浮窗、设备管理员、专注组件。
- \`device.screenshot\`：直接截取当前屏幕。
- \`device.alarm.set\`：调用系统时钟设闹钟。
- \`notifications.write\`：应用内通知 + \`device.notify\` 系统通知。
- \`media.download\`：把文件保存到手机。

权限不是「声明了就一定有」：用户可能没给悬浮窗/无障碍/设备管理员权限，APK 版本也可能不支持。
不要因为权限失败就整页崩掉。

### 4.2 看守锁

- \`lockStart({ packages, until })\` 的 \`packages\` 是**白名单**（放行清单），不是黑名单。
- 空数组表示「除了自己和系统 UI，其他应用都拦」，不是「不锁」。
- \`lockUpdate\` 只更新白名单/截止时间，不重置本轮计时；通行证变化时用它，不要重复 \`lockStart\`。
- 这是高影响能力：只有专注/自律类 APP 才用，且必须由用户明确开启。
- 调用后检查 \`result.ok\`；失败把 \`result.reason\` 展示给用户。

### 4.3 截图

- 必须由用户主动操作触发，不要静默截屏，不要上传到不可信服务。
- 返回 \`{ ok, dataUrl, width, height, bytes }\`；大图不要直接塞进 \`db\`，先 \`media.put\`。
- 网页版没有这个能力时，隐藏入口或提示「仅 APK 支持」。

### 4.4 闹钟 / 通知

- \`alarmSet\` 在 APK 里通常会打开系统时钟让用户确认，不是静默写入；网页版可能直接失败。
- \`device.notify\` 是系统通知，\`AiPhone.notifications.create\` 是应用内通知，两者不要混用。
- 定时提醒优先 \`tasks.schedule\`；需要系统级提醒时再叠加 \`alarmSet\`/\`device.notify\`。

## 5. 文件保存

优先用 SDK：

~~~js
// dataUrl / base64 / 已存入媒体库的 ref 都可以
const saved = await AiPhone.media.download({
  dataUrl: pngDataUrl,
  filename: "我的作品.png"
});
if (!saved || saved.ok === false) {
  AiPhone.ui.toast(saved && saved.reason ? saved.reason : "保存失败");
}
~~~

- 单文件上限 25MB；更大的文件先拆分或压缩。
- APK 里保存到系统下载目录；网页版交给浏览器下载。
- 不要用 \`URL.createObjectURL\` + 隐藏 \`a[download]\` 作为主路径。
- 保存图片到系统相册目前没有独立 SDK；不要向用户承诺「一定进相册」。

## 6. 生命周期与后台

- 自定义 APP 的 iframe 只在 APP 打开时挂载；用户退出 APP 后，普通 \`setTimeout\`/\`setInterval\`、
  未完成的 fetch、页面内状态都可能被销毁。
- 需要「退出 APP 后还能跑」的逻辑，只能声明宿主支持的扩展：
  - \`tasks.schedule\`：定时任务，App 重新打开后补跑到期任务。
  - \`chat.read.background\` + 后台事件 handler：监听聊天消息。
  - \`extensions.tools\` + 后台 handler：角色调用工具时由宿主临时挂载执行。
- 不要在 APP 里做「常驻后台服务」；WebView 会被系统冻结或回收。
- 长任务（生图、AI 生成）要落一条 pending 记录到 \`db\`，完成后再更新；不要只存在内存里。

## 7. UI / WebView 适配

- 继续遵守通用指南的顶部 A/B 方案：右上角有宿主返回胶囊，不要把关键按钮放右上角。
- 使用 \`100dvh\` 和宿主注入的安全区变量；不要写死 \`height: 844px\`。
- 键盘弹起时用 \`visualViewport\` 或让内容区滚动，不要把输入框固定在会被键盘遮住的位置。
- 触摸目标至少 44px；不要做只有 hover 才能操作的交互。
- 长列表用内部滚动容器，避免整页横向滚动。
- 大图先压缩/用媒体引用，避免一次渲染几十张原图导致 WebView 内存上涨。

## 8. 从网页项目移植到 APK 的检查清单

如果用户给的是一个网页项目 / GitHub 仓库，不要原样塞进来。按顺序改：

1. **去掉服务端**：删除 Node/Express/Next API/数据库服务端代码；需要持久化就改成 \`AiPhone.db\`。
2. **去掉构建链**：把 React/Vue/打包产物改成可直接运行的单 HTML + 原生 JS，或把构建后的静态文件放进 \`assets/\`。
3. **去掉登录/账号**：APK 里没有站点登录态；需要用户身份时用宿主提供的用户资料接口。
4. **替换存储**：\`localStorage\` / \`IndexedDB\` / \`sqlite\` → \`AiPhone.db\` / \`media.put\`。
5. **替换网络**：服务端代理/内部接口 → \`AiPhone.network.fetch\`；检查 CORS 和 \`allowedDomains\`。
6. **替换文件导出**：\`a[download]\` / \`showSaveFilePicker\` → \`AiPhone.media.download\`。
7. **替换通知**：Web Notification / Service Worker → \`AiPhone.notifications\` / \`device.notify\`。
8. **替换定时任务**：cron / setInterval → \`tasks.schedule\`，并接受「重开后补跑」。
9. **原生增强可选**：锁机、截图、勿扰、闹钟、桌面组件只在 APK 且权限可用时启用；网页版隐藏或降级。
10. **补 manifest**：\`id/name/version/entry/permissions\`，只声明实际用到的权限；需要角色工具时加 \`chat.tools\` 和 \`extensions.tools\`。
11. **自测**：断网、拒绝权限、Web 版打开、APK 打开、键盘弹起、退出再进、下载保存，逐项过一遍。

## 9. 给工坊的硬性要求

- 先读通用 \`type=app\` 指南，再读本指南；不要凭记忆写 API。
- 生成代码前先列出「用到的宿主能力 + 权限 + 网页版降级方案」。
- 任何原生调用都必须有失败分支；没有失败分支的代码视为未完成。
- 不要生成需要 npm、构建、服务端、数据库或本地端口的方案。
- 不要把 API key、token、用户隐私写进 APP 代码或 \`db\`。
- 交付前用清单自查：数据存储、网络、通知、下载、后台、权限、安全区、键盘、退出重进。

## 10. 最小能力探测模板

~~~js
const API = window.AiPhone;
const can = (path) => path.split(".").reduce((o, k) => (o && o[k]), API) != null;

async function safeCall(fn, fallback, label) {
  try {
    if (typeof fn !== "function") return fallback;
    const result = await fn();
    if (result && result.ok === false) {
      AiPhone.ui.toast(result.reason || (label + "不可用"));
      return fallback;
    }
    return result;
  } catch (error) {
    AiPhone.ui.toast(label + "失败：" + (error && error.message ? error.message : error));
    return fallback;
  }
}

const nativeLock = can("device.lockStart");
const nativeShot = can("device.screenshot");
const nativeDownload = can("media.download");
~~~

注意：\`can()\` 只代表方法存在，不代表权限已给、系统设置已开、当前 APK 版本行为正确；
真正调用后仍要检查返回值。
`;

export default APK_APP_CREATOR_GUIDE_MD;
