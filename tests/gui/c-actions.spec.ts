import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  GUI_AUTH_STATE,
  GUI_BASE_URL,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
  waitForRecordReady,
} from "./helpers";

test.describe("C. 行动面板", () => {
  test("C1 能力投影：行动面板列出当前受权能力", async ({ page }) => {
    // 技能/物品类受权能力由演示记录的场景与账本提供。
    await openDemoRecord(page);

    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await expect(panel).toBeVisible();
    const items = panel.locator(".affordance-list button");
    expect(await items.count()).toBeGreaterThanOrEqual(1);
    // 面板按技能/物品/姿态/场景分层。
    await expect(panel).toContainText("技能");
    await expect(panel).toContainText("物品");
    await expect(panel).toContainText("姿态");
    await expect(panel).toContainText("场景");
    await expect(panel).toContainText("细致观察");
    await expect(panel).toContainText("雾港信号灯");
    await expect(panel).toContainText("警戒姿态");
  });

  test("C2 选择行动：草稿预填且可继续编辑", async ({ page }) => {
    await openDemoRecord(page);

    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    const first = panel.locator(".affordance-list button", { hasText: "细致观察" });
    await first.click();

    const chip = page.locator(".selected-affordance");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("细致观察");
    const input = page.locator("#realm-message");
    await expect(input).not.toHaveValue("");
    // 预填内容可继续编辑。
    await input.fill(`${await input.inputValue()}（补充细节）`);
    await expect(input).toHaveValue(/（补充细节）$/);
  });

  test("C3 提交行动：正式提交成功且能力选择状态被清理", async ({
    page,
  }) => {
    await openDemoRecord(page);

    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    await panel.locator(".affordance-list button", { hasText: "细致观察" }).click();

    // 真实模型偶发失败不算 UI bug：失败后选择与草稿会恢复，可直接重试。
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

    await expect(page.locator(".selected-affordance")).toHaveCount(0);
    // 演示记录中同一行动可能已提交过多次，断言最新一条。
    await expect(
      page.locator(".event-card.is-committed", { hasText: "仔细观察蜡封边缘" }).last(),
    ).toBeVisible({ timeout: 180_000 });
  });

  test("C4 过期行动：冲突提示可见且不跳出当前记录，可改自然输入继续", async ({
    page,
    request,
    browser,
  }) => {
    // 本用例包含两次真实模型回合（他窗发言 + 过期后重试），
    // 240s 全局预算对模型时延敏感，单独放宽。
    test.setTimeout(600_000);
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 页面 A 选择一个行动但不提交。
    await page.getByRole("button", { name: "行动" }).click();
    await page
      .getByRole("dialog", { name: "当前可用行动" })
      .locator(".affordance-list button")
      .first()
      .click();
    await expect(page.locator(".selected-affordance")).toBeVisible();

    // 另一个会话在同一记录里提交一条自然输入，使 A 的写入授权过期。
    const contextB = await browser.newContext({ baseURL: GUI_BASE_URL, storageState: GUI_AUTH_STATE });
    const pageB = await contextB.newPage();
    await pageB.goto("/");
    await waitForRecordReady(pageB);
    await openRecordViaLibrary(pageB, record.title);
    const otherContent = "另一扇窗的发言。";
    const { response: responseB } = await submitMessage(pageB, otherContent);
    expect(responseB.status()).toBe(201);

    // 页面 A 用过期授权提交：必须出现可见错误提示，且仍停留在当前记录。
    await page.getByRole("button", { name: "送出" }).click();
    await expect(page.locator(".notice-bar")).toBeVisible({ timeout: 60_000 });
    await expect(page.locator(".record-heading h1")).toHaveText(record.title);

    // 玩家移除过期选择，改用自然输入继续提交。
    await page.locator(".selected-affordance button").click();
    const retryContent = "我改用自然输入继续。";
    const { response: retryResponse } = await submitMessage(page, retryContent);
    expect(retryResponse.status()).toBe(201);
    await expect(
      page.locator(".event-card.is-committed", { hasText: retryContent }),
    ).toBeVisible({ timeout: 180_000 });

    await contextB.close();
  });
});
