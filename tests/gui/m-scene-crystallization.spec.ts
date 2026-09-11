import { expect, test, type Page } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openRecordViaLibrary,
  submitMessage,
  waitForRecordReady,
} from "./helpers";

/**
 * M 组：设定结晶与逻辑一致性裁决（真实模型，两段式管线异步执行）。
 * 提取 + 裁决各一次模型调用，thinking 启用下单次可达一分钟以上，
 * 轮询窗口与用例超时都按此放宽。全部用例在隔离的 GUI 世界中进行，
 * 不污染演示世界的共享设定。
 */
const CRYSTALLIZATION_POLL_TIMEOUT = 300_000;

interface SceneState {
  location: string;
  worldTime: string;
  weather: string;
  tension: string;
  objective: string;
}

async function readScene(page: Page, recordId: string): Promise<SceneState> {
  const response = await page.request.get(`/api/record?recordId=${recordId}`);
  const body = (await response.json()) as { record?: { scene?: SceneState } };
  return body.record?.scene ?? {
    location: "",
    worldTime: "",
    weather: "",
    tension: "",
    objective: "",
  };
}

test.describe("M. 设定结晶与逻辑一致性裁决", () => {
  test("M1 动态生长：说出新地点与天气后场景面板对应字段浮现", async ({
    page,
    request,
  }) => {
    test.setTimeout(600_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    const content = "我们离开空地，赶到山脚下的灯塔值房避雪，外面的雪越下越大。";
    const { response } = await submitMessage(page, content);
    expect([201, 428]).toContain(response.status());

    // 结晶管线异步完成：轮询投影直到地点写回。
    await expect
      .poll(async () => (await readScene(page, record.id)).location, {
        timeout: CRYSTALLIZATION_POLL_TIMEOUT,
        intervals: [5_000, 10_000, 15_000, 20_000],
      })
      .toContain("灯塔值房");

    // 面板随投影浮现（结构性消隐的反面：有值即显现）。
    // 重新打开该记录以载入最新投影（记录选择不落在 URL 上）。
    await openRecordViaLibrary(page, record.title);
    await waitForRecordReady(page);
    await expect(page.locator(".scene-card h2")).toContainText("灯塔值房");
    await expect(page.locator(".scene-facts")).toContainText("雪");
    // 时间线留有结晶痕迹。
    await expect(
      page.locator(".event-card", { hasText: "场景定格" }).first(),
    ).toBeVisible();
  });

  test("M2 矛盾裁决：说出时间倒退的矛盾设定，世界时间保持不变", async ({
    page,
    request,
  }) => {
    test.setTimeout(720_000);
    const world = await createWorldViaApi(request);
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);
    await openDemoRecord(page);
    await openRecordViaLibrary(page, record.title);

    // 第一回合：建立时间基准（新历 40 年 3 月 2 日正午）。
    const establish = "现在是新历40年3月2日的正午，我们在营地清点行囊，准备出发。";
    const first = await submitMessage(page, establish);
    expect([201, 428]).toContain(first.response.status());
    await expect
      .poll(async () => (await readScene(page, record.id)).worldTime, {
        timeout: CRYSTALLIZATION_POLL_TIMEOUT,
        intervals: [5_000, 10_000, 15_000, 20_000],
      })
      .toContain("3月2日");

    // 第二回合：矛盾的时间倒退宣称，裁决应拒绝。
    const contradiction = "时间倒流回新历40年3月1日的清晨，太阳重新升起来了。";
    const second = await submitMessage(page, contradiction);
    expect([201, 428]).toContain(second.response.status());

    // 观察窗口覆盖提取+裁决两次模型调用；任何 fail-closed 分支
    // （提取为空、裁决拒绝、写回失败）都表现为世界时间不变。
    const startedAt = Date.now();
    let latest = await readScene(page, record.id);
    while (Date.now() - startedAt < 150_000) {
      await page.waitForTimeout(5_000);
      latest = await readScene(page, record.id);
    }
    expect(latest.worldTime).toContain("3月2日");
    expect(latest.worldTime).not.toContain("3月1日");
  });
});
