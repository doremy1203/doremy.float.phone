# 单页桌面 + 应用目录 · 开发与排障笔记

> 归属：本 fork（`QINQJnina/doremy.float.phone`）自加功能，**不在官方主线内**
> 用途：记录这套功能的结构、踩过的坑、以及排查方法。给未来的自己（和接手的人）
> 一条不用重新推理的线索——尤其是"为什么这么改""当时是怎么想的"。
> 生成方式：逐文件读源码 + 真机实测。**没验证的明确标「待验证」，不把推断写成结论。**

为什么需要这份文档：单页首页是集中两天加完的，改动横跨 React / CSS / 键盘交互三处，
出问题时如果只靠口述复述，很容易"一点一点重讲一遍还讲乱"。文档的作用是让下次排查
从"我昨天到底改了什么"直接跳到"这两个症状分别对应哪一层"。

---

## 零、实证等级约定

沿用 `docs/fork-changes-overview.md` 的规矩：

- **【实证】**——读过源码 / 真机实测过，文件名、行号、机制都核对过，可照着改。
- **【半实证】**——读了主文件，调用链没走完，方向可信、细节可能有偏。
- **【推断】**——只依据提交信息或工具摘要，**按它动手前必须先读文件**。
- **【待验证】**——已修或已改，但还没有真机确认过的。

⚠️ **本仓库有一条铁律：不信任"对比摘要"数字，只信任直接读到的文件内容。**
理由见 K4。

---

## 一、时间线（19 个提交）

相对上游 `doremy1203/doremy.float.phone:main` 领先 19 个提交，全部集中在 2026-10-16 → 10-17。

| # | 提交 | 标题 | 要点 |
|---|---|---|---|
| 1 | `6f36b26c2a` | feat: 新增「单页桌面」形态 | 与多页桌面一键切换，只改"怎么摆" |
| 2 | `6b41e9a60d` | feat: 应用目录收进按钮 | 点开为一整页全屏清单 |
| 3 | `85ef0ef371` | feat: 切换收进主题 App | 目录按钮移到右下角悬浮 |
| 4 | `71720cd52f` | fix: 「桌面形态」入口未显示 | 菜单渲染白名单漏加 `desktop` 分区 |
| 5 | `22c33035c4` | style: 仪表盘式卡片分组 | 目录加分组 + 搜索 |
| 6 | `c8a3dc544e` | fix: 目录分组无法滚动 | 见 K5；去掉重复的"全部 ›"入口 |
| 7 | `705d273e0c` | perf: 修复滚动掉帧 | 收敛嵌套毛玻璃，见 K6 |
| 8 | `3d2a2269b3` | Merge PR #1 | feature/single-page-desktop |
| 9 | `f3e6979aa5` | feat: 内容解耦 | 「常用」独立清单 + 组件区上移 |
| 10 | `072e019cc0` | feat: 常用改用卡片网格 | 复用设置/外观 App 的 `CardGrid` |
| 11 | `34c0730fc8` | style: 单页微调 | 居中大图标、胶囊条更透、底部留白 96→56px |
| 12 | `ecc6467cc8` | fix: 单页日历 3x2 | 日期行不再挤在一起 |
| 13 | `62bba951ce` | feat: 组件开放完整目录 | 不再限定手挑的 7 个（含 DIY） |
| 14 | `c047a78adf` | feat: 组件单独调尺寸 + 隐藏名称 | `singleWidgetSizes` / `singleWidgetLabels` |
| 15 | `f741b40290` | fix: 目录标题/搜索框被滚出视野 | 本次主线，见 K1 【待验证】 |
| 16 | `ffc11d4e60` | fix: 目录顶部让位改用壳实测状态栏高度 | `--status-bar-height` 从未定义，见 U2 |
| 17 | `9402b7146d` | revert: 回滚 `.ds-directory` 的合成层改动 | 恢复 `contain: paint` / `translateY`，见 K1 |
| 18 | `b04b50cf51` | revert: 撤掉键盘逐帧跟随 | 真机卡顿，见 K11 【实证】 |
| 19 | `6d6ff117a8` | fix(shell): 升 versionCode/Name + UA 对齐 | 见 K12，否则新包装不上 |

---

## 二、功能结构

### 2.1 涉及文件 【实证】

**本功能相对上游 `doremy1203:main` 共改动 9 个文件**（据完整 diff 核对）：

| 文件 | 性质 | 职责 |
|---|---|---|
| `styles/desktop-single.css` | **新增 485 行** | 单页形态专属样式，选择器全部限定在 `.desktop-single` / `.ds-*` |
| `components/desktop-shell.tsx` | 改 | 桌面壳主体；单页/目录渲染、状态、三个 render 函数、键盘 hook |
| `components/phone-theme-app.tsx` | 改 | 主题 App 新增「桌面形态」分区（`DesktopModePage`） |
| `lib/desktop-layout-storage.ts` | 改 | 5 个新存储键的读写 |
| `lib/widget-types.ts` | 改 | 单页组件目录、推荐尺寸、出厂默认 |
| `components/ui/card-grid.tsx` | 改 ⚠️ **共享组件** | `icon` 改可选 + 新增 `iconNode`，见 K9 |
| `components/widgets/widget-renderer.tsx` | 改 | 修掉字面量 "widgets" 占位文字，见 K10 |
| `styles/phone-shell.css` | 改 | 两处 `overflow: hidden → clip`（详见 K1） |
| `app/globals.css` | 改 | 仅新增一行 `@import "../styles/desktop-single.css"` |

**注意：`lib/theme-types.ts` 与 `lib/kv-db.ts` 本次没有改动**，它们是既有依赖
（`statusBarDropPx`、`AiPhoneKvDB` 都是上游原有）。

### 2.2 形态切换 【实证】

```ts
const [desktopViewMode, setDesktopViewMode] = useState<DesktopViewMode>("paged");
// paged  = 原多页翻页桌面（官方行为，一行没动）
// single = 单页桌面（组件 + 常用 + 右下角目录悬浮钮）
```

- 存储键：`ai_phone_desktop_view_mode_v1`
- 入口：**主题 App → 桌面形态**（注意：早期因菜单白名单漏了 `desktop` 分区导致入口不显示，见提交 4）
- 设计原则：**只改变"怎么摆"，图标布局 / 组件位置 / 主题都不动**，两种形态随时互切

### 2.3 目录页 DOM 结构 【实证】

```
<div class="ds-directory">            ← 整屏覆盖层，position:absolute; inset:0; z-index:700
  <div class="ds-dir-head">           ← 标题「应用目录」+ 关闭钮（flex:none，固定）
  <div class="ds-dir-search">         ← 搜索框（flex:none，固定）
  <div class="ds-dir-scroll">         ← 唯一滚动区（flex:1 1 auto; overflow-y:auto）
    <section class="ds-card ds-dir-group">  ← 每个分组一张卡
      <div class="ds-dir-group-head">       ← 分组名 + 数量
      <div class="ds-grid">                 ← 四列网格
        <div class="ds-dir-cell"> … <button class="ds-pin">  ← 图标 + 钉进常用
```

**关键层级约定：外层不滚、内层滚。** 这个约定是 K1 的成因，也是修复的依据。

### 2.4 目录入口按钮 【实证】

```css
.ds-dir-fab {
  position: absolute;
  right: 18px;
  bottom: calc(var(--dock-height, 92px) + var(--home-dock-lift, 0px) + 22px);
  z-index: 60;
}
```

判定「你手机上跑的是不是最新代码」有个零成本方法：**看单页桌面右下角有没有这个 ✦ 悬浮钮。**
有 = 新代码已生效；没有 = 不是这份代码。

---

## 三、踩坑台账

### K1. 点搜索框后「应用目录」标题/搜索框消失 【实证成因 / 修复待验证】

**症状**
- 打开应用目录，标题和搜索框正常显示
- 点一下搜索框（键盘弹起）→ 标题和搜索框**消失**
- 收起键盘 → 它们**自己回来**
- 全程 DOM 和 CSS 一个字都没变

**机制（这是最反直觉的一点）**

`overflow: hidden` **不是"不能滚动"，而是"不显示滚动条"**——它的 `scrollTop` 依然可以被改。
输入框聚焦时，浏览器为了把输入框滚进视野（focus scroll），会去滚动某个祖先容器的 `scrollTop`；
键盘收起后浏览器又把它滚回 0。于是看起来像"元素时有时无"，实际是**容器的滚动位置变了**。

项目里三个容器都用了 `overflow: hidden`：`.app-root`、`.phone-shell`、`.ds-directory`。
`.ds-directory` 顶部内边距只有 `calc(var(--status-bar-height,36px) + 12px)`，
本身就是「刚好够」的量，**一旦整页被滚，最先出界的就是标题和搜索框**。

**修复**

三处 `overflow: hidden` → `overflow: clip`：

| 文件 | 选择器 |
|---|---|
| `styles/phone-shell.css` | `.phone-shell` |
| `styles/phone-shell.css` | 移动端媒体查询内 `.app-root` |
| `styles/desktop-single.css` | `.ds-directory` |

`clip` 与 `hidden` 视觉完全一致（都裁掉溢出），但 **`clip` 不生成滚动容器**，
focus scroll 动不了它。

**⚠️ 绝对不要给这两个加 `clip`**——它们是真正需要滚动的区域，加了就滚不动了：

- `.desktop-single`（首页常用/组件的滚动列表，`overflow-y: auto`）
- `.ds-dir-scroll`（目录内部分组滚动区，`overflow-y: auto`）

**⚠️ `clip` 不创建滚动容器，会影响 `position: sticky` 的参照系。**
项目里有 sticky 的地方（如聊天联系人页字母索引）。若哪处 sticky 表现异常，
先只撤 `.phone-shell` 那条、保留另外两处——症状在目录页，`.ds-directory` 才是主药。

**已排除的错误方向（别再走一遍）**
- ❌ 不是底部被系统导航栏压住。实测：目录能完整滚到底，且是手势导航。
- ❌ 不是「状态栏占位上移 / `--status-bar-drop` 时有时无」。实测该项一直是 0。
- ❌ 不是第三方美化 CSS 修好了。那份 CSS 里没有任何 `.ds-directory` / `--status-bar-drop` 规则（见 K7）。

**对照实验记录（四次，结论已翻转）**

| # | 实验 | 结果 |
|---|---|---|
| 1 | 3 行 clip 临时 CSS（首次） | 键盘弹出 → 标题**稳稳在**（后被证伪：假阳性） |
| 2 | 清缓存 + 重新放同款 clip | 键盘弹出 → 标题/搜索框/返回键**消失但可交互** |
| 3 | 实验 C：再加 `.ds-directory{contain:none!important}` | **现象翻转**：弹出→出现，收起→**消失但可交互** |
| 4 | 实验 C+A：再加 `html,body{overflow:clip!important}` | **更混乱**：弹出/收起两种状态都随机出现/消失 |
| 5 | 实验 C+A+B：再加 `.phone-shell-wrap{transform:none!important;will-change:auto!important}` | **仍混乱**：键盘正常弹出收起，功能全在，可见性随机 |

**核心观察（用户原话）**：键盘出现和消失会"刷新"什么——每次键盘状态变化触发
resize → 两个 hook 改 CSS 变量 → 重排/重绘，**而重绘结果不稳定（竞态）**。

**「能交互但看不见」排除**：元素删除、布局塌缩、focus scroll（clip 已上仍失效）。

**翻转现象的含义**：去掉 `contain: paint` 后坏/好的时机正好对调——
`contain: paint` 是因素之一，但**不是唯一因素**，存在第二个叠加因素。

**修正后的头号嫌疑：`.phone-shell-wrap` 的永久 transform 合成层**

```css
.phone-shell-wrap {
  transform: translate3d(0, calc(-1 * var(--mobile-keyboard-lift, 0px)), 0);
  will-change: transform;
}
```

`translate3d(...)` 即使结果为 `(0,0,0)` 也是**非 none 的 transform**，强制整层走 GPU 合成；
`will-change: transform` 更是明示保层。目录页整个在这层里，键盘 resize 时该层重绘出错 →
**整层视觉消失、布局与点击区域仍在**，与「看不见但能点」完全吻合。

**待做实验（按顺序，一次一个）**：

```css
/* 实验 B（首要）：禁用整层 transform，验证合成层假设 */
.phone-shell-wrap { transform: none !important; will-change: auto !important; }
/* 副作用：聊天输入框会被键盘盖住（抬升靠 transform），仅验证用，验完删 */
```

- B 有效 → 根因是「合成层 + 键盘 resize 重绘竞态」，修法方向：键盘抬升不用 transform
  （改 margin-top）或去掉 `will-change: transform` 让浏览器自行降层。
- B 仍无效 → 合成层假设不成立，需 `chrome://inspect` 在弹出/收起两态逐一读 computed 值，
  CSS 盲测已接近边际效益递减。

**实验 B 结果（2026-10-17）：仍混乱 → 合成层假设不成立，已放弃 CSS 盲测。**

**实验 C+D 曾进过代码，已回滚（2026-10-17）**：一度把 `.ds-directory` 的
`contain: paint` 删掉、并把入场动画的 `translateY(14px)` 改成纯 `opacity`，
理由都是"减少合成层缓存/锁定"。按本台账实验 3 的记录，这正是把故障时机对调而非修复，
所以**两条都已还原**，源码里保留了注释说明为什么别再把它们当性能优化删掉。

同批改动中**唯一保留**的是「整页底色改完全不透明」——它与 K6（整页底色近乎不透明）
方向一致，与合成层假设无关，属独立成立的改进。

**教训**：`contain` / `transform` / `will-change` 这类合成层相关属性在 `.ds-directory`
上**不要单独调**。K1 已经把它们证伪为唯一根因，任何基于"少一层合成"的改动都会
以「看起来是优化、实际只是换了故障时机」的形式重演。要动就先按 U1 跑诊断。

**两个决定性新事实（用户补充，改写根因方向）**：

1. **不只是头部，分组内容也一起随机消失**——不是"头部三元素被盖住"的局部问题，
   是整个 `.ds-directory` 内容体（头 + 搜索 + 分组图标）整体可见性随机。
2. **这些临时 CSS 都是在"已去掉 b.css"的状态下测的**——此前「b.css 在场就正常、
   看不出区别」的观感，与「去掉 b.css 就乱」指向同一件事：见下。

**重新定性（比"合成层"更根本的假设）**：

`.ds-directory` 是 `position:absolute; inset:0; z-index:700` 的整屏覆盖层。
它**依赖父级 `.phone-shell` 正常参与绘制**。而 `.phone-shell` 在移动端媒体查询里
`width:100vw; height:100lvh`（`100lvh` 不随键盘变化）。键盘弹出/收起时布局视口高度在变、
壳高度却锁死 lvh → 覆盖层的可见区域/裁剪边界随之漂移。

`b.css` 在场时恰好把它"稳定住"了（很可能是它给 `.phone-shell` 或目录相关层级
强加了背景/层级/尺寸的 `!important` 规则），**这不是 b.css 修好了，而是 b.css 掩盖了它**。

**下一步：停止 CSS 盲测，等电脑用 chrome://inspect 精确诊断**。要读的值（键盘弹出/收起各抓一次）：

| 元素 | 要读的属性 |
|---|---|
| `html` / `body` | `scrollTop`、`clientHeight`、`scrollHeight` |
| `.phone-shell-wrap` | `transform`、`margin-top` |
| `.phone-shell` | `height`、`offsetHeight`、`clientHeight` |
| `.ds-directory` | `getBoundingClientRect()`、`opacity`、`visibility`、`z-index`、`overflow` |
| `:root` | `--phone-screen-height`、`--mobile-keyboard-lift`、`--status-bar-drop` |

尤其 `--phone-screen-height`（JS 用 `innerHeight + drop` 动态写）与
`100lvh`（`.phone-shell` 的 height）之间的**不一致**，是最可能暴露真凶的位置。

---

### K2. 「Chrome 里好看，App 里不对」的两个层次 【实证 · 已真机验证】

**第一层：跑的不是同一套媒体查询**

实测环境视口 **360 × 805 @2x**，而 Chrome 桌面预览是固定的 **390 × 844 机模**。

| 媒体查询 | 360 真机 | 390 机模 |
|---|---|---|
| `@media (max-width: 373px) and (hover:none) and (pointer:coarse)`（`--slot-size: 16.92vw` 等） | ✅ 命中 | ❌ 不命中 |
| `@media (max-width: 360px)`（第三方 CSS 里多处，带 `!important`） | ✅ 命中 | ❌ 不命中 |

即：**真机走的是等比缩放分支，桌面上看到的是默认 clamp 分支。** 两边像素级对不上是必然的。

**第二层：部分键盘 hook 在桌面根本不执行**

`useAndroidCaretKeyboardLift()` / `useAndroidNativeKeyboardViewport()` 都有这道门：

```js
window.matchMedia("(max-width: 500px) and (hover: none) and (pointer: coarse)").matches
```

桌面机模不满足 → 整段逻辑一次都不跑。所以**跟键盘相关的 bug，桌面 Chrome 永远复现不出来。**

**推论（重要）**：`max-width: 360px` 是**包含** 360 的。真机正好落在边界值上，
意味着在 360 上调出来的效果，到 361px 的设备就切回另一套规则。
**判断标准：在真机 360 环境里看，不要在桌面机模里看。**

自测当前命中哪一支（零成本）：

```css
@media (max-width: 360px) {
  .phone-shell::after {
    content: "≤360px 分支"; position: absolute; top: 40px; left: 8px;
    font-size: 10px; color: blue; z-index: 9999; pointer-events: none;
  }
}
@media (min-width: 361px) {
  .phone-shell::after {
    content: ">360px 分支"; position: absolute; top: 40px; left: 8px;
    font-size: 10px; color: red; z-index: 9999; pointer-events: none;
  }
}
```

**实测结果：≤360px 分支（蓝字）**——2026-10-17 在安卓壳内实测，确认本机命中
`max-width: 360px` 这一支，而桌面 390px 机模不命中。**这条已从推断升为实证。**

> 附带的推论：既然本机命中 `b.css` 的 `@media(max-width:360px)`，
> 那份第三方 CSS 里所有 360 分支的规则（如 `.feed-post` 边框 33px→29px）
> **在你的机器上是生效的**，而在桌面上看不到——这也是"两边不一样"的一部分。

---

### K3. 安卓壳不打包网页 —— 改网页不需要重打包 【实证】

`android-shell/.../MainActivity.kt` 开头注释即写明：

> 全屏 WebView 直接加载线上站点。**网页每次部署即时生效**，本壳只负责原生能力。

三处硬限制：

- `val SITE_URL: String = BuildConfig.SITE_URL` —— 站点地址是**编译期常量**
- `webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)` —— 冷启动只加载它，**壳没有地址栏**
- `shouldOverrideUrlLoading`：只有同 host 留在壳内，其它一律 `startActivity` 甩给系统浏览器

**结论**：改网页（`components/` `styles/` `lib/`）→ 部署即生效，**不用重新打包 APK**。
改壳（`android-shell/`）→ **必须重打包重装**，网页怎么部署都没用。

**要用壳验证分支部署怎么办**：workflow 支持 `workflow_dispatch` 的 `site_url` 输入，
重新打包指向预览地址即可。**代价：换 host = 换 origin = 空环境**，
本地 IndexedDB / localStorage 按 origin 隔离，数据一个都看不到。换前务必导出备份。

---

### K4. 对比工具报「零差异」不可信 【实证】

曾经出现：工具对比报「领先 0 / 落后 0，零差异」，而 GitHub 页面明确写
「15 commits ahead」。**两者矛盾时，以 GitHub 与你实际读到的文件为准。**

同类现象：`docs/fork-changes-overview.md` 也记过——对比列表里
`lib/shell-call-overlay.ts`、`styles/phone-shell.css` 等条目显示 `+0/-0`，
但实际有实质改动，是对比接口在文件数超限后没附 diff 统计。

**铁律**：凡是"改没改、改了什么"的判断，一律**直接读文件**，
不用工具摘要数字当证据。这条踩过两次，代价是两轮排查方向全跑偏。

---

### K5. 应用目录分组无法滚动 【实证】

`.desktop-single` / `.ds-dir-scroll` 一律用**「块级流 + 外边距」**排布，**不用 flex 列布局**。

原因：卡片自身是 `overflow: hidden`，而 `overflow` 不为 `visible` 时，
flex 子项的 `min-height: auto` 会解析为 0 —— 卡片被压扁到容器高度，
既不溢出也不滚动，内容就"看不见"了。

对应提交 `c8a3dc544e`。

---

### K6. 单页/目录滚动掉帧 【实证】

毛玻璃（`backdrop-filter`）在本文件里被刻意收敛，因为**嵌套模糊**是掉帧主因：

- 整页糊 + 卡糊 + 每个图标糊 → 滚动时每帧重新采样几十层
- 做法：整页底色改为近乎不透明、去掉整页/卡片的模糊，
  图标模糊半径从 22px 压到 5px（背后本来就已经是糊的，观感几乎无差别）

对应提交 `705d273e0c`。**加新样式时注意别把嵌套模糊加回来。**

---

### K7. 第三方美化 CSS 的干扰 【实证】

现用主题 `b.css`（约 300k）有几个必须知道的特点：

- 原版名为 **`Pillowy-全局完整主题内含聊天室主页美化v15.css`**，来自资源集市的分享
- 文件头标注来源是**另一个 fork**（`Repository 1206149951-create/float @ 8ef9e34`），
  DOM 结构可能与当前上游不同
- **导入前删掉了内嵌的图片资源**（原文件太大）。这一点后果严重，见 K8
- **几乎每条规则都带 `!important`**，覆盖力极强，出问题极难定位
- 有 `font-size: 0 !important` + `::after { content: "トーク" }` 这类**改文案**的规则，
  不只是换皮
- 大量 `:has()` / `:nth-child(3n+2)` 结构敏感选择器
- 含 `@media (max-width: 360px)` 分支，在本机（360px）会生效

**它没有修 K1**：全文没有 `.ds-directory` / `.ds-dir-*` / `--status-bar-drop` /
`--mobile-keyboard-lift` / `--phone-screen-height` / `phone-shell-wrap` 任何一条。
之前"加了美化就正常"是**视觉掩盖**——`.phone-shell { background: #faf6ec !important }`
把壳底色刷成不透明米色，裁切边不那么扎眼了，实际裁切还在。

**自查命令**（拿到新 CSS 先跑一遍）：

```bash
grep -nE "ds-directory|ds-dir|status-bar-drop|mobile-keyboard-lift|phone-screen-height|phone-shell-wrap" b.css
```

---

### K8. 美化 CSS 删掉图片资源后的「空壳占位」 【实证】

**背景**：`b.css` 原版是 `Pillowy-全局完整主题内含聊天室主页美化v15.css`，
因文件过大，导入前**删掉了内嵌图片资源**，但**依赖这些图片的布局规则没删**。

结果：一批 `::before` / `::after` 变成了**有尺寸、无内容**的空块。
其中两类是**真实占据流内空间**的（不是绝对定位的装饰），会明显撑开空白：

**① 聊天页 / 联系人页顶部的刊头空块**

```css
.chat-app:not([data-room-active])
  .page-body:has(input[placeholder="Search chats..."])::before {
    content: ""; display: block; flex-shrink: 0; width: 100%;
    aspect-ratio: 380 / 190; margin: 4px 0 20px;
  }
```

`display:block` + `flex-shrink:0` + `aspect-ratio` → 流内真实占位。
本机（360px 宽、内容宽约 324px）算下来：高约 **162px** + margin 24px ≈ **186px 纯空白**，
约占 805px 屏高的 **23%**。

后续虽有 `background-size` / `background-position` 规则，但**没有 `background-image`**，
块依旧是空的。

**② 朋友圈卡片 33px 透明边框**

```css
.chat-app .feed-post {
  border: 33px solid transparent !important;
  border-image-slice: 20% !important;
}
```

`border-image` 的图没了，`33px solid transparent` 还在 → 每张卡左右各 33px 纯空白边框。

**影响判断**
- **不是 K1 的成因**——K1 在 `.ds-directory`，b.css 里没有任何该选择器规则
- 但它是"界面显得空、内容显得少"的另一半来源，容易被误感知为"显示不全"

**如果想让界面恢复正常密度**，两条路：

1. **补回图片**（原版完整 CSS），空块就变成了装饰图
2. **删掉这些占位规则**（更省体积），至少处理 ①② 两类：
   - 把 `::before` 那条设成 `display: none`
   - 把 `.feed-post` 的 `border: 33px solid transparent` 改回 `border: 0`

自查命令（列出所有"有尺寸但可能没图"的伪元素）：

```bash
grep -nE '::(before|after) *\{' b.css | grep -E 'width|height|aspect-ratio'
```

> 顺带记录一个判断经验：**「加了美化反而正常」不等于美化修好了问题**。
> 它可能同时做两件事——视觉掩盖（改底色/边界）+ 引入新的空白。
> 想分清，就把美化临时关掉，用 K1 的 ①② 两问重新分诊一次。

---

## 四、分诊手册

### 症状：「应用目录」顶部（标题/搜索框）看不见

按顺序问两句话，能砍掉大半可能性：

| 问题 | 回答 | 结论 |
|---|---|---|
| ① 完全不碰搜索框，只打开目录、上下滑动，标题在吗？ | 一直在 | 是聚焦触发的 → K1 |
| | 也会消失 | 纯布局/裁切问题，**不是 K1**，重新查 |
| ② 点搜索框让键盘弹起、再收起键盘，标题回来吗？ | 回来 | 浏览器 focus scroll → **就是 K1** |
| | 不回来 | 某个变量被改了没恢复（`--phone-screen-height` 停在小值等），要动 JS |

实测记录：① 一直在、② 会回来 → **判定 K1，已按此修复。**

### 症状：改了代码但 App 里没变化

按顺序排查：

1. **✦ 悬浮钮在不在**（见 2.4）→ 不在 = 跑的是旧版
2. **Service Worker 缓存**（本机环境实测 SW 已激活）→ 部署后旧 HTML 引旧 CSS 是经典坑
3. **部署平台的 commit 是不是最新的**（Netlify/Vercel 面板看 Deploys 列表）
4. 换 origin 测分支 → 记得是空环境，别以为数据丢了

---

## 五、环境实测记录 【实证】

2026-10-17，在**安卓壳内**实测：

| 项 | 值 |
|---|---|
| UA | Android 14 / ALT-AN00 / `(wv)` / Chrome 116 / `FloatShell` |
| 视口 | **360 × 805**（CSS px） |
| 像素比 | @2x（物理 720 × 1610） |
| PWA 独立窗口 | 否（壳内，非装机 PWA） |
| Service Worker | **已激活**（改动后可能存在缓存滞后） |
| 通知权限 | 不支持（壳走原生推送通道） |
| 存储占用 | 37.9 MB / 配额 132.69 GB（0.0%） |
| IndexedDB | 20 个库（聊天/记忆/设置/主题/音乐/故事/地图/栖所/便签等） |
| 持久化存储 | **未开启**（存储紧张时系统可能清数据 → 定期导出备份） |

**调试通道**：`MainActivity.kt` 第 264 行 `WebView.setWebContentsDebuggingEnabled(true)`。
手机开 USB 调试 + 电脑 Chrome `chrome://inspect` 即可远程调试真机页面。
注意它**只看得到 WebView/Chrome 层**；原生层（状态栏高度注入、键盘 insets）要走 Logcat。

---

## 六、未结案（下次从这里继续）

### U1. K1 的真机复验 【待验证】

- 代码已提交：`f741b40290` → PR #3 合入 main
- **用户反馈：生产构建后在 App 里打开仍然不行**
- 但临时 CSS 对照实验是实测有效的，所以最可能是「新代码没真的跑起来」而非「修复无效」
- **2026-10-17 更新（重要）**：拿到 `doremy1203:main...main` 完整 diff 后确认，
  三处 `overflow: clip` **确实都在 main 上**（`.phone-shell`、`.app-root`、`.ds-directory`）。
  也就是说「代码没推上去」这条**已排除**，剩下两种可能：
  - **A. 部署/缓存**导致手机实际跑的还是旧 CSS
  - **B. K1 结论不完整**——真正被滚的容器不在这三处里，见 U5

- **下次优先确认（按顺序）**：
  1. 先看 U5：`html, body` 仍是 `overflow: hidden`，是唯一没改的祖先
  2. 临时那 3 行 `overflow: clip` CSS 是否还在主题配置里？还在 = 症状已不是 K1；已删 = 大概率缓存
  3. Netlify Deploys 最新 commit 是否为 `3721034145` / `f741b40290`
  4. 硬清缓存 / 换无痕窗口 / 在 `chrome://inspect` 里看 `getComputedStyle(.ds-directory).overflow` 是否为 `clip`
  5. 若 `overflow` 确实是 `clip` 但问题仍在 → **K1 结论需要修正**，重新做 ①② 分诊

**决定性诊断（一次定位，不再猜）**：在 `chrome://inspect` 的 Console 里，
点搜索框（键盘弹起）状态下执行：

```js
// 找出所有 scrollTop 不为 0 的元素——那就是真正被 focus scroll 滚走的容器
const scrolled = [];
document.querySelectorAll('*').forEach(el => {
  if (el.scrollTop > 0 || el.scrollLeft > 0) {
    scrolled.push({
      元素: el.tagName.toLowerCase() +
            (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string'
              ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
      scrollTop: el.scrollTop,
      overflow: getComputedStyle(el).overflow,
    });
  }
});
console.table(scrolled);
// 额外看一眼文档级滚动（html/body 是最后的兜底）
console.log('html.scrollTop =', document.documentElement.scrollTop,
            '| body.scrollTop =', document.body.scrollTop,
            '| scrollingElement =', document.scrollingElement?.tagName);
```

**哪一行不为 0，就锁定了哪一个容器**，比我继续推理可靠。


### U5. `html, body` 仍是 `overflow: hidden` 【推断，待验证】

三处改完后，整条祖先链上**唯一还留着 `overflow: hidden` 的是 `html, body`**：

```css
/* styles/phone-shell.css 移动端媒体查询内，本次未改动 */
html,
body {
  overflow: hidden;
  width: 100%;
  height: 100lvh;      /* ← 关键：lvh = 最大视口高，键盘弹出时不变 */
  background: var(--c-page-body-bg);
}
```

**为什么会残留问题**：
- `lvh` 是**最大值**，键盘弹出、布局视口变小时它**不变**
- 于是文档高度（100lvh）> 当前布局视口高度 → `html` / `body` 仍然**可被程序化滚动**
- 输入框聚焦时，浏览器找不到更近的可滚祖先时，会退回滚动 `html`/`body`

**为什么这条只是【推断】而不是结论**：
用户的临时实验（`.app-root` / `.phone-shell` / `.ds-directory` 加 `clip`）**实测有效**。
若真正被滚的是 `html`/`body`，那个实验不该起效。所以要么：
- 实验期间浏览器滚的确实是 `.app-root`，而源码部署后没生效（回到 U1-A 缓存）
- 要么还有别的条件差异

→ **不要直接改**。先用 U1 的决定性诊断跑出结果，再决定要不要给 `html, body` 也上 `clip`。

**若要试**：`html, body { overflow: clip }`，风险是可能影响移动端 Safari 的
视口行为（`-webkit-overflow-scrolling`），只在安卓壳内验证即可，别当成通用修复。

### U2. `--status-bar-height` 与「状态栏位置」的关系 【代码层已实证 / 真机观察待解释】

曾观察到「顶部偏移 12px 时标题在、4px 时不在」，但按代码：

```css
.ds-directory { padding: calc(var(--status-bar-height, 36px) + 12px) …; }
```

只读 `--status-bar-height`，**不读**「状态栏位置」`--status-bar-top`。
理论上调「状态栏位置」动不到目录顶部。

**代码层已证实（`styles/tokens.css` + `styles/desktop-single.css`）**：

| 变量 | 谁在用 | `.ds-directory` 用吗 |
|---|---|---|
| `--status-bar-height`（默认 36px） | `.phone-status-bar` 高度、`--phone-titlebar-safe-top` | ✅ **用**（`padding-top`） |
| `--status-bar-top`（默认 12px，「状态栏位置」） | 仅 `.phone-status-bar { top }` 与 `--phone-titlebar-safe-top` | ❌ **不用** |

即：**调「状态栏位置」在 CSS 层面动不到目录页顶部。** 这一条不再是推断。

**已补的一处（2026-10-17）**：上表里的 `--status-bar-height` **此前在整个仓库里没有任何定义**
（`tokens.css` / `base.css` / `phone-shell.css` / `globals.css` / `theme-storage.ts` 都查过，
`collectCssOverrides` 只搬 `cssOverrides` 里已存在的键，不生成新变量）。于是所有机型
一律吃 `36px` 兜底——壳实测的真实高度虽然由 `MainActivity.injectStatusBarHeight()`
注入成 `--android-shell-status-bar-height`，但**一个消费方都没有**。

现在 `.ds-directory` 的 `padding-top` 直接读实测值：

```css
padding: calc(var(--android-shell-status-bar-height, var(--status-bar-height, 36px)) + 12px) …;
```

非壳环境（浏览器 / iOS PWA）没有 `--android-shell-status-bar-height`，回落到 36px，观感不变。

**故意没有把 `--status-bar-height` 本身改成实测值**：它同时是 `.phone-status-bar`
（虚拟状态栏）的高度，一并改会让那一条在窄状态栏机型上被压扁；虚拟状态栏的 36px
是设计常量，不该跟设备走。如果以后确实要让虚拟状态栏也跟随设备，把那行的变量名换掉即可。

**另外记一笔**：`floatshell-statusbarheight` 这个自定义事件目前**没有监听者**——
本轮核对过的范围内（`desktop-shell.tsx` 1–2100 与 4040–5591、`phone-theme-app.tsx` 620–1150）
一处都没有。壳侧照常派发且做了同值去重，属无害冗余；CSS 变量走行内样式继承，
不依赖这个事件。真要给 JS 侧用，更稳的是直接调 `AndroidShell.getStatusBarHeightPx()`。

**仍然待解释的**：那当时「12px 时标题在、4px 时不在」调的究竟是什么？
三件独立的可能，需真机复测才能定：

1. 调的其实是「状态栏占位上移」（`statusBarDropPx`）→ 但用户说该项一直是 0，未取信
2. 调的是 `b.css` 或自定义 CSS 里 `.ds-directory` 的 padding 数值本身
3. **那两个观察本身都是 K1 的表现**（focus scroll 随机出现），只是当时被误归因成偏移值

→ 在 K1 修好之后重测：把「状态栏位置」分别设 12px / 4px，各测一次
**不聚焦**与**聚焦搜索框**两种状态，才是有效对照。

### U3. 键盘 hook 与 CSS 的契约 【代码层已实证：不一致确实存在，但当前路径无害】

本 fork 的 `phone-shell.css` 现在是：

```css
margin-top: calc(-1 * var(--status-bar-drop, 0px));
transform: translate3d(0, calc(-1 * var(--mobile-keyboard-lift, 0px)), 0);
```

而 `desktop-shell.tsx` 第 1021 行注释写的是「抬升已改用 margin-top（真实布局位移）实现」。
**注释与实现不一致**。

**已读码证实（`desktop-shell.tsx` 第 973–1002 行）**，`update()` 有三处提前 `applyLift(0); return;`：

```js
if (!element || document.activeElement !== element || !mobileMq.matches || !viewport) {
  applyLift(0); return;                       // ① 失焦 / 非移动端 → 清零
}
if (document.documentElement.dataset.nativeKbResize === "1") {
  applyLift(0); return;                       // ② 原生压缩已接管 → 清零
}
if (keyboardInset < 80) {
  applyLift(0); return;                       // ③ 键盘没起来 → 清零
}
```

**结论（可以确定的两点）**：

1. **失焦会清零**。`handleFocusOut` → `requestUpdate()` → `update()` 走分支 ① → `applyLift(0)`。
   之前担心的「失焦没清、lift 永久留下」**不成立**。
2. **原生压缩路径上 lift 恒为 0**。分支 ② 命中时，`--mobile-keyboard-lift` 被移除，
   CSS 写成 `transform` 还是 `margin-top` **结果完全相同**。

所以 U3 的契约不一致**是真实存在的**（注释与实现不同步），
**但它不是当前故障的成因**，属于"技术债"，可以以后再统一，不必现在动。

**唯一残留风险**：若浏览器**不支持** `interactive-widget=resizes-content`，
`nativeKbResize` 永不置位 → 走手动抬升 → `transform` 视觉位移生效
→ 那套「hit-test 与视觉错位」的老问题会回来。你的 WebView 是 Chrome 116，支持该属性，当前不受影响。
（可用 `chrome://inspect` 看 `document.documentElement.dataset.nativeKbResize` 弹键盘时是否为 `"1"`。）

### U4. 是否把 K1 的通用部分提给上游 【待定】

`.app-root` / `.phone-shell` 的 `overflow: hidden` 在官方主线也存在，
即「focus scroll 能把壳滚走」是**上游也有的问题**。
但 `.ds-directory` 是本 fork 独有。若将来要报，**只报前两处**，且需先验证官方版本可复现。

---

## 七、给未来的自己

1. **别信工具摘要，去读文件。**（K4，已经因此跑偏两轮）
2. **别在桌面 Chrome 验证和键盘/媒体查询相关的改动。**（K2）
3. **改 `overflow` 前先想：这个容器是「要裁」还是「要滚」。**（K1 / K5）
4. **加毛玻璃前先想：它是不是嵌套在另一个模糊里。**（K6）
5. **遇到「时有时无」，先找"什么在变"**——很可能是滚动位置、变量、或缓存，
   而不是布局本身。（K1 就是这样，一开始全班人马都在查布局）
6. **文档比记忆可靠。** 尤其是"为什么这么改"，隔一天就忘。
7. **按帧触发的性能改动默认不做。** 入场优化再漂亮，只要每帧触发就会拖累常态交互；
   能在代码层面推出的代价，不要拿用户的真机去验。（K11）
8. **验证之前先确认"跑的是哪个包"。** UA 版本号 / `typeof window.AndroidShell`
   两行就能排除"改了却没生效"这一大类假象——本轮 UA 就曾长期错报版本。（K12）
9. **排查前先说清环境：壳内还是浏览器。** 原生代码在浏览器里一行都不执行，
   搞错这一条，整条推理链会全部作废。

---

## 八、完整改动清单（依据 `doremy1203:main...main` 完整 diff）

这一节按文件逐条列净改动，供"我到底加了什么"的快速核对。

### 8.1 存储键（全部新增，与多页布局完全隔离）【实证】

| 键 | 内容 | 读取函数 |
|---|---|---|
| `ai_phone_desktop_view_mode_v1` | `"paged"` / `"single"` | `loadDesktopViewMode()` |
| `ai_phone_single_favorites_v1` | 单页「常用」图标 id 数组 | `loadSingleFavorites()` |
| `ai_phone_single_widgets_v1` | 单页组件类型字符串数组 | `loadSingleWidgets()` |
| `ai_phone_single_widget_sizes_v1` | `{ 类型: 尺寸 }` 覆盖表 | `loadSingleWidgetSizes()` |
| `ai_phone_single_widget_labels_v1` | 布尔，是否显示组件名 | `loadSingleWidgetLabelsVisible()` |

每个键都 `registerKvMigration(...)` 注册过，会被 `hydrateKvDb` 从 localStorage 迁进 IndexedDB。

**「从未设置过」用 `null` 表达**：

```ts
/** 读取单页「常用」清单；从未设置过时返回 null（调用方自行决定默认值）。 */
export function loadSingleFavorites(): DesktopIconId[] | null
```

调用方据此区分「用户清空成空数组」和「从没配过、该给出厂默认」。
`loadSingleWidgets()` 同理。而 `loadSingleWidgetLabelsVisible()` 默认 `true`，
`loadSingleWidgetSizes()` 默认 `{}`（缺项回落到组件推荐尺寸）。

### 8.2 出厂默认与首次水合 【实证】

```ts
// desktop-shell.tsx
const singleContentReadyRef = useRef(false);

useEffect(() => {
  if (singleContentReadyRef.current || !desktopReady) return;  // 只跑一次，且必须等桌面数据就绪
  singleContentReadyRef.current = true;
  const storedFavorites = loadSingleFavorites();
  const storedWidgets = loadSingleWidgets();
  setSingleFavorites(storedFavorites ?? (layout.page1 ?? []).map(item => item.id));
  setSingleWidgets(storedWidgets ?? DEFAULT_SINGLE_PAGE_WIDGETS);
  ...
}, [desktopReady, layout]);
```

- 常用默认 = **多页第一页的图标**（`layout.page1`），`null` 才回落到这里
- 组件默认 = `DEFAULT_SINGLE_PAGE_WIDGETS` = `["largeTime", "calendar", "mascot"]`

> ⚠️ 特别注意 `!desktopReady` 这个前置条件。`singleContentReadyRef` 一旦置 true 就不再跑，
> 如果哪天桌面数据水合变慢、而这个 effect 提前跑过，就会永久用上"空的 page1"当默认值。
> 这是单页「常用」莫名变空时第一个要怀疑的点。

### 8.3 单页组件的尺寸规则 【实证】

```ts
// lib/widget-types.ts
export function resolveSingleWidgetSize(type: string): WidgetSize {
  if (type === "calendar") return "3x2";        // 特例
  const entry = WIDGET_CATALOG.find((item) => item.type === type);
  return entry?.size ?? "2x2";
}
```

**日历为什么是特例（3x2）**——源码注释原文：

> 2x2 里要塞 7 行（星期表头 + 最多 6 周日期），扣掉上下留白每行只剩约 11px，
> 而日期字号是 9px，行距几乎为零。单页给它 3x2（宽度不变、多一格行高），每行约 21px。

即：**这是"2x2 装不下 7 行"的必然结果，不是审美选择。** 别随手改回 2x2。

另外：

- `SINGLE_PAGE_WIDGET_CATALOG` = 完整 `WIDGET_CATALOG` 映射，含 `freestyle` 标记
- 尺寸覆盖**只对标准组件开放**，自由艺术 / DIY 组件形状是设计死的，改尺寸会变形
- 主题 App 给的尺寸档位：`["1x4", "2x2", "3x2", "2x4", "4x4"]`

### 8.4 三个 render 函数的分工 【实证】

| 函数 | 用在哪 | 特点 |
|---|---|---|
| `renderSingleIcon(iconId)` | 目录格子、文件夹兜底 | 外观与多页图标同款，但**不挂长按拖拽** |
| `renderCardIconNode(iconId)` | 单页「常用」卡片 | 画进 `.card-icon` 圆底，图片优先、否则 glyph |
| `renderDirectoryIcon(iconId)` | 目录格子 | = `renderSingleIcon` + 右上角「钉进常用」星标 |

**为什么单页不挂拖拽**（源码注释）：

> 单页与目录页里的图标：外观与多页图标完全同款……但不挂多页那套长按拖拽——
> 这两处都是列表，拖拽排布请切回分页桌面做。

星标是**绝对定位**的（`.ds-pin`），不占布局，所以格子尺寸与普通图标完全一致。

### 8.5 应用目录的分组逻辑 【实证】

```ts
const custom  = customApps.map(app => toCustomAppIconId(app.id));
const builtin = (Object.keys(ICONS) as IconId[]);
// 只有两组：「我的应用」/「内置应用」
```

**注意三个"不包含"**（容易误判成 bug）：

1. **不包含 Dock 上的图标**——Dock 是 `dock` 数组，与 `ICONS` 无关
2. **不包含文件夹**——`isFolderIconId` 的直接 `return null`
3. **不包含已卸载/未知的 icon**——`getDesktopIconMeta` 拿不到就跳过

搜索是按 `meta.label`（中文名）和 `iconId` 两者做小写包含匹配。

### 8.6 `card-grid` 的改动（共享组件，风险点）【实证】→ 见 K9

### 8.7 `widget-renderer` 的改动 【实证】→ 见 K10

---

## 九、K9 / K10（从完整 diff 新发现的两处）

### K9. 改动了共享组件 `components/ui/card-grid.tsx` 【实证】

这个组件**不只为单页服务**，设置页、外观页都在用它。改动是**向后兼容**的：

```diff
 export type CardItem = {
   id: string;
-  icon: LucideIcon;
+  /** Lucide 线性图标；也可以改用下面的 glassIcon / iconNode */
+  icon?: LucideIcon;
   label: string;
   iconColor: string;
   glassIcon?: string;
+  /** 自定义图标节点。传了它优先，忽略 icon 与 glassIcon */
+  iconNode?: ReactNode;
 };

-{item.glassIcon ? <GlassIcon name={item.glassIcon} /> : <Icon size={22} />}
+{item.iconNode ? item.iconNode
+  : item.glassIcon ? <GlassIcon name={item.glassIcon} />
+  : Icon ? <Icon size={22} strokeWidth={1.75} />
+  : null}
```

**风险与结论**：
- `icon` 从必填变可选 → 老调用方全部照常（TS 宽松了，不会报错）
- 渲染优先级 `iconNode > glassIcon > icon`，**老的两个入口行为未变**
- 唯一行为差异：`icon` 缺失且无 `glassIcon`/`iconNode` 时渲染 `null` 而非崩溃

**排查提示**：如果**设置页 / 外观页**的卡片图标出现异常，
第一嫌疑就是这个文件——它不在单页的样式隔离范围内（`.desktop-single` 前缀管不到它）。

#### ⚠️ K9 附：`FeaturedCard` 没有跟进加保护（潜在崩溃点，已读码确认）

`CardGrid` 做了 `Icon ? <Icon/> : null` 的空值保护，但**同文件的 `FeaturedCard` 没有**：

```ts
// 第 75 行：注意这里 icon 沿用了 CardItem 的可选定义
export type FeaturedCardItem = CardItem & { desc: string };

// 第 77–89 行：没有 null 保护
export function FeaturedCard({ item }: { item: FeaturedCardItem }) {
  const Icon = item.icon;                        // ← 可能是 undefined
  ...
  {item.glassIcon ? <GlassIcon name={item.glassIcon} /> : <Icon size={22} />}   // ← 直接当组件用
}
```

因为 `CardItem.icon` 从**必填改成了可选**，`FeaturedCardItem` 跟着变可选，
但 `FeaturedCard` 仍然无条件渲染 `<Icon />`。

- **现在没有崩**：所有调用 `FeaturedCard` 的地方都还传着 `icon`，运行时不会触发
- **但类型层面已经松了**：以后谁给 `FeaturedCard` 传一个只有 `glassIcon` 的 item，
  会直接报 `Element type is invalid`——而且是运行时崩，TS 不拦

**若要补**（一行）：

```ts
item.glassIcon ? <GlassIcon name={item.glassIcon} />
  : Icon ? <Icon size={22} strokeWidth={1.75} /> : null
```

**结论**：K9 的改动方向没问题（向后兼容、老调用方行为不变），
但 `FeaturedCard` 这处是**同一次改动留下的不对称**，属于已知隐患而非当前故障。

### K10. 修掉了组件名占位的旧 bug 【实证】

```diff
-{!preview && <span className="widget-label">widgets</span>}
+{!preview && widgetName ? <span className="widget-label">{widgetName}</span> : null}
```

原来无论什么组件，名字一律显示字面量 `"widgets"`（而上一行算出来的 `widgetName` 没人用）。
现在显示真实名字，未知类型则不显示。

**连带影响**：所有桌面组件的名字标签都变了（多页桌面也受影响，不只是单页）。
若有人反馈"组件下面的文字变了/不见了"，这是**预期的修复**，不是新 bug。

---

## 十、K11 / K12（2026-10-17 第二轮：一次失败的性能优化 + 一条版本链路坑）

> 这一节接在「九」之后，编号继续。两件事都不是单页桌面的功能问题，
> 但都会在下一次排查时把你带偏，所以单独记。

### K11. 键盘「逐帧跟随」：看着像优化，实际是每帧 reflow 【实证 · 已回滚】

**做了什么**

把键盘让位从「变化时写一次底部内边距」改成「按系统动画逐帧插值写」：

```kotlin
// 已删除的实现（曾在 b04b50cf51 前存在）
ViewCompat.setWindowInsetsAnimationCallback(window.decorView,
  object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
    override fun onProgress(insets, runningAnimations): WindowInsetsCompat {
      val target = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      applyImePadding(imeAnimFromPx + ((target - imeAnimFromPx) * animation.interpolatedFraction).roundToInt())
      return insets
    }
  })
```

出发点是对的：只挂 `OnApplyWindowInsetsListener` 时，Android 11+ 要等动画收尾才派发终值，
输入栏是「后让位、一次跳到位」，有跳变观感。

**真机结果：卡。** 用户反馈「问题没解决，然而卡卡的」。已整体回滚（`b04b50cf51`）。

**为什么必然卡（不需要实测就能推出来，这才是教训）**

1. 每次 `setPadding` = 一次 `requestLayout`。逐帧 = **每秒 60 次布局**。
2. WebView 高度每帧变化 → 网页收到 60 次/秒 `resize`。
3. 网页侧 `useAndroidNativeKeyboardViewport` 监听 `window.resize`，
   每次都写 `--phone-screen-height` → 再触发一轮样式重算 + 重排。
4. 这条链还正好喂在 **K1 那条未定位的竞态**上（键盘变更 → resize → 改 CSS 变量 → 重绘不稳定）。

于是：为一个入场动画，牺牲了**常态**流畅度，同时给未定位的 bug 增加了 60 倍触发源。

**结论 / 以后的规矩**

- 键盘让位恢复「变化时落一次终值」，跳变不好看但可预期。
- **要做跟手，先解决"每帧 reflow"这个根本代价**——例如只动 `transform`
  （不参与布局，可走合成器）而不是改容器尺寸/padding。直接在回调里改 padding 这条路是死的。
- 更普适的一条：**评估性能改动要区分「入场/瞬时」与「常态」**。
  入场优化再漂亮，只要按帧触发就会拖累每一次交互。
  这类改动应该**默认不做**，等有明确的真机收益证据再说，而不是"先上真机看看"——
  代价由用户的时间和手感来付，得到的却是一个本来就能推出来的结论。

### K12. 壳的版本链路：装不上、也认不出跑的是哪个包 【实证 · 已修】

改 `android-shell/` 是**必须重打包重装**的（K3），于是这条链路上每个环节都会咬人。
本轮连续踩到三处，全部已修：

**① APK 只在 push 到 `main` 时构建**（`.github/workflows/android-shell.yml`）

```yaml
push:
  branches: [main]
  paths: ["android-shell/**", ".github/workflows/android-shell.yml"]
```

在 `dev-ui` 上改原生代码 → **不会触发构建**。表现是"我改了，重新装还是老样子"。
两条出路：合到 `main`，或用 `workflow_dispatch` 手动跑（可指定 `site_url`，
但换 host = 换 origin = 空环境，见 K3）。

**② `versionCode` 不递增 = 新包装不上**

`build.gradle` 自己写着：

> versionCode 必须严格递增，否则 Android 拒绝覆盖安装（表现为「应用未安装」）。

回滚时只改代码、没动版本号，新包能编出来但**装不上**，而报错文案是「应用未安装」——
极容易被误判成"包有问题"或"回滚无效"。已升到 `versionCode 12 / versionName 1.0.13`。

**③ UA 里的版本号在骗人**

```kotlin
// 修前
const val VERSION = "1.0.10"   // build.gradle 里 versionName 已经是 1.0.12
userAgentString = "$userAgentString FloatShell/$VERSION"
```

`VERSION` 拼进 WebView 的 UA，却与 `versionName` 长期不一致。
后果：**排查"手机上跑的是不是最新包"这条线索彻底失效**——你以为在验证新代码，
实际看的是旧版的 UA。已对齐为 `1.0.13`，升版时**两处必须一起改**。

**零成本确认「跑的是哪个包」**：壳内控制台看

```js
navigator.userAgent           // 末尾应是 FloatShell/1.0.13
typeof window.AndroidShell    // "object" = 在壳里；"undefined" = 在浏览器
```

浏览器里跑原生代码的改动**一行都不会执行**，这一点会让排查方向完全跑偏
（本轮一度差点把浏览器当壳来怀疑，见下方 §11.3）。

---

## 十一、2026-10-17 第二轮实测记录（交接用）

### 11.1 本轮做了什么（4 个提交，全部在 dev-ui）

| 提交 | 内容 | 状态 |
|---|---|---|
| `ffc11d4e60` | `.ds-directory` 顶部让位改读 `--android-shell-status-bar-height` | 保留 |
| `9402b7146d` | 回滚 `contain: paint` / `translateY`（K1 证伪的盲测） | 已还原 |
| `b04b50cf51` | 撤掉键盘逐帧跟随（K11） | 已还原 |
| `6d6ff117a8` | 升 versionCode/Name + UA 对齐（K12） | 保留 |

同批还保留了一处**纯 CSS 的独立改进**：`.ds-directory` 底色去掉
`color-mix(… 99%, transparent)`，改完全不透明（与 K6 同向，不涉及合成层假设）。

### 11.2 没有解决的：K1 原样未动

**必须说清楚**：本轮**没有修复 K1**（点搜索框 → 标题/搜索框消失）。
回滚那两条 CSS 之后，它回到了未修复的原始状态。原因是本台账实验 3 / B
已经证伪了 CSS 盲测这条路线（删 `contain: paint` 只是把故障时机对调）。

唯一算修的显示类问题是 U2（状态栏高度），它和 K1 无关。

### 11.3 【待验证】状态栏高度接线是否生效

改法是让 `.ds-directory` 优先读壳注入的实测值：

```css
padding: calc(var(--android-shell-status-bar-height, var(--status-bar-height, 36px)) + 12px) …;
```

**验证方法（不用重装 APK，网页部署即生效）**——壳内控制台：

```js
getComputedStyle(document.documentElement).getPropertyValue('--android-shell-status-bar-height')
getComputedStyle(document.querySelector('.ds-directory')).paddingTop
```

- 第一行**有数值**（如 `28px` / `30px`）= 注入通了、CSS 接上了；
  第二行应等于它 + 12px。此时目录顶部留白在各机型才真正贴合。
- 第一行**为空** = `injectStatusBarHeight()` 没跑起来（注意它内部有
  `statusBarHeightCssPx > 0` 的前置判断，取不到就静默不发）。这属于原生层问题，
  要看 Logcat，不是网页能修的。

⚠️ 这条**截至本轮结束尚未真机确认**，下次上来第一件事就是跑上面两行。

### 11.4 下次继续的入口（按优先级）

1. **先确认装的是新包**（K12 的 UA 检查）——否则后面一切结论都不可信；
2. 验证 11.3 那两行 console 输出；
3. 再攻 K1：按 U1 的诊断脚本（键盘弹起状态下列出所有 `scrollTop != 0` 的元素），
   一次定位，不再做 CSS 盲测；
4. 顺带对比 `b.css`（约 300k，几乎全 `!important`）在 / 不在时的流畅度差异 ——
   它是常态卡顿的独立嫌疑，与本轮原生改动无关（K7）。
