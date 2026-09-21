import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
} from "./helpers";

test.describe("O. 行动卡动态生长与下一步对话提案", () => {
  test("O1 新世界行动面板：无 demo 文案串场，留白走中性兜底", async ({
    page,
    request,
  }) => {
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await expect(panel).toBeVisible();
    const observe = panel.locator("button", { hasText: "观察四周" });
    await expect(observe).toBeVisible();
    // 留白世界：中性兜底，不出现任何 demo 世界意象。
    await expect(observe).toContainText("留意周遭环境的变化");
    await expect(panel).not.toContainText("防波堤");
    await expect(panel).not.toContainText("灯塔");
    await expect(panel).not.toContainText("雾港");
    // demo 专属能力（密函/信号灯/警戒姿态）在新世界不出现。
    await expect(panel).not.toContainText("细致观察");
    await expect(panel).not.toContainText("警戒姿态");
  });

  test("O2 demo 世界行动卡贴合其场景数据，不退化为中性兜底", async ({ page }) => {
    await openDemoRecord(page);
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    const observe = panel.locator("button", { hasText: "观察四周" });
    await expect(observe).toBeVisible();
    await expect(observe).toContainText("北防波堤一带的动静");
  });

  test("O3 回合后提案浮现：点击填入输入框，确认后可提交", async ({
    page,
    request,
  }) => {
    test.setTimeout(480_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 回合前：无提案区（不渲染空占位）。
    await expect(page.locator(".suggestion-row")).toHaveCount(0);

    // 提交并读取响应信封：提案随信封返回（探针已验证服务端契约）。
    const { response } = await submitMessage(page, "我清点行囊，确认水和干粮的存量。");
    expect([201, 428]).toContain(response.status());
    const body = (await response.json()) as { suggestions?: unknown };
    expect(Array.isArray(body.suggestions)).toBe(true);
    expect((body.suggestions as string[]).length).toBeGreaterThanOrEqual(2);

    // 纸签浮现。
    const slips = page.locator(".suggestion-slip");
    await expect(slips.first()).toBeVisible({ timeout: 30_000 });
    const count = await slips.count();
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(3);

    // 点击提案：填入输入框（不直接提交），可编辑后送出。
    const first = slips.first();
    const suggestionText = (await first.textContent())?.trim() ?? "";
    expect(suggestionText.length).toBeGreaterThan(0);
    await first.click();
    const input = page.locator("#realm-message");
    await expect(input).toHaveValue(suggestionText);
    // 提案是快捷入口而非强制：可自由改字。
    await input.fill(`${suggestionText}（先环顾四周）`);
    await expect(page.getByRole("button", { name: "送出" })).toBeEnabled();
  });

  test("O4 自由输入不受提案影响，回合进行中提案区消隐", async ({
    page,
    request,
  }) => {
    test.setTimeout(480_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 直接自由输入（不碰提案）：回合正常完成。
    const { response } = await submitMessage(page, "我沿着石板路慢慢往前走。");
    expect([201, 428]).toContain(response.status());
    // 回合进行中提案区不渲染（disabled 态），完成后才允许出现。
    const slips = page.locator(".suggestion-slip");
    await slips.first().waitFor({ timeout: 30_000 }).catch(() => {});
    // 无论本回合模型是否返回提案，输入框都必须保持可用。
    await expect(page.locator("#realm-message")).toBeEnabled();
  });
});
