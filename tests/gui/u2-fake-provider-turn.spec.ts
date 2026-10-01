import { expect, test } from "@playwright/test";
import {
  expectCommittedEvent,
  openDemoRecord,
  submitMessage,
} from "./helpers";
import { REALM_FAKE_STAGE_FIXTURES } from "../helpers/fake-openai-provider.mjs";

/**
 * 确定性玩家回合 tracer（离线 fake provider）：composer 提交 →
 * visibility/plan/narrator(stream)/review/release 全链 → 事件落库并渲染。
 * 零真实 provider 调用；失败必须显性（submitMessage 默认零重试）。
 */
test("fake provider：玩家回合提交→旁白落库→时间线可见", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await openDemoRecord(page);

  const playerText = "（环顾四周）这里好安静。";
  const { response } = await submitMessage(page, playerText);
  expect(response.status(), "玩家回合必须一次成功（确定性 fake）").toBe(201);

  // 玩家输入落库可见。
  await expectCommittedEvent(page, playerText);

  // 旁白（fake narrator fixture 的 environment 文本）经流式阶段落库可见。
  const narrator = REALM_FAKE_STAGE_FIXTURES.find((stage) => stage.id === "narrator");
  if (!narrator) throw new Error("narrator fixture missing");
  const narratorText = (narrator.body as { environment: string }).environment;
  await expectCommittedEvent(page, narratorText);

  expect(pageErrors, "pageerror 必须为零").toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("fake-provider-turn.png") });
});
