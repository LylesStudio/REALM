import assert from "node:assert/strict";
import test from "node:test";
import type { RecordProjection, ProjectionEvent } from "../modules/application/legacy-record-projection-types.ts";
import {
  LOCAL_RECORD_SCOPE,
  LocalRecordServiceError,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  mapLocalFormalEvent,
  type LocalRecordService,
} from "../modules/application/local-record-service.ts";
import {
  createInMemoryRuntimeRepository,
  type RuntimeRepository,
} from "../modules/runtime/public.ts";
import {
  fallbackSemanticSegments,
  type SemanticSegment,
} from "../modules/presentation/semantic-segments.ts";
import type {
  M2TurnCandidate,
  M2TurnPlan,
  M2TurnValidation,
  TurnVisibilityPlan,
} from "../modules/orchestration/public.ts";
import type {
  ActionAffordanceCatalog,
  ActionTransaction,
} from "../modules/actions/public.ts";
import { handleRecordGet } from "../app/api/record/route.ts";
import { handleMessagePost } from "../app/api/record/messages/route.ts";
import {
  createCommittedEventStream,
  handleCommittedEventsGet,
} from "../app/api/record/events/route.ts";

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

function createFixture(actionCatalog?: ActionAffordanceCatalog) {
  const repository: Repository = createInMemoryRuntimeRepository({
    recordHeads: [
      { recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 },
    ],
  });
  let tokenSequence = 0;
  let idSequence = 0;
  async function loadProjection() {
    const runtimeEvents = await repository.listCommittedEvents(
      LOCAL_RECORD_SCOPE.recordId,
    );
    const deliveryEvents = runtimeEvents.filter(
      (event) => event.kind !== "action.transaction.committed",
    );
    const events: ProjectionEvent[] = [openingEvent()].concat(
      deliveryEvents.map((event, index) => ({
        id: event.eventId,
        ordinal: index + 2,
        type:
          event.kind === "narration.committed" ? "narration" : "utterance",
        speaker: event.payload.speaker,
        speakerParticipantId: event.payload.participantId,
        role: event.payload.role,
          content: event.payload.content,
          segments: event.payload.segments,
        worldTime: "停战纪元17年 · 雾月12日 · 入夜",
        visibility: "public",
        status: "committed",
        createdAt: event.committedAt,
      })),
    );
    return baseProjection(events);
  }
  const projection = {
    async loadRecentAuthorizedEvents() {
      return [];
    },
    async loadForPlayer() {
      return loadProjection();
    },
    async loadDeliveryForPlayer() {
      return {
        record: await loadProjection(),
        viewer: {
          cursor: "viewer-local" as const,
          perspective: "omniscient" as const,
          dynamicKnowledgeVisible: true,
          characterInstanceId: null,
          membershipRole: "owner" as const,
        },
      };
    },
  };
  const tokens = createMemoryWriteTokenRegistry({
    randomToken: () => `opaque-${++tokenSequence}`,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
  });
  const service = createLocalRecordService({
    repository,
    projection,
    tokens,
    clock: () => new Date("2026-08-13T02:00:00.000Z"),
    idFactory: () => `local-${++idSequence}`,
    actionCatalog,
  });
  return { repository, service };
}

test("an expired affordance fails closed without consuming the write authorization", async () => {
  let calls = 0;
  const catalog: ActionAffordanceCatalog = {
    async listAuthorized(scope) {
      calls += 1;
      return calls === 1
        ? [{
            id: "asset.signal_lantern",
            kind: "asset",
            actorCharacterInstanceId: scope.characterInstanceId,
            actorName: "洛川",
            title: "雾港信号灯",
            description: "剩余 1 次",
            suggestedText: "我点亮信号灯。",
          }]
        : [];
    },
  };
  const { service } = createFixture(catalog);
  const initial = await service.loadRecord();
  assert.equal(initial.affordances[0]?.id, "asset.signal_lantern");
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "我点亮信号灯。",
      idempotencyKey: "expired-affordance",
      writeToken: initial.writeToken,
      actionSelection: { affordanceId: "asset.signal_lantern" },
    }),
    (error: unknown) =>
      error instanceof LocalRecordServiceError
      && error.code === "INVALID_ACTION_SELECTION",
  );
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "我先不使用物品，只观察眼前。",
    idempotencyKey: "same-token-after-expiry",
    writeToken: initial.writeToken,
  });
  assert.equal(committed.disposition, "committed");
});

test("message route returns a safe stage diagnostic instead of collapsing every failure into security text", async () => {
  const diagnostic = {
    stage: "drafting" as const,
    code: "CHARACTER_ACTION_INVALID",
    message: "角色行动没有通过结构化字段校验。",
    disposition: "failed" as const,
    attempt: 1,
  };
  const failingService = {
    async submitMessage() {
      throw new LocalRecordServiceError(
        "TURN_FAILED",
        "本轮在「内容生成」阶段未完成（CHARACTER_ACTION_INVALID）：角色行动没有通过结构化字段校验。",
        undefined,
        undefined,
        diagnostic,
      );
    },
  } as unknown as LocalRecordService;
  const response = await handleMessagePost(
    new Request("http://localhost/api/record/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordId: LOCAL_RECORD_SCOPE.recordId,
        content: "检查浓雾。",
        clientMessageId: "diagnostic-message",
        writeToken: "opaque-write-token",
      }),
    }),
    failingService,
  );
  assert.equal(response.status, 422);
  const body = await response.json() as {
    error: {
      code: string;
      message: string;
      diagnostic?: { stage?: string; code?: string; message?: string };
    };
  };
  assert.equal(body.error.code, "TURN_FAILED");
  assert.match(body.error.message, /内容生成/);
  assert.match(body.error.message, /CHARACTER_ACTION_INVALID/);
  assert.deepEqual(body.error.diagnostic, diagnostic);
  assert.doesNotMatch(JSON.stringify(body), /api[_-]?key|password|authorization/i);
});

test("the Application Service commits player and validated reply atomically and replays idempotently", async () => {
  const { repository, service } = createFixture();
  const initial = await service.loadRecord();
  assert.equal(initial.writeToken, "opaque-1");
  assert.equal(initial.record.version, 1);
  assert.deepEqual(initial.affordances.map((item) => item.kind), ["skill", "scene"]);
  assert.equal(JSON.stringify(initial).includes("canonicalVersion"), false);

  const input = {
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "检查信函的蜡封。",
    idempotencyKey: "message-1",
    writeToken: initial.writeToken,
  };
  const committed = await service.submitMessage(input);
  assert.equal(committed.disposition, "committed");
  assert.equal(committed.record.events.length, 4);
  assert.deepEqual(
    committed.record.events.slice(-3).map((event) => event.role),
    ["player", "narrator", "character"],
  );
  assert.deepEqual(
    committed.record.events.at(-1)?.segments.map((segment) => segment.kind),
    ["action"],
  );
  assert.equal(
    committed.record.events.at(-1)?.segments.map((segment) => segment.content).join("\n"),
    committed.record.events.at(-1)?.content,
  );
  assert.equal(
    committed.record.events.at(-1)?.segments.find((segment) => segment.kind === "action")?.content,
    "塞娜沿着防波堤确认周围的变化。",
  );
  assert.equal(
    committed.record.events.at(-1)?.segments.some((segment) => segment.kind === "dialogue"),
    false,
  );
  const formalEvents = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  assert.equal(formalEvents.length, 4);
  assert.equal(formalEvents[1]?.kind, "action.transaction.committed");
  assert.equal(formalEvents[1]?.payload.actionTransaction?.origin, "character");
  assert.equal(formalEvents[1]?.payload.actionTransaction?.call.name, "act");
  assert.equal(formalEvents[1]?.payload.actionTransaction?.receipt.resolution, "automatic");
  assert.equal(formalEvents[2]?.kind, "narration.committed");
  assert.equal((await repository.listOutboxMessages()).length, 1);

  const replay = await service.submitMessage(input);
  assert.equal(replay.disposition, "duplicate");
  assert.equal((await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId)).length, 4);
  assert.equal((await repository.listOutboxMessages()).length, 1);
  assert.equal(JSON.stringify(replay).includes("candidate"), false);
  assert.equal(JSON.stringify(replay).includes("manifest"), false);
  assert.equal(JSON.stringify(replay).includes("actionTransaction"), false);
});

test("selected action affordances resolve as player-owned transactions and forged ids fail closed", async () => {
  const { repository, service } = createFixture();
  const initial = await service.loadRecord();
  const selected = initial.affordances.find((item) => item.kind === "skill");
  assert.ok(selected);
  const committed = await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: selected.suggestedText,
    idempotencyKey: "selected-player-skill",
    writeToken: initial.writeToken,
    actionSelection: { affordanceId: selected.id },
  });
  assert.equal(committed.record.events.length, 4);
  const formalEvents = await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId);
  const transactions = formalEvents
    .filter((event) => event.kind === "action.transaction.committed")
    .map((event) => event.payload.actionTransaction);
  assert.equal(transactions.length, 2);
  assert.equal(transactions[0]?.actor.characterInstanceId, "char_inst_player");
  assert.equal(transactions[0]?.call.name, "use_skill");
  assert.equal(transactions[0]?.call.arguments.targetId, "letter_seal");
  assert.equal(transactions[1]?.actor.characterInstanceId, "char_inst_scout");

  const current = await service.loadRecord();
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "伪造一个不存在的技能。",
      idempotencyKey: "forged-player-skill",
      writeToken: current.writeToken,
      actionSelection: { affordanceId: "skill.admin_override" },
    }),
    (error: unknown) =>
      error instanceof LocalRecordServiceError
      && error.code === "INVALID_ACTION_SELECTION",
  );
  assert.equal((await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId)).length, 5);
});

test("write tokens bind a canonical snapshot without exposing or trusting a viewer version", async () => {
  const { service } = createFixture();
  const first = await service.loadRecord();
  const concurrent = await service.loadRecord();
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "先检查四周。",
    idempotencyKey: "winner",
    writeToken: first.writeToken,
  });
  await assert.rejects(
    service.submitMessage({
      recordId: LOCAL_RECORD_SCOPE.recordId,
      content: "打开信函。",
      idempotencyKey: "stale-writer",
      writeToken: concurrent.writeToken,
    }),
    (error: unknown) =>
      error instanceof LocalRecordServiceError
      && error.code === "WRITE_CONFLICT"
      && error.currentVersion === 4,
  );
});

test("the formal PostgreSQL mapper emits deterministic direct observations", () => {
  const mapped = mapLocalFormalEvent({
    draft: {
      eventId: "event-1",
      kind: "utterance.committed",
      payload: {
        schemaVersion: 1,
        role: "player",
        speaker: "洛川",
        participantId: "participant_player",
        content: "保持安静。",
        segments: fallbackSemanticSegments("保持安静。", "action"),
        suggestions: ["检查入口"],
      },
    },
    run: {
      turnId: "turn-1",
      command: {
        commandType: "player.utterance",
        recordId: LOCAL_RECORD_SCOPE.recordId,
        expectedRecordVersion: 1,
        idempotencyKey: "message-1",
        actorId: "participant_player",
        payload: { text: "保持安静。", visibility: { kind: "public" } },
      },
      commandFingerprint: "fingerprint",
      state: "releasing",
      revision: 7,
      attempts: { planning: 1, drafting: 1, validating: 1, releasing: 1 },
      failures: [],
      transitions: [],
      acceptedAt: "2026-08-13T02:00:00.000Z",
      updatedAt: "2026-08-13T02:00:00.000Z",
    },
    eventIndex: 0,
    recordVersion: 2,
    recordOrdinal: 2,
    worldCursor: {
      tick: 17_121_219,
      ordinal: 2,
      calendarId: "truce_calendar",
      display: "停战纪元17年 · 雾月12日 · 入夜",
    },
    committedAt: "2026-08-13T02:00:00.000Z",
  });
  assert.equal(mapped.visibilityPolicyId, "visibility_public_v1");
  assert.deepEqual(
    (mapped.metadata?.presentation as { segments?: unknown[] }).segments,
    fallbackSemanticSegments("保持安静。", "action"),
  );
  assert.deepEqual(mapped.metadata?.suggestions, ["检查入口"]);
  assert.equal(mapped.observations?.length, 3);
  assert.deepEqual(
    mapped.observations?.map((observation) => observation.observationId),
    [
      "event-1:observed:char_inst_player",
      "event-1:observed:char_inst_scout",
      "event-1:observed:char_inst_scholar",
    ],
  );
});

test("the formal mapper creates a restricted policy and hides non-audience observations", () => {
  const mapped = mapLocalFormalEvent({
    draft: {
      eventId: "event-secret",
      kind: "utterance.committed",
      payload: {
        schemaVersion: 1,
        role: "player",
        speaker: "洛川",
        participantId: "participant_player",
        content: "不要让其他人听到。",
        segments: fallbackSemanticSegments("不要让其他人听到。", "dialogue"),
      },
    },
    run: {
      turnId: "turn-secret",
      command: {
        commandType: "player.utterance",
        recordId: LOCAL_RECORD_SCOPE.recordId,
        expectedRecordVersion: 1,
        idempotencyKey: "secret-message",
        actorId: "participant_player",
        payload: {
          text: "不要让其他人听到。",
          visibility: {
            kind: "restricted",
            domainId: "secret:player:scout",
            audienceCharacterInstanceIds: [
              "char_inst_player",
              "char_inst_scout",
            ],
          },
        },
      },
      plan: {
        planId: "plan-secret",
        body: {
          goal: "只让塞娜听见",
          constraints: [],
          activatedCharacters: [],
          narratorEnabled: false,
          actionBudgetPerCharacter: 0,
          visibility: {
            kind: "restricted",
            domainId: "secret:player:scout",
            audienceCharacterInstanceIds: [
              "char_inst_player",
              "char_inst_scout",
            ],
          },
        },
        createdAt: "2026-08-13T02:00:00.000Z",
      },
      commandFingerprint: "fingerprint",
      state: "releasing",
      revision: 7,
      attempts: { planning: 1, drafting: 1, validating: 1, releasing: 1 },
      failures: [],
      transitions: [],
      acceptedAt: "2026-08-13T02:00:00.000Z",
      updatedAt: "2026-08-13T02:00:00.000Z",
    },
    eventIndex: 0,
    recordVersion: 2,
    recordOrdinal: 2,
    worldCursor: {
      tick: 17_121_219,
      ordinal: 2,
      calendarId: "truce_calendar",
      display: "停战纪元17年 · 雾月12日 · 入夜",
    },
    committedAt: "2026-08-13T02:00:00.000Z",
  });
  assert.equal(mapped.visibilityPolicyId, "visibility_secret_turn-secret");
  assert.equal(mapped.visibilityPolicy?.kind, "restricted");
  assert.deepEqual(
    mapped.visibilityPolicy?.audienceCharacterInstanceIds,
    ["char_inst_player", "char_inst_scout"],
  );
  assert.equal(mapped.observations?.length, 2);
  assert.deepEqual(
    mapped.observations?.map((observation) => observation.observerCharacterInstanceId),
    ["char_inst_player", "char_inst_scout"],
  );
});

test("the formal mapper does not invent a private observation for ordinary act", async () => {
  const { repository, service } = createFixture();
  const initial = await service.loadRecord();
  await service.submitMessage({
    recordId: LOCAL_RECORD_SCOPE.recordId,
    content: "看看信使离开的方向。",
    idempotencyKey: "private-receipt",
    writeToken: initial.writeToken,
  });
  const event = (await repository.listCommittedEvents(LOCAL_RECORD_SCOPE.recordId))[1];
  assert.equal(event?.kind, "action.transaction.committed");
  if (!event) assert.fail("Expected a committed Action Transaction.");
  const mapped = mapLocalFormalEvent({
    draft: { eventId: event.eventId, kind: event.kind, payload: event.payload },
    run: (await repository.loadTurn(event.turnId))!,
    eventIndex: 1,
    recordVersion: 2,
    recordOrdinal: 3,
    worldCursor: {
      tick: 17_121_219,
      ordinal: 3,
      calendarId: "truce_calendar",
      display: "停战纪元17年 · 雾月12日 · 入夜",
    },
    committedAt: event.committedAt,
  });
  assert.deepEqual(
    mapped.observations?.map((observation) => observation.observerCharacterInstanceId),
    [],
  );
});

test("GET and POST routes expose only the Application Service envelope", async () => {
  const { service } = createFixture();
  const getResponse = await handleRecordGet(
    new Request(`http://localhost/api/record?recordId=${LOCAL_RECORD_SCOPE.recordId}`),
    service,
  );
  assert.equal(getResponse.status, 200);
  const loaded = await getResponse.json() as { writeToken: string };
  assert.equal(loaded.writeToken, "opaque-1");

  const first = await post(service, loaded.writeToken, "route-message");
  assert.equal(first.status, 201);
  const duplicate = await post(service, loaded.writeToken, "route-message");
  assert.equal(duplicate.status, 200);
  const payload = await duplicate.text();
  assert.equal(payload.includes("candidate"), false);
  assert.equal(payload.includes("contextManifest"), false);
});

test("default entry without account memory returns the onboarding signal", async () => {
  const { service } = createFixture();
  const getResponse = await handleRecordGet(
    new Request("http://localhost/api/record"),
    service,
  );
  assert.equal(getResponse.status, 200);
  const body = (await getResponse.json()) as {
    ok: boolean;
    onboarding?: boolean;
    writeToken?: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.onboarding, true);
  assert.equal(body.writeToken, undefined);
});

test("committed SSE replays only projected events and honors viewer-local cursors", async () => {
  const event = openingEvent();
  const service: LocalRecordService = {
    async loadRecord() {
      throw new Error("not used");
    },
    async openDefaultRecord() {
      throw new Error("not used");
    },
    async submitMessage() {
      throw new Error("not used");
    },
    async startSelfPlay() {
      throw new Error("not used");
    },
    async stopSelfPlay() {
      throw new Error("not used");
    },
    async listCommittedEvents(_recordId: string, afterOrdinal: number) {
      return event.ordinal > afterOrdinal ? [event] : [];
    },
    async authorizeRecordViewer() {},
    cancelMessage() {
      return false;
    },
    subscribePreviews() {
      return () => {};
    },
  };
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    new AbortController().signal,
    { maxPolls: 1, heartbeatIntervalMs: Number.POSITIVE_INFINITY },
  );
  const text = await new Response(stream).text();
  assert.match(text, /^id: 1\nevent: committed\ndata: /);
  assert.match(text, /"status":"committed"/);
  assert.doesNotMatch(text, /candidate|manifest|token/i);

  const replay = handleCommittedEventsGet(
    new Request("http://localhost/api/record/events?afterOrdinal=1"),
    service,
    { maxPolls: 1 },
  );
  assert.equal(await replay.text(), "");
  const headerReplay = handleCommittedEventsGet(
    new Request("http://localhost/api/record/events", {
      headers: { "Last-Event-ID": "1" },
    }),
    service,
    { maxPolls: 1 },
  );
  assert.equal(await headerReplay.text(), "");
  const reconnectReplay = handleCommittedEventsGet(
    new Request("http://localhost/api/record/events?afterOrdinal=0", {
      headers: { "Last-Event-ID": "1" },
    }),
    service,
    { maxPolls: 1 },
  );
  assert.equal(await reconnectReplay.text(), "");
  const invalid = handleCommittedEventsGet(
    new Request("http://localhost/api/record/events?afterOrdinal=-1"),
    service,
  );
  assert.equal(invalid.status, 400);
});

test("SSE cancellation stops projection polling immediately", async () => {
  let calls = 0;
  const service: LocalRecordService = {
    async loadRecord() { throw new Error("not used"); },
    async openDefaultRecord() { throw new Error("not used"); },
    async submitMessage() { throw new Error("not used"); },
    async startSelfPlay() { throw new Error("not used"); },
    async stopSelfPlay() { throw new Error("not used"); },
    async listCommittedEvents() {
      calls += 1;
      return [];
    },
    async authorizeRecordViewer() {},
    cancelMessage() {
      return false;
    },
    subscribePreviews() {
      return () => {};
    },
  };
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    new AbortController().signal,
    { pollIntervalMs: 5, maxPolls: 100 },
  );
  const reader = stream.getReader();
  await new Promise((resolve) => setTimeout(resolve, 1));
  await reader.cancel();
  const callsAtCancel = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, callsAtCancel);
});

test("SSE request abort stops projection polling", async () => {
  let calls = 0;
  const service: LocalRecordService = {
    async loadRecord() { throw new Error("not used"); },
    async openDefaultRecord() { throw new Error("not used"); },
    async submitMessage() { throw new Error("not used"); },
    async startSelfPlay() { throw new Error("not used"); },
    async stopSelfPlay() { throw new Error("not used"); },
    async listCommittedEvents() {
      calls += 1;
      return [];
    },
    async authorizeRecordViewer() {},
    cancelMessage() {
      return false;
    },
    subscribePreviews() {
      return () => {};
    },
  };
  const abort = new AbortController();
  const stream = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
    { pollIntervalMs: 5, maxPolls: 100 },
  );
  const reader = stream.getReader();
  await new Promise((resolve) => setTimeout(resolve, 1));
  abort.abort();
  assert.equal((await reader.read()).done, true);
  const callsAtAbort = calls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, callsAtAbort);
});

test("SSE does not poll when the request was already aborted", async () => {
  let calls = 0;
  const service: LocalRecordService = {
    async loadRecord() { throw new Error("not used"); },
    async openDefaultRecord() { throw new Error("not used"); },
    async submitMessage() { throw new Error("not used"); },
    async startSelfPlay() { throw new Error("not used"); },
    async stopSelfPlay() { throw new Error("not used"); },
    async listCommittedEvents() {
      calls += 1;
      return [];
    },
    async authorizeRecordViewer() {},
    cancelMessage() {
      return false;
    },
    subscribePreviews() {
      return () => {};
    },
  };
  const abort = new AbortController();
  abort.abort();
  const reader = createCommittedEventStream(
    service,
    LOCAL_RECORD_SCOPE.recordId,
    0,
    abort.signal,
  ).getReader();
  assert.equal((await reader.read()).done, true);
  assert.equal(calls, 0);
});

async function post(
  service: LocalRecordService,
  writeToken: string,
  idempotencyKey: string,
): Promise<Response> {
  return handleMessagePost(
    new Request("http://localhost/api/record/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recordId: LOCAL_RECORD_SCOPE.recordId,
        content: "确认信函。",
        clientMessageId: idempotencyKey,
        writeToken,
        expectedVersion: 999_999,
        workspaceId: "attacker-workspace",
        principalId: "attacker-principal",
      }),
    }),
    service,
  );
}

function openingEvent(): ProjectionEvent {
  return {
    id: "event_opening",
    ordinal: 1,
    type: "narration",
    speaker: "旁白",
    speakerParticipantId: null,
    role: "narrator",
    content: "雾沿着石阶爬上防波堤。",
    segments: fallbackSemanticSegments("雾沿着石阶爬上防波堤。", "environment"),
    worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    visibility: "public",
    status: "committed",
    createdAt: "2026-08-13T01:00:00.000Z",
  };
}

function baseProjection(events: ProjectionEvent[]): RecordProjection {
  const cast: RecordProjection["cast"] = [
    {
      id: "char_def_player",
      participantId: "participant_player",
      characterInstanceId: "char_inst_player",
      name: "洛川",
      role: "人类使节",
      summary: "停战议会派来的年轻调停人。",
      status: "present",
      controlledBy: "human",
      isActive: true,
    },
  ];
  return {
    id: LOCAL_RECORD_SCOPE.recordId,
    version: events.length,
    world: {
      id: "world_ember_coast",
      name: "烬海诸国",
      era: "停战纪元17年",
      summary: "人魔停战十七年后。",
      timeCursor: "停战纪元17年 · 雾月12日 · 入夜",
      style: "classical",
      language: "zh-CN",
    },
    story: {
      id: "story_silent_bell",
      title: "无声钟的来客",
      status: "active",
      premise: "一封密函被送上岸。",
    },
    record: {
      id: LOCAL_RECORD_SCOPE.recordId,
      title: "第一幕 · 雾港来信",
      status: "active",
      version: events.length,
      location: "灰鲸港 · 北防波堤",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
    },
    scene: {
      location: "灰鲸港 · 北防波堤",
      worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      weather: "冷雾，无风",
      tension: "钟声已经响过三次",
      objective: "决定是否拆开密函",
    },
    cast,
    participants: cast,
    events,
    stories: [
      { id: "story_silent_bell", title: "无声钟的来客", status: "active" },
    ],
    records: [
      {
        id: LOCAL_RECORD_SCOPE.recordId,
        title: "第一幕 · 雾港来信",
        status: "active",
        worldTime: "停战纪元17年 · 雾月12日 · 入夜",
      },
    ],
  };
}
