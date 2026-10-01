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
    await page.locator(".guided-entry:not(.is-primary)").click();
    await expect(page.locator(".guided-genesis")).toBeVisible();
    await expect(page.locator(".guided-question")).toContainText("给这个世界起个名字");

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

    // 合卷总览：review surface 与创建按钮就位（不绑定易漂移的问句文案）。
    const review = page.locator(".guided-review-scroll");
    await expect(review).toBeVisible();
    await expect(page.locator(".guided-seal-button")).toBeVisible();
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
    await expect(page.locator(".event-card").first()).toContainText("世界刚刚生成");
  });

  test("N2 中途离场不留数据，重开从头开始", async ({ page }) => {
    const worldName = uniqueName("GUI弃卷");
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry:not(.is-primary)").click();

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
    await page.locator(".guided-entry:not(.is-primary)").click();
    await expect(page.locator(".guided-question")).toContainText("给这个世界起个名字");
    await expect(page.locator(".guided-scroll .scroll-entry")).toHaveCount(0);
  });

  test("N3 AI 代笔：候选点选即定并写入已定之卷（离线 fake provider 真实链路）", async ({ page }) => {
    // 不打真实模型：route → gateway → fake provider 的 genesis-suggestions
    // fixture → normalizer → 可见候选（fixture 候选集见
    // tests/helpers/fake-openai-provider.mjs 的 genesis-suggestions 阶段）。
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry:not(.is-primary)").click();

    // 世界之名：代笔 → 候选浮现 → 点选入框 → 落墨。
    await page.locator(".guided-suggest").click();
    const candidates = page.locator(".guided-suggestions li > button");
    await expect(candidates).toHaveCount(3);
    await candidates.first().click();
    await expect(
      page.getByRole("textbox", { name: "世界名称输入" }),
    ).toHaveValue("雾钟湖城");
    await page.locator(".guided-confirm").click();
    const scroll = page.locator(".guided-scroll");
    await expect(scroll.locator(".scroll-entry", { hasText: "雾钟湖城" })).toBeVisible();

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
    const companion = page.locator(".guided-suggestions li > button", { hasText: "阿汐" });
    await expect(companion).toBeVisible();
    await expect(companion).toContainText("值夜人");
    await companion.click();
    await expect(
      scroll.locator(".scroll-entry", { hasText: "阿汐 · 湖岸灯塔的值夜人" }),
    ).toBeVisible();
    await page.locator(".guided-skip", { hasText: "下一步" }).click();

    // 开场场景：全留白 → 合卷总览包含已定内容。
    await page.locator(".guided-skip", { hasText: "全部跳过" }).click();
    await expect(page.locator(".guided-review-scroll")).toContainText("雾钟湖城");
    await expect(page.locator(".guided-review-scroll")).toContainText("阿汐");
  });

  test("N5 世界落笔失败：保留草案并允许重试", async ({ page }) => {
    const worldName = uniqueName("GUI待重试");
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry:not(.is-primary)").click();
    await page.getByRole("textbox", { name: "世界名称输入" }).fill(worldName);
    await page.locator(".guided-confirm").click();
    for (let step = 0; step < 8; step += 1) {
      await page.locator(".guided-skip").click();
    }
    await expect(page.locator(".guided-review-scroll")).toContainText(worldName);

    let attempts = 0;
    await page.route("**/api/world/generate", async (route) => {
      attempts += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
    });
    const submit = page.locator(".guided-seal-button");
    await submit.click();
    await expect(page.locator(".guided-create-error[role=alert]")).toHaveText(
      "创建状态未能确认。请先检查世界库；确认未出现后，再重试，避免重复创建。",
    );
    await expect(page.locator(".guided-review-scroll")).toContainText(worldName);
    await expect(submit).toBeEnabled();

    await submit.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(page.locator(".guided-create-error[role=alert]")).toBeVisible();
  });

  test("N6 创世模态管理键盘焦点并在关闭后恢复", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    const opener = page.locator(".guided-entry:not(.is-primary)");
    await opener.click();

    const dialog = page.locator(".guided-overlay[role=dialog]");
    await expect(dialog).toBeVisible();
    const firstField = dialog.getByRole("textbox", { name: "世界名称输入" });
    await expect(firstField).toBeFocused();

    const tabbables = dialog.locator("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href]");
    await tabbables.last().focus();
    await page.keyboard.press("Tab");
    await expect(tabbables.first()).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-creation-focus-return="create-guided"]')).toBeFocused();
  });

  test("N7 对谈创世使用同一模态键盘焦点契约", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry.is-primary").click();

    const dialog = page.locator(".guided-overlay[role=dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".guided-genesis-chat .guided-heading button")).toBeFocused();
    await expect(dialog.getByRole("textbox", { name: "向 AI 助手说明你的创世构想" })).toBeVisible();
    await expect(dialog.locator("[role=dialog]")).toHaveCount(0);

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.locator('[data-creation-focus-return="create-chat"]')).toBeFocused();
  });

  test("N4 回退不会清空前后步骤内容", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry:not(.is-primary)").click();

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

test("N8 对谈失败改用分步引导：对谈历史/未发送草稿/完整提案全部保留，改值后真实创建", async ({ page }) => {
  // 真实 genesis-chat route → gateway → loopback fake provider（成功 fixture
  // + GUI故障注入 marker 确定失败）；不用 page.route 替代 provider 集成。
  const chatUserText = uniqueName("GUI保留-世界构想");
  const unsentText = uniqueName("GUI保留-未发送草稿");
  const editedName = uniqueName("GUI保留改名");

  await openDemoRecord(page);
  await openLibrary(page);
  await page.getByRole("button", { name: /与 AI 助手对话/ }).click();
  const chatOverlay = page.locator(".guided-overlay .guided-genesis-chat");
  await expect(chatOverlay).toBeVisible();

  // 成功开场（scribe 首轮）+ 一条可识别的成功玩家对话 → 提案卡浮现。
  const scribeFirst = chatOverlay.locator(".chat-turn.is-scribe p").first();
  await expect(scribeFirst).toBeVisible({ timeout: 30_000 });
  const openingScribeText = (await scribeFirst.innerText()).trim();
  const chatInput = chatOverlay.locator(".genesis-chat-form input");
  await chatInput.fill(chatUserText);
  await chatOverlay.locator(".genesis-chat-form button[type=submit]").click();
  await expect(
    chatOverlay.locator(".chat-turn.is-user p", { hasText: chatUserText }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(chatOverlay.locator(".genesis-proposal-card")).toBeVisible({ timeout: 30_000 });

  // 触发确定 provider 失败 → 静默条（可重试/可改用分步引导）。
  // 失败后玩家在输入框改写成新的未发送文本（保持未提交独立状态）。
  await chatInput.fill("GUI故障注入-改用分步引导");
  await chatOverlay.locator(".genesis-chat-form button[type=submit]").click();
  await expect(chatOverlay.locator(".genesis-chat-silent")).toBeVisible({ timeout: 30_000 });
  await chatInput.fill(unsentText);

  // 改用分步引导：上下文必须随 overlay 切换保留。
  await chatOverlay.getByRole("button", { name: "改用分步引导" }).click();
  const guided = page.locator(".guided-overlay .guided-genesis");
  await expect(guided).toBeVisible({ timeout: 30_000 });

  // 已提交 turns：数量、role、内容、次序逐项钉住
  // （开场 scribe → 成功 user turn → 对应 scribe turn）。
  const recovery = guided.locator(".guided-fallback-recovery");
  await expect(recovery).toBeVisible();
  const recoveryTurns = recovery.locator(".guided-fallback-turns li");
  await expect(recoveryTurns).toHaveCount(3);
  await expect(recoveryTurns.nth(0)).toHaveClass(/is-scribe/);
  await expect(recoveryTurns.nth(0)).toContainText(openingScribeText);
  await expect(recoveryTurns.nth(1)).toHaveClass(/is-user/);
  await expect(recoveryTurns.nth(1)).toContainText(chatUserText);
  await expect(recoveryTurns.nth(2)).toHaveClass(/is-scribe/);
  await expect(recoveryTurns.nth(2)).not.toBeEmpty();
  // 故障 marker 与未提交文本都不在历史 turns 列表。
  const turnList = recovery.locator(".guided-fallback-turns");
  await expect(turnList).not.toContainText("GUI故障注入-改用分步引导");
  await expect(turnList).not.toContainText(unsentText);
  // 切换后首焦点落在首个创世可编辑字段（不被恢复面板 textarea 抢焦）。
  const worldNameInput = guided.locator("textarea.guided-input").first();
  await expect(worldNameInput).toBeFocused();
  // 未发送草稿：独立 textarea 初始值正确、可编辑；编辑后历史列表仍不含它。
  const unsentInput = guided.locator(".guided-fallback-unsent textarea");
  await expect(unsentInput).toHaveValue(unsentText);
  await unsentInput.fill(`${unsentText}-改`);
  await expect(unsentInput).toHaveValue(`${unsentText}-改`);
  await expect(turnList).not.toContainText(`${unsentText}-改`);

  // 完整 proposal 初始化分步表单：世界名与嵌套同行者字段可见。
  await expect(worldNameInput).toHaveValue("雾钟湖城");
  const scroll = guided.locator(".guided-scroll");
  await expect(scroll).toContainText("阿汐");

  // 改世界名 → 走完分步 → 真实创建 → 新记录面包屑反映修改值。
  await worldNameInput.fill(editedName);
  await guided.locator(".guided-confirm").click();
  for (let step = 0; step < 8; step += 1) {
    await guided.locator(".guided-skip").first().click();
  }
  await expect(guided.locator(".guided-review-scroll")).toContainText(editedName);
  await expect(guided.locator(".guided-review-scroll")).toContainText("阿汐");
  await guided.locator(".guided-seal-button").click();
  await waitForRecordReady(page);
  await expect(page.locator(".breadcrumb")).toContainText(editedName);
});
