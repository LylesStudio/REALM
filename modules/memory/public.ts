export const MEMORY_EMBEDDING_DIMENSIONS = 384;
export const MEMORY_EMBEDDING_MODEL = "realm-lexical-v1";

export type WorldCursor = { tick: number; ordinal: number };

export type MemoryConclusion = {
  id: string;
  observerContinuityId: string;
  observedEntityKey: string;
  content: string;
  memoryKind: "explicit" | "inferred" | "summary" | "preference" | "relationship";
  fidelity: number;
  occurred: WorldCursor;
  availableFrom: WorldCursor;
  keywords: readonly string[];
};

export type MemoryRecall = MemoryConclusion & {
  score: number;
  keywordScore: number;
  vectorScore: number;
};

export type RelationshipKind =
  | "trust"
  | "hostile"
  | "alliance"
  | "kinship"
  | "debt"
  | "acquaintance"
  | "note";

export type SummaryDomain = "episodic" | "semantic" | "decision";

/**
 * Observer-scoped subjective relationship projection. A Relationship is what
 * one continuity currently believes about a target entity; it is never an
 * objective world relation. Revisions append evidence conclusions.
 */
export type RelationshipState = {
  observerContinuityId: string;
  targetEntityKey: string;
  relationKind: RelationshipKind;
  content: string;
  fidelity: number;
  occurred: WorldCursor;
  availableFrom: WorldCursor;
  createdAt: string;
  updatedAt: string;
};

export type MemorySnapshot = {
  id: string;
  observerContinuityId: string;
  snapshotKind: "representation" | "recall";
  content: string;
  itemIds: readonly string[];
  cursor: WorldCursor;
  cacheEpoch: number;
  tokenCount: number;
  createdAt: string;
};

/** A stale delta means the cache epoch advanced; callers must re-snapshot. */
export type MemoryDelta = {
  stale: boolean;
  cacheEpoch: number;
  items: readonly MemoryConclusion[];
};

export type CharacterMemoryQuery = {
  workspaceId: string;
  worldId: string;
  worldlineId: string;
  recordId: string;
  characterInstanceId: string;
  query: string;
  limit?: number;
};

export interface CharacterMemoryRepository {
  /**
   * 纯排序查询：只读取已物化的 memory_conclusions，绝不回写
   * （批次 T2 起物化由 extractAuthorized 在回合提交后异步完成）。
   */
  recallAuthorized(input: CharacterMemoryQuery & {
    keywords: readonly string[];
    embedding: readonly number[];
    embeddingModel: string;
  }): Promise<readonly MemoryRecall[]>;
  /**
   * sync_turn 萃取：把指定 record 内尚未物化的 observations 集合式物化为
   * memory_conclusions。幂等——重复触发不产生重复行
   * （ON CONFLICT DO NOTHING，唯一约束 (workspace_id,
   * observer_continuity_id, source_record_id, source_observation_id)）。
   * 返回本次实际新增的行数。
   */
  extractAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
  }): Promise<{ materialized: number }>;
  appendAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    observedEntityKey: string;
    content: string;
    memoryKind: MemoryConclusion["memoryKind"];
    fidelity: number;
    keywords: readonly string[];
    embedding: readonly number[];
    embeddingModel: string;
    summaryScope?: "character" | "dm" | "public" | "restricted";
    summaryDomain?: SummaryDomain;
    operation?: "add" | "update" | "retract";
    supersedesMemoryId?: string;
  }): Promise<void>;
  upsertRelationshipAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    targetEntityKey: string;
    relationKind: RelationshipKind;
    content: string;
    fidelity: number;
  }): Promise<void>;
  /**
   * Find the latest still-effective summary conclusion for an observer
   * and (optionally) summary domain. Used by summarize() to supersede the
   * previous summary instead of appending a duplicate.
   */
  latestSummaryAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    summaryScope?: "character" | "dm" | "public" | "restricted";
    summaryDomain?: SummaryDomain;
  }): Promise<{ id: string } | null>;
  relationshipsAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    limit?: number;
  }): Promise<readonly RelationshipState[]>;
  createSnapshotAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    snapshotId: string;
    snapshotKind: MemorySnapshot["snapshotKind"];
    content: string;
    itemIds: readonly string[];
    tokenCount: number;
  }): Promise<MemorySnapshot | null>;
  deltaAuthorized(input: {
    workspaceId: string;
    worldId: string;
    worldlineId: string;
    recordId: string;
    characterInstanceId: string;
    snapshotId: string;
  }): Promise<MemoryDelta | null>;
}

export interface CharacterMemoryService {
  recall(input: CharacterMemoryQuery): Promise<readonly MemoryRecall[]>;
  representation(
    input: Omit<CharacterMemoryQuery, "query" | "limit">,
    depth?: "simple" | "balanced" | "immersive",
    tokenBudget?: number,
  ): Promise<string>;
  summarize(
    input: Omit<CharacterMemoryQuery, "query" | "limit">,
    scope?: "character" | "dm" | "public" | "restricted",
  ): Promise<string>;
  summarizeDomain(
    input: Omit<CharacterMemoryQuery, "query" | "limit">,
    domain: SummaryDomain,
    scope?: "character" | "dm" | "public" | "restricted",
  ): Promise<string>;
  relationships(input: Omit<CharacterMemoryQuery, "query" | "limit">): Promise<string>;
  recordRelationship(input: Omit<CharacterMemoryQuery, "query" | "limit"> & {
    targetKey: string;
    content: string;
    fidelity?: number;
    relationKind?: RelationshipKind;
  }): Promise<void>;
  snapshot(
    input: Omit<CharacterMemoryQuery, "query" | "limit">,
    kind?: MemorySnapshot["snapshotKind"],
  ): Promise<MemorySnapshot | null>;
  delta(
    input: Omit<CharacterMemoryQuery, "query" | "limit">,
    snapshotId: string,
  ): Promise<MemoryDelta | null>;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(content: string): Promise<readonly number[]>;
}

export function createCharacterMemoryService(options: {
  repository: CharacterMemoryRepository;
  embedding?: EmbeddingProvider;
}): CharacterMemoryService {
  const embedding = options.embedding ?? createLocalLexicalEmbeddingProvider();
  return {
    async recall(input) {
      const query = input.query.trim();
      if (!query) return [];
      return options.repository.recallAuthorized({
        ...input,
        limit: Math.min(Math.max(input.limit ?? 6, 1), 20),
        keywords: extractMemoryKeywords(query),
        embedding: await embedding.embed(query),
        embeddingModel: embedding.model,
      });
    },

    async representation(input, depth = "balanced", tokenBudget) {
      const limit = depth === "simple" ? 3 : depth === "immersive" ? 12 : 6;
      const memories = await this.recall({
        ...input,
        query: "当前人物、地点、目标、承诺、关系与最近获知的关键事实",
        limit,
      });
      return fitMemoryLinesWithinBudget(
        memories.map((memory) => memory.content),
        tokenBudget,
      );
    },

    async summarize(input, scope = "character") {
      const memories = await this.recall({
        ...input,
        query: "关键事实 目标 承诺 关系 最近变化",
        limit: 8,
      });
      if (memories.length === 0) return "";
      const content = `近期要点：${memories.map((memory) => memory.content).join("；")}`;
      const previous = await options.repository.latestSummaryAuthorized({
        ...input,
        summaryScope: scope,
      });
      await options.repository.appendAuthorized({
        ...input,
        observedEntityKey: "self",
        content,
        memoryKind: "summary",
        fidelity: 1,
        keywords: extractMemoryKeywords(content),
        embedding: await embedding.embed(content),
        embeddingModel: embedding.model,
        summaryScope: scope,
        operation: previous ? "update" : "add",
        supersedesMemoryId: previous?.id,
      });
      return content;
    },

    async summarizeDomain(input, domain, scope = "character") {
      const memories = await this.recall({
        ...input,
        query: SUMMARY_DOMAIN_QUERIES[domain],
        limit: 8,
      });
      if (memories.length === 0) return "";
      const content = `${SUMMARY_DOMAIN_LABELS[domain]}：${
        memories.map((memory) => memory.content).join("；")
      }`;
      const previous = await options.repository.latestSummaryAuthorized({
        ...input,
        summaryScope: scope,
        summaryDomain: domain,
      });
      await options.repository.appendAuthorized({
        ...input,
        observedEntityKey: "self",
        content,
        memoryKind: "summary",
        fidelity: 1,
        keywords: extractMemoryKeywords(content),
        embedding: await embedding.embed(content),
        embeddingModel: embedding.model,
        summaryScope: scope,
        summaryDomain: domain,
        operation: previous ? "update" : "add",
        supersedesMemoryId: previous?.id,
      });
      return content;
    },

    async relationships(input) {
      const states = await options.repository.relationshipsAuthorized({
        ...input,
        limit: 8,
      });
      if (states.length > 0) {
        // 主观关系状态：始终以观察者视角措辞，不表述为客观世界关系。
        return states
          .map((state) => `- 对 ${state.targetEntityKey}：${state.content}`)
          .join("\n");
      }
      const memories = await this.recall({
        ...input,
        query: "关系 信任 承诺 敌意 同盟",
        limit: 8,
      });
      const relationshipLines = memories
        .filter((memory) => memory.memoryKind === "relationship")
        .map((memory) => `- ${memory.content}`);
      const observedEntities = [...new Set(
        memories
          .map((memory) => memory.observedEntityKey)
          .filter((key) => key && key !== "self"),
      )];
      if (relationshipLines.length === 0 && observedEntities.length > 0) {
        relationshipLines.push(`- 已知对象：${observedEntities.join("、")}`);
      } else if (relationshipLines.length === 0) {
        relationshipLines.push("- 当前没有已整理的关系结论。");
      }
      return relationshipLines.join("\n");
    },

    async recordRelationship(input) {
      const content = input.content.trim();
      if (!content || !input.targetKey.trim()) return;
      const fidelity = Math.min(Math.max(input.fidelity ?? 1, 0), 1);
      await options.repository.upsertRelationshipAuthorized({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        worldlineId: input.worldlineId,
        recordId: input.recordId,
        characterInstanceId: input.characterInstanceId,
        targetEntityKey: input.targetKey.trim(),
        relationKind: input.relationKind ?? "note",
        content,
        fidelity,
      });
      await options.repository.appendAuthorized({
        workspaceId: input.workspaceId,
        worldId: input.worldId,
        worldlineId: input.worldlineId,
        recordId: input.recordId,
        characterInstanceId: input.characterInstanceId,
        observedEntityKey: input.targetKey.trim(),
        content,
        memoryKind: "relationship",
        fidelity,
        keywords: extractMemoryKeywords(content),
        embedding: await embedding.embed(content),
        embeddingModel: embedding.model,
      });
    },

    async snapshot(input, kind = "representation") {
      const memories = await this.recall({
        ...input,
        query: "当前人物、地点、目标、承诺、关系与最近获知的关键事实",
        limit: 12,
      });
      const lines = memories.map((memory) => memory.content);
      const content = kind === "representation"
        ? fitMemoryLinesWithinBudget(lines)
        : lines.join("\n");
      const snapshotId = `snap_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
      return options.repository.createSnapshotAuthorized({
        ...input,
        snapshotId,
        snapshotKind: kind,
        content,
        itemIds: memories.map((memory) => memory.id),
        tokenCount: estimateMemoryTokens(content),
      });
    },

    async delta(input, snapshotId) {
      return options.repository.deltaAuthorized({ ...input, snapshotId });
    },
  };
}

const SUMMARY_DOMAIN_QUERIES: Record<SummaryDomain, string> = {
  episodic: "最近 发生 事件 经过 遭遇 场景 变化",
  semantic: "人物 地点 事实 知识 规则 稳定 特征",
  decision: "目标 决定 承诺 打算 计划 选择",
};

const SUMMARY_DOMAIN_LABELS: Record<SummaryDomain, string> = {
  episodic: "情景要点",
  semantic: "语义要点",
  decision: "决策要点",
};

/**
 * Deterministic local token estimate: CJK characters count as one token,
 * other characters as a quarter token, matching the context compiler's
 * conservative budgeting style.
 */
export function estimateMemoryTokens(content: string): number {
  let units = 0;
  for (const character of content) {
    units += /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)
      ? 4
      : 1;
  }
  return Math.ceil(units / 4);
}

/**
 * 生产 memory prefetch 注入预算（Cleanup Phase 4 / Batch 2C）。
 * 依据：recall limit = 6 行；growth/profile 类 memory 单行常规 ≤160 字符
 * （CJK 约 1 token/字符），6 行常规规模 ≈ 240–320 token；预算冻结为 320，
 * 只约束注入模型上下文的 representation（recall 顺序保持，超预算时按
 * fitMemoryLinesWithinBudget 的行内截断语义裁尾部），不改变 recall 的
 * 数量、关键词、embedding、授权范围或任何写入路径。
 */
export const MEMORY_PREFETCH_TOKEN_BUDGET = 320;

/**
 * 生产 prefetch 的统一格式化入口：recall 顺序 + `- ...` 行形 + 预算裁剪。
 * 空输入返回空串（调用方保持空块/fail-closed 语义）。
 */
export function formatMemoryPrefetchLines(
  lines: readonly string[],
  tokenBudget: number = MEMORY_PREFETCH_TOKEN_BUDGET,
): string {
  return fitMemoryLinesWithinBudget(lines, tokenBudget);
}

/**
 * Fixed token budget for long Records: lines are kept in recall order while
 * they fit; an overlong single line is truncated rather than dropped. Without
 * a budget the lines are returned unchanged.
 */
export function fitMemoryLinesWithinBudget(
  lines: readonly string[],
  tokenBudget?: number,
): string {
  const rendered = lines.map((line) => `- ${line}`);
  if (tokenBudget === undefined) return rendered.join("\n");
  const budget = Math.max(0, Math.floor(tokenBudget));
  if (budget === 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (const line of rendered) {
    const cost = estimateMemoryTokens(line);
    if (used + cost <= budget) {
      kept.push(line);
      used += cost;
      continue;
    }
    const remaining = budget - used;
    if (remaining >= 8 && kept.length < rendered.length) {
      // CJK 字符约 1 token/字符，取 remaining 长度必然不超预算。
      kept.push(`${line.slice(0, Math.max(0, remaining - 1))}…`);
    }
    break;
  }
  return kept.join("\n");
}

export function createLocalLexicalEmbeddingProvider(): EmbeddingProvider {
  return {
    model: MEMORY_EMBEDDING_MODEL,
    async embed(content) {
      return lexicalEmbedding(content);
    },
  };
}

export function extractMemoryKeywords(content: string): readonly string[] {
  const normalized = content.normalize("NFKC").toLowerCase();
  const latin = normalized.match(/[a-z0-9_:-]{2,}/g) ?? [];
  const cjkRuns = normalized.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? [];
  const terms = new Set<string>(latin);
  for (const run of cjkRuns) {
    for (const character of run) terms.add(character);
    for (let index = 0; index < run.length - 1; index += 1) {
      terms.add(run.slice(index, index + 2));
    }
  }
  return [...terms].filter(Boolean).slice(0, 48);
}

export function lexicalEmbedding(content: string): readonly number[] {
  const vector = new Array<number>(MEMORY_EMBEDDING_DIMENSIONS).fill(0);
  const terms = extractMemoryKeywords(content);
  for (const term of terms) {
    const hash = fnv1a(term);
    const index = hash % MEMORY_EMBEDDING_DIMENSIONS;
    const sign = (fnv1a(`${term}:sign`) & 1) === 0 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(8)));
}

function fnv1a(content: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
