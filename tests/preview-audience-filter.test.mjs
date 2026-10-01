import assert from "node:assert/strict";
import test from "node:test";
import { handlePreviewGet } from "../app/api/record/preview/route.ts";
import { createSessionValue } from "../modules/identity/auth.ts";
import {
  createLocalPreviewHub,
  createLocalRecordService,
  createMemoryWriteTokenRegistry,
  LOCAL_RECORD_SCOPE,
} from "../modules/application/local-record-service.ts";
import { createInMemoryRuntimeRepository } from "../modules/runtime/public.ts";

function sessionCookie(principalId) {
  return `realm_session=${createSessionValue(principalId)}`;
}

async function withSessionGate(run) {
  const saved = process.env.REALM_RUNTIME_DATABASE_URL;
  process.env.REALM_RUNTIME_DATABASE_URL = "postgresql://realm_runtime@127.0.0.1:5432/realm";
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env.REALM_RUNTIME_DATABASE_URL;
    else process.env.REALM_RUNTIME_DATABASE_URL = saved;
  }
}

test("restricted preview sends chunks and end metadata only to audience-bound viewers", () => {
  const hub = createLocalPreviewHub();
  const audienceEvents = [];
  const bystanderEvents = [];
  const unboundEvents = [];
  hub.subscribe("record", (event) => audienceEvents.push(event), "char_audience");
  hub.subscribe("record", (event) => bystanderEvents.push(event), "char_bystander");
  hub.subscribe("record", (event) => unboundEvents.push(event));

  hub.begin("record", "preview-private", new AbortController().signal, {
    kind: "restricted",
    domainId: "pair:secret-conversation",
    audienceCharacterInstanceIds: ["char_audience"],
  });
  hub.publishChunk("record", "塞娜", "只供收件人查看的预览");
  hub.end("record", "committed");

  assert.deepEqual(audienceEvents.map((event) => event.kind), ["chunk", "end"]);
  assert.deepEqual(bystanderEvents, [], "restricted text and end metadata must not leak");
  assert.deepEqual(unboundEvents, [], "missing server-derived viewer identity must fail closed");
});

test("public preview remains visible to authorized viewers without character binding", () => {
  const hub = createLocalPreviewHub();
  const memberEvents = [];
  const legacyMemberEvents = [];
  hub.subscribe("record", (event) => memberEvents.push(event), "char_member");
  hub.subscribe("record", (event) => legacyMemberEvents.push(event));
  hub.begin("record", "preview-public", new AbortController().signal, { kind: "public" });
  hub.publishChunk("record", "旁白", "公开场景预览");
  hub.end("record", "committed");
  assert.deepEqual(memberEvents.map((event) => event.kind), ["chunk", "end"]);
  assert.deepEqual(legacyMemberEvents.map((event) => event.kind), ["chunk", "end"]);
});

test("record service derives restricted-preview viewer identities only from each principal-bound scope", async () => {
  const hub = createLocalPreviewHub();
  const explicitViewerIds = {
    principal_audience: "char_audience",
    principal_bystander: "char_bystander",
  };
  const members = new Set([
    "principal_audience",
    "principal_bystander",
    "principal_legacy_member",
  ]);
  const service = createLocalRecordService({
    repository: createInMemoryRuntimeRepository({
      recordHeads: [{ recordId: LOCAL_RECORD_SCOPE.recordId, version: 1, nextOrdinal: 2 }],
    }),
    projection: {
      async hasViewerProjection({ principalId }) {
        return members.has(principalId);
      },
    },
    tokens: createMemoryWriteTokenRegistry(),
    runtimeScopeProvider: {
      async resolveViewerCharacterInstanceId({ principalId }) {
        return explicitViewerIds[principalId] ?? null;
      },
      async resolve({ workspaceId, principalId, recordId }) {
        return {
          workspaceId,
          principalId,
          recordId,
          // The legacy member deliberately has only the generic fallback actor.
          viewerCharacterInstanceId: explicitViewerIds[principalId],
        };
      },
    },
    previewHub: hub,
  });

  const audienceViewer = await service.authorizeRecordViewer(
    LOCAL_RECORD_SCOPE.recordId,
    "principal_audience",
  );
  const bystanderViewer = await service.authorizeRecordViewer(
    LOCAL_RECORD_SCOPE.recordId,
    "principal_bystander",
  );
  const legacyViewer = await service.authorizeRecordViewer(
    LOCAL_RECORD_SCOPE.recordId,
    "principal_legacy_member",
  );
  assert.equal(audienceViewer, "char_audience");
  assert.equal(bystanderViewer, "char_bystander");
  assert.equal(legacyViewer, undefined, "generic fallback actors are not restricted-preview identities");

  const audienceEvents = [];
  const bystanderEvents = [];
  const legacyEvents = [];
  service.subscribePreviews(LOCAL_RECORD_SCOPE.recordId, (event) => audienceEvents.push(event), audienceViewer);
  service.subscribePreviews(LOCAL_RECORD_SCOPE.recordId, (event) => bystanderEvents.push(event), bystanderViewer);
  service.subscribePreviews(LOCAL_RECORD_SCOPE.recordId, (event) => legacyEvents.push(event), legacyViewer);
  hub.begin(LOCAL_RECORD_SCOPE.recordId, "preview-private", new AbortController().signal, {
    kind: "restricted",
    domainId: "pair:secret-conversation",
    audienceCharacterInstanceIds: ["char_audience"],
  });
  hub.publishChunk(LOCAL_RECORD_SCOPE.recordId, "塞娜", "只有指定收件人可见");
  hub.end(LOCAL_RECORD_SCOPE.recordId, "committed");

  assert.deepEqual(audienceEvents.map((event) => event.kind), ["chunk", "end"]);
  assert.deepEqual(bystanderEvents, []);
  assert.deepEqual(legacyEvents, []);
});

test("preview route forwards only the server-authorized viewer identity, never query identity", async () => {
  await withSessionGate(async () => {
    const authenticatedPrincipal = "principal_authenticated";
    const authorizedViewerCharacter = "char_from_server_scope";
    const observations = { authorizedPrincipal: null, subscribedViewer: null };
    const service = {
      async authorizeRecordViewer(recordId, principalId) {
        observations.authorizedPrincipal = principalId;
        assert.equal(recordId, LOCAL_RECORD_SCOPE.recordId);
        return authorizedViewerCharacter;
      },
      subscribePreviews(recordId, _listener, viewerCharacterInstanceId) {
        assert.equal(recordId, LOCAL_RECORD_SCOPE.recordId);
        observations.subscribedViewer = viewerCharacterInstanceId;
        return () => {};
      },
    };
    const controller = new AbortController();
    try {
      const response = await handlePreviewGet(
        new Request(
          `http://localhost/api/record/preview?recordId=${LOCAL_RECORD_SCOPE.recordId}`
            + "&principalId=principal_attacker&viewerCharacterInstanceId=char_attacker",
          {
            headers: { cookie: sessionCookie(authenticatedPrincipal) },
            signal: controller.signal,
          },
        ),
        service,
      );
      assert.equal(response.status, 200);
      assert.equal(observations.authorizedPrincipal, authenticatedPrincipal);
      assert.equal(observations.subscribedViewer, authorizedViewerCharacter);
      controller.abort();
      await response.body?.cancel().catch(() => {});
    } finally {
      controller.abort();
    }
  });
});
