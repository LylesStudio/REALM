/**
 * 场景建立图生产接线测试（scratch PG）：真实 application 路径——
 * createPostgresRecordRuntimeScopeRepository（与回合管线同一 scope 来源）
 * → scene-image-service → composer → manifest patcher。
 * 不接受只调 helper 的假接线；不连共享库。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import {
  createPostgresRecordRuntimeScopeRepository,
  seedPostgresDemo,
} from "../database/postgres/public.ts";
import { createSceneImageService } from "../modules/application/scene-image-service.ts";
import { LocalRecordServiceError } from "../modules/application/local-record-service.ts";
import {
  IMAGE_VISUAL_PROFILES,
  loadSceneWorkflowManifest,
  readPatchedValue,
  SCENE_IMAGE_NEGATIVE_PROMPT,
} from "../modules/imagine/public.ts";

const adminConnectionString = process.env.DATABASE_URL;

const WS = "ws_demo";
const PRINCIPAL = "principal_demo_player";
const RECORD = "record_first_watch";

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

test(
  "scene image: production path composes prompt from real record scope and patches graph",
  { skip: !adminConnectionString, timeout: 300_000 },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_sceneimg_${randomUUID().replaceAll("-", "")}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    t.after(async () => {
      await ownerPool.end();
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });
    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }
    await seedPostgresDemo(ownerPool);

    const scopeRepository = createPostgresRecordRuntimeScopeRepository(ownerPool);
    const scope = { workspaceId: WS, principalId: PRINCIPAL, recordId: RECORD };

    // 生产 scope 真实解析（断言用对照，不喂给 composer——service 自己解析）。
    const resolved = await scopeRepository.resolve(scope);
    assert.ok(resolved, "demo record scope 必须可解析");

    const service = createSceneImageService({ scopeRepository });
    const prepared = await service.prepareSceneImageWorkflow(scope);

    // 真实数据进入 prompt（取自生产 scope，不断言 demo 文案本身）。
    assert.ok(resolved!.brief.worldName.length > 0);
    assert.ok(prepared.positivePrompt.includes(resolved!.brief.worldName));
    assert.ok(prepared.positivePrompt.includes(resolved!.brief.location));
    assert.ok(!prepared.positivePrompt.includes(resolved!.brief.storyTitle));
    assert.ok(prepared.includedBlocks.includes("world"));
    assert.ok(prepared.includedBlocks.includes("scene"));
    // 无 demo 示例句残留、无 graph 占位示例场景。
    assert.ok(!prepared.positivePrompt.includes("quiet coastal village"));
    // negative = 固定约束前缀 + 视觉 profile 漂移负面（demo 世界风格映射）。
    const expectedProfile = IMAGE_VISUAL_PROFILES[resolved!.style];
    assert.ok(prepared.negativePrompt.startsWith(SCENE_IMAGE_NEGATIVE_PROMPT));
    assert.ok(prepared.negativePrompt.includes(expectedProfile.negativeAdditions));
    assert.ok(
      prepared.positivePrompt.includes(expectedProfile.visualPrompt),
      "视觉 profile 必须随生产 scope.style 进入 prompt",
    );
    assert.equal(prepared.dispatched, false, "本批不 dispatch");

    // patched graph 经 manifest 反查与语义输出一致。
    const manifest = loadSceneWorkflowManifest();
    assert.equal(
      readPatchedValue(manifest, "t2i", prepared.patchedGraph, "positivePrompt"),
      prepared.positivePrompt,
    );
    assert.equal(
      readPatchedValue(manifest, "t2i", prepared.patchedGraph, "negativePrompt"),
      prepared.negativePrompt,
    );
    assert.equal(prepared.width, 896);
    assert.equal(prepared.height, 1152);
    assert.equal(typeof prepared.seed, "number");
    assert.equal(prepared.workflowId, "anima-scene-t2i-v0");
    assert.equal(prepared.runtime, "local");

    // seed 覆盖生效。
    const reseeded = await service.prepareSceneImageWorkflow(scope, { seed: 777001 });
    assert.equal(reseeded.seed, 777001);

    // 未知 record fail-closed（NOT_FOUND，不伪造 prompt）。
    await assert.rejects(
      service.prepareSceneImageWorkflow({ ...scope, recordId: "record_missing" }),
      (error: unknown) => {
        assert.ok(error instanceof LocalRecordServiceError);
        assert.equal(error.code, "NOT_FOUND");
        return true;
      },
    );
  },
);
