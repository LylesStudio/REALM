import { expect, test } from "@playwright/test";

/**
 * 真实 provider smoke（OpenRouter）——显式 opt-in，默认跳过。
 *
 * 运行前提（缺任一即拒绝/跳过，绝不打印任何值）：
 *   REALM_ENABLE_REAL_PROVIDER_SMOKE=1 + 宿主环境提供 REALM_MODEL_PROVIDER
 *   等供应商变量（runner 只在该模式下透传宿主模型环境）。
 *   npm run test:gui:smoke:real-provider
 *
 * 本文件不计入默认 GUI 回归与 npm test；断言依赖 OpenRouter 当前目录/
 * 费率，属于会漂移的供应商契约，失败必须先区分供应商变化与产品回归。
 */
const REAL_SMOKE = process.env.REALM_ENABLE_REAL_PROVIDER_SMOKE === "1";

test.describe("F-smoke. 真实 OpenRouter 设置页（gated）", () => {
  test.skip(!REAL_SMOKE, "真实 provider smoke 需 REALM_ENABLE_REAL_PROVIDER_SMOKE=1");

  test("S1 基本信息：OpenRouter profile 与端点状态", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    const provider = page.locator("label", { hasText: "模型供应商" }).locator("select");
    await expect(provider).toHaveValue("openrouter");
    const baseUrlInput = page.locator("label", { hasText: "API Base URL" }).locator("input");
    await expect(baseUrlInput).toHaveValue("https://openrouter.ai/api/v1");
    await expect(page.locator(".provider-health")).toContainText("OpenRouter 已配置");
    const keyInput = page.locator("label", { hasText: "API Key" }).locator("input");
    await expect(keyInput).toHaveValue("");
    await expect(page.locator("label", { hasText: "API Key" })).toContainText("已配置");
  });

  test("S2 模型发现：返回模型、免费标记与费率", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "连接端点并发现模型" }).click();
    const modelList = page.locator(".model-list");
    await expect(modelList.locator("label").first()).toBeVisible({ timeout: 90_000 });
    await expect(modelList).toContainText("每 1M token");
    await expect(page.locator(".settings-notice.is-success")).toContainText("已发现");
  });

  test("S3 连接测试：真实模型返回成功", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "测试所选模型" }).click();
    await expect(page.locator(".settings-notice.is-success")).toContainText(
      "连接正常",
      { timeout: 120_000 },
    );
  });
});
