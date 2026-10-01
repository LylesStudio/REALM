import { defineConfig } from "@playwright/test";

const listingOnly = process.argv.some((arg) => ["--list", "--help", "-h"].includes(arg));
if (!listingOnly) {
  const baseUrl = new URL(process.env.GUI_BASE_URL ?? "http://127.0.0.1:9999");
  const isolatedRun = process.env.REALM_GUI_SCRATCH === "1"
    && baseUrl.hostname === "127.0.0.1"
    && Boolean(baseUrl.port)
    && baseUrl.port !== "9999"
    && Boolean(process.env.GUI_AUTH_STATE_PATH)
    && Boolean(process.env.GUI_OUTPUT_DIR);
  if (!isolatedRun) {
    throw new Error(
      "Write-capable GUI tests require scripts/test-gui-with-scratch.mjs; direct Playwright runs are refused.",
    );
  }
}

/**
 * GUI 交互测试配置：写入型运行只允许经隔离 runner 启动，避免碰到共享 realm_dev。
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
  outputDir: process.env.GUI_OUTPUT_DIR ?? ".playwright/output",
  use: {
    locale: "zh-CN",
    // 本机 dev server 的绑定地址由 systemd 服务管理；默认回环，
    // 服务绑定其他本机网卡时用 GUI_BASE_URL 指向实际地址。
    baseURL: process.env.GUI_BASE_URL ?? (process.env.HOST_BIND ? `http://${process.env.HOST_BIND}:9999` : "http://127.0.0.1:9999"),
    storageState: process.env.GUI_AUTH_STATE_PATH ?? ".playwright/auth-state.json",
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
