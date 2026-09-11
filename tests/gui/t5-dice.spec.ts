import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  TURN_TIMEOUT,
} from "./helpers";

/**
 * 批次 T5 骰子真随机与多骰系（docs/development/T5-DICE-RANDOMNESS.md §6.4）：
 * 自建世界（非 demo）触发带检定的生成技能（锐意洞察 metadata.check:
 * d20 +1 / 目标 10）→ 真实模型回合落库 → 玩家时间线骰点过程可见
 * （.event-dice 锚点，data-dice-system/outcome）→ 刷新重读骰点仍在
 * （物化落库证据，重放读库不重掷）。全程真实模型，不新增任何 mock。
 */
test.describe("T5. 骰子 · 真随机判定结果玩家可见", () => {
  test("T5-1 自建世界检定 → 骰点可见 → 刷新重读同一物化结果", async ({
    page,
    request,
  }) => {
    test.setTimeout(480_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 选择带检定的生成技能（d20）。
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await expect(panel).toBeVisible();
    await panel.locator(".affordance-list button", { hasText: "锐意洞察" }).click();
    await expect(page.locator(".selected-affordance")).toContainText("锐意洞察");

    // 真实模型回合：偶发失败不算 UI bug，草稿与选择恢复后直接重试。
    let status = 0;
    for (let attempt = 0; attempt < 4 && status !== 201; attempt += 1) {
      const responsePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: TURN_TIMEOUT },
      );
      await page.getByRole("button", { name: "送出" }).click();
      status = (await responsePromise).status();
    }
    expect(status).toBe(201);

    // 判定事件落库且骰点行可见：d20 系统锚点 + 成败锚点 + 明细文案。
    const diceLine = page.locator(".event-dice[data-dice-system='d20']").first();
    await expect(diceLine).toBeVisible({ timeout: TURN_TIMEOUT });
    await expect(diceLine).toContainText("🎲 d20");
    await expect(diceLine).toContainText(/≥ 10 · (成功|失败)/);
    const outcome = await diceLine.getAttribute("data-dice-outcome");
    expect(["success", "failure"]).toContain(outcome);
    const rendered = (await diceLine.textContent()) ?? "";

    // 物化落库证据：刷新后重进记录，骰点行逐字一致（重放读库，不重掷）。
    await page.reload();
    await openRecordViaLibrary(page, record.title);
    const reread = page.locator(".event-dice[data-dice-system='d20']").first();
    await expect(reread).toBeVisible({ timeout: TURN_TIMEOUT });
    await expect(reread).toHaveText(rendered);
  });
});
