# 界核 / REALM GUI 交互测试

对应测试设计见 [`docs/development/GUI-TEST-PLAN.md`](../../docs/development/GUI-TEST-PLAN.md)。当前仓库有基础 A–J 旅程以及 N–Z 扩展交互；文件清单以 `tests/gui/*.spec.ts` 为准，执行范围必须看本次 runner 的真实结果，不能用枚举数量代替通过证据。

## 运行前提

1. 安装 Docker、Node 运行依赖以及 Playwright Chromium/WebKit 浏览器。
2. GUI 测试一律通过仓库隔离 runner 运行；runner 会创建临时 PostgreSQL 集群、跑完整迁移与 demo seed、启动独立 Web 服务，并创建单独的 auth/output state。
3. runner 不读取 `.env.local` 或已有模型设置；**默认离线确定性**：runner 在应用启动前拉起 `tests/helpers/fake-openai-provider.mjs`（loopback 临时端口，阶段注册表指纹分发固定 fixture，未知阶段 fail-closed 422），并向被测应用显式注入 `REALM_MODEL_PROVIDER=custom-openai` + loopback `/v1` + 确定模型 id + 空 key。真实 OpenRouter 验收在 `f-real-provider-smoke.spec.ts`，仅 `REALM_ENABLE_REAL_PROVIDER_SMOKE=1` 时运行（默认跳过）。注意 fake 注册表的覆盖边界：司卷对谈（genesis-chat）与初夜（first-night，characters 从请求同行者名单 derive）已注册；记忆萃取是纯 SQL 管线（无模型调用，无需阶段）；行动建议来自旁白响应（无需单独阶段）。创世手稿（world-genesis）与分步代笔（genesis-suggestions，按生产 [Task for this step] 七步分发，未知任务 fail-closed）已注册，`n-guided-genesis` N3 走真实 route→gateway→fixture→normalizer 链路。仍未注册的阶段：技能证据生成（仅在 use_skill 工具调用时触发，默认旅程不触发）。依赖未注册阶段的用例在默认套件中的状态须以实跑为准，不得预设通过。
4. Docker 不可用、数据库身份探针不符或独立服务无法启动时，测试应 fail-closed；不得回退到共享 `realm_dev` 或常驻 `realm-dev.service`。

## 运行方式

```bash
# Chromium 全部 GUI 用例，使用 disposable PostgreSQL + 独立服务
node scripts/test-gui-with-scratch.mjs --project=chromium

# WebKit（Safari 引擎近似）
node scripts/test-gui-with-scratch.mjs --project=webkit

# 聚焦单组旅程；Playwright CLI 参数原样透传
node scripts/test-gui-with-scratch.mjs --project=chromium --grep 'N1 全程引导|N5 世界落笔失败'

# 浏览器测试列表（仅枚举，不代表已执行）
npx playwright test --list
```

不要直接运行会写数据库的 `npx playwright test`；此命令会读取标准 Playwright 配置，可能指向共享开发服务/数据库。

## 用例文件

| 分组 | 代表文件 | 覆盖 |
|---|---|---|
| A–J 基础旅程 | `a-library` … `j-webkit` | 世界库、记录、行动、可见性、记忆、设置、实时同步、响应式、设计语言与 WebKit |
| K–S 产品扩展 | `k-graph`、`l-genesis`、`m-scene-crystallization`、`n-guided-genesis`、`o-action-suggestions`、`p-world-style`、`q-i18n`、`r-tavern-import`、`s-onboarding` | 图谱/Canon、创世、结晶、提案、文风、多语言、导入与 onboarding |
| T1–T12 迭代 | `t1-first-night`、`t2-memory-pipeline` … `t12-views` | 初夜、记忆、角色/规则、骰子、导入、观察、管理员、Canon、受众与视图 |
| U–Z 状态与扩展 | `u-bundle-boundary`、`v-branch`、`w-adaptive`、`x-theme`、`y-lobby`、`z-*` | bundle 边界、分支、适配、主题、大厅与邀请/租约/场景图片 |

完整枚举（当前 49 个 spec 文件，不代表 49 个都已执行）：

```bash
rg --files tests/gui -g '*.spec.ts' | sort
```

## 测试数据隔离

- 写入型 GUI 只在本次 disposable PostgreSQL 中运行；`uniqueName()` 仅避免单次运行内重名，不提供数据库隔离。
- 演示记录 `record_first_watch` 只存在于本次 scratch seed，不能据此声称访问或验证过共享开发库。
- runner 完成时应销毁临时容器、独立服务和临时目录；测试后另查无残留，不执行共享库清理脚本。

## WebKit 环境说明（Arch Linux）

本机为 Arch Linux，Playwright 官方不直接支持。WebKit 运行所需的
`libxml2.so.2` / `libicu74` / `libflite` 已从 Ubuntu 24.04 官方仓库提取到
`~/.cache/webkit-deps` 并软链进 `~/.cache/ms-playwright/webkit-*/minibrowser-{gtk,wpe}/sys/lib`。
这是本机浏览器运行环境补丁，不属于仓库内容；在受支持的系统（macOS / Ubuntu）上无需此步骤。

## 失败排查

- 截图与 trace 输出位于 runner 临时目录，默认在结束清理；当前没有保留开关。若验收需要留证，应单独设计显式 retention 选项，并确认不包含凭据或登录状态。
- 默认套件走 loopback fake provider（custom-openai profile）；fake 注册表未覆盖的模型阶段会 fail-closed 422——遇到依赖模型用例失败时先核对阶段注册表覆盖，再分类。z7 场景图闭环用进程内 loopback fake ComfyUI（`tests/helpers/scene-image-fixture.mjs`），不触真实 ComfyUI。F7 operator 正向 journey 仅在 runner 精确目标 `f-comfyui-operator.spec.ts` 时运行（fixture 注入），全量运行时具名跳过、负向 403 journey 照常。
- **基线运行（修复前）**：2026-09-27 Chromium 全量执行 124 项，69 passed、55 failed、0 skipped，退出码 1。失败同时含 provider 前置、断言漂移和测试隔离缺口；这不是当前修复后的全量结果。
- **最新聚焦运行**：修复后同一 disposable PG 的确定性 Chromium 与 WebKit 子集各 17/17 passed、退出码 0；另 WebKit z2 双身份邀请旅程 1/1 通过。完整 provider-dependent suite、真实 ComfyUI 生成和 WebKit 全 suite 仍未验收。
- 对任何隔离的 provider-independent 用例，先查 Playwright trace、page errors 和响应，再分类。不得把缺失模型配置当作 locator/count、lobby 或 scene-image 失败的解释。
