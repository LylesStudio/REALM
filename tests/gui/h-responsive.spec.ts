import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

test.describe("H. 响应式", () => {
  test("H1 桌面三栏：世界导航 | 记录主区 | 场景检查器", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDemoRecord(page);
    const nav = page.locator(".world-nav");
    const main = page.locator(".record-main");
    const inspector = page.locator(".scene-inspector");
    await expect(nav).toBeVisible();
    await expect(main).toBeVisible();
    await expect(inspector).toBeVisible();
    const navBox = (await nav.boundingBox())!;
    const mainBox = (await main.boundingBox())!;
    const inspectorBox = (await inspector.boundingBox())!;
    // 三栏横向排布。
    expect(navBox.x).toBeLessThan(mainBox.x);
    expect(mainBox.x + mainBox.width).toBeLessThanOrEqual(inspectorBox.x + 1);
    expect(Math.abs(navBox.y - mainBox.y)).toBeLessThan(2);
    expect(Math.abs(mainBox.y - inspectorBox.y)).toBeLessThan(2);
  });

  test("H2 平板双栏：导航 + 主记录，场景检查器移到主记录下方", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await openDemoRecord(page);
    const nav = page.locator(".world-nav");
    const main = page.locator(".record-main");
    const inspector = page.locator(".scene-inspector");
    await expect(nav).toBeVisible();
    await expect(main).toBeVisible();
    const navBox = (await nav.boundingBox())!;
    const mainBox = (await main.boundingBox())!;
    const inspectorBox = (await inspector.boundingBox())!;
    // 导航与主记录同排，检查器在主记录下方。
    expect(navBox.x).toBeLessThan(mainBox.x);
    expect(Math.abs(navBox.y - mainBox.y)).toBeLessThan(2);
    expect(inspectorBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
  });

  test("H3 手机纵向：纵向布局可用且无横向溢出", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await openDemoRecord(page);
    // 无横向溢出。
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth + 1);
    // 输入区与时间线可用。
    await expect(page.locator("#realm-message")).toBeVisible();
    await expect(page.locator(".event-timeline")).toBeVisible();
    await expect(page.getByRole("button", { name: "送出" })).toBeVisible();
    // 场景检查器纵向排列在主记录之后。
    const mainBox = (await page.locator(".record-main").boundingBox())!;
    const inspectorBox = (await page.locator(".scene-inspector").boundingBox())!;
    expect(inspectorBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);
  });
});
