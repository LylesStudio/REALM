/**
 * 批次 T11-B——semantic review 路由/评估器/适配层 deadline 单测（规范 §六）。
 * 分流（none/hard 不调模型、high-risk 最多一次）、单飞 409、输入上界 400、
 * evidence 写失败 503 不声称完成、timeoutMs 透传、非法 JSON/网关错误
 * fallback、适配层 per-call deadline 真实 abort 底层 fetch。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createSemanticReviewPost,
  SEMANTIC_REVIEW_TIMEOUT_MS,
} from "../app/api/worldline/conflict/semantic/route.ts";
import {
  createModelSemanticConflictAssessor,
  type SemanticConflictEvidence,
  type SemanticConflictEvidenceStore,
} from "../modules/worldline/semantic-conflict.ts";
import {
  createOpenAICompatibleGateway,
  ModelProviderError,
  type ModelGateway,
  type ModelProviderSettings,
} from "../modules/inference/public.ts";
import type { WorldClaim } from "../modules/world-knowledge/public.ts";

const SCOPE = { workspaceId: "ws", worldId: "world", worldlineId: "line" };

function claim(overrides: Partial<WorldClaim> = {}): WorldClaim {
  return {
    id: "claim_1",
    subjectEntityId: "e1",
    predicate: "状态",
    objectValue: "存活",
    scope: "story",
    truthStatus: "record_confirmed",
    confidence: 1,
    validFromTick: 5,
    validToTick: null,
    sourceRecordId: null,
    sourceEventId: null,
    supersedesClaimId: null,
    ...overrides,
  };
}

function requestBody(changeOverrides: Record<string, unknown> = {}) {
  return {
    worldId: SCOPE.worldId,
    existingFuture: { tick: 5, ordinal: 0 },
    changeSet: {
      changes: [
        {
          kind: "terminate",
          subjectEntityId: "e1",
          predicate: "状态",
          objectValue: "死亡",
          targetClaimId: "claim_1",
          effectiveCursor: { tick: 1, ordinal: 0 },
          ...changeOverrides,
        },
      ],
    },
  };
}

function post(body: unknown): Request {
  return new Request("http://localhost/api/worldline/conflict/semantic", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createHandler(options: {
  claims?: readonly WorldClaim[];
  assessor?: ReturnType<typeof createModelSemanticConflictAssessor>;
  scope?: typeof SCOPE | null;
}) {
  const claims = options.claims ?? [];
  return createSemanticReviewPost({
    resolveScope: () => Promise.resolve(options.scope === undefined ? SCOPE : options.scope),
    loadFacts: () => Promise.resolve({ existingClaims: claims, causalEdges: [] }),
    createAssessor: () => {
      if (!options.assessor) throw new Error("assessor must not be created");
      return options.assessor;
    },
    hasRuntime: () => true,
  });
}

test("semantic review: none/hard severities never touch the model", async () => {
  let created = 0;
  // none：变更晚于现有未来（tick 9 > 5）。
  const noneHandler = createSemanticReviewPost({
    resolveScope: () => Promise.resolve(SCOPE),
    loadFacts: () => Promise.resolve({ existingClaims: [], causalEdges: [] }),
    createAssessor: () => {
      created += 1;
      throw new Error("must not create");
    },
    hasRuntime: () => true,
  });
  const noneResponse = await noneHandler(post({
    worldId: SCOPE.worldId,
    existingFuture: { tick: 5, ordinal: 0 },
    changeSet: {
      changes: [{
        kind: "assert",
        subjectEntityId: "e1",
        predicate: "状态",
        objectValue: "存活",
        effectiveCursor: { tick: 9, ordinal: 0 },
      }],
    },
  }));
  assert.equal(noneResponse.status, 200);
  const noneBody = await noneResponse.json() as { semantic: unknown; deterministic: { classification: { conflict: string } } };
  assert.equal(noneBody.semantic, null);
  assert.equal(noneBody.deterministic.classification.conflict, "none");

  // hard：过去终止 + 未来活动 Claim（确定性 life_state 冲突）。
  const hardHandler = createHandler({
    claims: [claim()],
    assessor: undefined,
  });
  const hardResponse = await hardHandler(post(requestBody()));
  assert.equal(hardResponse.status, 200);
  const hardBody = await hardResponse.json() as { semantic: unknown; deterministic: { classification: { conflict: string } } };
  assert.equal(hardBody.semantic, null);
  assert.equal(hardBody.deterministic.classification.conflict, "hard");
  assert.equal(created, 0, "none/hard 不得创建评估器");
});

test("semantic review: high-risk calls the model at most once and persists scoped evidence", async () => {
  const stored: SemanticConflictEvidence[] = [];
  let chatCalls = 0;
  let seenTimeout: number | undefined;
  const evidenceStore: SemanticConflictEvidenceStore = {
    append: (evidence) => {
      stored.push(evidence);
      return Promise.resolve();
    },
  };
  const gateway: ModelGateway = {
    discoverModels: () => Promise.resolve([]),
    chat: (request) => {
      chatCalls += 1;
      seenTimeout = request.timeoutMs;
      return Promise.resolve({
        model: "fake-model",
        content: JSON.stringify({
          kind: "life_state",
          severity: "hard",
          recommendation: "branch",
          rationale: "人物生死矛盾，建议分支。",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      });
    },
  };
  const assessor = createModelSemanticConflictAssessor({
    getGateway: () => Promise.resolve(gateway),
    evidenceStore,
    timeoutMs: SEMANTIC_REVIEW_TIMEOUT_MS,
  });
  // high-risk：无锚点的过去变更（空事实集 + 过去游标）。
  const handler = createHandler({ claims: [], assessor });
  const response = await handler(post({
    worldId: SCOPE.worldId,
    existingFuture: { tick: 5, ordinal: 0 },
    changeSet: {
      changes: [{
        kind: "assert",
        subjectEntityId: "e1",
        predicate: "布局",
        objectValue: "改变",
        effectiveCursor: { tick: 1, ordinal: 0 },
      }],
    },
  }));
  assert.equal(response.status, 200);
  const body = await response.json() as {
    deterministic: { classification: { conflict: string } };
    semantic: SemanticConflictEvidence;
  };
  assert.equal(body.deterministic.classification.conflict, "high-risk");
  assert.equal(body.semantic.source, "model");
  assert.equal(body.semantic.result.recommendation, "branch");
  assert.equal(chatCalls, 1, "high-risk 最多一次模型调用");
  assert.equal(seenTimeout, SEMANTIC_REVIEW_TIMEOUT_MS, "评估器透传 8s 预算");
  assert.equal(stored.length, 1, "evidence 落库");
  assert.equal(stored[0]?.scope?.worldId, SCOPE.worldId);
  assert.equal(stored[0]?.scope?.worldlineId, SCOPE.worldlineId);
  assert.match(stored[0]?.requestId ?? "", /^sr_/);
  assert.equal(stored[0]?.promptVersion, "semantic-conflict-v1");
});

test("semantic review: invalid JSON and gateway errors fall back with deterministic verdict", async () => {
  for (const mode of ["invalid-json", "gateway-error"] as const) {
    const stored: SemanticConflictEvidence[] = [];
    const gateway: ModelGateway = {
      discoverModels: () => Promise.resolve([]),
      chat: () => {
        if (mode === "invalid-json") {
          return Promise.resolve({
            model: "fake-model",
            content: "not-json",
            toolCalls: [],
            finishReason: "stop",
            usage: null,
          });
        }
        return Promise.reject(
          new ModelProviderError("MODEL_REQUEST_FAILED", "down"),
        );
      },
    };
    const assessor = createModelSemanticConflictAssessor({
      getGateway: () => Promise.resolve(gateway),
      evidenceStore: { append: (evidence) => (stored.push(evidence), Promise.resolve()) },
      timeoutMs: SEMANTIC_REVIEW_TIMEOUT_MS,
    });
    const handler = createHandler({ claims: [], assessor });
    const response = await handler(post({
      worldId: SCOPE.worldId,
      existingFuture: { tick: 5, ordinal: 0 },
      changeSet: {
        changes: [{
          kind: "assert",
          subjectEntityId: "e1",
          predicate: "布局",
          objectValue: "改变",
          effectiveCursor: { tick: 1, ordinal: 0 },
        }],
      },
    }));
    assert.equal(response.status, 200);
    const body = await response.json() as { semantic: SemanticConflictEvidence };
    assert.equal(body.semantic.source, "fallback", `${mode} 必须 fallback`);
    assert.equal(body.semantic.model, "none");
    assert.equal(body.semantic.result.severity, "high-risk", "fallback 保留确定性结论");
    assert.equal(body.semantic.result.recommendation, "branch");
    assert.equal(stored.length, 1, "fallback evidence 也落库");
  }
});

test("semantic review: busy gate, input bound, evidence failure and scope errors", async () => {
  // 单飞：第一个请求挂起时第二个 409。
  let release: (() => void) | undefined;
  const hangingGateway: ModelGateway = {
    discoverModels: () => Promise.resolve([]),
    chat: () => new Promise((resolve) => {
      release = () => resolve({
        model: "fake",
        content: JSON.stringify({
          kind: "other", severity: "high-risk",
          recommendation: "branch", rationale: "r",
        }),
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      });
    }),
  };
  const hangingAssessor = createModelSemanticConflictAssessor({
    getGateway: () => Promise.resolve(hangingGateway),
    evidenceStore: { append: () => Promise.resolve() },
  });
  const busyHandler = createHandler({ claims: [], assessor: hangingAssessor });
  const highRiskBody = {
    worldId: SCOPE.worldId,
    existingFuture: { tick: 5, ordinal: 0 },
    changeSet: {
      changes: [{
        kind: "assert", subjectEntityId: "e1", predicate: "布局",
        objectValue: "改变", effectiveCursor: { tick: 1, ordinal: 0 },
      }],
    },
  };
  const first = busyHandler(post(highRiskBody));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await busyHandler(post(highRiskBody));
  assert.equal(second.status, 409);
  assert.equal(
    (await second.json() as { error: { code: string } }).error.code,
    "SEMANTIC_REVIEW_BUSY",
  );
  release!();
  assert.equal((await first).status, 200);

  // 输入上界：>64 Claims → 400，不调模型。
  const oversizedHandler = createSemanticReviewPost({
    resolveScope: () => Promise.resolve(SCOPE),
    loadFacts: () => Promise.resolve({
      existingClaims: Array.from({ length: 65 }, (_, index) =>
        claim({ id: `claim_${index}` })),
      causalEdges: [],
    }),
    createAssessor: () => {
      throw new Error("must not create assessor for oversized input");
    },
    hasRuntime: () => true,
  });
  const oversized = await oversizedHandler(post(highRiskBody));
  assert.equal(oversized.status, 400);
  assert.equal(
    (await oversized.json() as { error: { code: string } }).error.code,
    "SEMANTIC_REVIEW_INPUT_TOO_LARGE",
  );

  // evidence 写失败 → 503，不返回复审结果。
  const failingStore: SemanticConflictEvidenceStore = {
    append: () => Promise.reject(new Error("disk full")),
  };
  const okGateway: ModelGateway = {
    discoverModels: () => Promise.resolve([]),
    chat: () => Promise.resolve({
      model: "fake",
      content: JSON.stringify({
        kind: "other", severity: "high-risk",
        recommendation: "branch", rationale: "r",
      }),
      toolCalls: [],
      finishReason: "stop",
      usage: null,
    }),
  };
  const failingHandler = createHandler({
    claims: [],
    assessor: createModelSemanticConflictAssessor({
      getGateway: () => Promise.resolve(okGateway),
      evidenceStore: failingStore,
    }),
  });
  const failed = await failingHandler(post(highRiskBody));
  assert.equal(failed.status, 503);
  assert.equal(
    (await failed.json() as { error: { code: string } }).error.code,
    "SEMANTIC_REVIEW_UNAVAILABLE",
  );

  // 未知世界 404 / 缺 worldId 400。
  const notFoundHandler = createHandler({ claims: [], scope: null });
  assert.equal((await notFoundHandler(post(highRiskBody))).status, 404);
  const anyHandler = createHandler({ claims: [], assessor: hangingAssessor });
  assert.equal(
    (await anyHandler(post({ ...highRiskBody, worldId: "" }))).status,
    400,
  );
});

test("OpenAI-compatible adapter honors per-call deadline with a real abort", async () => {
  const settings: ModelProviderSettings = {
    schemaVersion: 1,
    providerId: "lmstudio",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKey: "",
    selectedModel: "fake",
    thinking: "disabled",
    timeoutMs: 30_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
  let abortSeen = false;
  const gateway = createOpenAICompatibleGateway({
    settings,
    fetch: (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortSeen = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    },
  });
  const startedAt = Date.now();
  // per-call 50ms 覆盖（设置 30s）——必须在 ~50ms 真实终止底层请求。
  await assert.rejects(
    gateway.chat({
      messages: [{ role: "user", content: "x" }],
      timeoutMs: 50,
    }),
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(abortSeen, "底层 fetch 必须观察到 abort（不是 Promise.race 假超时）");
  assert.ok(elapsed < 5_000, `deadline 应远早于设置超时（实测 ${elapsed}ms）`);

  // min 语义：per-call 30s > 设置 50ms → 按设置 50ms 终止。
  abortSeen = false;
  const tighter = createOpenAICompatibleGateway({
    settings: { ...settings, timeoutMs: 50 },
    fetch: (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          abortSeen = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      }),
  });
  await assert.rejects(
    tighter.chat({ messages: [{ role: "user", content: "x" }], timeoutMs: 30_000 }),
    (error: unknown) =>
      error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT",
  );
  assert.ok(abortSeen);
});
