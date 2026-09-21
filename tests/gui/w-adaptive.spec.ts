import { expect, test, type Page } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * 自适应验收（W 批次）：375/412/768/1024/1440 五档 viewport，
 * 主路径（Record / World / Story / Library / 分支树 / 登录）无横向溢出、
 * 关键交互元素可见可用（键盘可达）。隔离 server + 一次性 PG 运行。
 */

const VIEWPORTS = [
  { name: "375", width: 375, height: 720 },
  { name: "412", width: 412, height: 860 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
] as const;

async function expectNoHorizontalOverflow(page: Page, label: string) {
  // 允许 1px 取整误差；不得出现横向滚动。
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, `${label}: horizontal overflow`).toBeLessThanOrEqual(1);
  const bodyOverflow = await page.evaluate(
    () => document.body.scrollWidth - window.innerWidth,
  );
  expect(bodyOverflow, `${label}: body horizontal overflow`).toBeLessThanOrEqual(1);
}

for (const viewport of VIEWPORTS) {
  test.describe(`viewport ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`record/world/story/library/branch-tree no overflow @${viewport.name}`, async ({ page }) => {
      await openDemoRecord(page);
      await expectNoHorizontalOverflow(page, `record@${viewport.name}`);
      // 键盘可达：输入框可聚焦输入（不提交，避免写数据）。
      const composer = page.locator("#realm-message");
      await composer.focus();
      await expect(composer).toBeFocused();

      // World 视图。
      await page.getByRole("button", { name: "打开世界视图" }).click();
      await expect(page.locator('[data-view="world"]')).toBeVisible();
      await expectNoHorizontalOverflow(page, `world@${viewport.name}`);

      // Story 视图。
      await page.getByRole("button", { name: "打开故事视图" }).click();
      await expect(page.locator('[data-view="story"]')).toBeVisible();
      await expectNoHorizontalOverflow(page, `story@${viewport.name}`);

      // Library overlay。
      await page.getByRole("button", { name: "世界库" }).click();
      await expect(page.locator(".library-panel")).toBeVisible();
      await expectNoHorizontalOverflow(page, `library@${viewport.name}`);
      await page.keyboard.press("Escape");
      // Library 可能不用 Escape 关闭；用关闭按钮兜底。
      if (await page.locator(".library-panel").isVisible()) {
        await page.getByRole("button", { name: "关闭世界库" }).click();
      }
      await expect(page.locator(".library-panel")).toBeHidden();

      // 分支树 overlay（World 视图入口）。
      await page.getByRole("button", { name: "打开世界视图" }).click();
      await page.locator('[data-view="world"]').getByRole("button", { name: "分支树" }).click();
      const panel = page.locator('[data-testid="branch-tree-panel"]');
      await expect(panel).toBeVisible();
      await expect(panel.locator(".branch-tree")).toBeVisible({ timeout: 30_000 });
      await expectNoHorizontalOverflow(page, `branch-tree@${viewport.name}`);
      // 树节点键盘可达。
      await panel.getByRole("treeitem").first().focus();
      await expect(panel.getByRole("treeitem").first()).toBeFocused();
    });
  });
}

test("login page fits 375px without overflow", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 375, height: 720 },
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto("/");
  // 门禁启用时展示登录表单；未启用时进引导/记录——两种形态都不得溢出。
  await page.waitForLoadState("networkidle");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, "login@375: horizontal overflow").toBeLessThanOrEqual(1);
  await context.close();
});
