import { expect, test } from "@playwright/test";
import { openDemoRecord } from "./helpers";

/**
 * Record 场景氛围背景 GUI（隔离 server + scratch PG）。
 * 断言：装饰层存在且 aria-hidden、pointer-events 关闭、图像 URL 为仓库内
 * public 路径、过滤 token 生效（opacity/saturate/contrast 计算值）、前景遮罩
 * 存在；背景不拦截输入（composer 可聚焦）；375/1440 无横向溢出；夜间主题下
 * 遮罩强度 token 切换且不产生 pageerror。
 */

async function assertSceneLayer(page: import("@playwright/test").Page, width: number) {
  const layer = page.locator(".record-scene-bg");
  await expect(layer).toBeAttached();
  await expect(layer).toHaveAttribute("aria-hidden", "true");

  const layerStyle = await layer.evaluate((el) => {
    const style = getComputedStyle(el);
    return { pointerEvents: style.pointerEvents, position: style.position };
  });
  expect(layerStyle.pointerEvents).toBe("none");
  expect(layerStyle.position).toBe("absolute");

  const imageStyle = await layer.evaluate((el) => {
    const before = getComputedStyle(el, "::before");
    return {
      backgroundImage: before.backgroundImage,
      opacity: before.opacity,
      filter: before.filter,
    };
  });
  expect(imageStyle.backgroundImage).toContain("/scenes/record-scene-v0.png");
  expect(Number(imageStyle.opacity)).toBeLessThan(1);
  expect(imageStyle.filter).toContain("saturate");

  const veil = await layer.evaluate((el) =>
    getComputedStyle(el, "::after").backgroundImage
  );
  expect(veil).toContain("linear-gradient");
  // 古籍装裱边缘（可观测契约，非像素断言）：偏心径向做旧 + 版心框线。
  expect(veil).toContain("radial-gradient");
  const plate = await layer.evaluate((el) => {
    const after = getComputedStyle(el, "::after");
    return { outlineStyle: after.outlineStyle, outlineOffset: after.outlineOffset };
  });
  expect(plate.outlineStyle).toBe("solid");
  expect(
    Number.parseFloat(plate.outlineOffset),
    "版心框线必须收进层内缘（负 offset）",
  ).toBeLessThan(0);

  // 背景不拦截输入：composer 文本框可点击聚焦。
  const composer = page.locator("#realm-message");
  await composer.click();
  await expect(composer).toBeFocused();

  // 时间线与标题仍是可见前景。
  await expect(page.locator(".record-heading h1")).toBeVisible();
  await expect(page.locator(".timeline-scroll")).toBeVisible();

  // 无横向溢出（本批次作用面 = record-main；文档级 header 溢出为既有问题，
  // 与本层无关——probe 中和本层规则后 overflow 不变，见交付报告）。
  const overflow = await page.evaluate(() => {
    const main = document.querySelector(".record-main");
    return {
      recordMain: main ? main.scrollWidth - main.clientWidth : 0,
      document: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
  expect(overflow.recordMain, `record-main 横向溢出 @${width}px`).toBeLessThanOrEqual(1);
  // 既有 header 溢出只记录不拦截（中性化实验证明与本层无关）。
  console.log(`[z6] document-level overflow @${width}px: ${overflow.document}px（既有 header 问题，非本批范围）`);
}

test.describe("Z6 record scene background", () => {
  for (const width of [375, 1440]) {
    test(`场景背景层结构/交互/溢出 @${width}px`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      await page.setViewportSize({ width, height: width === 375 ? 760 : 900 });
      await openDemoRecord(page);
      await assertSceneLayer(page, width);
      await page.screenshot({ path: `/tmp/realm-z6-record-scene-${width}.png` });
      expect(pageErrors, "pageerror 必须为零").toEqual([]);
    });
  }

  test("夜间主题：遮罩 token 切换且背景层仍克制", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => {
      window.localStorage.setItem("realm.theme", "night");
    });
    await openDemoRecord(page);
    const veilStrength = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--record-scene-veil-strength")
        .trim()
    );
    expect(veilStrength).toBe("84%");
    await assertSceneLayer(page, 1440);
    await page.screenshot({ path: "/tmp/realm-z6-record-scene-night.png" });
    expect(pageErrors, "夜间 pageerror 必须为零").toEqual([]);
  });
});
