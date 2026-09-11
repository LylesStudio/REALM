# Contributing to REALM

感谢你对 REALM 的兴趣。

REALM 是一个仍在快速演进中的多人叙事角色运行时。当前公开版本定位为
**self-hosted single-user / research preview**：核心回合、角色编排、持久化记忆和世界知识已经具备，但公网多人身份、容量和长期运营仍未承诺。

## 开始之前

1. 阅读 [README.md](./README.md) 了解运行边界。
2. 阅读 [LICENSE](./LICENSE) 和 [SECURITY.md](./SECURITY.md)。
3. 涉及较大行为变化时，先在 Issue 中说明目标、影响范围和验证方式。
4. 不要把真实用户输入、生产数据库、访问令牌、模型密钥、内部地址或运行日志提交到仓库。

## 本地验证

要求 Node.js 22.13+、PostgreSQL 17 + pgvector，以及 Docker（PostgreSQL 集成测试使用一次性 scratch cluster）。

```bash
npm ci
cp .env.example .env.local
npm test
npm run lint
git diff --check
```

`npm test` 包含类型检查、Core、应用、前端契约、隔离 PostgreSQL、构建与渲染验证。
如果只修改纯逻辑，可以先运行对应的 focused test，再运行完整检查。

## 代码和提交

- 保持 Record 单写入、Event append-only、RLS、visibility/audience 和现有最小权限边界。
- 新行为先补回归测试，再实现最小改动；不要为了让测试变绿而放宽业务契约。
- 变更保持小而聚焦；不要顺手重排无关文件。
- 使用 Conventional Commit 风格，例如 `feat: ...`、`fix: ...`、`docs: ...`。
- Pull Request 中说明：改了什么、为什么、测试命令及其原始结果、已知限制。

## 数据和测试隔离

测试不得写入共享生产或个人开发数据。数据库集成测试应使用项目提供的 scratch harness，测试结束后确认临时数据库已清理。

不要提交：

- `.env.local` 或任何真实配置；
- `.local/` 下的模型设置、备份、日志和数据库文件；
- `dist/`、`.next/`、`.vinext/`、测试截图或临时导出包；
- 真实世界、玩家、Feishu 或供应商数据。

## Pull Request 预期

维护者会重点检查：

- 是否越过现有授权/可见性边界；
- 是否把模型输出当成权限、骰点或历史事实；
- 是否增加了同步关键路径上的不必要等待；
- 是否有 focused、集成或静态回归；
- 文档是否如实说明了尚未支持的场景。
