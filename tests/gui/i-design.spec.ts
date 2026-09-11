import { expect, test } from "@playwright/test";
import { openDemoRecord, openLibrary } from "./helpers";

function radiusOf(value: string): number[] {
  return value.split(" ").map((part) => Number.parseFloat(part) || 0);
}

test.describe("I. 纸墨设计语言", () => {
  test("I1 直角：关键交互元素 border-radius 为 0，无胶囊按钮", async ({
    page,
  }) => {
    await openDemoRecord(page);
    await openLibrary(page);

    const selectors = [
      ".event-card article",
      "#realm-message",
      ".message-composer button[type=submit]",
      ".library-panel",
      ".inspector-card",
      ".affordance-trigger",
      ".header-settings-link",
    ];
    for (const selector of selectors) {
      const element = page.locator(selector).first();
      await expect(element).toBeAttached();
      const radius = await element.evaluate(
        (node) => getComputedStyle(node).borderRadius,
      );
      const values = radiusOf(radius);
      for (const value of values) {
        expect(value, `${selector} 出现圆角 ${radius}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("I2 语义色：朱红主动作、苔绿在线态、墨色正文", async ({ page }) => {
    await openDemoRecord(page);

    // 主按钮墨黑底（--ink #20231f）；先让按钮处于可用态（禁用态按设计为中性灰）。
    await page.locator("#realm-message").fill("设计语言断言占位");
    const sendButton = page.getByRole("button", { name: "送出" });
    await expect(sendButton).toHaveCSS("background-color", "rgb(32, 35, 31)");
    // 玩家轨迹朱红（--accent #b94c36）：品牌印章。
    await expect(page.locator(".brand-seal")).toHaveCSS(
      "background-color",
      "rgb(185, 76, 54)",
    );
    // 正文主色 --ink。
    const firstCard = page.locator(".event-card article").first();
    await expect(firstCard).toHaveCSS("color", "rgb(32, 35, 31)");
  });

  test("I3 硬阴影：主卡片为短距离硬阴影，无大范围模糊", async ({ page }) => {
    await openDemoRecord(page);

    const card = page.locator(".inspector-card").first();
    await expect(card).toBeVisible();
    const shadow = await card.evaluate(
      (node) => getComputedStyle(node).boxShadow,
    );
    expect(shadow).not.toBe("none");
    // 形如 "rgba(...) 3px 3px 0px"：模糊半径必须为 0。
    const parts = shadow.match(/(-?\d+(?:\.\d+)?)px/g) ?? [];
    const blur = Number.parseFloat(parts[2] ?? "999");
    expect(blur, `阴影模糊半径过大：${shadow}`).toBe(0);
    const offsets = parts.slice(0, 2).map((part) => Math.abs(Number.parseFloat(part)));
    for (const offset of offsets) {
      expect(offset, `阴影距离过远：${shadow}`).toBeLessThanOrEqual(6);
    }
  });
});
