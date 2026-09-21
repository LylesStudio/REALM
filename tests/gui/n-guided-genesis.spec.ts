import { expect, test } from "@playwright/test";
import {
  openDemoRecord,
  openLibrary,
  uniqueName,
  waitForRecordReady,
} from "./helpers";

test.describe("N. AI 引导创建 · 对话式创世", () => {
  test("N1 全程引导：分步填写、内容预览、创建世界进入对局", async ({ page }) => {
    test.setTimeout(600_000);
    const worldName = uniqueName("GUI云港");
    await openDemoRecord(page);
    await openLibrary(page);

    // 推荐主入口可见，进入全屏引导。
    await page.locator(".guided-entry").click();
    await expect(page.locator(".guided-genesis")).toBeVisible();
    await expect(page.locator(".guided-question")).toContainText("给这个世界起个名字吧");

    // 第一步必填：空输入时「落墨」禁用。
    await expect(page.locator(".guided-confirm")).toBeDisabled();

    // 世界之名。
    await page.getByRole("textbox", { name: "世界名称输入" }).fill(worldName);
    await page.locator(".guided-confirm").click();
    const scroll = page.locator(".guided-scroll");
    await expect(scroll.locator(".scroll-entry", { hasText: worldName })).toBeVisible();

    // 时代背景：留白跳过，卷上不落条目。
    await page.locator(".guided-skip").click();
    await expect(scroll).not.toContainText("时代背景");

    // 文风步（新增）：留白跳过 = modern，卷上不落条目。
    await expect(page.locator(".guided-heading h2")).toHaveText("文风");
    await page.locator(".guided-skip").click();
    await expect(scroll).not.toContainText("文风");

    // 世界底色：输入一句题跋。
    await page.getByRole("textbox", { name: "世界概述输入" }).fill("云海上的旧船港，船员用风声记账。");
    await page.locator(".guided-confirm").click();
    await expect(
      scroll.locator(".scroll-entry", { hasText: "云海上的旧船港" }),
    ).toBeVisible();

    // 故事开篇：标题 + 缘起。
    await page.getByRole("textbox", { name: "开场故事输入" }).fill("雾中航船");
    await page.getByRole("textbox", { name: "故事简介输入" }).fill("一艘无籍船在雾夜靠岸。");
    await page.locator(".guided-confirm").click();
    await expect(scroll.locator(".scroll-entry", { hasText: "雾中航船" })).toBeVisible();

    // 你的身份：登录昵称展示 + 定位。
    await expect(page.locator(".guided-note")).toContainText("GUI 测试员");
    await page.getByRole("textbox", { name: "你的角色输入" }).fill("替港口辨认风声的新账房");
    await page.locator(".guided-confirm").click();
    await expect(
      scroll.locator(".scroll-entry", { hasText: "新账房" }),
    ).toBeVisible();

    // 参与方式（批次 S 新增步）：留白跳过 = 默认入局。
    await expect(page.locator(".guided-heading h2")).toHaveText("参与方式");
    await page.locator(".guided-skip").click();

    // 同行之人：暂不添加（空阵容由旁白推进，既有能力）。
    // AI 代笔候选点选在 N2 以确定性路由拦截覆盖。
    await page.locator(".guided-skip", { hasText: "暂不添加" }).click();

    // 开场场景：全部留白（不写默认值，留给设定结晶生长）。
    await page.locator(".guided-skip", { hasText: "全部跳过" }).click();
    await expect(scroll).not.toContainText("开场场景");

    // 合卷总览：已定内容齐备，一键入界。
    await expect(page.locator(".guided-question")).toContainText("确认以下信息");
    const review = page.locator(".guided-review-scroll");
    await expect(review).toContainText(worldName);
    await expect(review).toContainText("雾中航船");
    await expect(review).not.toContainText("时代背景");
    await page.locator(".guided-seal-button").click();

    // 落笔入界：直接打开新记录，玩家绑定登录昵称。
    await waitForRecordReady(page);
    await expect(page.locator(".breadcrumb")).toContainText(worldName);
    await expect(page.locator(".cast-list")).toContainText("GUI 测试员");
    // 批次 T1：逐步引导世界落笔即有确定性开场旁白，时间线不再空白；
    // 场景全留白 → modern 风格「万象未定」合成句。
    await expect(page.locator(".timeline-empty")).toHaveCount(0);
    await expect(page.locator(".event-card").first()).toContainText("世界刚刚落笔");
  });

  test("N2 中途离场不留数据，重开从头开始", async ({ page }) => {
    const worldName = uniqueName("GUI弃卷");
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry").click();

    await page.getByRole("textbox", { name: "世界名称输入" }).fill(worldName);
    await page.locator(".guided-confirm").click();
    await expect(
      page.locator(".guided-scroll .scroll-entry", { hasText: worldName }),
    ).toBeVisible();

    // 离场：不写任何数据。
    await page.getByRole("button", { name: "退出引导" }).click();
    await expect(page.locator(".guided-genesis")).toBeHidden();
    await openLibrary(page);
    await expect(
      page.locator(".library-world", { hasText: worldName }),
    ).toBeHidden();

    // 重开：回到第一步，已定之卷为空。
    await page.locator(".guided-entry").click();
    await expect(page.locator(".guided-question")).toContainText("给这个世界起个名字吧");
    await expect(page.locator(".guided-scroll .scroll-entry")).toHaveCount(0);
  });

  test("N3 AI 代笔：候选点选即定并写入已定之卷（确定性拦截）", async ({ page }) => {
    // 拦截候选端点，验证代笔交互契约（候选浮现→点选→落卷），不打真实模型。
    await page.route("**/api/world/suggest", async (route) => {
      const body = route.request().postDataJSON() as { step?: string };
      const suggestions = body.step === "world-name"
        ? ["汐雾集", "望潮墟", "浮灯坞"]
        : body.step === "companions"
          ? [{ name: "阿橹", role: "记账员", summary: "听得懂风声的人。" }]
          : ["候选甲", "候选乙"];
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ ok: true, suggestions }),
      });
    });

    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry").click();

    // 世界之名：代笔 → 候选浮现 → 点选入框 → 落墨。
    await page.locator(".guided-suggest").click();
    const candidates = page.locator(".guided-suggestions li > button");
    await expect(candidates).toHaveCount(3);
    await candidates.first().click();
    await expect(
      page.getByRole("textbox", { name: "世界名称输入" }),
    ).toHaveValue("汐雾集");
    await page.locator(".guided-confirm").click();
    const scroll = page.locator(".guided-scroll");
    await expect(scroll.locator(".scroll-entry", { hasText: "汐雾集" })).toBeVisible();

    // 纪元与底色：留白。
    await page.locator(".guided-skip").click();
    await page.locator(".guided-skip").click();
    // 故事开篇：留白（补「序章」）。
    await page.locator(".guided-skip").click();
    // 你的身份：留白。
    await page.locator(".guided-skip").click();

    // 参与方式（批次 S 新增步）：留白跳过（默认入局）。
    await page.locator(".guided-skip").click();

    // 文风步（新增）：留白跳过（modern）。
    await page.locator(".guided-skip").click();

    // 同行之人：代笔候选卡（名称/身份/侧写），点选即邀。
    await page.locator(".guided-suggest").click();
    const companion = page.locator(".guided-suggestions li > button", { hasText: "阿橹" });
    await expect(companion).toBeVisible();
    await expect(companion).toContainText("记账员");
    await companion.click();
    await expect(
      scroll.locator(".scroll-entry", { hasText: "阿橹 · 记账员" }),
    ).toBeVisible();
    await page.locator(".guided-skip", { hasText: "下一步" }).click();

    // 开场场景：全留白 → 合卷总览包含已定内容。
    await page.locator(".guided-skip", { hasText: "全部跳过" }).click();
    await expect(page.locator(".guided-review-scroll")).toContainText("汐雾集");
    await expect(page.locator(".guided-review-scroll")).toContainText("阿橹");
  });

  test("N4 回退不会清空前后步骤内容", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry").click();

    await page.getByRole("textbox", { name: "世界名称输入" }).fill("回退测试世界");
    await page.locator(".guided-confirm").click();
    await page.getByRole("textbox", { name: "时代背景输入" }).fill("未来第 17 年");
    await page.locator(".guided-confirm").click();

    await page.getByRole("button", { name: "← 上一步" }).click();
    await expect(page.getByRole("textbox", { name: "时代背景输入" })).toHaveValue("未来第 17 年");
    await page.getByRole("button", { name: "← 上一步" }).click();
    await expect(page.getByRole("textbox", { name: "世界名称输入" })).toHaveValue("回退测试世界");

    await page.getByRole("textbox", { name: "世界名称输入" }).fill("修改后的世界");
    await page.locator(".guided-confirm").click();
    await expect(page.getByRole("textbox", { name: "时代背景输入" })).toHaveValue("未来第 17 年");
  });
});
