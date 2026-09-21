import { expect, test } from "@playwright/test";
import {
  openDemoRecord,
  waitForRecordReady,
} from "./helpers";

/**
 * 分支管理 GUI 验收（V 批次）。运行前提：隔离 dev server + 一次性 PG
 * （GUI_BASE_URL 指向一次性实例；demo 世界 record_first_watch 含已提交事件）。
 *
 * 覆盖：Record 页创建分支（head/事件边界）→ 真实 API 落库 → 进入新
 * Record → WorldView 分支树入口 → 树展开/节点详情/来源跳转/进入记录 →
 * Library 入口 → 键盘与 ARIA → 375px 窄屏无横向溢出。
 */

async function openBranchDialog(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "创建分支" }).first().click();
  const dialog = page.locator('[data-testid="branch-dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openBranchTreeFromWorldView(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "打开世界视图" }).click();
  await expect(page.locator('[data-view="world"]')).toBeVisible();
  await page.locator('[data-view="world"]').getByRole("button", { name: "分支树" }).click();
  const panel = page.locator('[data-testid="branch-tree-panel"]');
  await expect(panel).toBeVisible();
  // 加载完成（loading 文案消失，树出现）。
  await expect(panel.locator(".branch-tree")).toBeVisible({ timeout: 30_000 });
  return panel;
}

test.describe("分支管理（隔离世界）", () => {
  test("V1 从当前进度创建分支 → 进入新 Record → 分支树谱系与返回路径", async ({ page }) => {
    await openDemoRecord(page);
    const sourceTitle = await page.locator(".record-heading h1").textContent();

    const dialog = await openBranchDialog(page);
    const dialogShell = page.locator('.branch-dialog-overlay[role="dialog"]');
    await expect(dialogShell).toHaveAttribute("aria-labelledby", "branch-dialog-title");
    await expect(dialogShell).toHaveAttribute("aria-describedby", "branch-dialog-note");
    await expect(dialogShell.getByRole("heading", { name: "创建分支" })).toHaveAttribute(
      "id",
      "branch-dialog-title",
    );
    await expect(dialog.locator("input[type=radio]").first()).toBeFocused();
    // 默认「从当前进度分叉」；确认后真实落库并进入新 Record。
    await dialog.getByRole("button", { name: "创建分支" }).click();
    await expect(page.locator(".record-heading h1")).toContainText("分支：", {
      timeout: 60_000,
    });
    await expect(page.locator(".record-heading")).toContainText(sourceTitle!.trim());
    // 新记录带「分支」徽标。
    await expect(
      page.locator(".record-heading .record-timeline-badge"),
    ).toHaveText("分支");
    await waitForRecordReady(page);

    // WorldView → 分支树：原初 + 子分支节点、当前徽标。
    const panel = await openBranchTreeFromWorldView(page);
    await expect(panel.locator(".branch-badge.is-origin").first()).toHaveText("原初");
    await expect(
      panel.locator(".branch-node", { hasText: `分支：${sourceTitle!.trim()}` }),
    ).toBeVisible();
    await expect(panel.locator(".branch-badge.is-current").first()).toHaveText("当前");

    // Worldline 下必须显式呈现 Story 层，不能只把 Story 藏在详情栏。
    await expect(panel.locator(".branch-story")).toHaveCount(2);
    await expect(panel.locator(".branch-story-title").first()).toBeVisible();
    // 选中分支 Worldline 时，父线字段必须是 Worldline，不得冒充来源 Record。
    await panel.locator(".branch-node-button", { hasText: `分支：${sourceTitle!.trim()}` }).click();
    await expect(panel.locator(".branch-detail")).toContainText("上级世界线");
    await expect(panel.locator(".branch-detail")).toContainText("原初世界线");

    // 来源跳转：详情里点来源记录 → 选中源 record 节点 → 进入记录。
    await panel
      .locator(".branch-record", { hasText: `分支：${sourceTitle!.trim()}` })
      .first()
      .click();
    const sourceLink = panel.locator(".branch-source-link");
    await expect(sourceLink).toBeVisible();
    await expect(sourceLink).toHaveText(sourceTitle!.trim());
    await sourceLink.click();
    await panel.getByRole("button", { name: "进入记录" }).click();
    await waitForRecordReady(page);
    await expect(page.locator(".record-heading h1")).toHaveText(sourceTitle!.trim());
  });

  test("V2 从已提交事件边界创建分支（canonical eventId，非 viewer ordinal）", async ({ page }) => {
    await openDemoRecord(page);
    const dialog = await openBranchDialog(page);
    await dialog.getByLabel("从一条已提交事件分叉").check();
    const eventSelect = dialog.getByLabel("选择事件");
    await expect(eventSelect).toBeVisible();
    // 选择第一条已提交事件。
    await eventSelect.selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "创建分支" }).click();
    await expect(page.locator(".record-heading h1")).toContainText("分支：", {
      timeout: 60_000,
    });
    await waitForRecordReady(page);

    // 树详情显示分叉点游标（非 0:0 即证明走了事件边界而非起点重演）。
    const panel = await openBranchTreeFromWorldView(page);
    await panel.locator(".branch-record.is-branch").first().click();
    const detail = panel.locator(".branch-detail");
    await expect(detail).toContainText("分叉点");
    const forkValue = await detail.locator("dd").nth(2).textContent();
    expect(forkValue!.trim()).not.toBe("0:0");
  });

  test("V3 Library 入口、键盘 ARIA 与 375px 窄屏", async ({ page, browserName }) => {
    await openDemoRecord(page);
    // Library 世界卡的「分支树」入口。
    await page.getByRole("button", { name: "世界库" }).click();
    const libraryPanel = page.locator(".library-panel");
    await expect(libraryPanel).toBeVisible();
    await libraryPanel.getByRole("button", { name: "分支树" }).first().click();
    const panel = page.locator('[data-testid="branch-tree-panel"]');
    await expect(panel).toBeVisible();
    await expect(panel.locator(".branch-tree")).toBeVisible({ timeout: 30_000 });

    // ARIA：tree/treeitem 语义与 roving tabindex。
    await expect(panel.getByRole("tree")).toBeVisible();
    const firstItem = panel.getByRole("treeitem").first();
    await expect(firstItem).toHaveAttribute("tabindex", "0");
    // 键盘：Tab 进入后方向键移动不报错（WebKit 焦点行为差异下仅验证不崩溃）。
    await firstItem.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");

    // 375px 窄屏：树退化为缩进列表，无横向溢出。
    await page.setViewportSize({ width: 375, height: 720 });
    await expect(panel.locator(".branch-tree")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, `${browserName}: 375px 窄屏不得横向溢出`).toBeLessThanOrEqual(1);
  });
});
