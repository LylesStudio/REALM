import { expect, test, type APIRequestContext } from "@playwright/test";
import { openDemoRecord, openLibrary, uniqueName } from "./helpers";

/** 批次 T9：canon/图谱 API 显式 worldId（demo 世界=烬海诸国）。 */
const DEMO_WORLD_ID = "world_ember_coast";

async function seedEntity(
  request: APIRequestContext,
  name: string,
  entityKind: string,
): Promise<string> {
  const response = await request.post("/api/world-knowledge", {
    data: { action: "upsertEntity", entityKind, name, summary: `${name} 的摘要。`, worldId: DEMO_WORLD_ID },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function seedClaim(
  request: APIRequestContext,
  subjectEntityId: string,
  predicate: string,
  objectValue: string,
  scope = "story",
): Promise<string> {
  const response = await request.post("/api/world-knowledge", {
    data: {
      action: "appendClaim",
      subjectEntityId,
      predicate,
      objectValue,
      scope,
      truthStatus: "record_confirmed",
      worldId: DEMO_WORLD_ID,
    },
  });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { id: string };
  return body.id;
}

async function openGraph(page: import("@playwright/test").Page) {
  await openDemoRecord(page);
  await openLibrary(page);
  await page
    .locator(".library-world", { hasText: "烬海诸国" })
    .getByRole("button", { name: "图谱 · 正史" })
    .click();
  await expect(page.locator(".graph-panel")).toBeVisible();
}

test.describe("K. 世界知识图谱与 Canon 审核", () => {
  test("K1 加载：世界条目入口打开图谱视图，节点渲染", async ({ page, request }) => {
    const name = uniqueName("K1灯塔");
    await seedEntity(request, name, "geography");
    await openGraph(page);
    const node = page.locator(".graph-node", { hasText: "K1灯塔" }).first();
    await expect(node).toBeVisible();
    await expect(page.locator(".graph-worldline-tag")).toContainText("原初世界线");
    // 图例完整。
    await expect(page.locator(".graph-legend")).toContainText("人物");
    await expect(page.locator(".graph-legend")).toContainText("地理");
  });

  test("K2 分色：不同实体类型节点使用规范色值", async ({ page, request }) => {
    await seedEntity(request, uniqueName("K2人物"), "person");
    await seedEntity(request, uniqueName("K2地理"), "geography");
    await openGraph(page);
    const personRect = page.locator('rect[data-entity-kind="person"]').first();
    const geoRect = page.locator('rect[data-entity-kind="geography"]').first();
    await expect(personRect).toHaveAttribute("fill", "#b94c36");
    await expect(geoRect).toHaveAttribute("fill", "#3f6770");
    // 直角：rect 无圆角半径。
    await expect(personRect).not.toHaveAttribute("rx", /[1-9]/);
  });

  test("K3 下钻：点节点显示 Claim 列表与关系", async ({ page, request }) => {
    const name = uniqueName("K3密函");
    const entityId = await seedEntity(request, name, "setting");
    await seedClaim(request, entityId, "状态", "被送上岸");
    const targetId = await seedEntity(request, uniqueName("K3塞娜"), "person");
    const claimId = await seedClaim(request, entityId, "经手", name);
    const relationResponse = await request.post("/api/world-knowledge", {
      data: {
        action: "appendRelation",
        subjectEntityId: entityId,
        objectEntityId: targetId,
        predicate: "经手",
        claimId,
        worldId: DEMO_WORLD_ID,
      },
    });
    expect(relationResponse.ok()).toBeTruthy();

    await openGraph(page);
    await page.locator(".graph-node", { hasText: "K3密函" }).first().click();
    const detail = page.locator(".graph-detail");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("被送上岸");
    await expect(detail).toContainText("record_confirmed");
    await expect(detail).toContainText("经手");
  });

  test("K4 编辑：创建实体与提交 Claim 立即反映到视图", async ({ page }) => {
    await openGraph(page);
    const name = uniqueName("K4遗迹");
    await page.getByRole("button", { name: "新建实体" }).click();
    const form = page.locator(".graph-edit-form");
    await form.locator("input").first().fill(name);
    await form.locator("select").selectOption("history");
    await form.locator("textarea").fill("GUI 测试创建的遗迹。");
    await form.getByRole("button", { name: "确认" }).click();
    await expect(page.locator(".graph-node", { hasText: "K4遗迹" }).first()).toBeVisible();

    await page.locator(".graph-node", { hasText: "K4遗迹" }).first().click();
    await page.getByRole("button", { name: "提交 Claim" }).click();
    const claimForm = page.locator(".graph-edit-form");
    await claimForm.locator("input").first().fill("发现于");
    await claimForm.locator("input").nth(1).fill("北岸潮线");
    await claimForm.getByRole("button", { name: "确认" }).click();
    await expect(page.locator(".graph-detail")).toContainText("北岸潮线");
  });

  test("K5 Canon 审核：pending 提案可见，拒绝后消失", async ({ page, request }) => {
    const entityId = await seedEntity(request, uniqueName("K5钟"), "setting");
    const claimId = await seedClaim(
      request,
      entityId,
      "状态",
      uniqueName("再次响起"),
      "story",
    );
    const propose = await request.post("/api/canon", {
      data: {
        action: "propose",
        targetLevel: "story",
        claimIds: [claimId],
        rationale: uniqueName("K5提案"),
        worldId: DEMO_WORLD_ID,
      },
    });
    expect(propose.status()).toBe(201);
    const proposalBody = (await propose.json()) as {
      proposal: { id: string; rationale: string };
    };
    const rationale = proposalBody.proposal.rationale;

    await openGraph(page);
    await page.getByRole("button", { name: /正史审核/ }).click();
    const card = page.locator(".canon-card", { hasText: rationale });
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "查看详情" }).click();
    await expect(card).toContainText("故事级");
    await card.getByRole("button", { name: "拒绝" }).click();
    await expect(page.locator(".canon-card", { hasText: rationale })).toHaveCount(0);
  });

  test("K6 设计语言：图谱区域无圆角无半透明卡片", async ({ page, request }) => {
    await seedEntity(request, uniqueName("K6样本"), "faction");
    await openGraph(page);
    for (const selector of [".graph-panel", ".graph-side", ".graph-canvas", ".canon-card", ".graph-edit-form input"]) {
      const element = page.locator(selector).first();
      if ((await element.count()) === 0) continue;
      const radius = await element.evaluate(
        (node) => getComputedStyle(node).borderRadius,
      );
      for (const value of radius.split(" ")) {
        expect(Number.parseFloat(value) || 0, `${selector} 出现圆角`).toBeLessThanOrEqual(1);
      }
    }
  });

  test("K7 刷新：外部新增实体后点击「刷新图谱」立即可见", async ({ page, request }) => {
    // 锚点实体确认初次加载已完成——之后 API 造的实体只能经手动刷新进入视图。
    // 节点 <g role="button"> 的 aria-label 带完整名称（标签文本超 6 字会
    // 截断），按全名精确匹配：每次运行唯一，重跑不受残留实体影响。
    const anchor = uniqueName("K7锚点");
    await seedEntity(request, anchor, "geography");
    await openGraph(page);
    await expect(
      page.getByRole("button", { name: `实体 ${anchor}`, exact: true }),
    ).toBeVisible();

    const name = uniqueName("K7灯塔");
    await seedEntity(request, name, "geography");
    await expect(
      page.getByRole("button", { name: `实体 ${name}`, exact: true }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "刷新图谱" }).click();
    await expect(
      page.getByRole("button", { name: `实体 ${name}`, exact: true }),
    ).toBeVisible();
  });

  test("K8 自动刷新：外部写入后不点刷新，新节点经 SSE 失效事件出现", async ({ page, request }) => {
    // 批次 T11-A2：graph-specific SSE。锚点实体确认初次加载完成——之后
    // API 造的实体只能经失效事件自动回读进入视图（全程不点「刷新图谱」）。
    const anchor = uniqueName("K8锚点");
    await seedEntity(request, anchor, "geography");
    await openGraph(page);
    await expect(
      page.getByRole("button", { name: `实体 ${anchor}`, exact: true }),
    ).toBeVisible();

    const name = uniqueName("K8烽火");
    await seedEntity(request, name, "geography");
    await expect(
      page.getByRole("button", { name: `实体 ${name}`, exact: true }),
    ).toBeVisible({ timeout: 20_000 });
  });
});
