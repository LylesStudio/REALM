import { defineConfig } from "@playwright/test";

/**
 * GUI 交互测试配置（见 docs/development/GUI-TEST-PLAN.md）。
 *
 * 运行前提：
 * - 应用 dev server 已监听 http://127.0.0.1:9999
 *   （`npx vinext dev --hostname 127.0.0.1`，不要跑 `npm run dev`）；
 *   若未运行，webServer 会以此命令自动拉起并复用已运行的实例。
 * - PostgreSQL 由 docker 容器 realm-pg17 提供（127.0.0.1:55432）。
 *
 * 运行方式：
 * - 全部浏览器：`npx playwright test`
 * - 仅 Chromium：`npx playwright test --project=chromium`
 * - 仅 WebKit（Safari 引擎近似）：`npx playwright test --project=webkit`
 *
 * WebKit 说明：本机为 Arch Linux，Playwright 官方不支持，WebKit 运行
 * 所需的 libxml2.so.2 / libicu74 / libflite 已从 Ubuntu 24.04 官方仓库
 * 提取到 ~/.cache/webkit-deps 并软链进 Playwright WebKit 的 sys/lib，
 * 属于本机浏览器运行环境补丁，不进入仓库。
 */
export default defineConfig({
  testDir: "./tests/gui",
  globalSetup: "./tests/gui/global-setup.ts",
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: ".playwright/output",
  use: {
    locale: "zh-CN",
    // 本机 dev server 的绑定地址由 systemd 服务管理；默认回环，
    // 服务绑定其他本机网卡时用 GUI_BASE_URL 指向实际地址。
    baseURL: process.env.GUI_BASE_URL ?? (process.env.HOST_BIND ? `http://${process.env.HOST_BIND}:9999` : "http://127.0.0.1:9999"),
    storageState: ".playwright/auth-state.json",
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
    {
      name: "webkit",
      use: { browserName: "webkit" },
    },
  ],
  webServer: {
    command: "node scripts/dev-server.mjs dev",
    url: process.env.GUI_BASE_URL ?? (process.env.HOST_BIND ? `http://${process.env.HOST_BIND}:9999` : "http://127.0.0.1:9999"),
    reuseExistingServer: true,
    timeout: 180_000,
  },
});
