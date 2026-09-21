import { expect, test } from "@playwright/test";
import {
  createRecordInStory,
  createStoryViaApi,
  createWorldViaApi,
  openDemoRecord,
  openLibrary,
  openRecordViaLibrary,
  TURN_TIMEOUT,
} from "./helpers";

/** 内存构造合成 PNG 角色卡（tEXt chara 块，与 R 组同款）。 */
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

/**
 * 批次 T6 导入卡参局（docs/development/T6-TAVERN-IMPORT-PLAY.md §5.2）：
 * 酒馆导入带 extensions.realm_skills 的角色卡 → 新建记录装配入阵容并授权
 * → 真实模型回合内该角色使用技能 → 行动裁决卡骰点可见（T5 投影延续）。
 * 全程真实模型，不新增任何 mock。
 *
 * 卡技能「制图术」（2d6 +1 / 目标 8），GUI 最终要求 2d6 骰点，
 * 以区分导入技能与 AI 实例原有的基础 d20 技能。
 */
test.describe("T6. 导入卡参局 · 酒馆角色真实模型参局", () => {
  test("T6-1 导入角色回合内使用技能 → 骰点可见且落库", async ({
    page,
    request,
  }) => {
    test.setTimeout(900_000);
    const world = await createWorldViaApi(request);

    // 导入带 realm_skills 的角色卡（multipart，同 POST /api/library/import）。
    const importResponse = await request.post("/api/library/import", {
      multipart: {
        worldId: world.id,
        file: {
          name: "ella.png",
          mimeType: "image/png",
          buffer: buildCardPng({
            spec: "chara_card_v2",
            data: {
              name: "艾拉",
              description: "旅队里的年轻制图师，随身带着测绘工具。",
              personality: "谨慎的制图师，习惯用「制图术」观察和记录地形。",
              extensions: {
                realm_skills: [
                  {
                    skillKey: "cartography",
                    title: "制图术",
                    description: "描绘并判读地形。",
                    check: { system: "2d6", modifier: 1, target: 8 },
                  },
                ],
              },
            },
          }),
        },
      },
    });
    expect(importResponse.ok()).toBeTruthy();
    const report = (await importResponse.json()) as {
      character?: { name: string };
    };
    expect(report.character?.name).toBe("艾拉");

    // 新建故事 + 记录：装配路径把艾拉入阵容并授权（卡技能 + 基础技能/资产）。
    const story = await createStoryViaApi(request, world.id);
    const record = await createRecordInStory(request, story.id);

    await openDemoRecord(page);
    await openLibrary(page);
    const importedCharacter = page.locator(".library-world", { hasText: world.name })
      .locator(".library-character", { hasText: "艾拉" });
    await expect(importedCharacter).toBeVisible();
    await expect(importedCharacter.locator(".char-source.is-tavern")).toContainText("酒馆导入");
    await page.getByRole("button", { name: "关闭世界库" }).click();
    await openRecordViaLibrary(page, record.title);

    // 请她动手测绘（DM 在普通回合激活她才有行动预算；点名未被激活时走
    // 插话——插话固定计划预算为 0，不含行动事务）。真实模型偶发失败
    // （422 TURN_FAILED，已知缺陷 #12）或未用技能都不算 UI bug：换新措辞
    // 重试，最多 4 轮。
    const diceCard = page.locator(".event-card.is-committed", { hasText: "艾拉" })
      .filter({ has: page.locator(".event-dice") })
      .first();
    const asks = [
      "艾拉，请施展你的「制图术」，测绘这片山谷的地形并判读走向。",
      "艾拉，山谷的地形图就拜托你了——请用「制图术」描绘并判读这片山谷。",
      "艾拉，请仔细观察山谷：用「制图术」把地形轮廓测绘出来。",
      "艾拉，请判读这片山谷的地形与溪流走向——你的「制图术」是正解。",
    ];
    let diceVisible = false;
    for (let round = 0; round < asks.length && !diceVisible; round += 1) {
      const input = page.locator("#realm-message");
      await input.fill(asks[round]!);
      let status = 0;
      for (let attempt = 0; attempt < 2 && status !== 201; attempt += 1) {
        const responsePromise = page.waitForResponse(
          (res) =>
            res.url().includes("/api/record/messages")
            && res.request().method() === "POST",
          { timeout: TURN_TIMEOUT },
        );
        await page.getByRole("button", { name: "送出" }).click();
        status = (await responsePromise).status();
      }
      if (status !== 201) continue; // 回合失败（模型侧）→ 直接下一轮
      try {
        await expect(diceCard).toBeVisible({ timeout: 90_000 });
        diceVisible = true;
      } catch {
        // 本轮艾拉未动用技能（纯台词回应）——下一轮再请她一次。
      }
    }
    expect(diceVisible, "艾拉应在回合内使用技能并投影骰点").toBe(true);

    // 骰点行形态：本卡唯一带检定的技能「制图术」是 2d6；基础 keen_insight
    // 是 d20。要求 2d6 才能证明导入技能被授权并真正进入参局，而不是仅有
    // 导入角色的普通台词或基础技能骰点。
    const dice = diceCard.locator(".event-dice");
    await expect(dice).toHaveAttribute("data-dice-system", "2d6");
    await expect(dice).toHaveAttribute("data-dice-outcome", /success|failure/);
    await expect(dice).toContainText("2d6");
  });
});
