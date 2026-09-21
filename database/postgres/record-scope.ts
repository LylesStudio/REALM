import type { PoolClient, QueryResultRow } from "pg";
import {
  normalizeWorldStyle,
  type WorldStyle,
} from "../../modules/style/world-style.ts";
import type { PublicDialogueLine } from "../../modules/orchestration/public.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";
import { profileNoteTextAt } from "./character-growth-store.ts";

export interface RecordRuntimeScope {
  workspaceId: string;
  principalId: string;
  worldId: string;
  worldlineId: string;
  storyId: string;
  recordId: string;
  sceneId: string;
  publicPolicyId: string;
  calendarId: string;
  displayTime: string;
  /** 世界文风（worlds.settings.style，缺省 modern）。 */
  style: WorldStyle;
  /** 世界内系统文本语言（worlds.settings.language，缺省 zh-CN）。 */
  language: string;
  /** 批次 T8：世界状态（worlds.status）——archived 世界只读，写路径拒绝。 */
  worldStatus: string;
  /** 世界/故事/场景快照：模型回合与设定结晶的设定依据。 */
  brief: WorldSceneBrief;
  playerActor: RuntimeActor;
  aiCharacters: readonly RuntimeActor[];
  observerCharacterInstanceIds: readonly string[];
  /** 当前游标前的公开事件摘要；dynamic discovery 不读取 restricted/private。 */
  recentPublicEvents: readonly string[];
  /**
   * 带主体信息的最近公开对话摘要（speaker participantId、recipientId、
   * 文本）：与 recentPublicEvents 同一授权查询（仅 public 事件，结构上
   * 排除 restricted/private），供 Character Runner 消费；不渲染给玩家。
   */
  recentPublicDialogue: readonly PublicDialogueLine[];
  /**
   * 当前记录的 record_confirmed 世界知识行（record 级，record-local 背景；
   * 绝非 story/world canon——canon 仍只来自 brief.canon 的阶梯过滤）。
   */
  recordKnowledge: readonly string[];
  [key: string]:
    | string
    | RuntimeActor
    | readonly RuntimeActor[]
    | readonly string[]
    | readonly PublicDialogueLine[]
    | WorldSceneBrief;
}

export interface WorldSceneBrief {
  worldName: string;
  era: string;
  summary: string;
  storyTitle: string;
  premise: string;
  location: string;
  weather: string;
  tension: string;
  objective: string;
  /** SWM v2：合格 article excerpt 行（`- 《title》：excerpt`；空=无合格文章）。 */
  worldLore: string;
  // 需要保持 JsonValue 兼容（运行时 scope 会序列化进命令载荷）。
  [key: string]: string;
}

export interface RuntimeActor {
  characterInstanceId: string;
  participantId: string;
  displayName: string;
  profileSummary: string;
  [key: string]: string;
}

interface RecordRow extends QueryResultRow {
  world_id: string;
  world_status: string;
  worldline_id: string;
  head_tick: string | number;
  head_ordinal: string | number;
  record_head_tick: string | number;
  record_head_ordinal: string | number;
  story_id: string;
  calendar_id: string;
  display_time: string;
  style: string;
  world_name: string;
  era: string;
  summary: string;
  weather: string;
  tension: string;
  timeline_kind: string;
  empty_retrospection: boolean;
  story_title: string;
  premise: string;
}

interface PolicyRow extends QueryResultRow {
  id: string;
}

interface SceneRow extends QueryResultRow {
  id: string;
  location: string;
  tension: string | null;
  objective: string;
  weather: string | null;
  display_time: string | null;
}

interface ActorRow extends QueryResultRow {
  participant_kind: "character" | "narrator";
  character_instance_id: string | null;
  participant_id: string;
  display_name: string;
  profile_notes: unknown;
  principal_id: string | null;
  controller_mode: string;
}

export interface RecordRuntimeScopeRepository {
  resolve(scope: {
    workspaceId: string;
    principalId: string;
    recordId: string;
  }): Promise<RecordRuntimeScope | null>;
}

export function createPostgresRecordRuntimeScopeRepository(
  database: WorkspaceDatabase,
): RecordRuntimeScopeRepository {
  return {
    async resolve({ workspaceId, principalId, recordId }) {
      // SWM v2：effective cursor（canon temporal 过滤用）随事务带出。
      // SWM 下一阶段（G4）：lore 资格用完整 tuple（tick + ordinal）。
      let effectiveTick = 0;
      let effectiveOrdinal = 0;
      const scope = await withWorkspaceTransaction(
        database,
        workspaceId,
        async (client) => {
          const record = await client.query<RecordRow>(
            `SELECT
               record.world_id,
               record.worldline_id,
               worldline.head_tick,
               worldline.head_ordinal,
               COALESCE(rhead.last_world_tick, record.start_tick) AS record_head_tick,
               COALESCE(rhead.last_world_ordinal, record.start_ordinal) AS record_head_ordinal,
               record.story_id,
               world.calendar_id,
               COALESCE(world.settings->>'displayTime', '') AS display_time,
               COALESCE(world.settings->>'style', '') AS style,
               COALESCE(world.settings->>'language', 'zh-CN') AS language,
               world.name AS world_name,
               world.status AS world_status,
               COALESCE(world.settings->>'era', '') AS era,
               COALESCE(world.summary, '') AS summary,
               COALESCE(world.settings->>'weather', '') AS weather,
               COALESCE(world.settings->>'tension', '') AS tension,
               COALESCE(to_jsonb(record)->>'timeline_kind', 'primary') AS timeline_kind,
               (
                 to_jsonb(record)->>'timeline_kind' = 'retrospection'
                 AND NOT EXISTS (
                   SELECT 1 FROM events AS existing_event
                   WHERE existing_event.workspace_id = record.workspace_id
                     AND existing_event.record_id = record.id
                 )
               ) AS empty_retrospection,
               story.title AS story_title,
               COALESCE(story.premise, '') AS premise
             FROM records AS record
             JOIN worlds AS world
               ON world.workspace_id = record.workspace_id
              AND world.id = record.world_id
             JOIN worldlines AS worldline
               ON worldline.workspace_id = record.workspace_id
              AND worldline.id = record.worldline_id
             LEFT JOIN record_heads AS rhead
               ON rhead.workspace_id = record.workspace_id
              AND rhead.record_id = record.id
             JOIN stories AS story
               ON story.workspace_id = record.workspace_id
              AND story.id = record.story_id
             WHERE record.workspace_id = $1 AND record.id = $2
               AND record.status <> 'archived'`,
            [workspaceId, recordId],
          );
          const recordRow = record.rows[0];
          if (!recordRow) return null;
          // SWM v2 验收修正②：canon/lore 的 effective cursor 用 Record head
          // （COALESCE(record_heads.last_world_tick, record.start_tick)），
          // 与 delivery projection/action-state/晶化一致；worldline 全局
          // head 不得把其他 Record 推进的 future claim 带进本 Record。
          effectiveTick = Number(recordRow.record_head_tick);
          effectiveOrdinal = Number(recordRow.record_head_ordinal);

          const scene = await client.query<SceneRow>(
            `SELECT id, location, objective,
                    to_jsonb(scenes)->>'tension' AS tension,
                    to_jsonb(scenes)->>'weather' AS weather,
                    to_jsonb(scenes)->>'display_time' AS display_time
             FROM scenes
             WHERE workspace_id = $1 AND record_id = $2
             ORDER BY start_tick DESC, start_ordinal DESC, id ASC
             LIMIT 1`,
            [workspaceId, recordId],
          );
          const policy = await client.query<PolicyRow>(
            `SELECT id
             FROM visibility_policies
             WHERE workspace_id = $1 AND record_id = $2 AND policy_kind = 'public'
             ORDER BY policy_version ASC, id ASC
             LIMIT 1`,
            [workspaceId, recordId],
          );
          const sceneId = scene.rows[0]?.id;
          const publicPolicyId = policy.rows[0]?.id;
          if (!sceneId || !publicPolicyId) return null;

          const actors = await client.query<ActorRow>(
            `SELECT
               participant.participant_kind,
               instance.id AS character_instance_id,
               participant.id AS participant_id,
               COALESCE(definition.display_name, '') AS display_name,
               COALESCE(NULLIF(instance.state->>'profileSummary', ''), definition.profile->>'summary', '') AS profile_summary,
               instance.state -> 'profileNotes' AS profile_notes,
               participant.principal_id,
               participant.controller_mode
             FROM participants AS participant
             LEFT JOIN character_instances AS instance
               ON instance.workspace_id = participant.workspace_id
              AND instance.id = participant.character_instance_id
             LEFT JOIN character_continuities AS continuity
               ON continuity.workspace_id = instance.workspace_id
              AND continuity.id = instance.continuity_id
             LEFT JOIN character_definitions AS definition
               ON definition.workspace_id = continuity.workspace_id
              AND definition.id = continuity.definition_id
             WHERE participant.workspace_id = $1
               AND participant.record_id = $2
               AND participant.participant_kind IN ('character', 'narrator')
               AND participant.is_active = true
               AND (
                 participant.participant_kind <> 'character'
                 OR instance.status NOT IN ('gone', 'retired')
               )
             ORDER BY participant.speaking_order ASC, participant.id ASC`,
            [workspaceId, recordId],
          );
          const recentPublicEvents = await client.query<{
            content: string;
            speaker_name: string;
            actor_participant_id: string | null;
            recipient_id: string | null;
          }>(
            `SELECT LEFT(event.content, 400) AS content,
                    event.speaker_name,
                    event.actor_participant_id,
                    event.payload ->> 'recipientId' AS recipient_id
             FROM events AS event
             JOIN visibility_policies AS policy
               ON policy.workspace_id = event.workspace_id
              AND policy.world_id = event.world_id
              AND policy.worldline_id = event.worldline_id
              AND policy.record_id = event.record_id
              AND policy.id = event.visibility_policy_id
             WHERE event.workspace_id = $1
               AND event.record_id = $2
               AND (event.world_tick, event.world_ordinal)
                 <= ($3::bigint, $4::bigint)
               AND policy.policy_kind = 'public'
               AND event.event_kind IN (
                 'utterance.committed',
                 'narration.committed',
                 'action.transaction.committed'
               )
             ORDER BY event.world_tick DESC, event.world_ordinal DESC, event.id DESC
             LIMIT 12`,
            [workspaceId, recordId, recordRow.head_tick, recordRow.head_ordinal],
          );
          const publicEventContext = recentPublicEvents.rows
            .map((row) => row.content.trim())
            .filter((content) => content.length > 0)
            .reverse();
          // 带主体信息的公开对话摘要：与 recentPublicEvents 同源（同一授权
          // WHERE + policy_kind='public'），speaker/recipient 只承载
          // participantId 对齐信息，供 Character Runner 消费，不渲染给玩家。
          const recentPublicDialogue: PublicDialogueLine[] = recentPublicEvents.rows
            .map((row) => ({
              speaker: row.speaker_name,
              speakerParticipantId: row.actor_participant_id,
              recipientId: row.recipient_id,
              text: row.content.trim(),
            }))
            .filter((line) => line.text.length > 0)
            .reverse();
          // 批次 S：玩家席位按身份解析。观察者（人类 narrator 席位）优先，
          // 其次精确匹配当前 principal → 人类 controller → participant_player
          // 前缀。绝不按角色名兜底，避免跨世界带入其他世界的设定。
          const narratorSeat = actors.rows.find((actor) =>
            actor.participant_kind === "narrator"
            && actor.principal_id === principalId
            && actor.controller_mode === "human"
          );
          const characterSeat = actors.rows.find((actor) =>
            actor.participant_kind === "character"
            && actor.principal_id === principalId
            && actor.controller_mode === "human"
          ) ?? actors.rows.find((actor) =>
            actor.participant_kind === "character"
            && actor.controller_mode === "human"
          ) ?? actors.rows.find((actor) =>
            actor.participant_id.startsWith("participant_player")
          );
          const playerActorRow = narratorSeat ?? characterSeat;
          if (!playerActorRow) return null;

          const playerActor = await toPlayerActor(
            client,
            workspaceId,
            principalId,
            playerActorRow,
            effectiveTick,
          );
          const aiCharacters = actors.rows.filter((actor) =>
            actor.participant_kind === "character"
            && actor.participant_id !== playerActor.participantId
          );

          return {
            workspaceId,
            principalId,
            worldId: recordRow.world_id,
            worldStatus: recordRow.world_status,
            worldlineId: recordRow.worldline_id,
            storyId: recordRow.story_id,
            recordId,
            sceneId,
            publicPolicyId,
            calendarId: recordRow.calendar_id,
            // 批次 T12 验收修正：displayTime/weather 以当前 Record 的 scene
            // 快照为准；无快照的 retrospection fail-closed 为空（不得回退
            // worlds.settings 把旧重演拉到当前世界时间/天气），primary 旧
            // 数据保留 settings 兼容回退。
            displayTime: scene.rows[0]?.display_time
              ? scene.rows[0].display_time
              : recordRow.timeline_kind === "retrospection"
                ? ""
                : recordRow.display_time,
            style: normalizeWorldStyle(recordRow.style),
            language: recordRow.language || "zh-CN",
            brief: {
              worldName: recordRow.world_name,
              era: recordRow.era,
              summary: recordRow.summary,
              storyTitle: recordRow.story_title,
              premise: recordRow.premise,
              location: scene.rows[0]?.location ?? "",
              // 批次 T12：scene weather 快照优先；无快照的 retrospection
              // fail-closed 为空，primary 旧数据回退 worlds.settings。
              weather: scene.rows[0]?.weather
                ? scene.rows[0].weather
                : recordRow.timeline_kind === "retrospection"
                  ? ""
                  : recordRow.weather,
              tension: recordRow.empty_retrospection
                ? ""
                : scene.rows[0]?.tension ?? recordRow.tension,
              objective: recordRow.empty_retrospection
                ? ""
                : scene.rows[0]?.objective ?? "",
              canon: "",
              worldLore: "",
            },
            playerActor,
            aiCharacters: aiCharacters.map((actor) =>
              toActor(actor, effectiveTick)
            ),
            observerCharacterInstanceIds: actors.rows
              .filter((actor) => actor.participant_kind === "character")
              .map((actor) => actor.character_instance_id)
              .filter((id): id is string => typeof id === "string" && id.length > 0),
            recentPublicEvents: publicEventContext,
            recentPublicDialogue,
            recordKnowledge: [] as readonly string[],
          };
        },
        { readOnly: true },
      );
      if (!scope) return null;
      // 批次 T9 canon（消费侧）独立只读事务：fail-closed 空串，且不与主
      // scope 同事务——PG 中失败语句会中止整个事务（T10-B6 实锤：缺治理
      // 迁移的库上 canon 查询曾毒化 scope 主读取）。
      // SWM v2/G4：effective cursor = 本 Record 的 head tuple（COALESCE(
      // record_heads.last_world_tick, record.start_tick) + ordinal 同理）；
      // canon temporal 用 tick 粒度（claim 无 ordinal 列），lore 资格用完整
      // tuple；canon 与 lore 同事务读取（资格单源，lore 至多 1 查询）。
      // growth 读回并入同一事务同一查询（见 readCanonAndLore）：canon 与
      // record 知识同一条 world_claims SQL（UNION ALL 区段标记），每回合
      // 只读一次图谱（turn-efficiency 预算 canonRead=1）。
      const { canon, worldLore, recordKnowledge } = await readCanonAndLore(
        database,
        workspaceId,
        scope.worldId,
        scope.worldlineId,
        recordId,
        effectiveTick,
        effectiveOrdinal,
      );
      scope.brief.canon = canon;
      scope.brief.worldLore = worldLore;
      scope.recordKnowledge = recordKnowledge;
      return scope;
    },
  };
}

/**
 * 批次 T9：本世界线 story_canon 以上 Claim 的正史行（supersede 链取最新、
 * 确定性排序、上限 12、单条 ≤160 字）；任何失败 fail-closed 为空串。
 * canon 注入必须满足双重闸门——
 * ① security：排除 restricted/secret revision 晋升的 claim（经
 *    information_campaigns.root_claim_ids + canon_revision_id 反查
 *    security_class；无 campaign 链接的 claim 按 public eligible——plain
 *    public merge 不产生 campaign，public revision 是默认值）；
 * ② temporal：绑定 Record 当前 effective world cursor——
 *    valid_from_tick <= cursor（inclusive）且
 *    (valid_to_tick IS NULL OR valid_to_tick > cursor)（exclusive）。
 *
 * SWM 下一阶段（G4，plan v10 §3.2）：lore 资格 attested-only，全部 AND
 * 无旁路——当前 worldline + latest qualification = qualified_public /
 * owner_attest + content_hash DB-side（pgcrypto digest/encode）匹配 +
 * Record head tuple (tick, ordinal) >= (available_from_tick,
 * available_from_ordinal) + claim_ids 为空 + 预算。claim 链接本身不再授予
 * 资格（链接合格 ≠ 正文安全）；无资格行 = pending_review fail-closed；
 * revoke 立即全隐藏；不 retroactive。excerpt 每条约 600 字符、至多 2 条、
 * 保留 title 来源标签。
 * 缺 0041/pgcrypto 的库（如本阶段共享 realm_dev）：探测后 lore 跳过
 * （fail-closed 空注入），canon 照常——探测结果按连接池缓存，migration
 * 后需重启进程生效。
 */
const LORE_EXCERPT_CHARS = 600;
const LORE_TITLE_CHARS = 80;
const LORE_MAX_EXCERPTS = 2;
/** lore 段渲染后总长度硬上限（含标题标签与连接符）。 */
const LORE_BLOCK_MAX_CHARS = 1200;

/**
 * G4：article_qualifications 表 + pgcrypto 的存在性探测（每连接池一次，
 * 缓存在模块级）。未应用 0041 的库 fail-closed：lore 查询整体跳过，
 * canon 事务不受影响（失败的 lore 语句会中止整个事务——T10-B6 教训）。
 */
const loreSchemaSupport = new WeakMap<WorkspaceDatabase, boolean>();
async function probeLoreSchemaSupport(
  database: WorkspaceDatabase,
  client: PoolClient,
): Promise<boolean> {
  const cached = loreSchemaSupport.get(database);
  if (cached !== undefined) return cached;
  const probe = await client.query<{
    qualifications: string | null;
    pgcrypto: number;
  }>(
    `SELECT to_regclass('public.article_qualifications') AS qualifications,
            (SELECT count(*)::int FROM pg_extension WHERE extname = 'pgcrypto') AS pgcrypto`,
  );
  const supported = Boolean(probe.rows[0]?.qualifications)
    && Number(probe.rows[0]?.pgcrypto) > 0;
  loreSchemaSupport.set(database, supported);
  return supported;
}

/**
 * 合格 canon claim 过滤体（canon 展示与 lore 资格共用同一 SQL 片段，
 * 防止双实现漂移）：worldline + truthStatus 阶梯 + temporal（cursor）
 * + supersede 最新链 + security（restricted/secret revision 关联排除）。
 */
const CANON_ELIGIBILITY_WHERE = `
  claim.workspace_id = $1
  AND claim.world_id = $2
  AND claim.worldline_id = $3
  AND claim.truth_status IN ('story_canon', 'world_canon')
  AND claim.valid_from_tick <= $4::bigint
  AND (claim.valid_to_tick IS NULL OR claim.valid_to_tick > $4::bigint)
  -- 时序安全 supersede：只有 newer 自身在当前 effective cursor 有效
  -- （valid_from inclusive / valid_to exclusive）才隐藏旧 claim；
  -- future superseder 不提前生效，expired superseder 不回头遮蔽。
  AND NOT EXISTS (
    SELECT 1 FROM world_claims AS newer
    WHERE newer.workspace_id = claim.workspace_id
      AND newer.supersedes_claim_id = claim.id
      AND newer.valid_from_tick <= $4::bigint
      AND (newer.valid_to_tick IS NULL OR newer.valid_to_tick > $4::bigint)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM information_campaigns AS campaign
    JOIN canon_revisions AS revision
      ON revision.workspace_id = campaign.workspace_id
     AND revision.id = campaign.canon_revision_id
    WHERE campaign.workspace_id = claim.workspace_id
      AND campaign.world_id = claim.world_id
      AND campaign.worldline_id = claim.worldline_id
      AND claim.id = ANY(campaign.root_claim_ids)
      AND revision.security_class <> 'public'
  )
`;

async function readCanonAndLore(
  database: WorkspaceDatabase,
  workspaceId: string,
  worldId: string,
  worldlineId: string,
  recordId: string,
  effectiveTick: number,
  effectiveOrdinal: number,
): Promise<{
  canon: string;
  worldLore: string;
  recordKnowledge: readonly string[];
}> {
  const empty = { canon: "", worldLore: "", recordKnowledge: [] as string[] };
  try {
    return await withWorkspaceTransaction(
      database,
      workspaceId,
      async (client) => {
        // canon 展示 + record 级 growth 知识：同一条 world_claims 查询
        // （UNION ALL 区段标记），每回合只读一次图谱；各自 DB 侧
        // LIMIT 13（应用再截 12），不读全量。record 区段只取本 Record
        // 来源的 record_confirmed claim——record-local 背景，绝不混入
        // canon（canon 仍只认 story_canon 以上 + security 闸门）。
        const canonRows = await client.query<{
          section: string;
          entity_name: string;
          predicate: string;
          object_value: string;
        }>(
          `SELECT * FROM (
             SELECT 'canon' AS section,
                    entity.name AS entity_name, claim.predicate, claim.object_value
             FROM world_claims AS claim
             JOIN world_entities AS entity
               ON entity.workspace_id = claim.workspace_id
              AND entity.id = claim.subject_entity_id
             WHERE ${CANON_ELIGIBILITY_WHERE}
             ORDER BY claim.truth_status DESC, claim.valid_from_tick ASC,
                      claim.created_at ASC, claim.id ASC
             LIMIT 13
           ) AS canon_section
           UNION ALL
           SELECT * FROM (
             SELECT 'record' AS section,
                    entity.name AS entity_name, claim.predicate, claim.object_value
             FROM world_claims AS claim
             JOIN world_entities AS entity
               ON entity.workspace_id = claim.workspace_id
              AND entity.id = claim.subject_entity_id
             WHERE claim.workspace_id = $1
               AND claim.world_id = $2
               AND claim.worldline_id = $3
               AND claim.scope = 'record'
               AND claim.truth_status = 'record_confirmed'
               AND claim.source_record_id = $5
               AND claim.valid_from_tick <= $4::bigint
               AND (claim.valid_to_tick IS NULL OR claim.valid_to_tick > $4::bigint)
               AND NOT EXISTS (
                 SELECT 1 FROM world_claims AS newer
                 WHERE newer.workspace_id = claim.workspace_id
                   AND newer.supersedes_claim_id = claim.id
                   AND newer.valid_from_tick <= $4::bigint
                   AND (newer.valid_to_tick IS NULL OR newer.valid_to_tick > $4::bigint)
               )
             ORDER BY claim.created_at ASC, claim.id ASC
             LIMIT 13
           ) AS record_section`,
          [workspaceId, worldId, worldlineId, effectiveTick, recordId],
        );
        const rows = canonRows.rows.filter((row) => row.section === "canon");
        const recordRows = canonRows.rows.filter(
          (row) => row.section === "record",
        );
        if (rows.length > 12) {
          console.warn(
            `[realm] canon readout exceeded 12 claims for world ${worldId}; truncating`,
          );
        }
        if (recordRows.length > 12) {
          console.warn(
            `[realm] record knowledge readout exceeded 12 claims for record ${recordId}; truncating`,
          );
        }
        const canon = rows.slice(0, 12).map((row) =>
          `- ${row.entity_name} ${row.predicate}：${row.object_value}`
            .slice(0, 160)
        ).join("\n");
        const recordKnowledge = recordRows.slice(0, 12).map((row) =>
          `- ${row.entity_name} ${row.predicate}：${row.object_value}`
            .slice(0, 160)
        );

        // lore 资格（G4 attested-only，plan v10 §3.2 唯一谓词，全部 AND）：
        // 资格判定完全在 SQL 内（DISTINCT ON latest-state + DB-side hash +
        // tuple 行比较 + 空 claim_ids），不把资格行物化到应用；缺 0041 /
        // pgcrypto 的库经探测跳过（fail-closed 空注入，canon 不受影响）。
        const loreSupported = await probeLoreSchemaSupport(database, client);
        const loreRows = loreSupported
          ? await client.query<{ title: string; excerpt: string }>(
              `SELECT LEFT(article.title, ${LORE_TITLE_CHARS}) AS title,
                      LEFT(article.body, ${LORE_EXCERPT_CHARS}) AS excerpt
               FROM world_articles AS article
               JOIN (
                 SELECT DISTINCT ON (qual.article_id)
                   qual.article_id,
                   qual.status,
                   qual.provenance_kind,
                   qual.content_hash,
                   qual.available_from_tick,
                   qual.available_from_ordinal
                 FROM article_qualifications AS qual
                 WHERE qual.workspace_id = $1
                   AND qual.world_id = $2
                   AND qual.worldline_id = $3
                 ORDER BY qual.article_id, qual.seq DESC, qual.id DESC
               ) AS latest
                 ON latest.article_id = article.id
               WHERE article.workspace_id = $1
                 AND article.world_id = $2
                 AND article.worldline_id = $3
                 AND latest.status = 'qualified_public'
                 AND latest.provenance_kind = 'owner_attest'
                 AND latest.content_hash = encode(
                       digest(
                         article.id || E'\n' || article.title || E'\n' || article.body,
                         'sha256'
                       ),
                       'hex'
                     )
                 AND ($4::bigint, $5::bigint)
                     >= (latest.available_from_tick, latest.available_from_ordinal)
                 AND COALESCE(array_length(article.claim_ids, 1), 0) = 0
               ORDER BY article.created_at DESC, article.id ASC
               LIMIT ${LORE_MAX_EXCERPTS}`,
              [
                workspaceId,
                worldId,
                worldlineId,
                effectiveTick,
                effectiveOrdinal,
              ],
            )
          : { rows: [] as { title: string; excerpt: string }[] };
        // 渲染预算：标题/正文各自有界（SQL LEFT），纯截断/空行排除，
        // 逐行累加至总硬上限 LORE_BLOCK_MAX_CHARS（不 mid-line 截断）。
        const loreLines: string[] = [];
        let loreLength = 0;
        for (const row of loreRows.rows) {
          const body = row.excerpt.trim();
          if (!body) continue;
          const line = `- 《${row.title.trim()}》：${body}`;
          const separator = loreLines.length > 0 ? 1 : 0;
          if (loreLength + separator + line.length > LORE_BLOCK_MAX_CHARS) {
            break;
          }
          loreLines.push(line);
          loreLength += separator + line.length;
        }
        return { canon, worldLore: loreLines.join("\n"), recordKnowledge };
      },
      { readOnly: true },
    );
  } catch (error) {
    console.warn(`[realm] canon readout failed (fail-closed empty): ${
      error instanceof Error ? error.message : String(error)
    }`);
    return empty;
  }
}

function toActor(row: ActorRow, effectiveTick: number): RuntimeActor {
  return {
    characterInstanceId: row.character_instance_id ?? "",
    participantId: row.participant_id,
    displayName: row.display_name,
    profileSummary: combineProfileSummary(
      row.profile_summary,
      row.profile_notes,
      effectiveTick,
    ),
  };
}

/**
 * profileSummary 合成：定义简介/显式自述为基底，growth notes（state
 * .profileNotes 数组）追加在后——只追加合并，绝不覆盖基底设定；
 * 总长度封顶 600（Prompt 消费预算）。
 * Batch 4B：双读——旧字符串原样渲染；object entry 只渲染当前有效的
 * note 文本（revoked/过期/未来不渲染，cursor 用本 Record head 的
 * effectiveTick，绝不用 global worldline head）；metadata（source IDs/
 * cursor/timestamps/revocation）绝不进入 prompt。
 */
function combineProfileSummary(
  base: string,
  notes: unknown,
  effectiveTick: number,
): string {
  const noteLines = Array.isArray(notes)
    ? notes
      .map((note) => profileNoteTextAt(note, effectiveTick))
      .filter((text): text is string => text !== null && text.length > 0)
    : [];
  if (noteLines.length === 0) return base;
  return [base.trim(), ...noteLines]
    .filter((part) => part.length > 0)
    .join("；")
    .slice(0, 600);
}

/**
 * 批次 S：观察者的人类 narrator 席位没有角色定义，displayName 取账号昵称；
 * 角色席位沿用定义名。characterInstanceId 允许为空串占位（类型不变）。
 */
async function toPlayerActor(
  client: PoolClient,
  workspaceId: string,
  principalId: string,
  row: ActorRow,
  effectiveTick: number,
): Promise<RuntimeActor> {
  const actor = toActor(row, effectiveTick);
  if (row.participant_kind !== "narrator") return actor;
  const account = await client.query<{ display_name: string }>(
    `SELECT display_name
     FROM accounts
     WHERE workspace_id = $1 AND principal_id = $2`,
    [workspaceId, principalId],
  );
  const nickname = account.rows[0]?.display_name?.trim() ?? "";
  return { ...actor, displayName: nickname || "旅人" };
}
