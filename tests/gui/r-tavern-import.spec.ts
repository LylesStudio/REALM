import { expect, test } from "@playwright/test";
import {
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
} from "./helpers";

/** 内存构造合成 PNG 角色卡（tEXt chara 块）。 */
function buildCardPng(card: unknown): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "ascii");
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const base64 = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("tEXt", Buffer.concat([
      Buffer.from("chara", "latin1"),
      Buffer.from([0]),
      Buffer.from(base64, "latin1"),
    ])),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CARD = {
  spec: "chara_card_v2",
  data: {
    name: "艾拉",
    description: "旅队里的年轻制图师。",
    personality: "谨慎",
    character_book: {
      entries: [
        { name: "商路", content: "群山商路每逢月圆封山。", keys: ["商路"], enabled: true },
        { name: "旧约", content: "旧约条目内容。", keys: ["旧约"], enabled: false },
      ],
    },
  },
};

test.describe("R. 酒馆格式导入", () => {
  test("R1 合成卡导入：角色出现 + 头像渲染 + 报告正确（含禁用跳过名单）", async ({
    page,
    request,
  }) => {
    const world = await createWorldViaApi(request);
    await openDemoRecord(page);
    await openLibrary(page);

    const worldSection = page.locator(".library-world", { hasText: world.name });
    const fileInput = worldSection.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "ella.png",
      mimeType: "image/png",
      buffer: buildCardPng(CARD),
    });

    // 导入报告：角色名 + 头像 + 条目数 + 跳过名单。
    const report = worldSection.locator(".library-import-report");
    await expect(report).toBeVisible();
    await expect(report).toContainText("艾拉");
    await expect(report).toContainText("旧约");
    await expect(report.locator("img.library-avatar")).toBeVisible();

    // 角色行出现并渲染头像。
    const character = worldSection.locator(".library-character", { hasText: "艾拉" });
    await expect(character).toBeVisible();
    const avatar = character.locator("img.library-avatar");
    await expect(avatar).toBeVisible();
    // 头像端点真实返回图像字节（合成 PNG 为 1×1，浏览器 naturalWidth 为 1）。
    const avatarSrc = await avatar.getAttribute("src");
    expect(avatarSrc).toMatch(/^\/api\/files\//);
    const avatarResponse = await page.request.get(avatarSrc!);
    expect(avatarResponse.ok()).toBeTruthy();
    expect(avatarResponse.headers()["content-type"]).toBe("image/png");
    expect((await avatarResponse.body()).length).toBeGreaterThan(0);
  });

  test("R2 坏文件报错且不落库", async ({ page, request }) => {
    const world = await createWorldViaApi(request);
    await openDemoRecord(page);
    await openLibrary(page);

    const worldSection = page.locator(".library-world", { hasText: world.name });
    await worldSection.locator('input[type="file"]').setInputFiles({
      name: "bad.json",
      mimeType: "application/json",
      buffer: Buffer.from("这不是合法导入文件"),
    });

    await expect(worldSection.locator(".library-import-error")).toBeVisible();
    // 不落库：角色列表没有新增。
    await expect(
      worldSection.locator(".library-character"),
    ).toHaveCount(0);
  });
});
