import { createHash, randomUUID } from "node:crypto";
import {
  parseTavernImport,
  sniffImageContentType,
  TavernImportError,
  type TavernWorldBookEntry,
} from "../import/tavern-parser.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "../../database/postgres/workspace-transaction.ts";
import { appendGraphInvalidation } from "../../database/postgres/graph-invalidation.ts";
import {
  ensureWorldBaseRuleDefinitions,
} from "./base-rule-definitions.ts";
import { parseCheckSpecification } from "../actions/rule-pack.ts";
import { FatalTurnError } from "../runtime/public.ts";
import type { TavernRealmSkillDraft } from "../import/tavern-parser.ts";

/**
 * 酒馆导入服务：角色 + 头像文件 + 世界书条目单事务原子落库。
 * 任一失败整体回滚；允许重复导入（每次新 id）。
 * 规范见 public documentation。
 */

export interface TavernImportReport {
  character: { id: string; name: string; avatarFileId: string | null } | null;
  articlesCreated: string[];
  skippedDisabled: string[];
  warnings: string[];
  /**
   * 批次 SWM-G2（file_exact）：精确同文件重复的 entry 名（DB readback 判定，
   * 候选 article/qualification 已被 SAVEPOINT 撤销，无孤儿）。
   */
  duplicates: string[];
  /**
   * 无 uid 的新建 entry 名——file_exact 只做精确同文件去重，这些 entry
   * 跨上传不可追踪（诚实能力边界，不声称 content_changed）。
   */
  identityUnstable: string[];
  /** 本阶段恒为空：跨上传 content_changed 需要可靠 source namespace（未实现）。 */
  contentChanged: string[];
  /** 防御性：file_exact 下同 identity 必然同 hash；实测不同 = 数据异常。 */
  conflictAnomaly: string[];
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 18)}`;
}

const REALM_SKILL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;

/**
 * 批次 T6：卡技能条目校验——合法标识 + 非空 title/description + check 按
 * T5 契约（parseCheckSpecification）预验。返回 null 表示合法，否则为原因。
 */
function validateRealmSkill(draft: TavernRealmSkillDraft): string | null {
  if (!REALM_SKILL_KEY_PATTERN.test(draft.skillKey)) {
    return "skillKey 非法";
  }
  if (!draft.title || !draft.description) {
    return "title/description 为空";
  }
  if (draft.check !== undefined) {
    try {
      parseCheckSpecification(draft.check);
    } catch (error) {
      if (error instanceof FatalTurnError) return `check 非法（${error.code}）`;
      throw error;
    }
  }
  return null;
}

export async function importTavernBundle(
  database: WorkspaceDatabase,
  scope: { workspaceId: string; worldId: string },
  bytes: Buffer,
  filename: string | null,
): Promise<TavernImportReport> {
  const parsed = parseTavernImport(bytes);

  return withWorkspaceTransaction(database, scope.workspaceId, async (client) => {
    const report: TavernImportReport = {
      character: null,
      articlesCreated: [],
      skippedDisabled: [],
      warnings: [],
      duplicates: [],
      identityUnstable: [],
      contentChanged: [],
      conflictAnomaly: [],
    };

    // 世界存在性校验（外键之外给出明确 404 语义）。
    const world = await client.query<{
      worldline_id: string;
      style: string | null;
      status: string;
    }>(
      // v37 §D.0：C 面——只读检查升级为持锁形态（worlds FOR KEY SHARE +
      // 锁内 active 重读，gateWorldWrite 同形）；写者并行、归档互斥。
      `SELECT worldline.id AS worldline_id, world.settings->>'style' AS style,
         world.status
       FROM worlds AS world
       JOIN worldlines AS worldline
         ON worldline.workspace_id = world.workspace_id
        AND worldline.world_id = world.id
       WHERE world.workspace_id = $1 AND world.id = $2
       ORDER BY worldline.created_at ASC
       LIMIT 1
       FOR KEY SHARE OF world`,
      [scope.workspaceId, scope.worldId],
    );
    const worldlineId = world.rows[0]?.worldline_id;
    if (!worldlineId) {
      throw new TavernImportError(
        "TAVERN_IMPORT_UNKNOWN_FORMAT",
        "Target world not found.",
      );
    }
    // 批次 T8：归档世界只读，拒绝导入（fail-closed）。
    if (world.rows[0]?.status === "archived") {
      throw new TavernImportError(
        "TAVERN_IMPORT_WORLD_ARCHIVED",
        "Target world is archived and read-only.",
      );
    }

    // 批次 T4：导入只确保目标世界基础规则定义存在（幂等）；
    // 授权发生在记录装配/角色挂记录时，导入不做授权。
    await ensureWorldBaseRuleDefinitions(
      client,
      { workspaceId: scope.workspaceId, worldId: scope.worldId },
      world.rows[0]?.style ?? null,
    );

    // 批次 SWM-G2：file_exact source identity（plan v10 §5.6/§5.8/§6.1）。
    // bundle hash = 整文件 sha256，兼任 source_namespace（schema CHECK 锁死）；
    // stable_entry_identity = entry ordinal 文本。三个 hash 严格分离：
    // qualification_content_hash 绑定 article.id（attestation/read-time 用），
    // entry_content_hash 不含 article.id（duplicate 检测用）。
    const bundleContentHash = createHash("sha256").update(bytes).digest("hex");
    const normalizeEntryName = (name: string) =>
      name.trim().replace(/\s+/g, " ").toLowerCase();

    async function insertBookEntries(entries: readonly TavernWorldBookEntry[]) {
      if (entries.length === 0) return;
      // If the optional qualification schema is unavailable, keep lore empty
      // rather than failing the main read path. Imported articles remain
      // pending until the qualification path is available.
      const support = await client.query<{
        qualifications: unknown;
        entries: unknown;
      }>(
        `SELECT to_regclass('public.article_qualifications') AS qualifications,
                to_regclass('public.article_import_entries') AS entries`,
      );
      const hasQualificationSchema = Boolean(support.rows[0]?.qualifications)
        && Boolean(support.rows[0]?.entries);

      let inserted = 0;
      for (const entry of entries) {
        if (!entry.enabled) {
          report.skippedDisabled.push(entry.name);
          continue;
        }
        const articleId = newId("article");
        if (!hasQualificationSchema) {
          await client.query(
            `INSERT INTO world_articles (
               workspace_id, world_id, worldline_id, id, title, body
             ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              scope.workspaceId,
              scope.worldId,
              worldlineId,
              articleId,
              entry.name,
              entry.content,
            ],
          );
          report.articlesCreated.push(entry.name);
          inserted += 1;
          continue;
        }

        // SAVEPOINT-per-entry：冲突即撤销 candidate，不产生孤儿
        // article/qualification；duplicate 判定靠同事务 DB readback。
        const normalizedName = normalizeEntryName(entry.name);
        const entryContentHash = createHash("sha256")
          .update(`${normalizedName}\n${entry.content}`, "utf8")
          .digest("hex");
        const qualificationContentHash = createHash("sha256")
          .update(`${articleId}\n${entry.name}\n${entry.content}`, "utf8")
          .digest("hex");
        await client.query("SAVEPOINT entry_step");
        await client.query(
          `INSERT INTO world_articles (
             workspace_id, world_id, worldline_id, id, title, body,
             claim_ids, source_event_ids
           ) VALUES ($1, $2, $3, $4, $5, $6, ARRAY[]::text[], ARRAY[]::text[])`,
          [
            scope.workspaceId,
            scope.worldId,
            worldlineId,
            articleId,
            entry.name,
            entry.content,
          ],
        );
        await client.query(
          `INSERT INTO article_qualifications (
             workspace_id, world_id, worldline_id, article_id, id, seq,
             provenance_kind, status, content_hash,
             attested_by, attested_at,
             available_from_tick, available_from_ordinal
           ) VALUES (
             $1, $2, $3, $4, $5, 1,
             'tavern_import', 'pending_review', $6,
             NULL, NULL,
             0, 0
           )`,
          [
            scope.workspaceId,
            scope.worldId,
            worldlineId,
            articleId,
            newId("aq"),
            qualificationContentHash,
          ],
        );
        const insertedEntry = await client.query(
          `INSERT INTO article_import_entries (
             workspace_id, world_id, worldline_id, article_id, id,
             source_kind, source_namespace, stable_entry_identity, identity_kind,
             entry_uid, entry_ordinal, normalized_name,
             bundle_content_hash, entry_content_hash
           ) VALUES (
             $1, $2, $3, $4, $5,
             'tavern_worldbook', $6, $7, 'file_exact',
             $8, $9, $10,
             $11, $12
           )
           ON CONFLICT (
             workspace_id, world_id, worldline_id,
             source_kind, source_namespace, stable_entry_identity
           ) DO NOTHING
           RETURNING id`,
          [
            scope.workspaceId,
            scope.worldId,
            worldlineId,
            articleId,
            newId("aie"),
            bundleContentHash,
            String(entry.ordinal),
            entry.uid,
            entry.ordinal,
            normalizedName,
            bundleContentHash,
            entryContentHash,
          ],
        );
        if (insertedEntry.rowCount === 0) {
          // 冲突：撤销 candidate（无孤儿），readback 既有 entry 判 duplicate。
          await client.query("ROLLBACK TO SAVEPOINT entry_step");
          const existing = await client.query<{ entry_content_hash: string }>(
            `SELECT entry_content_hash
             FROM article_import_entries
             WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
               AND source_kind = 'tavern_worldbook'
               AND source_namespace = $4 AND stable_entry_identity = $5`,
            [
              scope.workspaceId,
              scope.worldId,
              worldlineId,
              bundleContentHash,
              String(entry.ordinal),
            ],
          );
          // file_exact 下同 identity 必然同 hash；不同 = 数据异常（防御性）。
          if (existing.rows[0]?.entry_content_hash === entryContentHash) {
            report.duplicates.push(entry.name);
          } else {
            report.conflictAnomaly.push(entry.name);
          }
          continue;
        }
        await client.query("RELEASE SAVEPOINT entry_step");
        report.articlesCreated.push(entry.name);
        if (!entry.uid) report.identityUnstable.push(entry.name);
        inserted += 1;
      }
      // 批次 T11-A2：W9——导入事务内直写 world_articles，同事务合并为
      // 一个 article 失效事件（无实际插入不发）。
      if (inserted > 0) {
        await appendGraphInvalidation(
          client,
          {
            workspaceId: scope.workspaceId,
            worldId: scope.worldId,
            worldlineId,
          },
          "article",
          "tavern-import",
        );
      }
    }

    if (parsed.kind === "worldbook") {
      await insertBookEntries(parsed.book);
      return report;
    }

    // 角色卡：头像文件（PNG 卡本体）→ 角色定义 → 内嵌世界书。
    let avatarFileId: string | null = null;
    if (parsed.png) {
      const contentType = sniffImageContentType(parsed.png) ?? "image/png";
      avatarFileId = newId("file");
      await client.query(
        `INSERT INTO world_files (
           workspace_id, world_id, id, kind, content_type, filename,
           sha256, size_bytes, data
         ) VALUES ($1, $2, $3, 'character_avatar', $4, $5, $6, $7, $8)`,
        [
          scope.workspaceId,
          scope.worldId,
          avatarFileId,
          contentType,
          filename,
          createHash("sha256").update(parsed.png).digest("hex"),
          parsed.png.length,
          parsed.png,
        ],
      );
    }

    const card = parsed.card;
    const characterId = newId("char_def");

    // 批次 T6：卡携带技能（extensions.realm_skills）——逐条校验（合法标识 +
    // 非空文案 + check 按 T5 契约预验），非法条目跳过并列入 warnings
    // （显式报告，不阻断导入，绝不静默参局）；合法条目落 skill_definitions
    // （ON CONFLICT 幂等，与世界既有定义同 key 保留既有行）。
    const validSkills: TavernRealmSkillDraft[] = [];
    for (const draft of card.realmSkills) {
      const invalid = validateRealmSkill(draft);
      if (invalid) {
        report.warnings.push(
          `realm_skills 条目已跳过（${draft.skillKey || draft.title || "未命名"}：${invalid}）`,
        );
        continue;
      }
      validSkills.push(draft);
      await client.query(
        `INSERT INTO skill_definitions (
           workspace_id, world_id, id, skill_key, title, description,
           rule_pack_key, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
         ON CONFLICT (workspace_id, world_id, skill_key) DO NOTHING`,
        [
          scope.workspaceId,
          scope.worldId,
          `imported_skill_${draft.skillKey}_${scope.worldId.slice(-24)}`,
          draft.skillKey,
          draft.title,
          draft.description,
          "realm.imported.v1",
          JSON.stringify(draft.check !== undefined ? { check: draft.check } : {}),
        ],
      );
    }

    await client.query(
      `INSERT INTO character_definitions (
         workspace_id, world_id, id, display_name, source_format, profile
       ) VALUES ($1, $2, $3, $4, 'sillytavern_character_card', $5::jsonb)`,
      [
        scope.workspaceId,
        scope.worldId,
        characterId,
        card.name,
        JSON.stringify({
          spec: card.spec,
          name: card.name,
          description: card.description,
          personality: card.personality,
          scenario: card.scenario,
          first_mes: card.firstMes,
          mes_example: card.mesExample,
          creator_notes: card.creatorNotes,
          system_prompt: card.systemPrompt,
          post_history_instructions: card.postHistoryInstructions,
          alternate_greetings: card.alternateGreetings,
          tags: card.tags,
          creator: card.creator,
          character_version: card.characterVersion,
          role: card.personality ? card.personality.split("\n")[0]!.slice(0, 40) : "",
          summary: card.description.slice(0, 120),
          avatar_file_id: avatarFileId,
          // 批次 T6：卡→技能关联键（授权时按此查定义行）。
          realm_skill_keys: validSkills.map((draft) => draft.skillKey),
        }),
      ],
    );
    report.character = {
      id: characterId,
      name: card.name,
      avatarFileId: avatarFileId ?? null,
    };

    if (parsed.book) {
      await insertBookEntries(parsed.book);
    }
    return report;
  });
}
