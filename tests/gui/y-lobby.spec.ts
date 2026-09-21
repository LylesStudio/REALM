import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  openDemoRecord,
  uniqueName,
} from "./helpers";

/**
 * LAN 游戏大厅 GUI 验收（Y 批次）：两个浏览器上下文、两个不同身份，
 * 连接同一隔离服务。实测：创建 → 对端可见 → 密码加入（错/对）→ 双方
 * 成员计数与成员列表更新（SSE 失效 + 权威重读）→ 离开/关闭 → 刷新后
 * 状态来自服务端；375/412 无横向溢出。
 */

async function openLobby(page: Page) {
  await openDemoRecord(page);
  await page.getByRole("button", { name: "大厅" }).click();
  const panel = page.locator('[data-testid="lobby-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

test("大厅：双身份创建/可见/加入/同步/离开/关闭/刷新", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const publicName = uniqueName("公开房");
  const lockedName = uniqueName("密码房");
  const roomPassword = "猎户座密码";

  // ---- 房主（主上下文，GUI 测试员）：创建公开房 + 密码房 ----
  const hostPanel = await openLobby(page);
  await hostPanel.getByLabel("房间名称").fill(publicName);
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  // 等第一间房真正出现（创建成功会清空表单），再填第二间。
  const hostPublic = hostPanel.locator(".lobby-room", { hasText: publicName });
  await expect(hostPublic).toBeVisible({ timeout: 15_000 });
  await expect(hostPublic).toContainText("1/4");
  await hostPanel.getByLabel("房间名称").fill(lockedName);
  await hostPanel.getByLabel("密码（可选）").fill(roomPassword);
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  const hostLocked = hostPanel.locator(".lobby-room", { hasText: lockedName });
  await expect(hostLocked).toBeVisible({ timeout: 15_000 });
  await expect(hostLocked).toContainText("密码房");

  // ---- 客人（第二上下文，不同昵称）----
  const guest = await createNewUserContext(browser, request);
  expect(guest, "隔离 server 需可用账户登录（账户名+可选密码）").not.toBeNull();
  const guestPage = await guest!.context.newPage();
  const guestPanel = await openLobby(guestPage);
  // 公开房与密码房都可见；密码房有锁标记与密码框。
  const guestPublic = guestPanel.locator(".lobby-room", { hasText: publicName });
  const guestLocked = guestPanel.locator(".lobby-room", { hasText: lockedName });
  await expect(guestPublic).toBeVisible({ timeout: 15_000 });
  await expect(guestLocked).toBeVisible();
  await expect(guestLocked).toContainText("密码房");
  await expect(guestLocked.getByLabel("房间密码")).toBeVisible();
  // 房主显示名来自服务端账号，非客户端伪造。
  await expect(guestPublic).toContainText("GUI 测试员");

  // 错误密码：可见反馈，成员不变。
  await guestLocked.getByLabel("房间密码").fill("错误密码");
  await guestLocked.getByRole("button", { name: "加入" }).click();
  await expect(guestPanel.locator(".lobby-error")).toHaveText("密码不正确。");
  await expect(guestLocked).toContainText("1/4");

  // 正确密码加入：双方成员计数经 SSE 失效 + 权威重读更新。
  await guestLocked.getByLabel("房间密码").fill(roomPassword);
  await guestLocked.getByRole("button", { name: "加入" }).click();
  await expect(guestLocked).toContainText("2/4", { timeout: 15_000 });
  await expect(hostLocked).toContainText("2/4", { timeout: 15_000 });

  // 成员列表：房主展开看到两人（含对方昵称）。
  await hostLocked.getByRole("button", { name: "成员" }).click();
  await expect(hostPanel.locator(".lobby-members")).toContainText("GUI 测试员");
  await expect(hostPanel.locator(".lobby-members")).toContainText(guest!.displayName);
  await expect(hostPanel.locator(".lobby-members")).toContainText("房主");

  // 公开房加入 + 离开。
  await guestPublic.getByRole("button", { name: "加入" }).click();
  await expect(guestPublic).toContainText("2/4", { timeout: 15_000 });
  await guestPublic.getByRole("button", { name: "离开" }).click();
  await expect(hostPublic).toContainText("1/4", { timeout: 15_000 });

  // 客人不能关闭房主房间（无按钮）——越权由服务端 403 兜底（PG 测试覆盖）。
  await expect(guestPublic.getByRole("button", { name: "关闭房间" })).toHaveCount(0);

  // 房主关闭密码房；客人端状态经同步更新为已关闭，加入入口消失。
  await hostLocked.getByRole("button", { name: "关闭房间" }).click();
  await expect(guestLocked).toContainText("已关闭", { timeout: 15_000 });
  await expect(
    guestLocked.getByRole("button", { name: "加入" }),
  ).toHaveCount(0);

  // 刷新：客人离开过公开房，状态来自服务端（不是本地缓存）。
  await guestPage.reload({ waitUntil: "commit" });
  const guestPanelAfter = await openLobby(guestPage);
  const publicAfter = guestPanelAfter.locator(".lobby-room", { hasText: publicName });
  await expect(publicAfter).toContainText("1/4", { timeout: 15_000 });
  await expect(
    publicAfter.getByRole("button", { name: "加入" }),
  ).toBeVisible();

  // 375/412 窄屏：大厅无横向溢出。
  for (const width of [375, 412]) {
    await page.setViewportSize({ width, height: 760 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `lobby@${width}: 横向溢出`).toBeLessThanOrEqual(1);
  }
  await guest!.context.close();
});


test("大厅世界绑定：房主绑定自有世界，客人加入后进入共享世界", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const roomName = uniqueName("共享局");

  // 房主创建绑定 demo 世界（烬海诸国，房主即 owner）的房间。
  const hostPanel = await openLobby(page);
  await hostPanel.getByLabel("房间名称").fill(roomName);
  await hostPanel.getByLabel("共享世界（可选）").selectOption({ label: "烬海诸国" });
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  const hostRoom = hostPanel.locator(".lobby-room", { hasText: roomName });
  await expect(hostRoom).toBeVisible({ timeout: 15_000 });
  await expect(hostRoom).toContainText("共享世界 · 烬海诸国");

  // 客人加入绑定房间。
  const guest = await createNewUserContext(browser, request);
  expect(guest).not.toBeNull();
  const guestPage = await guest!.context.newPage();
  const guestPanel = await openLobby(guestPage);
  const guestRoom = guestPanel.locator(".lobby-room", { hasText: roomName });
  await expect(guestRoom).toBeVisible({ timeout: 15_000 });
  await guestRoom.getByRole("button", { name: "加入" }).click();
  await expect(guestRoom).toContainText("2/4", { timeout: 15_000 });

  // 客人获得「进入世界」入口；点击进入共享世界的记录。
  const enterButton = guestRoom.getByRole("button", { name: "进入世界" });
  await expect(enterButton).toBeVisible({ timeout: 15_000 });
  await enterButton.click();
  await guestPage.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await expect(guestPage.locator(".world-nav")).toContainText("烬海诸国");

  // 客人的世界库出现共享世界（membership 生效的读侧证据）。
  await guestPage.getByRole("button", { name: "世界库" }).click();
  await expect(
    guestPage.locator(".library-panel").locator(".library-world", { hasText: "烬海诸国" }),
  ).toBeVisible({ timeout: 15_000 });
  await guest!.context.close();
});


test("大厅 onboarding 入口：新账号从引导屏进入大厅并加入房间", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const roomName = uniqueName("迎客局");

  // 房主先开好一个绑定世界的房间。
  const hostPanel = await openLobby(page);
  await hostPanel.getByLabel("房间名称").fill(roomName);
  await hostPanel.getByLabel("共享世界（可选）").selectOption({ label: "烬海诸国" });
  await hostPanel.getByRole("button", { name: "创建房间" }).click();
  await expect(
    hostPanel.locator(".lobby-room", { hasText: roomName }),
  ).toBeVisible({ timeout: 15_000 });

  // 全新账号：无世界记忆 → 引导屏 → 大厅入口。
  const guest = await createNewUserContext(browser, request);
  expect(guest).not.toBeNull();
  const guestPage = await guest!.context.newPage();
  await guestPage.goto("/");
  await expect(
    guestPage.getByRole("button", { name: /进入游戏大厅/ }),
  ).toBeVisible({ timeout: 60_000 });
  await guestPage.getByRole("button", { name: /进入游戏大厅/ }).click();
  const guestPanel = guestPage.locator('[data-testid="lobby-panel"]');
  await expect(guestPanel).toBeVisible();
  const guestRoom = guestPanel.locator(".lobby-room", { hasText: roomName });
  await expect(guestRoom).toBeVisible({ timeout: 15_000 });
  await guestRoom.getByRole("button", { name: "加入" }).click();
  const enterButton = guestRoom.getByRole("button", { name: "进入世界" });
  await expect(enterButton).toBeVisible({ timeout: 15_000 });
  await enterButton.click();
  await guestPage.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await expect(guestPage.locator(".world-nav")).toContainText("烬海诸国");
  await guest!.context.close();
});
