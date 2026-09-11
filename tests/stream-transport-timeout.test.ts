import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { createOpenAICompatibleGateway } from "../modules/inference/openai-compatible-gateway.ts";
import { ModelProviderError } from "../modules/inference/types.ts";
import type { ModelProviderSettings } from "../modules/inference/types.ts";

/**
 * Cleanup Phase 4 / Batch 2A：streamChat 的 per-call timeout override。
 * 证明：有效 timeout = min(请求覆盖, 设置)；底层 fetch 收到真实 AbortSignal；
 * 正常完成/迭代器提前关闭/HTTP 错误都会清理 timer；错误分类不混淆。
 */

function settings(timeoutMs: number): ModelProviderSettings {
  return {
    schemaVersion: 1,
    providerId: "openrouter",
    baseUrl: "https://example.test",
    apiKey: "test-key",
    selectedModel: "test-model",
    thinking: "disabled",
    timeoutMs,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function hangUntilAbort(): { fetcher: typeof fetch; signal: () => AbortSignal | null } {
  let captured: AbortSignal | null = null;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    captured = init?.signal ?? null;
    return await new Promise<Response>((_resolve, reject) => {
      captured?.addEventListener("abort", () => {
        reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
      });
    });
  }) as typeof fetch;
  return { fetcher, signal: () => captured };
}

function sseResponse(
  chunks: string[],
  options: { close?: boolean; signal?: (signal: AbortSignal | null) => void } = {},
): { fetcher: typeof fetch; signal: () => AbortSignal | null } {
  let captured: AbortSignal | null = null;
  const encoder = new TextEncoder();
  const fetcher = (async (_url: string, init?: RequestInit) => {
    captured = init?.signal ?? null;
    options.signal?.(captured);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(
            encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(chunk)}}}]}\n\n`),
          );
        }
        if (options.close !== false) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  return { fetcher, signal: () => captured };
}

async function expectTimeout(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    return error instanceof ModelProviderError && error.code === "MODEL_TIMEOUT";
  });
}

test("stream timeout override is honored when below the provider cap", async () => {
  const { fetcher } = hangUntilAbort();
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: fetcher,
  });
  const started = performance.now();
  await expectTimeout((async () => {
    for await (const chunk of gateway.streamChat!({
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 25,
    })) {
      void chunk; // never reached
    }
  })());
  assert.ok(performance.now() - started < 2_000, "override below the cap must drive the abort quickly");
});

test("provider settings timeout clamps the per-call override", async () => {
  const { fetcher } = hangUntilAbort();
  const gateway = createOpenAICompatibleGateway({
    settings: settings(25),
    fetch: fetcher,
  });
  const started = performance.now();
  await expectTimeout((async () => {
    for await (const chunk of gateway.streamChat!({
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 5_000,
    })) {
      void chunk; // never reached
    }
  })());
  assert.ok(performance.now() - started < 2_000, "settings cap must win over a larger override");
});

test("stream timeout aborts the underlying fetch signal", async () => {
  const { fetcher, signal } = hangUntilAbort();
  const gateway = createOpenAICompatibleGateway({
    settings: settings(20),
    fetch: fetcher,
  });
  await expectTimeout((async () => {
    for await (const chunk of gateway.streamChat!({
      messages: [{ role: "user", content: "hi" }],
    })) {
      void chunk; // never reached
    }
  })());
  assert.equal(signal()?.aborted, true, "the underlying fetch must receive a real abort");
});

test("timer is cleared after normal stream completion", async () => {
  const { fetcher, signal } = sseResponse(["第一句。"]);
  const gateway = createOpenAICompatibleGateway({
    settings: settings(30),
    fetch: fetcher,
  });
  const chunks: string[] = [];
  for await (const chunk of gateway.streamChat!({
    messages: [{ role: "user", content: "hi" }],
  })) {
    chunks.push(chunk.content);
  }
  assert.deepEqual(chunks, ["第一句。"]);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal()?.aborted, false, "timer must be cleared after normal completion");
});

test("timer is cleared when the consumer closes the iterator early", async () => {
  const { fetcher, signal } = sseResponse(["第一句。"], { close: false });
  const gateway = createOpenAICompatibleGateway({
    settings: settings(30),
    fetch: fetcher,
  });
  for await (const chunk of gateway.streamChat!({
    messages: [{ role: "user", content: "hi" }],
  })) {
    void chunk;
    break; // 首个 chunk 即提前关闭迭代器；timer 必须随 onDone 清理
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(signal()?.aborted, false, "timer must be cleared on early iterator close");
});

test("HTTP errors keep their own classification instead of becoming timeouts", async () => {
  const fetcher = (async () => {
    return new Response(JSON.stringify({ error: { message: "slow down" } }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const gateway = createOpenAICompatibleGateway({
    settings: settings(5_000),
    fetch: fetcher,
  });
  await assert.rejects(
    (async () => {
      for await (const chunk of gateway.streamChat!({
        messages: [{ role: "user", content: "hi" }],
      })) {
        void chunk; // never reached
      }
    })(),
    (error: unknown) => {
      return error instanceof ModelProviderError && error.code === "MODEL_RATE_LIMITED";
    },
  );
});
