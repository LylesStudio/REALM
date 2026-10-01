import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * 自动场景图控制 GUI（隔离 server + scratch PG；ComfyUI 配置启用但本用例
 * 不消耗 GPU——只验证控制面与排队状态；生成闭环由 worker smoke 覆盖）。
 * 断言：控制按钮可见并显示当前模式；默认/加载时不自动 POST dispatch；
 * 选择模式即 PUT 持久化 + role=status 反馈；queued 请求显示状态徽标；
 * 手动生成按钮保留；pageerror 为零。
 */
test("自动场景图：控制可见、默认不耗 GPU、模式切换持久化、队列状态可见", async ({ page }, testInfo) => {
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

  // 只固定 GET 投影中的 queued 状态；持久化/lease/worker 行为由 PostgreSQL 集成测试覆盖。
  await page.route("**/api/record**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() !== "GET" || url.pathname !== "/api/record"
      || url.searchParams.get("recordId") !== "record_first_watch") {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const envelope = await response.json() as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...envelope, sceneImageJob: { status: "queued", triggerKind: "every_turn" } },
    });
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

  // queued 投影由本测试的 route fixture 固定；真实队列与 worker 由 PostgreSQL smoke 覆盖。
  // worker 心跳不可用时 UI 应给出可观察的等待状态。
  const chip = page.locator('[data-testid="scene-image-job"]');
  await expect(chip).toBeVisible();
  await expect(chip).toContainText(/排队|queued|待ち|等待后台|waiting for background/i);

  // 加载全程零 dispatch POST（不自动耗 GPU）。
  expect(dispatchPosts, "加载/切换模式不得自动 dispatch").toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("scene-auto.png") });
  expect(pageErrors, "pageerror 必须为零").toEqual([]);
});
