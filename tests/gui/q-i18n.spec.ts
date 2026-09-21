import { expect, test, type Page } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/** 切换界面语言并回到记录页。 */
async function switchLanguage(page: Page, label: "中文" | "English" | "日本語") {
  await page.goto("/settings");
  await page.locator(".settings-language button", { hasText: label }).click();
  await expect(
    page.locator(".settings-language button", { hasText: label }),
  ).toHaveClass(/is-active/);
  await page.goto("/");
}

test.describe("Q. 全文本 i18n", () => {
  test.afterEach(async ({ page }) => {
    // 每个用例结束还原中文，避免污染后续组。
    await switchLanguage(page, "中文");
  });

  test("Q1 界面切 English：固定文案与世界内系统文本同步，风格维度保持", async ({
    page,
  }) => {
    await openDemoRecord(page);
    await switchLanguage(page, "English");

    // 第一层：界面固定文案。
    await expect(page.locator(".record-heading .eyebrow")).toContainText(
      "Active record",
    );
    await expect(page.locator(".composer-heading label")).toHaveText("Your move");
    await expect(page.locator(".world-nav .nav-footer")).toContainText(
      "keeps running",
    );
    // 第二层：行动卡跟随界面语言（demo 世界 classical × en）。
    await page.getByRole("button", { name: "Actions" }).click();
    const panel = page.getByRole("dialog", { name: "Available actions" });
    await expect(panel).toContainText("Mark the stirrings about 灰鲸港 · 北防波堤");
    // 风格维度保持：仍是 classical 措辞（Mark/stirrings），不是 modern 的 Watch。
    await expect(panel).not.toContainText("Watch how things shift");
    await page.getByRole("button", { name: "Close action panel" }).click();

    // 动态文本不受影响：演示记录事件仍为原文。
    await expect(
      page.locator(".event-card", { hasText: "雾沿着石阶爬上防波堤" }).first(),
    ).toBeVisible();

    // 语言持久化：刷新后仍为英文。
    await page.reload();
    await expect(page.locator(".composer-heading label")).toHaveText("Your move");
  });

  test("Q2 界面切日本語：提问语与卷首空态随之切换", async ({ page, request }) => {
    void request;
    await openDemoRecord(page);
    await switchLanguage(page, "日本語");

    // 界面已是日语：世界库按钮与退出按钮按日语标签定位。
    await page.getByRole("button", { name: "世界庫" }).click();
    await expect(page.locator(".library-panel")).toBeVisible();
    await page.locator(".guided-entry").click();
    await expect(page.locator(".guided-question")).toContainText(
      "この世界の名前は？",
    );
    await page.getByRole("button", { name: "ガイドを閉じる" }).click();
  });

  test("Q3 玩家输入原样展示（动态文本不进资源文件）", async ({ page }) => {
    await openDemoRecord(page);
    // 玩家事件原文展示（含既有中文与任意输入语言）。
    await expect(
      page.locator(".event-card", { hasText: "这里好安静" }).first(),
    ).toBeVisible();
    // 界面为中文时文案键不裸露。
    await expect(page.locator("body")).not.toContainText("ui.composer");
    await expect(page.locator("body")).not.toContainText("ui.nav.");
  });
});
