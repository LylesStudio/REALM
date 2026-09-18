import assert from "node:assert/strict";
import test from "node:test";
import type {
  ModelChatRequest,
  ModelChatResponse,
  ModelGateway,
} from "../modules/inference/types.ts";
import { createModelPoweredM2TurnOrchestrator } from "../modules/orchestration/model-powered.ts";
import { FatalTurnError } from "../modules/runtime/public.ts";

/**
 * P1-7：stage（一次逻辑模型调用）级总时限。
 * 空流重试 → chat 回退 → 结构化 repair → 就地/外层 retry 的组合此前只有
 * per-call timeout，整条链理论可达约 24 分钟。总 deadline 到达后必须进入
 * 安全 Fatal 终态：不再发起 provider 请求、不再 stream fallback、不被
 * retryTurn 捞起（Fatal 非 Retryable）；用户主动取消仍是 TURN_CANCELLED。
 * 测试只用 fake gateway + 短测试 deadline（<200ms），不碰真实 provider。
 */

const SCOUT = {
  characterInstanceId: "scout-instance",
  participantId: "scout-participant",
  displayName: "塞娜",
} as const;

function jsonResponse(value: unknown): ModelChatResponse {
  return {
    model: "fake-model",
    content: JSON.stringify(value),
    toolCalls: [],
    finishReason: "stop",
    usage: null,
  };
}

/** 挂起直到请求 signal 中断（模拟 provider 永不返回；deadline 负责切断）。 */
function hangUntilAbort(request: ModelChatRequest): Promise<never> {
  return new Promise((_, reject) => {
    request.signal?.addEventListener("abort", () => {
      reject(new Error("provider request aborted"));
    });
  });
}

type Tracked = {
  narratorStreamCalls: number;
  narratorChatCalls: number;
  gateway: ModelGateway;
};

/** DM/actor/react 正常、narrator 按回调定制的 fake gateway。 */
function trackedGateway(hooks: {
  onNarratorChat?: (request: ModelChatRequest) => Promise<ModelChatResponse>;
  narratorStream: "empty" | "hang";
}): Tracked {
  const tracked: Tracked = {
    narratorStreamCalls: 0,
    narratorChatCalls: 0,
    gateway: {
      async discoverModels() {
        return [];
      },
      async chat(request) {
        const system = request.messages[0]?.content ?? "";
        if (system.includes("independent Narrator")) {
          tracked.narratorChatCalls += 1;
          return hooks.onNarratorChat
            ? hooks.onNarratorChat(request)
            : jsonResponse({ environment: "冷雾未散。", storyBeat: "港口苏醒。" });
        }
        if (system.includes("DM Controller")) {
          return jsonResponse({
            goal: "回应玩家的自然询问",
            activatedCharacterInstanceIds: [SCOUT.characterInstanceId],
            narratorEnabled: true,
          });
        }
        if (request.tools) {
          return jsonResponse({});
        }
        if (system.includes("DM output reviewer")) {
          return jsonResponse({ accepted: true, goalSatisfied: true, worldCompatible: true });
        }
        throw new Error(`Unexpected chat call: ${system.slice(0, 60)}`);
      },
      async *streamChat(request) {
        const system = request.messages[0]?.content ?? "";
        if (system.includes("independent Narrator")) {
          tracked.narratorStreamCalls += 1;
          if (hooks.narratorStream === "hang") {
            await hangUntilAbort(request);
          }
          return; // 恒空正文
        }
        yield {
          content: JSON.stringify({
            action: "塞娜侧耳。",
            dialogue: "我在听。",
            recipientId: null,
          }),
        };
      },
    },
  };
  return tracked;
}

async function draftOutcome(tracked: Tracked, stageDeadlineMs: number) {
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => tracked.gateway,
    stageDeadlineMs,
  });
  const input = { turnId: "turn-deadline", playerText: "你还醒着吗？" };
  const plan = await orchestrator.plan(input);
  const settled = orchestrator.draft({ ...input, plan }).then(
    (candidate) => ({ kind: "ok" as const, candidate }),
    (error) => ({ kind: "error" as const, error }),
  );
  // 看门狗：没有总 deadline 时 narrator 挂起请求永不返回——红测表现为
  // timeout 而不是挂死整个测试进程。
  return Promise.race([
    settled,
    new Promise<{ kind: "timeout" }>((resolve) => {
      setTimeout(() => resolve({ kind: "timeout" }), 2_000);
    }),
  ]);
}

test("stage deadline: 恒空流 + 挂起回退被总时限切断，provider 次数有界", async () => {
  const tracked = trackedGateway({
    narratorStream: "empty",
    onNarratorChat: (request) => hangUntilAbort(request),
  });
  const startedAt = Date.now();
  const outcome = await draftOutcome(tracked, 100);
  const elapsed = Date.now() - startedAt;
  assert.notEqual(outcome.kind, "timeout", "总 deadline 必须切断挂起的回退链");
  assert.equal(outcome.kind, "error");
  const error = (outcome as { kind: "error"; error: unknown }).error;
  assert.ok(error instanceof FatalTurnError, "deadline 必须进入 Fatal 终态");
  assert.equal((error as FatalTurnError).code, "MODEL_STAGE_DEADLINE_EXCEEDED");
  assert.equal(tracked.narratorStreamCalls, 3, "空流就地重试次数不被 deadline 放大");
  assert.equal(tracked.narratorChatCalls, 1, "deadline 后不得再发起 chat 回退/重试");
  assert.ok(elapsed < 1_500, `总耗时有界（实测 ${elapsed}ms）`);
});

test("stage deadline: 挂起的首次流式后不再发起第二次重试", async () => {
  const tracked = trackedGateway({ narratorStream: "hang" });
  const outcome = await draftOutcome(tracked, 80);
  assert.notEqual(outcome.kind, "timeout");
  assert.equal(outcome.kind, "error");
  const error = (outcome as { kind: "error"; error: unknown }).error;
  assert.ok(error instanceof FatalTurnError);
  assert.equal((error as FatalTurnError).code, "MODEL_STAGE_DEADLINE_EXCEEDED");
  assert.equal(tracked.narratorStreamCalls, 1, "deadline 后不得发起第二次流式重试");
  assert.equal(tracked.narratorChatCalls, 0, "deadline 后不得发起 chat 回退");
});

test("stage deadline: 用户主动取消保持 TURN_CANCELLED 语义", async () => {
  const tracked = trackedGateway({ narratorStream: "hang" });
  const orchestrator = createModelPoweredM2TurnOrchestrator({
    characters: [SCOUT],
    getGateway: async () => tracked.gateway,
    stageDeadlineMs: 1, // 极小 deadline：若 cancel 优先级丢失会误报 deadline
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    orchestrator.plan({
      turnId: "turn-deadline-cancel",
      playerText: "取消这一轮。",
      signal: controller.signal,
    }),
    (error: unknown) => {
      assert.ok(error instanceof FatalTurnError);
      assert.equal(error.code, "TURN_CANCELLED");
      return true;
    },
  );
});
