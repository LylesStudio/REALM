import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * 自动场景图控制 GUI（隔离 server + scratch PG；ComfyUI 配置启用但本用例
 * 不消耗 GPU——只验证控制面与排队状态；生成闭环由 worker smoke 覆盖）。
 * 断言：控制按钮可见并显示当前模式；默认/加载时不自动 POST dispatch；
 * 选择模式即 PUT 持久化 + role=status 反馈；queued 请求显示状态徽标；
 * 手动生成按钮保留；pageerror 为零。
 */
test("自动场景图：控制可见、默认不耗 GPU、模式切换持久化、队列状态可见", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  // 网络监听：加载期间不得有 scene-image dispatch POST。
  const dispatchPosts: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/record/scene-image") && request.method() === "POST") {
      dispatchPosts.push(request.url());
    }
  });

  await openDemoRecord(page);

  // 手动生成按钮保留。
  await expect(page.locator('[data-testid="scene-image-generate"]')).toBeVisible();

  // 自动控制：可见，显示当前模式（off）。
  const toggle = page.locator('[data-testid="scene-auto-toggle"]');
  await expect(toggle).toBeVisible();
  await expect(toggle).toContainText(/关|Off|オフ/);

  // 打开 popover：三个模式按钮可见。
  await toggle.click();
  const menu = page.locator(".scene-auto-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("button")).toHaveCount(3);

  // 选择 every_turn：PUT 200 + 按钮文案更新 + status 反馈。
  const putResponse = page.waitForResponse(
    (response) => response.url().includes("/api/settings/scene-image")
      && response.request().method() === "PUT",
  );
  await menu.getByRole("button", { name: /每次对话|every turn|毎ターン/i }).click();
  const saved = await putResponse;
  expect(saved.ok()).toBeTruthy();
  await expect(toggle).toContainText(/每次对话|every turn|毎ターン/i);
  await expect(menu.locator(".scene-auto-notice")).toBeVisible();

  // 刷新后模式保持（账号级持久化，非 localStorage）。
  await page.reload();
  await expect(toggle).toContainText(/每次对话|every turn|毎ターン/i, { timeout: 60_000 });

  // 恢复 off（不把偏好留在 scratch 之外的任何状态；也验证可关）。
  await toggle.click();
  const menuAgain = page.locator(".scene-auto-menu");
  const offResponse = page.waitForResponse(
    (response) => response.url().includes("/api/settings/scene-image")
      && response.request().method() === "PUT",
  );
  await menuAgain.getByRole("button", { name: /关闭|^Off$|オフ/ }).click();
  expect((await offResponse).ok()).toBeTruthy();
  await expect(toggle).toContainText(/关|Off|オフ/);

  // queued 意图徽标（本 scratch 由 smoke 前预置 queued 行；无 worker 时保持 queued）。
  // worker 心跳不可用（GUI scratch 不起 worker）时文案为「等待后台 Worker」，
  // 与真正的「排队中」区分——两种都是安全可观测状态。
  const chip = page.locator('[data-testid="scene-image-job"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/排队|queued|待ち|等待后台|waiting for background/i);

  // 加载全程零 dispatch POST（不自动耗 GPU）。
  expect(dispatchPosts, "加载/切换模式不得自动 dispatch").toEqual([]);
  await page.screenshot({ path: "/tmp/realm-z8-scene-auto.png" });
  expect(pageErrors, "pageerror 必须为零").toEqual([]);
});
