# 角色 ID 契约与数据链路

## 唯一规则

**Character.id 是应用内部唯一、稳定的角色主键。** 所有角色状态、记忆、工具、回合、生活系统、通话、图片生成和角色归属字段，都必须使用 Character.id。不能用显示名称、联系人 ID、会话 ID 或外部平台 ID 替代。

## ID 类型清单

| 字段 / 类型 | 含义 | 是否为角色主键 | 允许用途 |
| --- | --- | --- | --- |
| `Character.id`（通常为 `char_...`） | 角色卡主键 | 是 | 全部角色级业务数据 |
| `ChatContact.id`（通常为 `contact_...`） | 好友/联系人关系记录 ID | 否 | 联系人增删、联系人列表、关系记录 |
| `ChatContact.characterId` | 联系人指向的角色卡 | 是，引用 | 从联系人解析角色 |
| `ChatSession.id`（通常为 `sess_...`） | 一段私聊或群聊会话 | 否 | 消息归属、会话路由、通知回复定位 |
| `ChatSession.contactId` | 历史上混用过 Character.id 与 ChatContact.id 的会话关联字段 | 否，兼容字段 | 只用于旧数据读取、联系人关系查找和会话兼容 |
| `ChatSession.characterId` | 私聊对应的规范角色 ID | 是，引用 | 新代码中私聊角色解析的首选字段 |
| `participantIds` | 群聊参与角色 ID 列表 | 是，列表 | 群成员、群消息发言者、群动作 |
| `ChatMessage.senderCharacterId` | 群聊/角色消息发言者 | 是，引用 | 消息发言人和角色归属 |
| `life actorStates.ownerId` / `schedules.ownerId` | 生活系统参与者 | 是；玩家使用固定哨兵 `player` | 日程、地点、活动状态 |
| `scene.participants[].ownerId` / `timeline.actorId` | 现场角色或玩家 | 是；玩家为 `player` | 生活现场、时间线、行为记录 |
| `memory.characterId` | 记忆归属角色 | 是 | 短期/长期/核心记忆及总结水位线 |
| `ToolExecutionContext.characterId` | 工具调用所属角色 | 是 | 日历、记忆、状态、工具权限和动作 |
| `turn-coordinator.characterId` | 生成回合锁的角色键 | 是 | 同一角色的回合互斥 |
| `life_schedule_runtime.character_id` / `lifeScene.characterId` | 云端角色运行态及生活任务 | 是 | 云端日程和主动消息 |
| `sessionId` / `job_id` / `trace_id` | 会话、后台任务和诊断链路 ID | 否 | 追踪流程，不可当角色 ID |
| `wechatID` 等外部平台 ID | 第三方账号/平台标识 | 否 | 外部账号映射，不可写入角色归属字段 |

## 核心调用链

```text
Character.id
  ├─ ChatContact.characterId
  │    └─ ChatContact.id ── ChatSession.contactId（旧关联）
  │                              └─ ChatSession.characterId（规范关联）
  ├─ ChatSession.characterId
  │    ├─ chat-engine prompt / tool context
  │    ├─ ChatRoom 角色、状态、头像、通话、媒体与工具动作
  │    ├─ follow-up / timed wake / period care
  │    ├─ notification reply
  │    └─ turn-coordinator
  ├─ group participantIds / senderCharacterId
  ├─ memory.characterId / state values / calendar ownerId
  └─ life ownerId / scene participant / runtime.character_id
       └─ push_jobs → push-generate → push_outbox → notification delivery
```

## 兼容解析优先级

私聊解析必须调用 `resolveSessionCharacterId(session)`：

1. 如果 `session.characterId` 指向当前存在的 Character，使用它。
2. 否则把 `session.contactId` 当作 ChatContact.id 查找 `ChatContact.characterId`。
3. 为兼容旧数据，再检查 `session.contactId` 本身是否是现存 Character.id。
4. 如果仍无法唯一解析，返回 null 并停止角色级操作；禁止按显示名称猜测。
5. 群聊会话不解析单一角色，群成员必须使用 `participantIds`。

## 数据迁移

- IndexedDB hydration 先规范化并加载 contacts，再规范化 sessions，避免首次启动时联系人映射尚未就绪。
- 旧私聊会话保留 `contactId` 原值，同时补齐规范 `characterId`。
- 旧会话中直接保存 Character.id 的数据继续有效。
- 规范化时按角色主键合并重复私聊会话，并将旧消息重定向到优先会话。
- 联系人恢复只根据可验证的角色主键进行；缺失映射时不按名字猜测。
- 新建私聊会话同时保存 contactId 和 characterId，逐步停止向角色级服务传递 contactId。

## 曾存在的错配影响

当 `contact_...` 被误当成 Character.id 时，角色卡仍可能通过联系人找到，因此表面上能聊天；但以下链路会出现“聊天正常、角色相关功能异常”的分裂：

- 记忆读取/写入和自动总结使用错误的存储分区；
- 角色状态值、日历和工具动作归属到不存在的角色；
- turn coordinator 对同一角色无法正确互斥；
- follow-up、定时唤醒、经期关怀等后台任务无法找到正确角色；
- 生活现场租约、角色同地点判断、角色位置和日程无法匹配；
- 通知回复无法找到原角色或无法写入正确现场；
- 头像、贴纸、生成图片、通话、支付确认和自定义动作使用错误角色上下文。

## 测试要求

`npm run test:character-id` 覆盖真实 `chat-storage` hydration（以内存 IndexedDB 边界替代浏览器数据库）、旧新 ID 兼容、联系人映射、群聊隔离、规范 ID 持久化，以及 AI 日程 actorId/actorType/actorName 解析、同名歧义、错 ID、错类型和时间冲突。

云端诊断事件使用 trace_id 关联任务预约、生成启动、运行态校验、outbox 持久化、通知投递和 push_jobs 最终状态；每个事件同时保留 actor_id、session_id、job_id（适用时）。
