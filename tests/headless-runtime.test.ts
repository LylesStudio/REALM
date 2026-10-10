import assert from "node:assert/strict";
import test from "node:test";
import {
  createHeadlessRuntime,
  HeadlessRuntimeError,
  type HeadlessRuntimeScope,
} from "../modules/runtime/headless-runtime.ts";
import type { LocalRecordService } from "../modules/application/local-record-service.ts";
import type { WorldBinding } from "../modules/world-transfer/realm-save.ts";

function scope(): HeadlessRuntimeScope {
  return {
    workspaceId: "workspace-headless",
    principalId: "principal-headless",
    recordId: "record-headless",
    worldId: "world-headless",
    worldlineId: "worldline-headless",
    worldBinding: { kind: "world", worldId: "world-headless", worldVersion: "1.0.0" },
  };
}

test("headless runtime pins an authorized WorldBinding and dispatches record commands", async () => {
  const calls: unknown[] = [];
  const service = {
    async loadRecord(recordId?: string, principalId?: string) {
      calls.push(["load", recordId, principalId]);
      return { kind: "record", recordId };
    },
    async listCommittedEvents(recordId: string, afterOrdinal: number, principalId?: string) {
      calls.push(["events", recordId, afterOrdinal, principalId]);
      return [{ recordId, afterOrdinal }];
    },
    async submitMessage(input: { recordId: string; principalId?: string; content: string; idempotencyKey: string; writeToken: string }) {
      calls.push(["submit", input]);
      return { disposition: "committed", recordId: input.recordId };
    },
    async startSelfPlay(recordId: string, principalId?: string) {
      calls.push(["startSelfPlay", recordId, principalId]);
      return { recordId, state: "running" };
    },
    async stopSelfPlay(recordId: string, principalId?: string) {
      calls.push(["stopSelfPlay", recordId, principalId]);
      return { recordId, state: "cancelled" };
    },
  } as unknown as Pick<
    LocalRecordService,
    "loadRecord" | "listCommittedEvents" | "submitMessage" | "startSelfPlay" | "stopSelfPlay"
  >;
  const runtime = createHeadlessRuntime({
    scopeResolver: { resolve: async () => scope() },
    service,
    scope: {
      workspaceId: "workspace-headless",
      principalId: "principal-headless",
      recordId: "record-headless",
    },
    contentResolver: {
      resolve: async (binding: WorldBinding) => ({ binding, source: "fixture" }),
    },
  });

  assert.equal(runtime.lifecycle, "created");
  assert.equal(runtime.worldBinding, null);
  await assert.rejects(
    () => runtime.execute({ kind: "load" }),
    (error: unknown) => error instanceof HeadlessRuntimeError && error.code === "HEADLESS_NOT_STARTED",
  );

  const started = await runtime.start();
  assert.equal(started.lifecycle, "running");
  assert.deepEqual(started.worldBinding, scope().worldBinding);
  assert.deepEqual(runtime.worldBinding, scope().worldBinding);
  assert.deepEqual(runtime.worldContent, { binding: scope().worldBinding, source: "fixture" });
  assert.deepEqual(await runtime.start(), started);

  assert.deepEqual(await runtime.execute({ kind: "load" }), {
    kind: "record",
    value: { kind: "record", recordId: "record-headless" },
  });
  assert.deepEqual(await runtime.execute({ kind: "events", afterOrdinal: 7 }), {
    kind: "events",
    value: [{ recordId: "record-headless", afterOrdinal: 7 }],
  });
  assert.deepEqual(await runtime.execute({
    kind: "submit",
    content: "continue",
    idempotencyKey: "headless-1",
    writeToken: "write-token",
  }), {
    kind: "submit",
    value: { disposition: "committed", recordId: "record-headless" },
  });
  assert.deepEqual(await runtime.execute({ kind: "startSelfPlay" }), {
    kind: "startSelfPlay",
    value: { recordId: "record-headless", state: "running" },
  });
  assert.deepEqual(await runtime.execute({ kind: "stopSelfPlay" }), {
    kind: "stopSelfPlay",
    value: { recordId: "record-headless", state: "cancelled" },
  });
  assert.deepEqual(calls, [
    ["load", "record-headless", "principal-headless"],
    ["events", "record-headless", 7, "principal-headless"],
    ["submit", {
      recordId: "record-headless",
      principalId: "principal-headless",
      content: "continue",
      idempotencyKey: "headless-1",
      writeToken: "write-token",
    }],
    ["startSelfPlay", "record-headless", "principal-headless"],
    ["stopSelfPlay", "record-headless", "principal-headless"],
  ]);

  await runtime.stop();
  assert.equal(runtime.lifecycle, "stopped");
  assert.equal(runtime.worldBinding, null);
  assert.equal(runtime.worldContent, null);
  await assert.rejects(
    () => runtime.execute({ kind: "load" }),
    (error: unknown) => error instanceof HeadlessRuntimeError && error.code === "HEADLESS_STOPPED",
  );
  await assert.rejects(
    () => runtime.start(),
    (error: unknown) => error instanceof HeadlessRuntimeError && error.code === "HEADLESS_STOPPED",
  );
});

test("headless runtime refuses to start without an authorized persisted scope", async () => {
  const service = {
    loadRecord: async () => null,
    listCommittedEvents: async () => [],
    submitMessage: async () => null,
    startSelfPlay: async () => null,
    stopSelfPlay: async () => null,
  } as unknown as Pick<
    LocalRecordService,
    "loadRecord" | "listCommittedEvents" | "submitMessage" | "startSelfPlay" | "stopSelfPlay"
  >;
  const runtime = createHeadlessRuntime({
    scopeResolver: { resolve: async () => null },
    service,
    scope: {
      workspaceId: "workspace-headless",
      principalId: "principal-headless",
      recordId: "record-headless",
    },
  });
  await assert.rejects(
    () => runtime.start(),
    (error: unknown) => error instanceof HeadlessRuntimeError && error.code === "HEADLESS_SCOPE_UNAVAILABLE",
  );
  assert.equal(runtime.lifecycle, "created");
});

test("headless runtime rejects a world binding without mounted content", async () => {
  const service = {
    loadRecord: async () => null,
    listCommittedEvents: async () => [],
    submitMessage: async () => null,
    startSelfPlay: async () => null,
    stopSelfPlay: async () => null,
  } as unknown as Pick<
    LocalRecordService,
    "loadRecord" | "listCommittedEvents" | "submitMessage" | "startSelfPlay" | "stopSelfPlay"
  >;
  const runtime = createHeadlessRuntime({
    scopeResolver: { resolve: async () => scope() },
    service,
    scope: {
      workspaceId: "workspace-headless",
      principalId: "principal-headless",
      recordId: "record-headless",
    },
  });
  await assert.rejects(
    () => runtime.start(),
    (error: unknown) => error instanceof HeadlessRuntimeError
      && (error as HeadlessRuntimeError).code === "HEADLESS_CONTENT_UNAVAILABLE",
  );
  assert.equal(runtime.lifecycle, "created");
});
