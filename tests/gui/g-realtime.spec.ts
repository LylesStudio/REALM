import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  GUI_AUTH_STATE,
  GUI_BASE_URL,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
} from "./helpers";

test.describe("G. 实时同步", () => {
  test("G1 SSE 实时事件：另一会话提交后本页自动出现新事件", async ({
    page,
    request,
    browser,
  }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);
    // SSE 建立连接。
    await expect(page.locator(".sync-state")).toContainText("实时同步", {
      timeout: 30_000,
    });
    const contextB = await browser.newContext({ baseURL: GUI_BASE_URL, storageState: GUI_AUTH_STATE });
    const pageB = await contextB.newPage();
    await pageB.goto("/");
    await openRecordViaLibrary(pageB, record.title);
    const content = "我向大家挥手致意。";
    const { response } = await submitMessage(pageB, content);
    expect(response.status()).toBe(201);
    // 本页不刷新，事件经 SSE 自动出现。
    await expect(
      page.locator(".event-card.is-committed.event-player", { hasText: content }),
    ).toBeVisible({ timeout: 60_000 });
    await contextB.close();
  });

  test("G2 断线回补：断线显示重连状态，恢复后事件回补且时间线连续", async ({
    page,
    request,
    browser,
  }) => {
    const record = await createRecordViaApi(request);
    // 先中断事件流端点（模拟服务暂停），再进入页面：
    // EventSource 首次连接失败即进入重连状态，并持续自动重试。
    await page.route("**/api/record/events**", (route) => route.abort());
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);
    await expect(page.locator(".sync-state")).toContainText("正在重连", {
      timeout: 60_000,
    });
    // 断线期间由另一会话提交新事件。
    const contextB = await browser.newContext({ baseURL: GUI_BASE_URL, storageState: GUI_AUTH_STATE });
    const pageB = await contextB.newPage();
    await pageB.goto("/");
    await openRecordViaLibrary(pageB, record.title);
    const content = "雾中传来一阵脚步声。";
    const { response } = await submitMessage(pageB, content);
    expect(response.status()).toBe(201);
    await contextB.close();
    // 恢复连接：状态回到实时同步，断线期间的事件回补到时间线。
    await page.unroute("**/api/record/events**");
    await expect(page.locator(".sync-state")).toContainText("实时同步", {
      timeout: 60_000,
    });
    await expect(
      page.locator(".event-card.is-committed.event-player", { hasText: content }),
    ).toBeVisible({ timeout: 60_000 });
  });
});
