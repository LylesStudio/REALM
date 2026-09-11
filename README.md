# 界核 / REALM

> 一个面向多人叙事的角色运行时：让世界、角色、记忆和事件在持续对话中自然生长。

**当前定位：`v0.1.0` · self-hosted single-user / research preview**

REALM 已经具备完整的本地回合链，但公网多人身份、容量、费用控制和长期运营仍在建设中。欢迎阅读、运行和反馈；请不要把当前版本当作已经准备好的公共 SaaS。

## 已具备的能力

- 可恢复 Turn Core、Record 单写入和 append-only Event；
- DM、Narrator、Character Runner、规则事务、骰点、presence 和 self-play；
- 多 NPC participant ID，以及结构化 `recipientId` 对话目标，避免角色混淆发言对象；
- 提交后异步 Character Memory、场景结晶、世界知识和人物设定自然生长；
- 下一回合读取 Record-local knowledge 与角色 profile notes；
- PostgreSQL + pgvector 权威存储、RLS、最小权限和可见性投影；
- World / Story / Record 管理、知识图谱、Canon 审核；
- `.realm` 世界导出/导入、dry-run、copy/preserve 和冲突保护；
- 多供应商模型设置、结构化输出容错和 SSE 已提交事件更新；
- 直角纸墨界面与响应式布局。

## 快速开始

### 前置环境

- Node.js `22.13+`；
- PostgreSQL 17 + pgvector；
- Docker（运行完整 PostgreSQL scratch 集成测试时需要）；
- 可选：一个 OpenAI-compatible 模型服务。没有模型服务时，确定性测试仍可运行。

### 安装与运行

```bash
npm install
cp .env.example .env.local
npm run dev
```

`npm run dev` 会初始化本地开发数据库、执行迁移和演示 seed，然后启动 REALM。
默认服务地址是 `http://127.0.0.1:9999`。需要使用不同的 PostgreSQL 工具目录时，可以设置 `REALM_POSTGRES_BIN`。

真实模型可以通过设置页配置，也可以在 `.env.local` 中提供相应的占位配置。实际 API key 只能保存在本机未跟踪配置中，不能提交到 GitHub、Issue、日志或模型输入。

## 验证

```bash
npm test             # 类型、Core、应用、前端契约、PG scratch、构建、渲染
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm run test:core    # 纯 Core focused tests
npm run test:postgres-runtime  # 一次性隔离 PG17 scratch cluster
```

完整 PostgreSQL 测试使用一次性隔离集群，不应回退写入个人或生产数据库。

## 架构概览

```text
玩家 / 自演输入
      │
      ▼
Runtime Scope ──► DM / Character / Narrator orchestration
      │                         │
      │                         ├─ Rule Pack / Action Receipt
      │                         └─ structured semantic output
      ▼
Record single-writer ──► append-only Events / Observations / Outbox
      │
      ├─ Delivery Projection + SSE
      ├─ Character Memory sync / prefetch
      ├─ Scene crystallization
      └─ Record-local world knowledge + profile growth
```

主要目录：

```text
app/                         Web 页面与 API 路由
modules/application/         生产应用编排与 Record 服务
modules/orchestration/       DM、角色、旁白和 presence 编排
modules/runtime/             可恢复回合与正式提交
modules/inference/           模型供应商、安全网关和 Prompt Kit
modules/memory/              持久化记忆、萃取和召回
modules/world-knowledge/     实体、Claim、关系、文章和 Canon
modules/worldline/           世界线分叉、合并和冲突评估
database/postgres/           PostgreSQL repository、projection、seed、migration
tests/                       Core、应用、契约、PG 和渲染测试
docs/architecture/           公开架构文档
```

## 数据与隐私边界

REALM 的玩家输入、事件、角色记忆和世界设定都是运行数据。当前项目适合本地或受控 self-hosted 使用：

- 数据库存储由运行者管理；
- 模型请求由运行者选择的供应商处理；
- 仓库不包含模型、访问令牌、生产数据库或真实用户数据；
- `.env.local`、`.local/`、备份、日志和构建产物不属于源码发布内容；
- 当前登录模型仍是 research preview，不等价于公网多租户身份系统。

## 当前限制

- 公网多人注册、邀请、owner 治理和账户隔离尚未完成；
- 公共服务所需的限流、费用预算、数据保留和删除政策尚未定稿；
- 默认运行路径是 Node/Vinext + PostgreSQL，Cloudflare Worker/Container 部署尚未纳入活动源码路径；
- 长期叙事质量和连续多回合耐玩性仍需要更多真实玩家验证；
- 模型供应商能力、延迟和输出质量会影响实际体验。

## 文档

- [总体设计](./docs/architecture/SYSTEM-DESIGN.md)
- [技术架构](./docs/architecture/TECHNICAL-ARCHITECTURE.md)
- [PostgreSQL Runtime Contract](./docs/architecture/POSTGRESQL-RUNTIME-CONTRACT.md)
- [模型与记忆运行时](./docs/architecture/MODEL-AND-MEMORY-RUNTIME.md)
- 场景结晶与自然生长

完整的内部验收台账、代理规则、生产运行记录和历史实验材料不会随 public snapshot 发布。

## 参与贡献

请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题请阅读 [SECURITY.md](./SECURITY.md)，不要在公开 Issue 中粘贴凭据、数据库内容或真实玩家数据。

## 许可证

REALM 采用 [Apache-2.0](./LICENSE) 许可证。
