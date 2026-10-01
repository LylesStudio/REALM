/**
 * genesis-suggestions / world-genesis 阶段的生产驱动契约（F-AUD-5 后续）：
 * 真实生产函数（generateGenesisDraft / generateGenesisSuggestions）→ 真实
 * system prompt 构造 → stub ModelGateway → loopback fake provider → 阶段
 * fixture → 生产 normalizer。绝不手写仿造 prompt；七步矩阵逐一验证。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createFakeOpenAiProvider,
  FAKE_PROVIDER_MODEL,
} from "./helpers/fake-openai-provider.mjs";
import { generateGenesisDraft } from "../modules/application/world-genesis.ts";
import {
  GUIDED_GENESIS_STEPS,
  generateGenesisSuggestions,
} from "../modules/application/genesis-suggestions.ts";

/** stub gateway：把生产 chat 调用转发给 loopback fake provider。 */
function gatewayTo(baseUrl) {
  return {
    providerId: "custom-openai",
    async discoverModels() {
      return [];
    },
    async chat(request) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: FAKE_PROVIDER_MODEL,
          messages: request.messages,
          ...(request.responseFormat ? { response_format: { type: request.responseFormat } } : {}),
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        }),
      });
      const body = await response.json();
      const choice = body.choices?.[0];
      return {
        content: choice?.message?.content ?? "",
        model: body.model ?? FAKE_PROVIDER_MODEL,
        usage: body.usage ?? null,
        finishReason: choice?.finish_reason ?? (response.ok ? "stop" : "error"),
      };
    },
  };
}

test("world-genesis: generateGenesisDraft 经 fake provider 返回合法手稿", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const draft = await generateGenesisDraft(
    gatewayTo(provider.baseUrl),
    "一座沉在湖底的旧钟楼：钟声仍能在水下传播，靠听钟声辨认方向。",
  );
  assert.ok(draft, "world-genesis 阶段必须注册并通过 normalizeGenesisDraft");
  assert.ok(draft.world.name.trim().length > 0, "世界名非空");
  assert.ok(draft.world.name.length <= 40);
  assert.ok(draft.story.title.trim().length > 0);
  assert.ok(draft.playerRole.trim().length > 0);
  assert.ok(Array.isArray(draft.companions) && draft.companions.length >= 1, "手稿含同行者");
  assert.ok(draft.scene.location.trim().length > 0);
});

test("genesis-suggestions: 七步候选经 fake provider 逐一通过生产 normalizer", async (t) => {
  const provider = await createFakeOpenAiProvider();
  t.after(() => provider.stop());
  const gateway = gatewayTo(provider.baseUrl);
  const context = { world: { name: "雾钟湖城" } };
  for (const step of GUIDED_GENESIS_STEPS) {
    const suggestions = await generateGenesisSuggestions(gateway, {
      step,
      intent: "湖底钟楼与水下钟声",
      context,
    });
    assert.ok(suggestions, `${step} 候选必须非空（阶段 fixture 缺失或 normalizer 拒绝）`);
    if (step === "companions") {
      assert.ok(suggestions.every((item) =>
        typeof item === "object" && typeof item.name === "string" && item.name.length > 0
        && typeof item.role === "string" && typeof item.summary === "string"
      ), "companions 为 {name,role,summary} 对象数组");
    } else if (step === "scene") {
      assert.equal(typeof suggestions, "object");
      assert.ok(Array.isArray(suggestions.location) && suggestions.location.length > 0);
      assert.ok(Array.isArray(suggestions.objective));
    } else if (step === "story") {
      assert.ok(suggestions.every((item) => typeof item === "string" && item.includes("——")),
        "story 候选规整为 title——premise 字符串");
    } else {
      assert.ok(suggestions.every((item) => typeof item === "string" && item.trim().length > 0),
        `${step} 候选为非空字符串列表`);
      assert.ok(suggestions.length <= 3, `${step} 至多 3 条`);
    }
  }
});

test("genesis-suggestions: 未知 [Task for this step] fail-closed 422 且日志不记请求文本", async (t) => {
  // characterization：derive 对未识别任务返回 undefined → 与未知阶段同规
  // 422 FAKE_STAGE_UNKNOWN（Iris 已有独立 loopback smoke 证据）；本条把
  // 运行语义固化为持久回归，并钉住日志零请求文本。
  const logLines = [];
  const provider = await createFakeOpenAiProvider({ logger: (line) => logLines.push(line) });
  t.after(() => provider.stop());
  const secretTaskText = "Offer 9 forbidden escalation hacks";
  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: FAKE_PROVIDER_MODEL,
      messages: [
        {
          role: "system",
          content: "You are REALM's Scribe, writing a new world with the player one guided step at a time. Offer candidates for the current step for the player to pick from.",
        },
        {
          role: "user",
          content: `[Player intent]\n神秘意图\n\n[Task for this step]\n${secretTaskText}`,
        },
      ],
    }),
  });
  assert.equal(response.status, 422, "未知任务必须 fail-closed 422");
  const body = await response.json();
  assert.equal(body.error?.code, "FAKE_STAGE_UNKNOWN");
  assert.ok(typeof body.error?.stageHash === "string" && body.error.stageHash.length > 0,
    "响应只带不可逆指纹");
  assert.ok(!JSON.stringify(body).includes(secretTaskText), "响应不得回显任务文本");
  for (const line of logLines) {
    assert.ok(!line.includes(secretTaskText), "日志不得含请求文本");
    assert.ok(!line.includes("神秘意图"), "日志不得含 user 内容");
  }
});
