import { expect, test } from "@playwright/test";
import { FAKE_PROVIDER_MODEL } from "../helpers/fake-openai-provider.mjs";

/**
 * F 组模型设置（默认离线确定性版）：scratch runner 通过 custom-openai
 * profile 指向 loopback fake provider（REALM_MODEL_* 显式注入，不读宿主配置）。
 * OpenRouter 真实供应商用例移至 f-real-provider-smoke.spec.ts（显式
 * REALM_ENABLE_REAL_PROVIDER_SMOKE=1 门禁，默认跳过）。
 */
test.describe("F. 模型设置页（离线 fake provider）", () => {
  test("F1 基本信息：custom-openai profile 指向 loopback fake，密钥不回显", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    const provider = page.locator("label", { hasText: "模型供应商" }).locator("select");
    await expect(provider).toHaveValue("custom-openai");
    await expect(provider).toContainText("LM Studio");
    await expect(provider).toContainText("OpenRouter");

    const baseUrlInput = page.locator("label", { hasText: "API Base URL" }).locator("input");
    await expect(baseUrlInput).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    await expect(page.locator(".provider-health")).toBeVisible();
    // 密钥不回显到浏览器输入框（placeholder 定位避免命中 ComfyUI 卡的同名 label）。
    const keyInput = page.locator('input[placeholder="输入供应商 API key"]');
    await expect(keyInput).toHaveValue("");
    await expect(page.locator("label", { hasText: "返回长度预算" }).locator("select"))
      .toHaveValue("2048");
  });

  test("F2 模型发现：fake /v1/models 返回确定模型", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "连接端点并发现模型" }).click();
    const modelList = page.locator(".model-list");
    await expect(modelList).toContainText(FAKE_PROVIDER_MODEL, { timeout: 30_000 });
    await expect(page.locator(".settings-notice.is-success")).toContainText("已发现");
    await page.getByRole("button", { name: "查询当前费率" }).click();
    await expect(page.locator('[data-testid="model-billing"]')).toContainText("费率未知", { timeout: 30_000 });
  });

  test("F3 连接测试：fake 探针返回成功", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "测试所选模型" }).click();
    await expect(page.locator(".settings-notice.is-success")).toContainText(
      "连接正常",
      { timeout: 30_000 },
    );
  });

  test("F5 数据边界说明：最小发送与保护数据清单", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    const boundary = page.locator(".settings-data-card");
    await expect(boundary).toContainText("会发送");
    await expect(boundary).toContainText("不会发送");
    await expect(boundary).toContainText("最小世界规则与当前场景");
    await expect(boundary).toContainText("API Key、数据库连接与本机路径");
  });

  test("F6 桌面端设置页：内容超出窗口时由设置页自身滚动", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    const metrics = await page.locator(".settings-shell").evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowY: getComputedStyle(element).overflowY,
      viewportHeight: window.innerHeight,
    }));
    expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.viewportHeight);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(metrics.overflowY).toBe("auto");

    await page.locator(".settings-shell").evaluate((element) => element.scrollTo({ top: 9999 }));
    await expect.poll(async () => page.locator(".settings-shell").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });
});
