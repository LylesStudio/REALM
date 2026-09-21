import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessageViaApi,
} from "./helpers";

test.describe("E. 场景检查器", () => {
  test("E1 角色记忆卡片：内容非空", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    expect(
      await submitMessageViaApi(request, record.id, "我向塞娜打招呼。"),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const memoryCard = page.locator(".memory-card");
    await expect(memoryCard).toBeVisible({ timeout: 60_000 });
    await expect(memoryCard).toContainText("角色记忆 / Memory");
    const representation = memoryCard.locator(".memory-representation");
    await expect(representation).toBeVisible();
    // 批次 T2：萃取在回合提交后异步执行（sync_turn），记忆卡内容轮询等待
    // 后台萃取落库，不做一次性快照断言。
    await expect(representation).not.toHaveText(/^\s*$/, { timeout: 60_000 });
  });

  test("E2 三档深度切换：真实接口重新读取且按钮状态正确", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    expect(
      await submitMessageViaApi(request, record.id, "我检查防波堤的潮痕。"),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);
    const memoryCard = page.locator(".memory-card");
    await expect(memoryCard).toBeVisible({ timeout: 60_000 });

    // 初始为“平衡”。
    await expect(
      memoryCard.locator(".memory-depth button", { hasText: "平衡" }),
    ).toHaveClass(/is-active/);

    const immersiveRequest = page.waitForRequest(
      (req) => req.url().includes("/api/memory") && req.url().includes("depth=immersive"),
      { timeout: 30_000 },
    );
    await memoryCard.locator(".memory-depth button", { hasText: "沉浸" }).click();
    await immersiveRequest;
    await expect(
      memoryCard.locator(".memory-depth button", { hasText: "沉浸" }),
    ).toHaveClass(/is-active/);
    await expect(memoryCard.locator(".memory-representation")).toBeVisible();

    const simpleRequest = page.waitForRequest(
      (req) => req.url().includes("/api/memory") && req.url().includes("depth=simple"),
      { timeout: 30_000 },
    );
    await memoryCard.locator(".memory-depth button", { hasText: "精简" }).click();
    await simpleRequest;
    await expect(
      memoryCard.locator(".memory-depth button", { hasText: "精简" }),
    ).toHaveClass(/is-active/);

    // 窄屏下深度按钮可换行且不溢出卡片。
    await page.setViewportSize({ width: 375, height: 760 });
    const overflow = await memoryCard.evaluate((card) => {
      const depth = card.querySelector(".memory-depth");
      if (!depth) return { ok: false, reason: "no depth container" };
      return {
        ok: (depth as HTMLElement).scrollWidth <= card.clientWidth,
        reason: "",
      };
    });
    expect(overflow.ok, overflow.reason).toBeTruthy();
  });

  test("E3 关系线索：记忆卡片显示已知对象推导的线索", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    expect(
      await submitMessageViaApi(request, record.id, "我记住弥洛提到的铭文。"),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);
    const memoryCard = page.locator(".memory-card");
    await expect(memoryCard).toBeVisible({ timeout: 60_000 });
    await expect(memoryCard.locator(".memory-relationships")).toBeVisible({
      timeout: 60_000,
    });
  });

  test("E4 整理摘要：入口可触发且有进行态反馈", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    expect(
      await submitMessageViaApi(request, record.id, "我总结一下目前的发现。"),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);
    const memoryCard = page.locator(".memory-card");
    await expect(memoryCard).toBeVisible({ timeout: 60_000 });

    const summarize = memoryCard.locator(".memory-summarize");
    await expect(summarize).toBeEnabled();
    const postPromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/memory") && res.request().method() === "POST",
      { timeout: 120_000 },
    );
    await summarize.click();
    // 模型调用偶发失败不算 UI bug，但请求必须真实发出且结束后按钮恢复可用。
    await postPromise;
    await expect(summarize).toBeEnabled({ timeout: 120_000 });
  });
});
