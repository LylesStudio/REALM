import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelGateway, ModelProviderSettings } from "../modules/inference/types.ts";
import { createLocalModelSettingsStore } from "../modules/inference/local-settings.ts";
import { createModelSettingsService } from "../modules/application/model-settings-service.ts";

/**
 * Cleanup Phase 4 / Batch 2B：gateway snapshot cache。
 * 证明：hit/miss、save/discover 失效、并发 single-flight、构造失败不缓存、
 * provider 隔离、test(draft) 候选不污染 active cache。
 */

function settings(providerId: "lmstudio" | "openrouter", model: string): ModelProviderSettings {
  return {
    schemaVersion: 1,
    providerId,
    baseUrl: providerId === "lmstudio" ? "http://127.0.0.1:8823/v1" : "https://openrouter.ai/api/v1",
    apiKey: providerId === "openrouter" ? "test-key" : "",
    selectedModel: model,
    thinking: "disabled",
    timeoutMs: 30_000,
    maxTokens: 2_048,
    availableModels: [],
    lastDiscoveredAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function fakeGateway(tag: string): ModelGateway {
  return {
    async discoverModels() {
      return [{
        id: `${tag}-model`,
        name: tag,
        ownedBy: "test",
        contextLength: null,
        pricing: null,
        costClass: "free",
        supportsTools: null,
        supportsStructuredOutputs: null,
      }];
    },
    async chat() {
      return {
        model: tag,
        content: '{"ok":true}',
        toolCalls: [],
        finishReason: "stop",
        usage: null,
      };
    },
  };
}

async function makeService(createGateway: (settings: ModelProviderSettings) => ModelGateway) {
  const directory = await mkdtemp(join(tmpdir(), "realm-gateway-cache-"));
  const store = createLocalModelSettingsStore({
    filePath: join(directory, "model-providers.json"),
    environment: {},
  });
  await store.saveProfile(settings("lmstudio", "model-a"), true);
  const service = createModelSettingsService({ store, createGateway });
  return { service, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("repeated gateway() calls reuse one instance; settings change rebuilds", async () => {
  const tags: string[] = [];
  const { service, cleanup } = await makeService((gatewaySettings) => {
    tags.push(gatewaySettings.selectedModel);
    return fakeGateway(`gw-${tags.length}`);
  });
  try {
    const first = await service.gateway();
    const second = await service.gateway();
    assert.equal(first, second, "same fingerprint must reuse the same instance");
    assert.equal(tags.length, 1, "factory must run once for identical settings");

    await service.save({ selectedModel: "model-b" });
    const third = await service.gateway();
    const fourth = await service.gateway();
    assert.equal(third, fourth);
    assert.notEqual(first, third, "save() must invalidate the cached instance");
    assert.equal(tags.length, 2);
    assert.equal(tags[1], "model-b");
  } finally {
    await cleanup();
  }
});

test("concurrent gateway() calls construct exactly once (single-flight)", async () => {
  let constructions = 0;
  const { service, cleanup } = await makeService((gatewaySettings) => {
    constructions += 1;
    return fakeGateway(gatewaySettings.selectedModel);
  });
  try {
    const pending = Promise.all([service.gateway(), service.gateway(), service.gateway()]);
    const [a, b, c] = await pending;
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(constructions, 1, "concurrent callers must share one construction");
  } finally {
    await cleanup();
  }
});

test("discover() invalidates the cache only after success", async () => {
  let constructions = 0;
  const { service, cleanup } = await makeService((gatewaySettings) => {
    constructions += 1;
    return fakeGateway(gatewaySettings.selectedModel);
  });
  try {
    const first = await service.gateway();
    await service.discover({});
    const second = await service.gateway();
    assert.notEqual(first, second, "successful discover() must invalidate");
    assert.equal(
      constructions,
      3,
      "active + discover candidate + invalidated rebuild = 3 constructions",
    );
  } finally {
    await cleanup();
  }
});

test("construction failure is never cached", async () => {
  let attempts = 0;
  const { service, cleanup } = await makeService(() => {
    attempts += 1;
    if (attempts === 1) throw new Error("factory boom");
    return fakeGateway("recovered");
  });
  try {
    await assert.rejects(service.gateway(), /factory boom/);
    const recovered = await service.gateway();
    assert.ok(recovered);
    assert.equal(attempts, 2, "a failed construction must not be cached");
  } finally {
    await cleanup();
  }
});

test("provider/profile isolation and test(draft) never pollute the active cache", async () => {
  const constructions: string[] = [];
  const { service, cleanup } = await makeService((gatewaySettings) => {
    constructions.push(`${gatewaySettings.providerId}:${gatewaySettings.selectedModel}`);
    return fakeGateway(`${gatewaySettings.providerId}:${constructions.length}`);
  });
  try {
    const lmFirst = await service.gateway();
    const lmSecond = await service.gateway();
    assert.equal(lmFirst, lmSecond);

    // test(draft) 走候选 factory（不缓存）；active cache 不受污染。
    const beforeProbe = constructions.length;
    await service.test({});
    assert.equal(constructions.length, beforeProbe + 1, "probe uses a candidate gateway");
    const lmThird = await service.gateway();
    assert.equal(lmThird, lmFirst, "probe candidate must not evict the active cache");

    await service.save({ providerId: "openrouter", apiKey: "test-key-2" });
    const orGateway = await service.gateway();
    assert.notEqual(orGateway, lmFirst, "provider switch must build a separate gateway");
    const orAgain = await service.gateway();
    assert.equal(orAgain, orGateway);
  } finally {
    await cleanup();
  }
});
