import { expect, test } from "@playwright/test";

/**
 * 账户名 + 可选密码登录 GUI（隔离 server + scratch PG；服务器环境故意携带
 * 退役 REALM_ACCESS_TOKEN 残留，证明其不再影响启动/登录）。
 * 自建无会话浏览器上下文（不用全局 storageState）。
 * 覆盖：门禁重定向、登录页字段形态（无访问令牌）、无密码账户进入、
 * 密码账户创建/错误拒绝/正确进入、登出回登录页、pageerror 为零。
 */
test("账户名+可选密码登录：无密码进入 / 密码校验 / 退役令牌不影响", async ({ browser, baseURL }) => {
  // 显式空会话（项目级 storageState 不得泄漏进本用例）。
  const context = await browser.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  try {
    // 门禁：无会话访问 / → 重定向登录页。
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);

    // 登录页：账户名 + 密码（可留空），无「访问令牌」字段。
    await expect(page.locator("form.login-card")).toHaveAttribute("data-hydrated", "true");
    const nameInput = page.locator("form.login-card input").first();
    await expect(nameInput).toBeVisible();
    await expect(page.locator('form.login-card input[type="password"]')).toBeVisible();
    await expect(page.locator("form.login-card")).not.toContainText(/访问令牌|Access token|アクセストークン/);

    // 无密码新账户：账户名 + 空密码直接进入。
    const account = `z9旅客${Date.now().toString(36)}`;
    await nameInput.fill(account);
    const submitButton = page.locator('form.login-card button[type="submit"]');
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    // 新账户无「最近打开」记忆 → 落地 onboarding（世界入口屏）。
    await expect(page.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });

    // 登出回登录页。
    await page.request.post("/api/auth/logout");
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("form.login-card")).toHaveAttribute("data-hydrated", "true");

    // 无密码账户：非空密码拒绝（不静默设置/覆盖）。
    await nameInput.fill(account);
    await page.locator('form.login-card input[type="password"]').fill("不该收的密码");
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page.locator('[role="alert"]')).toBeVisible();

    // 密码账户：首次创建带密码 → 登出 → 错误密码拒绝 → 正确密码进入。
    const secured = `z9守密${Date.now().toString(36)}`;
    const create = await page.request.post("/api/auth/login", {
      data: { displayName: secured, password: "灯塔口令" },
    });
    expect(create.ok()).toBeTruthy();
    await page.request.post("/api/auth/logout");
    await page.goto("/login");
    await expect(page.locator("form.login-card")).toHaveAttribute("data-hydrated", "true");
    await page.locator("form.login-card input").first().fill(secured);
    await page.locator('form.login-card input[type="password"]').fill("错误口令");
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page.locator('[role="alert"]')).toBeVisible();
    await page.locator('form.login-card input[type="password"]').fill("灯塔口令");
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });

    await page.screenshot({ path: "/tmp/realm-z9-login.png" });
    expect(pageErrors, "pageerror 必须为零").toEqual([]);
  } finally {
    await context.close();
  }
});
