import { expect, test } from "@playwright/test";
import { uniqueName } from "./helpers";

/**
 * advertised origin GUI 验收（Z3 批次）：隔离 server 以显式
 * REALM_ADVERTISED_ORIGIN=http://192.0.2.10:9999（TEST-NET-1 文档地址，
 * 仅校验形态，不做真实跨设备连接）运行。
 *
 * 实测：分享链接使用显式 origin；面板无 loopback 警告；深链形状兼容
 * （换成可达 origin 后仍能打开大厅并定位目标、不自动加入）。
 */

test("显式 LAN origin：分享链接形态与深链兼容", async ({ page }) => {
  test.setTimeout(120_000);
  const roomName = uniqueName("可达房");

  await page.goto("/?recordId=record_first_watch");
  await page.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "大厅" }).click();
  const panel = page.locator('[data-testid="lobby-panel"]');
  await expect(panel).toBeVisible();

  // 有显式 origin 时不得出现 loopback 警告。
  await expect(panel.locator(".lobby-origin-warning")).toHaveCount(0);
  await expect(panel.locator(".lobby-origin-note")).toContainText("192.0.2.10:9999");

  await panel.getByLabel("房间名称").fill(roomName);
  await panel.getByRole("button", { name: "创建房间" }).click();
  const room = panel.locator(".lobby-room", { hasText: roomName });
  await expect(room).toBeVisible({ timeout: 15_000 });

  // 分享：clipboard fallback，链接使用显式 advertised origin。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await room.getByRole("button", { name: "分享" }).click();
  await expect(panel.locator(".lobby-share-feedback").first()).toContainText(
    /已复制|已分享|手动复制/,
    { timeout: 10_000 },
  );
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(inviteUrl).toMatch(/^http:\/\/192\.0\.2\.10:9999\/\?lobby=lobby_[0-9a-f]+$/);
  expect(inviteUrl).not.toMatch(/password|token|session|world/i);

  // 深链形状兼容：换成实际可达 origin 后仍能定位目标、不自动加入。
  const reachable = inviteUrl.replace("http://192.0.2.10:9999", new URL(page.url()).origin);
  await page.goto(reachable);
  const landed = page.locator('[data-testid="lobby-panel"]');
  await expect(landed).toBeVisible({ timeout: 60_000 });
  await expect(
    landed.locator(".lobby-room.is-invite-target", { hasText: roomName }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    landed.locator(".lobby-room.is-invite-target", { hasText: roomName }),
  ).toContainText("1/4");
});
