import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";
import {
  enableComfyUiForScratch,
  seedReadySceneImage,
  startFakeComfyUi,
} from "../helpers/scene-image-fixture.mjs";

/**
 * 场景图前端闭环 GUI（M7/F-AUD-1 离线化）：隔离 server + scratch PG +
 * 进程内 loopback fake ComfyUI（tests/helpers/scene-image-fixture.mjs）。
 * 断言：预置 ready 背景经 CSS 变量换用 /api/files/<id>（字节真实可加载）、
 * 显式按钮点击 → busy → dispatch ready（fake /prompt→/history→/view 全链
 * 落库）→ 背景仍为 /api/files；fake server 实收请求且不带 Authorization。
 * 零真实 ComfyUI/公网/GPU；浏览器只在点击后触发生成。
 */
test("场景图 ready 背景显示 + 显式重新生成闭环（离线 fake ComfyUI）", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  // 离线 fixture：fake ComfyUI + scratch 设置 + 预置 ready 图。
  const fake = await startFakeComfyUi();
  try {
    await enableComfyUiForScratch(fake.baseUrl);
    await seedReadySceneImage(process.env.DATABASE_URL);

    await openDemoRecord(page);

    // 既有 ready 背景：::before 的 backgroundImage 换成 /api/files/<id>。
    const layer = page.locator(".record-scene-bg");
    await expect(layer).toBeAttached();
    await expect
      .poll(async () => layer.evaluate((el) =>
        getComputedStyle(el, "::before").backgroundImage
      ))
      .toContain("/api/files/file_");
    const before = await layer.evaluate((el) =>
      getComputedStyle(el, "::before").backgroundImage
    );
    // 图片字节真实可解码（不经背景层间接验证：直接请求 URL）。
    const fileUrl = before.match(/\/api\/files\/[a-z0-9_]+/i)?.[0];
    expect(fileUrl).toBeTruthy();
    const imageResponse = await page.request.get(fileUrl!);
    expect(imageResponse.ok()).toBeTruthy();
    expect(imageResponse.headers()["content-type"]).toBe("image/png");

    // 显式点击重新生成（fake ComfyUI）：按钮转 busy → 状态条 ready。
    // （语言无关断言：环境 locale 可能是 en/zh；ready 以接口响应为准。）
    const button = page.locator('[data-testid="scene-image-generate"]');
    await expect(button).toBeVisible();
    await expect(button).not.toBeEmpty();
    const responsePromise = page.waitForResponse(
      (response) => response.url().includes("/api/record/scene-image")
        && response.request().method() === "POST",
      { timeout: 60_000 },
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

    // fake ComfyUI 全链实收：/prompt + /history + /view，且不带 key。
    const paths = fake.requests.map((entry) => `${entry.method} ${entry.path}`);
    expect(paths).toContain("POST /prompt");
    expect(paths).toContain("GET /history/pid_fake_z7");
    expect(paths).toContain("GET /view");
    expect(fake.requests.every((entry) => entry.authorization === undefined)).toBe(true);

    // ready 后背景仍是服务端 /api/files 路径（fileId 可能因内容寻址不变）。
    const after = await layer.evaluate((el) =>
      getComputedStyle(el, "::before").backgroundImage
    );
    expect(after).toContain("/api/files/file_");
    await page.screenshot({ path: testInfo.outputPath("scene-image-ready.png") });
    expect(pageErrors, "pageerror 必须为零").toEqual([]);
  } finally {
    await fake.close();
  }
});
