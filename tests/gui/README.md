# 界核 / REALM GUI 交互测试

GUI 目录包含可复现的 Playwright 用例；内部测试计划不随首发快照发布。

## 运行前提

1. 应用 dev server 监听 `http://127.0.0.1:9999`：
   `node scripts/dev-server.mjs dev`（**不要**跑 `npm run dev`，其 db bootstrap 依赖外部 PG）。
   若未运行，Playwright 的 `webServer` 会自动用该命令拉起；已运行则直接复用。
2. PostgreSQL 由 docker 容器 `realm-pg17` 提供（`127.0.0.1:55432`，库 `realm_dev`）。
3. 模型配置就绪：`.env.local`（LM Studio LAN 端点与 Gemma 模型）+ `.local/settings/model-provider.json`。
   提交类用例（B3/B4/C3/D1–D3/G1/G2 等）会触发真实模型回合（LAN LM Studio），单回合约 20–60 秒。
4. 浏览器：`npx playwright install chromium webkit`。

## 运行方式

```bash
# 全部用例（Chromium + WebKit 各跑一遍）
npx playwright test

# 仅 Chromium（主测）
npx playwright test --project=chromium

# 仅 WebKit（Safari 引擎近似，J 组重点）
npx playwright test --project=webkit

# 单文件 / 单用例
npx playwright test tests/gui/b-record.spec.ts --project=chromium
npx playwright test -g "B3"
```

## 用例文件

| 文件 | 用例 | 说明 |
|---|---|---|
| `a-library.spec.ts` | A1–A6 | 世界库：加载、创建世界/故事/记录、分支、timeline 标签 |
| `b-record.spec.ts` | B1–B7 | 记录页：时间线、语义段、提交、拆分、乐观发送、失败恢复、流式 |
| `c-actions.spec.ts` | C1–C4 | 行动面板：投影、预填、提交、过期行动 |
| `d-visibility.spec.ts` | D1–D4 | 可见性确认：密谋预判、仅目标可听、公开发送、取消 |
| `e-memory.spec.ts` | E1–E4 | 场景检查器：记忆卡片、三档深度、关系线索、整理摘要 |
| `f-settings.spec.ts` | F1–F5 | 模型设置页：信息、发现、think 开关、连接测试、数据边界 |
| `g-realtime.spec.ts` | G1–G2 | SSE 实时事件与断线回补 |
| `h-responsive.spec.ts` | H1–H3 | 桌面三栏 / 平板双栏 / 手机纵向 |
| `i-design.spec.ts` | I1–I3 | 纸墨设计语言：直角、语义色、硬阴影 |
| `j-webkit.spec.ts` | J1–J4 | Safari/WebKit 视口、滚动弹层、resize 与差异回归 |

## 测试数据隔离

- 创建型用例一律使用 `uniqueName()` 生成带时间戳的独立名称，不污染演示数据。
- 演示记录 `record_first_watch` 只做只读断言。

## WebKit 环境说明（Arch Linux）

本机为 Arch Linux，Playwright 官方不直接支持。WebKit 运行所需的
`libxml2.so.2` / `libicu74` / `libflite` 已从 Ubuntu 24.04 官方仓库提取到
`~/.cache/webkit-deps` 并软链进 `~/.cache/ms-playwright/webkit-*/minibrowser-{gtk,wpe}/sys/lib`。
这是本机浏览器运行环境补丁，不属于仓库内容；在受支持的系统（macOS / Ubuntu）上无需此步骤。

## 失败排查

- 截图与 trace 输出在 `.playwright/output/`（已加入 .gitignore）。
- 模型偶发失败不算 UI bug：提交类用例失败时先确认本地模型服务可用性
  （`F4 连接测试` 或设置页“测试所选模型”）。
