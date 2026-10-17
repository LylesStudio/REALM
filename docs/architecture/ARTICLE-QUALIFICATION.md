# 文章资格与导入身份契约

此契约描述 PostgreSQL 运行行为；内部阶段任务书不是安装或运行测试的依赖。实际结构来自 `0041_article_qualification_and_import_entries.sql`，执行行为另有 schema、路由与 PostgreSQL 测试验证。

## 迁移与事务

迁移 runner 使用 per-file transaction：在一个事务中执行单文件 SQL 并写入 checksum 台账，失败整体回滚；已有 migration 的 checksum 不一致时 fail-closed。SQL 文件本身不另开 BEGIN/COMMIT。只对 disposable 测试库或明确授权的部署库执行，不能因运行测试而写入共享 `realm_dev`。

## 资格账本

`article_qualifications` 是 append-only 事件账本。最新 seq 决定当前资格，qualified_public 当前要求 owner_attest，并绑定具体 article 内容 hash；模型、文件名或 content hash 自身均不是授权。工作区 RLS、作用域复合外键、非负游标以及最小 runtime grant 独立约束这些行为。

`available_from_tick` 与 `available_from_ordinal` 共同组成可见性起点，不可只比较 tick。资格变更按 worldline → article 的固定顺序持锁，然后分配 seq 并追加记录；撤销追加 revoked，而不是修改旧历史。重新授权产生新起点。

## 精确文件身份

`article_import_entries` 只支持 file_exact：`source_namespace = bundle_content_hash`，stable_entry_identity 为文件内 entry ordinal。整文件 hash、规范化 entry 内容 hash、绑定具体 article 行的资格内容 hash 各司其职，不可互换。文件名、keys 或 bundle 内可选 uid 不承担跨上传身份。

一个 bundle 的导入在同一事务内进行；每个 entry 使用 SAVEPOINT。唯一键冲突时回滚该 entry 的 candidate article 与 pending qualification，再读取既有 entry 比较内容 hash，避免遗留孤儿；真正错误使整批回滚。该能力不声称支持跨文件更新识别。

## 进入模型上下文的边界

候选文章必须同 worldline、最新状态为 qualified_public、来源为 owner_attest、hash 与当前数据库内容一致、Record head 不早于 available-from tuple，且同时通过 claim 与预算过滤。缺资格记录或必要扩展不可用时 fail-closed；撤销后不能继续注入。GET、SSE 和模型消费者各自保持授权检查，任何模型输出都不能代替 owner 的授权。
