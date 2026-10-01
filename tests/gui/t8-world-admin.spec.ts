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

    // 信息密度：计数行含 2 故事 · 2 记录（当前契约：createWorld 自动装配
    // 起始故事+起始记录（createStarterStoryAndRecord），另加本用例各一）。
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "2 故事",
    );
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "2 记录",
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
    // exact：记录行也有「删除」按钮（strict mode 下不加精确匹配会歧义）。
    await worldCard.getByRole("button", { name: "删除", exact: true }).click();
    await worldCard.getByRole("button", { name: "确认删除" }).click();
    await expect(page.locator(".notice-bar")).toContainText("先归档", {
      timeout: 15_000,
    });
    await expect(worldCard).toBeVisible();
  });

  test("T8-2 有历史世界两段确认删除被 fail-closed 拒绝，归档为受支持生命周期", async ({ page, request }) => {
    // 当前契约：createWorld 自动装配起始故事+起始记录（createStarterStoryAndRecord），
    // 不存在「零记录新世界」；WORLD_NOT_EMPTY 的 records 计数含已归档行
    //（append-only 事件引用网使物理删除不可达）——删除按钮的可达路径是拒绝
    // 并引导归档。本条钉住：起始记录归档后两段删除仍被拒、世界仍在、归档生效。
    test.setTimeout(240_000);
    const world = await createWorldViaApi(request);
    await createStoryViaApi(request, world.id);

    // 先把起始记录归档（delete-record=隐藏归档，owner 即创建者）。
    const library = (await (await request.get("/api/library")).json()) as {
      worlds: Array<{
        id: string;
        stories: Array<{ records: Array<{ id: string }> }>;
      }>;
    };
    const starterRecordId = library.worlds
      .find((entry) => entry.id === world.id)
      ?.stories.flatMap((story) => story.records)
      .map((record) => record.id)[0];
    expect(starterRecordId, "起始记录必须可从世界库读出").toBeTruthy();
    const archiveResponse = await request.post("/api/library", {
      data: { kind: "delete-record", worldId: world.id, recordId: starterRecordId },
    });
    expect(archiveResponse.ok(), "起始记录归档必须成功").toBeTruthy();

    await openDemoRecord(page);
    await openLibrary(page);
    const worldCard = page.locator(".library-world", { hasText: world.name });
    await expect(worldCard).toBeVisible();
    await expect(worldCard.locator(".library-world-stats")).toContainText(
      "0 记录",
    );

    // 两段确认删除：被服务端 WORLD_NOT_EMPTY 拒绝（409），世界仍在。
    await worldCard.getByRole("button", { name: "删除", exact: true }).click();
    await worldCard.getByRole("button", { name: "确认删除" }).click();
    await expect(worldCard).toBeVisible();
    await expect(
      page.locator(".library-world", { hasText: world.name }),
    ).toHaveCount(1);

    // 受支持的生命周期是归档：徽标出现、data-archived 置位。
    await worldCard.getByRole("button", { name: "归档", exact: true }).click();
    await expect(worldCard.locator(".world-archived-badge")).toContainText(
      "已归档",
    );
    await expect(worldCard).toHaveAttribute("data-archived", "true");
  });
});
