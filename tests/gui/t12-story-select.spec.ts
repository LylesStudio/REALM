import { expect, test, type APIRequestContext } from "@playwright/test";
import { openDemoRecord, uniqueName } from "./helpers";

/**
 * 批次 T12 验收修正：多故事页面级选择 + 归档隐藏（隔离临时库/专属端口运行，
 * 数据在隔离库内创建与归档，用例结束由 harness 拆库，零共享库污染）。
 */
const DEMO_WORLD_ID = "world_ember_coast";

async function createStory(
  request: APIRequestContext,
  title: string,
  premise: string,
): Promise<string> {
  const response = await request.post("/api/library", {
    data: { kind: "story", worldId: DEMO_WORLD_ID, title, premise },
  });
  expect(response.ok()).toBeTruthy();
  const snapshot = await (await request.get("/api/library")).json() as {
    worlds: { id: string; stories: { id: string; title: string }[] }[];
  };
  const story = snapshot.worlds.find((world) => world.id === DEMO_WORLD_ID)
    ?.stories.find((item) => item.title === title);
  expect(story).toBeTruthy();
  return story!.id;
}

async function createRecord(
  request: APIRequestContext,
  storyId: string,
  title: string,
): Promise<string> {
  const response = await request.post("/api/library", {
    data: { kind: "record", storyId, title },
  });
  expect(response.ok()).toBeTruthy();
  const snapshot = await (await request.get("/api/library")).json() as {
    worlds: {
      id: string;
      stories: { id: string; records: { id: string; title: string }[] }[];
    }[];
  };
  const record = snapshot.worlds.find((world) => world.id === DEMO_WORLD_ID)
    ?.stories.find((story) => story.id === storyId)
    ?.records.find((item) => item.title === title);
  expect(record).toBeTruthy();
  return record!.id;
}

test.describe("T12 story selection", () => {
  test("second story view, record entry, deep link and archived hiding", async ({ page, request }) => {
    const storyTitle = uniqueName("第二故事");
    const storyPremise = "第二故事独有前提，不得被当前记录冒充。";
    const recordTitle = uniqueName("第二故事记录");
    const archivedTitle = uniqueName("将归档记录");
    const storyId = await createStory(request, storyTitle, storyPremise);
    await createRecord(request, storyId, recordTitle);
    const archivedRecordId = await createRecord(request, storyId, archivedTitle);

    await openDemoRecord(page);

    // 世界视图：两个故事按钮各自携带自身 data-story-id。
    await page.getByRole("button", { name: "打开世界视图" }).click();
    await expect(page.locator('[data-view="world"]')).toBeVisible();
    const storyButtons = page.locator('[data-view="world"] .view-story-block > .view-link');
    const storyIds = await storyButtons.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-story-id"))
    );
    expect(new Set(storyIds).size).toBe(storyIds.length);
    expect(storyIds).toContain(storyId);

    // 点击第二个故事：故事视图标题/前提/记录列表都属于它。
    await page.locator(`.view-story-block > .view-link[data-story-id="${storyId}"]`).click();
    await expect(page.locator('[data-view="story"]')).toBeVisible();
    await expect(page.locator('[data-view="story"]')).toHaveAttribute("data-story-id", storyId);
    await expect(page.locator('[data-view="story"] h1')).toHaveText(storyTitle);
    await expect(page.locator('[data-view="story"]')).toContainText(storyPremise);
    await expect(page.locator('[data-view="story"]')).toContainText(recordTitle);
    expect(new URL(page.url()).searchParams.get("view")).toBe("story");
    expect(new URL(page.url()).searchParams.get("storyId")).toBe(storyId);

    // 从被选故事点击其记录：进入对应 Record 并回到记录视图。
    await page.locator('[data-view="story"] .view-link', { hasText: recordTitle }).click();
    await expect(page.locator("#realm-message")).toBeVisible();
    await expect(page.locator(".record-heading h1")).toHaveText(recordTitle);
    expect(new URL(page.url()).searchParams.get("view")).toBeNull();

    // 归档其中一条记录后：故事视图/世界视图/左侧导航/计数均不出现。
    const deleteResponse = await request.post("/api/library", {
      data: { kind: "delete-record", worldId: DEMO_WORLD_ID, recordId: archivedRecordId },
    });
    expect(deleteResponse.ok()).toBeTruthy();
    await page.goto(`/?recordId=record_first_watch&view=story&storyId=${storyId}`);
    await expect(page.locator('[data-view="story"]')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('[data-view="story"] h1')).toHaveText(storyTitle);
    await expect(page.locator('[data-view="story"]')).toContainText(recordTitle);
    await expect(page.locator('[data-view="story"]')).not.toContainText(archivedTitle);

    // 深链恢复被选故事；面包屑故事入口回到当前 Record 的故事。
    await page.getByRole("button", { name: "打开世界视图" }).click();
    await expect(page.locator('[data-view="world"]')).not.toContainText(archivedTitle);
    await page.getByRole("button", { name: "打开故事视图" }).click();
    await expect(page.locator('[data-view="story"] h1')).not.toHaveText(storyTitle);
    expect(new URL(page.url()).searchParams.get("storyId")).toBeNull();
  });
});
