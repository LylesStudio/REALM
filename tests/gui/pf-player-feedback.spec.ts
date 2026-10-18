import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { openDemoRecord, waitForRecordReady, uniqueName } from "./helpers";

test("PF1 background generation identifies speakers, blocks send but preserves editable drafts, then refreshes and submits", async ({ page }) => {
  await openDemoRecord(page);
  const response = await page.request.post("/api/world/generate", { data: { creationRequestId: randomUUID(), draft: {
    world: { name: uniqueName("GUI角色名") }, playerName: "霁川", playerRole: "领航员", companions: [],
    opening: "一封信放在桌上。", scene: { location: "码头" },
  } } });
  expect(response.ok()).toBe(true);
  const created = await response.json();
  let mode: "busy" | "idle" | "error" = "busy";
  let phase = "character";
  let posts = 0;
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/record/messages" && request.method() === "POST") posts++; });
  // Finish the real opening before injecting stage transitions. A mocked idle
  // response must not bypass a genuinely running first-night commit.
  await page.goto(`/?recordId=${created.recordId}`);
  await waitForRecordReady(page);
  const indicator = page.locator(".generation-indicator");
  await expect(indicator).toHaveCount(0, { timeout: 60_000 });
  await page.route("**/api/record/generation?**", async (route) => {
    if (mode === "error") { await route.abort(); return; }
    await route.fulfill({ json: { ok: true, recordId: created.recordId, generation: {
      busy: mode === "busy", activities: mode === "busy" ? [{ phase, ...(phase === "character" ? { speaker: "阿橹" } : {}) }] : [],
    } } });
  });
  await expect(indicator).toContainText("阿橹正在思考");
  const input = page.locator("#realm-message");
  await expect(input).toBeEnabled();
  await input.fill("我检查桌上的信。");
  await input.press("Enter");
  expect(posts).toBe(0);
  await expect(input).toHaveValue("我检查桌上的信。");
  phase = "narrator";
  await expect(indicator).toContainText("旁白正在生成");
  phase = "reviewer";
  await expect(indicator).toContainText("裁判正在审核");
  mode = "error";
  await expect(indicator).toContainText("正在确认生成状态");
  await expect(input).toHaveValue("我检查桌上的信。");
  mode = "idle";
  await expect(indicator).toHaveCount(0);
  const send = page.locator('.message-composer button[type="submit"]');
  await expect(send).toBeEnabled();
  const message = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/record/messages" && result.request().method() === "POST");
  await send.click();
  expect((await message).status()).toBe(202);
  await expect(page.locator(".event-card.is-committed").filter({ hasText: "我检查桌上的信。" }).first()).toContainText("霁川", { timeout: 60_000 });
  expect(posts).toBe(1);
  await page.reload();
  await waitForRecordReady(page);
  await expect(page.locator(".event-card.is-committed").filter({ hasText: "我检查桌上的信。" }).first()).toContainText("霁川");
});

test("PF2 guided creation exposes an independent role name and carries it into review and persisted cast", async ({ page }) => {
  await openDemoRecord(page);
  await page.getByRole("button", { name: "世界库", exact: true }).click();
  await page.locator(".guided-entry:not(.is-primary)").click();
  await page.getByRole("textbox", { name: "世界名称输入" }).fill(uniqueName("GUI姓名引导"));
  await page.locator(".guided-confirm").click();
  for (let step = 0; step < 4; step++) await page.locator(".guided-skip").click();
  await page.getByLabel("角色姓名", { exact: true }).fill("夜航");
  await page.locator(".guided-input").fill("船长");
  await page.locator(".guided-confirm").click();
  for (let step = 0; step < 3; step++) await page.locator(".guided-skip").click();
  await expect(page.locator(".guided-review")).toContainText("夜航");
  const sealed = page.waitForResponse((result) => new URL(result.url()).pathname === "/api/world/generate" && result.request().method() === "POST");
  await page.locator(".guided-seal-button").click();
  const result = await (await sealed).json();
  expect(result.ok).toBe(true);
  const read = await page.request.get(`/api/record?recordId=${result.recordId}`);
  expect(JSON.stringify(await read.json())).toContain("夜航");
});
