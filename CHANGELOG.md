# Changelog

本文件记录公开版本的重要变化。尚未发布的内容放在 `[Unreleased]`。

## [Unreleased]

- 准备首个公开源码发布快照。
- 补齐公开安装、贡献、安全和数据边界文档。

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
