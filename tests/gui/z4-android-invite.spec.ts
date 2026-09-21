import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { GUI_BASE_URL, uniqueName } from "./helpers";

/**
 * Android client-only 邀请粘贴 GUI（Z4 批次）。
 *
 * 形态说明（诚实边界）：桌面 Chromium 加载 src-tauri/ui/index.html +
 * 模拟 __TAURI__（host_kind=android 进入 Android 配置流；
 * validate_invite_url 由 mock invoke 镜像，Rust 规则由 cargo test 覆盖；
 * check_server 经 exposeFunction 对真实隔离服务发起真实 HTTP）。不是
 * Android 真机/WebView 验收。
 *
 * 实测：粘贴完整邀请 URL → 校验 → 真实连接检查 → 真实导航（Playwright
 * 观察目标 URL 带一次性 lobby query）→ Web 深链打开大厅定位目标、不
 * 自动加入 → 回跳壳 origin 读 localStorage 只有根地址；非法链接稳定
 * 报错、不导航、不落盘、不回显凭据。
 */

const SHELL_HTML = readFileSync("src-tauri/ui/index.html", "utf8");

/** 与 Rust normalize_invite_url 同规则的 mock（仅测试壳流程用）。 */
const MOCK_VALIDATE = `(function(input){
  try {
    const url = new URL(String(input).trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    if (!url.hostname || url.username || url.password) throw new Error("credentials");
    if (url.hash) throw new Error("fragment");
    if (url.pathname && url.pathname !== "/") throw new Error("path");
    let lobbyRoomId = null;
    for (const [key, value] of url.searchParams) {
      if (key !== "lobby") throw new Error("unknown query");
      if (lobbyRoomId) throw new Error("duplicate lobby");
      if (!/^lobby_[0-9a-f]{24}$/.test(value)) throw new Error("bad room id");
      lobbyRoomId = value;
    }
    if (url.search && !lobbyRoomId) throw new Error("query without lobby");
    return { serverUrl: url.origin, lobbyRoomId };
  } catch (error) {
    throw error;
  }
})`;

async function bootShell(page: import("@playwright/test").Page, failFirstCheck = false) {
  let checkCount = 0;
  // 真实连接检查：exposeFunction 在 Node 侧 fetch（绕开浏览器 CORS，
  // 语义等价于 Rust reqwest 直连）。
  await page.context().exposeFunction("__realmNodeCheck", async (url: string) => {
    if (failFirstCheck && checkCount++ === 0) throw new Error("synthetic first check failure");
    const response = await fetch(`${url}/`, { redirect: "manual" });
    if (response.status >= 500) throw new Error(`service returned HTTP ${response.status}`);
    return { status: response.status };
  });
  await page.route("http://tauri.local/**", (route) =>
    route.fulfill({ contentType: "text/html", body: SHELL_HTML }));
  await page.addInitScript((mockValidateSource) => {
    const validate = eval(mockValidateSource);
    (window as unknown as Record<string, unknown>).__TAURI__ = {
      core: {
        invoke: async (name: string, invokeArgs: Record<string, unknown>) => {
          if (name === "host_kind") return "android";
          if (name === "validate_invite_url") return validate(invokeArgs?.input);
          if (name === "validate_server_url") {
            const result = validate(invokeArgs?.input);
            return result.serverUrl;
          }
          if (name === "check_server") {
            return (window as unknown as {
              __realmNodeCheck: (url: string) => Promise<unknown>;
            }).__realmNodeCheck(String(invokeArgs?.url));
          }
          throw new Error(`unexpected invoke: ${name}`);
        },
      },
      event: { listen: async () => () => {} },
    };
  }, MOCK_VALIDATE);
  await page.goto("http://tauri.local/");
}

test("Android 壳：粘贴邀请链接 → 连接 → 大厅定位目标（浏览器 mock 壳，非真机）", async ({ page, request }) => {
  // 隔离服务里造一个真实房间（房主身份）。
  const roomName = uniqueName("壳邀请房");
  const create = await request.post(`${GUI_BASE_URL}/api/lobby`, {
    data: { kind: "create-room", name: roomName },
  });
  expect(create.ok()).toBeTruthy();
  const list = await (await request.get(`${GUI_BASE_URL}/api/lobby`)).json() as {
    rooms: { id: string; name: string }[];
  };
  const roomId = list.rooms.find((room) => room.name === roomName)!.id;

  await bootShell(page, true);
  await expect(page.getByLabel(/服务地址/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/服务地址/).fill(`${GUI_BASE_URL}/?lobby=${roomId}`);
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  // 首次检查失败后重试，仍必须保留邀请目标。
  await page.getByRole("button", { name: "重试" }).click();

  // 真实导航：Playwright 直接观察目标 URL（一次性 lobby query）。
  await page.waitForURL(`${GUI_BASE_URL}/?lobby=${roomId}`, { timeout: 30_000 });

  // 落地：大厅打开、目标高亮、不自动加入。
  // 注：mock 壳与房主同身份（GUI 测试员）——房主视角无「加入」按钮，
  // 以成员计数不变 + 房主控件证明「定位但不自动加入」；异身份显式加入
  // 由 z2 双身份套件覆盖。
  await expect(page.locator('[data-testid="lobby-panel"]')).toBeVisible({ timeout: 60_000 });
  const target = page.locator(".lobby-room.is-invite-target", { hasText: roomName });
  await expect(target).toBeVisible({ timeout: 15_000 });
  await expect(target).toContainText("1/4");
  await expect(target.getByRole("button", { name: "成员" })).toBeVisible();
  await expect(target.getByRole("button", { name: "关闭房间" })).toBeVisible();

  // 存储断言：回跳壳 origin 读 localStorage——只有根地址，无 lobby 痕迹。
  await page.goto("http://tauri.local/");
  await expect(page.getByLabel(/服务地址/)).toBeVisible({ timeout: 30_000 });
  const stored = await page.evaluate(() => ({
    serverUrl: localStorage.getItem("realm.serverUrl"),
    keys: Object.keys(localStorage),
  }));
  expect(stored.serverUrl).toBe(GUI_BASE_URL);
  expect(JSON.stringify(stored.keys)).not.toContain("lobby");
});

test("Android 壳：非法邀请链接稳定报错，不导航不落盘（浏览器 mock 壳）", async ({ page }) => {
  await bootShell(page);
  await expect(page.getByLabel(/服务地址/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/服务地址/).fill(
    `http://user:hunter2@127.0.0.1:9999/?lobby=lobby_0123456789abcdef01234567`,
  );
  await page.getByRole("button", { name: "连接" }).click();
  await expect(page.locator("#error")).toContainText("无效");
  expect(page.url()).toBe("http://tauri.local/");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  // 错误消息不回显 userinfo。
  await expect(page.locator("#error")).not.toContainText("hunter2");
});

test("Android 壳：纯服务根地址仍导航根页（回归）", async ({ page }) => {
  await bootShell(page);
  await expect(page.getByLabel(/服务地址/)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel(/服务地址/).fill(GUI_BASE_URL);
  await page.getByRole("button", { name: "连接" }).click();
  // 无 lobby：导航到根页（登录/引导由 Web 端既有流程接管）。
  await page.waitForURL(`${GUI_BASE_URL}/**`, { timeout: 60_000 });
  expect(page.url()).not.toContain("lobby=");
});
