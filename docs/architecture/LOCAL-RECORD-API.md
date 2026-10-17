# 本地 Record API Contract

> 本契约只描述本机/可信内网应用边界，不授权外部部署、遥测或第三方传输。

## 1. 单一调用链

```text
Web / Local Gateway
→ HTTP Route
→ Local Record Application Service
→ Runtime Repository + Delivery Projection
→ loopback PostgreSQL
```

Route 只负责解析、输入验证和安全错误映射。候选生成、DM 校验、正式发布、
投影和幂等判断不得复制到 Route。应用进程只使用 `realm_runtime` 数据库角色，
也不在请求路径执行迁移或 Seed。

## 2. 读取 Record

```http
GET /api/record?recordId=record_first_watch
```

成功响应：

```ts
{
  ok: true;
  record: RecordProjection;     // 已按 Principal、视角、时间和 ACL 过滤
  writeToken: string;           // 不透明、短期、绑定本次可写快照
  viewer: {
    cursor: "viewer-local";
    perspective: "omniscient" | "character";
    dynamicKnowledgeVisible: boolean;
    characterInstanceId: string | null;
  };
}
```

`record.version` 和 `events[].ordinal` 都是连续的玩家投影游标。它们不得暴露或
代替数据库的 canonical Record version。

每个可见 Event 同时提供结构化语义段：

```ts
event.segments: Array<{
  id: string;
  kind: "environment" | "story" | "fact" | "action" | "dialogue";
  content: string;
  speechMode: "narrator" | "speaker" | "none";
}>;
```

一条 Event 可以包含多个类型，例如“角色望向灯塔”与随后引号中的台词分别是
`action` 和 `dialogue`，但仍保持同一条事件及原始顺序。`speechMode` 和段 ID 是
未来 STT/TTS、语义段流式提交与打断的结构边界；正文中不插入可见哨兵字符。

## 3. 提交玩家消息

```http
POST /api/record/messages
Idempotency-Key: <clientMessageId>
Content-Type: application/json
```

```ts
{
  recordId: string;
  content: string;
  clientMessageId: string;
  writeToken: string;
}
```

客户端不得提交 `workspaceId`、`principalId` 或 `expectedVersion`。服务端从受信
配置固定 Workspace/Principal，并从不透明写入令牌恢复 canonical version。
令牌绑定 Workspace、Record、Principal、角色实例和快照；过期、跨作用域或旧
快照均拒绝。相同令牌与相同幂等键可以安全重放；相同幂等键更换内容会冲突。

一次成功 Turn 按序原子提交玩家发言、已完成的 Action Transaction、Narrator 的
公开叙述、经 DM 验证的角色回应、确定性 Observation、双重 Head、Outbox 和
Command/Turn 完成状态。模型/Fake 推理与规则计算不持有数据库事务。

Action Transaction 是控制面审计事件，不进入普通玩家 Delivery Projection。
世界内结果由 Narrator 与 Character 的授权语义片段表达；GET、POST 与 SSE 不得
返回机械值、Action Transaction 原文、DM Goal、候选、检查清单或 Context Manifest。

## 4. 已提交事件 SSE

```http
GET /api/record/events?recordId=record_first_watch&afterOrdinal=<viewer cursor>
Accept: text/event-stream
```

每个事件：

```text
id: <viewer-local ordinal>
event: committed
data: {"event": <authorized ProjectionEvent>}
```

断线时使用同一 Viewer 身份的 `Last-Event-ID` 或 `afterOrdinal` 补发。SSE 只读取
已提交的 Delivery Projection，不发送 Token 片段、候选、Manifest、过滤数量、
canonical ordinal 或 `dm_only` 内容。SSE 游标不是写入令牌。

> 传输实现注记：当前服务端使用 PostgreSQL NOTIFY + committed-event ledger 唤醒：`commitRelease` 在同一事务内发出最小唤醒，生产 SSE route 建立专用 LISTEN 连接，并按 viewer cursor 重读已提交投影；旧的内存轮询 seam 仅供测试兼容。Goal projection SSE 复用同一唤醒原则，但只读取 `goal.transition.committed` ledger。

## 4A. Local Record API Bridge v1

供已验证 RealmWorld WebUI bundle 使用的版本化入口为：

```text
/api/bridge/v1/record
/api/bridge/v1/record/events
/api/bridge/v1/record/messages
/api/bridge/v1/record/goals
/api/bridge/v1/record/goals/events
```

`modules/application/local-record-api-v1.ts` 是纯 public contract：不导入 Node、数据库、
provider/settings、repository 或 service。它只公开 player-safe Record envelope、opaque
`writeToken`、viewer-local cursor、Goal 粗粒度投影和已提交事件/SSE payload；workspace、
principal、provider settings、SQL/table 类型、assessment evidence、Judge 输出与内部 job
状态不属于 Bridge v1。

五个 v1 route 是原 `/api/record*` handler 的 facade alias，不复制权限、scope、投影、
幂等或 SSE 逻辑，因此旧路径与版本化路径共享同一实现。SSE 保持
`text/event-stream; charset=utf-8`、`no-store`、`no-transform` 与 `X-Accel-Buffering: no`
语义；WebUI route 不安装、写入或执行 bundle。

typed client 对 recordId、viewer cursor、message/action/visibility 输入、same-origin 或
无 credentials 的 `http(s)` base URL、远端 error code、HTTP status、malformed response 和
EventSource construction failure 均 fail-closed，并且不把远端原始错误 message 透传给调用方。

## 5. 视角与秘密

- 上帝视角来自 World Membership 的不可变创建选项，请求不能开启。
- 上帝视角可见的非公开内容必须标为 `ooc:*`，表示当前角色未知。
- Character 视角只接收公开内容及该 CharacterInstance 的合法历史受众快照。
- `dm_only` 永不进入玩家 GET、POST 响应或 SSE。
- 动态知识关闭时，只保留导航身份；世界/故事详情、场景状态和 Cast 不以空值
  猜测或虚构。

## 6. 状态与错误

| HTTP | 语义 |
|---:|---|
| `200` | 读取成功或幂等重放成功 |
| `201` | 新 Turn 已正式提交 |
| `400` | JSON、正文、幂等键、写入令牌格式或 SSE 游标无效 |
| `404` | Record 不存在 |
| `409` | 写入令牌过期/冲突，或幂等键被不同内容复用 |
| `422` | Turn 未通过完整性/世界约束检查，未提交正式 Event |
| `503` | 本地数据库/演示运行时尚未初始化 |

错误响应只能包含稳定安全文案，不得带原始 SQL、Provider 错误、秘密 ID、被过滤
数量或 Context Manifest。
