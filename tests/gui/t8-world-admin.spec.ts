import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
} from "./helpers";

/**
 * 批次 T8 世界管理台（docs/development/T8-WORLD-ADMIN.md §4.3）：
 * 世界卡信息密度（角色/故事/记录计数）→ 归档（徽标 + data-archived + 开新局
 * 被服务端 WORLD_ARCHIVED 拒绝）→ 恢复 → 两段确认删除（仅零记录世界）。
 * 归档/删除不碰模型，全链路确定性。
 */
test.describe("T8. 世界管理台 · 归档/删除与信息密度", () => {
  test("T8-1 世界卡密度 → 归档封存 → 恢复 → 有记录世界删除被拒", async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    await createRecordInStory(request, story.id);

    await openDemoRecord(page);
    await openLibrary(page);
    const worldCard = page.locator(".library-world", { hasText: world.name });

    // 信息密度：计数行显示 0 角色 · 1 故事 · 1 记录。
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "1 故事",
    );
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "1 记录",
    );

    // 归档：徽标出现、世界卡标记 data-archived。
    await worldCard.getByRole("button", { name: "归档", exact: true }).click();
    await expect(worldCard.locator(".world-archived-badge")).toContainText(
      "已归档",
    );
    await expect(worldCard).toHaveAttribute("data-archived", "true");

    // 封存语义：归档世界开新局被服务端拒绝（409 WORLD_ARCHIVED）。
    const rejected = await request.post("/api/library", {
      data: { kind: "story", worldId: world.id, title: "封存故事", premise: "" },
    });
    expect(rejected.status()).toBe(409);
    expect(((await rejected.json()) as { error?: { code?: string } }).error?.code)
      .toBe("WORLD_ARCHIVED");

    // 恢复：徽标消失、状态回 active。
    await worldCard.getByRole("button", { name: "恢复" }).click();
    await expect(worldCard).toHaveAttribute("data-archived", "false");

    // 有记录世界删除被拒：两段确认后 WORLD_NOT_EMPTY 提示（引导归档），世界仍在。
    await worldCard.getByRole("button", { name: "删除" }).click();
    await worldCard.getByRole("button", { name: "确认删除" }).click();
    await expect(page.locator(".notice-bar")).toContainText("先归档", {
      timeout: 15_000,
    });
    await expect(worldCard).toBeVisible();
  });

  test("T8-2 零记录世界两段确认删除后从世界库消失", async ({ page, request }) => {
    test.setTimeout(240_000);
    const world = await createWorldViaApi(request);
    await createStoryViaApi(request, world.id);

    await openDemoRecord(page);
    await openLibrary(page);
    const worldCard = page.locator(".library-world", { hasText: world.name });
    await expect(worldCard).toBeVisible();
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "0 记录",
    );

    await worldCard.getByRole("button", { name: "删除" }).click();
    await worldCard.getByRole("button", { name: "确认删除" }).click();
    await expect(
      page.locator(".library-world", { hasText: world.name }),
    ).toHaveCount(0);
  });
});
