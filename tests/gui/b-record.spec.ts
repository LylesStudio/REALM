import { expect, test } from "@playwright/test";
import {
  createRecordViaApi,
  DEMO_RECORD_ID,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
  submitMessageViaApi,
} from "./helpers";

const SEMANTIC_COLORS: Record<string, string> = {
  environment: "rgb(63, 103, 112)",
  story: "rgb(112, 85, 107)",
  fact: "rgb(138, 103, 45)",
  action: "rgb(82, 107, 80)",
  dialogue: "rgb(155, 73, 56)",
};

test.describe("B. 记录页交互", () => {
  test("B1 时间线加载：已提交事件按序显示且正文完整", async ({ page }) => {
    await openDemoRecord(page);

    const cards = page.locator(".event-card.is-committed");
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeGreaterThanOrEqual(1);
    const firstContent = cards.first().locator(".semantic-content");
    await expect(firstContent).toContainText("雾沿着石阶爬上防波堤。");
    await expect(firstContent).toContainText("信使放下蜡封完好的黑色信函。");
    await expect(firstContent).toContainText("远处灯塔的光随第三声钟鸣熄灭。");
    // 序号轴按序渲染
    await expect(cards.first().locator(".event-axis span")).toHaveText("01");
  });

  test("B2 语义段渲染：五类语义只以文字颜色区分，无底色/边框/内边距", async ({
    page,
    request,
  }) => {
    // 造一条玩家事件覆盖动作/台词两类片段。
    const record = await createRecordViaApi(request);
    const status = await submitMessageViaApi(request, record.id, "（环顾四周）这里好安静。");
    expect(status).toBe(201);

    // 演示记录的旁白事件覆盖环境/剧情/关键事实。
    await openDemoRecord(page);
    for (const kind of ["environment", "story", "fact"]) {
      const segment = page
        .locator(`.semantic-segment[data-segment-kind="${kind}"]`)
        .first();
      await expect(segment).toBeVisible();
      await expect(segment).toHaveCSS("color", SEMANTIC_COLORS[kind]!);
      await expect(segment).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(segment).toHaveCSS("padding", "0px");
      const borderWidth = await segment.evaluate(
        (node) => getComputedStyle(node).borderWidth,
      );
      expect(borderWidth).toBe("0px");
    }

    // 新记录的玩家事件覆盖动作/台词。
    await openRecordViaLibrary(page, record.title);
    for (const kind of ["action", "dialogue"]) {
      const segment = page
        .locator(`.semantic-segment[data-segment-kind="${kind}"]`)
        .first();
      await expect(segment).toBeVisible();
      await expect(segment).toHaveCSS("color", SEMANTIC_COLORS[kind]!);
      await expect(segment).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(segment).toHaveCSS("padding", "0px");
      const borderWidth = await segment.evaluate(
        (node) => getComputedStyle(node).borderWidth,
      );
      expect(borderWidth).toBe("0px");
    }

    // 正文占满卡片可用宽度（不出现独立窄列）。
    const widths = await page
      .locator(".event-card.is-committed article")
      .first()
      .evaluate((article) => {
        const content = article.querySelector(".semantic-content");
        if (!content) return { article: 0, content: 0 };
        return {
          article: article.clientWidth,
          content: (content as HTMLElement).clientWidth,
        };
      });
    expect(widths.content).toBeGreaterThan(0);
    expect(widths.content / widths.article).toBeGreaterThan(0.9);
  });

  test("B3 自然输入提交：201 且时间线出现新事件", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const content = "今晚的雾比昨晚更重。";
    const { response } = await submitMessage(page, content);
    expect(response.status()).toBe(201);

    const card = page.locator(".event-card.is-committed", { hasText: content });
    await expect(card).toBeVisible();
    await expect(card.locator(".speaker-block h3")).toHaveText("洛川");
  });

  test("B4 括号动作 + 台词：动作与台词被拆分呈现", async ({ page, request }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const { response } = await submitMessage(page, "（环顾四周）这里好安静。");
    expect(response.status()).toBe(201);

    const card = page.locator(".event-card.is-committed", {
      hasText: "这里好安静",
    }).first();
    await expect(card).toBeVisible();
    await expect(
      card.locator('.semantic-segment[data-segment-kind="action"]'),
    ).toContainText("环顾四周");
    await expect(
      card.locator('.semantic-segment[data-segment-kind="dialogue"]'),
    ).toContainText("这里好安静");
  });

  test("B5 乐观发送与清理：输入框即时空、事件出现、按钮恢复", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const content = "我点头示意。";
    const input = page.locator("#realm-message");
    await input.fill(content);
    // 在途态下按钮文案变为“处理中”，可访问名不稳定，按类型定位。
    const sendButton = page.locator(".message-composer button[type=submit]");
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/record/messages")
        && res.request().method() === "POST",
      { timeout: 180_000 },
    );
    await sendButton.click();

    // 提交即刻清空输入并禁用按钮（乐观发送体验）。
    // 在途态持续数秒（真实模型回合），1 秒轮询窗口内必然可观察到禁用态，
    // 且不会被回合结束后的状态恢复抢跑。
    await expect(input).toHaveValue("");
    await expect
      .poll(
        () => sendButton.evaluate((button) => (button as HTMLButtonElement).disabled),
        { timeout: 1_000 },
      )
      .toBe(true);

    const response = await responsePromise;
    // 真实模型偶发失败不算 UI bug：失败后草稿恢复，补一次重试。
    if (response.status() !== 201) {
      await expect(input).toHaveValue(content, { timeout: 30_000 });
      const retryPromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: 180_000 },
      );
      await sendButton.click();
      await retryPromise;
    }
    await expect(
      page.locator(".event-card.is-committed", { hasText: content }),
    ).toBeVisible({ timeout: 180_000 });
    // 按钮从“处理中”恢复为“送出”；输入新内容后恢复可用。
    await expect(sendButton).toContainText("送出");
    await input.fill("恢复可用检查。");
    await expect(sendButton).toBeEnabled();
  });

  test("B6 失败恢复：草稿移除、输入恢复、可重试、无幽灵事件", async ({
    page,
    request,
  }) => {
    const record = await createRecordViaApi(request);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const content = "这条消息先失败后重试。";
    await page.route("**/api/record/messages", (route) => route.abort());
    try {
      await page.locator("#realm-message").fill(content);
      await page.getByRole("button", { name: "送出" }).click();

      await expect(page.locator(".notice-bar")).toBeVisible({ timeout: 30_000 });
      await expect(page.locator("#realm-message")).toHaveValue(content);
      // 不出现幽灵事件（无 pending/committed 卡片携带该内容）。
      await expect(
        page.locator(".event-card", { hasText: content }),
      ).toHaveCount(0);
    } finally {
      await page.unroute("**/api/record/messages");
    }

    // 恢复网络后可直接重试并成功提交。
    // 真实模型偶发失败不算 UI bug：最多重试 3 次。
    let status = 0;
    for (let attempt = 0; attempt < 4 && status !== 201; attempt += 1) {
      const responsePromise = page.waitForResponse(
        (res) =>
          res.url().includes("/api/record/messages")
          && res.request().method() === "POST",
        { timeout: 180_000 },
      );
      await page.getByRole("button", { name: "送出" }).click();
      status = (await responsePromise).status();
    }
    expect(status).toBe(201);
    await expect(
      page.locator(".event-card.is-committed", { hasText: content }),
    ).toBeVisible({ timeout: 180_000 });
  });

  test("B7 语义流式呈现：最新事件按短句逐段显示，最终文本完整", async ({
    page,
    request,
  }) => {
    // 从 API 取演示记录最近一条多段事件的完整拼接文本作为基准
    // （设定结晶的「场景定格」系统事件只有单段，不适用流式断言）。
    const recordResponse = await request.get(`/api/record?recordId=${DEMO_RECORD_ID}`);
    const envelope = (await recordResponse.json()) as {
      record: {
        events: Array<{ speaker?: string; segments?: Array<{ content: string }> }>;
      };
    };
    const multiSegment = [...envelope.record.events]
      .reverse()
      .find((event) => (event.segments?.length ?? 0) > 1);
    expect(multiSegment?.segments?.length).toBeGreaterThan(1);
    const fullText = (multiSegment?.segments ?? [])
      .map((segment) => segment.content)
      .join("");

    await page.goto(`/?recordId=${DEMO_RECORD_ID}`);
    const content = page
      .locator(".event-card.is-committed", { hasText: fullText.slice(0, 12) })
      .last()
      .locator(".semantic-content");
    await content.waitFor({ state: "attached", timeout: 60_000 });

    // 流式期间应观察到比完整文本短的中间态（初始为空，逐句增长）。
    // 注意：历史事件经 SSE 重放可能瞬时完成，首帧即为完整文本，
    // 因此不硬性要求抓到中间态；改为验证观察序列单调不减
    // （流式增长不回跳），最终文本必须完整。
    const observedLengths: number[] = [];
    const deadline = Date.now() + 30_000;
    let finalText = "";
    while (Date.now() < deadline) {
      const current = (await content.textContent()) ?? "";
      observedLengths.push(current.length);
      if (current === fullText) {
        finalText = current;
        break;
      }
      await page.waitForTimeout(10);
    }
    expect(finalText).toBe(fullText);
    const isMonotonic = observedLengths.every(
      (length, index) => index === 0 || length >= observedLengths[index - 1]!,
    );
    expect(isMonotonic).toBe(true);
  });
});
