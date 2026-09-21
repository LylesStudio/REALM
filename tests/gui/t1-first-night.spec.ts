import { expect, test, type Page } from "@playwright/test";
import {
  createNewUserContext,
  submitMessage,
  TURN_TIMEOUT,
  uniqueName,
  waitForRecordReady,
} from "./helpers";

/**
 * T1. 批次 T1：世界初夜——落笔入界后的第一轮可玩密度。
 * 见 docs/development/T1-FIRST-NIGHT.md 验收标准。
 * 全程真实模型回合，不 mock；每个用例以全新账号开局。
 */

type ChatResponseBody = { ok?: boolean; reply?: string };

/**
 * 按请求体 message 精确匹配某一轮 genesis-chat POST 应答。
 * 开场空输入请求与上一轮应答可能仍在途，宽松匹配会抢错应答（批次 S 实证）。
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
 * 司卷对谈发一轮并等待应答；模型阵发沉默时点「再试一次」重发，至多 3 次。
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

/**
 * 开局：新用户引导屏 → 司卷对谈开场 → ≥2 轮对话 → 世界提案卡浮现。
 * 返回提案卡定位器（已可见）。
 */
async function chatToProposalCard(page: Page, worldConcept: string) {
  await page.goto("/");
  await expect(page.locator(".world-onboarding")).toBeVisible({ timeout: 60_000 });
  // 司卷自动开场（首轮空输入请求）。先挂应答等待再点入口。
  const openingPromise = page.waitForResponse(chatPostFor(""), { timeout: TURN_TIMEOUT });
  await page.locator(".onboarding-entry.is-primary").click();
  await expect(page.locator(".guided-genesis-chat")).toBeVisible();
  let openingBody = (await (await openingPromise).json()) as ChatResponseBody;
  for (let attempt = 0; openingBody.ok !== true && attempt < 2; attempt += 1) {
    openingBody = await clickSilentRetry(page, "");
  }
  expect(openingBody.ok).toBe(true);
  await expect(page.locator(".chat-turn.is-scribe").first()).toBeVisible({ timeout: 30_000 });

  // 第一轮：自由输入世界构想。
  await sendChat(page, worldConcept);
  await expect(page.locator(".chat-turn.is-scribe").nth(1)).toBeVisible({ timeout: 30_000 });

  // 第二轮：明确要求完整提案。
  await sendChat(
    page,
    "就按你的理解给出完整世界提案：世界名、纪元、底色、开篇故事、我的定位、同行者与初始场景。",
  );

  // 提案卡可能出现于本轮或下一轮；至多再追问两轮。
  const card = page.locator(".genesis-proposal-card");
  let cardVisible = await card
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => true, () => false);
  for (let attempt = 0; !cardVisible && attempt < 2; attempt += 1) {
    await sendChat(page, "请直接给出完整提案，不必再追问。");
    cardVisible = await card
      .waitFor({ state: "visible", timeout: 10_000 })
      .then(() => true, () => false);
  }
  await expect(card).toBeVisible({ timeout: 30_000 });
  return card;
}

test.describe("T1. 世界初夜：落笔即有密度", () => {
  test("T1-1 场景即时生成：开场旁白首屏非空，初夜场景定格异步渐显", async ({
    request,
    browser,
  }) => {
    test.setTimeout(900_000);
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    // ≥2 轮司卷对谈 → 提案卡。
    const card = await chatToProposalCard(
      freshPage,
      "我想写一座沉在湖底的旧钟楼：钟声仍能在水下传播，靠听钟声辨认方向。",
    );

    // 就地定稿：世界名加唯一后缀；初始场景地点写入唯一值，
    // 供「场景卡地点与提案一致」断言。
    const nameInput = card.locator("input").first();
    const proposedName = ((await nameInput.inputValue()) ?? "").trim();
    expect(proposedName.length).toBeGreaterThan(0);
    const editedName = `${proposedName}初`.slice(0, 40);
    await nameInput.fill(editedName);
    const sceneLocation = uniqueName("湖底钟楼");
    await card.locator(".scene-grid input").first().fill(sceneLocation);

    // 落笔入界：进入新记录（事务内确定性开场旁白已落库）。
    await freshPage.getByRole("button", { name: "落笔入界" }).click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(editedName);

    // 首屏非空：确定性开场旁白可见，时间线不留白。
    await expect(freshPage.locator(".timeline-empty")).toHaveCount(0);
    const narratorEvents = freshPage.locator(".event-card.event-narrator.is-committed");
    await expect(narratorEvents.first()).toBeVisible();

    // 场景卡地点非空且与提案一致。
    await expect(freshPage.locator(".scene-card h2")).toContainText(sceneLocation);

    // 异步初夜：pending 期间状态条可见，或模型极快时事件已渐显——二者必居其一。
    const chip = freshPage.locator(".first-night-status");
    await expect
      .poll(async () => (await chip.count()) + (await narratorEvents.count()), {
        timeout: 30_000,
      })
      .toBeGreaterThanOrEqual(2);

    // 轮询内（2.5s × 90s）出现初夜场景定格旁白：第二条旁白事件，
    // presentation 三段（environment/story/fact）以语义段呈现。
    await expect
      .poll(async () => narratorEvents.count(), { timeout: 120_000 })
      .toBeGreaterThanOrEqual(2);
    const firstNightEvent = narratorEvents.nth(1);
    await expect(
      firstNightEvent.locator(
        ".semantic-segment[data-segment-kind=environment], "
          + ".semantic-segment[data-segment-kind=story], "
          + ".semantic-segment[data-segment-kind=fact]",
      ).first(),
    ).toBeVisible();
    // 场景定格落库后状态条消失（ready/degraded 均不再显示 pending 条）。
    await expect(chip).toHaveCount(0);
    // 时间线保持非空。
    await expect(freshPage.locator(".timeline-empty")).toHaveCount(0);

    await fresh!.context.close();
  });

  test("T1-2 角色在场：提案同行者在初夜发声，阵容卡列名", async ({
    request,
    browser,
  }) => {
    test.setTimeout(900_000);
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    // ≥2 轮司卷对谈 → 提案卡。
    const card = await chatToProposalCard(
      freshPage,
      "我想写一间开在渡口的深夜面馆：往来的夜行人用一段秘密换一碗面。",
    );

    // 定稿世界名；并确保提案含一名同行者（模型已给则改名定值，未给则添一行）。
    const nameInput = card.locator("input").first();
    const proposedName = ((await nameInput.inputValue()) ?? "").trim();
    expect(proposedName.length).toBeGreaterThan(0);
    const editedName = `${proposedName}面`.slice(0, 40);
    await nameInput.fill(editedName);
    const companionName = uniqueName("灶娘");
    const companionRows = card.locator(".companion-row");
    if ((await companionRows.count()) > 0) {
      await companionRows.first().locator("input").first().fill(companionName);
    } else {
      await card.locator(".companion-add").click();
      const row = card.locator(".companion-row").first();
      await row.locator("input").nth(0).fill(companionName);
      await row.locator("input").nth(1).fill("面馆掌勺");
      await row.locator("input").nth(2).fill("听得懂夜行人没说出口的话。");
    }

    // 落笔入界。
    await freshPage.getByRole("button", { name: "落笔入界" }).click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(editedName);

    // 阵容卡列出同行者（在场名单先行）。
    await expect(freshPage.locator(".cast-list")).toContainText(companionName);

    // 初夜完成后，时间线出现以同行者名为发言人的角色事件（event-character），
    // 含台词段（dialogue，speechMode speaker）。
    const characterEvent = freshPage.locator(".event-card.event-character.is-committed", {
      hasText: companionName,
    });
    await expect(characterEvent.first()).toBeVisible({ timeout: 120_000 });
    await expect(
      characterEvent.first().locator(".semantic-segment[data-segment-kind=dialogue]"),
    ).toBeVisible();
    // 状态条收尾消失。
    await expect(freshPage.locator(".first-night-status")).toHaveCount(0);

    await fresh!.context.close();
  });

  test("T1-3 开场钩子与提案：钩子事件进时间线，开场提案补位行动卡", async ({
    request,
    browser,
  }) => {
    test.setTimeout(900_000);
    const fresh = await createNewUserContext(browser, request);
    test.skip(!fresh, "访问门禁未启用，无法创建新用户。");
    const freshPage = await fresh!.context.newPage();

    // ≥2 轮司卷对谈 → 提案卡。
    const card = await chatToProposalCard(
      freshPage,
      "我想写一座只在涨潮时出现的灯塔：守塔人用灯光给迷路的船记账。",
    );

    // 定稿：世界名唯一；场景地点唯一 + 明确目标（降级路径也保底钩子与提案）；
    // 确保一名同行者在场。
    const nameInput = card.locator("input").first();
    const proposedName = ((await nameInput.inputValue()) ?? "").trim();
    expect(proposedName.length).toBeGreaterThan(0);
    const editedName = `${proposedName}潮`.slice(0, 40);
    await nameInput.fill(editedName);
    const sceneInputs = card.locator(".scene-grid input");
    const sceneLocation = uniqueName("潮汐灯塔");
    await sceneInputs.nth(0).fill(sceneLocation);
    await sceneInputs.nth(3).fill("查清今晚最后靠岸那艘船的来历");
    const companionName = uniqueName("守塔人");
    const companionRows = card.locator(".companion-row");
    if ((await companionRows.count()) > 0) {
      await companionRows.first().locator("input").first().fill(companionName);
    } else {
      await card.locator(".companion-add").click();
      const row = card.locator(".companion-row").first();
      await row.locator("input").nth(0).fill(companionName);
      await row.locator("input").nth(1).fill("守塔人");
      await row.locator("input").nth(2).fill("认得每一盏迷路的灯。");
    }

    // 落笔入界 → 初夜完成（pending 状态条消失）。
    await freshPage.getByRole("button", { name: "落笔入界" }).click();
    await waitForRecordReady(freshPage);
    await expect(freshPage.locator(".breadcrumb")).toContainText(editedName);
    await expect(freshPage.locator(".first-night-status")).toHaveCount(0, { timeout: 120_000 });

    // 钩子卡：司镜台展示开场钩子，文本非空。
    const hookContent = freshPage.locator(".hook-card .hook-content");
    await expect(hookContent).toBeVisible({ timeout: 30_000 });
    const hookText = (await hookContent.innerText()).trim();
    expect(hookText.length).toBeGreaterThan(0);

    // 钩子事件：同一钩子文本以旁白形态落进时间线。
    await expect(
      freshPage.locator(".event-card.event-narrator.is-committed", { hasText: hookText }).first(),
    ).toBeVisible();

    // 开场提案：≥2 张行动卡，且不出现「观察四周」式泛化表述。
    const slips = freshPage.locator(".suggestion-slip");
    await expect
      .poll(async () => (await slips.allInnerTexts()).length, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
    const slipTexts = await slips.allInnerTexts();
    for (const text of slipTexts) {
      expect(text).not.toContain("观察四周");
    }

    // 点击提案 → 只填入输入框（玩家确认后送出，不代提交）。
    const chosen = slipTexts[0]!.trim();
    const before = await freshPage.locator(".event-card.is-committed").count();
    await slips.first().click();
    await expect(freshPage.locator("#realm-message")).toHaveValue(chosen);

    // 走共享提交通道：时间线增长（本回合话语落库）。
    await submitMessage(freshPage, chosen);
    await expect
      .poll(async () => freshPage.locator(".event-card.is-committed").count(), {
        timeout: TURN_TIMEOUT,
      })
      .toBeGreaterThan(before);

    await fresh!.context.close();
  });
});
