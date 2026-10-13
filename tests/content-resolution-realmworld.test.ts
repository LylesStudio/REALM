/**
 * 内容解析层 · RealmWorldContentResolver focused 验收。
 *
 * 覆盖（world-bound 内容解析 slice 验收面）：
 * - 内存构建的签名 RealmWorld fixture（一次性 ed25519 测试密钥），经
 *   createRealmWorldContentResolverFromMount 与 install-root 工厂
 *   （createRealmWorldContentResolver → mountRealmWorld）两条路径解析；
 * - resolveWorld/characters/actions(skill/asset/effect/stance)/story/scene/
 *   goals/messages/genesis 形状与本地化回退；
 * - 身份边界：base binding、manifest/binding/request 身份不符一律
 *   CONTENT_IDENTITY_REJECTED；
 * - 未知请求键、不安全 id、非法 actionKind 一律 CONTENT_REQUEST_INVALID；
 * - 未知内容键/缺失模块显式 null miss（list 返回冻结空数组），绝不回退；
 * - 返回值深冻结，调用方 mutate 抛 TypeError。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ContentResolutionError,
  type ContentRequestBase,
  type ContentResolver,
} from "../modules/content-resolution/public.ts";
import {
  createRealmWorldContentResolver,
  createRealmWorldContentResolverFromMount,
  type MountedRealmWorldContent,
} from "../modules/content-resolution/realmworld-resolver.ts";
import {
  computeRealmWorldContentHash,
  installRealmWorldArchive,
  buildRealmWorldArchive,
  loadRealmWorldArchive,
} from "../modules/world-transfer/realmworld-loader.ts";
import {
  REALMWORLD_FORMAT,
  REALMWORLD_FORMAT_VERSION,
  serializeRealmWorldManifestSigningPayload,
  type RealmWorldManifestV1,
} from "../modules/world-transfer/realmworld-manifest.ts";
import { LOCAL_WORLD_VERSION, type WorldBinding } from "../modules/world-transfer/realm-save.ts";

const WORLD_ID = "world-resolver-fixture";
const WORLD_VERSION = "1.0.0";
const BINDING: WorldBinding = { kind: "world", worldId: WORLD_ID, worldVersion: WORLD_VERSION };

const { privateKey } = generateKeyPairSync("ed25519");

function json(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

const FULL_FILES = new Map<string, Uint8Array>([
  ["content/index.json", json({
    format: "realmworld-content",
    schemaVersion: 1,
    modules: [
      "content/world.json",
      "content/characters.json",
      "content/actions.json",
      "content/story.json",
      "content/scene.json",
      "content/goals.json",
      "content/messages.json",
    ],
  })],
  ["content/world.json", json({
    worldId: WORLD_ID,
    title: { en: "Resolver Harbor", "zh-CN": "解析港" },
    settings: {
      era: "storm",
      summary: "A harbor under test",
      calendarId: "harbor_calendar",
      style: "classical",
      weather: "salt rain",
      tension: "quiet pressure",
      displayTime: "Night 1",
      worldlineLabel: "Prime",
    },
  })],
  ["content/characters.json", json({
    format: "realmworld-characters",
    schemaVersion: 1,
    characters: [
      {
        characterKey: "keeper",
        displayName: { en: "Warden", "zh-CN": "守望者" },
        role: { en: "Harbor keeper", "zh-CN": "港湾守望" },
        summary: { en: "Keeps the light.", "zh-CN": "守着灯。" },
        isPlayer: false,
      },
      {
        characterKey: "envoy",
        displayName: { en: "Envoy" },
        role: { en: "Human envoy", "zh-CN": "人类使节" },
        summary: { en: "The player seat." },
        isPlayer: true,
      },
    ],
  })],
  ["content/actions.json", json({
    format: "realmworld-actions",
    schemaVersion: 1,
    actions: [
      {
        actionKind: "skill",
        actionKey: "careful_look",
        title: { en: "Careful Look", "zh-CN": "细致观察" },
        description: { en: "Look carefully.", "zh-CN": "仔细观察。" },
        rulePackKey: "realm.light.v1",
        consumable: false,
        effectKind: null,
        metadata: { check: { system: "d20", target: 12 } },
      },
      {
        actionKind: "asset",
        actionKey: "signal_lantern",
        title: { en: "Signal Lantern" },
        description: { en: "A hooded lantern." },
        rulePackKey: "realm.light.v1",
        consumable: true,
        effectKind: null,
        metadata: { uses: 3 },
      },
      {
        actionKind: "effect",
        actionKey: "fog_curse",
        title: { en: "Fog Curse" },
        description: { en: "A creeping fog." },
        rulePackKey: "realm.light.v1",
        consumable: false,
        effectKind: "curse",
        metadata: { severity: 2 },
      },
      {
        actionKind: "stance",
        actionKey: "guarded_watch",
        title: { en: "Guarded Watch" },
        description: { en: "Hold the pier." },
        rulePackKey: "realm.light.v1",
        consumable: false,
        effectKind: "stance",
        metadata: { posture: "defensive" },
      },
    ],
  })],
  ["content/story.json", json({
    format: "realmworld-story",
    schemaVersion: 1,
    stories: [
      {
        storyKey: "main",
        title: { en: "Harbor Story", "zh-CN": "港湾物语" },
        premise: { en: "The watch begins.", "zh-CN": "守望开始。" },
        recordTitle: { en: "First Watch", "zh-CN": "第一夜" },
        opening: {
          speaker: { en: "Warden", "zh-CN": "守望者" },
          content: { en: "The fog rolls in.", "zh-CN": "雾涌了进来。" },
          segments: [
            {
              id: "seg-1",
              kind: "narration",
              content: { en: "Fog over the pier.", "zh-CN": "雾漫过栈桥。" },
              speechMode: "narration",
            },
          ],
        },
      },
    ],
  })],
  ["content/scene.json", json({
    format: "realmworld-scenes",
    schemaVersion: 1,
    scenes: [
      {
        sceneKey: "pier",
        title: { en: "North Pier", "zh-CN": "北栈桥" },
        location: { en: "North pier", "zh-CN": "北栈桥" },
        weather: { en: "Salt rain", "zh-CN": "咸雨" },
        tension: { en: "Quiet pressure", "zh-CN": "无声的压力" },
        displayTime: { en: "Night", "zh-CN": "夜" },
        objective: { en: "Hold the line", "zh-CN": "守住防线" },
      },
    ],
  })],
  ["content/goals.json", json({
    format: "realmworld-goals",
    schemaVersion: 1,
    goals: [
      {
        goalKey: "hold-the-line",
        policyVersion: "v1",
        mode: "deterministic",
        visible: true,
        rubric: { kind: "event_count", eventKind: "watch_kept", progressKey: "watches", threshold: 3 },
        outcome: { result: "held" },
      },
    ],
  })],
  ["content/messages.json", json({
    format: "realmworld-messages",
    schemaVersion: 1,
    messages: {
      en: { "world.name": "Resolver Harbor", "ui.start": "Start" },
      "zh-CN": { "world.name": "解析港" },
    },
  })],
]);

/** 内存构建签名 RealmWorld 包（一次性 ed25519 测试密钥，绝不落盘）。 */
function buildSignedMount(worldId: string, files: ReadonlyMap<string, Uint8Array>): {
  mount: MountedRealmWorldContent;
  signature: string;
} {
  const unsigned: RealmWorldManifestV1 = {
    format: REALMWORLD_FORMAT,
    formatVersion: REALMWORLD_FORMAT_VERSION,
    worldId,
    worldVersion: WORLD_VERSION,
    engineCompat: {
      schemaLatest: "0057_realmworld_record_binding.sql",
      requiresMigrations: ["0055_goal_runtime.sql"],
      baseRange: ">=1.0.0 <2.0.0",
    },
    contentHash: computeRealmWorldContentHash(files),
    signature: { algorithm: "ed25519", keyId: "resolver-test-key", value: "placeholder" },
  };
  const signature = sign(
    null,
    Buffer.from(serializeRealmWorldManifestSigningPayload(unsigned), "utf8"),
    privateKey,
  ).toString("base64url");
  const manifest: RealmWorldManifestV1 = {
    ...unsigned,
    signature: { ...unsigned.signature, value: signature },
  };
  return { mount: { manifest, files }, signature };
}

const { mount: fullMount, signature: fullSignature } = buildSignedMount(WORLD_ID, FULL_FILES);
const verifyFullSignature = ({ manifest }: { manifest: RealmWorldManifestV1 }) =>
  manifest.signature.value === fullSignature;

function request(extra: Partial<ContentRequestBase> = {}): ContentRequestBase {
  return {
    binding: BINDING,
    worldId: WORLD_ID,
    worldVersion: WORLD_VERSION,
    language: "en",
    ...extra,
  };
}

function expectError(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ContentResolutionError);
    assert.equal(error.code, code);
    return true;
  });
}

const resolver: ContentResolver = createRealmWorldContentResolverFromMount(fullMount, BINDING, "en");

test("realmworld resolver resolves the world document with settings and localization", () => {
  const world = resolver.resolveWorld(request());
  assert.ok(world);
  assert.equal(world.contentKey, WORLD_ID);
  assert.equal(world.name, "Resolver Harbor");
  assert.equal(world.era, "storm");
  assert.equal(world.summary, "A harbor under test");
  assert.equal(world.calendarId, "harbor_calendar");
  assert.equal(world.style, "classical");
  assert.equal(world.weather, "salt rain");
  assert.equal(world.tension, "quiet pressure");
  assert.equal(world.displayTime, "Night 1");
  assert.equal(world.worldlineLabel, "Prime");
  assert.equal(world.settings.style, "classical");

  const zh = resolver.resolveWorld(request({ language: "zh-CN" }));
  assert.equal(zh?.name, "解析港");
  // 显式 contentKey = 包主内容键命中；未知 contentKey 显式 miss。
  assert.equal(resolver.resolveWorld(request({ contentKey: WORLD_ID }))?.name, "Resolver Harbor");
  assert.equal(resolver.resolveWorld(request({ contentKey: "other-bundle" })), null);
});

test("realmworld resolver resolves and lists character definitions", () => {
  const characters = resolver.listCharacters(request());
  assert.deepEqual(characters.map((entry) => entry.characterKey), ["keeper", "envoy"]);
  const keeper = resolver.resolveCharacter({ ...request({ language: "zh-CN" }), characterKey: "keeper" });
  assert.ok(keeper);
  assert.equal(keeper.displayName, "守望者");
  assert.equal(keeper.role, "港湾守望");
  assert.equal(keeper.isPlayer, false);
  const envoy = resolver.resolveCharacter({ ...request(), characterKey: "envoy" });
  assert.equal(envoy?.isPlayer, true);
  // 未知角色键显式 miss；不安全 id 拒绝。
  assert.equal(resolver.resolveCharacter({ ...request(), characterKey: "ghost" }), null);
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveCharacter({ ...request(), characterKey: "../escape" }));
});

test("realmworld resolver resolves skill/asset/effect/stance action definitions", () => {
  const all = resolver.listActions(request());
  assert.deepEqual(
    all.map((entry) => entry.actionKind).sort(),
    ["asset", "effect", "skill", "stance"],
  );

  const skill = resolver.resolveAction({ ...request({ language: "zh-CN" }), actionKind: "skill", actionKey: "careful_look" });
  assert.ok(skill);
  assert.equal(skill.title, "细致观察");
  assert.equal(skill.rulePackKey, "realm.light.v1");
  assert.equal(skill.consumable, false);
  assert.equal(skill.effectKind, null);
  assert.deepEqual(skill.metadata.check, { system: "d20", target: 12 });

  const asset = resolver.resolveAction({ ...request(), actionKind: "asset", actionKey: "signal_lantern" });
  assert.equal(asset?.consumable, true);
  const effect = resolver.resolveAction({ ...request(), actionKind: "effect", actionKey: "fog_curse" });
  assert.equal(effect?.effectKind, "curse");
  const stance = resolver.resolveAction({ ...request(), actionKind: "stance", actionKey: "guarded_watch" });
  assert.equal(stance?.effectKind, "stance");

  // actionKind 不符 = miss；kind 过滤的 list；未知 kind 拒绝。
  assert.equal(
    resolver.resolveAction({ ...request(), actionKind: "asset", actionKey: "careful_look" }),
    null,
  );
  assert.equal(resolver.listActions({ ...request(), actionKind: "skill" }).length, 1);
  assert.equal(resolver.resolveAction({ ...request(), actionKind: "skill", actionKey: "unknown" }), null);
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveAction({ ...request(), actionKind: "bogus" as never, actionKey: "careful_look" }));
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveAction({ ...request(), actionKind: "skill", actionKey: "bad key" }));
});

test("realmworld resolver resolves story with record title and opening segments", () => {
  const story = resolver.resolveStory(request({ language: "zh-CN" }));
  assert.ok(story);
  assert.equal(story.storyKey, "main");
  assert.equal(story.title, "港湾物语");
  assert.equal(story.recordTitle, "第一夜");
  assert.equal(story.opening.speaker, "守望者");
  assert.equal(story.opening.content, "雾涌了进来。");
  assert.deepEqual(story.opening.segments, [
    { id: "seg-1", kind: "narration", content: "雾漫过栈桥。", speechMode: "narration" },
  ]);
  // 显式 storyKey 命中/不符；不安全 storyKey 拒绝。
  assert.equal(resolver.resolveStory({ ...request(), storyKey: "main" })?.title, "Harbor Story");
  assert.equal(resolver.resolveStory({ ...request(), storyKey: "side" }), null);
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveStory({ ...request(), storyKey: "a/b" }));
});

test("realmworld resolver resolves the scene", () => {
  const scene = resolver.resolveScene(request({ language: "zh-CN" }));
  assert.ok(scene);
  assert.equal(scene.sceneKey, "pier");
  assert.equal(scene.title, "北栈桥");
  assert.equal(scene.location, "北栈桥");
  assert.equal(scene.weather, "咸雨");
  assert.equal(scene.tension, "无声的压力");
  assert.equal(scene.displayTime, "夜");
  assert.equal(scene.objective, "守住防线");
  assert.equal(resolver.resolveScene({ ...request(), sceneKey: "pier" })?.title, "North Pier");
  assert.equal(resolver.resolveScene({ ...request(), sceneKey: "square" }), null);
});

test("realmworld resolver resolves goal definitions", () => {
  const goal = resolver.resolveGoal({ ...request(), goalKey: "hold-the-line" });
  assert.ok(goal);
  assert.equal(goal.mode, "deterministic");
  assert.deepEqual(goal.rubric, {
    kind: "event_count",
    eventKind: "watch_kept",
    progressKey: "watches",
    threshold: 3,
  });
  assert.equal(resolver.resolveGoal({ ...request(), goalKey: "unknown" }), null);
});

test("realmworld resolver resolves locale message bundles with fallback", () => {
  const zh = resolver.resolveMessages(request({ language: "zh-CN" }));
  assert.deepEqual(zh, { "world.name": "解析港" });
  // ja 未安装：按本地化回退链落到 en。
  const ja = resolver.resolveMessages(request({ language: "ja" }));
  assert.deepEqual(ja, { "world.name": "Resolver Harbor", "ui.start": "Start" });
});

test("realmworld resolver resolves genesis content from the mounted package", () => {
  const genesis = resolver.resolveGenesisContent({ binding: BINDING, language: "en" });
  assert.ok(genesis);
  assert.equal(genesis.contentKey, WORLD_ID);
  assert.equal(genesis.world.name, "Resolver Harbor");
  assert.equal(genesis.story.title, "Harbor Story");
  assert.equal(genesis.record.title, "First Watch");
  assert.equal(genesis.scene.title, "North Pier");
  assert.equal(genesis.playerRole, "Human envoy");
  assert.equal(genesis.playerStance, "player");
  assert.deepEqual(genesis.characters.map((entry) => entry.characterKey), ["keeper"]);
  assert.equal(genesis.goals.length, 1);
  assert.equal(genesis.opening, "The fog rolls in.");
  // 未知 contentKey 显式 miss；异世界 binding 拒绝。
  assert.equal(
    resolver.resolveGenesisContent({ binding: BINDING, language: "en", contentKey: "other" }),
    null,
  );
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    resolver.resolveGenesisContent({
      binding: { kind: "world", worldId: "other-world", worldVersion: WORLD_VERSION },
      language: "en",
    }));
});

test("realmworld resolver rejects base and mismatched identities", () => {
  // base binding 构造即拒绝。
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    createRealmWorldContentResolverFromMount(fullMount, { kind: "base" }, "en"));
  // binding 与 manifest 身份不符拒绝。
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    createRealmWorldContentResolverFromMount(
      fullMount,
      { kind: "world", worldId: "other-world", worldVersion: WORLD_VERSION },
      "en",
    ));
  // base 请求身份拒绝（绝不降级到 base 内容）。
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    resolver.resolveWorld({
      binding: { kind: "base" },
      worldId: "",
      worldVersion: LOCAL_WORLD_VERSION,
      language: "en",
    }));
  // 请求身份与 binding 不符拒绝。
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    resolver.resolveWorld(request({ worldId: "other-world" })));
  expectError("CONTENT_IDENTITY_REJECTED", () =>
    resolver.resolveWorld(request({ worldVersion: "9.9.9" })));
});

test("realmworld resolver rejects unknown request keys and invalid languages", () => {
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveWorld({ ...request(), bogus: true } as never));
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveCharacter({ ...request(), characterKey: "keeper", extra: 1 } as never));
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveWorld(request({ language: "fr" as never })));
  expectError("CONTENT_REQUEST_INVALID", () =>
    resolver.resolveGoal({ ...request(), goalKey: "" }));
});

test("realmworld resolver returns explicit misses for missing modules", () => {
  const sparseFiles = new Map<string, Uint8Array>([
    ["content/index.json", json({
      format: "realmworld-content",
      schemaVersion: 1,
      modules: ["content/world.json", "content/characters.json"],
    })],
    ["content/world.json", json({
      worldId: "world-resolver-sparse",
      title: { en: "Sparse" },
      settings: { era: "calm" },
    })],
    ["content/characters.json", json({
      format: "realmworld-characters",
      schemaVersion: 1,
      characters: [],
    })],
  ]);
  const { mount } = buildSignedMount("world-resolver-sparse", sparseFiles);
  const sparse = createRealmWorldContentResolverFromMount(
    mount,
    { kind: "world", worldId: "world-resolver-sparse", worldVersion: WORLD_VERSION },
    "en",
  );
  const scope: ContentRequestBase = {
    binding: { kind: "world", worldId: "world-resolver-sparse", worldVersion: WORLD_VERSION },
    worldId: "world-resolver-sparse",
    worldVersion: WORLD_VERSION,
    language: "en",
  };
  assert.equal(sparse.resolveWorld(scope)?.name, "Sparse");
  // 未安装模块显式 miss：resolve null / list 冻结空数组 / genesis null。
  assert.equal(sparse.resolveMessages(scope), null);
  assert.equal(sparse.resolveGoal({ ...scope, goalKey: "hold-the-line" }), null);
  assert.equal(sparse.resolveStory(scope), null);
  assert.equal(sparse.resolveScene(scope), null);
  assert.equal(sparse.resolveAction({ ...scope, actionKind: "skill", actionKey: "careful_look" }), null);
  assert.equal(sparse.listActions(scope).length, 0);
  assert.equal(sparse.listCharacters(scope).length, 0);
  assert.ok(Object.isFrozen(sparse.listActions(scope)));
  assert.equal(sparse.resolveGenesisContent({ binding: scope.binding as WorldBinding, language: "en" }), null);
});

test("realmworld resolver deep-freezes all returned content", () => {
  const world = resolver.resolveWorld(request());
  assert.ok(world);
  assert.ok(Object.isFrozen(world));
  assert.ok(Object.isFrozen(world.settings));
  assert.throws(() => {
    (world as { name: string }).name = "mutated";
  }, TypeError);
  assert.equal(world.name, "Resolver Harbor");

  const action = resolver.resolveAction({ ...request(), actionKind: "skill", actionKey: "careful_look" });
  assert.ok(action);
  assert.ok(Object.isFrozen(action));
  assert.ok(Object.isFrozen(action.metadata));
  assert.ok(Object.isFrozen(action.metadata.check));

  const story = resolver.resolveStory(request());
  assert.ok(story);
  assert.ok(Object.isFrozen(story.opening));
  assert.ok(Object.isFrozen(story.opening.segments));
  assert.ok(Object.isFrozen(story.opening.segments[0]));

  const characters = resolver.listCharacters(request());
  assert.ok(Object.isFrozen(characters));
  assert.ok(Object.isFrozen(characters[0]));

  const messages = resolver.resolveMessages(request());
  assert.ok(messages);
  assert.ok(Object.isFrozen(messages));

  const goal = resolver.resolveGoal({ ...request(), goalKey: "hold-the-line" });
  assert.ok(goal);
  assert.ok(Object.isFrozen(goal));
  assert.ok(Object.isFrozen(goal.rubric));
  assert.ok(Object.isFrozen(goal.outcome));
  // 返回值是独立拷贝：mutate 抛错且不影响后续解析。
  assert.throws(() => {
    (goal.outcome as Record<string, unknown>).result = "broken";
  }, TypeError);
  assert.equal(
    resolver.resolveGoal({ ...request(), goalKey: "hold-the-line" })?.outcome.result,
    "held",
  );
});

test("install-root factory mounts the signed package via mountRealmWorld", async () => {
  const installRoot = await mkdtemp(join(tmpdir(), "realm-resolver-install-"));
  try {
    const archive = buildRealmWorldArchive({ manifest: fullMount.manifest, files: fullMount.files });
    await installRealmWorldArchive({
      archiveBytes: archive,
      installRoot,
      verifySignature: verifyFullSignature,
    });
    const factory = createRealmWorldContentResolver({
      installRoot,
      verifySignature: verifyFullSignature,
      locale: "en",
    });
    // base binding 由 BaseContentResolver 负责，这里显式 null。
    assert.equal(await factory({ kind: "base" }), null);
    const mounted = await factory(BINDING);
    assert.ok(mounted);
    assert.equal(mounted.resolveWorld(request())?.name, "Resolver Harbor");
    assert.equal(
      mounted.resolveCharacter({ ...request({ language: "zh-CN" }), characterKey: "keeper" })?.displayName,
      "守望者",
    );
  } finally {
    await rm(installRoot, { recursive: true, force: true });
  }
});

test("from-mount consumes archives loaded fully in memory", async () => {
  const archive = buildRealmWorldArchive({ manifest: fullMount.manifest, files: fullMount.files });
  const loaded = await loadRealmWorldArchive(archive, { verifySignature: verifyFullSignature });
  const fromArchive = createRealmWorldContentResolverFromMount(loaded, BINDING, "en");
  assert.equal(fromArchive.resolveWorld(request())?.name, "Resolver Harbor");
  // 签名被篡改的包在加载期即被拒绝，resolver 永远见不到未验签内容。
  const tampered = Buffer.from(archive);
  await assert.rejects(
    loadRealmWorldArchive(tampered, {
      verifySignature: () => false,
    }),
  );
});

test("realmworld resolver rejects invalid constructor locale", () => {
  expectError("CONTENT_REQUEST_INVALID", () =>
    createRealmWorldContentResolverFromMount(fullMount, BINDING, "bad locale!"));
  expectError("CONTENT_REQUEST_INVALID", () =>
    createRealmWorldContentResolverFromMount(fullMount, BINDING, " en"));
});
