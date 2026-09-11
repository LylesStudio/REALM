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

/** 真实模型起草可能需要一分钟以上；本地降级则立即返回。 */
const GENESIS_TIMEOUT = 180_000;

test.describe("L. 启笔铸界与数据隔离", () => {
  test("L1 自然语言创世：手稿预览、微调后落笔入界", async ({ page }) => {
    const worldName = uniqueName("GUI云港");
    await openDemoRecord(page);
    await openLibrary(page);

    // 主推入口：宣纸灵感框直接可见，手动录入默认收起。
    await expect(page.locator(".genesis-prompt")).toBeVisible();
    await expect(page.locator(".library-form")).toBeHidden();

    await page.locator(".genesis-prompt").fill(
      "一座漂在云海上的旧船港，船员用风声记账，雾起时会有不属于任何航线的船靠岸。",
    );
    await page.locator(".genesis-submit").click();

    // 纸墨手稿展开：模型提炼或本地降级都必须给出可编辑草稿。
    const manuscript = page.locator(".genesis-manuscript");
    await expect(manuscript).toBeVisible({ timeout: GENESIS_TIMEOUT });
    await expect(manuscript.locator(".genesis-source")).toContainText(/提炼/);

    // 微调世界名后落笔。
    await manuscript
      .locator("label", { hasText: "世界名" })
      .locator("input")
      .fill(worldName);
    await page.locator(".genesis-confirm").click();

    // 落笔即入界：直接打开新记录，世界名出现在顶栏与导航。
    await waitForRecordReady(page);
    await expect(page.locator(".breadcrumb")).toContainText(worldName);
    await expect(page.locator(".world-nav .context-heading h2")).toHaveText(worldName);
    // 人类玩家绑定当前登录账号昵称，而不是任何硬编码角色。
    await expect(page.locator(".cast-list")).toContainText("GUI 测试员");
    // 批次 T1：落笔即有确定性开场旁白（手稿 opening 或场景合成句），时间线不再空白。
    await expect(page.locator(".timeline-empty")).toHaveCount(0);
    await expect(page.locator(".event-card.event-narrator").first()).toBeVisible();
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
