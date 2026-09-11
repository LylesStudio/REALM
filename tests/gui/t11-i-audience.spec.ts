import { expect, test } from "@playwright/test";
import { openDemoRecord, openLibrary } from "./helpers";

/** T11-I-B：真实浏览器点击验收 owner audience mapping 面。 */
test.describe("T11-I audience mapping operator surface", () => {
  test("owner can append a mapping and duplicate append stays idempotent", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    await page
      .locator(".library-world", { hasText: "烬海诸国" })
      .getByRole("button", { name: "图谱 · 正史" })
      .click();
    await expect(page.locator(".graph-panel")).toBeVisible();

    await page.getByRole("button", { name: /正史审核/ }).click();
    const panel = page.locator(".canon-mapping-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("受众映射治理");
    await expect(panel).toContainText("追加即冻结");

    const nodeSelect = panel.locator("select").nth(0);
    const continuitySelect = panel.locator("select").nth(1);
    await expect(nodeSelect.locator("option")).not.toHaveCount(0);
    await expect(continuitySelect.locator("option")).not.toHaveCount(0);

    const nodeKey = await nodeSelect.locator("option").first().getAttribute("value");
    const continuityId = await continuitySelect.locator("option").first().getAttribute("value");
    const continuityLabel = (await continuitySelect.locator("option").first().textContent())?.trim();
    expect(nodeKey).toBeTruthy();
    expect(continuityId).toBeTruthy();
    expect(continuityLabel).toBeTruthy();

    await panel.getByRole("button", { name: "追加映射" }).click();
    await expect(panel).toContainText("映射已追加", { timeout: 30_000 });
    await expect(
      panel.locator(".canon-mapping-list li", { hasText: nodeKey! }),
    ).toContainText(continuityLabel!);

    await panel.getByRole("button", { name: "追加映射" }).click();
    await expect(panel).toContainText("映射已存在", { timeout: 30_000 });
    await expect(
      panel.locator(".canon-mapping-list li", { hasText: nodeKey! }),
    ).toHaveCount(1);
    await expect(panel.getByRole("button", { name: /删除|修改|编辑/ })).toHaveCount(0);
  });

  test("malformed qualification hides the mapping write surface", async ({ page }) => {
    await page.route(/\/api\/canon\?view=qualification/, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          qualification: {
            scope: { worldId: "world_ember_coast", worldlineId: "worldline_origin" },
            membershipRole: "owner",
            continuities: [{ id: "continuity_missing", displayName: "ghost" }],
            topology: {
              nodes: [{ key: "canon_origin", clearance: "public" }],
              routes: [{ from: "canon_origin", to: "missing_node", channel: "official_bulletin" }],
              nodeAudiences: [],
            },
          },
        }),
      });
    });
    await openDemoRecord(page);
    await openLibrary(page);
    await page
      .locator(".library-world", { hasText: "烬海诸国" })
      .getByRole("button", { name: "图谱 · 正史" })
      .click();
    await expect(page.locator(".graph-panel")).toBeVisible();
    await page.getByRole("button", { name: /正史审核/ }).click();
    await expect(page.locator(".canon-mapping-panel")).toHaveCount(0);
  });
});
