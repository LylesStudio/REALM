import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * 场景图前端闭环 GUI（隔离 server + scratch PG + 真实 LAN ComfyUI）。
 * 前置：scratch DB 已有一条 ready 场景图（store smoke 落库）。
 * 断言：背景层经 CSS 变量换用 /api/files/<id>（图片真实可加载）、
 * 显式按钮点击 → busy → role=status 状态 → ready 后背景仍为 /api/files。
 * 浏览器零自动生成——只在点击后消耗 GPU。
 */
test("场景图：ready 背景渲染 + 显式重新生成闭环", async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await openDemoRecord(page);

  // 既有 ready 背景：::before 的 backgroundImage 换成 /api/files/<id>。
  const layer = page.locator(".record-scene-bg");
  await expect(layer).toBeAttached();
  const before = await layer.evaluate((el) =>
    getComputedStyle(el, "::before").backgroundImage
  );
  expect(before).toContain("/api/files/file_");
  // 图片字节真实可解码（不经背景层间接验证：直接请求 URL）。
  const fileUrl = before.match(/\/api\/files\/[a-z0-9_]+/i)?.[0];
  expect(fileUrl).toBeTruthy();
  const imageResponse = await page.request.get(fileUrl!);
  expect(imageResponse.ok()).toBeTruthy();
  expect(imageResponse.headers()["content-type"]).toBe("image/png");

  // 显式点击重新生成（真实 ComfyUI）：按钮转 busy → 状态条 ready。
  // （语言无关断言：环境 locale 可能是 en/zh；ready 以接口响应为准。）
  const button = page.locator('[data-testid="scene-image-generate"]');
  await expect(button).toBeVisible();
  await expect(button).not.toBeEmpty();
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/api/record/scene-image")
      && response.request().method() === "POST",
    { timeout: 180_000 },
  );
  await button.click();
  await expect(button).toBeDisabled();
  const dispatchResponse = await responsePromise;
  const dispatchBody = await dispatchResponse.json();
  expect(dispatchResponse.ok(), "dispatch 响应必须成功").toBeTruthy();
  expect(dispatchBody.status, "生成必须 ready（落库）").toBe("ready");
  expect(dispatchBody.fileUrl).toMatch(/^\/api\/files\/file_[a-f0-9]+$/);
  const status = page.locator(".record-scene-status");
  await expect(status).toBeVisible();
  await expect(status).not.toBeEmpty();

  // ready 后背景仍是服务端 /api/files 路径（fileId 可能因内容寻址不变）。
  const after = await layer.evaluate((el) =>
    getComputedStyle(el, "::before").backgroundImage
  );
  expect(after).toContain("/api/files/file_");
  await page.screenshot({ path: "/tmp/realm-z7-scene-image.png" });
  expect(pageErrors, "pageerror 必须为零").toEqual([]);
});
