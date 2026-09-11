import { expect, test } from "@playwright/test";
import { openDemoRecord, uniqueName } from "./helpers";

/**
 * 批次 L：生成中暂存位真实浏览器验收（1440×900）。
 * 真实模型回合期间断言暂存位可见且含原文；提交完成后暂存位消失、
 * 正式事件接管、无重复卡片。骰点动效的真实 GUI 触发依赖模型产出
 * 带 check 的行动，本批不做脆弱断言——见收口记录。
 */
test.describe("L. 生成中暂存位", () => {
  test("L1 提交后暂存位可见，提交完成消失且不重复", async ({ page }) => {
    test.setTimeout(240_000);
    await openDemoRecord(page);
    const content = uniqueName("L1我观察蜡封");
    await page.locator("#realm-message").fill(content);
    await page.getByRole("button", { name: "送出" }).click();

    // 生成中：独立暂存位存在、含原文与「正在生成」状态文案。
    const pending = page.locator(".pending-submission");
    await expect(pending).toBeVisible({ timeout: 10_000 });
    await expect(pending).toContainText(content.slice(0, 12));
    await expect(pending).toContainText("正在生成");
    await expect(pending).toHaveAttribute("role", "status");

    // 接管：暂存位消失，正式 committed 事件出现，且原文只出现一次。
    await expect(pending).toHaveCount(0, { timeout: 200_000 });
    const committed = page.locator(".event-card.is-committed", { hasText: content });
    await expect(committed.first()).toBeVisible({ timeout: 200_000 });
    await expect(
      page.locator(".event-card", { hasText: content }),
    ).toHaveCount(1, { timeout: 200_000 });
  });

  test("L2 骰点揭示：滚动后稳定读出服务端真实结果", async ({ page }) => {
    test.setTimeout(300_000);
    await openDemoRecord(page);

    // 真实行动链：细致观察技能带 check 元数据，提交后产出骰点判定事件。
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await panel.locator(".affordance-list button", { hasText: "细致观察" }).click();
    let status = 0;
    for (let attempt = 0; attempt < 4 && status !== 201; attempt += 1) {
      const responsePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: 180_000 },
      );
      await page.getByRole("button", { name: "送出" }).click();
      status = (await responsePromise).status();
    }
    expect(status).toBe(201);

    // 揭示完成后：滚动类消失，真实结果文本稳定可读，数据属性保留。
    const dice = page.locator(".event-dice").last();
    await expect(dice).toBeVisible({ timeout: 180_000 });
    await expect(dice).toContainText("🎲", { timeout: 180_000 });
    await expect(page.locator(".event-dice.is-rolling")).toHaveCount(0);
    await expect(dice).toHaveAttribute("data-dice-system", /d20|2d6|percentile|pool|draw/);
    await expect(dice).toHaveAttribute("data-dice-outcome", /success|failure/);
    await expect(dice).toHaveAttribute("role", "status");
    const firstRead = await dice.textContent();
    expect(firstRead).toMatch(/成功|失败/);
    // 重渲染/后续 SSE  tick 不重播：同一元素文本保持稳定。
    await page.waitForTimeout(3_000);
    expect((await dice.textContent()) ?? "").toBe(firstRead ?? "");
    await expect(page.locator(".event-dice.is-rolling")).toHaveCount(0);
  });
});
