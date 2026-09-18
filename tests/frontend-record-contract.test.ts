import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import {
  createOptimisticEvent,
  describeVisibility,
  lastCommittedOrdinal,
  normalizeCommittedEventPayload,
  normalizeRecordEnvelope,
  normalizeRecordProjection,
  recordEnvelopesEqual,
  upsertCommittedEvent,
  type RecordProjection,
  type TimelineEvent,
} from "../app/components/record-types.ts";
import { normalizeLibrarySnapshot } from "../app/components/library-types.ts";
import { fallbackSemanticSegments } from "../modules/presentation/semantic-segments.ts";

function projection(events: TimelineEvent[] = []): RecordProjection {
  return {
    id: "record-1",
    version: events.length,
    world: { id: "world-1", name: "烬海", era: "停战纪元" },
    story: { id: "story-1", title: "无声钟", status: "进行中" },
    record: {
      id: "record-1",
      title: "第一夜巡",
      location: "北门",
      worldTime: "停战纪元17年",
      version: events.length,
    },
    events,
    cast: [
      {
        id: "cast-1",
        name: "洛川",
        role: "守夜人",
        summary: "在北门守夜的旅人。",
        status: "在场",
        controlledBy: "玩家",
        isActive: true,
      },
    ],
    scene: {
      location: "北门",
      worldTime: "停战纪元17年",
      weather: "薄雾",
      tension: "戒备",
      objective: "检查蜡封",
    },
    stories: [{ id: "story-1", title: "无声钟", status: "当前" }],
    records: [
      {
        id: "record-1",
        title: "第一夜巡",
        status: "当前",
        worldTime: "停战纪元17年",
      },
    ],
  };
}

function committedEvent(id: string, ordinal: number): TimelineEvent {
  return {
    id,
    ordinal,
    type: "utterance",
    speaker: "塞娜",
    role: "character",
    content: `事件 ${ordinal}`,
    segments: fallbackSemanticSegments(`事件 ${ordinal}`, "dialogue"),
    worldTime: "停战纪元17年",
    visibility: "scene",
    status: "committed",
  };
}

test("Record envelope accepts explicit viewer authority and otherwise fails closed", () => {
  const omniscient = normalizeRecordEnvelope({
    ok: true,
    record: projection(),
    writeToken: "opaque-write-token",
    viewer: {
      cursor: "viewer-local",
      perspective: "omniscient",
      characterInstanceId: null,
      dynamicKnowledgeVisible: true,
    },
  });
  assert.equal(omniscient.writeToken, "opaque-write-token");
  assert.equal(omniscient.viewer.perspective, "omniscient");
  assert.equal(omniscient.viewer.dynamicKnowledgeVisible, true);
  assert.equal(omniscient.record.scene.location, "北门");
  assert.deepEqual(omniscient.affordances, []);

  const malformed = normalizeRecordEnvelope({
    ok: true,
    record: projection(),
    writeToken: "opaque-write-token",
    viewer: { perspective: "admin", dynamicKnowledgeVisible: "yes" },
  });
  assert.equal(malformed.viewer.perspective, "character");
  assert.equal(malformed.viewer.dynamicKnowledgeVisible, false);
  assert.equal(malformed.viewer.characterInstanceId, null);
  assert.equal(malformed.record.world.era, "");
  assert.equal(malformed.record.story.status, "");
  assert.equal(malformed.record.stories[0]?.status, "");
  assert.equal(malformed.record.scene.location, "");
  assert.deepEqual(malformed.record.cast, []);
});

test("silent refresh equality treats cloned envelopes as equal but preserves changes", () => {
  const envelope = normalizeRecordEnvelope({
    ok: true,
    record: projection([committedEvent("event-1", 1)]),
    writeToken: "opaque-write-token",
    viewer: {
      cursor: "viewer-local",
      perspective: "character",
      characterInstanceId: "cast-1",
      dynamicKnowledgeVisible: true,
      membershipRole: "player",
    },
  });
  const clone = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
  assert.notStrictEqual(clone, envelope);
  assert.equal(recordEnvelopesEqual(envelope, clone), true);
  // writeToken 每次 load 都会重新签发（随机 opaque token）——dedup 必须
  // 忽略 token 轮换，否则静默刷新永远触发无效 setState。
  assert.equal(
    recordEnvelopesEqual(envelope, { ...clone, writeToken: "next-write-token" }),
    true,
  );
  // 数据变化（时间线新增事件）必须检出，不得跳过更新。
  const changed = {
    ...clone,
    record: {
      ...clone.record,
      events: [
        ...clone.record.events,
        committedEvent("event-2", 2),
      ],
    },
  };
  assert.equal(recordEnvelopesEqual(envelope, changed), false);
  assert.equal(recordEnvelopesEqual(envelope, null), false);
  assert.equal(recordEnvelopesEqual(null, null), true);
});

test("Record envelope accepts only complete server action affordances", () => {
  const normalized = normalizeRecordEnvelope({
    ok: true,
    record: projection(),
    writeToken: "opaque-write-token",
    viewer: {
      cursor: "viewer-local",
      perspective: "omniscient",
      characterInstanceId: null,
      dynamicKnowledgeVisible: true,
    },
    affordances: [
      {
        id: "skill.careful_observation.letter_seal",
        kind: "skill",
        actorCharacterInstanceId: "char_inst_player",
        actorName: "洛川",
        title: "细致观察",
        description: "辨认蜡封边缘。",
        suggestedText: "我仔细观察蜡封边缘。",
      },
      { id: "forged", kind: "admin" },
    ],
  });
  assert.equal(normalized.affordances.length, 1);
  assert.equal(normalized.affordances[0]?.id, "skill.careful_observation.letter_seal");
});

test("SSE parser accepts only committed viewer-local Events", () => {
  const accepted = normalizeCommittedEventPayload({
    event: committedEvent("event-2", 2),
  });
  assert.equal(accepted?.id, "event-2");
  assert.equal(accepted?.ordinal, 2);
  assert.equal(
    normalizeCommittedEventPayload({
      event: { ...committedEvent("event-3", 3), status: "pending" },
    }),
    null,
  );
  assert.equal(
    normalizeCommittedEventPayload({ event: committedEvent("event-0", 0) }),
    null,
  );
  const withoutOrdinal: Record<string, unknown> = {
    ...committedEvent("event-missing", 2),
  };
  delete withoutOrdinal.ordinal;
  assert.equal(normalizeCommittedEventPayload({ event: withoutOrdinal }), null);
  assert.equal(normalizeCommittedEventPayload(committedEvent("event-4", 4)), null);
});

test("committed replays upsert by id and never overwrite a pending Event", () => {
  const first = committedEvent("event-1", 1);
  const optimistic = createOptimisticEvent("向城门走去", "message-1", "今夜");
  const initial = projection([first, optimistic]);

  assert.equal(lastCommittedOrdinal(initial.events), 1);
  const protectedProjection = upsertCommittedEvent(
    initial,
    { ...committedEvent("message-1", 2), content: "服务器回应" },
  );
  assert.strictEqual(protectedProjection, initial);
  assert.equal(protectedProjection.events.at(-1)?.status, "pending");

  const withSecond = upsertCommittedEvent(initial, committedEvent("event-2", 2));
  assert.equal(withSecond.events.length, 3);
  assert.equal(lastCommittedOrdinal(withSecond.events), 2);
  const replay = upsertCommittedEvent(withSecond, committedEvent("event-2", 2));
  assert.equal(replay.events.filter((event) => event.id === "event-2").length, 1);
});

test("visibility labels distinguish OOC and restrained audience scopes", () => {
  assert.deepEqual(describeVisibility("public"), {
    label: null,
    isOutOfCharacter: false,
  });
  assert.equal(describeVisibility("scene").label, "同场可见");
  assert.equal(describeVisibility("restricted").label, "限定可见");
  assert.equal(describeVisibility("private").label, "仅你可见");
  assert.equal(describeVisibility("local-draft").label, "本地待提交");
  assert.deepEqual(describeVisibility("ooc:public"), {
    label: "上帝视角信息 · 当前角色未知",
    isOutOfCharacter: true,
  });
});

test("optimistic player input is a local draft rather than a private canonical Event", () => {
  const optimistic = createOptimisticEvent("你能听到我说话吗？", "local-draft-1", "今夜");
  assert.equal(optimistic.visibility, "local-draft");
  assert.equal(optimistic.status, "pending");
});

test("library snapshot normalizes nested worlds, stories and records", () => {
  const snapshot = normalizeLibrarySnapshot({
    worlds: [{
      id: "world-1",
      name: "白塔遗境",
      era: "灰历 300 年",
      summary: "一座拒绝被记录的高塔。",
      status: "active",
      stories: [{
        id: "story-1",
        title: "守塔人的最后一日",
        status: "draft",
        premise: "塔门第一次在正午开启。",
        records: [{ id: "record-1", title: "正午的访客", status: "draft" }],
      }],
    }],
  });
  assert.equal(snapshot.worlds[0]?.name, "白塔遗境");
  assert.equal(snapshot.worlds[0]?.stories[0]?.premise, "塔门第一次在正午开启。");
  assert.equal(snapshot.worlds[0]?.stories[0]?.records[0]?.title, "正午的访客");
  // 缺失 premise 的故事 fail-closed 为空串，不继承当前 Record 的前提。
  const bare = normalizeLibrarySnapshot({
    worlds: [{ id: "world-2", stories: [{ id: "story-2", title: "无前提" }] }],
  });
  assert.equal(bare.worlds[0]?.stories[0]?.premise, "");
});

test("cross-record fallback never leaks another world's strings", () => {
  const previous = projection();
  // 切换到另一条记录：载荷只携带新记录的最小信息时，
  // 旧记录的世界/故事/场景字符串一律不得继承。
  const switched = normalizeRecordProjection(
    {
      record: { id: "record-2", title: "新世界第一夜" },
      world: { id: "world-2", name: "云港志" },
      story: { id: "story-2", title: "雾中航船" },
      scene: { location: "", weather: "", tension: "", objective: "" },
      stories: [{ id: "story-2", title: "雾中航船", status: "active" }],
      records: [{ id: "record-2", title: "新世界第一夜", status: "active" }],
    },
    previous,
  );
  assert.equal(switched.world.name, "云港志");
  assert.equal(switched.story.title, "雾中航船");
  assert.equal(switched.scene.location, "");
  assert.equal(switched.scene.weather, "");
  assert.equal(switched.scene.tension, "");
  assert.equal(switched.scene.objective, "");
  assert.equal(switched.events.length, 0);
  assert.equal(switched.cast.length, 0);
  assert.deepEqual(
    switched.stories.map((story) => story.id),
    ["story-2"],
  );
  assert.deepEqual(
    switched.records.map((record) => record.id),
    ["record-2"],
  );

  // 同一条记录的局部载荷（如乐观草稿回包）仍允许继承既有字段。
  const sameRecord = normalizeRecordProjection(
    { record: { id: "record-1" } },
    previous,
  );
  assert.equal(sameRecord.world.name, "烬海");
  assert.equal(sameRecord.events.length, previous.events.length);
  assert.equal(sameRecord.scene.location, "北门");
});

test("world summary and story premise pass through, and never leak across records", () => {
  const withMeta = normalizeRecordProjection({
    record: { id: "record-1", title: "第一夜巡" },
    world: { id: "world-1", name: "烬海", summary: "烧尽之海上的浮城。" },
    story: { id: "story-1", title: "无声钟", premise: "钟声停下那一夜，守夜人失踪了。" },
  });
  assert.equal(withMeta.world.summary, "烧尽之海上的浮城。");
  assert.equal(withMeta.story.premise, "钟声停下那一夜，守夜人失踪了。");

  // 同记录局部载荷允许继承；跨记录切换不得继承摘要/前提。
  const previous = projection();
  const sameRecord = normalizeRecordProjection(
    { record: { id: "record-1" } },
    {
      ...previous,
      world: { ...previous.world, summary: "烧尽之海上的浮城。" },
      story: { ...previous.story, premise: "旧前提。" },
    },
  );
  assert.equal(sameRecord.world.summary, "烧尽之海上的浮城。");
  assert.equal(sameRecord.story.premise, "旧前提。");
  const switched = normalizeRecordProjection(
    { record: { id: "record-2", title: "新世界第一夜" } },
    sameRecord,
  );
  assert.equal(switched.world.summary, "");
  assert.equal(switched.story.premise, "");
});

test("page-level world/story views are wired to breadcrumb and snapshot data", () => {
  const client = readFileSync(
    new URL("../app/realm-client.tsx", import.meta.url),
    "utf8",
  );
  // 面包屑三级均为可点 button（aria-current 语义），不再是纯文本。
  assert.match(client, /breadcrumb-crumb/);
  assert.match(client, /aria-current=\{mainView === "world" \? "page" : undefined\}/);
  assert.match(client, /aria-current=\{mainView === "story" \? "page" : undefined\}/);
  assert.match(client, /aria-current=\{mainView === "record" \? "page" : undefined\}/);
  // 页面级视图组件接线；视图状态可深链（?view=）。
  assert.match(client, /<WorldView/);
  assert.match(client, /<StoryView/);
  assert.match(client, /searchParams\.get\("view"\)/);
  // 打开记录必须回落到记录视图。
  assert.match(client, /setMainViewState\("record"\)/);
});

test("story view selection carries the chosen story id end to end", () => {
  const client = readFileSync(
    new URL("../app/realm-client.tsx", import.meta.url),
    "utf8",
  );
  const worldView = readFileSync(
    new URL("../app/components/world-view.tsx", import.meta.url),
    "utf8",
  );
  const storyView = readFileSync(
    new URL("../app/components/story-view.tsx", import.meta.url),
    "utf8",
  );
  const navigation = readFileSync(
    new URL("../app/components/world-navigation.tsx", import.meta.url),
    "utf8",
  );
  // WorldView 每个故事按钮必须携带自身 id（不同故事不同 id）。
  assert.match(worldView, /data-story-id=\{story\.id\}/);
  assert.match(worldView, /onOpenStory\(story\.id\)/);
  // 主区保存被选 story 并写回 URL（深链 ?view=story&storyId= 可恢复）。
  assert.match(client, /selectedStoryId/);
  assert.match(client, /searchParams\.get\("storyId"\)/);
  assert.match(client, /searchParams\.set\("storyId", storyId\)/);
  // StoryView 按被选 story 渲染（snapshot 数据），不冒充当前 Record 的故事。
  assert.match(storyView, /data-story-id=\{story\.id\}/);
  assert.match(storyView, /story\.premise/);
  assert.match(storyView, /story\.records/);
  // 左侧导航 story/record 项是真实可操作入口，不再是纯文本 li。
  assert.match(navigation, /onOpenStory\(story\.id\)/);
  assert.match(navigation, /onOpenRecord\(record\.id\)/);
  assert.match(navigation, /className="nav-entry"/);
});

test("missing scene fields normalize to empty strings, never placeholder copy", () => {
  const bare = normalizeRecordProjection({
    record: { id: "record-9", title: "空场景" },
  });
  assert.equal(bare.scene.weather, "");
  assert.equal(bare.scene.tension, "");
  assert.equal(bare.scene.objective, "");
  assert.equal(bare.scene.location, "");
  assert.equal(bare.scene.worldTime, "");
  assert.equal(bare.world.name, "");
  assert.deepEqual(bare.stories, []);
  assert.deepEqual(bare.records, []);
});

test("frontend sends the opaque write token and subscribes to committed SSE", () => {
  const source = readFileSync(
    new URL("../app/realm-client.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /writeToken:\s*envelope\.writeToken/);
  assert.match(source, /actionSelection/);
  assert.doesNotMatch(source, /expectedVersion/);
  assert.match(source, /new EventSource\(`/);
  assert.match(source, /\/api\/record\/events\?/);
  assert.match(source, /addEventListener\("committed"/);
  assert.match(source, /scheduleRecordEnvelopeRefresh/);
  assert.match(source, /loadRecord\(streamRecordId, \{ silent: true \}\)/);
});

test("legacy prompt-boundary wording is hidden from the delivered timeline", () => {
  const normalized = normalizeRecordProjection({
    record: { id: "record-1" },
    events: [{
      id: "event-leak",
      ordinal: 1,
      type: "utterance",
      role: "character",
      speaker: "克罗姆",
      content: "动作\n“所得结果只应作为当前场景中的直接认知。”",
      segments: [
        { id: "action-1", kind: "action", content: "动作", speechMode: "narrator" },
        {
          id: "dialogue-1",
          kind: "dialogue",
          content: "“所得结果只应作为当前场景中的直接认知。”",
          speechMode: "speaker",
        },
      ],
      status: "committed",
    }],
  });
  assert.deepEqual(normalized.events[0]?.segments.map((segment) => segment.kind), ["action"]);
});

test("legacy public fact is not rendered as character dialogue", () => {
  const normalized = normalizeRecordProjection({
    record: { id: "record-1" },
    events: [
      {
        id: "narrator-fact",
        ordinal: 1,
        type: "narration",
        role: "narrator",
        speaker: "旁白",
        content: "克罗姆开始按自己的判断确认眼前的情况。",
        segments: [{
          id: "fact-1",
          kind: "fact",
          content: "克罗姆开始按自己的判断确认眼前的情况。",
          speechMode: "narrator",
        }],
        status: "committed",
      },
      {
        id: "character-leak",
        ordinal: 2,
        type: "utterance",
        role: "character",
        speaker: "克罗姆",
        content: "动作\n“克罗姆开始按自己的判断确认眼前的情况。”",
        segments: [
          { id: "action-1", kind: "action", content: "动作", speechMode: "narrator" },
          {
            id: "dialogue-1",
            kind: "dialogue",
            content: "“克罗姆开始按自己的判断确认眼前的情况。”",
            speechMode: "speaker",
          },
        ],
        status: "committed",
      },
    ],
  });
  assert.deepEqual(normalized.events[0]?.segments.map((segment) => segment.kind), ["fact"]);
  assert.deepEqual(normalized.events[1]?.segments.map((segment) => segment.kind), ["action"]);
  assert.equal(normalized.events[1]?.content, "动作");
});

test("semantic reveal stays stable across self-play projection polls", () => {
  const source = readFileSync(
    new URL("../app/components/semantic-event-content.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /segmentSignature/);
  assert.match(source, /stableSegments/);
  assert.doesNotMatch(source, /\[reveal, segments\]/);
});

test("generic skill judgment wording is not rendered as character dialogue", () => {
  const normalized = normalizeRecordProjection({
    record: { id: "record-1" },
    events: [{
      id: "skill-private-leak",
      ordinal: 1,
      type: "utterance",
      role: "character",
      speaker: "克罗姆",
      content: "记录下编码。\n“眼前的结果足以让角色形成直接判断。”",
      segments: [
        { id: "action-1", kind: "action", content: "记录下编码。", speechMode: "narrator" },
        {
          id: "dialogue-1",
          kind: "dialogue",
          content: "“眼前的结果足以让角色形成直接判断。”",
          speechMode: "speaker",
        },
      ],
      status: "committed",
    }],
  });
  assert.deepEqual(normalized.events[0]?.segments.map((segment) => segment.kind), ["action"]);
  assert.equal(normalized.events[0]?.content, "记录下编码。");
});

test("record duplication and canon confirmation stay behind explicit UI/API actions", () => {
  const source = readFileSync(new URL("../app/realm-client.tsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/record\/duplicate/);
  assert.match(source, /\/api\/record\/retrospection\/commit/);
  assert.match(source, /confirm:\s*true/);
  assert.match(source, /ui\.record\.canonizeSecondWarning/);
  assert.match(source, /timelineKind === "retrospection"/);
});

test("retrospection canon route requires confirmation and dry-runs before merge", () => {
  const source = readFileSync(
    new URL("../app/api/record/retrospection/commit/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /body\.confirm !== true/);
  assert.match(source, /dryRun: true/);
  assert.match(source, /const merged = await service\.merge/);
});

test("canon qualification normalizer is fail-closed", async () => {
  const { normalizeCanonQualification } = await import(
    "../app/components/knowledge-graph-types.ts"
  );
  // 合法载荷完整通过。
  const valid = normalizeCanonQualification({
    qualification: {
      scope: { worldId: "w1", worldlineId: "line1" },
      membershipRole: "owner",
      continuities: [{ id: "cont_1", displayName: "塞娜" }],
      topology: {
        nodes: [
          { key: "canon_origin", clearance: "secret" },
          { key: "safehouse", clearance: "secret" },
        ],
        routes: [{
          from: "canon_origin",
          to: "safehouse",
          channel: "private_letter",
          recipient: "safehouse",
        }],
        nodeAudiences: [{ nodeKey: "safehouse", continuityId: "cont_1" }],
        secretReady: true,
      },
    },
  });
  assert.equal(valid?.membershipRole, "owner");
  assert.equal(valid?.topology.secretReady, true);
  assert.equal(valid?.continuities[0]?.displayName, "塞娜");
  // 缺字段/坏结构一律 null（UI 隐藏 non-public 控件）。
  assert.equal(normalizeCanonQualification(null), null);
  assert.equal(normalizeCanonQualification({}), null);
  assert.equal(
    normalizeCanonQualification({
      qualification: { membershipRole: "owner", scope: { worldId: "w1" } },
    }),
    null,
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [],
        topology: { nodes: [], routes: [], nodeAudiences: [] },
      },
    }),
    null,
    "缺 secretReady 布尔值必须 fail-closed",
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [{ id: 42, displayName: "伪造" }],
        topology: { nodes: [], routes: [], nodeAudiences: [], secretReady: false },
      },
    }),
    null,
    "嵌套 continuity id 非字符串必须 fail-closed",
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [{ id: "cont_1", displayName: "塞娜" }],
        topology: {
          nodes: [{ key: "origin", clearance: "public" }],
          routes: [],
          nodeAudiences: [{ nodeKey: "missing", continuityId: "cont_1" }],
          secretReady: false,
        },
      },
    }),
    null,
    "mapping 引用未知 node 必须 fail-closed",
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [{ id: "cont_1", displayName: "塞娜" }],
        topology: {
          nodes: [{ key: "origin", clearance: "public" }],
          routes: [],
          nodeAudiences: [{ nodeKey: "origin", continuityId: "missing" }],
          secretReady: false,
        },
      },
    }),
    null,
    "mapping 引用未知 continuity 必须 fail-closed",
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [{ id: "cont_1", displayName: "塞娜" }],
        topology: {
          nodes: [{ key: "origin", clearance: "public" }],
          routes: [],
          nodeAudiences: [
            { nodeKey: "origin", continuityId: "cont_1" },
            { nodeKey: "origin", continuityId: "cont_1" },
          ],
          secretReady: false,
        },
      },
    }),
    null,
    "重复 mapping 必须 fail-closed",
  );
  assert.equal(
    normalizeCanonQualification({
      qualification: {
        scope: { worldId: "w1", worldlineId: "l1" },
        membershipRole: "owner",
        continuities: [],
        topology: {
          nodes: [{ key: "origin", clearance: "public" }],
          routes: [{ from: "origin", to: "missing", channel: "official_bulletin", recipient: null }],
          nodeAudiences: [],
          secretReady: false,
        },
      },
    }),
    null,
    "route 端点引用未知 node 必须 fail-closed",
  );
});

test("audience append response requires an exact server contract", async () => {
  const { normalizeAudienceAppendResponse } = await import(
    "../app/components/knowledge-graph-types.ts"
  );
  assert.deepEqual(
    normalizeAudienceAppendResponse(
      { ok: true, added: true, nodeKey: "safehouse", continuityId: "cont_1" },
      "safehouse",
      "cont_1",
    ),
    { added: true },
  );
  assert.deepEqual(
    normalizeAudienceAppendResponse(
      { ok: true, added: false, nodeKey: "safehouse", continuityId: "cont_1" },
      "safehouse",
      "cont_1",
    ),
    { added: false },
  );
  assert.equal(
    normalizeAudienceAppendResponse(
      { ok: true, added: true, nodeKey: "other", continuityId: "cont_1" },
      "safehouse",
      "cont_1",
    ),
    null,
  );
  assert.equal(
    normalizeAudienceAppendResponse({ ok: true, added: "yes" }, "safehouse", "cont_1"),
    null,
  );
  assert.equal(normalizeAudienceAppendResponse({ ok: false }, "safehouse", "cont_1"), null);
});

/**
 * Client/server 模块边界（Prompt System v2 后续边界修复）：
 * 浏览器报 `node:fs/promises has been externalized` 的根因是 use client 入口
 * runtime import 了带模型调用的 server module。本测试递归遍历 client 入口的
 * 依赖图（import/export...from，含 type-only 以外的全部 runtime 边），
 * 断言 server-only 模块永远不可达；未来有人重新 export 时本测试先红。
 */
test("client entries never reach server-only inference/settings modules", () => {
  const root = new URL("..", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const FORBIDDEN = [
    "modules/inference/public.ts",
    "modules/inference/local-settings.ts",
    "modules/inference/openai-compatible-gateway.ts",
    "modules/inference/structured-output.ts",
    "modules/inference/prompt-kit.ts",
    "modules/application/model-settings-service.ts",
    "modules/application/world-genesis.ts",
    "modules/application/genesis-chat.ts",
  ];
  const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".d.ts"];

  const seen = new Set<string>();
  // 入口 = app/ 下所有 "use client" 组件（server component 可合法用 node:*，
  // 不在边界内）。扫描目录动态发现，新 client 组件自动纳入。
  const stack: string[] = [];
  function collectClientEntries(directory: string) {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
      const relative = `${directory}${entry.name}`;
      if (entry.isDirectory()) {
        collectClientEntries(`${relative}/`);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const source = read(relative);
      if (/^["']use client["']/.test(source.trimStart())) stack.push(relative);
    }
  }
  collectClientEntries("app/");
  assert.ok(stack.length > 0, "必须发现至少一个 client 入口");
  const offenders: string[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = read(current);
    // type-only import/export 在构建期完全擦除，不构成 runtime 边。
    const statements = source.matchAll(
      /(?:import|export)\s+(?!type\b)(?:[\w*{}\s,]*?\s+from\s+)?["']([^"']+)["']/g,
    );
    for (const statement of statements) {
      const specifier = statement[1]!;
      if (specifier.startsWith("node:")) {
        offenders.push(`${current} -> ${specifier}`);
        continue;
      }
      if (!specifier.startsWith(".")) continue;
      const base = new URL(specifier, new URL(`${current}`, root));
      let resolved: string | null = null;
      for (const extension of RESOLVE_EXTENSIONS) {
        const candidate = base.pathname.endsWith(extension)
          ? base.pathname
          : `${base.pathname}${extension}`;
        try {
          readFileSync(candidate);
          resolved = candidate;
          break;
        } catch {
          // try next extension
        }
      }
      if (!resolved) continue;
      const relative = resolved.replace(root.pathname, "");
      if (FORBIDDEN.includes(relative)) {
        offenders.push(`${current} -> ${relative}`);
        continue;
      }
      if (!seen.has(relative)) stack.push(relative);
    }
  }
  assert.deepEqual(offenders, [], "client bundle 不得可达 server-only 模块");
});
