import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPngCardText,
  parseTavernImport,
  sniffImageContentType,
  TavernImportError,
} from "../modules/import/tavern-parser.ts";

/** 内存构造合成 PNG：签名 + IHDR + tEXt(keyword, text) + IEND。 */
function buildPng(chunks: { keyword: string; text: string }[]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts: Buffer[] = [signature];
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  parts.push(chunk("IHDR", ihdr));
  for (const { keyword, text } of chunks) {
    parts.push(chunk("tEXt", Buffer.concat([
      Buffer.from(keyword, "latin1"),
      Buffer.from([0]),
      Buffer.from(text, "latin1"),
    ])));
  }
  parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(1, 0); // CRC 内容对解析器不重要
  return Buffer.concat([head, data, crc]);
}

const V2_CARD = {
  spec: "chara_card_v2",
  data: {
    name: "艾拉",
    description: "旅队里的年轻制图师。",
    personality: "谨慎",
    scenario: "群山商路",
    first_mes: "地图要带吗？",
    character_book: {
      entries: [
        { name: "商路", content: "群山商路每逢月圆封山。", keys: ["商路"], enabled: true },
        { name: "旧约", content: "旧约条目内容。", keys: ["旧约"], enabled: false },
      ],
    },
  },
};

test("PNG chunk parser reads tEXt chara and falls back to ccv3", () => {
  const base64 = Buffer.from(JSON.stringify(V2_CARD), "utf8").toString("base64");
  const png = buildPng([{ keyword: "chara", text: base64 }]);
  const extracted = extractPngCardText(png);
  assert.equal(extracted?.keyword, "chara");
  const parsed = parseTavernImport(png);
  assert.equal(parsed.kind, "character");
  if (parsed.kind === "character") {
    assert.equal(parsed.card.name, "艾拉");
    assert.equal(parsed.card.spec, "chara_card_v2");
    assert.ok(parsed.png);
    assert.equal(parsed.book?.length, 2);
    assert.equal(parsed.book?.[1]?.enabled, false);
  }

  // ccv3 回退
  const pngV3 = buildPng([{ keyword: "ccv3", text: base64 }]);
  const v3 = parseTavernImport(pngV3);
  assert.equal(v3.kind, "character");
  if (v3.kind === "character") assert.equal(v3.card.spec, "chara_card_v3");

  // 无卡 PNG
  const bare = buildPng([]);
  assert.equal(extractPngCardText(bare), null);
  assert.throws(() => parseTavernImport(bare), (error: unknown) =>
    error instanceof TavernImportError
    && error.code === "TAVERN_IMPORT_PNG_NO_CARD");
});

test("JSON V2 / V1 / worldbook parsing", () => {
  const v2 = parseTavernImport(Buffer.from(JSON.stringify(V2_CARD), "utf8"));
  assert.equal(v2.kind, "character");
  if (v2.kind === "character") {
    assert.equal(v2.png, null);
    assert.equal(v2.card.creatorNotes, "");
  }

  const v1 = parseTavernImport(Buffer.from(JSON.stringify({
    name: "老守门人",
    description: "守着废弃的北门。",
    personality: "沉默",
  }), "utf8"));
  assert.equal(v1.kind, "character");
  if (v1.kind === "character") assert.equal(v1.card.spec, "tavern-v1");

  // 独立世界书：entries 为索引对象
  const book = parseTavernImport(Buffer.from(JSON.stringify({
    entries: {
      "0": { content: "月升时海雾封港。", keys: ["海雾"], enabled: true },
      "1": { content: "被禁用的条目。", keys: [], enabled: false },
    },
  }), "utf8"));
  assert.equal(book.kind, "worldbook");
  if (book.kind === "worldbook") {
    assert.equal(book.book.length, 2);
    assert.equal(book.book[0]?.name, "海雾");
    assert.equal(book.book[1]?.enabled, false);
  }
});

test("extensions.realm_skills passthrough (T6 card-carried skills)", () => {
  const parsed = parseTavernImport(Buffer.from(JSON.stringify({
    spec: "chara_card_v2",
    data: {
      name: "艾拉",
      description: "旅队里的年轻制图师。",
      extensions: {
        realm_skills: [
          {
            skillKey: "cartography",
            title: "制图术",
            description: "描绘并判读地形。",
            check: { system: "2d6", modifier: 1, target: 8 },
          },
          { skillKey: "herbalism", title: "草药辨识", description: "辨认常见草药。" },
          "garbage-entry",
        ],
      },
    },
  }), "utf8"));
  assert.equal(parsed.kind, "character");
  if (parsed.kind !== "character") return;
  // 对象条目透传（check 原样）；非对象条目（形状噪声）跳过。
  assert.equal(parsed.card.realmSkills.length, 2);
  assert.equal(parsed.card.realmSkills[0]!.skillKey, "cartography");
  assert.deepEqual(parsed.card.realmSkills[0]!.check, {
    system: "2d6",
    modifier: 1,
    target: 8,
  });
  assert.equal(parsed.card.realmSkills[1]!.check, undefined);

  // 无 extensions / realm_skills 非数组 → 空集（缺省）。
  const noExt = parseTavernImport(Buffer.from(JSON.stringify({
    spec: "chara_card_v2",
    data: { name: "甲", description: "乙。", extensions: { realm_skills: {} } },
  }), "utf8"));
  if (noExt.kind !== "character") throw new Error("unreachable");
  assert.deepEqual(noExt.card.realmSkills, []);
});

test("fail-closed branches: bad base64, non-png image, unknown format, too large", () => {
  // 坏 base64
  const badPng = buildPng([{ keyword: "chara", text: "!!!不是base64!!!" }]);
  assert.throws(() => parseTavernImport(badPng), (error: unknown) =>
    error instanceof TavernImportError
    && ["TAVERN_IMPORT_BAD_BASE64", "TAVERN_IMPORT_BAD_JSON"].includes(error.code));

  // 非 PNG 图片（JPEG magic）
  assert.equal(
    sniffImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])),
    "image/jpeg",
  );
  assert.throws(
    () => parseTavernImport(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10])),
    (error: unknown) =>
      error instanceof TavernImportError
      && error.code === "TAVERN_IMPORT_BAD_BYTES",
  );

  // 未知 JSON 结构
  assert.throws(
    () => parseTavernImport(Buffer.from(JSON.stringify({ hello: 1 }))),
    (error: unknown) =>
      error instanceof TavernImportError
      && error.code === "TAVERN_IMPORT_UNKNOWN_FORMAT",
  );

  // 超上限
  assert.throws(
    () => parseTavernImport(Buffer.alloc(10 * 1024 * 1024 + 1)),
    (error: unknown) =>
      error instanceof TavernImportError
      && error.code === "TAVERN_IMPORT_TOO_LARGE",
  );
});
