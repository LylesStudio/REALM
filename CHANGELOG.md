# Changelog

本文件记录公开版本的重要变化。尚未发布的内容放在 `[Unreleased]`。

## [Unreleased]

## [0.3.1] - 2026-09-21

### Fixed

- 修复预设世界初始内容语言未稳定继承的问题：预设创建现在按界面/系统语言选择 `zh-CN`、`en` 或 `ja` 草案，并将内容语言写入世界设置。
- 修复 anime 文风可能诱导世界自演、初夜和角色生成输出日语的问题；模型链明确接收 configured language，文风不再决定语种。
- 修复自由创世对谈的语言上下文传递，并保留玩家本轮输入语言优先的规则。
- 修复世界库与引导屏预设卡片在窄屏和长文案下的拥挤布局，统一间距、卡片高度、换行和移动端单列行为。

### Changed

- Playwright GUI 验收固定使用 `zh-CN` locale，避免宿主浏览器语言导致断言漂移。
- 增加预设三语草案、世界语言持久化、运行时提示链和 configured language 回归测试。

## [0.3.0] - 2026-09-21

### Added

- 三个一键可玩预设世界：标准 DND「遗忘酒馆」、二次元勇者「魔王城前的村庄」、中式都市轻小说「灵气复苏的咖啡馆」。
- 世界引导屏与世界库面板新增「预设世界」入口，点击后直接创建并进入首个记录。
- `scripts/configure-comfyui-workflow.mjs`：检测并指引用户补全 Anima 工作流所需模型（UNet/CLIP/VAE），支持自定义 manifest 与 ComfyUI 目录。

### Changed

- `LibraryCreateCommand` 扩展 `kind: "preset-world"`，复用现有创世事务创建完整世界、故事、记录与开场。
- i18n 新增预设世界相关键，覆盖 zh-CN / en / ja 三语。

## [0.2.0] - 2026-09-21

### Added

- 实时场景图生成：本地 ComfyUI T2I/I2I workflow、视觉风格 profile、数据到 prompt 的装配。
- 场景图自动生成模式：记录场景状态变化时异步排队生成，Worker 单实例锁与跨平台宿主。
- 场景图存储与记录页背景渲染，支持手动重绘。
- 账户名 + 可选 scrypt 密码登录，退役 LAN access token 要求。
- ComfyUI 连接与场景图设置面板。

### Changed

- 启动器、服务宿主与设置面板适配新的身份与场景图 Worker 入口。
- 安装与配置文档同步到新的认证与生成能力边界。

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
