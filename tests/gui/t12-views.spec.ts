import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * 批次 T12-C：页面级世界/故事/记录视图导航（只读，不写共享库）。
 * 归档隐藏与重演起点由 PG 集成测试覆盖（共享 realm_dev 禁止物理清理，
 * 故本用例不创建/归档数据）。
 */
test.describe("T12 page-level views", () => {
  test("breadcrumb switches record/world/story views and deep-links", async ({ page }) => {
    await openDemoRecord(page);

    // 面包屑三级均为可点按钮，当前记录为 aria-current=page。
    const worldCrumb = page.getByRole("button", { name: "打开世界视图" });
    const storyCrumb = page.getByRole("button", { name: "打开故事视图" });
    const recordCrumb = page.getByRole("button", { name: "返回记录视图" });
    await expect(worldCrumb).toBeVisible();
    await expect(storyCrumb).toBeVisible();
    await expect(recordCrumb).toBeVisible();
    await expect(recordCrumb).toHaveAttribute("aria-current", "page");

    // 世界视图：名称、统计与故事-记录结构；URL 写回 ?view=world。
    await worldCrumb.click();
    await expect(page.locator('[data-view="world"]')).toBeVisible();
    await expect(page.locator('[data-view="world"] h1')).toHaveText("烬海诸国");
    await expect(page.locator(".view-stats")).toBeVisible();
    await expect(worldCrumb).toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).searchParams.get("view")).toBe("world");

    // 故事视图：当前故事标题与未归档记录列表。
    await storyCrumb.click();
    await expect(page.locator('[data-view="story"]')).toBeVisible();
    await expect(page.locator('[data-view="story"] h1')).toBeVisible();
    await expect(page.locator('[data-view="story"] .view-record-list .view-link').first()).toBeVisible();
    await expect(storyCrumb).toHaveAttribute("aria-current", "page");
    expect(new URL(page.url()).searchParams.get("view")).toBe("story");

    // 记录视图回落：时间线与输入框回来，URL 去掉 view 参数。
    await recordCrumb.click();
    await expect(page.locator("#realm-message")).toBeVisible();
    await expect(page.locator(".timeline-scroll")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("view")).toBeNull();

    // 深链：刷新 ?view=world 仍停在世界视图（记录视图元素不再出现）。
    await page.goto("/?recordId=record_first_watch&view=world");
    await expect(page.locator('[data-view="world"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-view="world"] h1')).toHaveText("烬海诸国");
  });
});
