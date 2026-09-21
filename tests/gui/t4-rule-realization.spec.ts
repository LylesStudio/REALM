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
 * 批次 T4 规则系统真化（docs/development/T4-RULE-REALIZATION.md §7.4）：
 * 自建世界（非 demo）的记录装配会按文风生成 2 技能 + 1 资产 + 1 姿态
 * 基础定义并授权——行动面板数据驱动目录可见；真实模型回合使用生成的
 * 技能成功落库（时间线可见）；资产扣减可见（目录「剩余 n 次」2→1）。
 * 全程真实模型，不新增任何 mock。
 */
test.describe("T4. 规则真化 · 自建世界数据驱动规则参局", () => {
  test("T4-1 能力目录数据驱动 + 生成技能真实模型回合落库", async ({
    page,
    request,
  }) => {
    test.setTimeout(480_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 行动面板：装配生成的基础定义全部可见（modern 文风固定文案），
    // 资产带账本余额「剩余 2 次」。
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("锐意洞察");
    await expect(panel).toContainText("稳定操作");
    await expect(panel).toContainText("旅行工具包");
    await expect(panel).toContainText("剩余 2 次");
    await expect(panel).toContainText("警觉守望");
    // demo 专属能力不串场（目录只读本世界定义）。
    await expect(panel).not.toContainText("细致观察");
    await expect(panel).not.toContainText("雾港信号灯");
    await expect(panel).not.toContainText("警戒姿态");

    // 选择带检定的生成技能（metadata.check: d20 +1 / 目标 10）：
    // 判定参数由定义推导，经 resolve_uncertainty 解算。
    await panel.locator(".affordance-list button", { hasText: "锐意洞察" }).click();
    const chip = page.locator(".selected-affordance");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("锐意洞察");
    const input = page.locator("#realm-message");
    await expect(input).not.toHaveValue("");

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
    await expect(page.locator(".selected-affordance")).toHaveCount(0);

    // 成功落库且时间线可见：玩家行动宣告成为已提交事件，
    // 且世界给出了至少一条回应事件（回合完整提交）。
    await expect(
      page.locator(".event-card.event-player.is-committed", { hasText: "锐意洞察" }).first(),
    ).toBeVisible({ timeout: TURN_TIMEOUT });
    await expect(
      page.locator(".event-card.is-committed:not(.event-player)").first(),
    ).toBeVisible({ timeout: TURN_TIMEOUT });
  });

  test("T4-2 资产扣减可见：旅行工具包余额 2→1", async ({ page, request }) => {
    test.setTimeout(480_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 使用前：账本余额「剩余 2 次」。
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    const asset = panel.locator(".affordance-list button", { hasText: "旅行工具包" });
    await expect(asset).toContainText("剩余 2 次");
    await asset.click();
    await expect(page.locator(".selected-affordance")).toContainText("旅行工具包");

    // 真实模型回合：use_asset 自动成功 + consume_resource 账本扣减。
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

    // 行动落库：玩家使用宣告成为已提交事件。
    await expect(
      page.locator(".event-card.event-player.is-committed", { hasText: "旅行工具包" }).first(),
    ).toBeVisible({ timeout: TURN_TIMEOUT });

    // 重开面板：余额真实扣减为「剩余 1 次」（character_assets 投影）。
    await page.getByRole("button", { name: "行动" }).click();
    await expect(
      panel.locator(".affordance-list button", { hasText: "旅行工具包" }),
    ).toContainText("剩余 1 次");
  });
});
