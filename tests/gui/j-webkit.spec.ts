import { expect, test } from "@playwright/test";
import { createRecordViaApi, openDemoRecord, openRecordViaLibrary } from "./helpers";

/**
 * J 组用例在 Chromium 与 WebKit 上各跑一遍；WebKit 视作 Safari 引擎近似。
 * J4（差异修复回归）由本文件全部用例在 WebKit 项目下通过来验证。
 */
test.describe("J. Safari / WebKit 窗口与视口", () => {
  test("J1 视口高度回退与文本缩放保护", async ({ page }) => {
    // 桌面：固定壳层布局，100dvh 回退链生效，壳层高度等于窗口高度。
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDemoRecord(page);
    const readMetrics = () =>
      page.evaluate(async () => {
        const shell = document.querySelector(".realm-shell");
        const htmlStyle = getComputedStyle(document.documentElement);
        // 部分 WebKit 移植（如 WPE）不在 getComputedStyle/CSSOM 中暴露
        // -webkit-text-size-adjust；回退为读取样式表原文验证声明存在
        // （任务允许的 CSS 回退链检查）。
        const cssTexts: string[] = [];
        for (const sheet of Array.from(document.styleSheets)) {
          if (sheet.href) {
            cssTexts.push(
              await fetch(sheet.href).then((res) => res.text()).catch(() => ""),
            );
          } else if (sheet.ownerNode) {
            cssTexts.push((sheet.ownerNode as HTMLElement).textContent ?? "");
          }
        }
        return {
          innerHeight: window.innerHeight,
          bodyHeight: document.body.clientHeight,
          shellHeight: shell ? (shell as HTMLElement).clientHeight : 0,
          textSizeAdjust:
            htmlStyle.getPropertyValue("-webkit-text-size-adjust")
            || htmlStyle.getPropertyValue("text-size-adjust"),
          textSizeAdjustDeclared: cssTexts.join("\n").includes("text-size-adjust"),
        };
      });
    const desktop = await readMetrics();
    expect(Math.abs(desktop.shellHeight - desktop.innerHeight)).toBeLessThanOrEqual(2);
    expect(Math.abs(desktop.bodyHeight - desktop.innerHeight)).toBeLessThanOrEqual(2);
    // 引擎实现该属性时断言计算值；否则至少要求样式表声明存在（CSSOM 回退链检查）。
    expect(desktop.textSizeAdjustDeclared).toBeTruthy();
    if (desktop.textSizeAdjust !== "") {
      expect(desktop.textSizeAdjust).toBe("100%");
    }
    // 输入区完整落在视口内，不被窗口底部裁切。
    const composerBox = await page.locator(".message-composer").boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
      desktop.innerHeight + 1,
    );

    // 手机宽度：页面滚动布局，壳层至少占满视口（min-height 100dvh 回退）。
    await page.setViewportSize({ width: 390, height: 700 });
    const mobile = await readMetrics();
    expect(mobile.shellHeight).toBeGreaterThanOrEqual(mobile.innerHeight - 2);
    expect(mobile.textSizeAdjustDeclared).toBeTruthy();
    if (mobile.textSizeAdjust !== "") {
      expect(mobile.textSizeAdjust).toBe("100%");
    }
    // 输入区可滚动进入视口并完整可见（无底部裁切）。
    await page.locator(".message-composer").scrollIntoViewIfNeeded();
    const mobileComposer = await page.locator(".message-composer").boundingBox();
    expect(mobileComposer).not.toBeNull();
    expect(mobileComposer!.y).toBeGreaterThanOrEqual(-1);
    expect(mobileComposer!.y + mobileComposer!.height).toBeLessThanOrEqual(
      mobile.innerHeight + 1,
    );
  });

  test("J2 滚动、弹层与输入聚焦无窗口跳动", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    await page.setViewportSize({ width: 390, height: 700 });
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 时间线容器是独立的纵向滚动区。
    const timeline = page.locator(".timeline-scroll");
    const overflowY = await timeline.evaluate(
      (node) => getComputedStyle(node).overflowY,
    );
    expect(["auto", "scroll"]).toContain(overflowY);

    // 聚焦输入框（移动 Safari 会弹出键盘）不产生横向位移或宽度跳动。
    const before = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollX: window.scrollX,
    }));
    await page.locator("#realm-message").focus();
    await page.locator("#realm-message").fill("聚焦测试");
    const after = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollX: window.scrollX,
    }));
    expect(after.width).toBe(before.width);
    expect(after.scrollX).toBe(before.scrollX);

    // 世界库弹层完整落在视口内。
    await page.getByRole("button", { name: "世界库" }).click();
    const panel = page.locator(".library-panel");
    await expect(panel).toBeVisible();
    const panelBox = (await panel.boundingBox())!;
    expect(panelBox.x).toBeGreaterThanOrEqual(-1);
    expect(panelBox.y).toBeGreaterThanOrEqual(-1);
    const viewport = page.viewportSize()!;
    expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(panelBox.y + panelBox.height).toBeLessThanOrEqual(viewport.height + 1);
  });

  test("J3 窗口 resize：桌面↔手机布局正确切换且无残留错位", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openDemoRecord(page);

    const grid = page.locator(".realm-grid");
    const readDisplay = () =>
      grid.evaluate((node) => getComputedStyle(node).display);
    expect(await readDisplay()).toBe("grid");

    await page.setViewportSize({ width: 375, height: 720 });
    await expect(page.locator("#realm-message")).toBeVisible();
    // 手机宽度下主网格切换为纵向 flex。
    expect(await readDisplay()).toBe("flex");
    let overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await readDisplay()).toBe("grid");
    overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    // 三栏元素恢复可见且无错位。
    await expect(page.locator(".world-nav")).toBeVisible();
    await expect(page.locator(".scene-inspector")).toBeVisible();
  });
});
