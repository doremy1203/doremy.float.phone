# 自定义 App → 内置 App 转换指南

> 适用：把一个「应用市场 zip 包」形态的自定义 app（单文件 HTML + manifest.json + resources）转成仓库内置 app。
> 参考范本：`lib/builtin-apps/heartcraft-*`（完整范本，含工具/指令/事件/数据迁移）、`lib/builtin-apps/call-stats-*`（最简范本）。
> 配套实例：[doris.focus.companion 迁移方案](./focus-companion-builtin-migration-plan.md)。

## 0. 三种应用形态，先判断你要哪种

| 形态 | 适用 | 定义位置 | 渲染 |
|---|---|---|---|
| A. React 内置应用 | 需要深度复用宿主 React 状态、复杂交互、性能敏感 | `lib/desktop-config.ts` ICONS + `components/*-app.tsx` | desktop-shell 直接渲染组件 |
| B. **HTML 内置应用（本指南）** | 已有自定义 app（zip/HTML），想免安装、内置分发、优先注册 | `lib/builtin-apps/` | `CustomAppRunner` 沙盒 iframe + 注入 `window.AiPhone` SDK |
| C. 市场/用户上传应用 | 第三方、随时可卸载 | `lib/custom-app-storage.ts` kv 存储 | 同 B |

**关键事实：B 与 C 的运行时协议完全相同**（同一套 AiPhone SDK、同一个沙盒 iframe、同一张权限表）。内置化只改变「HTML 从哪来」与「注册优先级」，不改变 app 代码协议。所以迁移的主体工作是把安装动作变成代码注册，**app 内部代码理论上可以一行不改**。

## 1. 迁移前体检（对 zip 包的静态检查）

- [ ] `manifest.json` 的 `id` 与用户已安装市场版 **保持一致** —— 数据存储 key 是 `ai_phone_custom_app_data_v1:<appId>/<collection>`，id 不变则老用户数据无缝延续（`lib/builtin-apps/registry.ts:10` 注释明确「两版共用同一个 app id，数据也是同一份」）。
- [ ] `permissions` 对照全集 `lib/custom-app-types.ts:5-62`（62 种）逐个核对：多报不致命（权限门按 action 映射 `lib/custom-app-host-api.ts:156-181 HOST_ACTION_PERMISSIONS`），**漏报会直接被 `requirePermission` 拒掉**（`custom-app-runner.tsx:1105-1108`）。
- [ ] `extensions.tools` 每个 tool 的 `handler` 名 == app 内 `AiPhone.tools.handle('<handler>', fn)` 注册名；`parameterSchema` 是合法 JSON Schema。
- [ ] `extensions.chat.directives` / `plusActions`：指令语法有解析器（app 侧），卡片字段与 `sendCard` 对齐。
- [ ] `extensions.events`：`background: true` 的事件走宿主隐藏 iframe（`desktop-shell.tsx:1873-1962`），app 侧要有对应 `AiPhone.on('<event>')` 监听且**不能依赖 UI 存在**。
- [ ] `resources.presets`（presets.json）：确认要在哪一层注入（见 §4.7）。
- [ ] entry HTML 是否用 `window.AiPhone || window.AiPhoneApp` 取桥（推荐写法，两种别名宿主都有，`custom-app-runner.tsx:571-572`）。
- [ ] entry HTML 是否引用了 zip 包内其他文件（图片/字体）：`createCustomAppSrcDoc` 会把包内资源改写成 data: URL（`custom-app-runner.tsx:124-133`），但**大体积 base64 会撑爆 srcDoc**，建议改为 `media.put` 动态载入或删依赖。
- [ ] 是否使用 `localStorage` / `sessionStorage`：**沙盒 iframe 是不透明源（opaque origin），localStorage 会抛异常**（见 `desktop-shell.tsx:1444` 注释、heartcraft 范本）。数据一律走 `AiPhone.db.*`。
- [ ] 是否直接调 `window.AndroidShell*`：**跨源 iframe 会被 nonce 校验拒绝**（`MainActivity.kt:2853-2900 SecureJavascriptBridge`），原生能力只能经宿主代理（见 §5）。

## 2. 七步迁移清单

以目标 id 为 `<appId>`、名称为 `<AppName>` 为例（变量替换即可）。

### Step 1：入口 HTML → `lib/builtin-apps/<kebab>-source.ts`

```ts
/** 内置「<AppName>」的入口 HTML。
 *  由 CustomAppRunner 挂载后复用宿主 AiPhone 桥；来源：market zip v<ver>。 */
export const <APP>_ENTRY_HTML = [
  "<!DOCTYPE html>",
  "<html lang=\"zh-CN\">",
  // ... 每行一个字符串，转义双引号与反斜杠
].join("\n");
```

- 用脚本生成（不要手转义 1 万行）：从 zip 解出 index.html，按行 split、`JSON.stringify` 每行、join 成数组字面量。
- **体积红线**：静态 import 会进主 bundle（heartcraft 600KB 已偏大）。>800KB 建议改为动态加载：`const { <APP>_ENTRY_HTML } = await import("@/lib/builtin-apps/<kebab>-source")`，在 openApp 分支与后台事件接入点两处 await，配一个模块级 Promise 缓存防重复加载（见 Step 4 代码）。

### Step 2：manifest → `lib/builtin-apps/<kebab>-meta.ts`

```ts
import type { InstalledCustomApp } from "../custom-app-types";

export const <APP>_APP_ID = "<appId>";
export const <APP>_APP_NAME = "<名称>";
export const <APP>_APP_VERSION = "<版本>";   // 与 zip manifest.version 一致
export const <APP>_APP_DESCRIPTION = "<描述>";

export const <APP>_MANIFEST: InstalledCustomApp["manifest"] = {
  /* 整段照抄 zip manifest.json，加 extensions.tools/directives/plusActions/events */
};

export const <APP>_PERMISSIONS = <APP>_MANIFEST.permissions as InstalledCustomApp["permissions"];

export function build<AppName>App(entryHtml: string): InstalledCustomApp {
  return {
    id: <APP>_APP_ID, name: <APP>_APP_NAME, version: <APP>_APP_VERSION,
    author: <APP>_MANIFEST.author ?? "", description: <APP>_APP_DESCRIPTION,
    entryHtml, permissions: <APP>_PERMISSIONS, manifest: <APP>_MANIFEST,
    assets: {},                       /* icon.png 若要内置，转 dataUrl 放这里 */
    installedAt: "<内置化日期>T00:00:00.000Z",
    updatedAt: "<内置化日期>T00:00:00.000Z",
  };
}
```

拆两份文件的原因：工具箱/指令注册表只需要 manifest，不必把几百 KB 的 HTML 拖进这些模块（heartcraft-meta.ts:3-9 注释原文）。

### Step 3：注册表 → `lib/builtin-apps/registry.ts`

```ts
import { build<AppName>App, <APP>_APP_ID, <APP>_MANIFEST } from "./<kebab>-meta";

/** 按 app id 取内置应用（不含 HTML）。 */
export function getBuiltinCustomApp(appId: string): InstalledCustomApp | null {
  if (appId === HEARTCRAFT_APP_ID) return buildHeartcraftApp("");
  if (appId === <APP>_APP_ID) return build<AppName>App("");
  return null;
}

/** 内置版始终优先；市场同 id 版本从运行列表过滤掉（保留数据供迁移/回滚）。 */
export function loadAllCustomApps(): InstalledCustomApp[] {
  const installed = loadInstalledCustomApps().filter((app) => (
    app.id !== HEARTCRAFT_APP_ID && (app.manifest?.id || app.id) !== HEARTCRAFT_MANIFEST.id
    && app.id !== <APP>_APP_ID && (app.manifest?.id || app.id) !== <APP>_MANIFEST.id
  ));
  return [buildHeartcraftApp(""), build<AppName>App(""), ...installed];
}
```

### Step 4：桌面 → `lib/desktop-config.ts` + `components/desktop-shell.tsx`

`desktop-config.ts`：`IconId` 联合类型加 `"focuscompanion"`（kebab 或小写无点），`ICONS` 加 `{ iconId: "focuscompanion", label: "专注", tone: "...", path: ... }`，并加进某个 `PAGE_x_DEFAULT`。

`desktop-shell.tsx` 四处：

1. import meta（静态）+ source（大文件可动态）：
```ts
const { FOCUS_ENTRY_HTML } = await import("@/lib/builtin-apps/focus-source");
const FOCUS_BUILTIN_APP = buildFocusCompanionApp(FOCUS_ENTRY_HTML);   // 若动态，放进 loadBuiltinFocusApp() 带 Promise 缓存
```
2. `openApp(iconId)` 分支：`if (iconId === "focuscompanion") setActiveApp("focuscompanion")`。
3. `activeApp === "focuscompanion"` 渲染块：照抄 heartcraft（`desktop-shell.tsx:4607-4620`），`CustomAppForegroundBoundary` + `CustomAppRunner` + `launchContext` + `onClose`。
4. 聊天卡片冷启动兜底：聊天里点 app 卡片时 openApp 需带 `launchContext`（照抄 `:2566-2569`）。

### Step 5：后台事件接入点

manifest 带 `background: true` 事件时，宿主后台跑的是「带 HTML 的完整定义替换空 HTML stub」逻辑（`desktop-shell.tsx:1814-1880`），内置 app 需要在该处把自己的完整 HTML 传进去，否则后台事件拿不到可执行代码。heartcraft 已有先例，照抄。

### Step 6：数据迁移（可选）

仅当用户此前装的是**不同 id** 的旧版本、或 zip 包经历过打包态旧格式时，才需要在 `lib/custom-app-storage.ts` 仿 `ensureHeartcraftBuiltinDataMigrated()`（:949）写归并函数并在启动时调用一次。**id 不变则跳过本步。**

### Step 7：presets.json 注入

zip 的 `resources.presets` 在市场安装时由 `applyCustomAppRegistrationsAsync` 并入全局（`lib/custom-app-registration.ts:425-463`，id 前缀 `custom_app_<id>_<kind>_`）。内置化后没有「安装」动作，二选一：

- **推荐**：把 preset 条目改写成宿主内置应用提示词，进 `lib/builtin-app-prompts.ts:167 APP_PROMPT_DEFINITIONS`（用 `tags` 限定只在调用本 app 的 AI 请求时生效，`llm-prompt-assembler.ts:616-622` 按 appTags 子集匹配），并同步 `builtin-preset.ts` 的 `prompt_order` 与 `BUILTIN_PRESET_VERSION`（**升版会重置用户预设副本**，注意 `:10` 警告）——用户可在「预设管理器」里编辑，这才是内置 app 的「提示词不硬编码」机制。
- 保守：内置化首次启动时手动调一次 `applyCustomAppRegistrationsAsync` 等价逻辑，把 presets.json 写进用户配置（幂等键用固定资源 id）。

## 3. 接口对照表（zip 内容 → 代码位置）

| zip 包内容 | 迁移后落点 |
|---|---|
| `index.html` | `lib/builtin-apps/<kebab>-source.ts` |
| `manifest.json` 主体 | `lib/builtin-apps/<kebab>-meta.ts` MANIFEST |
| `manifest.json` icon + assets | `build<App>App()` 的 `assets`（dataUrl） |
| `presets.json` | `lib/builtin-app-prompts.ts` APP_PROMPT_DEFINITIONS 或一次性注册 |
| `extensions.tools` | 不改，handler 由 app HTML 运行时 `AiPhone.tools.handle` 注册 |
| `extensions.chat.*` | 不改（directives/plusActions 随 manifest 自动注册） |
| `extensions.events` | 不改 + Step 5 宿主接入点 |
| 市场安装动作 | `registry.ts` 注册（编译期完成） |

## 4. 沙盒与宿主边界（必读的坑）

1. **不透明源**：无 localStorage/sessionStorage/同源 fetch；`document.cookie` 不可用。
2. **原生壳不可直呼**：`window.AndroidShell*` 有 nonce 校验，跨源 iframe 全拒。原生能力走两条路：
   - 已代理：`AiPhone.media.download`（下载由宿主代理，`custom-app-runner.tsx:253-257`）、`media.pick/save`（宿主文件选择/保存）；
   - 未代理的壳方法（闹钟/勿扰/锁机等）：要在 `custom-app-runner.tsx handleBridgeRequest` 加 action 分支 + `HOST_ACTION_PERMISSIONS` 加权限映射 + `custom-app-types.ts` 加权限类型，宿主侧再调 `lib/device-action/bridge.ts` 对应封装。参见锁机方案（focus-companion 迁移方案 §7）。
3. **下载**：iframe sandbox 有 `allow-downloads`，但 APK WebView 对 `<a download>` blob 链接支持不稳，统一改 `AiPhone.media.save` / `media.download`。
4. **srcDoc 体积**：每次挂载都会解析整份 HTML；大 app 建议动态 import（Step 1/4），并避免把 base64 资源内嵌进 HTML。
5. **后台事件无 UI**：`background: true` 的隐藏 iframe 里 `render()`、`document.querySelector` 全是空跑，事件 handler 必须是纯数据逻辑。
6. **权限漏报** = 运行时拒绝，先跑 `npm run check:sdk`（`scripts/check-custom-app-sdk-consistency.mjs`）校验 app 用到的 SDK 方法与宿主实现一致。
7. **版本升级**：内置后版本号由 meta 文件管；用户改过的预设副本靠 `BUILTIN_PRESET_VERSION` 递增迁移，别乱动。

## 5. 原生能力代理（需要 APK 新能力时的固定三件套）

```
① lib/custom-app-types.ts            CustomAppPermission 加类型（如 "device.lock"）
② lib/custom-app-host-api.ts         HOST_ACTION_PERMISSIONS 加 action→permission 映射
③ components/app-market/custom-app-runner.tsx   handleBridgeRequest 加分支（调 lib/device-action/bridge.ts 新封装）
④ android-shell（可选）              ShellBridge 新 @JavascriptInterface 方法（要重打 APK）
```

## 6. 验收清单

- [ ] `npm run check:sdk` 通过。
- [ ] CI 三条 workflow（Validate global comp / Validate life system / Build Android Shell）绿。
- [ ] 桌面图标出现、可打开、关闭后再开不丢状态（会话数据走 `AiPhone.db`）。
- [ ] 老用户（装过市场同 id 版）打开后：数据还在、市场版图标不再双份、工具箱/卡片指令只有一套。
- [ ] 聊天卡片冷启动（聊天室点 app 卡片）带 launchContext 正常。
- [ ] 后台事件（无 UI 场景）真实触发一次验证。
- [ ] APK 真机：下载/保存图片走 `media.save` 不落空；通知/角标正常；退出 app 重进计时类状态不漂移。
- [ ] 卸载路径：内置版不可卸载（UI 层无卸载按钮），回滚手段 = 停用桌面图标 + registry 过滤放开市场版。
