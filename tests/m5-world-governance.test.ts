import assert from "node:assert/strict";
import test from "node:test";
import {
  WorldKnowledgeError,
  assertPromotionAllowed,
  type WorldClaim,
} from "../modules/world-knowledge/public.ts";
import { detectCausalConflicts } from "../modules/worldline/conflict-detection.ts";
import {
  PROPAGATION_ALGORITHM_VERSION,
  propagate,
  type ChannelRoute,
  type InformationPacket,
  type SocialNode,
} from "../modules/propagation/public.ts";
import {
  createPropagationWorker,
  type PropagationJobQueue,
} from "../modules/propagation/worker.ts";

function claim(overrides: Partial<WorldClaim> = {}): WorldClaim {
  return {
    id: "claim_1",
    subjectEntityId: "entity_milo",
    predicate: "life_state",
    objectValue: "alive",
    scope: "story",
    truthStatus: "story_canon",
    confidence: 1,
    validFromTick: 100,
    validToTick: null,
    sourceRecordId: null,
    sourceEventId: null,
    supersedesClaimId: null,
    ...overrides,
  };
}

test("truth ladder promotion only moves forward; side states always allowed", () => {
  assert.doesNotThrow(() => assertPromotionAllowed("mentioned", "record_confirmed"));
  assert.doesNotThrow(() => assertPromotionAllowed("record_confirmed", "story_canon"));
  assert.throws(
    () => assertPromotionAllowed("story_canon", "mentioned"),
    WorldKnowledgeError,
  );
  assert.throws(
    () => assertPromotionAllowed("world_canon", "story_canon"),
    WorldKnowledgeError,
  );
  assert.doesNotThrow(() => assertPromotionAllowed("story_canon", "disputed"));
  assert.doesNotThrow(() => assertPromotionAllowed("story_canon", "deprecated"));
});

test("killing a character in the past who acts in the future is a hard conflict", () => {
  const futureDeed = claim({
    id: "claim_future_deed",
    predicate: "performs",
    objectValue: "译出灯塔铭文",
    validFromTick: 200,
  });
  const report = detectCausalConflicts({
    changeSet: {
      changes: [{
        kind: "terminate",
        subjectEntityId: "entity_milo",
        predicate: "life_state",
        objectValue: "dead",
        targetClaimId: "claim_1",
        effectiveCursor: { tick: 150, ordinal: 0, calendarId: "", display: "" },
      }],
    },
    existingClaims: [claim(), futureDeed],
    causalEdges: [],
    existingFutureCursor: { tick: 300, ordinal: 0, calendarId: "", display: "" },
  });
  assert.equal(report.deterministic.length, 1);
  assert.equal(report.deterministic[0]?.conflictingClaimId, "claim_future_deed");
  assert.equal(report.classification.conflict, "hard");
  assert.equal(report.classification.shouldBranch, true);
});

test("rewriting a claim that later claims depend on is a dependency conflict", () => {
  const report = detectCausalConflicts({
    changeSet: {
      changes: [{
        kind: "supersede",
        subjectEntityId: "entity_port",
        predicate: "ruled_by",
        objectValue: "议会",
        targetClaimId: "claim_rule",
        effectiveCursor: { tick: 50, ordinal: 0, calendarId: "", display: "" },
      }],
    },
    existingClaims: [
      claim({ id: "claim_rule", subjectEntityId: "entity_port" }),
      claim({ id: "claim_policy", subjectEntityId: "entity_port", validFromTick: 120 }),
    ],
    causalEdges: [{
      id: "edge_1",
      fromClaimId: "claim_rule",
      toClaimId: "claim_policy",
      edgeKind: "enables",
    }],
    existingFutureCursor: { tick: 300, ordinal: 0, calendarId: "", display: "" },
  });
  assert.equal(report.deterministic.length, 0);
  assert.equal(report.dependency.length, 1);
  assert.equal(report.classification.conflict, "bridgeable");
  assert.equal(report.classification.shouldBranch, true);
});

test("a past change without anchors defaults to recommending a branch", () => {
  const report = detectCausalConflicts({
    changeSet: {
      changes: [{
        kind: "assert",
        subjectEntityId: "entity_port",
        predicate: "weather",
        objectValue: "雾散",
        effectiveCursor: { tick: 50, ordinal: 0, calendarId: "", display: "" },
      }],
    },
    existingClaims: [],
    causalEdges: [],
    existingFutureCursor: { tick: 300, ordinal: 0, calendarId: "", display: "" },
  });
  assert.equal(report.classification.conflict, "high-risk");
  assert.equal(report.classification.shouldBranch, true);
});

const NODES: SocialNode[] = [
  { key: "herald", clearance: "public" },
  { key: "market", clearance: "public" },
  { key: "tavern", clearance: "public" },
  { key: "envoy", clearance: "secret" },
  { key: "isolated", clearance: "public" },
];

const ROUTES: ChannelRoute[] = [
  { from: "herald", to: "market", channel: "official_bulletin", distance: 2 },
  { from: "market", to: "tavern", channel: "market_rumor", distance: 1 },
  { from: "herald", to: "envoy", channel: "private_letter", distance: 3, recipient: "envoy" },
  { from: "herald", to: "envoy", channel: "private_letter", distance: 1, recipient: "someone_else" },
];

function rootPacket(claimIds: readonly string[]): InformationPacket {
  return {
    id: "packet_root",
    campaignId: "camp_1",
    parentPacketId: null,
    channel: "official_bulletin",
    claimIds,
    framing: "official",
    omittedClaimIds: [],
    semanticFidelityToParent: 1,
    contentHash: "root",
  };
}

const CLAIM_IDS = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"];

function runPropagation() {
  return propagate({
    campaign: {
      id: "camp_1",
      securityClass: "public",
      effectiveTick: 10,
      salience: 0.8,
      complexity: 0.3,
    },
    roots: [{ nodeKey: "herald", packet: rootPacket(CLAIM_IDS) }],
    nodes: NODES,
    routes: ROUTES,
  });
}

test("propagation is deterministic and reproducible byte for byte", () => {
  const first = runPropagation();
  const second = runPropagation();
  assert.deepEqual(first, second);
  assert.equal(first.algorithmVersion, PROPAGATION_ALGORITHM_VERSION);
});

test("bulletin, rumor and letter produce different reproducible outcomes", () => {
  const result = runPropagation();
  const byNode = new Map(result.exposures.map((exposure) => [exposure.nodeKey, exposure]));

  // 官方公告：保真 0.95，延迟 2*2=4。
  assert.equal(byNode.get("market")?.channel, "official_bulletin");
  assert.equal(byNode.get("market")?.arrivalTick, 14);
  assert.equal(byNode.get("market")?.fidelity, 0.95);

  // 商队传闻：在公告基础上再衰减（0.95*0.6），保真更低、内容有省略。
  assert.equal(byNode.get("tavern")?.channel, "market_rumor");
  assert.equal(byNode.get("tavern")?.fidelity, 0.57);
  const rumorPacket = result.packets.find(
    (packet) => packet.id === byNode.get("tavern")?.packetId,
  );
  assert.equal(rumorPacket?.framing, "rumor");
  assert.ok((rumorPacket?.omittedClaimIds.length ?? 0) > 0);
  assert.ok(
    (rumorPacket?.claimIds.length ?? 0)
      + (rumorPacket?.omittedClaimIds.length ?? 0)
      === CLAIM_IDS.length,
  );
  assert.equal(rumorPacket?.parentPacketId, byNode.get("market")?.packetId);

  // 密信：只到指定收件人；另一封收件人不符的信不产生 Exposure。
  assert.equal(byNode.get("envoy")?.channel, "private_letter");
  assert.equal(byNode.get("envoy")?.arrivalTick, 22);
  const letterPackets = result.packets.filter(
    (packet) => packet.channel === "private_letter",
  );
  assert.equal(letterPackets.length, 1);

  // 无路由节点不获得任何内容。
  assert.equal(byNode.has("isolated"), false);
});

test("secret campaigns cannot travel via public channels", () => {
  const secretNodes: SocialNode[] = [
    ...NODES,
    { key: "secret_market", clearance: "secret" },
  ];
  const result = propagate({
    campaign: {
      id: "camp_secret",
      securityClass: "secret",
      effectiveTick: 0,
      salience: 0.9,
      complexity: 0.8,
    },
    roots: [{
      nodeKey: "envoy",
      packet: { ...rootPacket(["c1"]), channel: "private_letter" },
    }],
    nodes: secretNodes,
    routes: [
      { from: "envoy", to: "herald", channel: "official_bulletin", distance: 1 },
      { from: "envoy", to: "secret_market", channel: "market_rumor", distance: 1 },
      { from: "envoy", to: "market", channel: "private_letter", distance: 1, recipient: "market" },
    ],
  });
  // 公告与传闻渠道都被秘密级排除；不是因为目标节点 clearance 不够。
  assert.equal(result.exposures.some((exposure) => exposure.nodeKey === "herald"), false);
  assert.equal(result.exposures.some((exposure) => exposure.nodeKey === "secret_market"), false);
  // market 节点 clearance 为 public，不满足 secret 安全级。
  assert.equal(result.exposures.some((exposure) => exposure.nodeKey === "market"), false);
});

test("worker permanently rejects a non-public job with a mismatched frozen audience digest", async () => {
  let completeCalled = false;
  let failedError: string | null = null;
  const queue: PropagationJobQueue = {
    enqueue: async () => {},
    claimNext: async () => ({
      scope: { workspaceId: "ws_test", worldId: "world_test", worldlineId: "worldline_test" },
      job: {
        id: "job_invalid_audience_digest",
        campaignId: "campaign_invalid_audience_digest",
        input: {
          campaign: {
            id: "campaign_invalid_audience_digest",
            securityClass: "restricted",
            effectiveTick: 0,
            salience: 0.5,
            complexity: 0.5,
          },
          roots: [{
            nodeKey: "canon_origin",
            packet: {
              ...rootPacket(["c1"]),
              campaignId: "campaign_invalid_audience_digest",
            },
          }],
          nodes: [{ key: "canon_origin", clearance: "restricted" }],
          routes: [],
          topologyVersion: "test",
          canonRevisionId: "revision_invalid_audience_digest",
          audienceContinuityIds: ["continuity_a"],
          audienceDigest: "000000000000000000000000",
        },
        status: "running",
        attempts: 1,
        lastError: null,
      },
      lease: { jobId: "job_invalid_audience_digest", attempts: 1 },
    }),
    completeRun: async () => {
      completeCalled = true;
    },
    markFailed: async (_scope, _lease, error) => {
      failedError = error;
      return { staleIgnored: false };
    },
    recoverStale: async () => 0,
    retry: async () => {},
    stats: async () => ({ pending: 0, running: 0, done: 0, failed: 1 }),
  };
  const worker = createPropagationWorker({ queue });
  assert.equal(await worker.runOnce("ws_test"), "failed");
  assert.equal(completeCalled, false);
  assert.match(failedError ?? "", /invalid frozen audience digest/);
});
