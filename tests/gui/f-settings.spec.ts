import { expect, test } from "@playwright/test";

/**
 * F 组模型设置：多供应商 profile + OpenRouter 当前模型费率。
 * 当前开发环境将 OpenRouter 免费模型设为 active，LM Studio profile 仍保留可切换。
 */
test.describe("F. 模型设置页", () => {
  test("F1 基本信息：两个供应商 profile 与 OpenRouter 端点状态", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    const provider = page.locator("label", { hasText: "模型供应商" }).locator("select");
    await expect(provider).toHaveValue("openrouter");
    await expect(provider.locator("option")).toHaveCount(2);
    await expect(provider).toContainText("LM Studio");
    await expect(provider).toContainText("OpenRouter");

    const baseUrlInput = page.locator("label", { hasText: "API Base URL" }).locator("input");
    await expect(baseUrlInput).toHaveValue("https://openrouter.ai/api/v1");
    await expect(page.locator(".provider-health")).toContainText("OpenRouter 已配置");
    // 密钥不回显到浏览器输入框，只显示服务端提供的尾号 hint。
    const keyInput = page.locator("label", { hasText: "API Key" }).locator("input");
    await expect(keyInput).toHaveValue("");
    await expect(page.locator("label", { hasText: "API Key" })).toContainText("已配置");
    await expect(page.locator("label", { hasText: "返回长度预算" }).locator("select"))
      .toHaveValue("2048");
  });

  test("F2 模型发现：返回模型、免费标记与当前费率", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "连接端点并发现模型" }).click();
    const modelList = page.locator(".model-list");
    await expect(modelList.locator("label")).toHaveCount(20, { timeout: 90_000 });
    await expect(modelList).toContainText("当前免费", { timeout: 90_000 });
    await expect(modelList).toContainText("每 1M token");
    const search = page.getByLabel("检索模型");
    await search.fill("Ox Alpha");
    await expect(modelList.locator("label")).toHaveCount(1);
    await expect(modelList).toContainText("Ox Alpha");
    await search.fill("");
    await page.getByRole("button", { name: "仅看免费" }).click();
    await expect(page.locator(".model-list-pager")).toContainText("共 22 个");
    await expect(page.locator(".settings-notice.is-success")).toContainText("已发现");
  });

  test("F3 模型选择：优先选中兼容 REALM 的免费模型", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "连接端点并发现模型" }).click();
    const selected = page.locator(".model-list label.is-selected");
    await expect(selected).toContainText("FREE", { timeout: 90_000 });
    await expect(selected).toContainText("TOOLS");

    const thinking = page.locator("label", { hasText: "思考模式" }).locator("select");
    await expect(thinking).toHaveValue(/^(enabled|disabled)$/);
    await expect(page.locator("label", { hasText: "返回长度预算" }).locator("select"))
      .toHaveValue("2048");
  });

  test("F4 连接测试：真实 OpenRouter 免费模型返回成功", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "测试所选模型" }).click();
    await expect(page.locator(".settings-notice.is-success")).toContainText(
      "连接正常",
      { timeout: 120_000 },
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
    await expect(boundary).toContainText("最小必要上下文发送到 OpenRouter");
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
