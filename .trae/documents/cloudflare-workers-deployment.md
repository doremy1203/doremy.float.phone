# Cloudflare Workers 部署计划

## Context

当前项目是 Next.js 15 + React 19 全栈应用，Vercel 免费额度已超限，需要迁移到 Cloudflare，同时保留 API 路由、Supabase 等服务端能力。采用官方当前推荐的 **@opennextjs/cloudflare + Workers Static Assets**，不使用旧版 Pages Next 插件。

已有的 [cloudflare-worker/wrangler.toml](file:///workspace/cloudflare-worker/wrangler.toml) 是独立的推送 Worker（D1 + Cron），视频转录 Worker 也独立存在，本次均不修改、不覆盖。

## 你需要准备

1. 一个 Cloudflare 账号，并开通 Workers 与 `workers.dev` 子域名；免费套餐即可先部署。
2. 在 Cloudflare 中授权读取你的 GitHub 仓库，用于后续自动部署；域名不是必需品，先用系统分配的 `workers.dev` 地址。
3. 如果正在使用 Supabase、应用市场、邮件等云端功能，准备对应环境变量。不要把密钥发到聊天或提交进仓库；在 Cloudflare 的环境变量设置中填写。
4. 首次由我完成代码配置和静态验证；Cloudflare 登录授权及最终线上按钮需要你的账号配合。未得到明确要求前不提交、不推送代码。

## 实施步骤

### 1. 添加 OpenNext 与 Wrangler

- 在 [package.json](file:///workspace/package.json) 安装 `@opennextjs/cloudflare`（运行依赖）和 `wrangler`（开发依赖），同步 lockfile。
- 保留原有 `build` 脚本中的微信助手、个人推送准备和 CSS 修复流程。
- 新增独立脚本：
  - `build:cf`: `opennextjs-cloudflare build`
  - `preview:cf`: 先 `build:cf`，再 `opennextjs-cloudflare preview`
  - `deploy:cf`: 先 `build:cf`，再 `opennextjs-cloudflare deploy`
  - `cf-typegen`: 生成 Cloudflare 绑定类型

### 2. 添加独立的网站 Worker 配置

- 新建根目录 `wrangler.jsonc`：Worker 名使用 `ai-virtual-phone-web`，入口 `.open-next/worker.js`，静态资源目录 `.open-next/assets`，启用 `nodejs_compat`，绑定 `ASSETS`。
- 新建 `open-next.config.ts`，先用最小 `defineCloudflareConfig()`；首版不强制创建 R2，避免额外资源和配置。
- 新建 `public/_headers`，仅为 `/_next/static/*` 添加长期 immutable 缓存。
- 在 [.gitignore](file:///workspace/.gitignore) 增加 `.open-next/`、`.wrangler/`、`.dev.vars`。
- [next.config.mjs](file:///workspace/next.config.mjs) 保持现有构建配置；项目未使用 Cloudflare 业务 bindings，不为了迁移强行改写 Next 配置。

### 3. 保持业务代码最小改动

- 保留 API 路由的 `runtime = "nodejs"`，不改成 Edge；`nodejs_compat` 用于支持现有 `node:crypto`、Buffer、`process.env`。
- 现有 Cloudflare API 代理、Supabase REST 和外部 `fetch` 保持原样。
- 不在首版迁移 [lib/watch-resolver.ts](file:///workspace/lib/watch-resolver.ts) 的本地 `.watch-cache` 大文件缓存；Workers 无持久磁盘，该能力的本地内置缓存不作为本次上线阻塞项。
- 不修改 Netlify 配置和现有独立 Worker，避免影响其他仍在使用的部署。

### 4. 配置 Cloudflare 自动部署

在 Cloudflare Dashboard 的 Workers 中导入 GitHub 仓库：

- Build command：`npx opennextjs-cloudflare build`
- Deploy command：`npx opennextjs-cloudflare deploy`
- Root directory：仓库根目录
- Production branch：`main`
- 自部署基础变量：`NEXT_PUBLIC_SELF_HOSTED_MODE=true`
- 其余变量按 [.env.example](file:///workspace/.env.example) 中实际启用的功能填写；`NEXT_PUBLIC_*` 改后必须重新构建，服务端密钥只放 Cloudflare 环境变量。

首次部署后使用 `xxx.workers.dev` 验证；需要自有域名时，再在 Worker 的 Domains & Routes 中添加。

## 验证

1. 执行依赖安装与 lockfile 一致性检查、`npx tsc --noEmit`、`npm run lint`（必须 exit 0，warnings 不超过现有 689）。
2. 尝试 `npm run build:cf`；沙箱此前存在 Next 构建 OOM，因此若仍受内存限制，记录明确日志，由本机或 Cloudflare 构建完成完整验证，不把 OOM 误判为代码错误。
3. 能构建时继续 `npm run preview:cf`，检查首页、静态资源、PWA、至少一个普通 API、Supabase 读写（若启用）及登录 Cookie。
4. 首次线上部署后检查 `workers.dev` 页面、API、浏览器 IndexedDB 数据流程、静态素材与控制台错误；若出现兼容问题，只针对报错路由做最小修复。

## 预期结果

仓库获得可复用的 Cloudflare 构建/预览/部署配置；Cloudflare 每次接收 `main` 更新后自动构建并发布，不再依赖 Vercel 额度。