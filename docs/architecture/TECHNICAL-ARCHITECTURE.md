# 多人叙事角色运行时：技术与架构方案

> 文档状态：工程设计与评审记录。面向贡献者，记录模块边界、并发模型和内部契约；玩家请从 [Web 一键启动](../WEB-BOOTSTRAP.md) 开始。
> 配套文档：[《多人叙事角色运行时：总体设计方案》](./SYSTEM-DESIGN.md)
> 目标读者：技术负责人、后端/前端工程师、AI Runtime 工程师、测试与运维
> 架构阶段：模块化单体起步，保留按证据拆分服务的边界

> **实施状态校准（2026-10，HEAD `dd7e6ed` 核对）**：本文是早期目标设计记录，其中 §1.3 的十条不变量、§3.3 控制面/叙事面分层、§6 模块所有权等**设计边界仍然有效**；但 §1.1 推荐基线、§3 部署形态、§4 技术栈、§5 目录结构、§14 飞书 Gateway 描述的**具体栈未按此实现**。当前实际栈：单一 Next.js(vinext）应用（`app/` + `modules/`），`pg` 驱动 + 手写参数化 SQL,`node:test` + Playwright + scratch PostgreSQL,PostgreSQL 为唯一正式状态与事务基础设施；无 pnpm monorepo(`apps/`、`adapters/`、`packages/`)、无 Fastify/Kysely、无独立 React+Vite SPA、无 TanStack/Radix、无 Redis、无 S3、无 Vitest/Testcontainers；飞书 Gateway 未实现且明确不属于当前阶段（见 `MODEL-AND-MEMORY-RUNTIME.md`）。已建成系统的如实描述以 [`SYSTEM-DESIGN.md`](./SYSTEM-DESIGN.md) 为准；当前演进方向以 `../development/REALMWORLD-ENGINE-UPGRADE-PLAN.md` 为准。
> 术语校准：本文中的 “Goal” 均指 **DM 单回合目标（turn intent)**，属控制面，不是持久 Goal；持久 Goal 的目标设计见上述升级计划。

---

## 目录

1. 技术结论
2. 目标、约束与非目标
3. 系统上下文与部署形态
4. 技术栈
5. Monorepo 目录结构
6. 分层、模块边界与依赖规则
7. 数据架构
8. 接口与契约
9. Record Runtime 与并发模型
10. DM、角色、旁白与工具执行
11. 上下文、检索与缓存
12. 时间线、记忆、Canon 与社会传播
13. Web 前端架构
14. 飞书 Gateway 架构
15. 后台任务与调度
16. 安全与隐私
17. 可观测性、审计与成本
18. 测试与质量门禁
19. 本地开发、CI/CD 与发布
20. 部署、扩容与服务拆分
21. 分阶段实施顺序
22. 架构决策记录与待确认项
23. 附录

---

## 1. 技术结论

### 1.1 推荐基线

> 【目标/未实现】本表是设计期的推荐栈，**未按此落地**。实际栈见文首“实施状态校准”：单包仓库、Next.js(vinext）路由、`pg` + 手写 SQL、`node:test`；下表中 pnpm workspace、Fastify、Kysely、React+Vite SPA、S3、Redis、Vitest/Testcontainers 均未采用。

| 领域 | 推荐选择 | 核心理由 |
|---|---|---|
| 仓库 | TypeScript Monorepo | 前后端、ToolSpec、事件和 Gateway 契约可共享，但业务实现不共享 |
| 包管理 | pnpm workspace | Workspace 原生、依赖隔离明确、磁盘占用低 |
| 后端运行时 | Node.js LTS + ESM | 模型 SDK、流式、飞书及 Web 生态完整 |
| HTTP 服务 | Fastify | 轻量、插件边界清晰、原生采用 JSON Schema 验证与序列化 |
| 数据契约 | JSON Schema 受限子集 + TypeScript 静态类型 | 同时服务 HTTP、Event、Tool Calling、模型适配和测试 |
| 数据库访问 | Kysely + `pg` + 必要的参数化 SQL | 保留类型安全，又不遮蔽锁、CTE、范围类型、pgvector 和复杂查询 |
| 权威数据库 | PostgreSQL + pgvector | 同一事务内维护 Event、状态、秘密边界、工具结果和 Outbox |
| 前端 | React + Vite + TanStack Query/Router | 自建 SPA，无 SSR 必要，流式和复杂工作台状态更直接 |
| UI | 自有 Design Tokens + Radix Primitives + 轻量样式层 | 保证无障碍与交互质量，同时维持简洁卡片语言 |
| 实时通道 | HTTP Command + SSE；必要时升级 WebSocket | 第一版足够可靠，断线续传和代理兼容性更容易控制 |
| 异步任务 | PostgreSQL Job Queue + Transactional Outbox | 第一版无需 Kafka/RabbitMQ，也不牺牲提交与投递一致性 |
| 对象存储 | S3 兼容接口 | 图片、语音、卡面和附件与核心事务解耦 |
| 可选缓存 | Redis | 仅广播、在线状态、限流和可丢失热点缓存，不参与正确性 |
| 可观测性 | OpenTelemetry + 结构化日志 + 指标后端 | 统一贯穿 API、Worker、模型调用、工具和投递链 |
| 测试 | Vitest + Playwright + Testcontainers | 单元、端到端和真实 PostgreSQL 语义均可覆盖 |

版本不在本方案中写死。落地时选取处于维护期的稳定版本，以 lockfile 固定；每个季度集中升级，不允许业务包各自漂移主版本。

### 1.2 一句话架构

> 一个拥有严格内部边界的模块化单体，以 PostgreSQL 为唯一事务权威；模型可以并行生成候选，正式世界状态按 Record 串行提交；所有角色只读取经过时间、世界线、可见性和认知过滤后的上下文。

### 1.3 不可破坏的技术不变量

1. 同一 Record 的正式 `ordinal` 只能由一个逻辑写入者推进。
2. LLM 调用不得跨越数据库事务，也不得直接写入正式状态。
3. `Event`、工具状态变化、可见性和 Outbox 必须在同一事务内提交。
4. 不能先生成全知上下文或摘要再删除秘密；各可见域必须独立读取、编译和生成。
5. 向量召回不能越过 Workspace、Worldline、时间和 ACL 硬过滤。
6. DM Controller、Narrator、Character Runner 是不同职责，不能共用一份输出契约。
7. 真人与 AI 都通过 CharacterInstance 进入世界；Principal 永远不直接成为世界内说话者。
8. 随机、规则和工具状态变化必须可重放、可审计、幂等。
9. Redis、Embedding、摘要和模型供应商缓存都不是事实来源。
10. 未经用户合并的高层 Canon Proposal 不能静默改写 Story 或 Worldline。

---

## 2. 目标、约束与非目标

### 2.1 技术目标

- 支持一对一、一对多、多对一、多对多的真人与 AI 角色组合；
- 支持长时间线、回溯 Record、世界线分支和时间安全的角色知识；
- 支持公共 Scene、秘密组、角色私有信息和 DM 控制面；
- 支持语义句/短段级流式、插话、取消和工具执行；
- 支持通用 TRPG 规则包，不把 Core 绑定到 D&D；
- 支持 Web 完整体验，以及飞书等消息平台的能力降级接入；
- 允许模型供应商替换，并尽可能保持稳定前缀和缓存命中；
- 在不提前微服务化的前提下支持多进程、多副本和故障恢复。

### 2.2 首版非目标

- 完整实现任一特定 TRPG 规则书；
- 使用模型模拟世界中每一个普通居民；
- 将所有状态都做成纯 Event Sourcing；
- 引入 Kubernetes、Kafka、独立向量数据库或图数据库作为首版前置条件；
- 向用户暴露底层 Prompt、采样器、索引权重和传播模型的全部参数；
- 让外部角色卡、世界书或工具定义获得可执行权限。

### 2.3 初始工程指标

以下指标只衡量本系统开销，不把第三方模型生成时间混入：

| 指标 | 首版目标 |
|---|---|
| 已接收命令持久化 | p95 小于 300 ms |
| Event/Action 正式提交 | p95 小于 300 ms |
| SSE 已提交事件断线续传 | 不丢失、不重复展示 |
| 同一外部消息重复投递 | 只产生一次业务效果 |
| 同一 Tool Call 重试 | 只产生一次状态变化 |
| 秘密越权读取 | 自动化测试中为 0 |
| Record 崩溃恢复 | 从最近稳定状态自动继续或明确终止 |
| 核心链路审计覆盖 | Command → Model → Tool → Commit → Delivery 全链可追踪 |

---

## 3. 系统上下文与部署形态

### 3.1 逻辑视图

```mermaid
flowchart LR
    WEB["Web SPA"] --> API["API / Gateway"]
    FEISHU["飞书"] --> API
    API --> PG["PostgreSQL + pgvector"]
    API --> OBJ["S3 兼容对象存储"]
    API --> STREAM["SSE Stream"]
    RUNTIME["Runtime Worker"] --> PG
    RUNTIME --> MODEL["模型供应商 / 本地模型"]
    BACKGROUND["Background Worker"] --> PG
    BACKGROUND --> MODEL
    SCHEDULER["Scheduler"] --> PG
    API -. "可选广播" .-> REDIS["Redis"]
    RUNTIME -. "可选广播" .-> REDIS
```

### 3.2 四类进程

> 【目标/未实现】当前实际部署是**单个 Next.js 进程**（同一进程内完成 API 与 turn 编排），另有可选的独立 worker 先例（propagation worker、scene-image worker,`modules/application/propagation-worker-runtime.ts`)；不存在 `api` / `runtime-worker` / `background-worker` / `scheduler` 四进程拆分。下表保留为按证据拆分服务时的设计参考。

| 进程 | 主要职责 | 水平扩展键 |
|---|---|---|
| `api` | 鉴权、HTTP、SSE、飞书 Webhook、Command 接收、Query Projection | 无状态请求 |
| `runtime-worker` | Turn 状态机、Context 编译、DM/角色调用、验证、工具与正式提交 | `record_id` |
| `background-worker` | Embedding、摘要、Canon 草稿、社会传播、索引和媒体任务 | `job_id` |
| `scheduler` | 系统时间任务、世界时间到期任务、超时与恢复扫描 | 时间分片 |

四类进程来自同一个代码仓库和发布版本，但入口、连接池、资源限额和扩容策略不同。开发环境可以由一个命令同时启动；生产环境建议使用同一个镜像的不同启动命令。

### 3.3 两个平面

```text
控制面
DM Goal、Validator、权限、Canon 审核、配置、Context Manifest、运维

叙事面
角色输入、Narrator、可见事件、工具结果、记忆、世界状态、消息投递
```

控制面数据不得进入普通角色 Prompt。Narrator 虽拥有较宽的世界理解投影，也只能输出当前受众可公开感知的结果。

### 3.4 模块化单体不等于单进程

本方案中的“单体”只表达三件事：

1. 一个逻辑应用与统一版本；
2. 一套可在本地完成的领域调用；
3. 一个可以原子提交核心状态的 PostgreSQL。

它不意味着只能运行一台机器，也不意味着模块可以任意互调。API 和 Worker 可以分别增加副本；不同 Record 并行，同一 Record 仅在最终提交阶段串行。

---

## 4. 技术栈

### 4.1 TypeScript 与 Node.js

后端、前端、Gateway 和协议定义统一使用 TypeScript，但只共享契约，不共享业务状态对象。这样可以减少以下边界错误：

- ToolSpec 与供应商 Function Calling 形状不一致；
- Web Command 与服务端 Command 漂移；
- Feishu Adapter 私自理解领域语义；
- Event 生产者和消费者版本不一致。

领域层只能依赖 TypeScript 标准能力和 `shared-kernel`，不得依赖 Fastify、React、供应商 SDK 或数据库客户端。

### 4.2 Fastify 与 JSON Schema

Fastify 只承担传输层职责：路由、鉴权钩子、请求/响应验证、序列化、限流和流式连接。它不拥有业务事务。

选择 JSON Schema 作为外部契约的基准，原因是它可同时用于：

- HTTP 输入输出；
- Command、Domain Event 和 Job Payload；
- ToolSpec；
- 模型结构化输出；
- 契约测试与 Fixture 验证。

内部使用受控的 Schema Builder 生成 JSON Schema 和静态类型。禁止在运行时把用户导入的 Schema 交给编译型验证器；导入数据必须先经过系统预定义的静态 Schema，因为 Fastify/Ajv 的编译模型要求 Schema 本身被视为应用代码。

### 4.3 Kysely 而非重型 ORM

本项目会大量使用：

- `FOR UPDATE SKIP LOCKED`；
- Advisory Lock；
- 递归 CTE；
- `int8range`/有效时间区间；
- GIN 全文索引；
- pgvector 距离查询；
- 部分索引、表达式索引和物化视图；
- 显式事务与版本检查。

因此使用 Kysely 提供类型安全的薄查询层，复杂查询保留参数化 SQL。禁止 Repository 为了“ORM 纯洁性”把一次正确 SQL 拆成大量往返。

### 4.4 React SPA

Web 是一个登录后的交互式应用，不依赖公开网页 SEO，首版不需要 SSR。采用 React + Vite：

- TanStack Query 管理服务器状态、失效和乐观 UI；
- TanStack Router 管理类型化路由和工作区嵌套；
- SSE 接收已提交事件、语义流片段和任务状态；
- 本地状态只保存 UI 临时态，不复制权威世界状态；
- Design Tokens、Radix Primitives 和自有组件形成统一卡片语言。

### 4.5 PostgreSQL 与 pgvector

PostgreSQL 是唯一权威事实源。pgvector 只增加语义候选召回，不改变权限和时间判断：

- 小候选集优先精确距离查询；
- 大候选集可启用 HNSW；
- ANN 查询必须带 Workspace、Worldline、时间和可见域过滤；
- 过滤造成召回不足时采用迭代扫描、过取样或退化为受限精确查询；
- 不允许先跨权限向量召回正文，再在应用层删除越权结果。

### 4.6 Redis 的边界

Redis 是可选加速器，只允许用于：

- 跨 API 副本的 SSE/WebSocket 广播提示；
- 在线状态和 typing 指示；
- 限流计数；
- 可丢失热点投影。

Record 锁、Job、Outbox、幂等和正式事件全部以 PostgreSQL 为准。Redis 故障只能造成体验降级，不能改变世界状态。

---

## 5. Monorepo 目录结构

> 【目标/未实现】当前仓库是**单包结构**(`app/` + `modules/` + `database/` + `scripts/` + `tests/`)，无 pnpm workspace、`apps/`、`adapters/`、`packages/`。本节目录树与归属规则保留为未来按证据拆分时的设计参考，不描述现状。

### 5.1 顶层目录

```text
character-runtime/
├── apps/                         # 可部署或可运行的组合入口
│   ├── api/
│   ├── runtime-worker/
│   ├── background-worker/
│   ├── scheduler/
│   ├── web/
│   └── cli/
│
├── modules/                      # 业务边界；未来可整体拆服务
│   ├── identity-access/
│   ├── world-canon/
│   ├── story-record/
│   ├── character/
│   ├── cognition/
│   ├── context/
│   ├── rules-assets/
│   ├── dm-runtime/
│   ├── model-gateway/
│   ├── delivery-gateway/
│   └── operations/
│
├── adapters/                     # 外部世界适配；不含领域决策
│   ├── model-openai/
│   ├── model-anthropic/
│   ├── model-gemini/
│   ├── model-openai-compatible/
│   ├── gateway-feishu/
│   ├── import-sillytavern/
│   ├── storage-s3/
│   ├── embeddings/
│   └── mcp/
│
├── packages/                     # 无业务归属的最小技术基础
│   ├── shared-kernel/
│   ├── schema/
│   ├── database/
│   ├── config/
│   ├── observability/
│   ├── crypto/
│   ├── ui/
│   └── testkit/
│
├── database/
│   ├── migrations/               # 按 PostgreSQL Schema 分属各模块
│   │   ├── iam/
│   │   ├── world/
│   │   ├── narrative/
│   │   ├── character/
│   │   ├── cognition/
│   │   ├── context/
│   │   ├── rules/
│   │   ├── delivery/
│   │   └── ops/
│   ├── seeds/                    # 仅开发/演示数据
│   └── fixtures/                 # 测试世界与时间线
│
├── docs/
│   ├── architecture/
│   ├── adr/                      # Architecture Decision Records
│   ├── contracts/
│   ├── runbooks/
│   └── threat-models/
│
├── deploy/
│   ├── docker/
│   ├── compose/
│   └── environments/
│
├── scripts/                      # 只放仓库维护脚本，不放业务逻辑
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── package.json
└── README.md
```

### 5.2 四个顶层类别的判断规则

| 问题 | 放置位置 |
|---|---|
| 它是否可以独立启动、部署或由用户运行？ | `apps/` |
| 它是否拥有业务术语、状态和规则？ | `modules/` |
| 它是否连接某个供应商、协议或基础设施？ | `adapters/` |
| 它是否完全不知道 World、Record、Character 等业务概念？ | `packages/` |

禁止创建顶层 `services/`、`helpers/`、`common-business/`。无法判断归属的代码必须先明确责任，而不是扔进公共目录。

### 5.3 单个业务模块模板

```text
modules/story-record/
├── src/
│   ├── domain/
│   │   ├── entities/
│   │   ├── value-objects/
│   │   ├── policies/
│   │   ├── services/
│   │   └── events/
│   ├── application/
│   │   ├── commands/
│   │   ├── queries/
│   │   ├── handlers/
│   │   ├── projections/
│   │   └── ports/
│   ├── infrastructure/
│   │   ├── postgres/
│   │   ├── jobs/
│   │   └── mappers/
│   ├── interface/
│   │   ├── http/
│   │   └── event-handlers/
│   ├── contract/                 # 允许其他模块导入的命令、查询和事件
│   ├── compose.ts                # 模块装配，不启动进程
│   └── public.ts                 # 唯一公开入口
├── test/
│   ├── unit/
│   ├── integration/
│   └── contract/
├── package.json
└── tsconfig.json
```

小模块不要求为了形式创建空目录；但依赖方向不能改变：

```text
interface → application → domain
infrastructure → application ports
compose → interface + infrastructure
domain → shared-kernel only
```

### 5.4 App 作为 Composition Root

`apps/*` 只负责组装模块和适配器：

```text
apps/runtime-worker/src/
├── bootstrap.ts
├── config.ts
├── composition.ts
├── health.ts
└── main.ts
```

这里可以决定“DM Runtime 使用哪个 Model Adapter”“Repository 使用哪个 PostgreSQL Pool”，但不得放 `ResolveTurnService` 之类业务实现。

### 5.5 Web 前端目录

```text
apps/web/src/
├── app/                           # Provider、Router、全局错误边界
├── routes/                        # 页面装配，不堆业务实现
├── features/
│   ├── world-create/
│   ├── record-play/
│   ├── conspiracy-scene/
│   ├── character-control/
│   ├── canon-review/
│   └── knowledge-explorer/
├── entities/                      # 前端 Projection 模型
│   ├── world/
│   ├── record/
│   ├── character/
│   └── event/
├── widgets/                       # 多 Feature 组成的大卡片/区域
├── shared/
│   ├── api/
│   ├── stream/
│   ├── auth/
│   ├── lib/
│   └── styles/
└── main.tsx
```

前端 `entities` 是面向当前 Principal 的 Projection，不得复制后端领域实体，也不能出现未经投影的 DM 字段。

---

## 6. 分层、模块边界与依赖规则

### 6.1 依赖层级

```mermaid
flowchart TD
    L5["L5 Delivery / API / Web"] --> L4["L4 DM Runtime Orchestration"]
    L4 --> L3["L3 Context Compiler"]
    L3 --> L2["L2 Story Record / Cognition"]
    L2 --> L1["L1 Identity / World / Character / Rules / Model Ports"]
    L1 --> L0["L0 Shared Kernel / Schema"]
    OPS["Operations"] -. "观察事件，不反向控制领域" .-> L2
```

高层可以调用低层的公开契约，低层不得导入高层实现。跨层反向通知使用 Domain Event 或由上层传入 Port。

### 6.2 模块所有权

| 模块 | 拥有 | 公开能力 | 不拥有 |
|---|---|---|---|
| `identity-access` | Principal、Membership、ControlGrant、ACL | 鉴权、授权、Perspective 查询 | 角色认知 |
| `world-canon` | World、Worldline、CanonRevision、Entity、Claim、Article | 世界快照、Canon Proposal/Commit | Record 对话 |
| `story-record` | Story、Record、Scene、Participant、Turn、Event、RecordHead | Command、事件追加、Record Projection | 模型调用 |
| `character` | Definition、Continuity、Instance、状态 | 激活实例、状态快照、继承入口 | 主观知识 |
| `cognition` | Observation、Knowledge、Memory、Relationship、Diffusion | Character Lens、记忆巩固、情报传播 | 客观 Canon |
| `context` | Document、Snapshot、Digest、Manifest、索引元数据 | ContextRequest → CompiledContext | 决定剧情 |
| `rules-assets` | RulePack、ToolSpec、Inventory、Effect、ToolResult | 计划、确认、确定性执行 | 自由文本旁白 |
| `dm-runtime` | Goal、TurnContract、Run State、Validator 结果 | 编排完整 Turn | 直接拥有业务表状态 |
| `model-gateway` | ProviderProfile、ModelRoute、Invocation、Usage | 统一模型调用与结构化流 | 业务权限决策 |
| `delivery-gateway` | 平台绑定、Inbound/Outbound、Receipt | 标准化消息与投递 | 世界和角色语义 |
| `operations` | Job、Outbox、审计、Dead Letter、指标元数据 | 任务租约、审计查询 | 修改未经领域验证的事实 |

> 术语校准：上表 `dm-runtime` 拥有的 “Goal” 指 **DM 单回合意图（turn intent)**——当前实现为 `M2TurnPlan.turnIntent`(`modules/orchestration/public.ts:36`)，属控制面且永不对玩家可见（`LOCAL-RECORD-API.md` §3)。它不是持久 Goal；持久 Goal(RealmWorld 定义、有状态/进度/Outcome、玩家可见粗粒度投影）目前不存在，其目标设计与分层命名见 `../development/REALMWORLD-ENGINE-UPGRADE-PLAN.md`。

### 6.3 跨模块调用规则

允许：

- 导入目标模块的 `public.ts` 或 `contract/*`；
- 通过类型化 Command/Query 同步调用；
- 通过版本化 Domain Event 异步反应；
- 在 Application Service 中编排同库短事务；
- 在数据库中保留跨 Schema 外键。

禁止：

- 导入其他模块的 `domain/entities` 或 Repository；
- 直接更新其他模块拥有的表；
- 通过一个全局 `ServiceLocator` 绕过依赖声明；
- 在 Domain Event Handler 中形成同步循环；
- 把数据库 Row 当作跨模块公共类型。

### 6.4 自动化边界检查

仓库必须设置以下门禁：

1. `package.json.exports` 只暴露 `public.ts` 和明确的 Contract；
2. TypeScript path 不提供其他模块的 internal alias；
3. 依赖图规则阻止 Domain 导入 Fastify、Kysely、React 或供应商 SDK；
4. CI 检查循环依赖和禁止路径；
5. 数据库写入集成测试统计每个模块实际触碰的 Schema；
6. ADR 审核新增顶层 Package 或跨模块同步依赖。

### 6.5 共享内核的上限

`packages/shared-kernel` 只允许包含：

```text
WorkspaceId / WorldId / RecordId 等品牌化 ID
SystemTime / WorldTick / EffectiveRange
Result / DomainError
EventHeader / TraceContext
CanonicalJson / ContentHash
Clock / IdGenerator / DeterministicRandom Port
```

不得包含 World、Character、Memory、Tool 等实体，也不得出现业务 Service。

---

## 7. 数据架构

### 7.1 PostgreSQL Schema

| Schema | 核心表 |
|---|---|
| `iam` | `principals`, `external_identities`, `workspace_memberships`, `player_world_memberships`, `control_grants`, `turn_control_leases`, `acl_entries` |
| `world` | `worlds`, `worldlines`, `canon_revisions`, `entities`, `claims`, `relations`, `causal_edges`, `lore_articles`, `canon_proposals` |
| `narrative` | `stories`, `records`, `scenes`, `participants`, `record_heads`, `command_inbox`, `turn_runs`, `action_candidates`, `event_store`, `event_visibility` |
| `character` | `definitions`, `continuities`, `instances`, `state_snapshots`, `instance_assets` |
| `cognition` | `observations`, `knowledge_claims`, `memories`, `relationship_states`, `information_campaigns`, `packet_versions`, `social_nodes`, `channel_routes`, `transmissions`, `exposures` |
| `context` | `documents`, `chunks`, `embeddings`, `digests`, `snapshots`, `manifests`, `cache_epochs`, `compiled_artifacts` |
| `rules` | `rule_packs`, `tool_specs`, `assets`, `inventories`, `inventory_entries`, `effects`, `action_transactions`, `tool_results`, `random_draws` |
| `delivery` | `gateway_bindings`, `inbound_messages`, `outbound_messages`, `delivery_receipts` |
| `ops` | `jobs`, `outbox`, `dead_letters`, `audit_events`, `model_usage`, `runtime_failures` |

### 7.2 通用字段

所有租户业务表至少包含：

```text
workspace_id       UUID，所有高频索引和唯一约束的首要过滤维度
id                 UUIDv7，由应用生成
created_at         timestamptz，系统时间
updated_at         timestamptz，适用于可变行
version            bigint，适用于乐观并发
```

涉及世界状态的行额外包含：

```text
world_id
worldline_id
effective_from_tick
effective_to_tick  可空，或使用 int8range
recorded_at        系统写入时间
source_event_id / source_claim_id
```

世界时间和系统时间必须使用不同类型封装，禁止在 TypeScript 中都表示成裸 `number`。

### 7.3 Event Store 的边界

本系统使用“Record 事件日志 + 规范化状态表”，不是把所有数据都做成纯 Event Sourcing：

- `event_store` 保存已提交叙事、观察、工具结果引用和状态变化依据；
- Inventory、Effect、Character State、ACL 等仍有当前权威表；
- 每次状态写入都保留 `source_event_id` 或 `tool_result_id`；
- Projection 可以从事件和快照重建，但核心事务不依赖最终一致的 Projection 才算成功；
- 未释放的模型草稿不进入正式 Event Store。

### 7.4 Event Envelope

```json
{
  "event_id": "uuidv7",
  "event_type": "utterance.segment.committed.v1",
  "workspace_id": "uuid",
  "world_id": "uuid",
  "worldline_id": "uuid",
  "story_id": "uuid",
  "record_id": "uuid",
  "scene_id": "uuid",
  "ordinal": 128,
  "effective_tick": 913044,
  "recorded_at": "2026-08-13T10:00:00Z",
  "sender_participant_id": "uuid",
  "visibility_policy_id": "uuid",
  "causation_id": "uuid",
  "correlation_id": "uuid",
  "schema_version": 1,
  "payload": {}
}
```

`origin_principal_id`、模型 Run、Context Manifest 等审计字段放在受保护的关联表或受保护列中，不出现在普通角色可读的 Event Projection。

### 7.5 Record Head 与单写入

```text
narrative.record_heads
record_id            PK
workspace_id
version              bigint
next_ordinal         bigint
active_turn_run_id
lease_owner          nullable
lease_expires_at     nullable
updated_at
```

正确性采用“双保险”：

1. Runtime Worker 使用事务级 Advisory Lock 或 Record Head 行锁取得提交权；
2. 更新时检查 `version`，并依赖 `(record_id, ordinal)` 唯一约束。

锁防止正常并发，版本与唯一约束防止超时、进程暂停或重复执行导致的双写。

### 7.6 Command Inbox 与幂等

所有外部输入先标准化为 Command：

```text
command_id
workspace_id
record_id
command_type
idempotency_key
source                  web / feishu / internal / scheduler
source_message_id
actor_principal_id
payload
status                  accepted / running / completed / rejected / failed
result_ref
created_at
```

唯一约束：

```text
(workspace_id, source, idempotency_key)
(workspace_id, source, source_message_id) where source_message_id is not null
```

API 对重复请求返回原 `command_id` 和当前结果，不重新触发模型。

### 7.7 Outbox 与正式提交

Event、状态变化和 `ops.outbox` 在同一数据库事务内写入。Outbox 记录只表示“已经承诺需要投递”，不表示外部平台已经收到。

```text
outbox_id
topic
aggregate_type / aggregate_id
payload
available_at
attempt_count
lease_owner / lease_expires_at
status
created_at / delivered_at
```

Delivery Worker 读取 Outbox，写入 `delivery.outbound_messages`，发送后记录 Receipt。外部接口超时但结果未知时，使用平台幂等键查询或安全重试。

### 7.8 Workspace 隔离与 RLS

建议第一版即启用 Workspace 级 Row-Level Security 作为纵深防御：

- API 请求在短事务内设置当前 `workspace_id` 与 `principal_id`；
- Worker 使用受限服务角色，并且 Job Payload 必须显式携带 Workspace；
- Migration 角色与运行角色分离；
- 对象级秘密仍由 ACL/Visibility Query 处理，不能只依赖 RLS；
- 连接归还池前不得残留 Session 级租户变量，优先使用 `SET LOCAL`。

### 7.9 索引原则

优先建立：

- 所有外键索引；
- `(workspace_id, record_id, ordinal)`；
- `(workspace_id, worldline_id, effective_from_tick)`；
- Command/Tool/Delivery 幂等唯一索引；
- Job 的 `(status, available_at)` 部分索引；
- Claim、Observation、Knowledge 的来源和有效时间索引；
- Context 文本的 GIN FTS 索引；
- 经基准测试后再为大集合建立 HNSW。

禁止“先给每个向量列建 HNSW 再说”。pgvector 默认精确搜索即可工作，ANN 是规模优化，不是功能前提。

### 7.10 Migration 规则

- Migration 只前进，生产环境不依赖自动 Down；
- 大表修改采用 expand → backfill → switch → contract；
- Schema、应用兼容至少跨一个发布窗口；
- 长耗时索引使用并发创建并单独监控；
- 每次 Migration 声明所属模块、锁风险、回滚策略和数据修复方案；
- 部署时由独立 Migration Job 执行，业务进程不自行迁移。

---
## 8. 接口与契约

### 8.1 契约分层

```text
Transport Contract   HTTP/SSE/Feishu 的输入输出形状
Application Contract 模块公开 Command、Query、Result
Domain Event          已发生且不可撤销的领域事实
Job Contract          可重试后台任务
Model Contract        DM/角色/旁白的结构化输出
Tool Contract         ToolSpec、ActionIntent、ToolResult
```

这些契约不能混用。例如 HTTP 的 `CreateRecordRequest` 可以映射成 `CreateRecordCommand`，但 Domain 层不得接收 Fastify Request；模型输出是候选，不得冒充 Domain Event。

### 8.2 JSON Schema Profile

为了兼容主流模型 Function Calling，内部 Tool/Model Schema 限制为稳定子集：

```text
允许：object、array、string、number、integer、boolean、null
允许：properties、required、enum、const、items、min/max、description
有限允许：oneOf/anyOf，仅用于简单互斥结构
禁止：递归引用、动态引用、可执行格式、复杂 patternProperties
默认：additionalProperties = false
```

Model Adapter 将内部 Schema Profile 转换成供应商协议。若供应商能力不足，Adapter 必须显式降级并在 Invocation Manifest 中记录，不能静默删除必填约束。

### 8.3 Command Envelope

```json
{
  "command_id": "uuidv7",
  "command_type": "record.player_input.v1",
  "workspace_id": "uuid",
  "record_id": "uuid",
  "actor_principal_id": "uuid",
  "idempotency_key": "client-generated-key",
  "expected_record_version": 27,
  "payload": {
    "participant_id": "uuid",
    "content": "我尝试说服守卫。",
    "client_timestamp": "2026-08-13T10:00:00Z"
  }
}
```

`expected_record_version` 用于尽早发现用户基于过期界面提交的高风险操作；普通发言可由服务端在最新状态上重新评估，高价值或不可逆操作必须要求确认。

### 8.4 Domain Event 版本

Event Type 使用后缀版本：

```text
record.created.v1
turn.started.v1
utterance.segment.committed.v1
action.transaction.committed.v1
knowledge.claim.acquired.v1
canon.proposal.created.v1
worldline.branched.v1
```

规则：

- 新增可选字段不必升级主版本；
- 删除、改名或改变语义必须创建新版本；
- Event Consumer 必须声明可接受版本；
- 历史 Event 不做原地重写，通过 Upcaster 在读取时升级；
- 外部 Gateway 只消费稳定的 Projection Contract，不直接消费内部 Event Payload。

### 8.5 HTTP API

首版保持资源查询与 Command 写入分离：

```text
POST   /v1/worlds
GET    /v1/worlds/:worldId
POST   /v1/worlds/:worldId/commands

GET    /v1/records/:recordId
POST   /v1/records/:recordId/commands
GET    /v1/records/:recordId/events?afterOrdinal=...
GET    /v1/records/:recordId/stream?afterOrdinal=...

GET    /v1/characters/:characterId
POST   /v1/characters/:characterId/commands

GET    /v1/canon/proposals/:proposalId
POST   /v1/canon/proposals/:proposalId/commands

POST   /v1/gateways/feishu/webhook
GET    /v1/jobs/:jobId
```

写操作不设计大量领域动词 URL，而统一进入 Command Endpoint；API 返回 `202 Accepted + command_id`，需要立即完成的轻量命令可以返回最终 Projection。

### 8.6 SSE 事件

SSE 只发送 PrincipalProjection：

```text
event: command.status
event: turn.status
event: utterance.segment.preview
event: utterance.segment.committed
event: action.result
event: record.projection.updated
event: notification
```

每条包含单调 `stream_id` 和关联 `record_ordinal`。重连时客户端发送最后已确认 ID；服务端从 Event/Outbox Projection 补发。Preview 可以丢失，Committed 不可丢失。

Preview 也必须先通过语义片段级 Validator 和受众 Projection；它只是尚未获得 Record 正式序号，不代表可以提前展示未经权限检查的模型 Token。若最终 Commit 因版本冲突失败，客户端按 `turn_run_id + segment_index` 撤销该 Preview。

### 8.7 错误模型

```json
{
  "error": {
    "code": "RECORD_VERSION_CONFLICT",
    "message": "记录状态已变化，请重新确认操作。",
    "retryable": false,
    "correlation_id": "uuid",
    "details": {}
  }
}
```

错误分为：Validation、Authorization、Conflict、RateLimit、Dependency、Runtime、Invariant。外部响应不包含 SQL、Prompt、Manifest、供应商原文或秘密字段。

### 8.8 SillyTavern 资产导入边界

`adapters/import-sillytavern` 只兼容两类资产：

```text
Character Card → CharacterDefinition Draft
World Info / Lorebook → Lore Source Documents / Entity-Claim Drafts
```

不兼容并且不执行外部聊天平台的运行时、Extension、STscript、Quick Reply、Regex 脚本、Prompt Preset 或宏。导入流程保存原文件 Hash、来源版本、规范化结果和字段映射报告；无法识别的字段可封存为原始元数据，但不会进入 Prompt 或获得执行权限。所有导入结果必须经预览确认后才进入正式资产库。

---

## 9. Record Runtime 与并发模型

### 9.1 Turn Run 状态机

```mermaid
stateDiagram-v2
    [*] --> Accepted
    Accepted --> Planning
    Planning --> ContextCompiled
    ContextCompiled --> Drafting
    Drafting --> Validating
    Validating --> ToolPending: 需要工具
    ToolPending --> Applying
    Applying --> Revalidating
    Revalidating --> Releasing
    Validating --> Releasing: 无工具且通过
    Releasing --> Completed
    Drafting --> Interrupted
    Validating --> Repairing: 可修复
    Repairing --> Validating
    Planning --> Failed
    Validating --> Failed: 超过修复上限
    Interrupted --> Completed
```

`turn_runs` 保存当前状态、尝试次数、候选引用和 Checkpoint，使 Worker 崩溃后能够判断：继续、重跑无副作用步骤，或以明确失败事件终止。

### 9.2 完整消息流

```text
1. API 验证并持久化 Command Inbox
2. 创建或唤醒 Turn Run
3. Runtime Worker 读取最新 Record Head
4. DM Controller 生成 Turn Contract 与待激活角色集合
5. Context Compiler 为每个调用独立生成合法上下文
6. 角色模型可并行生成候选
7. 候选按完整语义句/短段进入 Validator
8. 工具意图进入 Action Transaction；普通语言进入 Utterance Commit
9. 单写入者取得 Record 提交权，在最新版本上重新验证
10. Event、状态、可见性和 Outbox 原子提交
11. SSE/飞书投递已提交结果
12. Background Jobs 生成摘要、记忆、Embedding、传播或 Canon Proposal
```

### 9.3 推理并行、提交串行

允许并行的部分：

- DM 对多个候选角色进行激活评估；
- 不共享工具状态的多个角色生成草稿；
- Narrator 草稿与不冲突的角色草稿准备；
- 检索不同上下文域。

必须串行的部分：

- 同一 Record 的 `ordinal` 分配；
- 工具影响同一状态或资产；
- 正式 Utterance 的释放顺序；
- Scene/Participant/Visibility 变化；
- Action 后的 Narrator 结果和后续角色反应。

并行结果只是 `action_candidates`。提交前按最新 Record Version 重新检查；失效候选被丢弃或重生成，不能强行套用旧上下文。

### 9.4 Lease、Lock 与 Version

```text
Job Lease            防止普通重复消费，可超时接管
Advisory/Row Lock    保证提交临界区单写入
Record Version       检测过期上下文和锁租约异常
Unique Constraint    最后一道重复效果防线
Idempotency Key      对外部重试返回原结果
```

不得只依赖任意一层。模型生成期间不持有 Lock；仅在创建 Run Checkpoint 和最终 Commit 时开启短事务。

### 9.5 Utterance Commit 与 Action Transaction

Utterance 是可分段释放的语言事件：

```text
Draft Segment → Validate → Commit Segment → Project/Stream
```

Action 是原子状态事务：

```text
Intent → Plan → Confirm if needed → Execute → Commit ToolResult + State + Event
```

禁止把“角色说到一半就扣除了道具”做成不可恢复的混合状态。发言可以已经提交，而后续 Action 失败；此时追加明确的失败结果，不回写或删除历史 Utterance。

### 9.6 取消与插话

流式单位是完整语义句或短段：

- 未完成 Token 仅存在于内存/短期诊断区；
- Validator 通过后才形成可释放 Segment；
- DM 在 Segment 边界判断是否允许另一角色插话；
- 插话触发后取消原模型流，已提交 Segment 保留；
- 未提交草稿不进入 Event Store、Memory、摘要或未来上下文；
- 每轮设置最大自动发言角色数和强沉默偏置。

### 9.7 崩溃恢复

| 崩溃点 | 恢复策略 |
|---|---|
| Command 已入库、Run 未创建 | Scheduler/Worker 扫描并创建 |
| 模型调用中断 | 根据策略重试；没有正式副作用 |
| Tool 执行前中断 | 原 `tool_call_id` 重试 |
| 数据库 Commit 结果未知 | 查询幂等键/唯一约束，不盲目重做 |
| Commit 成功、外部投递失败 | Outbox 重试 |
| 飞书发送超时 | 使用平台消息幂等标识查询或重试 |

---

## 10. DM、角色、旁白与工具执行

### 10.1 四类运行职责

| 组件 | 输入投影 | 输出 | 是否可提交事实 |
|---|---|---|---|
| DM Controller | 控制面 + 合法世界状态 | Turn Contract、激活、检查、修复决策 | 只能通过 Runtime 编排 |
| Character Runner | Character Lens | 角色语言、行动意图、沉默 | 否，只生成候选 |
| Narrator | 当前 Scene 的受众可公开结果 | 环境、动作结果和转场叙述 | 否，只生成候选 |
| Rules Engine | 结构化状态与 Tool Intent | 确定性 ToolResult/State Delta | 由 Action Transaction 提交 |

### 10.2 DM Controller 不输出旁白

DM Controller 的结构化输出示例：

```json
{
  "goal_status": "in_progress",
  "activate": ["participant-id"],
  "narrator_needed": true,
  "required_checks": ["world_consistency", "tool_completeness"],
  "interrupt_policy": "segment_boundary",
  "completion_conditions": ["all_required_actions_resolved"],
  "notes": []
}
```

它不替角色决定情绪、措辞或具体反应。Character Runner 拥有自己的完整合法上下文，并可选择行动、说话或沉默。

### 10.3 Validator 管线

按照低成本到高成本排列：

```text
1. Schema / 结构完整性
2. 权限与可见性
3. 时间和 Worldline
4. Tool Call 完整性及必调工具检查
5. 确定性规则与状态前置条件
6. 世界观硬约束
7. Goal 完成度
8. 语义一致性与叙事质量
```

能由代码完成的检查不交给 LLM。LLM Validator 只处理语义、世界观软约束和自然语言完整性。

### 10.4 不会调用工具的模型

每个 Model Profile 记录：

```text
native_tool_calling
parallel_tool_calls
strict_schema
streaming_tool_delta
structured_output
context_limit
cache_capabilities
```

执行策略：

1. 原生工具能力可靠：直接使用供应商 Function Calling；
2. 能结构化输出但工具弱：让模型输出 `ActorActionProposal`，由 Provider Adapter 转成同一 Actor Tool；
3. 两者都弱：使用独立 Intent Compiler 做窄范围结构化，不让 DM 猜测角色意图；
4. 模型遗漏 Actor Tool：Validator 拒绝完成，进行一次窄范围修复；
5. 超过修复次数：执行安全默认、请求真人确认或明确失败，不无限重试。

不得用关键词或正则把自然语言动作直接映射成骰子、技能或状态；DM 也不代理角色选择行动。

### 10.5 ToolSpec

```json
{
  "name": "use_skill",
  "version": 1,
  "description": "角色主动使用一个已知技能。",
  "input_schema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "skill_id": { "type": "string" },
      "target_id": { "type": ["string", "null"] },
      "intent": { "type": "string" }
    },
    "required": ["skill_id", "target_id", "intent"]
  },
  "side_effect": "rule_defined",
  "confirmation_policy": "never",
  "permission": "participant.action"
}
```

Core 绑定 actor、Record、Worldline 与时间。角色只选择行动或技能；是否需要判定、采用 d20、2d6、百分骰、骰池或无骰叙事规则，由 Action Resolver 与 RulePack 决定。

### 10.6 Action Transaction

```text
action_transaction_id
record_id / turn_run_id / actor_instance_id
tool_spec_id / tool_spec_version
tool_call_id
intent
precondition_snapshot_hash
confirmation_requirement
status
random_seed_ref
tool_result
state_delta
committed_event_ids
```

执行流程：

```text
Validate Intent
→ Load current state
→ Build deterministic plan
→ Ask confirmation only if ambiguous / irreversible / high-value
→ Execute with idempotent tool_call_id
→ Recheck precondition version
→ Commit result + state delta + event + outbox
```

### 10.7 通用首版工具

```text
角色可见：
act               尝试自然行动
use_skill         使用已知技能
use_asset         使用道具、装备或有限资源
take_stance       主动进入可控姿态

仅引擎可见：
resolve_uncertainty  按 RulePack 解决不确定性和随机
consume_resource     扣除资源
apply_effect         应用或移除状态效果
```

完整 D&D 规则是未来的 RulePack，而不是 Core 的数据模型。

### 10.8 确定性随机

所有规则随机使用加密 PRF 派生的稳定种子：

```text
seed = PRF(worldline_secret, action_transaction_id, draw_index, rule_pack_version)
```

数据库记录随机算法版本、输入、原始抽样和最终解释。重放得到相同结果；客户端和模型都不能自行指定最终随机值。

---

## 11. 上下文、检索与缓存

### 11.1 Context Compiler 是唯一模型读取入口

所有 DM、角色、Narrator、摘要和 Canon 调用都必须提交 `ContextRequest`：

```text
caller_type
workspace / world / worldline / story / record / scene
principal_id（如适用）
character_instance_id（如适用）
effective_tick
visibility_scope
purpose
token_budget
cache_family
```

任何模块不得自行拼接“最近聊天 + 全部世界书”调用模型。

### 11.2 固定编译管线

```text
1. 验证调用者与 Purpose
2. 固定 Worldline、CanonRevision 和 Effective Tick
3. 计算 Principal / Character / DM 可见域
4. 加载不可变 Snapshot
5. 按域产生关键词与向量候选
6. 在 SQL 中执行 ACL、时间和世界线硬过滤
7. 关键词 + 向量 + 图关系 + 最近性融合排序
8. 应用冲突、来源、认知和 token 预算策略
9. 使用稳定模板和确定性序列化
10. 生成 CompiledContext 与受保护 Context Manifest
```

### 11.3 混合检索

候选来源：

- PostgreSQL FTS：名称、关键词、精确术语；
- pgvector：语义近似；
- Graph Neighbors：直接实体、关系和因果邻居；
- Recency：当前 Scene、近期 Observation、未完成 Goal；
- Pinned：系统硬约束、角色身份、当前 RulePack。

推荐使用 Reciprocal Rank Fusion 合并候选，再应用领域重排：

```text
final_score = rrf(keyword, vector, graph, recency)
            + source_authority
            + character_relevance
            + decision_relevance
            - contradiction_penalty
            - staleness_penalty
```

权限、Worldline 和有效时间是布尔门槛，不是分数项。

### 11.4 向量检索的安全查询

```text
先确定 allowed_scope / worldline / effective_tick
→ 生成受限 SQL 候选集
→ 对小集合精确向量排序
→ 对大集合使用 HNSW + 过取样/迭代扫描
→ 结果不足时对合法候选退化为精确查询
```

Embedding 行必须继承源 Document 的 Workspace、可见性域、有效时间和来源引用。删除或收紧源权限时，通过 Job 立即使对应向量失效；搜索索引不能保留更宽权限的孤儿副本。

### 11.5 摘要域

最少独立维护：

```text
Public Digest               所有人共同可见
Restricted Group Digest     某秘密组可见
Character Digest            单个 Character Lens
DM Digest                   仅控制面
Story Digest                已确认故事层事实
Worldline Digest            已确认 Canon
```

每类摘要从其合法源重新生成。禁止以 DM Digest 为母版删除字段得到 Public/Character Digest。

### 11.6 稳定 Prompt 前缀

```text
P0 Provider/System 固定协议
P1 Runtime 不变量与角色职责
P2 稳定 Tool Bundle
P3 Worldline Canon Snapshot
P4 Story Snapshot
P5 Character Identity / RulePack
──────── Cache Boundary ────────
D1 Scene / Current State
D2 Prefetch Memory / Knowledge
D3 Recent Committed Events
D4 Current Turn Contract / User Input
```

固定段：

- 按固定 Module ID 和版本排序；
- 使用 Canonical JSON；
- 摘要冻结到 Checkpoint，不每轮改写；
- Tool Bundle 只在能力变化时升级；
- 动态内容只追加到尾部。

### 11.7 Cache Family

```text
cache_family_id = hash(
  provider_profile,
  prompt_protocol_version,
  tool_bundle_version,
  worldline_snapshot_id,
  story_snapshot_id,
  character_definition_version,
  rule_pack_version,
  privacy_policy
)
```

Scene 动态内容通常不改变稳定前缀。Canon、角色卡、RulePack 或 Tool Bundle 变化时提升 `cache_epoch`，不对历史缓存原地覆盖。

### 11.8 缓存隐私

- Workspace 和 Scene 可以关闭显式供应商缓存；
- 关闭后 Model Adapter 必须使用供应商对应的禁用选项，并记录实际能力；
- 若供应商无法满足策略，该模型不可用于该 Scene；
- CompiledContext 本地缓存按可见域和 Character Lens 分区；
- Secret Scene 不与 Public Scene 共用 Cache Family；
- 缓存日志只保存 Hash、Token 数和命中信息，不保存秘密正文。

### 11.9 Context Manifest

Manifest 保存：

```text
context_manifest_id
request metadata
snapshot / digest / prompt module versions
候选来源、入选/淘汰原因
visibility scope 与 policy version
token allocation
cache family / epoch
最终内容 hash
```

它属于受保护诊断数据，因为“检索过哪些秘密、谁不知道什么”本身就可能泄密。普通玩家 UI 只显示安全解释，例如“基于角色亲历记忆与公开世界知识”。

---

## 12. 时间线、记忆、Canon 与社会传播

### 12.1 双时间模型

```text
effective_tick   世界观中事件何时发生
recorded_at      系统何时获知或写入
```

Record、Event、Claim、Observation、Knowledge、Memory、关系状态和传播 Packet 都必须保存相应时间。所有 Prefetch 使用 `effective_tick <= invocation_tick`，并考虑知识获得时间，不能让角色读取未来事实。

### 12.2 Character 三层持久化

```text
CharacterDefinition    角色卡与基础设定
CharacterContinuity    某条 Worldline 上的一生与长期记忆
CharacterInstance      某个 Record 中的激活实例和短期状态
```

真人和 AI 使用同一结构。Principal 仅通过 ControlGrant 控制 CharacterInstance；消息审计记录真实来源，但角色 Prompt 不注入现实账号身份。

### 12.3 新实例继承

创建 CharacterInstance 时：

```text
1. 锁定目标 Worldline 与 Record 起始 tick
2. 查找同 Continuity 在此前 tick 已结束/已确认的实例
3. 排除其他 Worldline 和未来知识
4. 合并不可遗忘事实、关键承诺、关系和高强度记忆
5. 对普通经历按时间衰减、重要性和检索相关性压缩
6. 保存 inheritance_manifest 与来源实例
7. 形成新的初始 Character Snapshot
```

继承算法版本化。重算不能悄然改变已经开始的 Record；只能在检查点显式升级。

### 12.4 关系与知识分离

- `relationship_state` 表示好感、信任、恐惧、义务、敌意等主观状态；
- `knowledge_claim` 表示角色相信的事实及置信度；
- `observation` 表示其通过何种渠道接触到什么；
- `memory` 表示被保留并可回忆的个人经历。

关系不能作为事实来源，智力不能绕过观察路径，世界 Canon 也不等于角色自动知晓。

### 12.5 World Graph

首版使用 PostgreSQL：

```text
entities
relations
claims
claim_evidence
causal_edges
lore_articles
```

Claim 是最小事实单位，Article 是面向人和模型的世界观文章投影。地理、历史、势力、人物和基础设定通过 Entity Type 与 Claim Schema 扩展，不靠新增任意 JSON 大字段解决所有问题。

### 12.6 Canon 管线

```text
Record Event
→ DM 提取关键 Claim/Decision
→ Story Proposal
→ 因果与时间冲突扫描
→ DM 包装 Story Article
→ 用户审核
→ Story Commit
→ Worldline Proposal
→ 用户审核
→ CanonRevision Commit
```

普通 Record 事实自动保存，不逐条打扰用户；只有改变主线、世界格局、重要人物命运、长期规则或未来因果的高层变化进入审核。

### 12.7 回溯与世界线分支

回溯 Record 在自己的临时因果覆盖层运行。其 Proposal 与较晚已存在 Record 比较：

- 无冲突：允许升格；
- 局部可解释：给出补丁和受影响范围；
- 高因果风险：默认建议创建 Worldline 分支；
- 已泄露未来信息或破坏角色身份连续性：禁止静默覆盖。

冲突扫描是后台 Job，但 Canon Commit 必须在短事务内再次验证 Base CanonRevision，防止审核期间世界已变化。

### 12.8 社会情报传播

高层事件传播使用事件驱动的多尺度模型：

```text
Canon Claim
→ Information Campaign
→ Packet Version
→ Social Node / Channel Route
→ Contact
→ Attention
→ Comprehension
→ Belief Update
→ Memory Encoding
→ Retransmission / Distortion
→ Character KnowledgeClaim
```

技术实现：

- `packet_versions` 不可变并以父子 DAG 保存失真谱系；
- 重要角色、组织和聚合人口分别使用不同粒度的 SocialNode；
- 广播先更新传播前沿，不立即为所有人创建个人知识；
- Character 即将激活或被查询时懒物化个人 Exposure；
- 每个阶段使用稳定 PRF 种子和版本化参数；
- pgvector 仅匹配主题与兴趣/专业，不决定 ACL、路径或到达；
- 秘密必须先通过硬 ACL，除非存在泄密、偷听、截信等显式事件。

### 12.9 传播 Job 的幂等键

```text
(campaign_id, packet_id, sender_node_id, recipient_node_id,
 channel_id, stage, attempt_no, algorithm_version)
```

相同输入重跑产生相同抽样与 ExposureOutcome；算法升级创建新版本，不改写已用于剧情的旧结果。

---

## 13. Web 前端架构

### 13.1 信息架构

```text
世界大厅
├── 世界卡片
├── 故事卡片
└── Record 卡片

Record 游玩页
├── 主舞台：对话、旁白、工具结果
├── 角色席位：在线、沉默、发言与控制状态
├── 行动区：自然语言、技能、道具和骰子
└── 可折叠知识抽屉：世界 / 故事 / 当前角色

Creator Studio
├── 世界与时间线
├── 角色与关系
├── RulePack 与工具
├── Canon Proposal 审核
└── 受保护诊断与运行状态
```

### 13.2 Projection 驱动

后端按使用目的返回不同 Projection：

```text
PrincipalProjection    真人可以看的 UI 信息
CharacterProjection    角色在世界内知道的信息
PublicProjection       共享显示面共同可见的信息
CreatorProjection      Canon 治理视图
DMProjection           受保护控制面
```

前端不通过隐藏 CSS 保护秘密；服务端响应中根本不能包含越权字段。

### 13.3 上帝视角与战争迷雾

`PlayerWorldMembership.perspective_mode` 在创建时锁定：

- `omniscient`：默认选择；查看所有已提交世界内信息，但不含 DM 推理、草稿和系统机密；
- `character`：只查看当前角色在该时刻能够观察、知道、相信或记得的信息。

动态世界、故事、角色知识面板默认开启，是可变展示偏好，不改变实际权限。关闭面板不删除数据；重新开启仍按 Perspective 投影。

### 13.4 状态管理

- TanStack Query 保存服务器 Projection；
- SSE 更新 Query Cache 或触发精确失效；
- 输入框、卡片开合、草稿使用本地状态；
- 未提交 Preview 以 `turn_run_id + segment_index` 暂存；
- 收到 Committed Event 后用正式 `event_id/ordinal` 替换 Preview；
- 断线后以最后 `stream_id` 补发，不能把本地 Preview 当正式历史。

### 13.5 设计系统

坚持“默认少、按需展开”：

- 一级页面只显示当前任务所需选项；
- 高级参数放 Creator Studio，不放普通对话页；
- World、Story、Record、Character、Tool 都以统一卡片骨架表达；
- 卡片拥有明确状态、主要动作和最多一个次要菜单；
- 颜色不作为唯一状态线索；
- 支持键盘、读屏、触摸和减少动态效果；
- Design Token 统一间距、圆角、阴影、层级、字体和语义颜色。

### 13.6 流式交互

角色输出先显示为“正在形成的短段”，只有服务器标记 committed 后才进入正式历史。被插话或取消时：

- 已提交短段保留；
- 未提交 Preview 平滑撤销；
- UI 显示自然的“被打断”状态，不暴露 Validator 或 Prompt 细节；
- 工具执行展示明确的 Pending、Need Confirmation、Resolved、Failed 状态。

### 13.7 前端安全

- 不把 Access Token 放入 LocalStorage，优先安全 Cookie；
- Markdown/富文本采用白名单渲染；
- 角色内容不允许任意 HTML、脚本、远程 iframe；
- 图片代理和上传检查 MIME、尺寸、大小及恶意内容；
- Creator 诊断路由独立鉴权并设置更严格缓存头；
- 浏览器日志不打印 Context、秘密 Event 或模型原始响应。

---

## 14. 飞书 Gateway 架构

> 【目标/未实现】飞书 Gateway **未实现**，且明确不属于当前阶段（`MODEL-AND-MEMORY-RUNTIME.md`：“飞书消息网关不属于本阶段；原生 Web 体验是唯一活动入口”)。本章保留为未来接入消息平台时的设计参考；任何真实联调仍需用户另行授权。

### 14.1 Adapter 边界

```text
飞书 Webhook
→ 验签/解密
→ 去重
→ external open_id 映射 Principal
→ chat_id 映射 GatewayBinding / Active Record
→ 标准 InboundMessage
→ Application Command
```

Feishu Adapter 只理解平台能力，不直接查询 World、Character、Memory 或调用模型。

### 14.2 标准输入

```json
{
  "gateway": "feishu",
  "external_message_id": "...",
  "external_chat_id": "...",
  "external_sender_id": "...",
  "conversation_kind": "group",
  "content_type": "text",
  "content": {},
  "received_at": "...",
  "capabilities": {
    "stream_update": false,
    "private_reply": true
  }
}
```

标准输入不携带可信的角色身份；Identity 模块根据绑定和 ControlGrant 解析受控 CharacterInstance。

### 14.3 群聊与 Record

- 一个飞书群绑定一个当前活跃 Record；
- 绑定历史独立保存，切换由私聊主控或 Web 完成；
- 群成员输入映射到各自的角色 Participant；
- 同一角色多人共控默认拒绝，显式开启后使用 TurnControlLease；
- OOC 命令进入控制面，不伪装成角色发言。

### 14.4 共同可见交集

群聊是共享显示面，无法为同一条群消息提供不同正文。因此投递前计算：

```text
PublicProjection = intersection(
  当前群成员的 PrincipalProjection,
  Scene visibility,
  Gateway capability
)
```

上帝视角补充、角色私有知识、密谋和个人面板通过 Web 或机器人私聊发送。某位上帝视角玩家的存在不能扩大群消息可见域。

### 14.5 首版投递策略

首版采用“生成与验证完成后一次发送”：

- 不做 Token/卡片逐步更新；
- Outbox 保证重试；
- 长回复按语义段安全拆分，保持顺序；
- 同一 `outbound_message_id` 映射平台幂等键；
- 发送失败不回滚世界状态，只产生投递故障并重试。

后续确认平台能力和稳定性后，再加入交互卡片、句段更新和 Tool Confirmation 卡片。

### 14.6 密谋路径

密谋不能发到原群后撤回。允许的渠道：

- Web 私密 Scene；
- 机器人私聊参与者；
- 单独的受控飞书群绑定 Private Scene。

任何私密路径都生成独立 Visibility Policy、Digest、Context Cache Family 和 Delivery Projection。

---

## 15. 后台任务与调度

### 15.1 PostgreSQL Job Queue

```text
job_id
workspace_id
job_type
payload_version / payload
priority
available_at
status
attempt_count / max_attempts
lease_owner / lease_expires_at
deduplication_key
last_error_code
created_at / completed_at
```

Worker 使用 `FOR UPDATE SKIP LOCKED` 批量领取到期任务，立即提交租约事务；实际模型或外部调用在事务外执行。

### 15.2 Job 分类

| 类别 | 示例 | 是否可丢弃 |
|---|---|---|
| 正确性任务 | Outbox 投递、超时恢复、Canon Commit 后投影 | 否 |
| 可重建任务 | Embedding、FTS、摘要、搜索投影 | 可重建但不可永久遗漏 |
| 模拟任务 | 情报传播、记忆巩固、因果扫描 | 可重试，结果需确定性 |
| 优化任务 | Cache 预热、分析指标 | 可丢弃或降级 |
| 媒体任务 | 图片、语音、卡片资源 | 依业务请求决定 |

### 15.3 重试策略

- 只对明确可重试错误自动重试；
- 指数退避 + 抖动；
- 使用业务幂等键，而非假设“请求失败就没有副作用”；
- 超过上限进入 Dead Letter；
- 认证、Schema、权限和世界不变量错误不自动重试；
- 模型内容不合格采用有限 Repair Run，不混入基础设施重试计数。

### 15.4 Scheduler

Scheduler 处理两种时间：

```text
系统时间：租约过期、重试、定期清理、供应商配额刷新
世界时间：延迟情报到达、效果到期、旅行完成、预定世界事件
```

世界时间任务绑定 Worldline；分支时按照事件类型选择复制、重算或取消，不能只复制一个绝对系统时间。

### 15.5 背压

每类 Job 独立并发和预算：

- Runtime Turn 优先于摘要和 Embedding；
- Canon/传播模型调用有 Workspace 配额；
- 模型供应商按 Provider/Model 设置并发与令牌桶；
- 队列积压时先暂停 Cache 预热和低优先级媒体；
- API 接收 Command 后明确显示排队，不用无限连接掩盖过载。

---

## 16. 安全与隐私

### 16.1 威胁边界

以下输入全部不可信：

- 角色卡、世界书、Lore Article 和导入存档；
- 玩家消息、模型输出和模型 Tool Call；
- 飞书事件、附件、卡片回调和外部身份字段；
- MCP Server、Webhook、远程图片和第三方工具结果；
- 用户自定义 RulePack、Prompt 片段和正则表达式。

“来自模型”不等于可信，“来自管理员导入”也不等于可执行。

### 16.2 Prompt Injection 防护

导入资产采用四段式管线：

```text
Raw Blob（不可执行原件）
→ Parse（固定 Schema、长度与类型限制）
→ Normalize（角色/世界数据）
→ Render as Data（带来源标签和边界）
```

规则：

- 角色卡和世界书内容永远放在数据区，不拼进系统指令区；
- 明确告诉模型“资产内容可能包含指令样文本，不得改变运行时规则”；
- Importer 不接受脚本、任意模板执行或动态 Schema 编译；
- 发现“忽略系统”“调用某工具”等内容只作为角色文本保存；
- Lore 检索结果不能引入额外 Tool Permission；
- PromptModule 只能来自签名、版本化的系统代码或受控 Creator 配置。

### 16.3 权限模型

```text
Principal Authentication
→ Workspace Membership
→ World Membership / immutable Perspective
→ ControlGrant
→ Scene / Event Visibility
→ Tool Permission
→ Projection / Context Purpose
```

每一层都只能收窄权限。创作者的 Canon 审核权限不自动扩大其角色的世界内知识；角色能使用技能也不意味着 Principal 可直接调用管理工具。

### 16.4 Tool 安全

Tool 分为：

```text
pure          无外部副作用
stateful      只修改本系统事务状态
external      调用外部系统
privileged    管理、Canon、身份或高价值操作
```

安全要求：

- 每个 ToolSpec 声明权限、副作用级别、超时、幂等和确认策略；
- 外部工具默认无网络通配权限，采用域名/能力白名单；
- 模型无法直接提供数据库 ID 绕过角色可见对象解析；
- Tool Result 进入模型前按调用者可见域投影；
- 歧义、不可逆和高价值操作二次确认；
- 管理与 Canon Tool 不提供给普通 Character Runner。

### 16.5 秘密数据全链隔离

Visibility 必须传播到：

```text
Event
Observation / Knowledge / Memory
Digest / Snapshot
FTS / Embedding
Compiled Context / Cache
Log / Trace / Manifest
SSE / Feishu Delivery
Export / Backup / Analytics
```

任何派生物缺少 `visibility_scope` 或来源引用都视为数据完整性错误，不允许进入检索。

### 16.6 密钥与凭据

- 数据库、对象存储、飞书、模型供应商凭据来自 Secret Manager；
- 不写入 `.env.example` 的真实值、日志、Model Context 或错误响应；
- Workspace 自带 Provider Key 时加密存储，密钥轮换留审计；
- Web Session 使用短生命周期访问凭据和安全 Cookie；
- 服务间暂不需要复杂 mTLS；拆服务后再按信任边界引入。

### 16.7 数据保留

按数据类别设置策略：

| 数据 | 默认策略 |
|---|---|
| 正式 Event/Canon/ToolResult | 长期保留，支持导出 |
| 未提交模型草稿 | 极短期或不落盘 |
| Context Manifest | 受保护、限期保留 |
| 原始模型响应 | 默认不长期保存；诊断需脱敏和显式开启 |
| Audit Event | 防篡改、按安全策略保留 |
| Embedding/Cache | 可重建，权限变化后优先失效 |
| 飞书原始 Payload | 完成映射后最小化保留 |

### 16.8 安全降级

不确定时遵循：

```text
权限不确定        → 不返回
时间归属不确定    → 不注入角色上下文
Tool 前置不明确   → 不执行，必要时确认
模型格式不完整    → 不提交
投递受众不明确    → 不发送群聊
Canon 冲突不明确  → 暂存或建议分支
```

---

## 17. 可观测性、审计与成本

### 17.1 Trace 模型

一条用户输入至少贯穿：

```text
gateway.receive
→ command.accept
→ turn.plan
→ context.compile
→ model.invoke.dm
→ model.invoke.character
→ output.validate
→ tool.execute
→ record.commit
→ outbox.dispatch
→ gateway.deliver
```

核心关联 ID：

```text
trace_id
correlation_id
causation_id
command_id
turn_run_id
model_invocation_id
tool_call_id
event_id
outbound_message_id
```

### 17.2 结构化日志

日志默认只保存元数据：

- ID、状态、耗时、Token、模型、重试次数；
- Visibility Class，不保存秘密正文；
- SQL 模板名与耗时，不记录绑定参数中的用户内容；
- 错误码和受控摘要，不直接打印供应商响应；
- 所有日志字段通过集中 Redaction Policy。

### 17.3 指标

运行指标：

```text
command_accept_latency
turn_duration / queue_delay
record_commit_conflict_rate
runtime_recovery_count
job_lag / dead_letter_count
outbox_delivery_latency / failure_rate
sse_reconnect / replay_count
```

模型指标：

```text
prompt_tokens / completion_tokens
cache_read_tokens / cache_write_tokens
time_to_first_segment
tool_call_required_but_missing
schema_failure / validator_repair_rate
interrupted_generation_waste
provider_error / fallback_rate
```

上下文指标：

```text
candidate_count_by_source
acl_filtered_count
token_budget_by_layer
context_manifest_size
vector_recall_fallback_rate
stale_snapshot_rate
prefix_hash_stability / cache_hit_rate
```

产品质量指标：

```text
secret_leak_incident
future_knowledge_violation
tool_double_effect
worldline_conflict_detected / missed
character_silence_rate / overtalk_rate
canon_proposal_accept_edit_reject
```

### 17.4 Audit 与普通日志分离

Audit Event 记录：

- Perspective 创建与锁定；
- ControlGrant、共控和临时控制；
- Secret Scene 成员变化；
- Manifest/DM Projection 访问；
- Canon 审核与世界线分支；
- 高价值/不可逆工具确认；
- Provider Key、缓存隐私和保留策略变化；
- 管理员导出、删除和恢复。

Audit 存储不可被普通应用日志轮转策略删除，并限制读取角色。

### 17.5 成本账本

`ops.model_usage` 按以下维度记录：

```text
workspace / world / record
purpose                  dm / character / narrator / summary / diffusion / canon
provider / model
prompt / completion / cache tokens
latency / retries
estimated_cost
context_manifest_id
```

Workspace 可以设置月度预算、单 Turn 预算和后台模拟预算。超限时优先降级摘要、传播语言润色和 Cache 预热，不得跳过权限与规则检查。

---

## 18. 测试与质量门禁

### 18.1 测试分层

| 层级 | 工具 | 重点 |
|---|---|---|
| Domain Unit | Vitest | 时间、可见性、规则、分支、继承、概率阶段 |
| Module Integration | Vitest + Testcontainers | 真实 PostgreSQL 锁、RLS、事务、FTS、pgvector |
| Contract | JSON Schema Fixtures | HTTP、Event、Tool、Model Adapter、Feishu |
| Runtime Scenario | Fake Model Provider | Turn 状态机、修复、插话、崩溃恢复 |
| End-to-End | Playwright | Web Perspective、密谋、工具确认、断线续传 |
| Model Eval | 固定场景集 | 角色一致性、工具遗漏、世界观与输出完整性 |
| Load/Chaos | 场景压测 | 热门 Record、队列积压、供应商超时、Worker 终止 |

### 18.2 不使用内存数据库替代核心集成测试

SQLite/PGlite 可用于前端演示或纯查询单测，但以下测试必须运行真实 PostgreSQL + pgvector：

- Advisory Lock、Row Lock、`SKIP LOCKED`；
- RLS 与 `SET LOCAL`；
- 范围类型和递归 CTE；
- GIN FTS 与 pgvector；
- Transactional Outbox；
- 并发唯一约束。

### 18.3 必须有的场景测试

1. 密谋消息不进入非参与角色的 Prompt、摘要、向量、缓存、日志和飞书群消息；
2. 角色在 tick 100 不知道 tick 110 才获得的情报；
3. 上帝视角玩家看到秘密不导致其 Character Lens 获得秘密；
4. 同一飞书事件重复十次只形成一个 Command 效果；
5. 两个 Worker 并发提交同一 Record，只有一个 ordinal 成功；
6. Tool 超时后重试不重复扣除物品；
7. 模型遗漏必要工具时 DM 不允许回合假完成；
8. 插话只截断未提交 Segment，已提交语言保持历史一致；
9. 过去 Record 改变关键事件时默认提出 Worldline 分支；
10. 新 CharacterInstance 只继承该 Worldline、该时点以前的长期记忆；
11. 群聊只收到所有群成员的共同可见交集；
12. Context Snapshot 未变化时稳定前缀 Hash 不变；
13. 用户资产包含 Prompt Injection 时不能提升权限或调用工具；
14. 情报没有传播路径时，即使角色身份高级、兴趣强、智力高也不能知晓；
15. 同源谣言多次转述不被计算成独立证据。

### 18.4 Model Eval

模型行为不可只靠单元测试。建立版本化 Eval Dataset：

```text
tool_required_but_omitted
tool_called_with_invalid_args
world_lore_contradiction
secret_temptation
future_knowledge_temptation
character_should_stay_silent
interruption_boundary
goal_incomplete_ending
narrator_public_only
lightweight_rule_pack
```

评测保存 Prompt Protocol、Model Profile、Tool Bundle、Context Snapshot 和评分器版本。更换模型或 Prompt 前必须跑回归。

### 18.5 CI 质量门禁

```text
format
→ lint + dependency boundaries
→ typecheck
→ unit tests
→ contract/schema compatibility
→ PostgreSQL integration tests
→ build
→ selected runtime scenarios
→ migration safety check
→ container scan / secret scan
```

完整 Model Eval、E2E 和负载测试可按发布候选运行，不必阻塞每个小提交。

---

## 19. 本地开发、CI/CD 与发布

### 19.1 本地环境

本地最小依赖：

```text
Node.js LTS
pnpm
Docker / compatible container runtime
PostgreSQL + pgvector container
S3 compatible local object store
可选 Redis
Fake Model Provider
```

开发默认使用 Fake Provider，使状态机、工具、流式、权限和测试不依赖真实模型费用。真实 Provider 通过个人 Secret Profile 显式启用。

### 19.2 常用仓库命令语义

```text
dev              启动 Web、API、Worker 和依赖
check            format/lint/typecheck/unit
test:integration 启动隔离 PostgreSQL 执行模块集成测试
test:e2e         执行关键用户路径
db:migrate       对目标环境运行待执行 Migration
db:verify        检查 Schema 与生成类型一致
contracts:check  检查 Event/API/Tool 向后兼容
eval             运行模型场景评测
```

命令由根目录统一提供，工程师不需要记住每个 Package 的私有脚本。

### 19.3 分支与变更单元

一个业务变更应尽量垂直完成：

```text
Contract
→ Domain/Application
→ Persistence/Migration
→ API/Projection
→ Web/Gateway
→ Tests/Observability
→ ADR（若改变边界）
```

禁止先在 `shared` 堆抽象、等待未来功能使用。跨三个以上模块的同步调用需要在评审中说明为何不能通过编排或事件完成。

### 19.4 发布产物

推荐构建：

```text
runtime-server image
  command: api | runtime-worker | background-worker | scheduler | migrate

web static artifact
```

所有 Server 角色来自同一 Commit 和 Contract Version。Web 可以独立发布，但必须声明兼容的 API Contract 范围。

### 19.5 发布策略

1. 先运行兼容性 Migration；
2. 发布支持新旧 Schema 的 Server；
3. 发布 Web；
4. 执行数据 Backfill；
5. 观察指标与错误；
6. 下一发布窗口再删除旧字段和旧 Event Consumer。

模型 Prompt、RulePack、ToolSpec 和传播参数同样版本化发布，不能把它们当作数据库外的不可追踪配置。

### 19.6 Feature Flag

Feature Flag 适用于：

- 新 Model Adapter；
- 新 Tool/RulePack；
- 新 Context Ranker；
- 社会传播参数版本；
- 飞书卡片流式；
- 新 Canon 工作流。

Flag 不得用于长期维持两套核心事务语义。Record 创建时可冻结必要运行时版本，避免进行中体验漂移。

---

## 20. 部署、扩容与服务拆分

### 20.1 本地与单机部署

```text
reverse proxy
├── web static
└── api

runtime-worker
background-worker
scheduler
postgres + pgvector
object storage
optional redis
```

即使单机部署，进程角色也保持分离配置，避免 API 被长模型调用和后台任务阻塞。

### 20.2 生产初始拓扑

```mermaid
flowchart TB
    LB["Load Balancer"] --> API1["API Replica 1"]
    LB --> API2["API Replica 2"]
    API1 --> PG["Managed PostgreSQL + pgvector"]
    API2 --> PG
    RW1["Runtime Worker Pool"] --> PG
    BW1["Background Worker Pool"] --> PG
    SCH["Scheduler Leader / Lease"] --> PG
    API1 --> OBJ["Object Storage"]
    API2 --> OBJ
    RW1 --> LLM["Model Providers"]
    BW1 --> LLM
```

初期不要求 Kubernetes。容器平台只要支持健康检查、滚动发布、独立副本和 Secret 注入即可。

### 20.3 健康检查

```text
/health/live     进程事件循环可响应
/health/ready    数据库、必要配置和 Migration 版本可用
/health/startup  启动初始化是否完成
```

模型供应商故障不应让 API `live` 失败，但会影响 Runtime Readiness/Provider Health，并触发路由降级。

### 20.4 扩容顺序

1. 增加 Runtime Worker，按不同 Record 并行；
2. 增加 API 副本；
3. 独立增加 Background Worker 类别并设置并发；
4. 优化 PostgreSQL 索引、连接池、查询和分区；
5. 增加只读副本承担读 Projection；
6. 只有测量证明后才拆服务或引入专用存储。

同一 Record 的热门会话不能靠增加 Worker 并行提交解决；应优化 Prompt、模型延迟、语义段长度和工具事务。

### 20.5 PostgreSQL 分区候选

先不要分区所有表。达到规模后优先评估：

- `event_store` 按 Workspace Hash 或时间分区；
- `ops.jobs/outbox/audit_events` 按时间分区；
- 大型 `context.embeddings` 按模型或 Workspace 分组；
- 社会传播 `transmissions/exposures` 按 Worldline/时间分区。

分区键必须保留常见查询的裁剪能力，不能为了归档破坏 Record 顺序读取。

### 20.6 备份与灾难恢复

- PostgreSQL 使用连续归档/PITR；
- 对象存储启用版本化或生命周期策略；
- 定期执行恢复演练，不只检查备份任务成功；
- Secret 与基础设施配置有独立恢复流程；
- Event、State、Outbox 的恢复点必须一致；
- Provider Cache、Embedding 和搜索投影不进入关键恢复目标，可重建。

首版建议目标：明确并演练 RPO/RTO，再根据真实使用价值调整，不在文档中虚构零数据丢失承诺。

### 20.7 拆服务的证据门槛

满足下列至少一类持续证据才拆：

- 某模块独立扩容需求长期高出其他模块约 3 倍；
- 经 SQL、批处理、缓存和 Worker 隔离后仍拖累核心 p95/p99；
- 出现明确的安全、合规、网络或数据保留边界；
- 团队所有权、发布频率或故障域必须独立；
- PostgreSQL Outbox/Job 吞吐成为已测量瓶颈；
- 专用存储在真实基准上带来必要收益。

### 20.8 推荐拆分顺序

```text
较早可拆：媒体处理 → Embedding/检索 → 社会传播 → Model Gateway
中期可拆：Delivery Gateway → Analytics/Operations
最后才拆：Record Runtime → Event/Rules Transaction → Canon Commit
```

拆分前要求：

1. 模块已有独立 Contract 与表所有权；
2. Outbox Event 可以承载跨进程一致性；
3. 明确重复、乱序、超时和补偿策略；
4. 不把 Character Secret 通过宽泛 Event 广播；
5. 有对比基准和回滚方案。

---

## 21. 分阶段实施顺序

### 阶段 0：仓库与契约骨架

交付：

- Monorepo、模块边界检查和统一命令；
- PostgreSQL Schema/Migration 框架；
- Shared Kernel、Schema Profile、Event/Command Header；
- Fastify API、SSE、Worker 和 Fake Model Provider 骨架；
- OpenTelemetry Trace 与结构化日志；
- ADR 模板和基础 CI。

退出条件：空业务场景可以完成 Command → Job → Event → SSE 的端到端闭环。

### 阶段 1：可玩的最小垂直切片

交付：

- World → Story → Record；
- Principal、玩家角色卡、CharacterInstance、Participant；
- 一对一和基础多人；
- DM Controller / Character Runner / Narrator；
- Record 单写入和完成后一次释放；
- Web 对话页与飞书群绑定；
- Event Store、Outbox、基本 Projection。

退出条件：两位真人与一个 AI 角色能在 Web/飞书完成可恢复的一轮对话，重复投递不重复生效。

### 阶段 2：工具与严格完成

交付：

- ToolSpec、Action Transaction、通用工具包；
- RulePack 难度档映射；
- DM Validator 与遗漏工具修复；
- Inventory、Effect、随机审计；
- 二次确认策略。

退出条件：模型不会调用工具时仍能由 DM 代理完成必要动作，工具重试不会双重扣除。

### 阶段 3：时间安全上下文与长期角色

交付：

- Context Ledger/Compiler/Manifest；
- 关键词 + pgvector + 图邻居混合检索；
- 分域摘要与稳定 Cache Family；
- Observation、Knowledge、Memory、Relationship；
- CharacterContinuity 与实例继承；
- 上帝视角/战争迷雾 Projection。

退出条件：秘密和未来信息在 Prompt、摘要、检索、缓存和 UI 全链均不可越权。

### 阶段 4：语义流式、插话与复杂多人

交付：

- 语义段 Preview/Commit；
- 插话、取消、强沉默偏置；
- 多模型并行候选和串行提交；
- 显式多人共控与 TurnControlLease；
- 飞书卡片能力评估和可选升级。

退出条件：被打断输出不污染历史，多个模型不能造成 Record 双写。

### 阶段 5：世界治理与社会传播

交付：

- Entity/Claim/Article World Graph；
- Record → Story → Worldline Canon Proposal；
- 回溯冲突扫描与世界线分支；
- Information Campaign/Packet/Channel/Exposure；
- 聚合传播与角色懒物化；
- Canon Creator Studio。

退出条件：过去重大改写不会静默破坏未来 Record，高层消息按路径、延迟和认知差异传播。

---

## 22. 架构决策记录与待确认项

### 22.1 建议建立的 ADR

| ADR | 主题 | 当前建议状态 |
|---|---|---|
| ADR-001 | 模块化单体 + PostgreSQL 权威 | Proposed，建议接受 |
| ADR-002 | TypeScript Monorepo | Proposed |
| ADR-003 | JSON Schema 受限子集作为契约标准 | Proposed |
| ADR-004 | Fastify + Kysely | Proposed |
| ADR-005 | HTTP Command + SSE 首版实时协议 | Proposed |
| ADR-006 | Record 逻辑单写入者 | Accepted |
| ADR-007 | Utterance Commit 与 Action Transaction 分离 | Accepted |
| ADR-008 | DM Controller 与 Narrator 分离 | Accepted |
| ADR-009 | PostgreSQL Job Queue + Outbox | Proposed |
| ADR-010 | PostgreSQL 关系图谱，暂不引入图数据库 | Proposed |
| ADR-011 | 关键词 + pgvector 混合检索 | Accepted |
| ADR-012 | 独立可见域摘要与缓存 | Accepted |
| ADR-013 | 通用 RulePack，不绑定完整 D&D | Accepted |
| ADR-014 | 真人通过 CharacterInstance 入场 | Accepted |
| ADR-015 | 社会情报传播采用多阶段概率模型 | Accepted |

### 22.2 建议下一轮确认的技术选择

业务方向已经足够明确。进入建仓前只需确认这些可替换技术选择：

1. 是否接受 TypeScript 全栈，而不是后端使用 Go/Rust；
2. 是否接受 React SPA，而不是 Next.js；
3. 是否接受 Fastify + Kysely，而不是 NestJS + ORM；
4. 是否首版启用 Workspace RLS；
5. SSE 是否作为 Web 首版流式协议；
6. 对象存储采用云服务还是自建 S3 兼容服务；
7. 第一批模型供应商和默认 Fallback 顺序。

这些选择不会改变领域模型，但会影响首版工程模板和运维复杂度。

---

## 23. 附录

### 23.1 命名约定

| 类型 | 约定 | 示例 |
|---|---|---|
| TypeScript 文件 | `kebab-case.ts` | `commit-action-transaction.ts` |
| 类型/类 | `PascalCase` | `CharacterContinuity` |
| 函数/变量 | `camelCase` | `compileCharacterContext` |
| 数据库 | `snake_case` | `effective_from_tick` |
| Event Type | `dot.case.vN` | `knowledge.claim.acquired.v1` |
| Job Type | `dot.case.vN` | `context.embedding.generate.v1` |
| Tool Name | `snake_case` | `use_skill` |
| HTTP JSON | `snake_case` 或 `camelCase` 二选一后全局固定 | 推荐 `snake_case` 对齐事件/工具 |

禁止使用含义模糊的 `data`、`info`、`manager`、`processor` 作为核心领域命名。名称应表达具体动作或所有权。

### 23.2 Module Definition of Done

一个新模块进入主干前必须具备：

- 清晰的职责与非职责；
- 拥有的 PostgreSQL Schema/Table；
- 唯一 `public.ts`；
- Command/Query/Event Contract；
- 权限、时间和 Workspace 策略；
- Unit + Integration + Contract Test；
- Trace、Metric、Error Code；
- Migration 与恢复说明；
- 不产生新的循环依赖。

### 23.3 关键提交伪代码

```ts
async function commitTurn(candidate: ValidatedCandidate) {
  return database.transaction().execute(async (trx) => {
    await acquireRecordCommitLock(trx, candidate.recordId)

    const head = await recordHeads.getForUpdate(trx, candidate.recordId)
    assertVersion(head, candidate.baseRecordVersion)

    const effects = candidate.action
      ? await rules.applyAction(trx, candidate.action, head)
      : noEffects()

    const events = await storyRecord.appendValidatedEvents(trx, {
      candidate,
      effects,
      firstOrdinal: head.nextOrdinal,
    })

    await recordHeads.advance(trx, head, events.length)
    await operations.enqueueOutbox(trx, events)

    return { events, newVersion: head.version + 1 }
  })
}
```

伪代码的关键不是具体 API，而是：锁和事务只覆盖重新验证与提交，不覆盖 LLM 推理。

### 23.4 推荐技术资料

- [Fastify：Validation and Serialization](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)
- [Fastify：TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/)
- [Kysely：Type-safe SQL Query Builder](https://www.kysely.dev/)
- [PostgreSQL：SELECT 与 SKIP LOCKED](https://www.postgresql.org/docs/current/sql-select.html)
- [PostgreSQL：Advisory Lock Functions](https://www.postgresql.org/docs/current/functions-admin.html)
- [pgvector 官方仓库与索引说明](https://github.com/pgvector/pgvector)
- [OpenTelemetry JavaScript](https://opentelemetry.io/docs/languages/js/)

### 23.5 最终工程原则

1. 先保护世界状态与秘密，再优化生成速度。
2. 让模型提出候选，让代码掌握权限、顺序、规则和提交。
3. 共享契约，不共享无边界业务实现。
4. 事务要短，但需要原子的一定放在同一事务。
5. 不提前拆服务，也不允许单体内部失去边界。
6. 检索、摘要和缓存都必须继承原始信息的时间与可见性。
7. 每个不可逆结果都要能回答：谁、何时、基于什么、通过哪个工具、写入了什么。
8. 目录结构服务于职责和依赖，而不是追求文件数量上的“整齐”。
