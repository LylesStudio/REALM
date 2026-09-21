import {
  expect,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export const DEMO_RECORD_ID = "record_first_watch";
export const DEMO_STORY_ID = "story_silent_bell";

/** dev server 实际地址：与 playwright.config 的 baseURL 保持一致。 */
export const GUI_BASE_URL = process.env.GUI_BASE_URL ?? (process.env.HOST_BIND ? `http://${process.env.HOST_BIND}:9999` : "http://127.0.0.1:9999");

/** 全局登录产物（tests/gui/global-setup.ts 写入）。 */
export const GUI_AUTH_STATE = ".playwright/auth-state.json";

/** 真实模型回合可能需要数十秒，提交类断言统一使用较长超时。 */
export const TURN_TIMEOUT = 180_000;

export function uniqueName(prefix: string): string {
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}${rand}`;
}

/** 等待记录页主界面加载完成（输入框可用）。 */
export async function waitForRecordReady(page: Page) {
  await expect(page.locator("#realm-message")).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".record-heading h1")).toBeVisible({ timeout: 60_000 });
}

/**
 * 打开演示记录 record_first_watch。
 * 批次 S 起默认入口按账号「最近打开」记忆解析，无记忆会进引导屏；
 * 测试一律走深链 ?recordId=，语义与旧版硬编码默认记录一致。
 */
export async function openDemoRecord(page: Page) {
  await page.goto(`/?recordId=${DEMO_RECORD_ID}`);
  await waitForRecordReady(page);
}

/** 打开世界库面板。 */
export async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "世界库" }).click();
  await expect(page.locator(".library-panel")).toBeVisible();
}

/** 打开世界库并展开「工笔细琢」手动录入抽屉。 */
export async function openManualForm(page: Page) {
  await openLibrary(page);
  await page.locator(".library-manual-toggle").click();
  await expect(page.locator(".library-form")).toBeVisible();
}

/** 通过世界库面板点击指定标题的记录进入。 */
export async function openRecordViaLibrary(page: Page, title: string) {
  await openLibrary(page);
  await page.locator(".library-record", { hasText: title }).first().click();
  await waitForRecordReady(page);
  await expect(page.locator(".record-heading h1")).toHaveText(title);
}

interface LibraryRecordEntry {
  id: string;
  title: string;
}

async function findRecordId(
  request: APIRequestContext,
  title: string,
): Promise<string> {
  const response = await request.get("/api/library");
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as {
    worlds: Array<{ stories: Array<{ records: LibraryRecordEntry[] }> }>;
  };
  for (const world of body.worlds) {
    for (const story of world.stories) {
      for (const record of story.records) {
        if (record.title === title) return record.id;
      }
    }
  }
  throw new Error(`记录未创建成功：${title}`);
}

/** 通过 API 创建隔离的测试记录（带唯一标题），返回记录 id 与标题。 */
export async function createRecordViaApi(
  request: APIRequestContext,
  options: { storyId?: string; title?: string; retrospection?: boolean } = {},
): Promise<{ id: string; title: string }> {
  const title = options.title ?? uniqueName("GUI记录");
  const response = await request.post("/api/library", {
    data: {
      kind: "record",
      storyId: options.storyId ?? DEMO_STORY_ID,
      title,
      retrospection: options.retrospection ?? false,
    },
  });
  expect(response.ok()).toBeTruthy();
  const id = await findRecordId(request, title);
  return { id, title };
}

/** 通过 API 创建隔离世界，返回世界 id 与名称。 */
export async function createWorldViaApi(
  request: APIRequestContext,
  name = uniqueName("GUI世界"),
): Promise<{ id: string; name: string }> {
  const response = await request.post("/api/library", {
    data: { kind: "world", name, era: "测试纪元", summary: "GUI 测试隔离世界。" },
  });
  expect(response.ok()).toBeTruthy();
  const library = (await (await request.get("/api/library")).json()) as {
    worlds: Array<{ id: string; name: string }>;
  };
  const world = library.worlds.find((entry) => entry.name === name);
  if (!world) throw new Error(`世界未创建成功：${name}`);
  return { id: world.id, name };
}

/** 通过 API 在指定世界创建故事，返回故事 id 与标题。 */
export async function createStoryViaApi(
  request: APIRequestContext,
  worldId: string,
  title = uniqueName("GUI故事"),
): Promise<{ id: string; title: string }> {
  const response = await request.post("/api/library", {
    data: { kind: "story", worldId, title, premise: "GUI 隔离测试故事。" },
  });
  expect(response.ok()).toBeTruthy();
  const library = (await (await request.get("/api/library")).json()) as {
    worlds: Array<{ id: string; stories: Array<{ id: string; title: string }> }>;
  };
  const story = library.worlds
    .find((world) => world.id === worldId)
    ?.stories.find((entry) => entry.title === title);
  if (!story) throw new Error(`故事未创建成功：${title}`);
  return story;
}

/** 通过 API 在指定故事创建记录，返回记录 id 与标题。 */
export async function createRecordInStory(
  request: APIRequestContext,
  storyId: string,
  title = uniqueName("GUI记录"),
): Promise<{ id: string; title: string }> {
  const response = await request.post("/api/library", {
    data: { kind: "record", storyId, title },
  });
  expect(response.ok()).toBeTruthy();
  const library = (await (await request.get("/api/library")).json()) as {
    worlds: Array<{
      stories: Array<{
        id: string;
        records: Array<{ id: string; title: string }>;
      }>;
    }>;
  };
  for (const world of library.worlds) {
    for (const story of world.stories) {
      const record = story.records.find((entry) => entry.title === title);
      if (record) return record;
    }
  }
  throw new Error(`记录未创建成功：${title}`);
}

/**
 * 提交一条自然输入并等待其作为已提交事件出现在时间线。
 * 真实模型偶发失败（422 TURN_FAILED / 5xx）不算 UI bug：按真实用户行为
 * 等待草稿恢复后重试，默认最多 3 次。
 */
export async function submitMessage(
  page: Page,
  content: string,
  options: { timeoutMs?: number; retries?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? TURN_TIMEOUT;
  const retries = options.retries ?? 4;
  const input = page.locator("#realm-message");
  let response: import("@playwright/test").Response | null = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (attempt > 0) {
      // 失败后界面应已恢复草稿；确认后重新送出。
      await expect(page.locator(".notice-bar")).toBeVisible({ timeout: 30_000 });
      await expect(input).toHaveValue(content, { timeout: 30_000 });
    } else {
      await input.fill(content);
    }
    const responsePromise = page.waitForResponse(
      (res) =>
        res.url().includes("/api/record/messages")
        && res.request().method() === "POST",
      { timeout: timeoutMs },
    );
    await page.getByRole("button", { name: "送出" }).click();
    response = await responsePromise;
    if (response.status() === 201 || response.status() === 428) break;
  }
  return { response: response! };
}

/** 等待包含指定文本的已提交事件卡片出现。 */
export async function expectCommittedEvent(
  page: Page,
  text: string,
  options: { timeoutMs?: number } = {},
) {
  const card = page.locator(".event-card.is-committed", { hasText: text }).last();
  await expect(card).toBeVisible({ timeout: options.timeoutMs ?? TURN_TIMEOUT });
  return card;
}

/** 通过 API 直接向指定记录提交一条消息（用于在他页制造事件）。 */
export async function submitMessageViaApi(
  request: APIRequestContext,
  recordId: string,
  content: string,
): Promise<number> {
  // 真实模型偶发失败不算 UI bug：最多重试 3 次。
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const recordResponse = await request.get(`/api/record?recordId=${recordId}`);
    expect(recordResponse.ok()).toBeTruthy();
    const envelope = (await recordResponse.json()) as { writeToken?: string };
    expect(envelope.writeToken).toBeTruthy();
    const clientMessageId = uniqueName("gui-api");
    const response = await request.post("/api/record/messages", {
      headers: { "Idempotency-Key": clientMessageId },
      data: {
        content,
        recordId,
        clientMessageId,
        writeToken: envelope.writeToken,
      },
      timeout: TURN_TIMEOUT,
    });
    if (response.status() === 201) return 201;
  }
  return 0;
}

/**
 * 批次 S：登录一个全新账号并返回其独立浏览器上下文。
 * 新账号没有任何「最近打开」记忆——默认入口必进引导屏。
 * 账户名 + 可选密码语义：无密码账户留空即可登录（REALM_ACCESS_TOKEN
 * 已退役，绝不读取 .env.local）。
 */
export async function createNewUserContext(
  browser: Browser,
  request: APIRequestContext,
): Promise<{ context: BrowserContext; displayName: string } | null> {
  const displayName = uniqueName("S界客");
  const response = await request.post("/api/auth/login", {
    data: { displayName, password: "" },
  });
  if (!response.ok()) return null;
  const setCookie = response.headers()["set-cookie"] ?? "";
  const match = /realm_session=([^;]+)/.exec(setCookie);
  if (!match) return null;
  const context = await browser.newContext({ baseURL: GUI_BASE_URL });
  await context.addCookies([
    {
      name: "realm_session",
      value: match[1],
      domain: new URL(GUI_BASE_URL).hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  return { context, displayName };
}
