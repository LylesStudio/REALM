import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  uniqueName,
  waitForRecordReady,
} from "./helpers";

test.describe("L. 启笔铸界与数据隔离", () => {
  test("L1 世界库统一创世入口：AI 助手主入口、分步次入口、来源返回", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);

    // 统一入口：AI 助手对话（主）+ 分步引导（次）均可见；
    // 旧的单轮「灵感→草稿」UI 已移除。
    const chatEntry = page.getByRole("button", { name: /与 AI 助手对话/ });
    const guidedEntry = page.getByRole("button", { name: /分步引导 · 逐项填写/ });
    await expect(chatEntry).toBeVisible();
    await expect(guidedEntry).toBeVisible();
    await expect(page.locator(".genesis-prompt")).toHaveCount(0);
    await expect(page.locator(".genesis-section")).toHaveCount(0);

    // 主入口：打开与首次 onboarding 同一 GuidedGenesisChat 全屏对话，
    // 世界库 overlay 让位（无双 overlay）。
    await chatEntry.click();
    const chatOverlay = page.locator(".guided-overlay .guided-genesis-chat");
    await expect(chatOverlay).toBeVisible();
    await expect(page.locator(".library-panel")).toBeHidden();

    // 退出回来源：关闭对话后回到世界库。
    await chatOverlay.getByRole("button", { name: "关闭" }).click();
    await expect(page.locator(".library-panel")).toBeVisible();

    // 次入口：分步引导同样从世界库打开，退出回到世界库。
    await guidedEntry.click();
    const guidedOverlay = page.locator(".guided-overlay .guided-genesis");
    await expect(guidedOverlay).toBeVisible();
    await expect(page.locator(".library-panel")).toBeHidden();
    await guidedOverlay.getByRole("button", { name: "退出引导" }).click();
    await expect(page.locator(".library-panel")).toBeVisible();
  });

  test("L2 新世界数据隔离与场景空态留白", async ({ page, request }) => {
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id, uniqueName("GUI故事"));
    const record = await createRecordInStory(request, story.id, uniqueName("GUI记录"));

    await openDemoRecord(page);
    await openLibrary(page);
    await page
      .locator(".library-record", { hasText: record.title })
      .first()
      .click();
    await waitForRecordReady(page);
    await expect(page.locator(".record-heading h1")).toHaveText(record.title);

    // 数据隔离：导航与面包屑只呈现新世界，无演示世界文字残留。
    await expect(page.locator(".world-nav .context-heading h2")).toHaveText(world.name);
    await expect(page.locator(".world-nav")).not.toContainText("烬海诸国");
    await expect(page.locator(".world-nav")).not.toContainText("无声钟的来客");
    await expect(page.locator(".breadcrumb")).not.toContainText("雾港来信");
    // 鬼影清除：阵容只有当前账号玩家，没有塞娜/弥洛/洛川。
    await expect(page.locator(".cast-list li")).toHaveCount(1);
    await expect(page.locator(".cast-list")).toContainText("GUI 测试员");
    await expect(page.locator(".scene-inspector")).not.toContainText("塞娜");
    await expect(page.locator(".scene-inspector")).not.toContainText("弥洛");
    await expect(page.locator(".scene-inspector")).not.toContainText("洛川");

    // 空态消隐：空字段折叠不占位，地点回退为所属故事名。
    await expect(page.locator(".scene-card h2")).toHaveText(story.title);
    await expect(page.locator(".scene-facts")).toBeHidden();
    await expect(page.locator(".scene-objective")).toBeHidden();
    await expect(page.locator(".scene-inspector")).not.toContainText("未记录");
    await expect(page.locator(".scene-inspector")).not.toContainText("平稳");
    await expect(page.locator(".scene-inspector")).not.toContainText("尚未命名地点");

    // 空时间线卷首意象，输入框聚焦可用。
    await expect(page.locator(".timeline-empty")).toContainText("新的一页，还没有内容");
    await expect(page.locator("#realm-message")).toBeEnabled();
  });
});
