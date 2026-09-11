import assert from "node:assert/strict";
import test from "node:test";
import { handlePreviewGet } from "../app/api/record/preview/route.ts";
import {
  POST as cancelPost,
  handleCancelPost,
} from "../app/api/record/messages/cancel/route.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  type LocalPreviewEvent,
  type LocalRecordService,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository, type RuntimeRepository } from "../modules/runtime/public.ts";
import type { RecordProjection } from "../modules/application/legacy-record-projection-types.ts";
import type { ActionTransaction } from "../modules/actions/public.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type { SemanticSegment } from "../modules/presentation/semantic-segments.ts";

/**
 * Preview/cancel 授权批：route 必须先过 Record scope + world membership +
 * viewer 可见性窄检查（authorizeRecordViewer），未通过不得 subscribe /
 * 不得 cancel；principal 只来自 session（access-gate 关闭时回落本地
 * 单用户 principal，但 scope 检查不绕过）。
 */

type CommandPayload = { text: string; visibility: TurnVisibilityPlan };
type EventPayload = {
  schemaVersion: 1;
  role: "player" | "character" | "narrator" | "system";
  speaker: string;
  participantId: string | null;
  content: string;
  segments: readonly SemanticSegment[];
  actionTransaction?: ActionTransaction;
};
type OutboxPayload = { recordId: string; eventIds: readonly string[] };
type Repository = RuntimeRepository<
  CommandPayload,
  M2TurnPlan,
  M2TurnCandidate,
  M2TurnValidation,
  EventPayload,
  OutboxPayload
>;

const SESSION_PRINCIPAL = "principal_demo_player";
const GATE_TOKEN = "preview-cancel-auth-gate-token";

function sessionCookie(principalId: string): string {
  return `realm_session=${createSessionValue(principalId)}`;
}

async function withGate<T>(enabled: boolean, run: () => Promise<T>): Promise<T> {
  const saved = process.env.REALM_ACCESS_TOKEN;
  try {
    if (enabled) process.env.REALM_ACCESS_TOKEN = GATE_TOKEN;
    else delete process.env.REALM_ACCESS_TOKEN;
    return await run();
  } finally {
    if (saved === undefined) delete process.env.REALM_ACCESS_TOKEN;
    else process.env.REALM_ACCESS_TOKEN = saved;
  }
}

type FakeSpies = {
  authorizeCalls: { recordId: string; principalId?: string }[];
  subscribeCalls: string[];
  unsubscribeCalls: number;
  cancelCalls: { recordId: string; key: string }[];
  emit(recordId: string, event: LocalPreviewEvent): void;
};

function createFakeService(options: {
  authorizeError?: LocalRecordServiceError;
  cancelResult?: boolean;
} = {}): { service: LocalRecordService; spies: FakeSpies } {
  const listeners = new Map<string, (event: LocalPreviewEvent) => void>();
  const spies: FakeSpies = {
    authorizeCalls: [],
    subscribeCalls: [],
    unsubscribeCalls: 0,
    cancelCalls: [],
    emit(recordId, event) {
      listeners.get(recordId)?.(event);
    },
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  const service: LocalRecordService = {
    loadRecord: unused,
    openDefaultRecord: unused,
    submitMessage: unused,
    startSelfPlay: unused,
    stopSelfPlay: unused,
    listCommittedEvents: unused,
    async authorizeRecordViewer(recordId, principalId) {
      spies.authorizeCalls.push({ recordId, principalId });
      if (options.authorizeError) throw options.authorizeError;
    },
    subscribePreviews(recordId, listener) {
      spies.subscribeCalls.push(recordId);
      listeners.set(recordId, listener);
      return () => {
        spies.unsubscribeCalls += 1;
        listeners.delete(recordId);
      };
    },
    cancelMessage(recordId, key) {
      spies.cancelCalls.push({ recordId, key });
      return options.cancelResult ?? true;
    },
  };
  return { service, spies };
}

function previewRequest(
  query: string,
  init: { cookie?: string; signal?: AbortSignal } = {},
): Request {
  return new Request(`http://localhost/api/record/preview?${query}`, {
    ...(init.cookie ? { headers: { cookie: init.cookie } } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
  });
}

function cancelRequest(body: unknown, init: { cookie?: string } = {}): Request {
  return new Request("http://localhost/api/record/messages/cancel", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(init.cookie ? { cookie: init.cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function readStreamChunk(
  response: Response,
  timeoutMs = 2000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("stream read 超时")), timeoutMs)
      ),
    ]);
    return decoder.decode(result.value);
  } finally {
    reader.releaseLock();
  }
}

test("preview：gate 开启且未登录 → 401，不触碰 service", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService();
    const response = await handlePreviewGet(
      previewRequest(`recordId=${LOCAL_RECORD_SCOPE.recordId}`),
      service,
    );
    assert.equal(response.status, 401);
    assert.equal(spies.authorizeCalls.length, 0);
    assert.equal(spies.subscribeCalls.length, 0);
  });
});

test("preview：unknown/non-member/non-viewer record → 安全 404，无 SSE body、不订阅", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService({
      authorizeError: new LocalRecordServiceError("NOT_FOUND", "Record not found."),
    });
    const response = await handlePreviewGet(
      previewRequest(`recordId=${LOCAL_RECORD_SCOPE.recordId}`, {
        cookie: sessionCookie(SESSION_PRINCIPAL),
      }),
      service,
    );
    assert.equal(response.status, 404);
    assert.notEqual(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const body = await response.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(spies.subscribeCalls.length, 0);
  });
});

test("preview：runtime 未初始化 → 既有 503 形态", async () => {
  await withGate(true, async () => {
    const { service } = createFakeService({
      authorizeError: new LocalRecordServiceError(
        "LOCAL_RUNTIME_NOT_INITIALIZED",
        "The local PostgreSQL demo has not been initialized.",
      ),
    });
    const response = await handlePreviewGet(
      previewRequest(`recordId=${LOCAL_RECORD_SCOPE.recordId}`, {
        cookie: sessionCookie(SESSION_PRINCIPAL),
      }),
      service,
    );
    assert.equal(response.status, 503);
  });
});

test("preview：已授权 viewer 用 session principal 订阅成功；query 伪造身份无效；abort 清理订阅", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService();
    const controller = new AbortController();
    const response = await handlePreviewGet(
      previewRequest(
        `recordId=${LOCAL_RECORD_SCOPE.recordId}&principalId=principal_evil&workspaceId=ws_evil&worldlineId=wl_evil`,
        { cookie: sessionCookie(SESSION_PRINCIPAL), signal: controller.signal },
      ),
      service,
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-type"),
      "text/event-stream; charset=utf-8",
    );
    // 授权只认 session principal + query 的 recordId；伪造字段不影响。
    assert.deepEqual(spies.authorizeCalls, [
      { recordId: LOCAL_RECORD_SCOPE.recordId, principalId: SESSION_PRINCIPAL },
    ]);
    assert.deepEqual(spies.subscribeCalls, [LOCAL_RECORD_SCOPE.recordId]);
    // 授权后既有 chunk/end 交付不变。
    spies.emit(LOCAL_RECORD_SCOPE.recordId, {
      kind: "chunk",
      previewId: "pv_1",
      speaker: "旁白",
      content: "chunk-content",
    });
    const chunk = await readStreamChunk(response);
    assert.match(chunk, /event: preview\ndata: /);
    assert.match(chunk, /"kind":"chunk"/);
    // request abort 仍清理订阅。
    controller.abort();
    assert.equal(spies.unsubscribeCalls, 1);
  });
});

test("cancel：gate 开启且未登录 → 401，不触碰 service", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService();
    const response = await handleCancelPost(
      cancelRequest({
        recordId: LOCAL_RECORD_SCOPE.recordId,
        clientMessageId: "key-1",
      }),
      service,
    );
    assert.equal(response.status, 401);
    assert.equal(spies.authorizeCalls.length, 0);
    assert.equal(spies.cancelCalls.length, 0);
  });
});

test("cancel：未授权 record → 404，不调用 cancelMessage（在途 Turn 不被 abort）", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService({
      authorizeError: new LocalRecordServiceError("NOT_FOUND", "Record not found."),
    });
    const response = await handleCancelPost(
      cancelRequest(
        { recordId: LOCAL_RECORD_SCOPE.recordId, clientMessageId: "key-1" },
        { cookie: sessionCookie(SESSION_PRINCIPAL) },
      ),
      service,
    );
    assert.equal(response.status, 404);
    const body = await response.json() as { ok: boolean; error: { code: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(spies.cancelCalls.length, 0);
  });
});

test("cancel：已授权 viewer 命中 controller；body 伪造身份无效；未知 key 维持 404/false", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService({ cancelResult: true });
    const response = await handleCancelPost(
      cancelRequest(
        {
          recordId: LOCAL_RECORD_SCOPE.recordId,
          clientMessageId: "key-1",
          principalId: "principal_evil",
          workspaceId: "ws_evil",
          worldlineId: "wl_evil",
        },
        { cookie: sessionCookie(SESSION_PRINCIPAL) },
      ),
      service,
    );
    assert.equal(response.status, 202);
    const body = await response.json() as { ok: boolean; cancelled: boolean };
    assert.deepEqual(body, { ok: true, cancelled: true });
    assert.deepEqual(spies.authorizeCalls, [
      { recordId: LOCAL_RECORD_SCOPE.recordId, principalId: SESSION_PRINCIPAL },
    ]);
    assert.deepEqual(spies.cancelCalls, [
      { recordId: LOCAL_RECORD_SCOPE.recordId, key: "key-1" },
    ]);

    // 未知/已结束 key：维持现有 404 + cancelled=false 语义。
    const missing = createFakeService({ cancelResult: false });
    const missingResponse = await handleCancelPost(
      cancelRequest(
        { recordId: LOCAL_RECORD_SCOPE.recordId, clientMessageId: "key-gone" },
        { cookie: sessionCookie(SESSION_PRINCIPAL) },
      ),
      missing.service,
    );
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), { ok: true, cancelled: false });
  });
});

test("cancel：缺字段 body → 400，不触碰 service", async () => {
  await withGate(true, async () => {
    const { service, spies } = createFakeService();
    const response = await handleCancelPost(
      cancelRequest({ recordId: LOCAL_RECORD_SCOPE.recordId }),
      service,
    );
    assert.equal(response.status, 400);
    assert.equal(spies.authorizeCalls.length, 0);
    assert.equal(spies.cancelCalls.length, 0);
  });
});

test("gate 关闭的本地 fallback：principal 回落本地单用户，但 scope 检查不绕过", async () => {
  await withGate(false, async () => {
    const { service, spies } = createFakeService();
    const controller = new AbortController();
    const response = await handlePreviewGet(
      previewRequest("recordId=record_explicit", { signal: controller.signal }),
      service,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(spies.authorizeCalls, [
      { recordId: "record_explicit", principalId: LOCAL_RECORD_SCOPE.principalId },
    ]);
    assert.deepEqual(spies.subscribeCalls, ["record_explicit"]);
    // 清理 SSE heartbeat/订阅，避免悬挂定时器。
    controller.abort();
    assert.equal(spies.unsubscribeCalls, 1);

    const cancel = await handleCancelPost(
      cancelRequest({ recordId: "record_explicit", clientMessageId: "k" }),
      service,
    );
    assert.equal(cancel.status, 202);
    assert.deepEqual(spies.cancelCalls, [
      { recordId: "record_explicit", key: "k" },
    ]);
  });
});

test("cancel POST wrapper：runtime 未初始化仍返回 503，而不是被外层 catch 改成 500", async () => {
  await withGate(false, async () => {
    const saved = process.env.REALM_RUNTIME_DATABASE_URL;
    try {
      delete process.env.REALM_RUNTIME_DATABASE_URL;
      const response = await cancelPost(
        cancelRequest({
          recordId: LOCAL_RECORD_SCOPE.recordId,
          clientMessageId: "wrapper-key",
        }),
      );
      assert.equal(response.status, 503);
      const body = await response.json() as { ok: boolean; error: { code: string } };
      assert.equal(body.ok, false);
      assert.equal(body.error.code, "LOCAL_RUNTIME_NOT_INITIALIZED");
    } finally {
      if (saved === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
      else process.env.REALM_RUNTIME_DATABASE_URL = saved;
    }
  });
});

// ---- service 级：authorizeRecordViewer 语义与零副作用 ----

function createServiceFixture(options: {
  deliveryNull?: boolean;
  headMissing?: boolean;
} = {}) {
  const calls = {
    delivery: 0,
    issue: 0,
    saveLastOpened: 0,
  };
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: options.headMissing
      ? []
      : [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }],
  });
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return null;
    },
    async loadDeliveryForPlayer() {
      calls.delivery += 1;
      if (options.deliveryNull) return null;
      return {
        record: { id: LOCAL_RECORD_SCOPE.recordId } as unknown as RecordProjection,
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: "char_inst_player",
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const service = createLocalRecordService({
    repository,
    projection,
    tokens: createMemoryWriteTokenRegistry({
      randomToken: () => {
        calls.issue += 1;
        return `opaque-${calls.issue}`;
      },
      clock: () => new Date("2026-09-04T01:00:00.000Z"),
    }),
    clock: () => new Date("2026-09-04T01:00:00.000Z"),
    accountMemory: {
      async findLastOpened() {
        return null;
      },
      async saveLastOpened() {
        calls.saveLastOpened += 1;
      },
    },
  });
  return { service, calls };
}

test("authorizeRecordViewer：未知 Record → NOT_FOUND，不读 delivery、无副作用", async () => {
  const { service, calls } = createServiceFixture();
  await assert.rejects(
    service.authorizeRecordViewer("record_stranger", SESSION_PRINCIPAL),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "NOT_FOUND");
      return true;
    },
  );
  assert.equal(calls.delivery, 0);
  assert.equal(calls.issue, 0);
  assert.equal(calls.saveLastOpened, 0);
});

test("authorizeRecordViewer：无 viewer projection（非成员）→ 安全 404，同形于未知 Record", async () => {
  const { service, calls } = createServiceFixture({ deliveryNull: true });
  await assert.rejects(
    service.authorizeRecordViewer(LOCAL_RECORD_SCOPE.recordId, SESSION_PRINCIPAL),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "NOT_FOUND");
      assert.equal(error.message, "Record not found.");
      return true;
    },
  );
  assert.equal(calls.delivery, 1);
  assert.equal(calls.issue, 0);
  assert.equal(calls.saveLastOpened, 0);
});

test("authorizeRecordViewer：runtime 未初始化 → 503 形态；已授权 viewer 通过且零副作用", async () => {
  const missing = createServiceFixture({ headMissing: true });
  await assert.rejects(
    missing.service.authorizeRecordViewer(
      LOCAL_RECORD_SCOPE.recordId,
      SESSION_PRINCIPAL,
    ),
    (error: unknown) => {
      assert.ok(error instanceof LocalRecordServiceError);
      assert.equal(error.code, "LOCAL_RUNTIME_NOT_INITIALIZED");
      return true;
    },
  );

  const { service, calls } = createServiceFixture();
  await service.authorizeRecordViewer(
    LOCAL_RECORD_SCOPE.recordId,
    SESSION_PRINCIPAL,
  );
  // 只读窄授权：不签发 writeToken、不写 account last-opened。
  assert.equal(calls.issue, 0);
  assert.equal(calls.saveLastOpened, 0);
});
