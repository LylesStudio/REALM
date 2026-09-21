import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  uniqueName,
} from "./helpers";

/**
 * 大厅邀请链路 GUI 验收（Z2 批次）：房主分享 → 复制链接（clipboard
 * fallback，Chromium 无 Web Share）→ 第二身份打开链接 → 大厅自动打开并
 * 定位高亮目标 → 显式加入（公开 + 密码房错误/正确）→ 失效/不存在目标
 * 的稳定提示。不自动加入；链接只含不透明 roomId。
 */

async function openLobby(page: Page) {
  await page.goto("/?recordId=record_first_watch");
  await page.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await page.getByRole("button", { name: "大厅" }).click();
  const panel = page.locator('[data-testid="lobby-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

test("邀请链接：分享→落地定位→显式加入→失效目标稳定提示", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const publicName = uniqueName("邀请公开房");
  const lockedName = uniqueName("邀请密码房");
  const password = "猎户座密码";

  // 房主创建两间房并分享公开房链接（clipboard fallback）。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const hostPanel = await openLobby(page);
  await hostPanel.getByLabel("房间名称").fill(publicName);
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  const hostPublic = hostPanel.locator(".lobby-room", { hasText: publicName });
  await expect(hostPublic).toBeVisible({ timeout: 15_000 });
  await hostPanel.getByLabel("房间名称").fill(lockedName);
  await hostPanel.getByLabel("密码（可选）").fill(password);
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  const hostLocked = hostPanel.locator(".lobby-room", { hasText: lockedName });
  await expect(hostLocked).toBeVisible({ timeout: 15_000 });

  // 分享：无 Web Share 的 headless Chromium 走 clipboard；有可见反馈。
  await hostPublic.getByRole("button", { name: "分享" }).click();
  await expect(hostPanel.locator(".lobby-share-feedback").first()).toContainText(
    /已复制|已分享|手动复制/,
    { timeout: 10_000 },
  );
  // 默认（无 REALM_ADVERTISED_ORIGIN）loopback 运行：必须有「仅本机
  // 可用」提示，不暗示跨设备可达；链接回退到当前 loopback origin。
  await expect(hostPanel.locator(".lobby-origin-warning").first()).toContainText(
    "仅本机可用",
  );
  const inviteUrl = await page.evaluate(() => navigator.clipboard.readText());
  expect(inviteUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?lobby=lobby_[0-9a-f]+$/);
  // 链接最小化：无密码/token/session/世界 id。
  expect(inviteUrl).not.toMatch(/password|token|session|world/i);

  // 第二身份打开链接：大厅自动打开、目标房间高亮定位、不自动加入。
  const guest = await createNewUserContext(browser, request);
  expect(guest).not.toBeNull();
  const guestPage = await guest!.context.newPage();
  await guestPage.goto(inviteUrl);
  const guestPanel = guestPage.locator('[data-testid="lobby-panel"]');
  await expect(guestPanel).toBeVisible({ timeout: 60_000 });
  const guestPublic = guestPanel.locator(".lobby-room.is-invite-target", { hasText: publicName });
  await expect(guestPublic).toBeVisible({ timeout: 15_000 });
  // URL 参数已剥离（一次性导航提示）。
  expect(guestPage.url()).not.toContain("lobby=");
  // 不自动加入：目标房间仍是 1/4，加入入口在。
  await expect(guestPublic).toContainText("1/4");
  await guestPublic.getByRole("button", { name: "加入" }).click();
  await expect(guestPublic).toContainText("2/4", { timeout: 15_000 });

  // 密码房深链：可见但锁定，加入仍需显式密码（错误→可见反馈；正确→成功）。
  const hostLockedId = inviteUrl.replace(/lobby=lobby_[0-9a-f]+/, "lobby=")
    + await hostLocked.getAttribute("data-room-id");
  await guestPage.goto(hostLockedId);
  const guestLocked = guestPanel.locator(".lobby-room.is-invite-target", { hasText: lockedName });
  await expect(guestLocked).toBeVisible({ timeout: 60_000 });
  await expect(guestLocked).toContainText("密码房");
  await guestLocked.getByLabel("房间密码").fill("错误密码");
  await guestLocked.getByRole("button", { name: "加入" }).click();
  await expect(guestPanel.locator(".lobby-error")).toHaveText("密码不正确。");
  await guestLocked.getByLabel("房间密码").fill(password);
  await guestLocked.getByRole("button", { name: "加入" }).click();
  await expect(guestLocked).toContainText("2/4", { timeout: 15_000 });

  // 失效目标：不存在的 roomId → 稳定提示，不泄露成员详情、不自动加入。
  await guestPage.goto(`${new URL(inviteUrl).origin}/?lobby=lobby_nope`);
  await expect(guestPanel).toBeVisible({ timeout: 60_000 });
  await expect(guestPanel.locator(".lobby-invite-note")).toContainText(
    "邀请的房间不存在、已关闭或已失效。",
    { timeout: 15_000 },
  );
  await expect(guestPanel.locator(".lobby-members")).toHaveCount(0);

  // 已关闭房间：房主关闭公开房后，客人重复打开链接 → 卡片显示已关闭、无加入入口。
  await hostPublic.getByRole("button", { name: "关闭房间" }).click();
  await expect(hostPublic).toContainText("已关闭", { timeout: 15_000 });
  await guestPage.goto(inviteUrl);
  const closedTarget = guestPanel.locator(".lobby-room.is-invite-target", { hasText: publicName });
  await expect(closedTarget).toContainText("已关闭", { timeout: 60_000 });
  await expect(closedTarget.getByRole("button", { name: "加入" })).toHaveCount(0);

  await guest!.context.close();
});
