import { expect, test } from "@playwright/test";
import {
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  openManualForm,
  uniqueName,
  waitForRecordReady,
} from "./helpers";

test.describe("A. 世界库", () => {
  test("A1 初始加载：列出演示世界及其名称、纪元、摘要、状态", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);

    const world = page.locator(".library-world", { hasText: "烬海诸国" });
    await expect(world).toBeVisible();
    await expect(world.locator(".library-world-heading strong")).toHaveText("烬海诸国");
    await expect(world.locator(".library-world-heading")).toContainText("停战纪元 17 年");
    await expect(world).toContainText("人魔停战十七年后");
    await expect(world).toContainText("active");
    // 演示世界应展示角色、原初世界线与演示记录。
    await expect(world.locator(".library-character", { hasText: "塞娜" })).toBeVisible();
    await expect(world.locator(".library-worldline").first()).toContainText("原初");
    await expect(
      world.locator(".library-record", { hasText: "第一幕 · 雾港来信" }),
    ).toBeVisible();
    await expect(
      page.locator(".library-preset-card"),
    ).toHaveCount(3);
    await expect(page.locator(".library-preset-card").first()).toBeVisible();
  });

  test("A2 创建世界：提交后出现在列表并自动获得原初世界线", async ({ page }) => {
    const name = uniqueName("GUI世界");
    await openDemoRecord(page);
    await openManualForm(page);

    await page.locator(".library-tabs button", { hasText: "世界" }).click();
    await page.locator(".library-fields input").first().fill(name);
    await page.locator(".library-fields label", { hasText: "时代" }).locator("input").fill("测试纪元 1 年");
    await page.locator(".library-fields textarea").first().fill("GUI 测试创建的世界。");
    await page.locator(".library-submit").click();

    const world = page.locator(".library-world", { hasText: name });
    await expect(world).toBeVisible();
    await expect(world.locator(".library-worldline").first()).toContainText("原初");
  });

  test("A3 创建故事：提交后出现在目标世界的故事列表", async ({ page }) => {
    const title = uniqueName("GUI故事");
    await openDemoRecord(page);
    await openManualForm(page);

    await page.locator(".library-tabs button", { hasText: "故事" }).click();
    await page.locator(".library-fields select").selectOption({ label: "烬海诸国" });
    await page.locator(".library-fields input").first().fill(title);
    await page.locator(".library-fields textarea").first().fill("GUI 测试创建的故事。");
    await page.locator(".library-submit").click();

    const world = page.locator(".library-world", { hasText: "烬海诸国" });
    await expect(world.locator(".library-story", { hasText: title })).toBeVisible();
  });

  test("A4 创建记录并进入：自动装配玩家、AI 角色与场景", async ({ page }) => {
    const title = uniqueName("GUI记录");
    await openDemoRecord(page);
    await openManualForm(page);

    await page.locator(".library-tabs button", { hasText: "记录" }).click();
    await page
      .locator(".library-fields select")
      .selectOption({ label: "无声钟的来客" });
    await page.locator(".library-fields input").first().fill(title);
    await page.locator(".library-submit").click();

    const world = page.locator(".library-world", { hasText: "烬海诸国" });
    const recordButton = world.locator(".library-record", { hasText: title });
    await expect(recordButton).toBeVisible();

    await recordButton.click();
    await waitForRecordReady(page);
    await expect(page.locator(".record-heading h1")).toHaveText(title);
    // 自动装配：默认玩家 + 至少两名 AI 角色出现在场景检查器。
    // 演示世界还带有世界级自定义角色定义，装配会一并列出，故断言下限。
    expect(await page.locator(".cast-list li").count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator(".cast-list")).toContainText("塞娜");
    await expect(page.locator(".cast-list")).toContainText("弥洛");
    // 空记录展示卷首意象，输入框可用。
    await expect(page.locator(".timeline-empty")).toContainText("长卷初展，诸事未定");
    await expect(page.locator("#realm-message")).toBeEnabled();
  });

  test("A5 世界线分支：创建后列表显示原初与分支标签", async ({ page, request }) => {
    const world = await createWorldViaApi(request);
    const branchLabel = uniqueName("GUI分支");
    await openDemoRecord(page);
    await openManualForm(page);

    await page.locator(".library-tabs button", { hasText: "分支" }).click();
    await page
      .locator(".library-fields select")
      .selectOption({ label: world.name });
    await page.locator(".library-fields input").first().fill(branchLabel);
    await page.locator(".library-submit").click();

    const worldSection = page.locator(".library-world", { hasText: world.name });
    await expect(
      worldSection.locator(".library-worldline", { hasText: branchLabel }),
    ).toContainText("分支");
    await expect(
      worldSection.locator(".library-worldline").first(),
    ).toContainText("原初");
  });

  test("A6 timeline 标签：回溯记录显示 Retrospection，普通记录不带该标签", async ({
    page,
  }) => {
    const retroTitle = uniqueName("GUI回溯");
    const normalTitle = uniqueName("GUI普通");
    await openDemoRecord(page);
    await openManualForm(page);

    await page.locator(".library-tabs button", { hasText: "记录" }).click();
    const storySelect = page.locator(".library-fields select");
    await storySelect.selectOption({ label: "无声钟的来客" });
    await page.locator(".library-fields input").first().fill(retroTitle);
    await page.locator(".library-checkbox input").check();
    await page.locator(".library-submit").click();

    const world = page.locator(".library-world", { hasText: "烬海诸国" });
    const retroRecord = world.locator(".library-record", { hasText: retroTitle });
    await expect(retroRecord).toBeVisible();
    await expect(retroRecord).toContainText("Retrospection");

    await page.locator(".library-fields input").first().fill(normalTitle);
    await page.locator(".library-submit").click();
    const normalRecord = world.locator(".library-record", { hasText: normalTitle });
    await expect(normalRecord).toBeVisible();
    await expect(normalRecord).not.toContainText("Retrospection");
    await expect(normalRecord).not.toContainText("Merged");
  });
});
