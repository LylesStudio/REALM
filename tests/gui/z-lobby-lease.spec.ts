import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  openDemoRecord,
  uniqueName,
} from "./helpers";

/**
 * 大厅房主租约 GUI 验收（Z 批次）：隔离 server 以短租约运行
 * （REALM_LOBBY_LEASE_MS=3000 / REALM_LOBBY_REAP_MS=1000；客户端心跳
 * 频率由 GET /api/lobby meta 下发 = 1s）。
 *
 * 实测：房主页面在线时房间跨 TTL 保持 open（心跳生效）→ 房主页面关闭
 * （心跳停止）→ 客人经 SSE 回收通知看到「已关闭」→ 过期房间不可加入。
 * 权威状态全部来自服务端时钟；客户端本地时间不参与。
 */

async function openLobby(page: Page) {
  await openDemoRecord(page);
  await page.getByRole("button", { name: "大厅" }).click();
  const panel = page.locator('[data-testid="lobby-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

test("房主在线续租保持开放；房主离线后客人看到自动关闭", async ({ browser, page, request }) => {
  test.setTimeout(120_000);
  const roomName = uniqueName("租约局");

  // 房主创建房间并关闭大厅面板（心跳由根组件驱动，不依赖面板开着）。
  const hostPanel = await openLobby(page);
  await hostPanel.getByLabel("房间名称").fill(roomName);
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  const hostRoom = hostPanel.locator(".lobby-room", { hasText: roomName });
  await expect(hostRoom).toBeVisible({ timeout: 15_000 });
  // 房主可见托管提示（租约语义对玩家可见）。
  await expect(hostRoom.locator(".lobby-lease-note")).toContainText("托管中");
  await hostPanel.getByRole("button", { name: "关闭大厅" }).click();
  await expect(hostPanel).toBeHidden();

  // 客人端看到开放房间。
  const guest = await createNewUserContext(browser, request);
  expect(guest).not.toBeNull();
  const guestPage = await guest!.context.newPage();
  const guestPanel = await openLobby(guestPage);
  const guestRoom = guestPanel.locator(".lobby-room", { hasText: roomName });
  await expect(guestRoom).toBeVisible({ timeout: 15_000 });
  await expect(guestRoom.getByRole("button", { name: "加入" })).toBeVisible();

  // 房主在线（页面开着，根组件每 1s 续租）：跨过 TTL 房间仍开放。
  await guestPage.waitForTimeout(4_500);
  await expect(
    guestRoom.getByRole("button", { name: "加入" }),
    "房主在线续租期间房间不得被回收",
  ).toBeVisible();

  // 房主离线：整个页面关闭 → 心跳停止 → 租约到期 → 回收 → 客人看到关闭。
  await page.close();
  await expect(guestRoom).toContainText("已关闭", { timeout: 20_000 });
  await expect(
    guestRoom.getByRole("button", { name: "加入" }),
    "过期房间不得再出现加入入口",
  ).toHaveCount(0);

  await guest!.context.close();
});
