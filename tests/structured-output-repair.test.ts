import assert from "node:assert/strict";
import test from "node:test";
import {
  requestStructuredObject,
  type StructuredOutputLogEvent,
} from "../modules/inference/structured-output.ts";

const SCHEMA = "Schema: {name: string (<= 40 chars), mood: \"calm\" | \"stormy\"}";

function normalize(body: Record<string, unknown>): { name: string; mood: string } | null {
  if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 40) return null;
  if (body.mood !== "calm" && body.mood !== "stormy") return null;
  return { name: body.name.trim(), mood: body.mood };
}

function fakeCall(script: string[]): {
  call: (messages: readonly { role: "system" | "user" | "assistant"; content: string }[]) => Promise<{ content: string; model: string }>;
  seen: { role: string; content: string }[][];
} {
  const seen: { role: string; content: string }[][] = [];
  return {
    seen,
    call: async (messages) => {
      seen.push(messages.map((message) => ({ role: message.role, content: message.content })));
      const content = script.shift();
      if (content === undefined) throw new Error("unexpected extra call");
      return { content, model: "fake-model" };
    },
  };
}

const MESSAGES = [
  { role: "system" as const, content: "You are a test policy." },
  { role: "user" as const, content: "[input]\nhello" },
];

test("first-try success performs zero repair calls", async () => {
  const { call, seen } = fakeCall(['{"name":"Aster","mood":"calm"}']);
  const result = await requestStructuredObject({
    call, messages: MESSAGES, normalize, schemaInstruction: SCHEMA, code: "TEST_INVALID",
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(result?.value, { name: "Aster", mood: "calm" });
  assert.equal(result?.repaired, false);
});

test("unparseable first response triggers exactly one repair with English feedback", async () => {
  const { call, seen } = fakeCall([
    "let me think... not json at all",
    '{"name":"Aster","mood":"stormy"}',
  ]);
  const logs: StructuredOutputLogEvent[] = [];
  const result = await requestStructuredObject({
    call, messages: MESSAGES, normalize, schemaInstruction: SCHEMA, code: "TEST_INVALID",
    onLog: (event) => logs.push(event),
  });
  assert.equal(seen.length, 2, "恰好一次 repair");
  assert.equal(result?.repaired, true);
  assert.deepEqual(result?.value, { name: "Aster", mood: "stormy" });
  const repairMessage = seen[1]!.at(-1)!;
  assert.equal(repairMessage.role, "user");
  assert.match(repairMessage.content, /could not be used/);
  assert.match(repairMessage.content, /unparseable/);
  assert.match(repairMessage.content, /Return the corrected JSON object only/);
  assert.match(repairMessage.content, /Schema:/);
  // 修复反馈不得回显模型原文。
  assert.ok(!repairMessage.content.includes("let me think"));
  // 日志只有脱敏元数据。
  assert.equal(logs.length, 1);
  assert.equal(logs[0]?.kind, "unparseable");
  assert.equal(typeof logs[0]?.length, "number");
});

test("schema rejection also triggers exactly one repair", async () => {
  const { call, seen } = fakeCall([
    '{"name":"Aster","mood":"unknown-mood"}',
    '{"name":"Aster","mood":"calm"}',
  ]);
  const result = await requestStructuredObject({
    call, messages: MESSAGES, normalize, schemaInstruction: SCHEMA, code: "TEST_INVALID",
  });
  assert.equal(seen.length, 2);
  assert.match(seen[1]!.at(-1)!.content, /schema/);
  assert.equal(result?.value.mood, "calm");
});

test("repair failure returns null (caller fail-closed), never a second repair", async () => {
  const { call, seen } = fakeCall(["garbage", "still garbage"]);
  const result = await requestStructuredObject({
    call, messages: MESSAGES, normalize, schemaInstruction: SCHEMA, code: "TEST_INVALID",
  });
  assert.equal(seen.length, 2, "初次 + 一次 repair，不无限重试");
  assert.equal(result, null);
});

test("provider errors propagate and are not disguised as format repair", async () => {
  const call = async () => {
    throw new Error("MODEL_TIMEOUT");
  };
  await assert.rejects(
    requestStructuredObject({
      call, messages: MESSAGES, normalize, schemaInstruction: SCHEMA, code: "TEST_INVALID",
    }),
    /MODEL_TIMEOUT/,
  );
});
