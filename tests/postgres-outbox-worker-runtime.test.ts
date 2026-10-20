import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import {
  createPostgresRuntimeRepository,
  POSTGRES_DEMO_IDS,
} from "../database/postgres/public.ts";
import {
  executeTurn,
  type RuntimeCommand,
  type RuntimeRepository,
  type TurnRuntimeDependencies,
} from "../modules/runtime/public.ts";

const adminConnectionString = process.env.DATABASE_URL;
const runtimeConnectionString = process.env.REALM_RUNTIME_DATABASE_URL;

type CommandPayload = { text: string };
type Plan = { objective: string };
type Candidate = { text: string };
type Validation = { accepted: boolean };
type EventPayload = { content: string };
type OutboxPayload = { recordId: string; eventIds: string[] };

interface DeliveryRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function currentRecordVersion(ownerPool: pg.Pool): Promise<number> {
  const result = await ownerPool.query<{ version: string }>(
    `SELECT record_version AS version FROM record_heads
     WHERE workspace_id = $1 AND record_id = $2`,
    [POSTGRES_DEMO_IDS.workspace, POSTGRES_DEMO_IDS.record],
  );
  const version = Number(result.rows[0]?.version);
  assert.ok(Number.isSafeInteger(version) && version >= 1);
  return version;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error("timed out waiting for Outbox worker state");
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function startDeliveryServer(
  requests: DeliveryRequest[],
): Promise<{ server: ReturnType<typeof createServer>; endpoint: string }> {
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    requests.push({
      headers: request.headers,
      body: JSON.parse(body),
    });
    // Force one durable retry before acknowledging the message.
    if (requests.length === 1) {
      response.statusCode = 503;
    } else {
      response.statusCode = 202;
    }
    response.end();
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return {
      server,
      endpoint: `http://127.0.0.1:${address.port}/events`,
    };
  });
}

function startChild(
  script: string,
  env: Record<string, string>,
): { child: ChildProcess; output: { stdout: string; stderr: string } } {
  const output = { stdout: "", stderr: "" };
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", script],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ) as ChildProcess;
  child.stdout?.on("data", (chunk: Buffer) => { output.stdout += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output.stderr += chunk.toString(); });
  return { child, output };
}

function runtimeDependencies(
  repository: RuntimeRepository<
    CommandPayload,
    Plan,
    Candidate,
    Validation,
    EventPayload,
    OutboxPayload
  >,
  suffix: string,
): TurnRuntimeDependencies<
  CommandPayload,
  Plan,
  Candidate,
  Validation,
  EventPayload,
  OutboxPayload
> {
  let clockSecond = 0;
  return {
    repository,
    planner: { async plan() { return { objective: "commit the delivery" }; } },
    drafter: { async draft() { return { text: "A delivery is waiting." }; } },
    validator: { async validate() { return { accepted: true }; } },
    releaseBuilder: {
      async build(context) {
        const eventId = `${context.turnId}:event`;
        return {
          formalEvents: [{
            eventId,
            kind: "narration.committed",
            payload: { content: context.candidate.body.text },
          }],
          outbox: [{
            messageId: `${context.turnId}:delivery`,
            topic: "record.events.committed",
            dedupeKey: `${context.turnId}:delivery:v1`,
            payload: { recordId: POSTGRES_DEMO_IDS.record, eventIds: [eventId] },
          }],
        };
      },
    },
    idFactory: () => `outbox-worker-${suffix}`,
    clock: () => new Date(Date.UTC(2026, 9, 5, 0, 0, clockSecond++)).toISOString(),
  };
}

test(
  "production Outbox worker delivers record.events.committed through HTTP and retries safely",
  { skip: !adminConnectionString || !runtimeConnectionString, timeout: 120_000 },
  async (t) => {
    const requests: DeliveryRequest[] = [];
    const delivery = await startDeliveryServer(requests);
    const ownerPool = new pg.Pool({ connectionString: adminConnectionString!, max: 3 });
    const suffix = randomUUID().replaceAll("-", "");
    // Register cleanup before any assertion so an early failure still
    // releases the pool, the delivery server and any spawned worker.
    const processes: ChildProcess[] = [];
    t.after(async () => {
      for (const process of processes) {
        if (process.exitCode === null && process.signalCode === null) {
          process.kill("SIGKILL");
          await Promise.race([once(process, "exit"), sleep(5_000)]);
        }
      }
      await ownerPool.end();
      await new Promise<void>((resolve) => delivery.server.close(() => resolve()));
    });
    const repository = createPostgresRuntimeRepository<
      CommandPayload,
      Plan,
      Candidate,
      Validation,
      EventPayload,
      OutboxPayload
    >({
      pool: ownerPool,
      workspaceId: POSTGRES_DEMO_IDS.workspace,
      mapFormalEvent({ draft }) {
        return {
          sceneId: POSTGRES_DEMO_IDS.scene,
          visibilityPolicyId: POSTGRES_DEMO_IDS.publicPolicy,
          eventKind: "narration.committed",
          content: draft.payload.content,
        };
      },
    });
    const command: RuntimeCommand<CommandPayload> = {
      commandType: "player.utterance",
      recordId: POSTGRES_DEMO_IDS.record,
      // The demo record head is read back instead of assumed: sibling suites
      // sharing the scratch realm_dev (e.g. the Goal runtime suite settles a
      // transition into the demo record) may have advanced it, and node:test
      // orders files alphabetically rather than by CLI argument order.
      expectedRecordVersion: await currentRecordVersion(ownerPool),
      idempotencyKey: `outbox-worker-${suffix}`,
      actorId: null,
      payload: { text: "Deliver this event." },
    };
    const completed = await executeTurn(
      command,
      runtimeDependencies(repository, suffix),
    );
    assert.equal(completed.state, "completed");
    const messageId = `${completed.turnId}:delivery`;
    const before = await repository.loadOutboxMessage(messageId);
    assert.equal(before?.state, "pending");

    const workerScript = fileURLToPath(
      new URL("../scripts/outbox-worker.mjs", import.meta.url),
    );
    const childEnv: Record<string, string> = {
      REALM_RUNTIME_DATABASE_URL: runtimeConnectionString!,
      REALM_OUTBOX_DELIVERY_URL: delivery.endpoint,
      REALM_OUTBOX_WORKSPACES: POSTGRES_DEMO_IDS.workspace,
      REALM_OUTBOX_RETRY_DELAY_MS: "25",
      REALM_OUTBOX_IDLE_MIN_MS: "10",
      REALM_OUTBOX_IDLE_MAX_MS: "50",
      REALM_OUTBOX_BATCH_LIMIT: "4",
      REALM_OUTBOX_MAX_ATTEMPTS: "3",
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    };
    const { child, output } = startChild(workerScript, childEnv);
    processes.push(child);

    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("Outbox worker exited before acquiring its advisory lock.");
      }
      return output.stdout.includes("advisory lock acquired");
    });
    const competitor = startChild(workerScript, childEnv);
    processes.push(competitor.child);
    const [competitorExitCode, competitorSignal] = await once(
      competitor.child,
      "exit",
    ) as [number | null, NodeJS.Signals | null];
    assert.equal(competitorExitCode, 1);
    assert.equal(competitorSignal, null);
    assert.match(
      `${competitor.output.stdout}\n${competitor.output.stderr}`,
      /another Outbox worker instance holds the advisory lock/,
    );
    assert.doesNotMatch(
      `${competitor.output.stdout}\n${competitor.output.stderr}`,
      /postgres(?:ql)?:\/\//i,
    );

    await waitFor(async () => {
      const result = await ownerPool.query<{ state: string; attempts: number }>(
        `SELECT state, attempt_count AS attempts
         FROM outbox WHERE workspace_id = $1 AND id = $2`,
        [POSTGRES_DEMO_IDS.workspace, messageId],
      );
      return result.rows[0]?.state === "delivered"
        && Number(result.rows[0]?.attempts) === 2;
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.headers["idempotency-key"], `${completed.turnId}:delivery:v1`);
    assert.equal(requests[1]?.headers["idempotency-key"], `${completed.turnId}:delivery:v1`);
    assert.deepEqual((requests[1]?.body as { payload?: unknown }).payload, {
      recordId: POSTGRES_DEMO_IDS.record,
      eventIds: [`${completed.turnId}:event`],
    });

    child.kill("SIGTERM");
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0);
    // stop() through the shared host must release the advisory lock
    // (dedicated connection closed) before the process exits.
    const locksAfterExit = await ownerPool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND granted
         AND classid = ((hashtext('realm_outbox_worker')::bigint >> 32) & x'ffffffff'::bigint)::bigint
         AND objid = (hashtext('realm_outbox_worker')::bigint & x'ffffffff'::bigint)::bigint`,
    );
    assert.equal(locksAfterExit.rows[0]?.n, 0, "SIGTERM stop must release the advisory lock");
    assert.doesNotMatch(output.stdout, /postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(output.stderr, /postgres(?:ql)?:\/\//i);
    assert.doesNotMatch(`${output.stdout}\n${output.stderr}`, /api[_-]?key|token|password|secret/i);
  },
);
