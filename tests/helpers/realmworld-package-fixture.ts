/**
 * PG/路由测试夹具：构建并安装一个签名可信的 RealmWorld fixture 版本
 *（content 随版本变化使 contentHash 不同）。仅面向 disposable 测试环境：
 * 包内容由测试常量组成，签名用一次性 ed25519 测试密钥。
 */
import { sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifest,
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../../modules/world-transfer/realmworld-manifest.ts";
import {
  computeRealmWorldContentHash,
  installRealmWorldDirectory,
} from "../../modules/world-transfer/realmworld-loader.ts";

export interface RealmWorldFixtureKeyPair {
  privateKey: KeyObject;
  publicKeyPem: string;
}

/** 安装一个签名可信的指定版本 fixture（content 随版本变化使 hash 不同）。 */
export async function installSignedRealmWorldFixture(input: {
  installRoot: string;
  worldId: string;
  version: string;
  recordTitle: string;
  keyId: string;
  keyPair: RealmWorldFixtureKeyPair;
  /** manifest engineCompat.baseRange（缺省兼容引擎当前 base 版本段）。 */
  baseRange?: string;
  /** 传给 installRealmWorldDirectory 的 engineBaseVersion（缺省引擎当前版本）。 */
  engineBaseVersion?: string;
}): Promise<void> {
  const sourceDir = await mkdtemp(join(tmpdir(), "realm-vsrc-"));
  const files = new Map<string, Uint8Array>([
    ["content/index.json", Buffer.from(JSON.stringify({
      format: "realmworld-content",
      schemaVersion: 1,
      modules: ["content/world.json", "content/runtime.json", "content/goals.json"],
    }))],
    ["content/world.json", Buffer.from(JSON.stringify({
      worldId: input.worldId,
      title: { en: `Version Harbor ${input.version}` },
      settings: { era: "V", language: "en", weather: "calm", tension: "none" },
    }))],
    ["content/runtime.json", Buffer.from(JSON.stringify({
      format: "realmworld-runtime",
      schemaVersion: 1,
      story: { title: { en: "T" }, premise: { en: "P" } },
      record: { title: { en: input.recordTitle } },
      scene: {
        title: { en: "S" },
        location: { en: "L" },
        objective: { en: "O" },
        tension: { en: "T" },
        weather: { en: "W" },
        displayTime: { en: "D" },
      },
      playerRole: { en: "Keeper" },
      playerStance: "player",
      characters: [],
    }))],
    ["content/goals.json", Buffer.from(JSON.stringify({
      format: "realmworld-goals",
      schemaVersion: 1,
      goals: [],
    }))],
  ]);
  const unsigned: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId: input.worldId,
    worldVersion: input.version,
    engineCompat: {
      schemaLatest: "0057_realmworld_record_binding.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange: input.baseRange ?? ">=1.0.0 <2.0.0",
    },
    contentHash: computeRealmWorldContentHash(files),
    signature: { algorithm: "ed25519", keyId: input.keyId, value: "placeholder" },
  };
  const signature = sign(
    null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(unsigned), "utf8"),
    input.keyPair.privateKey,
  ).toString("base64url");
  const manifest: RealmWorldManifestV1 = {
    ...unsigned,
    signature: { ...unsigned.signature, value: signature },
  };
  for (const [relativePath, bytes] of files) {
    const path = join(sourceDir, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, bytes);
  }
  await writeFile(join(sourceDir, "realmworld-manifest.json"), serializeRealmWorldManifest(manifest));
  await installRealmWorldDirectory({
    sourceDir,
    installRoot: input.installRoot,
    engineBaseVersion: input.engineBaseVersion,
    verifySignature: ({ manifest: candidate }: { manifest: RealmWorldManifestV1 }) =>
      candidate.signature.value === signature,
  });
  await rm(sourceDir, { recursive: true, force: true });
}
