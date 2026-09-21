import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  submitMessage,
  TURN_TIMEOUT,
  uniqueName,
  waitForRecordReady,
} from "./helpers";

/**
 * S. 批次 S：世界记忆 / 司卷对谈创世 / 角色与观察者。
 * 完整游玩闭环使用真实模型；fail-closed 用例走确定性路由拦截。
 * 每个用例都以全新账号开局（无「最近打开」记忆）。
 */

type ChatResponseBody = { ok?: boolean; reply?: string };

/**
 * 按请求体 message 精确匹配某一轮的 genesis-chat POST 应答。
 * 不能只判 URL+method：开场空输入请求与上一轮的应答可能仍在途，
 * 宽松匹配会让 waitForResponse 抢走别的请求的应答（批次 S 调试实证）。
 */
function chatPostFor(message: string) {
  return (response: {
    url(): string;
    request(): { method(): string; postDataJSON(): unknown };
  }): boolean => {
    if (!response.url().includes("/api/world/genesis-chat")) return false;
    if (response.request().method() !== "POST") return false;
    try {
      const body = response.request().postDataJSON() as { message?: unknown };
      return body.message === message;
    } catch {
      return false;
    }
  };
}

/** 静默条「再试一次」：等待可见并点击，返回重发请求的应答体。 */
async function clickSilentRetry(page: Page, message: string): Promise<ChatResponseBody> {
  const retry = page.locator(".genesis-chat-silent").getByRole("button", { name: "再试一次" });
  await expect(retry).toBeVisible({ timeout: 60_000 });
  const retryPromise = page.waitForResponse(chatPostFor(message), { timeout: TURN_TIMEOUT });
  await retry.click();
  return (await (await retryPromise).json()) as ChatResponseBody;
}

/**
 * 在司卷对谈中发出一轮用户输入并等待本轮应答；模型阵发沉默时
 * 点静默条「再试一次」重发同一句（与真实玩家行为一致），至多 3 次。
 */
async function sendChat(page: Page, message: string): Promise<ChatResponseBody> {
  const replyPromise = page.waitForResponse(chatPostFor(message), { timeout: TURN_TIMEOUT });
  await page.locator(".genesis-chat-form input").fill(message);
  await page.locator(".genesis-chat-form button[type=submit]").click();
  let body = (await (await replyPromise).json()) as ChatResponseBody;
  for (let attempt = 0; body.ok !== true && attempt < 2; attempt += 1) {
    body = await clickSilentRetry(page, message);
  }
  expect(body.ok).toBe(true);
  return body;
}

test.describe("S. 世界记忆与司卷对谈创世", () => {
  test("S1 新用户无记忆：默认入口进引导屏，不出现演示记录时间线", async ({
    request,
    browser,
  }) => {
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    await freshPage.goto("/");
    await expect(freshPage.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });
    // 引导屏入口：司卷对谈（主）与逐步引导（次）。
    await expect(freshPage.locator(".onboarding-entry.is-primary")).toContainText("与司卷对谈");
    await expect(freshPage.locator(".onboarding-entry")).toHaveCount(2);
    // 不出现演示记录时间线。
    await expect(freshPage.locator(".record-main")).toHaveCount(0);
    await expect(freshPage.locator(".event-card")).toHaveCount(0);
    // 已有世界（含演示世界）一并列出，可进入。
    await expect(freshPage.locator(".onboarding-worlds")).toContainText("烬海诸国");
    await expect(
      freshPage.locator(".onboarding-worlds li button").first(),
    ).toBeVisible();

    await fresh!.context.close();
  });

  test("S2 司卷对谈创世：≥2 轮自由对话 → 提案可编辑 → 落笔入界 → 重开回到上次世界", async ({
    request,
    browser,
  }) => {
    test.setTimeout(900_000);
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();
    const displayName = fresh!.displayName;

    await freshPage.goto("/");
    await expect(freshPage.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });
    // 司卷自动开场（首轮空输入请求开场）。先挂应答等待再点击入口，
    // 避免请求在等待挂起前发出；「思考中」占位不含 is-scribe，不会误判。
    const openingPromise = freshPage.waitForResponse(chatPostFor(""), { timeout: TURN_TIMEOUT });
    await freshPage.locator(".onboarding-entry.is-primary").click();
    await expect(freshPage.locator(".guided-genesis-chat")).toBeVisible();
    let openingBody = (await (await openingPromise).json()) as ChatResponseBody;
    // 阵发沉默则点静默条「再试一次」重发开场，至多 3 次。
    for (let attempt = 0; openingBody.ok !== true && attempt < 2; attempt += 1) {
      openingBody = await clickSilentRetry(freshPage, "");
    }
    expect(openingBody.ok).toBe(true);
    await expect(freshPage.locator(".chat-turn.is-scribe").first()).toBeVisible({
      timeout: 30_000,
    });

    // 第一轮：自由输入，司卷应接住并追问/回应。
    await sendChat(
      freshPage,
      "我想写一个被浓雾笼罩的港口城市：船只进港必须熄灯，灯火由守灯人看守。",
    );
    await expect(freshPage.locator(".chat-turn.is-scribe").nth(1)).toBeVisible({
      timeout: 30_000,
    });

    // 第二轮：明确要求完整提案。
    await sendChat(
      freshPage,
      "就按你的理解给出完整世界提案：世界名、纪元、底色、开篇故事、我的定位、同行者与初始场景。",
    );

    // 提案卡可能出现于本轮或下一轮；至多再追问两轮。
    const card = freshPage.locator(".genesis-proposal-card");
    let cardVisible = await card
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true, () => false);
    for (let attempt = 0; !cardVisible && attempt < 2; attempt += 1) {
      await sendChat(freshPage, "请直接给出完整提案，不必再追问。");
      cardVisible = await card
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true, () => false);
    }
    await expect(card).toBeVisible({ timeout: 30_000 });

    // 提案字段非空：世界名已定。
    const nameInput = card.locator("input").first();
    const proposedName = ((await nameInput.inputValue()) ?? "").trim();
    expect(proposedName.length).toBeGreaterThan(0);
    // 姿态选择可见，默认入局。
    await expect(card.locator(".stance-option")).toHaveCount(2);
    await expect(card.locator(".stance-option.is-active")).toContainText("入局");

    // 就地编辑世界名，落笔以定稿为准。
    const editedName = `${proposedName}定`.slice(0, 40);
    await nameInput.fill(editedName);
    await expect(nameInput).toHaveValue(editedName);

    // 落笔入界：进入新记录（玩家席位绑定登录昵称）。
    await freshPage.getByRole("button", { name: "落笔入界" }).click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(editedName);
    await expect(freshPage.locator(".cast-list")).toContainText(displayName);

    // 关闭重开（无参数默认入口）：回到上次世界，而非演示世界。
    await freshPage.goto("/");
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(editedName);

    await fresh!.context.close();
  });

  test("S4 观察者落界闭环：执笔者徽标 + 卷首旁白 + 添角色入阵容 + 执笔者真实回合 + 姿态切换往返", async ({
    request,
    browser,
  }) => {
    test.setTimeout(1_200_000);
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    // —— 步骤 1–2：新账号引导屏 → 司卷对谈 ≥2 轮 → 世界提案卡。
    await freshPage.goto("/");
    await expect(freshPage.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });
    const openingPromise = freshPage.waitForResponse(chatPostFor(""), { timeout: TURN_TIMEOUT });
    await freshPage.locator(".onboarding-entry.is-primary").click();
    await expect(freshPage.locator(".guided-genesis-chat")).toBeVisible();
    let openingBody = (await (await openingPromise).json()) as ChatResponseBody;
    for (let attempt = 0; openingBody.ok !== true && attempt < 2; attempt += 1) {
      openingBody = await clickSilentRetry(freshPage, "");
    }
    expect(openingBody.ok).toBe(true);
    await expect(freshPage.locator(".chat-turn.is-scribe").first()).toBeVisible({
      timeout: 30_000,
    });

    await sendChat(
      freshPage,
      "我想写一个云海上的灯塔小镇：守灯人每晚点灯为飞艇引航，灯油用记忆交换。",
    );
    await expect(freshPage.locator(".chat-turn.is-scribe").nth(1)).toBeVisible({
      timeout: 30_000,
    });
    await sendChat(
      freshPage,
      "就按你的理解给出完整世界提案：世界名、纪元、底色、开篇故事、我的定位、同行者与初始场景。",
    );

    const card = freshPage.locator(".genesis-proposal-card");
    let cardVisible = await card
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true, () => false);
    for (let attempt = 0; !cardVisible && attempt < 2; attempt += 1) {
      await sendChat(freshPage, "请直接给出完整提案，不必再追问。");
      cardVisible = await card
        .waitFor({ state: "visible", timeout: 10_000 })
        .then(() => true, () => false);
    }
    await expect(card).toBeVisible({ timeout: 30_000 });
    const proposedName = ((await card.locator("input").first().inputValue()) ?? "").trim();
    expect(proposedName.length).toBeGreaterThan(0);

    // —— 步骤 3：提案改观察者姿态 + 定稿开场白 → 落笔入界。
    await card.locator(".stance-option", { hasText: "观察者" }).click();
    await expect(card.locator(".stance-option.is-active")).toContainText("观察者");
    const openingText = "灯塔点亮之前，云海先吞没过一艘船。";
    await card.locator("textarea[rows='3']").fill(openingText);

    await freshPage.getByRole("button", { name: "落笔入界" }).click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(proposedName);
    // header 执笔者徽标；阵容不含「你」的角色席位（观察者在阵容外）。
    await expect(freshPage.locator(".view-mode.is-narrator")).toBeVisible();
    await expect(freshPage.locator(".cast-you")).toHaveCount(0);
    // 开场事件（卷首旁白）在时间线可见。
    const openingCard = freshPage.locator(".event-card.is-committed", {
      hasText: openingText,
    });
    await expect(openingCard).toBeVisible({ timeout: 30_000 });
    await expect(openingCard.locator("h3")).toHaveText("旁白");

    // —— 步骤 4：世界库为该世界添一名角色 → 当前记录阵容立即可见。
    await freshPage.getByRole("button", { name: "世界库" }).click();
    await expect(freshPage.locator(".library-panel")).toBeVisible();
    const worldCard = freshPage.locator(".library-world", { hasText: proposedName });
    const charName = uniqueName("S角");
    await worldCard.locator(".library-add-character input[aria-label='名字']").fill(charName);
    await worldCard.locator(".library-add-character input[aria-label='定位']").fill("守灯学徒");
    const attachResponse = freshPage.waitForResponse(
      (response) =>
        response.url().includes("/api/library")
        && response.request().method() === "POST",
      { timeout: 60_000 },
    );
    await worldCard.locator(".library-add-character button[type=submit]").click();
    await attachResponse;
    // 附带入阵提示，世界卡角色列表标注「在阵容」。
    await expect(worldCard.locator(".library-add-character-note")).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      worldCard.locator(".library-character", { hasText: charName }),
    ).toContainText("在阵容");
    // 收起面板：新角色立即出现在右侧阵容。
    await freshPage.locator(".library-panel-heading button").click();
    await expect(freshPage.locator(".library-panel")).toBeHidden();
    await expect(freshPage.locator(".cast-list")).toContainText(charName, {
      timeout: 30_000,
    });

    // —— 步骤 5：以执笔者身份提交一条真实回合，AI 角色响应入时间线。
    const beforeCount = await freshPage.locator(".event-card.is-committed").count();
    await submitMessage(
      freshPage,
      "（敲响灯室的铜钟）今夜换灯油，当值的守灯人先报上名来。",
    );
    await expect
      .poll(
        async () => freshPage.locator(".event-card.is-committed").count(),
        { timeout: TURN_TIMEOUT },
      )
      .toBeGreaterThanOrEqual(beforeCount + 2);
    await expect
      .poll(
        async () =>
          freshPage.locator(".event-card.event-character.is-committed").count(),
        { timeout: TURN_TIMEOUT },
      )
      .toBeGreaterThanOrEqual(1);

    // —— 步骤 6：关闭重开（无参数默认入口）→ 回到该世界该记录。
    await freshPage.goto("/");
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(proposedName);
    await expect(freshPage.locator(".view-mode.is-narrator")).toBeVisible();

    // —— 步骤 7：姿态切换往返——入局出现「你」席位，切回观察者席位退出。
    await freshPage.getByRole("button", { name: "世界库" }).click();
    const stanceCard = freshPage.locator(".library-world", { hasText: proposedName });
    await stanceCard
      .locator(".library-stance-toggle button", { hasText: "入局" })
      .click();
    await expect(
      stanceCard.locator(".library-stance-toggle button.is-active"),
    ).toHaveText("入局", { timeout: 60_000 });
    await freshPage.locator(".library-panel-heading button").click();
    await expect(freshPage.locator(".library-panel")).toBeHidden();
    // 转入局：阵容出现本人席位「你」，执笔者徽标消失。
    await expect(freshPage.locator(".cast-you")).toBeVisible({ timeout: 60_000 });
    await expect(freshPage.locator(".view-mode.is-narrator")).toHaveCount(0);

    await freshPage.getByRole("button", { name: "世界库" }).click();
    await stanceCard
      .locator(".library-stance-toggle button", { hasText: "观察者" })
      .click();
    await expect(
      stanceCard.locator(".library-stance-toggle button.is-active"),
    ).toContainText("观察者", { timeout: 60_000 });
    await freshPage.locator(".library-panel-heading button").click();
    await expect(freshPage.locator(".library-panel")).toBeHidden();
    // 切回观察者：「你」席位退出阵容显示，徽标回归。
    await expect(freshPage.locator(".cast-you")).toHaveCount(0, { timeout: 60_000 });
    await expect(freshPage.locator(".view-mode.is-narrator")).toBeVisible({
      timeout: 60_000,
    });

    await fresh!.context.close();
  });

  test("S3 司卷沉默（确定性拦截）：静默降级，可转旧表单完成创建", async ({
    request,
    browser,
  }) => {
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    // 拦截司卷端点：一律 500（模拟模型通道故障）。
    await freshPage.route("**/api/world/genesis-chat", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: "{}" }));

    await freshPage.goto("/");
    await expect(freshPage.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });
    await freshPage.locator(".onboarding-entry.is-primary").click();
    await expect(freshPage.locator(".guided-genesis-chat")).toBeVisible();

    // fail-closed：不弹报错，只显示「司卷暂时沉默」与降级出口。
    const silent = freshPage.locator(".genesis-chat-silent");
    await expect(silent).toBeVisible({ timeout: 60_000 });
    await expect(silent).toContainText("司卷暂时沉默");

    // 转旧表单并完成创建。
    await silent.getByRole("button", { name: "改用逐步引导" }).click();
    await expect(freshPage.locator(".guided-genesis")).toBeVisible();
    const worldName = uniqueName("GUI默路");
    await freshPage.getByRole("textbox", { name: "世界之名输入" }).fill(worldName);
    await freshPage.locator(".guided-confirm").click();
    for (let step = 0; step < 8; step += 1) {
      await freshPage.locator(".guided-skip").click();
    }
    await freshPage.locator(".guided-seal-button").click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(worldName);

    await fresh!.context.close();
  });
});
