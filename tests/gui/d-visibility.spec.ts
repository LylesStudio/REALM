import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
} from "./helpers";

const SECRET_TEXT = "我悄悄对塞娜说：不要让其他人听到，密函先由我来保管。";
const SECRET_TEXT_2 = "我低声只告诉弥洛：信函上的铭文不要声张。";

test.describe("D. 可见性确认", () => {
  test("D1 密谋预判：出现发送前确认卡片，不直接公开落库", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const { response } = await submitMessage(page, SECRET_TEXT);
    expect(response.status()).toBe(428);

    const proposal = page.locator(".visibility-proposal");
    await expect(proposal).toBeVisible();
    await expect(proposal).toContainText("DM 判断这条内容可能只适合部分角色知道");
    await expect(proposal.getByRole("button", { name: "仅目标可听" })).toBeVisible();
    await expect(proposal.getByRole("button", { name: "公开说出" })).toBeVisible();
    // 未确认前不写入时间线。
    await expect(
      page.locator(".event-card", { hasText: "密函先由我来保管" }),
    ).toHaveCount(0);
  });

  test("D2 确认“仅目标可听”：201 且事件带受限可见性，卡片消失", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 真实模型偶发失败不算 UI bug：确认提交失败时按真实用户行为重试整轮。
    let status = 0;
    for (let round = 0; round < 3 && status !== 201; round += 1) {
      await submitMessage(page, SECRET_TEXT);
      const proposal = page.locator(".visibility-proposal");
      await expect(proposal).toBeVisible();
      const confirmPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: 180_000 },
      );
      await proposal.getByRole("button", { name: "仅目标可听" }).click();
      status = (await confirmPromise).status();
    }
    expect(status).toBe(201);

    await expect(page.locator(".visibility-proposal")).toHaveCount(0);
    const card = page.locator(".event-card.is-committed", {
      hasText: "密函先由我来保管",
    });
    await expect(card).toBeVisible({ timeout: 180_000 });
    // 受限可见性在时间线上有明确标签（限定可见或上帝视角 OOC 标注）。
    await expect(card.locator(".event-stamps")).toContainText(
      /限定可见|当前角色未知|受限/,
    );
  });

  test("D3 确认“公开发送”：201 且事件公开", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    let status = 0;
    for (let round = 0; round < 3 && status !== 201; round += 1) {
      await submitMessage(page, SECRET_TEXT_2);
      const proposal = page.locator(".visibility-proposal");
      await expect(proposal).toBeVisible();
      const confirmPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: 180_000 },
      );
      await proposal.getByRole("button", { name: "公开说出" }).click();
      status = (await confirmPromise).status();
    }
    expect(status).toBe(201);

    await expect(page.locator(".visibility-proposal")).toHaveCount(0);
    const card = page.locator(".event-card.is-committed", {
      hasText: "信函上的铭文不要声张",
    });
    await expect(card).toBeVisible({ timeout: 180_000 });
    await expect(card.locator(".event-stamps")).not.toContainText("限定可见");
  });

  test("D4 取消确认：草稿保留，可修改后重新提交", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    await submitMessage(page, SECRET_TEXT);
    const proposal = page.locator(".visibility-proposal");
    await expect(proposal).toBeVisible();

    await proposal.getByRole("button", { name: "取消可见范围确认" }).click();
    await expect(proposal).toHaveCount(0);

    const input = page.locator("#realm-message");
    await expect(input).toHaveValue(SECRET_TEXT);
    // 草稿可修改。
    await input.fill(`${SECRET_TEXT}（改口）算了，当我没说。`);
    await expect(input).toHaveValue(/算了，当我没说。$/);
  });
});
