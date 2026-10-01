import assert from "node:assert/strict";
import test from "node:test";
import { cancelActiveTurn } from "../modules/application/local-record-service.ts";

test("cancel only aborts a controller owned by the requested Record", () => {
  const signals = new Map<string, { recordId: string; controller: AbortController }>();
  const controller = new AbortController();
  signals.set("same-client-key", { recordId: "record-owner", controller });

  assert.equal(cancelActiveTurn(signals, "record-other", "same-client-key"), false);
  assert.equal(controller.signal.aborted, false);

  assert.equal(cancelActiveTurn(signals, "record-owner", "same-client-key"), true);
  assert.equal(controller.signal.aborted, true);
});

test("cancel returns false for an unknown key", () => {
  const signals = new Map<string, { recordId: string; controller: AbortController }>();
  assert.equal(cancelActiveTurn(signals, "record-owner", "unknown"), false);
});

