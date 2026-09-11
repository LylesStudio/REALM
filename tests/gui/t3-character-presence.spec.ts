import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessageViaApi,
} from "./helpers";

/**
 * 批次 T3 角色在场（docs/development/T3-CHARACTER-PRESENCE.md §4.3）：
 * 未点名真实模型回合提交后，回合外出现非玩家触发的角色自主发声
 * （utterance.committed + data-presence 标记）；预算受控：单回合后 ≤1 条。
 * 全程真实模型，不新增任何 mock。
 */
test.describe("T3. 角色在场 · 回合后自主发声", () => {
  test.setTimeout(600_000);

  test("T3-1 未点名回合后时间线出现非玩家触发的角色事件，预算 ≤1", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);

    // 未点名回合：不指向任何角色 → 插话门沉默，回合后走在场评估。
    expect(
      await submitMessageViaApi(
        request,
        record.id,
        "我沿着防波堤慢慢走，观察雾气与灯塔的变化。",
      ),
    ).toBe(201);

    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 在场事件经既有事件形态落库：时间线上带 data-presence 标记的卡片。
    // 在场回合是回合后异步真实模型生成，给足等待窗口。
    const presenceCard = page.locator("[data-presence]");
    await expect(presenceCard.first()).toBeVisible({ timeout: 180_000 });

    // 形态核验：角色事件（非玩家）、已提交、带三类触发标记之一。
    const card = presenceCard.first();
    await expect(card).toHaveClass(/event-card event-character is-committed/);
    const marker = await card.getAttribute("data-presence");
    expect(["environment", "peer", "hook"]).toContain(marker);
    // 发声内容非空（角色真的开口了）。
    await expect(card).not.toHaveText(/^\s*$/);

    // 预算断言：单回合后至多 1 条在场事件——再等一拍（覆盖一次额外在场
    // 回合的生成窗口），计数仍不得增长。
    await page.waitForTimeout(30_000);
    await expect(presenceCard).toHaveCount(1, { timeout: 30_000 });
  });
});
