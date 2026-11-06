> **历史移植资料，不是当前部署操作手册。** 本文记录的是从旧项目/上游移植 Supabase「更新已有项目」链路时的分析。文中来源仓库名、文件清单、接口细节和部署步骤均属于当时快照；当前功能以本仓库 `components/settings/cloud-services-setup.tsx`、`app/api/supabase-admin/route.ts`、`app/api/push/deploy-personal/route.ts`、`lib/personal-push-cloud.ts` 及现行 SQL 为准。执行任何步骤前必须重新核对当前代码和目标 Supabase 项目，不能照搬旧项目名称或旧文件清单。

# Supabase「更新部署」链路移植指南

> 来源：`Zyxxx1203/momo.float.phone`（`main`）相对官方上游的实际改动
> 目的：让其他仓库（或别的 AI）照着这份教程，把「云服务部署 → 原地更新已有项目」这套能力复刻过去
> 口径：只覆盖「云服务部署」这一条链——部署页 + 管理 API 代理 + 部署执行 + 个人云客户端 + 同屏的排查／清空工具。不含通话、剧情、生图等无关改动。

---

## 0. 适用前提与实测边界

| 项目 | 说明 |
| --- | --- |
| 基线 | 官方上游 `main`（未打过本套补丁的干净版本） |
| 目标 | 用户在自己的 Supabase 上，能一键**新建**或**更新**个人云项目（云备份 / 微信接入 / 离线推送） |
| 关键依赖 | Node.js 20+、Next.js（App Router）、Supabase 官方 Management API |
| 环境变量 | 本套改动**不新增**任何环境变量 |

本文标注 `【实证】`＝逐行读过源码；`【半实证】`＝读了主文件但未走完整条调用链。打后者标记的地方，动手前请再自行核对。

> 一处已知的数据缺口：本次「对比官方版本」返回的可贡献清单里**没有列出 `app/` 目录下的任何文件**，但单独查询 `app/api/push/jobs/route.ts` 却能返回逐行 diff。两者矛盾说明该清单可能被截断。因此本文中 `app/api/` 相关部分全部是**直接读源码**得出的，不是靠对比列表推断。【实证】

---

## 1. 这条链由哪些文件组成

| 文件 | 性质 | 职责 |
| --- | --- | --- |
| `components/settings/cloud-services-setup.tsx` | 改（+214/-2） | 部署页 UI：Token 输入、组织/范围选择、**原地更新入口**、排查、清空 |
| `app/api/supabase-admin/route.ts` | 改 | 服务端代理 Supabase Management API（浏览器直连会被 CORS 拦） |
| `app/api/push/deploy-personal/route.ts` | 改 | 真正执行「部署 5 个 Edge Function + 建表」 |
| `app/api/push/jobs/route.ts` | 改（+36/-8） | 离线任务写入口；含「全清」与「running 转 cancelled」 |
| `lib/cloud-backup/config.ts` | 改 | `managedProjectRef` 标记——决定弹窗给「更新」还是「新建」 |
| `lib/personal-push-cloud.ts` | 改（+0/-0，实为有实质改动） | 个人云状态、部署、健康检查、换设备重连 |
| `lib/cloud-deploy-status.ts` | 改 | 部署状态本机标记 |
| `lib/push-selfcheck.ts` | **新增** | 服务端链路自检的客户端封装 |
| `lib/push-bailout-diagnostics.ts` | **新增** | 本机预约诊断（逐条重跑 arm*） |
| `lib/bailout-dirty.ts` | **新增** | 排期落盘 → 立刻挂单的信号 |
| `lib/bailout-cancel.ts` | **新增** | 删规则 → 通知服务端撤销的信号 |

> 说明：`lib/personal-push-cloud.ts` 在对比清单里显示 `+0/-0`，**不代表没改**——超限后对比接口不附 diff 统计。**不要拿 `+0/-0` 当没改的证据。**

---
## 2. 核心改动：为「丢失标记的既有项目」提供显式更新入口

### 2.1 现象

用户以前能对自己的 Supabase 项目「重新部署＝更新」，后来发现部署弹窗**只给「创建并部署」**，等于只能新建项目，无法把新版云函数覆盖上去。

### 2.2 根因【实证】

部署弹窗的分叉只看一个本机标记 `managedProjectRef`（存在 `ai_phone_cloud_backup_config_v1` 里）：

```ts
const configuredRef = projectRefFromUrl(config.url);
const managedRef = config.managedProjectRef === configuredRef ? configuredRef : "";
if (managedRef) { /* 原地更新 */ } else { /* 走新建流程 */ }
```

而这个标记**只在「通过应用创建项目」时写入**（`runDeploy` 里 `saveCloudBackupConfig({ ..., managedProjectRef: projectRef, ... })`）。

**「换设备重连」不会写它**——`runConnect` 只覆盖 `url` 和 `key`：

```ts
const nextConfig = {
    ...loadCloudBackupConfig(),
    url: normalizeBackupUrl(connectUrl),
    key: connectKey.trim(),
};
saveCloudBackupConfig(nextConfig);
```

于是链条是：换设备／清浏览器数据 → 本地 IndexedDB 被清、标记丢失 → 用「换设备重连」接上（只恢复地址与 key）→ 再想部署时被判成「非本应用创建的项目」→ **只给新建**。旧版手填地址连接的项目也从来没有这个标记。

> **注意**：真正的部署接口本身**一直是支持更新的**——它用 `POST /v1/projects/{ref}/functions/deploy?slug=<函数名>`，**同名即覆盖**。问题只在前端愿不愿意把 `selectedRef` 设成那个既有项目。

### 2.3 改动内容【实证】

**目标**：不削弱原有保护（自动判定仍只认「本应用创建过」的项目），但给用户一条**必须主动点击**的更新路径。服务端的独立项目校验照旧兜底。

**文件**：`components/settings/cloud-services-setup.tsx`

#### ① 新增两个状态

```tsx
// 本机当前已连接、但不是「本应用创建」的项目 ref：弹窗里据此提供显式的原地更新入口
const [existingRef, setExistingRef] = useState("");
// 用户是否主动选择了「更新这个非本应用创建的既有项目」（决定是否显示红字警示）
const [updateOverride, setUpdateOverride] = useState(false);
```

#### ② `openScopeDialog`：无标记时记下既有项目，但**不自动选中**

```tsx
if (managedRef) {
    // 本应用创建过的专用项目允许原地重新部署；旧版手填/误选项目没有标记，
    // 默认走新建流程，绝不把这次发布写回已有业务库。
    setSelectedRef(managedRef);
    setExistingRef("");
    setUpdateOverride(false);
    setOrganizations([]);
    setSelectedOrganizationSlug(config.managedOrganizationSlug || "");
} else {
    // 没有标记但本机确实连着一个项目（多因换设备/清数据丢了标记）：
    // 不在弹窗里自动选中它，只在用户明确点「更新这个项目」时才原地更新。
    setExistingRef(configuredRef);
    setUpdateOverride(false);
    const data = await callSupabaseAdmin<{ organizations: OrganizationOption[] }>({ action: "organizations", token });
    // ...其余不变（拉组织列表、选中唯一组织等）
}
```

**关键**：`else` 分支里 **`setSelectedRef("")` 依旧**，即默认仍然是「新建」。`existingRef` 只是拿来渲染那个按钮。

#### ③ 新增 `startUpdateExisting`

```tsx
/**
 * 显式改为「原地更新本机已连接的既有项目」。
 *
 * 只由用户在弹窗里主动点击触发：自动判定仍然只认本应用创建过的项目，
 * 这条路径把「这是我自己要更新的项目」变成一次明确的用户动作，
 * 服务端 assert_dedicated_project 独立项目校验照旧兜底。
 */
const startUpdateExisting = () => {
    if (busy || !existingRef) return;
    setSelectedRef(existingRef);
    setUpdateOverride(true);
    setSelectedOrganizationSlug("");
};
```

#### ④ 弹窗：三态说明 + 更新按钮 + 按钮文案

说明区从「两态」扩成「三态」：

```tsx
{!selectedRef ? (
    <div className="menu-desc ...">将新建独立的「AI Phone Personal Cloud」项目，不会写入任何已有项目。</div>
) : updateOverride ? (
    <div className="rounded-[14px] bg-amber-500/10 px-3 py-2.5 ... text-amber-700">
        ⚠️ 将把本次发布<strong>写入你当前已连接的既有项目</strong>
        （{existingRef}.supabase.co）。此项目不是本应用创建的，部署会覆盖其中的
        ai-phone-push / push-generate 等同名云函数。请确认这就是你要更新的项目。
    </div>
) : (
    <div className="menu-desc ...">将更新此前由 AI Phone 创建的专用项目。</div>
)}
```

紧接着插入「更新这个已有项目」入口（**只在没选中项目、但存在既有项目时出现**）：

```tsx
{!selectedRef && existingRef ? (
    <div className="flex flex-col gap-2 rounded-[14px] bg-black/[0.03] px-3 py-2.5">
        <span className="menu-desc !mt-0">
            本机当前连着一个项目（{existingRef}.supabase.co），但没有「本应用创建」标记
            （换设备、清数据或旧版手填地址都会这样）。要更新它就选这里，否则将新建项目。
        </span>
        <button
            type="button"
            className="ui-btn ui-btn-outline self-start"
            onClick={startUpdateExisting}
            disabled={Boolean(busy)}
        >
            更新这个已有项目
        </button>
    </div>
) : null}
```

底部主按钮文案随之变化：

```tsx
{updateOverride ? "更新此项目" : selectedRef ? "开始部署" : "创建并部署"}
```

### 2.4 为什么要这么设计（安全取舍）

- **不做**「重连时自动补写标记」：那会让标记语义从「本应用创建」放宽成「本应用连过」，等于用户一次误连就把自己的业务库暴露成部署目标。
- **做**「显式点击 + 红字警示」：把「这是我要更新的项目」变成一次明确的用户动作，同时保留服务端 `assert_dedicated_project` 那道独立项目校验作为最后一道闸。
- 用户若偏好零风险，仍可手动去 Supabase Dashboard 粘贴覆盖，效果等价。

---

## 3. 部署执行层

### 3.1 `app/api/push/deploy-personal/route.ts`【实证】

**职责**：接收前端打包好的 5 份 Edge Function 源码 + schema SQL，把它们部署到**用户自己的** Supabase 项目。

核心是这一段——**同名覆盖，即「更新」**：

```ts
async function deployFunction(params) {
  const form = new FormData();
  form.append("metadata", JSON.stringify({
    name: params.slug,
    entrypoint_path: "index.ts",
    verify_jwt: false,
  }));
  form.append("file", new Blob([params.code], { type: "application/typescript" }), "index.ts");
  return fetch(
    `https://api.supabase.com/v1/projects/${params.projectRef}/functions/deploy?slug=${params.slug}`,
    { method: "POST", headers: { Authorization: `Bearer ${params.token}` }, body: form },
  );
}
```

部署的 5 个函数 slug：

```ts
const GATEWAY_SLUG = "ai-phone-push";
const GENERATE_SLUG = "push-generate";
const RESULT_SLUG = "push-shortcut-result";
const BRIDGE_SLUG = "push-bridge";
const SCREEN_SLUG = "screen-chat";
```

**顺序很关键**——必须在部署前先做独立项目检查：

```ts
// 必须在部署同名函数之前检查。主项目也有 push-generate / push-bridge；
// 若先部署再查库，错误目标会先覆盖生产函数版本。
const dedicatedProject = await assertDedicatedProject({ projectRef, token });
if (!dedicatedProject.ok) { /* 409/502 中止 */ }
```

`assertDedicatedProject` 用一条只读 SQL 判定：目标库要么已有 `ai_phone_cloud_meta` 标记，要么除白名单表外**没有任何其他业务表**；否则返回 `shared-project-blocked`，中止部署。白名单表为：`push_server_config`、`push_subscriptions`、`push_jobs`、`push_outbox`、`push_shortcut_commands`、`push_bridge_config`、`push_bridge_snapshots`、`push_screen_sessions`、`push_screen_threads`。

**保留原样**：校验各包特征串（如 `generateCode.includes("离线推送·兜底生成执行器")`）、大小上限（网关 600KB / 生成器 900KB 等）、`schemaSql` 必须以 `-- ai-phone-personal-push-schema-v1` 开头且含 `__PROJECT_REF__`。

### 3.2 `app/api/supabase-admin/route.ts`【半实证】

**职责**：代理 `https://api.supabase.com/v1`。**必须走服务端**——`api.supabase.com` 不向第三方站点返回 CORS 放行头，浏览器直连会被拦（与微信/推送一键部署同因）。

支持的动作（前端按 `action` 分发）：`organizations` / `create_project` / `project_status` / `run_sql` / `api_keys` / `assert_dedicated_project`。

安全约定（移植时别丢）：

- Token 与取回的 `service_role key` **只在本次请求中透传，不存储、不记录**；
- 错误信息统一过 `safeErrorText`，把 `sbp_…` / `sb_secret_…` / JWT 打码后再回传，并附上按 HTTP 状态给出的中文处置建议（401/403/429/5xx）。

### 3.3 `lib/personal-push-cloud.ts`【实证】

三个出口：

- **`deployPersonalPushCloud(accessToken)`**：从本站 `/ai-phone-push/*.mjs` 取 6 个部署包（5 函数 + schema），POST 给 `/api/push/deploy-personal`；成功后写 `personal_push_cloud_state_v1`（先 `pending`，健康检查通过转 `ready`）。
- **`connectPersonalPushCloud()`**：**换设备重连**——只要 URL + `service_role key`，打一次网关 `?action=health`，通过就就地恢复本机状态，**不重新部署、不需要 Access Token**。（注意：它**不补写** `managedProjectRef`，这正是第 2 节问题的来源。）
- **`pushJobsFetch(init)`**：任务是发个人云还是本站，取决于环境——**壳环境一律走站点** `/api/push/jobs`。原因写在代码里：个人云网关把任务挂在 `OWNER_ID("owner")` 下，而壳订阅的频道是 `shellpush:<站点账号 id>`，两边永远对不上，任务建了也没人收。

还有一处易漏的兼容逻辑：

```ts
// 一旦管理接口确认个人函数已部署，立即关闭共享任务门控。
// 即使健康检查尚在传播，也只允许等待个人云，绝不把任务重新送回 Netlify。
kvSet(PUSH_SUBSCRIPTION_GATE_KEY, JSON.stringify({ subscribed: false, checkedAt: Date.now() }));
```

### 3.4 `lib/cloud-backup/config.ts`【实证】

新增两个可选字段（**旧配置读到 undefined，天然兼容**）：

```ts
/** Project provisioned by AI Phone. Old/manual configs deliberately have no marker. */
managedProjectRef?: string;
/** Organization selected by the user when the managed project was created. */
managedOrganizationSlug?: string;
```

`loadCloudBackupConfig` 读取时按 `typeof === "string"` 校验；`saveCloudBackupConfig` 原样透传（不做删减）。

### 3.5 `lib/cloud-deploy-status.ts`【实证】

本机部署标记，供「三处入口只显示已部署/未部署 + 一个按钮」使用：

```ts
const WEIXIN_DEPLOYED_KEY = "ai_phone_weixin_cloud_deployed_v1";
const WEIXIN_SCHEDULED_KEY = "ai_phone_weixin_cloud_scheduled_v1";
const PUSH_SCHEDULED_KEY = "ai_phone_push_cloud_scheduled_v1";

/** 部署脚本默认就带定时任务，所以缺省视为开。 */
export function loadPushCloudScheduled(): boolean {
    return kvGet(PUSH_SCHEDULED_KEY) !== "0";
}
```

---

## 4. 部署页同屏的两个工具

### 4.1 一键排查【实证】

部署页那句「收不到主动消息？一键排查 →」把**两段**结果拼在一起：

```tsx
const result = await runOfflinePushSelfCheck(true);   // 服务端整条链
sections.push(formatSelfCheckReport(result));
sections.push("─── 本机主动消息预约 ───");
sections.push(await diagnoseScheduledBailouts());      // 本机逐条重跑 arm*
```

分工写得很清楚（`lib/push-selfcheck.ts` 顶部注释）：

- `push-bailout-diagnostics`：只看**本机有没有把预约挂上去**，逐条重跑 `arm*`，把每个失败原因摊开；
- `push-selfcheck`：看**整条链**（服务端配置、订阅、任务表、回传箱、真实广播），用来判断断点究竟在服务端还是客户端。

### 4.2 清空存量预约【实证】

两个配套改动，缺一不可：

**前端**（`cloud-services-setup.tsx`）——注意刻意用**动态 import**：

```tsx
// 刻意用动态 import：push-bailout-client 本身很大（连着一整条提示词组装链路），
// 顶部静态引入会把它拉进首屏加载图、改变模块求值顺序。
const { purgeAllBailoutJobs } = await import("@/lib/push-bailout-client");
```

**服务端**（`app/api/push/jobs/route.ts`）——这是最关键的一处逻辑修正：

```ts
// 已领取（running）的任务不能靠删除停手：那些已经跑进 push-generate 的执行体
// 持有自己的一份快照，把它从表里删掉并不会中断它，它跑完还会照常续排下一发。
// 改为把它标记成 cancelled——执行体在生成前与续排前各查一次，被撤就停手。
const cancelRunning = await supabaseRestFetch(
  `push_jobs?${userFilter}${keyFilterPart}&status=eq.running`,
  { method: "PATCH", body: JSON.stringify({ status: "cancelled", updated_at: new Date().toISOString() }) },
);
// ...随后才删除 pending
```

配套两个新增的小模块（避免循环导入）：

- `lib/bailout-dirty.ts`：排期/规则落盘即广播，让推送侧**立刻挂单**，不必等下一次轮询；
- `lib/bailout-cancel.ts`：存储层删规则时只广播事件，由 `push-bailout-client` 监听并真正发 DELETE。**只删本地不发撤销，服务端仍会照原排期推——用户删了却照收。**

### 4.3 自部署要放行共享任务接口【实证】

`app/api/push/jobs/route.ts` 顶部有一处自部署专用开关：

```ts
// 官方站点的共享推送额度已停用；但自部署用户用的是自己的 Supabase，
// 没有理由连自己也不能用。此前写死 true，导致自部署站点上「创建离线任务」
// 必然返回 503、任务永远进不了 push_jobs，主动消息功能整体失效。
const SHARED_PUSH_DISABLED = process.env.NEXT_PUBLIC_SELF_HOSTED_MODE !== "true";
```

**移植时必须一并改**，否则部署页装好了也没用——自部署实例根本挂不上任务。

---

## 5. 移植顺序（给 AI 的执行步骤）

1. **先读**：确认目标仓库里这些文件是否已存在，逐行比对后再动；**不要整体覆盖**。
2. `lib/cloud-backup/config.ts`：加 `managedProjectRef` / `managedOrganizationSlug` 两个可选字段（含 load/save）。
3. `app/api/supabase-admin/route.ts`：补齐 `organizations` / `create_project` / `project_status` / `run_sql` / `api_keys` / `assert_dedicated_project` 六个动作与错误打码。
4. `app/api/push/deploy-personal/route.ts`：`deployFunction`（同名覆盖）+ 5 个 slug + **部署前的独立项目检查**。
5. `app/api/push/jobs/route.ts`：`SHARED_PUSH_DISABLED` 改环境变量驱动；DELETE 支持 `all`；**running 先转 cancelled 再删 pending**。
6. `lib/personal-push-cloud.ts`：部署 / 重连 / 健康检查 / `pushJobsFetch` 的壳分支。
7. `lib/cloud-deploy-status.ts`、`lib/bailout-dirty.ts`、`lib/bailout-cancel.ts`、`lib/push-selfcheck.ts`、`lib/push-bailout-diagnostics.ts`（新增文件直接建）。
8. `components/settings/cloud-services-setup.tsx`：**最后改**，因为它依赖前面所有模块。含第 2 节四处改动 + 排查/清空两个按钮。
9. 环境变量：`NEXT_PUBLIC_SELF_HOSTED_MODE=true`（自部署必需）。

---

## 6. 验证清单

- [ ] 干净项目（无任何业务表）→ 部署弹窗应显示「创建并部署」，能走通；
- [ ] 已有业务表的项目 → 服务端应返回 409 `shared-project-blocked`，中止；
- [ ] 换设备后（本地无标记）→ 弹窗应出现「更新这个已有项目」入口；点击后红字警示出现、主按钮变「更新此项目」；
- [ ] 点「更新此项目」→ Supabase 上 5 个同名函数被覆盖（看 Deployment 时间戳变化）；
- [ ] 手动删掉 `managedProjectRef` 后，**默认仍然是新建**（确认没有误放宽）；
- [ ] 自部署实例上创建一条离线任务 → `push_jobs` 有记录（验证 `SHARED_PUSH_DISABLED` 已放行）；
- [ ] 点「清空存量预约」→ 表里 pending 全删、running 变 cancelled。

---

## 7. 未核实 / 需你自行确认

- `app/api/supabase-admin/route.ts` 我只读了前 120 行【半实证】——移植前请把 `create_project` / `api_keys` / `assert_dedicated_project` 三个动作的实现读完。
- `lib/push-selfcheck.ts`（共 50 行）与 `lib/push-bailout-diagnostics.ts`（91 行）读了主体，**服务端对应的 `/api/push/selfcheck` 路由本文未覆盖**——自检要真正可用，那份路由也得一并移植。
- 本文**不含**壳（`android-shell/`）与通话相关改动，那部分是另一条线。

---

## 8. 与官方上游的差异口径说明

- 对比命令：用本仓库的「对比官方版本」得到可贡献文件清单；单项用「读取贡献差异」看逐行 diff。
- **对比接口有缓存**：刚同步过官方更新时，落后的提交数可能不准，稍等几分钟再查。
- **`+0/-0` 不等于没改**：文件数超限后接口不附 diff 统计，`lib/personal-push-cloud.ts` 就是这种情况。
- 本文所有 `app/api/` 结论均为**直接读源码**所得，理由见第 0 节的数据缺口说明。
