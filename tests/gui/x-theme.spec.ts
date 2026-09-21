import { expect, test, type Page } from "@playwright/test";

/**
 * 夜间主题 GUI 验收（X 批次）：header 切换 → data-theme/aria/localStorage
 * 同步 → 刷新保持（首帧即 night，无闪白）→ 关键表面 computed style 真正
 * 变深 → 375/412 无横向溢出 → settings 同主题。隔离 server 运行。
 */

async function bgLuminance(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => {
    const rgb = getComputedStyle(element).backgroundColor
      .match(/\d+(\.\d+)?/g)!
      .map(Number);
    const [r, g, b] = rgb as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

/** 主题切换带 120ms CSS 过渡；轮询等待亮度跨过阈值后再断言。 */
async function expectLuminance(
  page: Page,
  selector: string,
  direction: "dark" | "light",
  label: string,
) {
  const poll = expect.poll(() => bgLuminance(page, selector), { timeout: 5_000 });
  if (direction === "dark") {
    await poll.toBeLessThan(70);
  } else {
    await poll.toBeGreaterThan(180);
  }
  void label;
}

async function textLuminance(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate((element) => {
    const rgb = getComputedStyle(element).color.match(/\d+(\.\d+)?/g)!.map(Number);
    const [r, g, b] = rgb as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  });
}

async function expectNightControlContrast(page: Page, label: string) {
  const reports = await page.locator(
    'textarea, input:not([type="radio"]):not([type="checkbox"]):not([type="file"]), select',
  ).evaluateAll((elements) => elements.filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }).map((element) => {
    const parse = (value: string) => value.match(/[\d.]+/g)?.map(Number) ?? [];
    const luminance = (value: string) => {
      const [r, g, b] = parse(value).slice(0, 3).map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(element);
    const foreground = luminance(style.color);
    const background = luminance(style.backgroundColor);
    const [high, low] = foreground > background
      ? [foreground, background]
      : [background, foreground];
    return { tag: element.tagName, ratio: (high + 0.05) / (low + 0.05) };
  }));
  for (const report of reports) {
    expect(report.ratio, `${label}: ${report.tag} 控件对比度`).toBeGreaterThanOrEqual(4.5);
  }
}

test("主题切换：状态同步、刷新持久化、表面真正变深、窄屏无溢出", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/?recordId=record_first_watch");
  await page.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });

  // 默认浅色：toggle 可达且状态为未按下。
  const toggle = page.getByTestId("theme-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toHaveAccessibleName(/切换浅色\/夜间主题|Toggle light or night theme|ライト\/ナイトテーマを切り替え/);
  await expectLuminance(page, "body", "light", "body 浅色背景");

  // 切换夜间：data-theme / aria-pressed / localStorage 三者同步。
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("night");
  expect(await page.evaluate(() => localStorage.getItem("realm.theme"))).toBe("night");
  expect(
    await page.evaluate(() => document.documentElement.style.colorScheme),
  ).toBe("dark");

  // 关键表面真正变深（body / 主区 / header 文字保持可读对比）。
  await expectLuminance(page, "body", "dark", "body 夜间背景必须为深色");
  await expectLuminance(page, ".record-main", "dark", "record 主区夜间必须为深色");
  const headingText = await textLuminance(page, ".record-heading h1");
  expect(headingText, "标题文字夜间必须为浅色").toBeGreaterThan(150);
  await expectNightControlContrast(page, "record");

  // 世界库 overlay：无白色卡片闪出。
  await page.getByRole("button", { name: /世界库|Library|ライブラリ/ }).click();
  await expect(page.locator(".library-panel")).toBeVisible();
  await expectLuminance(page, ".library-panel", "dark", "library 面板夜间必须为深色");
  await page.getByRole("button", { name: /关闭世界库|Close the library|世界庫を閉じる/ }).click();

  // 分支树 overlay（夜间直角面板）。
  await page.getByRole("button", { name: /打开世界视图|Open the world view|世界ビューを開く/ }).click();
  await page.locator('[data-view="world"]').getByRole("button", { name: /分支树|Branch tree|ブランチツリー/ }).click();
  const panel = page.locator('[data-testid="branch-tree-panel"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator(".branch-tree")).toBeVisible({ timeout: 30_000 });
  await expectLuminance(page, ".branch-tree-panel", "dark", "分支树面板夜间必须为深色");
  await page.getByRole("button", { name: /关闭分支树|Close the branch tree|ブランチツリーを閉じる/ }).click();

  // 刷新保持：首帧即 night（不等任何异步状态直接读 data-theme）。
  // 注意刷新时 URL 带 ?view=world（主区是世界视图，无 #realm-message），
  // 主题断言与视图无关；随后显式回到记录页再继续。
  await page.reload({ waitUntil: "commit" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme), { timeout: 5_000 })
    .toBe("night");
  await expectLuminance(page, "body", "dark", "刷新后 body 保持深色");
  await page.goto("/?recordId=record_first_watch");
  await page.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // 设置页同主题且有同一切换组件。
  await page.goto("/settings");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("night");
  await expect(page.getByTestId("theme-toggle")).toBeVisible();
  await expectLuminance(page, "body", "dark", "设置页 body 保持深色");
  await expectNightControlContrast(page, "settings");
  await page.goto("/?recordId=record_first_watch");
  await page.locator("#realm-message").waitFor({ state: "visible", timeout: 60_000 });

  // 375 / 412 窄屏：无横向溢出、按钮可聚焦。
  for (const width of [375, 412]) {
    await page.setViewportSize({ width, height: 760 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `night@${width}: 横向溢出`).toBeLessThanOrEqual(1);
    await toggle.focus();
    await expect(toggle).toBeFocused();
  }

  // 切回浅色：状态同步恢复，localStorage 写回 light。
  await page.setViewportSize({ width: 1440, height: 900 });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("realm.theme"))).toBe("light");
  await expectLuminance(page, "body", "light", "切回浅色后 body 恢复");
  expect(consoleErrors, "主题流程不应产生浏览器 console error").toEqual([]);
  expect(pageErrors, "主题流程不应产生 page error").toEqual([]);
});
