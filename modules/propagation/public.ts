/**
 * M5 deterministic social propagation engine (realm-propagate-v1).
 *
 * Canon Claims, in-transit Packets and character knowledge stay strictly
 * separate. No route, no knowledge: identity, interest and intelligence can
 * never create contact out of thin air. Every "random" choice is driven by
 * content hashes, so replaying a run is byte-for-byte reproducible. The
 * engine only produces cognition (Exposures); it never writes world facts.
 */

import { createHash } from "node:crypto";

export const PROPAGATION_ALGORITHM_VERSION = "realm-propagate-v1";

export type ChannelKind = "official_bulletin" | "private_letter" | "market_rumor";
export type SecurityClass = "public" | "restricted" | "secret";

export type SocialNode = {
  key: string;
  /** Highest security class the node may receive. */
  clearance: SecurityClass;
};

export type ChannelRoute = {
  from: string;
  to: string;
  channel: ChannelKind;
  /** Multiplier on the channel base latency. */
  distance: number;
  /** private_letter only: the single intended recipient. */
  recipient?: string;
};

export type InformationCampaign = {
  id: string;
  securityClass: SecurityClass;
  effectiveTick: number;
  salience: number;
  complexity: number;
};

export type InformationPacket = {
  id: string;
  campaignId: string;
  parentPacketId: string | null;
  channel: ChannelKind;
  claimIds: readonly string[];
  framing: string;
  omittedClaimIds: readonly string[];
  semanticFidelityToParent: number;
  contentHash: string;
};

export type PropagationExposure = {
  nodeKey: string;
  packetId: string;
  channel: ChannelKind;
  arrivalTick: number;
  fidelity: number;
};

export type PropagationResult = {
  packets: readonly InformationPacket[];
  exposures: readonly PropagationExposure[];
  algorithmVersion: string;
};

type ChannelSpec = {
  baseLatency: number;
  baseFidelity: number;
  distorts: boolean;
};

const CHANNELS: Record<ChannelKind, ChannelSpec> = {
  official_bulletin: { baseLatency: 2, baseFidelity: 0.95, distorts: false },
  private_letter: { baseLatency: 4, baseFidelity: 0.9, distorts: false },
  market_rumor: { baseLatency: 1, baseFidelity: 0.6, distorts: true },
};

const CLEARANCE_RANK: Record<SecurityClass, number> = {
  public: 0,
  restricted: 1,
  secret: 2,
};

export function propagate(input: {
  campaign: InformationCampaign;
  /** Root packets with their origin node keys. */
  roots: readonly { nodeKey: string; packet: InformationPacket }[];
  nodes: readonly SocialNode[];
  routes: readonly ChannelRoute[];
  idFactory?: () => string;
}): PropagationResult {
  // 默认 idFactory 必须确定：同一输入重放产生逐字节一致的结果。
  let autoId = 0;
  const idFactory = input.idFactory ?? (() => `auto_${++autoId}`);
  const nodes = new Map(input.nodes.map((node) => [node.key, node]));
  const packets: InformationPacket[] = input.roots.map((root) => root.packet);
  const exposures = new Map<string, PropagationExposure>();
  const queue: { nodeKey: string; packet: InformationPacket; arrivalTick: number; fidelity: number }[] =
    [];

  for (const root of input.roots) {
    if (!mayReceive(nodes.get(root.nodeKey), input.campaign.securityClass)) continue;
    queue.push({
      nodeKey: root.nodeKey,
      packet: root.packet,
      arrivalTick: input.campaign.effectiveTick,
      fidelity: 1,
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const existing = exposures.get(current.nodeKey);
    if (
      existing
      && existing.arrivalTick <= current.arrivalTick
    ) {
      continue;
    }
    exposures.set(current.nodeKey, {
      nodeKey: current.nodeKey,
      packetId: current.packet.id,
      channel: current.packet.channel,
      arrivalTick: current.arrivalTick,
      fidelity: current.fidelity,
    });

    for (const route of input.routes) {
      if (route.from !== current.nodeKey) continue;
      const target = nodes.get(route.to);
      if (!target) continue;
      if (!channelAllowedForCampaign(route.channel, input.campaign.securityClass)) {
        continue;
      }
      if (!mayReceive(target, input.campaign.securityClass)) continue;
      if (route.channel === "private_letter" && route.recipient !== route.to) {
        continue;
      }
      const spec = CHANNELS[route.channel];
      const arrivalTick = current.arrivalTick
        + Math.max(0, Math.round(spec.baseLatency * Math.max(route.distance, 0)));
      const fidelity = round4(current.fidelity * spec.baseFidelity);
      const packet = spec.distorts
        ? distortPacket(current.packet, route.channel, idFactory)
        : forwardPacket(current.packet, route.channel, spec.baseFidelity, idFactory);
      packets.push(packet);
      queue.push({
        nodeKey: route.to,
        packet,
        arrivalTick,
        fidelity,
      });
    }
  }

  return {
    packets,
    exposures: [...exposures.values()].sort((left, right) =>
      left.arrivalTick - right.arrivalTick
      || left.nodeKey.localeCompare(right.nodeKey)
    ),
    algorithmVersion: PROPAGATION_ALGORITHM_VERSION,
  };
}

function mayReceive(node: SocialNode | undefined, securityClass: SecurityClass): boolean {
  if (!node) return false;
  return CLEARANCE_RANK[node.clearance] >= CLEARANCE_RANK[securityClass];
}

function channelAllowedForCampaign(
  channel: ChannelKind,
  securityClass: SecurityClass,
): boolean {
  // secret 第一阶段只允许 private_letter；其他 channel 不是“降级”，
  // 而是不可接受的资格路径。Canon merge 侧也会提前拒绝不合规拓扑，
  // 这里再守一层，防止手工/旧 Job 绕过入口。
  if (securityClass === "secret" && channel !== "private_letter") return false;
  return true;
}

function forwardPacket(
  parent: InformationPacket,
  channel: ChannelKind,
  fidelityToParent: number,
  idFactory: () => string,
): InformationPacket {
  const id = `packet_${idFactory()}`;
  return {
    id,
    campaignId: parent.campaignId,
    parentPacketId: parent.id,
    channel,
    claimIds: parent.claimIds,
    framing: parent.framing,
    omittedClaimIds: parent.omittedClaimIds,
    semanticFidelityToParent: fidelityToParent,
    contentHash: packetHash(id, parent.claimIds, parent.omittedClaimIds, parent.framing),
  };
}

/**
 * Rumor distortion: deterministically omits roughly one third of the claims
 * (content-hash driven) and reframes the packet as rumor. The child packet
 * is new and immutable; the parent text is never overwritten.
 */
function distortPacket(
  parent: InformationPacket,
  channel: ChannelKind,
  idFactory: () => string,
): InformationPacket {
  const omitted = new Set(parent.omittedClaimIds);
  const kept: string[] = [];
  for (const claimId of parent.claimIds) {
    if (fnv1a(`${parent.id}:${claimId}`) % 3 === 0) omitted.add(claimId);
    else kept.push(claimId);
  }
  const id = `packet_${idFactory()}`;
  const omittedList = [...omitted].sort();
  return {
    id,
    campaignId: parent.campaignId,
    parentPacketId: parent.id,
    channel,
    claimIds: kept,
    framing: "rumor",
    omittedClaimIds: omittedList,
    semanticFidelityToParent: CHANNELS.market_rumor.baseFidelity,
    contentHash: packetHash(id, kept, omittedList, "rumor"),
  };
}

function packetHash(
  id: string,
  claimIds: readonly string[],
  omittedClaimIds: readonly string[],
  framing: string,
): string {
  return createHash("sha256")
    .update([id, claimIds.join(","), omittedClaimIds.join(","), framing].join(":"))
    .digest("hex");
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function fnv1a(content: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
