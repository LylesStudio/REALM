import { expect, test, type Page } from "@playwright/test";
import {
  DEMO_RECORD_ID,
  installPlayerEventProjectionFixture,
  openDemoRecord,
} from "./helpers";

/** 切换界面语言并回到记录页。 */
async function switchLanguage(
  page: Page,
  label: "中文" | "English" | "日本語",
  returnTo = "/",
) {
  await page.goto("/settings");
  await page.locator(".settings-language button", { hasText: label }).click();
  await expect(
    page.locator(".settings-language button", { hasText: label }),
  ).toHaveClass(/is-active/);
  await page.goto(returnTo);
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
    // 技能/资产/姿态按种子标题经 i18n 表本地化（EN）。
    await expect(panel).toContainText("Careful Observation");
    await expect(panel).toContainText("Mist Harbor Signal Lantern");
    // 场景行动是当前场景快照生成的世界内动态文案（中文世界数据），
    // 不随界面语言翻译（与 Q3 动态内容原样展示同源契约）。
    await expect(panel).toContainText("观察四周");
    await expect(panel).toContainText("灰鲸港 · 北防波堤");
    await page.getByRole("button", { name: "Close action panel" }).click();

    // 世界内系统环境段按界面语言本地化（该 seed 段为 zh-CN→en 对照）。
    await expect(page.locator(".semantic-segment").first()).toHaveText(
      "Mist climbs the breakwater along the stone steps.",
    );

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
    await page.locator('.library-create > [data-creation-focus-return="create-guided"]').click();
    await expect(page.locator(".guided-question")).toContainText(
      "この世界の名前は？",
    );
    await page.getByRole("button", { name: "ガイドを閉じる" }).click();
  });

  test("Q3 玩家动态输入原样展示（确定性 Record 投影 fixture）", async ({ page }) => {
    const playerInput = "玩家原文：Hello, 旅人！";
    await installPlayerEventProjectionFixture(page, DEMO_RECORD_ID, playerInput);
    await openDemoRecord(page);
    const card = page.locator(".event-card.is-committed", { hasText: playerInput });
    await expect(card).toBeVisible();

    // 切换界面语言后，玩家原文仍逐字保留。
    await switchLanguage(page, "English", `/?recordId=${DEMO_RECORD_ID}`);
    const playerDialogue = page.locator('.semantic-segment[data-segment-kind="dialogue"]', {
      hasText: playerInput,
    });
    await expect(playerDialogue).toHaveText(playerInput);
    await expect(page.locator("body")).not.toContainText("ui.composer");
    await expect(page.locator("body")).not.toContainText("ui.nav.");
  });
});
