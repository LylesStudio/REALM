import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  openDemoRecord,
  uniqueName,
} from "./helpers";

/**
 * 大厅收口 GUI（Z5 批次）：pageerror/console error 为零、长房名无溢出、
 * 邀请高亮关闭后不残留、大厅/世界库互斥、SSE 断线提示不阻断操作。
 * 隔离 server + 一次性 scratch PG 运行。
 */

interface ConsoleWatch {
  errors: { text: string; url: string }[];
  pageErrors: string[];
}

function watchConsole(page: Page): ConsoleWatch {
  const watch: ConsoleWatch = { errors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") {
      watch.errors.push({ text: message.text(), url: message.location().url });
    }
  });
  page.on("pageerror", (error) => watch.pageErrors.push(String(error)));
  return watch;
}

async function openLobby(page: Page) {
  await openDemoRecord(page);
  await page.getByRole("button", { name: "大厅" }).click();
  const panel = page.locator('[data-testid="lobby-panel"]');
  await expect(panel).toBeVisible();
  return panel;
}

test("大厅收口：零页面错误、长房名、互斥、断线提示不阻断、stale 高亮清除", async ({ browser, page, request }) => {
  test.setTimeout(180_000);
  const hostWatch = watchConsole(page);
  const longName = uniqueName("长房名") + "长长长长长长长长长长长长长长长长";
  const roomName = uniqueName("收口房");

  // 创建：长房名 + 普通房。
  const panel = await openLobby(page);
  await panel.getByLabel("房间名称").fill(longName);
  await panel.getByRole("button", { name: "创建房间" }).click();
  const longRoom = panel.locator(".lobby-room", { hasText: longName.slice(0, 20) });
  await expect(longRoom).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel("房间名称").fill(roomName);
  await panel.getByRole("button", { name: "创建房间" }).click();
  const room = panel.locator(".lobby-room", { hasText: roomName });
  await expect(room).toBeVisible({ timeout: 15_000 });

  // 长房名 375px 无横向溢出（大厅面板开着时）。
  await page.setViewportSize({ width: 375, height: 760 });
  const overflow375 = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow375, "长房名@375 横向溢出").toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1440, height: 900 });

  // 大厅/世界库互斥：开世界库后大厅关；回大厅后世界库关。
  await page.getByRole("button", { name: "关闭大厅" }).click();
  await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "世界库" }).click();
  await expect(page.locator(".library-panel")).toBeVisible();
  await expect(page.locator('[data-testid="lobby-panel"]')).toHaveCount(0);
  await page.getByRole("button", { name: "关闭世界库" }).click();

  // 邀请深链 → 高亮；关闭大厅后再打开 → 无 stale 高亮。
  const list = await (await request.get("/api/lobby")).json() as {
    rooms: { id: string; name: string }[];
  };
  const targetId = list.rooms.find((entry) => entry.name === roomName)!.id;
  await page.goto(`/?recordId=record_first_watch&lobby=${targetId}`);
  const invited = page.locator('[data-testid="lobby-panel"]');
  await expect(invited).toBeVisible({ timeout: 60_000 });
  await expect(
    invited.locator(".lobby-room.is-invite-target", { hasText: roomName }),
  ).toBeVisible({ timeout: 15_000 });
  await invited.getByRole("button", { name: "关闭大厅" }).click();
  await expect(invited).toBeHidden();
  await page.getByRole("button", { name: "大厅" }).click();
  const reopened = page.locator('[data-testid="lobby-panel"]');
  await expect(reopened).toBeVisible();
  await expect(reopened.locator(".is-invite-target")).toHaveCount(0);

  // SSE 断线：拦截大厅事件流失败 → 提示出现但加入操作仍可用。
  await page.route("**/api/lobby/events", (route) => route.abort());
  const guest = await createNewUserContext(browser, request);
  expect(guest).not.toBeNull();
  const guestPage = await guest!.context.newPage();
  const guestWatch = watchConsole(guestPage);
  await guestPage.route("**/api/lobby/events", (route) => route.abort());
  await guestPage.goto("/?recordId=record_first_watch");
  await guestPage.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await guestPage.getByRole("button", { name: "大厅" }).click();
  const guestPanel = guestPage.locator('[data-testid="lobby-panel"]');
  await expect(guestPanel).toBeVisible();
  await expect(guestPanel.locator(".lobby-offline")).toBeVisible({ timeout: 15_000 });
  // 断线提示不阻断：客人仍能加入公开房（权威重读与写路径独立于 SSE）。
  const guestRoom = guestPanel.locator(".lobby-room", { hasText: roomName });
  await expect(guestRoom).toBeVisible();
  await guestRoom.getByRole("button", { name: "加入" }).click();
  await expect(guestRoom).toContainText("2/4", { timeout: 15_000 });
  // 展开成员后离开：成功重读必须回到列表，不能用失效成员查询卡死。
  await guestRoom.getByRole("button", { name: "成员" }).click();
  await guestRoom.getByRole("button", { name: "离开" }).click();
  await expect(guestRoom.getByRole("button", { name: "加入" })).toBeVisible({ timeout: 15_000 });
  await expect(guestRoom).toContainText("1/4", { timeout: 15_000 });

  await guest!.context.close();
  // 收尾：两端 pageerror/console error 为零（vite 噪音不计）。
  const realErrors = [...hostWatch.pageErrors, ...guestWatch.pageErrors];
  expect(realErrors, "页面级异常必须为零").toEqual([]);
  const consoleErrors = [...hostWatch.errors, ...guestWatch.errors];
  const unexpectedConsoleErrors = consoleErrors.filter((entry) =>
    !(entry.text === "Failed to load resource: net::ERR_FAILED"
      && entry.url.includes("/api/lobby/events"))
  );
  expect(unexpectedConsoleErrors, "console error 必须为零（排除主动 SSE 断线模拟）").toEqual([]);
});
