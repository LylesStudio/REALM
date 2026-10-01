# Changelog

本文件记录公开版本的重要变化。尚未发布的内容放在 `[Unreleased]`。

## [Unreleased]

## [0.4.2] - 2026-10-01

### Fixed

- 重新运行 Windows 安装器时，codeload（无 `.git`）安装目录现在会刷新源码，不再冻结在首次下载的旧版本。
- Windows bootstrap 固定使用当前 Node 安装目录旁的 `npm.cmd`，绕过项目内损坏的 npm shim。
- 保留升级过程中的 `.env.local`、`.env.owner.local` 与 `.local/` 本地配置和数据。
- public staging 的内部 archive 审计在缺少私有 `docs/archive` 时显式跳过；public 文档布局测试不再要求私有 `AGENT.md`/`STATUS.md`，也不将这些被排除的内部链接误报为断链。

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
