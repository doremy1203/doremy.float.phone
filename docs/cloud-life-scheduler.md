# Cloud-resident life schedule evaluator

> **当前功能开关说明（2026-11-06）：** 本仓库包含云端日程评估 Edge Function，但当前客户端将生活主动消息生成关闭：`components/life/life-engine-app.tsx`、`lib/life/life-proactive-scheduler.ts` 中的 `LIFE_PROACTIVE_MESSAGES_ENABLED` 均为 `false`，`lib/life/life-schedule-cloud.ts` 同步的 `proactiveEnabled` 也为 `false`。因此本文不能被理解为“当前会自动创建并发送后台角色消息”。本文说明仍存在的日程快照、云端运行态评估代码及其部署边界。

## 代码职责

- 客户端生活系统负责编辑七日日程、角色/玩家活动与地点、场景和参与者，并把相关快照同步到个人云或站点推送桥。
- `supabase/functions/life-scheduler/index.ts` 负责读取加密日程快照，计算玩家和角色当前活动/地点，并维护 `life_schedule_runtime` 运行态。
- `supabase/functions/push-generate/index.ts` 包含生活场景任务的快照/运行态校验、并发保护、诊断和消息写入处理代码。该代码存在不代表当前客户端会安排主动消息任务。
- `app/api/life/schedule-diagnostics/route.ts` 为生活系统诊断面板提供云端诊断查询入口。

## 日程数据

客户端同步的快照包含：
- 玩家地点、角色地点；
- 活跃场景及参与角色；
- 七日日程条目；
- 角色/玩家活动状态和临时地点覆盖；
- 日程版本、场景前台租约和在线聊天租约；
- 主动消息开关状态（当前固定同步为关闭）。

云端评估函数对 `source = weekly-generation` 的常规周计划按周投影；一次性、手动、特殊活动和邀约不按常规周计划重复。具体时间和地点解析以当前 `life-scheduler/index.ts` 为准。

## 云端执行与启用条件

1. 客户端调用 `syncLifeScheduleSnapshot`，将加密日程快照写入所配置的个人云项目或站点推送桥。
2. 当个人 Supabase 已部署相应 Schema、`life-scheduler` Edge Function 和 Cron，Cron 才能周期性调用日程评估函数并更新运行态。
3. 当前主动消息开关关闭，客户端不会把该功能描述为后台主动消息已启用；即使云端存在相关生成处理代码，也不能据此推断会有新的主动消息排期或送达。
4. 通知投递还需要相应推送订阅、Realtime/Web Push 配置、网络、设备权限和后台策略。通知送达与日程运行态计算是不同结果。

## 部署边界

本仓库包含 `supabase/functions/life-scheduler/index.ts` 及构建产物 `public/ai-phone-push/life-scheduler.mjs`。个人 Supabase 项目不会因为 Netlify 网页部署而自动更新。启用云端日程评估前，应通过应用提供的个人云部署流程升级 Schema、Edge Function、Cron 和密钥，并检查运行日志与诊断表。

## 诊断边界

`life_schedule_runtime`、`life_schedule_diagnostics` 等表/函数只有在对应 Schema 已部署时才存在。遇到问题应分别核对：
- 客户端是否成功同步快照；
- 个人云 Schema 与函数版本；
- Cron 是否注册并运行；
- `life_schedule_runtime` 是否更新；
- 诊断事件是否记录；
- 推送订阅与设备端通知是否可用。

不要把页面显示了日程、代码仓库包含 Edge Function、自动化测试通过，等同于某个用户的个人云环境已成功运行。
