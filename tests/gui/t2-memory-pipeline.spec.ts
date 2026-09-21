import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessageViaApi,
  waitForRecordReady,
} from "./helpers";

/**
 * 批次 T2 记忆管线（docs/development/T2-MEMORY-PIPELINE.md §5.3）：
 * 真实模型回合后 sync_turn 后台异步萃取，记忆卡投影轮询等待落库内容；
 * 第二轮真实模型回合走 prefetch 消费路径，不阻塞、不改变响应形态。
 * 全程真实模型，不新增任何 mock。
 */
test.describe("T2. 记忆管线 · 异步萃取与并行预取", () => {
  test("T2-1 回合提交后异步萃取浮现记忆卡，第二回合预取消费不阻塞", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);

    // 第一轮真实模型回合：回合内写 observations，提交完成后后台萃取。
    expect(
      await submitMessageViaApi(request, record.id, "我向塞娜打招呼，问她记得信使朝哪个方向走了。"),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const memoryCard = page.locator(".memory-card");
    const representation = memoryCard.locator(".memory-representation");
    try {
      await expect(memoryCard).toBeVisible({ timeout: 20_000 });
    } catch {
      // 挂载时 /api/memory 读取若与后台萃取竞态（卡片仅在重新读取后渲染），
      // 直链重进一次重新读取——萃取是幂等后台任务，重读必然可见。
      await page.goto(`/?recordId=${record.id}`);
      await waitForRecordReady(page);
      await expect(memoryCard).toBeVisible({ timeout: 60_000 });
    }
    // 沿用 E1 断言形态：萃取异步落库，轮询等待非空，不做一次性快照断言。
    await expect(representation).not.toHaveText(/^\s*$/, { timeout: 60_000 });

    // 第二轮真实模型回合：prefetch 在回合开始并行发起、请求体组装同步消费
    // 就绪结果——提交必须照常 201，不被召回等待阻塞或改变形态。
    expect(
      await submitMessageViaApi(request, record.id, "我问塞娜对这封信的蜡封有什么印象。"),
    ).toBe(201);

    // 第二回合提交后 sync_turn 再次触发（re-arm）：直链重进刷新读取，
    // 记忆卡投影仍有内容（幂等物化不回退、不丢已有结论）。
    await page.goto(`/?recordId=${record.id}`);
    await waitForRecordReady(page);
    await expect(
      page.locator(".memory-card .memory-representation"),
    ).not.toHaveText(/^\s*$/, { timeout: 60_000 });
  });
});
