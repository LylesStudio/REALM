# Changelog

本文件记录公开版本的重要变化。尚未发布的内容放在 `[Unreleased]`。

## [Unreleased]

## [1.1.1] - 2026-10-18

### Fixed

- 控制台重启时复用同一托管 PostgreSQL 集群的实际监听端口，避免 Windows 停服后数据库仍在运行、启动器另选空闲端口而造成连接拒绝。复用须验证数据目录、PID/端口格式及 `pg_ctl status`；新安装仍选择可用端口。

## [1.1.0] - 2026-10-18

### Added

- Record 独立的 fixed/evolving Goal：AI 或人工创世、创建、修订、撤回、按正式证据评估，以及有版本和后继关系的自动演化。
- Goal 与 narrative situation 的有界公开上下文、运行状态展示，以及 `.realm` 存档恢复和独立分支中的完整历史继承。
- 生成状态提示：显示角色正在思考、旁白、导演规划、审核、场景整理及排队/开场任务；私密阶段按当前读者权限隐藏细节。
- 后台忙或状态未知时保留可编辑草稿并阻止发送，恢复后刷新记录和提交凭据，减少过早提交后重新输入的问题。
- 创世角色姓名与账号昵称解耦：显式姓名用于世界内身份、开场上下文和玩家发言，同世界后续记录延续当前账号拥有的角色名；不回写账号昵称或旧事件。

### Fixed

- 空 Record 第一轮正式叙事的 head ordinal 归一化，避免负游标导致合法 narrative proposal 被拒绝。
- public 干净安装的文档和静态契约依赖：公开契约与通用模板独立于内部任务书和本机运维配置。
- 相邻 GUI 回归按既有 `202` 异步受理协议等待正式事件，不把已受理的请求当失败重复提交。
- PostgreSQL 隔离测试在拆库前等待连接实际关闭，修复 Node 22 上偶发的 `57P01` 清理竞态；生产连接池策略不变。

### Verification scope

- 代码门禁、隔离 PostgreSQL 与确定性 Chromium/WebKit 回归通过；此前 Record Goal 的真实模型、已安装验签受控 RealmWorld 与恢复/分支验收保留在维护证据中。
- 本次为源码发行，不附带新的预构建桌面安装器。目标设备部署与平台验证另行记录，不将隔离测试扩大为所有平台安装验收。

## [0.4.9] - 2026-10-02

### Fixed

- 为公开发布前 snapshot `53e9f5a0b0eafca24659bf877f27c205912250ab` 的 15 条 comment-only migration 同时加入精确 LF 与 CRLF 历史 checksum；macOS/Linux 与 Windows 旧 ledger 均可只收敛 ledger，不重放 SQL。
- 为 `0014`、`0015` 的已验证历史版本补充 LF checksum，保留幂等重放当前 SQL 与精确 hash 白名单。
- 未知内容漂移仍一次性 inventory 并 fail-closed，不因平台或换行格式自动放行。

## [0.4.8] - 2026-10-02

### Fixed

- 识别公开发布前 snapshot `53e9f5a0b0eafca24659bf877f27c205912250ab` 中 15 条已应用 migration 的精确 CRLF checksum；这些历史版本只改了文档注释，升级时只收敛 ledger，不重放 SQL。
- 未知内容漂移仍一次性 inventory 并 fail-closed；兼容清单只在当前 SQL checksum 与已验证版本完全匹配时生效。

## [0.4.7] - 2026-10-02

### Fixed

- migration runner 在 fail-closed 之前先 inventory 所有已应用但未识别的 checksum mismatch，避免旧数据库升级时每次只暴露一个文件。
- inventory 同时显示 stored、当前 LF 与当前 CRLF checksum；只读诊断不修改 ledger 或业务数据。

## [0.4.6] - 2026-10-02

### Fixed

- 兼容现有 Windows 数据库中 `0015_account_ui_language.sql` 的精确历史 checksum；升级时幂等重放当前语言字段、约束与权限定义，并将 ledger 收敛到当前 checksum。
- `0014` 与 `0015` 的历史兼容均限定为精确 hash，其他未知 migration checksum 继续 fail-closed。

## [0.4.5] - 2026-10-02

### Fixed

- 兼容公开发布前 Windows 安装留下的 `0014_scene_crystallization_grants.sql` 精确历史 checksum；升级时幂等重放当前授权 SQL，并将 ledger 收敛到当前 checksum。
- 其他未知 migration checksum 仍 fail-closed，不会被宽泛放行。

## [0.4.4] - 2026-10-02

### Fixed

- 将 Windows 旧 ledger 的 CRLF 兼容从单个 `0014` migration 扩展为所有 migration：只接受当前 SQL 的精确 CRLF checksum，任何实际内容漂移仍拒绝。

## [0.4.3] - 2026-10-02

### Fixed

- Windows 旧安装目录的 PostgreSQL migration ledger 若记录了 `0014` 的 CRLF checksum，升级时现在会按明确白名单兼容，不会误报迁移文件被修改。
- PostgreSQL migration checksum 统一按 LF 计算，避免 Windows 换行格式让后续升级再次产生跨平台漂移；未知 checksum 仍 fail-closed。
- migration checksum 错误现在同时报告已存储与当前 checksum，便于定位真实的历史漂移。

## [1.0.0] - 2026-10-11

### Added

- RealmWorld 生命周期、升级/降级与跨版本运行。
- Record 版本绑定、持久化 topology、幂等 instantiate/replay 与 fail-closed 回滚。
- 声明式 Goal runtime materialization、durable assessment enqueue、真实 semantic Judge provider。
- 统一 durable worker host。
- branch/fork/reconcile、restore 全量运行态。
- trust-store operator lifecycle。
- WebUI Bridge 生产接线。
- Local Record API Bridge v1。
- base provider 统一内容层及 nested fail-closed correction。
- runtime-save v2 完整链路：action receipts、character effects、observations、memory、outbox、first-night、self-play 的 save/restore/replay。
- worldline merge 对 action receipts / character effects / observations 的完整物化。
- 真实 branch/fork → origin/branch 双线 run → merge back 生命周期独立验收。
- OpenRouter 与 LM Studio 真实 HTTP 网络验证。

### Security

- 接受 7 个 high severity npm audit advisory（`braces`/`micromatch`/`fast-glob` 链）为已知风险。这些依赖只用于 lint/build 阶段，默认 self-hosted 单用户场景下没有远程可触发路径；上游 `braces` 目前无修复版本，强制降级反而可能破坏构建。

## [0.5.0] - 2026-10-04

### Added

- API 配置页可查询当前选定模型的供应商费率，并展示输入/输出价格。
- 供应商未返回费率、模型不存在或响应无法识别时明确显示“费率未知”，不会猜测为免费或 `$0`。
- 计费查询支持未保存的草稿配置，且响应只返回脱敏后的当前模型计费快照。

## [0.4.1] - 2026-10-01

### Fixed

- macOS 安装命令不再静默挂起：下载步骤增加进度条、超时与明确日志。
- Windows 升级失败 `Cannot find module 'npm-prefix.js'`：安装前显式清理旧 `node_modules`，避免损坏的本地 npm 被复用。
- 嵌入式 PostgreSQL 版本解析：从 releases 列表查找 `embedded-pg-*` tag，而不是误把代码 release 当作 PG release。

## [0.4.0] - 2026-10-01

### Added

- 引导式创世（Guided Genesis）与 onboarding 旅程完整闭环。
- 世界库预设世界入口与一键创建。
- 角色在场（presence）回合外自主发声。
- 大厅（lobby）房间、邀请链接与世界绑定。
- 场景图自动生成队列与确定性离线 fixture。
- 身份/operator 门禁、session proof 与 capability 安全边界。

### Changed

- 大量 GUI 旅程契约测试与 fake provider 阶段注册表对齐。
- 改进世界管理、归档/删除与信息密度体验。

### Fixed

- onboarding S3/S4 selector 与 observer 只读姿态测试流。
- genesis-entry fallback payload 传递不变式。
- 角色在场标记在 fake provider 新建记录下的实例 id 解析。

## [0.1.0] - 2026-09-06

### Added

- 可恢复 Turn Core、Record 单写入和 append-only Event 提交链。
- DM、Narrator、Character Runner、规则事务、骰点、presence 和 self-play。
- 多 NPC participant ID 与结构化 `recipientId`，用于明确对话目标。
- 提交后异步 Character Memory、场景结晶、世界知识和人物设定自然生长。
- PostgreSQL + pgvector 权威存储、RLS、最小权限和安全可见性投影。
- World / Story / Record 管理、知识图谱、Canon 审核以及 `.realm` 导出/导入。
- 多供应商模型设置、结构化输出容错和本地开发测试基建。

### Known limitations

- 当前仍定位为 self-hosted single-user / research preview。
- 公网多人身份、邀请治理、限流、费用控制和长期运营尚未完成。
- 当前默认开发运行时依赖本地 PostgreSQL；公开服务器部署方案尚未定稿。
- 真实模型供应商需要运行者自行配置，仓库不提供模型或凭据。
