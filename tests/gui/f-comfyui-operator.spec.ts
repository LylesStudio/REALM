import http from "node:http";
import { expect, test } from "@playwright/test";
import { createNewUserContext } from "./helpers.ts";

/**
 * F7 ComfyUI operator 边界（M7 收口，离线 scratch）。
 * runner 仅在本 spec 精确目标时向 scratch web server 注入固定 fixture
 * operator principal（principal_f1716031a4a75d60ea = 全局登录账户
 * 「GUI 测试员」的 principalIdForDisplayName 派生值）。
 *
 * 覆盖两条真实 Chromium journey：
 * 1. operator（默认登录态）：表单可见 → endpoint 指向测试进程内真实
 *    loopback fake ComfyUI（ephemeral 端口、只回假 /system_stats JSON）→
 *    保存成功 → 刷新读回 → 测试连接成功 → fake server 收到请求且不带
 *    Authorization。不触真实 ComfyUI/provider/key/公网。
 * 2. 普通 player（新注册账户、独立 browser context）：settings 页无表单/
 *    动作；GET/PUT/POST /api/settings/comfyui 全 403 且 body 不含设置。
 */
test.describe("F7. ComfyUI operator 边界（fixture operator + 普通玩家）", () => {
  test("operator 可保存并测试 loopback fake ComfyUI，刷新后读回", async ({ page, request }) => {
    // F-AUD-2 修正：skip 只看 runner 注入的显式 marker（resolver 派生）；
    // marker 存在时 403 是授权回归，必须失败而非跳过。
    test.skip(
      process.env.REALM_GUI_OPERATOR_FIXTURE !== "1",
      "operator fixture 未注入：仅 `node scripts/test-gui-with-scratch.mjs --project=chromium tests/gui/f-comfyui-operator.spec.ts` 精确目标时运行本正向 journey",
    );

    // fixture 已注入：operator GET 必须 200（403 = 授权回归，显性失败）。
    const gateProbe = await request.get("/api/settings/comfyui");
    expect(
      gateProbe.status(),
      "fixture 注入后 operator GET 必须 200；403 视为授权回归",
    ).toBe(200);

    // 身份绑定：默认登录态必须是 fixture operator principal。
    const me = await request.get("/api/auth/me");
    expect(me.ok()).toBe(true);
    const meBody = await me.json();
    expect(meBody.principalId).toBe("principal_f1716031a4a75d60ea");

    // 测试进程内真实 loopback fake ComfyUI。
    const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
    const fakeComfy = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      if (req.method === "GET" && req.url === "/system_stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ system: { os: "fake" }, devices: [] }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => fakeComfy.listen(0, "127.0.0.1", resolveListen));
    const fakePort = (fakeComfy.address() as { port: number }).port;
    const fakeUrl = `http://127.0.0.1:${fakePort}`;
    try {
      await page.goto("/settings");
      await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });
      const card = page.locator('[data-testid="comfyui-card"]');
      // operator：表单与动作可见（非权限态）。
      await expect(card.locator('[data-testid="comfyui-operator-only"]')).toHaveCount(0);
      const baseUrlInput = card.locator("label", { hasText: "ComfyUI Base URL" }).locator("input");
      await expect(baseUrlInput).toBeVisible({ timeout: 30_000 });

      await baseUrlInput.fill(fakeUrl);
      await card.getByRole("button", { name: "保存图像设置" }).click();
      await expect(card.locator(".settings-notice.is-success")).toContainText(
        "图像生成设置已保存",
        { timeout: 30_000 },
      );

      // 刷新读回：保存的 endpoint 持久化并回显在表单。
      await page.reload();
      await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });
      const cardAfter = page.locator('[data-testid="comfyui-card"]');
      await expect(
        cardAfter.locator("label", { hasText: "ComfyUI Base URL" }).locator("input"),
      ).toHaveValue(fakeUrl, { timeout: 30_000 });

      // 测试连接：fake ComfyUI 收到 GET /system_stats，且无 Authorization。
      await cardAfter.getByRole("button", { name: "测试连接" }).click();
      await expect(cardAfter.locator(".settings-notice.is-success")).toContainText(
        "连接成功",
        { timeout: 30_000 },
      );
      const statsCalls = requests.filter((entry) => entry.url === "/system_stats");
      expect(statsCalls.length).toBeGreaterThan(0);
      expect(statsCalls.every((entry) => entry.authorization === undefined)).toBe(true);
    } finally {
      fakeComfy.closeAllConnections();
      await new Promise((resolveClose) => fakeComfy.close(resolveClose));
    }
  });

  test("普通玩家无表单/动作，GET/PUT/POST 全 403 且不泄露设置", async ({ browser, request }) => {
    const player = await createNewUserContext(browser, request);
    expect(player, "普通玩家注册登录必须成功").not.toBeNull();
    const context = player!.context;
    try {
      const page = await context.newPage();
      await page.goto("/settings");
      await expect(page.locator(".settings-layout")).toBeVisible({ timeout: 60_000 });
      const card = page.locator('[data-testid="comfyui-card"]');
      await expect(card.locator('[data-testid="comfyui-operator-only"]')).toBeVisible({ timeout: 30_000 });
      await expect(card.locator("input")).toHaveCount(0);
      await expect(card.getByRole("button")).toHaveCount(0);

      // API 层全 403，body 不含 settings/地址/key。
      const api = context.request;
      const get = await api.get("/api/settings/comfyui");
      expect(get.status()).toBe(403);
      const put = await api.put("/api/settings/comfyui", {
        data: { enabled: true, baseUrl: "http://127.0.0.1:9" },
      });
      expect(put.status()).toBe(403);
      const post = await api.post("/api/settings/comfyui", {
        data: { action: "test", baseUrl: "http://127.0.0.1:9" },
      });
      expect(post.status()).toBe(403);
      for (const response of [get, put, post]) {
        const body = await response.json();
        expect(body.ok).toBe(false);
        expect(body.settings).toBeUndefined();
        expect(JSON.stringify(body)).not.toContain("apiKey");
        expect(JSON.stringify(body)).not.toContain("127.0.0.1:9");
      }
    } finally {
      await context.close();
    }
  });
});
