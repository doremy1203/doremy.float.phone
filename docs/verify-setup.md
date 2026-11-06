# 成年审核 · 激活码自助申请 — 历史部署说明

> **当前状态（已核对 main 源码）**：新申请入口暂时关闭。`lib/verification-availability.ts` 中 `VERIFY_APPLICATIONS_OPEN = false`，`/api/verify/submit` 会返回 503 和关闭提示。不要按本文部署后就认为申请功能已开放。已有申请仍可通过查询码走 `/verify` 或关闭申请页面中的查询流程。重新开放前，需由维护者明确启用开关并验证完整申请、审核、删图和发码链路。

## 历史流程（仅供重新开放时核对）
1. 用户在登录页打开 `/verify`；
2. 填写昵称/联系方式并上传成年证明图片，提交后得到查询码（VR-XXXXXXXX）；
3. 管理员在 `/verify/admin` 输入管理密钥审核：查看图片、通过并发码或拒绝；
4. 用户使用查询码查询进度，通过后查看激活码。

## 重新开放前的部署要求
1. 在 Supabase SQL Editor 执行 `docs/verify-supabase.sql`（创建 `verification_requests` 表和私有桶 `verification-images`）。
2. 配置服务端 Supabase 环境变量，确保服务端使用的 service_role 凭据仅保存在服务端。
3. 配置 `VERIFY_ADMIN_KEY` 长随机密钥；未配置时管理接口不可用。
4. 由维护者将 `VERIFY_APPLICATIONS_OPEN` 改为 `true`，部署后先用测试数据验证，不要直接收集真实证明材料。

## 安全与隐私边界
- 图片存私有桶，客户端不应直接读取；管理页看图走服务端代理并校验管理密钥。
- 申请表开启 RLS 且不创建客户端 policy，读写仅经服务端 API。
- 审核完成（通过/拒绝）后应删除图片，数据库保留必要的文字审核记录。
- 查询码用于查询本人申请状态，不应公开或转发。
- 当前提交接口限制 4MB、JPG/PNG/WebP，并有同实例尽力而为的 60 秒 IP 节流；Serverless 实例之间不共享该 Map，不能视为强防刷措施。

## 重新开放后的日常操作
- 审核台：`https://<你的域名>/verify/admin`。
- 激活码来源依赖既有 `activation_codes` 表；执行 SQL 前先确认 `docs/verify-supabase.sql` 的依赖表已部署。
- 审核密钥应只存部署平台的服务端环境变量，不要写入前端变量或提交仓库。
