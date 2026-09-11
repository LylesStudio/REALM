import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  openRecordViaLibrary,
} from "./helpers";

test.describe("P. 世界文风系统", () => {
  test("P1 新世界默认 modern：行动卡与提问语无古风串场", async ({
    page,
    request,
  }) => {
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 行动卡：modern 留白兜底措辞（非古风）。
    await page.getByRole("button", { name: "行动" }).click();
    const panel = page.getByRole("dialog", { name: "当前可用行动" });
    const observe = panel.locator("button", { hasText: "观察四周" });
    await expect(observe).toContainText("留意周遭环境的变化");
    await expect(observe).not.toContainText("留心四方动静");
    // 空时间线卷首：modern 措辞。
    await expect(page.locator(".timeline-empty h2")).toHaveText(
      "新的一页，还没有内容",
    );

    // 司卷问答提问语：modern 措辞。
    await openLibrary(page);
    await page.locator(".guided-entry").click();
    await expect(page.locator(".guided-question")).toContainText(
      "先给这个世界起个名字吧",
    );
    await expect(page.locator(".guided-question")).not.toContainText("当以何名传世");
    await page.getByRole("button", { name: "退出引导" }).click();
  });

  test("P2 司卷问答文风步：点选入卷，跳过不留条目", async ({ page }) => {
    await openDemoRecord(page);
    await openLibrary(page);
    await page.locator(".guided-entry").click();

    // 世界之名 → 纪元基调（跳过）→ 文风步。
    await page.getByRole("textbox", { name: "世界之名输入" }).fill("P2 风格试验场");
    await page.locator(".guided-confirm").click();
    await page.locator(".guided-skip").click();

    await expect(page.locator(".guided-heading h2")).toHaveText("文风");
    const options = page.locator(".guided-style-option");
    await expect(options).toHaveCount(4);
    // 点选「西幻」：立即进入下一步，已定之卷浮现文风条目。
    await options.filter({ hasText: "西幻" }).click();
    await expect(page.locator(".guided-heading h2")).toHaveText("世界底色");
    // 文风步之后的提问语切换为西幻笔调。
    await expect(page.locator(".guided-question")).toContainText("立传");
    const scroll = page.locator(".guided-scroll");
    await expect(
      scroll.locator(".scroll-entry", { hasText: "文风" }),
    ).toContainText("西幻");

    // 退出重开验证跳过路径：文风步跳过 → 卷上不现条目。
    await page.getByRole("button", { name: "退出引导" }).click();
    await openLibrary(page);
    await page.locator(".guided-entry").click();
    await page.getByRole("textbox", { name: "世界之名输入" }).fill("P2 跳过组");
    await page.locator(".guided-confirm").click();
    await page.locator(".guided-skip").click();
    await expect(page.locator(".guided-heading h2")).toHaveText("文风");
    await page.locator(".guided-skip").click();
    await expect(page.locator(".guided-heading h2")).toHaveText("世界底色");
    await expect(page.locator(".guided-scroll")).not.toContainText("文风");
  });

  test("P3 世界库改文风后行动卡文案随之变化，demo 保持 classical", async ({
    page,
    request,
  }) => {
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 初始 modern。
    await page.getByRole("button", { name: "行动" }).click();
    await expect(
      page.getByRole("dialog", { name: "当前可用行动" }),
    ).toContainText("留意周遭环境的变化");
    await page.getByRole("button", { name: "关闭行动面板" }).click();

    // 世界库切换为二次元。
    await openLibrary(page);
    const picker = page.locator(".library-world", { hasText: world.name })
      .locator(".library-style-picker");
    await picker.locator("button", { hasText: "二次元" }).click();
    await expect(
      picker.locator("button", { hasText: "二次元" }),
    ).toHaveClass(/is-active/);
    await page.getByRole("button", { name: "关闭世界库" }).click();

    // 行动卡立即跟随新文风（每回合从世界快照读取）。
    await openRecordViaLibrary(page, record.title);
    await page.getByRole("button", { name: "行动" }).click();
    await expect(
      page.getByRole("dialog", { name: "当前可用行动" }),
    ).toContainText("注意周围的变化哦");
    await page.getByRole("button", { name: "关闭行动面板" }).click();

    // demo 世界保持 classical（不因新世界切换而变）。
    await openDemoRecord(page);
    await page.getByRole("button", { name: "行动" }).click();
    await expect(
      page.getByRole("dialog", { name: "当前可用行动" }),
    ).toContainText("留意灰鲸港 · 北防波堤一带的动静");
  });
});
