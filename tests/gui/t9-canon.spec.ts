import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  TURN_TIMEOUT,
} from "./helpers";

/**
 * 批次 T9 Canon 回读（docs/development/T9-CANON-READBACK.md §4.3）：
 * 自建世界（非 demo）→ 图谱 UI 建实体/Claim（worldId 显式链路）→ canon
 * 提案 → UI 合并晋升 story_canon → 该世界记录里真实模型回合完成（正史
 * 注入不破坏管线，不 422）。全程真实模型，不新增 mock。
 */
test.describe("T9. Canon 回读 · 非 demo 世界图谱→正史→回合", () => {
  test("T9-1 自建世界图谱编辑 → 提案合并 → 真实回合完成", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    // 图谱 UI（非 demo 世界）：新建实体 + 提交 Claim。
    await openDemoRecord(page);
    await openLibrary(page);
    await page
      .locator(".library-world", { hasText: world.name })
      .getByRole("button", { name: "图谱 · 正史" })
      .click();
    await expect(page.locator(".graph-panel")).toBeVisible();

    await page.getByRole("button", { name: "新建实体" }).click();
    const form = page.locator(".graph-edit-form");
    await form.locator("input").first().fill("界碑");
    await form.locator("select").selectOption("geography");
    await form.locator("textarea").fill("世界边缘的石碑。");
    await form.getByRole("button", { name: "确认" }).click();
    await expect(
      page.locator(".graph-node", { hasText: "界碑" }).first(),
    ).toBeVisible();

    await page.locator(".graph-node", { hasText: "界碑" }).first().click();
    await page.getByRole("button", { name: "提交 Claim" }).click();
    const claimForm = page.locator(".graph-edit-form");
    await claimForm.locator("input").first().fill("铭文");
    await claimForm.locator("input").nth(1).fill("来者留名");
    // 两个 select：层级（story/world）与真值状态；分别按位选取。
    await claimForm.locator("select").first().selectOption("story");
    await claimForm.locator("select").nth(1).selectOption("record_confirmed");
    await claimForm.getByRole("button", { name: "确认" }).click();
    await expect(page.locator(".graph-detail")).toContainText("来者留名");

    // Claim id 经 API（带 worldId）取出并提案。
    const graph = await request.get(
      `/api/world-knowledge?worldId=${encodeURIComponent(world.id)}`,
    );
    expect(graph.ok()).toBeTruthy();
    const claims = ((await graph.json()) as { claims: { id: string }[] }).claims;
    expect(claims.length).toBe(1);
    const propose = await request.post("/api/canon", {
      data: {
        action: "propose",
        targetLevel: "story",
        claimIds: [claims[0]!.id],
        rationale: "界碑铭文应入正史。",
        worldId: world.id,
      },
    });
    expect(propose.status()).toBe(201);

    // 提案发生在面板打开之后：关闭重开让 canon 列表重读（面板仅挂载时加载）。
    await page
      .locator(".graph-panel")
      .getByRole("button", { name: "关闭知识图谱" })
      .click();
    // 世界库面板仍开着（图谱是它的覆盖层），不可再 toggle——直接重开图谱。
    await page
      .locator(".library-world", { hasText: world.name })
      .getByRole("button", { name: "图谱 · 正史" })
      .click();
    await expect(page.locator(".graph-panel")).toBeVisible();

    // 正史审核 tab：UI 合并晋升 story_canon。
    await page.getByRole("button", { name: /正史审核/ }).click();
    const card = page.locator(".canon-card", { hasText: "界碑铭文应入正史。" });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "合并" }).click();
    await expect(
      page.locator(".canon-card", { hasText: "界碑铭文应入正史。" }),
    ).toHaveCount(0);
    // 关闭图谱覆盖层回到仍开着的世界库，直接进记录（世界库 toggle 不能重点）。
    await page
      .locator(".graph-panel")
      .getByRole("button", { name: "关闭知识图谱" })
      .click();
    await page
      .locator(".library-record", { hasText: record.title })
      .first()
      .click();
    await expect(page.locator(".record-heading h1")).toHaveText(record.title);
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/record/messages")
        && res.request().method() === "POST",
      { timeout: TURN_TIMEOUT },
    );
    await page.locator("#realm-message").fill("我环顾四周，确认这里的状况。");
    await page.getByRole("button", { name: "送出" }).click();
    expect((await responsePromise).status()).toBe(201);
    await expect(
      page.locator(".event-card.is-committed", { hasText: "我环顾四周" }).first(),
    ).toBeVisible({ timeout: 90_000 });
  });
});
