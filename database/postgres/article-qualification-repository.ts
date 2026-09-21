/**
 * Article qualification 账本仓库（plan v10 §5.5/§5.7/§5.9；v37 §E.1 并行化）。
 *
 * owner attestation 是 article 正文公共资格的唯一来源；事件 append-only
 * （DB 触发器 + grants 兜底）。并发协议（v37 §E.1 终版）：
 *   ⓪ gateWorldWrite：worlds FOR KEY SHARE + active 断言（跨 article 真
 *      并行——KEY SHARE 互相兼容，仅与归档命令的 FOR UPDATE 互斥）；
 *   ① per-article pg_advisory_xact_lock(hashtextextended(key, 0))——同
 *      article 串行化、跨 article 不互斥（realm_runtime 对
 *      world_articles 只有 SELECT/INSERT，不能锁 article 行）；
 *   ② worldlines FOR KEY SHARE 读 head cursor tuple；
 *   ③ article 无锁读 + DB-side hash；④ latest；⑤ INSERT seq=latest+1，
 *   UNIQUE(workspace_id, world_id, worldline_id, article_id, seq) 兜底。
 * 失败语义：55P03/23505 重试一次 → QUALIFICATION_CONCURRENT；40P01 不
 * 静默重试（抛 500）；42P01/42883 → QUALIFICATION_SCHEMA_MISSING。
 *
 * content hash 永远 DB-side（pgcrypto digest/encode）读取比对，应用层
 * 不把正文读进来算 hash（无界路径禁令）；三 hash 语义见
 * docs/development/ARTICLE-QUALIFICATION-MIGRATION.md。
 */
import { randomUUID } from "node:crypto";
import type {
  ArticleQualificationDecision,
  ArticleQualificationStatus,
  WorldScope,
} from "../../modules/world-knowledge/public.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";
import {
  gateWorldWrite,
  isWorldWriteGateError,
} from "./world-write-gate.ts";

export interface ArticleQualificationState {
  articleId: string;
  status: ArticleQualificationStatus;
  provenanceKind: string;
  contentHash: string;
  availableFromTick: number;
  availableFromOrdinal: number;
  seq: number;
  id: string;
  attestedBy: string | null;
  attestedAt: string | null;
}

export type ArticleQualifyOutcome =
  | {
      ok: true;
      articleId: string;
      status: ArticleQualificationStatus;
      seq: number;
      availableFromTick: number;
      availableFromOrdinal: number;
      idempotent: boolean;
    }
  | {
      ok: false;
      code:
        | "ARTICLE_NOT_FOUND"
        | "HASH_MISMATCH"
        | "QUALIFICATION_SCHEMA_MISSING"
        | "QUALIFICATION_CONCURRENT"
        | "WORLD_ARCHIVED";
    };

function newQualificationId(): string {
  return `aq_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

function asSafeCursor(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("qualification cursor exceeds JavaScript safe integer range");
  }
  return parsed;
}

// 未应用 0041（或 pgcrypto 不可用）的库：undefined_table（42P01）=
// 账本表缺席；undefined_function（42883）= digest() 缺席。两者都 fail-closed。
function isMissingQualificationSupport(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
  return code === "42P01" || code === "42883";
}

// 55P03 = lock_not_available（lock_timeout 命中）；23505 = unique_violation
// （并发 seq 撞 UNIQUE 兜底）。两者重试一次后仍失败 → QUALIFICATION_CONCURRENT。
// 40P01（deadlock）绝不静默重试——直接抛出由 route 映射 500。
function isRetryableQualificationLockError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null
    ? (error as { code?: string }).code
    : undefined;
  return code === "55P03" || code === "23505";
}

const NEXT_STATUS: Record<ArticleQualificationDecision, ArticleQualificationStatus> = {
  attest: "qualified_public",
  reject: "rejected",
  revoke: "revoked",
};

export function createArticleQualificationRepository(
  database: WorkspaceDatabase,
) {
  return {
    /**
     * 追加资格事件（或幂等返回）。锁序固定 worlds(KEY SHARE) →
     * advisory(article) → worldlines(KEY SHARE) →（读）article → latest →
     * insert；绝不反向（v37 §E.1）。
     */
    async qualify(
      scope: WorldScope,
      input: {
        articleId: string;
        decision: ArticleQualificationDecision;
        attestedBy: string;
      },
    ): Promise<ArticleQualifyOutcome> {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await qualifyOnce(database, scope, input);
        } catch (error) {
          if (isWorldWriteGateError(error)) {
            if (error.code === "WORLD_ARCHIVED") {
              return { ok: false as const, code: "WORLD_ARCHIVED" as const };
            }
            return { ok: false as const, code: "ARTICLE_NOT_FOUND" as const };
          }
          // 未应用 0041 的库：fail-closed（不创建任何资格、不接 prompt）。
          if (isMissingQualificationSupport(error)) {
            return { ok: false as const, code: "QUALIFICATION_SCHEMA_MISSING" as const };
          }
          if (isRetryableQualificationLockError(error) && attempt === 0) {
            continue;
          }
          if (isRetryableQualificationLockError(error)) {
            return { ok: false as const, code: "QUALIFICATION_CONCURRENT" as const };
          }
          throw error;
        }
      }
      return { ok: false as const, code: "QUALIFICATION_CONCURRENT" as const };
    },

    /** deterministic latest-state（§5.7）；无资格行 → null（= pending_review）。 */
    async latestState(
      scope: WorldScope,
      articleId: string,
    ): Promise<ArticleQualificationState | null> {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query<{
            article_id: string;
            status: ArticleQualificationStatus;
            provenance_kind: string;
            content_hash: string;
            available_from_tick: string;
            available_from_ordinal: string;
            seq: string;
            id: string;
            attested_by: string | null;
            attested_at: Date | null;
          }>(
            `SELECT DISTINCT ON (qual.article_id)
               qual.article_id,
               qual.status,
               qual.provenance_kind,
               qual.content_hash,
               qual.available_from_tick,
               qual.available_from_ordinal,
               qual.seq,
               qual.id,
               qual.attested_by,
               qual.attested_at
             FROM article_qualifications AS qual
             WHERE qual.workspace_id = $1 AND qual.world_id = $2
               AND qual.worldline_id = $3 AND qual.article_id = $4
             ORDER BY qual.article_id, qual.seq DESC, qual.id DESC`,
            [scope.workspaceId, scope.worldId, scope.worldlineId, articleId],
          );
          const row = result.rows[0];
          if (!row) return null;
          return {
            articleId: row.article_id,
            status: row.status,
            provenanceKind: row.provenance_kind,
            contentHash: row.content_hash,
            availableFromTick: asSafeCursor(row.available_from_tick),
            availableFromOrdinal: asSafeCursor(row.available_from_ordinal),
            seq: asSafeCursor(row.seq),
            id: row.id,
            attestedBy: row.attested_by,
            attestedAt: row.attested_at ? row.attested_at.toISOString() : null,
          };
        },
        { readOnly: true },
      );
    },
    /**
     * G5：worldline 内全部 article 的 latest-state 批量读取（GET 控制面矩阵用）。
     * 调用方负责 42P01/42883 fail-closed（缺 0041 → 全部 pending_review）。
     */
    async listStates(
      scope: WorldScope,
    ): Promise<
      ReadonlyMap<string, {
        status: ArticleQualificationStatus;
        availableFromTick: number;
        availableFromOrdinal: number;
      }>
    > {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const result = await client.query<{
            article_id: string;
            status: ArticleQualificationStatus;
            available_from_tick: string;
            available_from_ordinal: string;
          }>(
            `SELECT DISTINCT ON (qual.article_id)
               qual.article_id,
               qual.status,
               qual.available_from_tick,
               qual.available_from_ordinal
             FROM article_qualifications AS qual
             WHERE qual.workspace_id = $1 AND qual.world_id = $2
               AND qual.worldline_id = $3
             ORDER BY qual.article_id, qual.seq DESC, qual.id DESC`,
            [scope.workspaceId, scope.worldId, scope.worldlineId],
          );
          return new Map(result.rows.map((row) => [
            row.article_id,
            {
              status: row.status,
              availableFromTick: asSafeCursor(row.available_from_tick),
              availableFromOrdinal: asSafeCursor(row.available_from_ordinal),
            },
          ]));
        },
        { readOnly: true },
      );
    },
  };
}

/** qualify 单次尝试（事务体；v37 §E.1 锁序）。 */
async function qualifyOnce(
  database: WorkspaceDatabase,
  scope: WorldScope,
  input: {
    articleId: string;
    decision: ArticleQualificationDecision;
    attestedBy: string;
  },
): Promise<ArticleQualifyOutcome> {
  return withWorkspaceTransaction(
    database,
    scope.workspaceId,
    async (client) => {
      // 锁等待必须有界：2s lock_timeout（命中 → 55P03 → 重试一次 →
      // QUALIFICATION_CONCURRENT 409）。
      await client.query("SET LOCAL lock_timeout = '2s'");

      // ⓪ gateWorldWrite：worlds FOR KEY SHARE + active 断言——内容面写
      // 事务的第一个锁；跨 article/跨写者真并行，与归档 FOR UPDATE 互斥。
      await gateWorldWrite(client, {
        workspaceId: scope.workspaceId,
        worldId: scope.worldId,
      });

      // ① per-article advisory 锁：同 article 串行、跨 article 并行。
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${scope.workspaceId}|${scope.worldId}|${scope.worldlineId}|${input.articleId}`],
      );

      // ② worldline FOR KEY SHARE：读当前 cursor 作为 available_from tuple
      //    （与 head writer 的 FOR UPDATE 不互斥——cursor 读允许并发）。
      const worldline = await client.query<{
        head_tick: string;
        head_ordinal: string;
      }>(
        `SELECT head_tick, head_ordinal
         FROM worldlines
         WHERE workspace_id = $1 AND world_id = $2 AND id = $3
         FOR KEY SHARE`,
        [scope.workspaceId, scope.worldId, scope.worldlineId],
      );
      if (!worldline.rows[0]) {
        return { ok: false as const, code: "ARTICLE_NOT_FOUND" as const };
      }
      const headTick = asSafeCursor(worldline.rows[0].head_tick);
      const headOrdinal = asSafeCursor(worldline.rows[0].head_ordinal);

      // ③ article 存在性 + 当前正文的 DB-side hash（不读正文进应用）。
      const article = await client.query<{ content_hash: string }>(
        `SELECT encode(
           digest(article.id || E'\\n' || article.title || E'\\n' || article.body, 'sha256'),
           'hex'
         ) AS content_hash
         FROM world_articles AS article
         WHERE article.workspace_id = $1 AND article.world_id = $2
           AND article.worldline_id = $3 AND article.id = $4`,
        [scope.workspaceId, scope.worldId, scope.worldlineId, input.articleId],
      );
      if (!article.rows[0]) {
        return { ok: false as const, code: "ARTICLE_NOT_FOUND" as const };
      }
      const currentHash = article.rows[0].content_hash;

      // ④ deterministic latest-state（advisory 锁保证 seq 唯一；id 字典序双保险）。
      const latestResult = await client.query<{
        status: ArticleQualificationStatus;
        content_hash: string;
        seq: string;
        available_from_tick: string;
        available_from_ordinal: string;
      }>(
        `SELECT status, content_hash, seq,
                available_from_tick, available_from_ordinal
         FROM article_qualifications
         WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           AND article_id = $4
         ORDER BY seq DESC, id DESC
         LIMIT 1`,
        [scope.workspaceId, scope.worldId, scope.worldlineId, input.articleId],
      );
      const latest = latestResult.rows[0];
      const nextStatus = NEXT_STATUS[input.decision];

      // duplicate：同 decision + 同 hash + latest 同状态 → 幂等，不追加。
      if (
        latest
        && latest.status === nextStatus
        && latest.content_hash === currentHash
      ) {
        return {
          ok: true as const,
          articleId: input.articleId,
          status: nextStatus,
          seq: asSafeCursor(latest.seq),
          availableFromTick: asSafeCursor(latest.available_from_tick),
          availableFromOrdinal: asSafeCursor(latest.available_from_ordinal),
          idempotent: true,
        };
      }
      // attest 时 latest 为 qualified_public 但 hash 不同 = 正文在
      // attestation 后被改：fail-closed 409，不静默重签（先 revoke）。
      if (
        input.decision === "attest"
        && latest
        && latest.status === "qualified_public"
        && latest.content_hash !== currentHash
      ) {
        return { ok: false as const, code: "HASH_MISMATCH" as const };
      }

      // revoke 的 available_from 沿用前次（语义无关但保持可溯）；
      // 其余取当前 worldline cursor tuple。
      const availableFromTick = input.decision === "revoke" && latest
        ? asSafeCursor(latest.available_from_tick)
        : headTick;
      const availableFromOrdinal = input.decision === "revoke" && latest
        ? asSafeCursor(latest.available_from_ordinal)
        : headOrdinal;
      const seq = latest ? asSafeCursor(latest.seq) + 1 : 1;
      await client.query(
        `INSERT INTO article_qualifications (
           workspace_id, world_id, worldline_id, article_id, id, seq,
           provenance_kind, status, content_hash,
           attested_by, attested_at,
           available_from_tick, available_from_ordinal
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           'owner_attest', $7, $8,
           $9, CURRENT_TIMESTAMP,
           $10, $11
         )`,
        [
          scope.workspaceId,
          scope.worldId,
          scope.worldlineId,
          input.articleId,
          newQualificationId(),
          seq,
          nextStatus,
          currentHash,
          input.attestedBy,
          availableFromTick,
          availableFromOrdinal,
        ],
      );
      return {
        ok: true as const,
        articleId: input.articleId,
        status: nextStatus,
        seq,
        availableFromTick,
        availableFromOrdinal,
        idempotent: false,
      };
    },
  );
}

export type ArticleQualificationRepository = ReturnType<
  typeof createArticleQualificationRepository
>;
