/**
 * Goal semantic Judge — real provider e2e（opt-in，默认跳过）。
 *
 * 这是 Slice 4 的真实 provider 验收：当且仅当宿主环境提供
 * REALM_TEST_PROVIDER_API_KEY 时运行；CI（无 key）一律跳过。
 *
 * 运行方式（一次性 scratch PG17 集群自举，绝不触碰共享 realm_dev）：
 *   REALM_TEST_PROVIDER_API_KEY=... \
 *   [REALM_TEST_PROVIDER_ID=openrouter] \
 *   [REALM_TEST_PROVIDER_BASE_URL=https://openrouter.ai/api/v1] \
 *   [REALM_TEST_PROVIDER_MODEL=openai/gpt-4o-mini] \
 *   node --experimental-strip-types --test tests/goal-semantic-judge-real-provider.test.ts
 *
 * 流程：docker scratch cluster → 完整迁移链 → seed demo → 入队一个
 * semantic Goal 评估作业 → 生产 Judge 适配器（createModelGoalJudge）经
 * 真实 ModelGateway 调真实 provider → worker settle → 断言 verdict
 * 被接受或拒绝、immutable assessment ledger 行落账。
 *
 * 保密契约：
 * - 永不打印 API key、provider URL 或原始模型响应；所有诊断输出经
 *   redact()，任何凭证形态的值一律显示为 [REDACTED]；
 * - provider/传输错误只以有界机器码（GOAL_JUDGE_FAILED 等）进入断言，
 *   原始错误消息不进测试报告；
 * - 选定模型必须支持 OpenAI-compatible json_object 响应格式。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import test from "node:test";
import {
  dockerAvailable,
  startScratchPgCluster,
} from "./helpers/v37-test-cluster.mjs";
import {
  createPostgresGoalAssessmentJobQueue,
  type GoalAssessmentEnqueueInput,
} from "../database/postgres/goal-assessment-job-queue.ts";
import { POSTGRES_DEMO_IDS } from "../database/postgres/public.ts";
import { runGoalAssessmentWorkerCycle } from "../modules/goals/assessment-worker-runtime.ts";
import { createModelGoalJudge } from "../modules/goals/model-judge.ts";
import type { GoalDefinition } from "../modules/goals/public.ts";
import {
  createModelGateway,
  MODEL_PROVIDER_CATALOG,
  type ModelProviderId,
  type ModelProviderSettings,
} from "../modules/inference/public.ts";

const REDACTED = "[REDACTED]";
const API_KEY = process.env.REALM_TEST_PROVIDER_API_KEY ?? "";
const PROVIDER_ID_RAW = process.env.REALM_TEST_PROVIDER_ID ?? "openrouter";
const BASE_URL = process.env.REALM_TEST_PROVIDER_BASE_URL
  ?? "https://openrouter.ai/api/v1";
const MODEL = process.env.REALM_TEST_PROVIDER_MODEL ?? "openai/gpt-4o-mini";

const skipReason = "requires REALM_TEST_PROVIDER_API_KEY (real provider opt-in)";

/**
 * 诊断脱敏：API key、provider URL 与一切凭证形态的值一律替换为
 * [REDACTED]。测试输出的每一行都必须经过此函数。
 */
function redact(value: string): string {
  let out = value;
  for (const secret of [API_KEY, BASE_URL]) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out
    .replace(/bearer\s+[^\s"']+/gi, `Bearer ${REDACTED}`)
    .replace(/(api[_-]?key|token|secret|password)(["'\s:=]+)[^\s,"']+/gi, `$1$2${REDACTED}`)
    .replace(/https?:\/\/[^\s"')]+/gi, REDACTED);
}

function providerId(): ModelProviderId {
  const known = MODEL_PROVIDER_CATALOG.some((entry) => entry.id === PROVIDER_ID_RAW);
  assert.ok(known, "REALM_TEST_PROVIDER_ID must be a registered catalog provider id");
  return PROVIDER_ID_RAW as ModelProviderId;
}

function gatewaySettings(): ModelProviderSettings {
  const endpoint = new URL(BASE_URL);
  assert.ok(
    endpoint.protocol === "https:" || endpoint.protocol === "http:",
    "REALM_TEST_PROVIDER_BASE_URL must be an http(s) URL",
  );
  assert.equal(endpoint.username, "", "provider URL must not embed credentials");
  assert.equal(endpoint.password, "", "provider URL must not embed credentials");
  return {
    schemaVersion: 1,
    providerId: providerId(),
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    selectedModel: MODEL,
    thinking: "disabled",
    timeoutMs: 30_000,
    maxTokens: 800,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: new Date().toISOString(),
  };
}

const repoRoot = new URL("..", import.meta.url).pathname;

/** 运行仓库脚本；输出永不直接外抛——失败时仅抛脱敏后的尾部。 */
async function runRepoScript(args: readonly string[], env: Record<string, string>): Promise<void> {
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("exit", (exitCode) => resolve(exitCode ?? 1));
    child.once("error", reject);
  });
  if (code !== 0) {
    throw new Error(`setup script failed: ${redact(output.slice(-500))}`);
  }
}

test("redaction masks credential-like values in diagnostics", () => {
  const sample = `key=${API_KEY || "sk-live-123"} url=${BASE_URL} Authorization: Bearer abc.def.ghi token: xyz`;
  const masked = redact(sample);
  if (API_KEY) assert.ok(!masked.includes(API_KEY));
  assert.ok(!masked.includes(BASE_URL));
  assert.ok(!masked.includes("abc.def.ghi"));
  assert.ok(!masked.includes("xyz"));
  assert.ok(masked.includes(REDACTED));
  assert.equal(redact("plain status line"), "plain status line");
});

test(
  "real provider: semantic Goal settles from enqueue to ledger with a judged verdict",
  { skip: API_KEY === "" ? skipReason : false, timeout: 600_000 },
  async (t) => {
    assert.ok(
      await dockerAvailable(),
      "docker is required for the disposable scratch PostgreSQL cluster",
    );
    const cluster = await startScratchPgCluster({
      label: "goal-judge-real-provider",
      roles: ["realm_runtime", "realm_control", "realm_transfer"],
    });
    // 信号兜底：Ctrl+C/SIGTERM 同步销毁集群，零残留。
    const killClusterSync = () => {
      try {
        spawnSync("docker", ["rm", "-f", cluster.name], { stdio: "ignore" });
      } catch { /* best effort */ }
    };
    process.once("SIGINT", () => { killClusterSync(); process.exit(130); });
    process.once("SIGTERM", () => { killClusterSync(); process.exit(143); });
    // 单一清理钩子：先放池再毁集群（钩子顺序不依赖注册序）。
    let ownerPool: pg.Pool | null = null;
    let runtimePool: pg.Pool | null = null;
    t.after(async () => {
      await runtimePool?.end().catch(() => undefined);
      await ownerPool?.end().catch(() => undefined);
      await cluster.stop();
    });

    const admin = new pg.Client({ connectionString: cluster.adminUrl });
    await admin.connect();
    await admin.query("CREATE DATABASE realm_dev");
    await admin.end();
    const adminDbUrl = cluster.adminUrl.replace(/\/postgres$/, "/realm_dev");
    const runtimeDbUrl = cluster.runtimeUrl.replace(/\/postgres$/, "/realm_dev");
    t.diagnostic(redact("scratch cluster ready; applying full migration chain"));
    await runRepoScript(["scripts/postgres-migrate.mjs"], { DATABASE_URL: adminDbUrl });
    await runRepoScript(
      ["--experimental-strip-types", "scripts/postgres-seed-demo.mjs"],
      { DATABASE_URL: adminDbUrl },
    );

    ownerPool = new pg.Pool({ connectionString: adminDbUrl, max: 2 });
    runtimePool = new pg.Pool({ connectionString: runtimeDbUrl, max: 2 });

    const suffix = randomUUID().replaceAll("-", "");
    const goalKey = `real-provider-watch-${suffix.slice(0, 12)}`;
    const goalInstanceId = goalKey;
    const jobId = `goal_job_real_${suffix}`;
    const leaseOwner = `test-real-provider-worker-${suffix}`;
    const definition: GoalDefinition = {
      goalKey,
      policyVersion: "semantic-real-v1",
      mode: "semantic",
      visible: true,
      rubric: {
        kind: "semantic",
        promptKey:
          "The Goal is complete only when the committed story events show the "
          + "character finishing the first night watch at the north breakwater. "
          + "If the watch is still in progress choose continue; if it can no "
          + "longer be completed choose reject.",
      },
      outcome: { result: "watch resolved" },
    };

    await ownerPool.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, id, goal_key,
         state, revision, progress, outcome, policy_version
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 0, '{}'::jsonb, NULL, 'semantic-real-v1')`,
      [
        POSTGRES_DEMO_IDS.workspace,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        POSTGRES_DEMO_IDS.record,
        goalInstanceId,
        goalKey,
      ],
    );

    // 真实已提交事件与 record head（一次性集群内的 seed demo 数据）。
    const events = await ownerPool.query<{ id: string } & pg.QueryResultRow>(
      `SELECT id FROM events
       WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND record_id = $4
       ORDER BY record_ordinal, id`,
      [
        POSTGRES_DEMO_IDS.workspace,
        POSTGRES_DEMO_IDS.world,
        POSTGRES_DEMO_IDS.worldline,
        POSTGRES_DEMO_IDS.record,
      ],
    );
    assert.ok(events.rowCount !== null && events.rowCount > 0, "seeded record must have events");
    const committedEventIds = new Set(events.rows.map((row) => row.id));
    const sourceEventId = events.rows[events.rows.length - 1]!.id;

    const queue = createPostgresGoalAssessmentJobQueue({
      pool: runtimePool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      leaseOwner,
      leaseDurationMs: 30_000,
    });
    const enqueue: GoalAssessmentEnqueueInput = {
      jobId,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      worldId: POSTGRES_DEMO_IDS.world,
      worldlineId: POSTGRES_DEMO_IDS.worldline,
      recordId: POSTGRES_DEMO_IDS.record,
      goalInstanceId,
      goalKey,
      sourceEventId,
      input: { trigger: "real-provider-e2e" },
      availableAt: new Date().toISOString(),
    };
    assert.equal(await queue.enqueue(enqueue), "inserted");

    // 生产 Judge 适配器 + 真实 provider gateway（与 worker 入口同一工厂）。
    const gateway = createModelGateway(gatewaySettings());
    assert.equal(gateway.providerId, providerId());
    const judge = createModelGoalJudge({ getGateway: async () => gateway });

    t.diagnostic(redact("calling the configured real provider for one judged assessment"));
    const reports = await runGoalAssessmentWorkerCycle({
      slots: [{ workspaceId: POSTGRES_DEMO_IDS.workspace, repository: queue }],
      resolveDefinition: async () => definition,
      judge,
      now: new Date().toISOString(),
    });
    const report = reports.get(POSTGRES_DEMO_IDS.workspace);
    assert.ok(report, "worker cycle must report for the demo workspace");

    if (report.kind === "failed" || report.kind === "retryable") {
      // 有界机器码断言：provider/输出失败绝不泄露原始响应、key 或 URL。
      const code = report.kind === "failed" ? report.code : "retryable";
      assert.match(code, /^GOAL_[A-Z_]+$/, "failure must be a bounded Goal code");
      assert.fail(`real provider assessment did not settle (${code})`);
    }
    assert.equal(report.kind, "settled");
    assert.ok(
      report.status === "accepted" || report.status === "rejected",
      "the judged verdict must be accepted or rejected",
    );
    t.diagnostic(redact(`verdict settled with status ${report.status}`));

    // Immutable assessment ledger 行：恰好一行，judge 来源，证据链回真实
    // 已提交事件，快照哈希/策略版本落账。
    const assessment = await ownerPool.query<{
      id: string;
      assessment_job_id: string | null;
      source_event_id: string;
      source: string;
      status: string;
      result: Record<string, unknown>;
      evidence_event_ids: string[];
      evidence_snapshot_hash: string;
      policy_version: string;
    } & pg.QueryResultRow>(
      `SELECT id, assessment_job_id, source_event_id, source, status, result,
              evidence_event_ids, evidence_snapshot_hash, policy_version
       FROM goal_assessments WHERE workspace_id = $1 AND goal_instance_id = $2`,
      [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
    );
    assert.equal(assessment.rowCount, 1);
    const row = assessment.rows[0]!;
    assert.equal(row.id, `goal-assessment:${jobId}:1`);
    assert.equal(row.assessment_job_id, jobId);
    assert.equal(row.source, "judge");
    assert.equal(row.status, report.status);
    assert.equal(row.source_event_id, sourceEventId);
    assert.equal(row.policy_version, definition.policyVersion);
    assert.match(row.evidence_snapshot_hash, /^[0-9a-f]{64}$/);
    assert.ok(row.evidence_event_ids.length > 0, "verdict must cite evidence events");
    for (const eventId of row.evidence_event_ids) {
      assert.ok(
        committedEventIds.has(eventId),
        "cited evidence must be a real committed event id",
      );
    }
    const decision = (row.result as { decision?: unknown }).decision;
    assert.ok(
      decision === "complete" || decision === "continue" || decision === "reject",
      "ledger result must carry the model verdict class",
    );
    if (report.status === "accepted") {
      assert.equal(decision, "complete");
    }

    // Ledger immutability：append-only 触发器拒绝任何改写。
    await assert.rejects(
      ownerPool.query(
        `UPDATE goal_assessments SET result = '{}'::jsonb
         WHERE workspace_id = $1 AND id = $2`,
        [POSTGRES_DEMO_IDS.workspace, row.id],
      ),
      /immutable evidence/,
    );

    // Job 收束：completed、租约清空、无错误残留。
    const jobRow = await ownerPool.query<{
      state: string;
      lease_owner: string | null;
      lease_expires_at: string | null;
      last_error_code: string | null;
    } & pg.QueryResultRow>(
      `SELECT state, lease_owner, lease_expires_at, last_error_code
       FROM goal_assessment_jobs WHERE workspace_id = $1 AND id = $2`,
      [POSTGRES_DEMO_IDS.workspace, jobId],
    );
    assert.equal(jobRow.rows[0]?.state, "completed");
    assert.equal(jobRow.rows[0]?.lease_owner, null);
    assert.equal(jobRow.rows[0]?.lease_expires_at, null);
    assert.equal(jobRow.rows[0]?.last_error_code, null);

    // accepted ⇒ Goal 实例 completed + 恰好一条 goal.transition.committed。
    if (report.status === "accepted") {
      const instance = await ownerPool.query<{ state: string } & pg.QueryResultRow>(
        `SELECT state FROM goal_instances WHERE workspace_id = $1 AND id = $2`,
        [POSTGRES_DEMO_IDS.workspace, goalInstanceId],
      );
      assert.equal(instance.rows[0]?.state, "completed");
      const transition = await ownerPool.query<pg.QueryResultRow>(
        `SELECT id FROM events
         WHERE workspace_id = $1 AND id = $2 AND event_kind = 'goal.transition.committed'`,
        [POSTGRES_DEMO_IDS.workspace, `goal-transition:${jobId}:1`],
      );
      assert.equal(transition.rowCount, 1);
    }
  },
);
