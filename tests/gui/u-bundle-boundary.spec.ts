import { expect, test } from "@playwright/test";

/**
 * Client/Server 模块边界修复的冒烟：首页（含 genesis 引导组件树）加载
 * 不得产生 pageerror——历史根因是 client bundle 可达 local-settings.ts
 * 的 node:fs/promises（Vite externalize 后运行时报错）。
 */
test("home page loads without pageerror (client bundle boundary)", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/");
  // 登录墙或应用壳任一出现都算加载成功；关键是零 pageerror。
  await expect(page.locator("body")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
  // 设置页同样走模型设置 UI（model settings service 的 server 边界）。
  await page.goto("/settings");
  await expect(page.locator("body")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});
