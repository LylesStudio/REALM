# 模型与记忆运行时

## 1. 当前边界

- 推理供应商和叙事 Core 通过 `ModelGateway` 分离；领域模块不依赖供应商 SDK。
- 当前支持两个 OpenAI-compatible profile：LAN 上的 LM Studio（`/v1`）与 OpenRouter（`/api/v1`）；前者允许空 API key，后者使用官方 HTTPS Bearer API key。
- 多供应商配置保存在本机 `.local/settings/model-providers.json`（0600、Git 忽略）；旧 `.local/settings/model-provider.json` 可迁移读取。浏览器只得到 active profile、模型目录和 API key 是否配置/末四位提示。
- Base URL 按供应商钉定 host/端口/协议/path 并服务端校验，拒绝任意外部端点以防 SSRF；模型发现和推理仍分别使用各自的 `/models` 与 `/chat/completions`，含 SSE 流式。
- OpenRouter Models API 的 pricing 快照以 USD/token 保存并显示为每 1M token；输入/输出均为 0 时只标记“当前免费”，不承诺灰测模型永久免费。
- 外部模型处于启用状态时，生成必然会发送最小世界规则、当前场景、本轮玩家输入、被激活角色和该角色在当前时间点有权知道的记忆；这是模型完成生成所必需的数据面。
- 编译顺序必须先完成 Worldline、时间游标和受众授权过滤，再调用供应商。API Key、数据库连接、源码、未授权秘密、Context Manifest、过滤计数和未提交候选不属于模型输入。
- 飞书消息网关不属于本阶段；原生 Web 体验是唯一活动入口。

## 2. 模型职责

```text
DM Controller       选择需要激活的角色、定义本轮 Goal
Character Runner    自主选择 act / use_skill Actor Tool
Action Resolver     本地规则判断自动成功或内部不确定性
Narrator            只根据公开 Action Receipt 叙述结果
DM Validator        检查完整结束、世界约束与职责越界
```

DM 不替角色调用工具，不替角色决定态度。角色模型也不直接请求骰点、难度或状态变更；它只表达自然世界中的行动意图。

模型动态输入始终位于提示后部。稳定的职责、世界规则和工具 schema 位于前缀，以减少供应商 Prompt Cache 的失效范围。

## 3. 记忆模型

本项目参考但不照搬两类开源实现：

- mem0：事实抽取、ADD/UPDATE/RETRACT 生命周期、向量和关键词混合召回、实体连接。
- Honcho：真人与 AI 统一为参与实体、Session 消息作为原子输入、`observer → observed` 结论、异步派生与低延迟 Representation。

REALM 的关键差异是：权限和时间先于相关性。

```text
正式 Event
  → CharacterInstance Observation
  → Character continuity Conclusion
  → 时间 / Worldline / observer 硬过滤
  → 关键词 + 向量 + 保真度 + 近因排序
  → Character Runner 动态上下文
```

### 3.1 长期身份

Memory Conclusion 归属于 `CharacterContinuity`，而不是单个 Record 中的 CharacterInstance。因此同一角色进入新 Record 后，可以通过 continuity 继承此前已经获得的知识。

### 3.2 认知方向

每条 Conclusion 同时保存：

- `observer_continuity_id`：谁持有这条认知；
- `observed_entity_key`：这条认知描述谁或什么；
- 来源 Observation 与 Record；
- 发生游标与可用游标；
- 保真度、关键词、向量和来源元数据。

这对应 Honcho 的 observer/observed 表征，但必须受 REALM 的角色知识和世界时间约束。

### 3.3 召回顺序

1. 从服务端确定 Workspace、World、Worldline、Record 和 CharacterInstance；请求不得覆盖。
2. 解析 Character continuity 和当前 Record head，建立有效知识游标。
3. 只读取同 continuity 且 `available_from <= effective_cursor` 的 Conclusion。
4. 排除被 UPDATE 或 RETRACT 结论取代的旧结论。
5. 在合法候选集上融合关键词、向量、保真度和近因分数。
6. 将紧凑结果注入 Character Runner 的动态提示，不写入稳定前缀。

### 3.4 当前嵌入

第一版使用本机、确定性、384 维 `realm-lexical-v1` 嵌入，以便在不增加第二个外部供应商的情况下验证 pgvector 契约、索引和混合排序。`EmbeddingProvider` 是独立端口；之后可替换为真正的多语言语义嵌入模型，同时保留同一权限和时间过滤顺序。

## 4. 后续批次

- 异步 LLM 推断结论与自动矛盾合并；
- 世界实体图谱和角色间认知表征；
- 用户可审阅的 Memory 面板；
- 记忆质量、时间问答和秘密泄露 Evals。

## 5. 参考

- [LM Studio OpenAI Compatibility API](https://lmstudio.ai/docs/developer/openai-compat)（`/v1/models`、`/v1/chat/completions`）
- [OpenRouter Models API](https://openrouter.ai/docs/api-reference/models/get-models)（模型目录、pricing、能力元数据）
- [OpenRouter API Reference](https://openrouter.ai/docs/api-reference/overview)（Chat Completions、tools、structured outputs）
- [mem0](https://github.com/mem0ai/mem0)
- [mem0 Graph Memory](https://docs.mem0.ai/platform/features/graph-memory)
- [Honcho](https://github.com/plastic-labs/honcho)
