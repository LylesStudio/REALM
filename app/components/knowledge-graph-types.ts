export type GraphEntity = {
  id: string;
  entityKind: "geography" | "history" | "setting" | "faction" | "person" | "other";
  name: string;
  summary: string;
};

export type GraphClaim = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectValue: string;
  scope: "record" | "story" | "world";
  truthStatus: string;
};

type GraphRelation = {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string;
  sourceClaimId: string;
};

export type GraphArticle = {
  id: string;
  title: string;
  /**
   * 批次 SWM-G5：正文由服务端按「资格状态 × 角色」矩阵门控——非 owner 对
   * pending/rejected/revoked 文章收到空串（前端不做权限判断）。
   */
  body: string;
  claimIds: readonly string[];
  sourceEventIds: readonly string[];
  /** 资格状态（缺省 = pending_review，无资格行 fail-closed）。 */
  qualificationStatus?: "pending_review" | "qualified_public" | "rejected" | "revoked";
  /** 授权生效 Record cursor——两个分量要么齐全要么都不展示（禁丢 ordinal）。 */
  availableFromTick?: number;
  availableFromOrdinal?: number;
};

/** 批次 SWM-G5：资格状态徽标文案（图谱面板文章条目）。 */
export const ARTICLE_QUALIFICATION_LABELS: Record<
  NonNullable<GraphArticle["qualificationStatus"]>,
  string
> = {
  pending_review: "待审",
  qualified_public: "已授权",
  rejected: "已拒绝",
  revoked: "已撤销",
};

export type CanonProposalItem = {
  id: string;
  targetLevel: "story" | "worldline";
  articleId: string | null;
  claimIds: readonly string[];
  rationale: string;
  status: "pending" | "merged" | "rejected" | "deferred";
  proposedBy: string;
};

export type KnowledgeGraphSnapshot = {
  entities: readonly GraphEntity[];
  claims: readonly GraphClaim[];
  relations: readonly GraphRelation[];
  articles: readonly GraphArticle[];
};

export function normalizeGraphSnapshot(value: unknown): KnowledgeGraphSnapshot {
  const source = (value ?? {}) as Record<string, unknown>;
  return {
    entities: Array.isArray(source.entities) ? source.entities as GraphEntity[] : [],
    claims: Array.isArray(source.claims) ? source.claims as GraphClaim[] : [],
    relations: Array.isArray(source.relations) ? source.relations as GraphRelation[] : [],
    articles: Array.isArray(source.articles) ? source.articles as GraphArticle[] : [],
  };
}

export function normalizeCanonProposals(value: unknown): readonly CanonProposalItem[] {
  const source = (value ?? {}) as Record<string, unknown>;
  return Array.isArray(source.proposals)
    ? source.proposals as CanonProposalItem[]
    : [];
}

/** 批次 T11-H：Canon 资格预检（GET /api/canon?view=qualification）。 */
export type CanonQualification = {
  scope: { worldId: string; worldlineId: string };
  membershipRole: string;
  continuities: readonly { id: string; displayName: string }[];
  topology: {
    nodes: readonly { key: string; clearance: string }[];
    routes: readonly {
      from: string;
      to: string;
      channel: string;
      recipient: string | null;
    }[];
    nodeAudiences: readonly { nodeKey: string; continuityId: string }[];
    secretReady: boolean;
  };
};

/** fail-closed：结构不合法返回 null（UI 隐藏 non-public 控件）。 */
export function normalizeCanonQualification(value: unknown): CanonQualification | null {
  const source = asRecord(value);
  const qualification = asRecord(source?.qualification);
  const scope = asRecord(qualification?.scope);
  const topology = asRecord(qualification?.topology);
  const membershipRole = qualification?.membershipRole;
  if (
    !scope
    || !topology
    || !isNonEmptyString(scope.worldId)
    || !isNonEmptyString(scope.worldlineId)
    || !["owner", "player", "observer"].includes(membershipRole as string)
    || !Array.isArray(qualification?.continuities)
    || !Array.isArray(topology.nodes)
    || !Array.isArray(topology.routes)
    || !Array.isArray(topology.nodeAudiences)
    || typeof topology.secretReady !== "boolean"
  ) {
    return null;
  }

  const continuities = qualification.continuities.flatMap((value) => {
    const item = asRecord(value);
    if (!item || !isNonEmptyString(item.id) || !isNonEmptyString(item.displayName)) return [];
    return [{ id: item.id, displayName: item.displayName }];
  });
  if (
    continuities.length !== qualification.continuities.length
    || hasDuplicate(continuities.map((item) => item.id))
  ) return null;

  const nodes = topology.nodes.flatMap((value) => {
    const item = asRecord(value);
    const clearance = item?.clearance;
    if (
      !item
      || !isNonEmptyString(item.key)
      || typeof clearance !== "string"
      || !["public", "restricted", "secret"].includes(clearance)
    ) return [];
    return [{ key: item.key, clearance }];
  });
  if (
    nodes.length !== topology.nodes.length
    || hasDuplicate(nodes.map((item) => item.key))
  ) return null;

  const routes = topology.routes.flatMap((value) => {
    const item = asRecord(value);
    const channel = item?.channel;
    const recipient = item?.recipient;
    if (
      !item
      || !isNonEmptyString(item.from)
      || !isNonEmptyString(item.to)
      || typeof channel !== "string"
      || !["official_bulletin", "private_letter", "market_rumor"].includes(channel)
      || !(recipient === null || isNonEmptyString(recipient))
      || (channel === "private_letter" && recipient === null)
    ) return [];
    return [{
      from: item.from,
      to: item.to,
      channel,
      recipient,
    }];
  });
  if (
    routes.length !== topology.routes.length
    || hasDuplicate(routes.map((route) => `${route.from}\u0000${route.to}\u0000${route.channel}\u0000${route.recipient ?? ""}`))
  ) return null;

  const nodeKeys = new Set(nodes.map((node) => node.key));
  if (routes.some((route) =>
    !nodeKeys.has(route.from)
    || !nodeKeys.has(route.to)
    || route.from === route.to
    || (route.recipient !== null && !nodeKeys.has(route.recipient))
  )) return null;

  const nodeAudiences = topology.nodeAudiences.flatMap((value) => {
    const item = asRecord(value);
    if (!item || !isNonEmptyString(item.nodeKey) || !isNonEmptyString(item.continuityId)) return [];
    return [{ nodeKey: item.nodeKey, continuityId: item.continuityId }];
  });
  if (
    nodeAudiences.length !== topology.nodeAudiences.length
    || hasDuplicate(nodeAudiences.map((mapping) => `${mapping.nodeKey}\u0000${mapping.continuityId}`))
    || nodeAudiences.some((mapping) =>
      !nodeKeys.has(mapping.nodeKey)
      || !continuities.some((continuity) => continuity.id === mapping.continuityId)
    )
  ) return null;

  return {
    scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
    membershipRole: membershipRole as string,
    continuities,
    topology: {
      nodes,
      routes,
      nodeAudiences,
      secretReady: topology.secretReady,
    },
  };
}

export function normalizeAudienceAppendResponse(
  value: unknown,
  expectedNodeKey: string,
  expectedContinuityId: string,
): { added: boolean } | null {
  const source = asRecord(value);
  if (
    !source
    || source.ok !== true
    || typeof source.added !== "boolean"
    || source.nodeKey !== expectedNodeKey
    || source.continuityId !== expectedContinuityId
  ) return null;
  return { added: source.added };
}

function hasDuplicate(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** 实体类型 → 节点色（全部来自既有语义调色板，禁荧光色）。 */
export const ENTITY_KIND_COLORS: Record<GraphEntity["entityKind"], string> = {
  person: "#b94c36",
  faction: "#526b50",
  geography: "#3f6770",
  history: "#9c7438",
  setting: "#70556b",
  other: "#55594f",
};

export const ENTITY_KIND_LABELS: Record<GraphEntity["entityKind"], string> = {
  person: "人物",
  faction: "势力",
  geography: "地理",
  history: "历史",
  setting: "设定",
  other: "其他",
};

const TRUTH_ORDER: Record<string, number> = {
  world_canon: 0,
  story_canon: 1,
  record_confirmed: 2,
  mentioned: 3,
  disputed: 4,
  rumor: 5,
  hypothesis: 6,
  deprecated: 7,
};

/** 要点优先：按真值阶梯排序，高层在前。 */
export function sortClaimsByImportance(claims: readonly GraphClaim[]): GraphClaim[] {
  return [...claims].sort(
    (left, right) =>
      (TRUTH_ORDER[left.truthStatus] ?? 9) - (TRUTH_ORDER[right.truthStatus] ?? 9),
  );
}
