import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  waitForRecordReady,
} from "./helpers";

/**
 * 批次 T7 观察者之眼看世界（docs/development/T7-OBSERVATION-VISION.md §4.4）：
 * 创世建仓 → 姿态切观察者（UI 开关）→ 打开记录 → 「开始演绎」→ 无键盘输入，
 * 世界自演拍实时渐显（data-self-play 锚点），状态卡走到终态，拍数 ≤ 预算。
 * 全程真实模型，不新增任何 mock。
 *
 * 真实模型偶发失败（拍复核三连否决/模型沉默 → 会话 failed）不算 UI bug：
 * 允许点「再演一轮」重试一次（与 T6 同引擎重试纪律同型）。
 */
test.describe("T7. 观察者之眼 · 世界自演真实模型可见", () => {
  test("T7-1 观察者开始演绎 → 自演拍实时可见且状态收束", async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    // 姿态切观察者（世界库 UI 开关，批次 S 既有入口）。
    await openDemoRecord(page);
    await openLibrary(page);
    const worldCard = page.locator(".library-world", { hasText: world.name });
    await worldCard
      .getByRole("button", { name: "观察者 · 执笔者" })
      .click();
    await expect(
      worldCard.getByRole("button", { name: "观察者 · 执笔者" }),
    ).toHaveAttribute("aria-pressed", "true");
    // 世界库已在开：直接点记录进入（openLibrary 再点会 toggle 关面板）。
    await page.locator(".library-record", { hasText: record.title }).first().click();
    await waitForRecordReady(page);
    await expect(page.locator(".record-heading h1")).toHaveText(record.title);

    // 观察者身份：执笔者徽标；自演面板就绪。
    await expect(page.locator(".view-mode.is-narrator")).toContainText("执笔者");
    const panel = page.locator("[data-self-play-panel]");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("世界自演");

    const selfPlayEvents = page.locator(".event-card[data-self-play]");
    let succeeded = false;
    for (let attempt = 0; attempt < 2 && !succeeded; attempt += 1) {
      await panel.getByRole("button").first().click();

      // 等第一拍事件实时渐显（无键盘输入；SSE 通道）。
      try {
        await expect(selfPlayEvents.first()).toBeVisible({ timeout: 240_000 });
      } catch {
        // 首拍模型失败（会话 failed）→ 再演一轮重试。
      }
      if (await selfPlayEvents.first().isVisible().catch(() => false)) {
        succeeded = true;
        break;
      }
      // 会话落 failed 才可重试；仍在 running/stopping 则继续等终态。
      await expect(panel).toContainText(/演绎中断|演绎完成|已停止/, {
        timeout: 240_000,
      });
      if (!(await panel.textContent())?.includes("演绎中断")) break;
    }
    expect(succeeded, "自演拍应实时落时间线（data-self-play 锚点）").toBe(true);

    // 状态收束到终态，拍数不超预算（默认 3）。
    await expect(panel).toContainText(/演绎完成|已停止|演绎中断/, {
      timeout: 600_000,
    });
    const beatValues = (await selfPlayEvents.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-self-play"))
    )).filter((value): value is string => value !== null);
    const distinctBeats = [...new Set(beatValues)];
    expect(distinctBeats.length).toBeGreaterThan(0);
    expect(
      Math.max(...distinctBeats.map((value) => Number(value))),
    ).toBeLessThanOrEqual(3);

    // 自演不产生玩家事件：时间线里无「你」角色卡之外的玩家事件冒名。
    await expect(page.locator(".event-card.event-player")).toHaveCount(0);
  });
});
