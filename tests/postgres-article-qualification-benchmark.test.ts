/**
 * X0 基线基准（plan v37 §I 轨道 X / §K.1）：qualification 写入锁并行化
 * 前 baseline 数字。三负载：
 *   ① 32 并发 × 8 article 混合（跨 article）；
 *   ② 32 并发 × 同 article；
 *   ③ ① 形态 + 并发真实回合提交（executeTurn，两条 Record 链）。
 * 指标：ops/s、p50/p95/p99、锁错误计数（40P01 死锁 / 40001 序列化 / 55P03 锁超时，
 * 全部必须为 0）。结果以 AQ_BENCHMARK JSON 行输出，before 数字记入 commit message。
 * 隔离库 finally DROP；不可复现即停（plan 停止条件）。
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import test from "node:test";
import pg from "pg";
import {
  executeTurn,
  type JsonValue,
  type RuntimeCommand,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";
import { createPostgresRuntimeRepository } from "../database/postgres/public.ts";
import {
  createArticleQualificationRepository,
} from "../database/postgres/article-qualification-repository.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

const WORKERS = 32;
const ARTICLES = 8;
const MIXED_OPS = 256;
const SAME_ARTICLE_OPS = 256;
const COMBINED_QUALIFY_OPS = 128;
const TURNS_PER_RECORD = 2;

interface LoadMetrics {
  load: string;
  ops: number;
  wallMs: number;
  opsPerSec: number;
  p50ms: number;
  p95ms: number;
  p99ms: number;
  errors: Record<string, number>;
}

function requireLoopbackUrl(value: string): URL {
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PostgreSQL tests are restricted to a loopback host.");
  }
  return url;
}

function summarize(load: string, latencies: number[], errors: string[], wallMs: number): LoadMetrics {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pick = (q: number) => sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const errorHistogram: Record<string, number> = {};
  for (const code of errors) {
    errorHistogram[code] = (errorHistogram[code] ?? 0) + 1;
  }
  return {
    load,
    ops: latencies.length,
    wallMs: Math.round(wallMs * 100) / 100,
    opsPerSec: wallMs > 0 ? Math.round((latencies.length / wallMs) * 100_000) / 100 : 0,
    p50ms: Math.round(pick(0.5) * 100) / 100,
    p95ms: Math.round(pick(0.95) * 100) / 100,
    p99ms: Math.round(pick(0.99) * 100) / 100,
    errors: errorHistogram,
  };
}

async function runWithConcurrency(
  total: number,
  worker: (index: number) => Promise<void>,
): Promise<{ latencies: number[]; errors: string[]; wallMs: number }> {
  const latencies: number[] = new Array(total);
  const errors: string[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      const opStart = performance.now();
      try {
        await worker(index);
        latencies[index] = performance.now() - opStart;
      } catch (error) {
        const code = typeof error === "object" && error !== null
          ? (error as { code?: string }).code ?? "UNKNOWN"
          : "UNKNOWN";
        errors.push(code);
      }
    }
  }));
  return { latencies, errors, wallMs: performance.now() - started };
}

test(
  "X0 qualification write-lock baseline benchmark (three loads)",
  { skip: !adminConnectionString || !runtimeConnectionString },
  async (t) => {
    const adminUrl = requireLoopbackUrl(adminConnectionString!);
    const databaseName = `realm_aq_bench_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const maintenanceUrl = new URL(adminUrl);
    maintenanceUrl.pathname = "/postgres";
    const maintenance = new pg.Client({ connectionString: maintenanceUrl.href });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    const ownerUrl = new URL(adminUrl);
    ownerUrl.pathname = `/${databaseName}`;
    const ownerPool = new pg.Pool({ connectionString: ownerUrl.href, max: 2 });
    const runtimeUrl = new URL(requireLoopbackUrl(runtimeConnectionString!).href);
    runtimeUrl.pathname = `/${databaseName}`;
    const runtimePool = new pg.Pool({ connectionString: runtimeUrl.href, max: WORKERS });
    // pg.Pool 对被杀掉的空闲连接会抛 'error' 事件；无 listener 会变成
    // uncaughtException 掩盖真实测试错误。这里显式吞掉（清理路径专用）。
    runtimePool.on("error", () => undefined);
    ownerPool.on("error", () => undefined);
    t.after(async () => {
      await runtimePool.end().catch(() => undefined);
      await ownerPool.end().catch(() => undefined);
      await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      await maintenance.end();
    });

    const migrationDir = new URL("../database/postgres/migrations/", import.meta.url);
    for (const filename of (await readdir(migrationDir)).sort()) {
      if (!filename.endsWith(".sql")) continue;
      await ownerPool.query(await readFile(new URL(filename, migrationDir), "utf8"));
    }

    const workspaceId = `ws_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const worldId = `world_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const worldlineId = `worldline_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const scope = { workspaceId, worldId, worldlineId };
    const articleIds = Array.from(
      { length: ARTICLES },
      (_, i) => `article_${i}_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
    );
    const records = [
      {
        story: `story_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        record: `record_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        scene: `scene_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        definition: `definition_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        continuity: `continuity_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        instance: `instance_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        visibility: `visibility_a_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      },
      {
        story: `story_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        record: `record_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        scene: `scene_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        definition: `definition_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        continuity: `continuity_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        instance: `instance_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        visibility: `visibility_b_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      },
    ];

    await ownerPool.query("SELECT set_config('realm.workspace_id', $1, false)", [workspaceId]);
    await ownerPool.query("INSERT INTO workspaces (id, name) VALUES ($1, 'AQ Bench')", [workspaceId]);
    await ownerPool.query(
      "INSERT INTO worlds (workspace_id, id, name, calendar_id) VALUES ($1, $2, 'Bench World', 'bench-calendar')",
      [workspaceId, worldId],
    );
    await ownerPool.query(
      "INSERT INTO worldlines (workspace_id, world_id, id, label, head_tick, head_ordinal) VALUES ($1, $2, $3, 'Origin', 100, 0)",
      [workspaceId, worldId, worldlineId],
    );
    for (const [index, articleId] of articleIds.entries()) {
      await ownerPool.query(
        "INSERT INTO world_articles (workspace_id, world_id, worldline_id, id, title, body) VALUES ($1, $2, $3, $4, $5, $6)",
        [workspaceId, worldId, worldlineId, articleId, `Article ${index}`, `Body ${index}`],
      );
    }
    for (const ids of records) {
      await ownerPool.query(
        "INSERT INTO stories (workspace_id, world_id, worldline_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, 'Story', 'active', 0, 0)",
        [workspaceId, worldId, worldlineId, ids.story],
      );
      await ownerPool.query(
        "INSERT INTO records (workspace_id, world_id, worldline_id, story_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Record', 'active', 0, 0)",
        [workspaceId, worldId, worldlineId, ids.story, ids.record],
      );
      await ownerPool.query(
        "INSERT INTO scenes (workspace_id, world_id, worldline_id, record_id, id, title, status, start_tick, start_ordinal) VALUES ($1, $2, $3, $4, $5, 'Scene', 'active', 0, 0)",
        [workspaceId, worldId, worldlineId, ids.record, ids.scene],
      );
      await ownerPool.query(
        "INSERT INTO character_definitions (workspace_id, world_id, id, display_name) VALUES ($1, $2, $3, 'Witness')",
        [workspaceId, worldId, ids.definition],
      );
      await ownerPool.query(
        "INSERT INTO character_continuities (workspace_id, world_id, worldline_id, definition_id, id, continuity_key, born_tick, born_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 0, 0)",
        [workspaceId, worldId, worldlineId, ids.definition, ids.continuity, `${ids.continuity}-key`],
      );
      await ownerPool.query(
        "INSERT INTO character_instances (workspace_id, world_id, worldline_id, record_id, continuity_id, id, controller_mode, instantiated_tick, instantiated_ordinal, inheritance_cutoff_tick, inheritance_cutoff_ordinal) VALUES ($1, $2, $3, $4, $5, $6, 'ai', 0, 0, 0, 0)",
        [workspaceId, worldId, worldlineId, ids.record, ids.continuity, ids.instance],
      );
      await ownerPool.query(
        "INSERT INTO visibility_policies (workspace_id, world_id, worldline_id, record_id, id, policy_key, policy_kind) VALUES ($1, $2, $3, $4, $5, 'public', 'public')",
        [workspaceId, worldId, worldlineId, ids.record, ids.visibility],
      );
      await ownerPool.query(
        "INSERT INTO record_heads (workspace_id, world_id, worldline_id, record_id, record_version, next_record_ordinal) VALUES ($1, $2, $3, $4, 0, 1)",
        [workspaceId, worldId, worldlineId, ids.record],
      );
    }

    const qualification = createArticleQualificationRepository(runtimePool);
    const decisions = ["attest", "revoke"] as const;
    const qualifyOp = async (index: number, articleCount: number) => {
      const articleId = articleIds[index % articleCount]!;
      const decision = decisions[Math.floor(index / articleCount) % 2]!;
      const outcome = await qualification.qualify(scope, {
        articleId,
        decision,
        attestedBy: "principal_bench_owner",
      });
      if (!outcome.ok) {
        throw new Error(`qualify rejected: ${outcome.code}`);
      }
    };

    // 负载①：32 并发 × 8 article 混合。
    const load1 = await runWithConcurrency(MIXED_OPS, (i) => qualifyOp(i, ARTICLES));
    const metrics1 = summarize("mixed-8-articles", load1.latencies, load1.errors, load1.wallMs);
    console.log(`AQ_BENCHMARK ${JSON.stringify(metrics1)}`);

    // 负载②：32 并发 × 同 article。
    const load2 = await runWithConcurrency(SAME_ARTICLE_OPS, (i) => qualifyOp(i, 1));
    const metrics2 = summarize("same-article", load2.latencies, load2.errors, load2.wallMs);
    console.log(`AQ_BENCHMARK ${JSON.stringify(metrics2)}`);

    // 负载③：① 形态 + 并发真实回合提交（两条 Record 链各 TURNS_PER_RECORD 个回合）。
    const turnErrors: string[] = [];
    const runTurnChain = async (ids: (typeof records)[number]) => {
      let sequence = 0;
      const repository = createPostgresRuntimeRepository<
        readonly JsonValue[],
        { objective: string },
        { text: string },
        { accepted: boolean },
        { content: string },
        { eventId: string }
      >({
        pool: runtimePool,
        workspaceId,
        mapFormalEvent({ draft, worldCursor }: {
          draft: { eventId: string; payload: { content: string } };
          worldCursor: { tick: number; ordinal: number };
        }) {
          return {
            sceneId: ids.scene,
            visibilityPolicyId: ids.visibility,
            eventKind: "utterance.committed",
            speakerName: "塞娜",
            content: draft.payload.content,
            observations: [
              {
                observationId: `${draft.eventId}-observation`,
                observerCharacterInstanceId: ids.instance,
                dedupeKey: `${draft.eventId}:direct`,
                kind: "direct",
                content: draft.payload.content,
                availableFrom: worldCursor,
              },
            ],
          };
        },
      });
      const dependencies: TurnRuntimeDependencies<
        readonly JsonValue[],
        { objective: string },
        { text: string },
        { accepted: boolean },
        { content: string },
        { eventId: string }
      > = {
        repository,
        planner: { async plan() { return { objective: "respond" }; } },
        drafter: { async draft() { return { text: "基准回合。" }; } },
        validator: { async validate() { return { accepted: true }; } },
        releaseBuilder: {
          async build(context: { turnId: string; candidate: { body: { text: string } } }) {
            const eventId = `${context.turnId}-event`;
            return {
              formalEvents: [
                { eventId, kind: "utterance.committed", payload: { content: context.candidate.body.text } },
              ],
              outbox: [
                {
                  messageId: `${context.turnId}-outbox`,
                  dedupeKey: `${context.turnId}:projection`,
                  topic: "record.event.committed",
                  payload: { eventId },
                },
              ],
            };
          },
        },
        idFactory: () => `bench-runtime-${ids.record}-${++sequence}`,
        clock: () => new Date().toISOString(),
      };
      for (let turnIndex = 0; turnIndex < TURNS_PER_RECORD; turnIndex += 1) {
        const head = await repository.loadRecordHead(ids.record);
        const command: RuntimeCommand<readonly JsonValue[]> = {
          commandType: "player.utterance",
          recordId: ids.record,
          expectedRecordVersion: head?.version ?? 0,
          idempotencyKey: `bench-${ids.record}-${turnIndex}`,
          actorId: null,
          payload: [`benchmark turn ${turnIndex}`],
        };
        try {
          const completed = await executeTurn(command, dependencies);
          assert.equal(completed.state, "completed");
        } catch (error) {
          const code = typeof error === "object" && error !== null
            ? (error as { code?: string }).code ?? "UNKNOWN"
            : "UNKNOWN";
          turnErrors.push(code);
        }
      }
    };

    const combinedStart = performance.now();
    const [load3] = await Promise.all([
      runWithConcurrency(COMBINED_QUALIFY_OPS, (i) => qualifyOp(i, ARTICLES)),
      Promise.all(records.map((ids) => runTurnChain(ids))),
    ]);
    const combinedWallMs = performance.now() - combinedStart;
    const metrics3 = summarize("mixed-plus-turn-commits", load3.latencies, load3.errors, combinedWallMs);
    console.log(`AQ_BENCHMARK ${JSON.stringify({ ...metrics3, turnErrors })}`);

    for (const metrics of [metrics1, metrics2, metrics3]) {
      assert.equal(metrics.errors["40P01"] ?? 0, 0, `${metrics.load}: deadlocks must be zero`);
      assert.equal(metrics.errors["40001"] ?? 0, 0, `${metrics.load}: serialization failures must be zero`);
      assert.equal(metrics.errors["55P03"] ?? 0, 0, `${metrics.load}: lock timeouts must be zero`);
      assert.ok(metrics.ops > 0, `${metrics.load}: at least one op must succeed`);
    }
    assert.equal(turnErrors.length, 0, "turn commits must not fail");
  },
);
