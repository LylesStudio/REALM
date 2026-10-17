import type { PoolClient } from "pg";
import {
  GoalRuntimeRepositoryError,
} from "./goal-assessment-job-queue.ts";
import {
  goalAssessmentJobIdFor,
  goalInstanceIdFor,
  goalScopeKind,
  type GoalState,
  type GoalScope,
  type GoalRuntimeScope,
  type GoalStoryScope,
} from "../../modules/goals/public.ts";

/**
 * Goal runtime materialization（RealmWorld Phase 3 续）：声明式 Goal 在
 * 创建 Record 的同一 workspace 事务内物化为 goal_instances，并在正式事件
 * 提交（opening / commitRelease）的同一事务内 enqueue 耐久的
 * goal_assessment_jobs。
 *
 * 硬边界（REALMWORLD-ENGINE-UPGRADE-PLAN §2.2）：这里只写 Record-scoped
 * runtime state（goal key、policy version、active/revision/progress/
 * outcome）；Goal 定义与 rubric 仍留在已安装/签名/trust-store 的
 * RealmWorld 内容层，绝不复制进数据库。
 *
 * 本模块不复用 goal-assessment-job-queue.ts 的 enqueue：那个入口自带
 * 独立事务，而本模块的全部函数都在调用方既有事务的 client 上执行——
 * 失败即整体回滚，绝不在事务外补写。
 */

export interface GoalMaterializationDeclaration {
  goalKey: string;
  policyVersion: string;
}

export interface GoalCommittedEventScope extends GoalRuntimeScope {
  /** 本次事务内真实提交的正式事件 id（opening 事件或 release 批次）。 */
  eventIds: readonly string[];
}

/**
 * 分支克隆的源 Goal 快照（createRecordBranchInTransaction 的 fork 门禁与
 * 克隆数据源）。completedAt 必须随 state 一起保留——0055 的 CHECK 要求
 * terminal state 与 completed_at 同真同假，缺一角即约束冲突、整事务回滚。
 */
export interface GoalBranchCloneSource {
  definitionSource?: 'record';
  goalKey: string;
  state: GoalState;
  /** bigint 列的文本形态（node-pg 默认），回写时由 bigint 列直接接受。 */
  revision: string;
  progress: unknown;
  outcome: unknown;
  policyVersion: string;
  completedAt: Date | null;
  /** 源 attempt（int4；分支克隆保留 attempt，supersedes 不随分支复制）。 */
  attempt: number;
}

/**
 * 分支门禁读取：锁定源 Record 的全部 goal_instances 行（FOR UPDATE）供
 * fork 门禁判定与当前 head 克隆使用。
 *
 * - 源 Record 无 Goal 时是一次安全的空读——旧无 Goal 路径除这次空读外
 *   不引入任何 Goal schema 写入，行为逐字节不变；
 * - FOR UPDATE 把分支克隆与 assessment worker 的并发 Goal 状态推进
 *   串行化：克隆到的就是本事务看到的确定状态，绝不读写之间的半新快照；
 * - 调用方语义（fail-closed）：返回非空且 fork ≠ 源 record 当前有效 head
 *   时必须在写入任何拓扑行之前拒绝（BRANCH_GOAL_STATE_UNAVAILABLE）——
 *   不猜测历史 fork 点的语义/确定性 Goal 状态。
 */
export async function lockGoalInstancesForBranch(
  client: PoolClient,
  workspaceId: string,
  sourceRecordId: string,
): Promise<readonly GoalBranchCloneSource[]> {
  const result = await client.query<{
    goal_key: string;
    definition_source: string;
    state: GoalState;
    revision: string;
    progress: unknown;
    outcome: unknown;
    policy_version: string;
    completed_at: Date | null;
    attempt: number;
  }>(
    `SELECT goal_key, state, revision::text AS revision,
            progress, outcome, policy_version, completed_at, attempt,
            COALESCE(to_jsonb(goal)->>'definition_source','content') AS definition_source
     FROM goal_instances goal
     WHERE workspace_id = $1 AND record_id = $2 AND scope_kind = 'record'
     ORDER BY goal_key
     FOR UPDATE`,
    [workspaceId, sourceRecordId],
  );
  return result.rows.map((row) => ({
    ...(row.definition_source==='record'?{definitionSource:'record' as const}:{}),
    goalKey: row.goal_key,
    state: row.state,
    revision: row.revision,
    progress: row.progress,
    outcome: row.outcome,
    policyVersion: row.policy_version,
    completedAt: row.completed_at,
    attempt: row.attempt,
  }));
}

/**
 * 当前 head 分支的 Goal 克隆：把源快照逐行克隆进目标 Record scope，
 * instance id 由目标 Record scope + goalKey 确定性派生
 * （goalInstanceIdFor——分支重放/幂等不会产出不同 id）。
 *
 * - 逐字节保留 goal_key/state/revision/progress/outcome/policy_version/
 *   completed_at（terminal 语义随 completed_at 一起克隆）；
 * - 绝不克隆源 record 的 goal_assessment_jobs 或不可变
 *   goal_assessments——分支从零 assessment 队列/台账起步；
 * - plain INSERT（无 ON CONFLICT）：identity 碰撞、UNIQUE
 *   (workspace_id, record_id, goal_key)、CHECK（含 terminal ⇔
 *   completed_at 形状）或 RLS 不符都直接中止整个 workspace 事务，
 *   fail-closed 且零拓扑残留。
 *
 * 返回克隆的 instance id（顺序与输入一致）。
 */
export async function cloneGoalInstancesForBranch(
  client: PoolClient,
  target: GoalRuntimeScope,
  goals: readonly GoalBranchCloneSource[],
): Promise<readonly string[]> {
  const ids: string[] = [];
  for (const goal of goals) {
    const id = goalInstanceIdFor(target, goal.goalKey, goal.attempt);
    await client.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, scope_kind, id,
         goal_key, state, revision, progress, outcome, policy_version,
         completed_at, attempt
       ) VALUES ($1, $2, $3, $4, 'record', $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12, $13)`,
      [
        target.workspaceId,
        target.worldId,
        target.worldlineId,
        target.recordId,
        id,
        goal.goalKey,
        goal.state,
        goal.revision,
        JSON.stringify(goal.progress ?? {}),
        goal.outcome === null || goal.outcome === undefined
          ? null
          : JSON.stringify(goal.outcome),
        goal.policyVersion,
        goal.completedAt,
        goal.attempt,
      ],
    );
    ids.push(id);
  }
  return ids;
}

/**
 * 物化声明式 Goal 为 goal_instances 行（state='active'、revision=0、
 * progress='{}'、outcome=NULL、attempt=1）。scope 为判别联合
 * （record | story | worldline）；Record scope 的 instance id 保持历史
 * digest，story/worldline scope 使用域分隔的新 digest。调用方负责在事
 * 前校验声明合法性（非空/去重）；此处使用无 ON CONFLICT 的 plain
 * INSERT——任何冲突（重复 goalKey、scope 锚 CHECK、identity 碰撞、
 * RLS/workspace 不符）都中止事务，fail-closed 且零残留。返回物化的
 * instance id（顺序与输入一致）。
 */
export async function materializeGoalInstances(
  client: PoolClient,
  scope: GoalScope,
  goals: readonly GoalMaterializationDeclaration[],
): Promise<readonly string[]> {
  const scopeKind = goalScopeKind(scope);
  const recordId = scopeKind === "record"
    ? (scope as GoalRuntimeScope).recordId
    : null;
  const storyId = scopeKind === "story"
    ? (scope as GoalStoryScope).storyId
    : null;
  const ids: string[] = [];
  for (const goal of goals) {
    const id = goalInstanceIdFor(scope, goal.goalKey);
    await client.query(
      `INSERT INTO goal_instances (
         workspace_id, world_id, worldline_id, record_id, story_id,
         scope_kind, id, goal_key,
         state, revision, progress, outcome, policy_version, attempt
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'active', 0, '{}'::jsonb, NULL, $9, 1)`,
      [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        recordId,
        storyId,
        scopeKind,
        id,
        goal.goalKey,
        goal.policyVersion,
      ],
    );
    ids.push(id);
  }
  return ids;
}

export interface GoalRetryDeclaration extends GoalMaterializationDeclaration {
  /** 内容声明的 retryable；未显式声明 retryable: true 时拒绝重试。 */
  retryable?: boolean;
}

/**
 * 终态重试（B1）：为同 scope+goalKey 的最新终态实例开启新 attempt——
 * 新确定性 instance id（goalInstanceIdFor(scope, goalKey, attempt)）、
 * supersedes_instance_id 指向前序终态实例、state='active'、revision=0。
 *
 * - 终态绝不原地复活：旧实例行不被 UPDATE（0060 终态不可变触发器
 *   兜底）；
 * - 同 scope+goal_key 只能一个 active：旧实例仍 active 时抛
 *   GOAL_RETRY_ACTIVE_EXISTS；partial unique index
 *   goal_instances_scope_single_active_key 在并发下兜底；
 * - 调用方必须在同一 workspace 事务内调用；任何冲突 fail-closed 中止
 *   事务，零残留。
 *
 * 返回新 attempt 的 instance id。
 */
export async function retryGoalInstance(
  client: PoolClient,
  scope: GoalScope,
  goal: GoalRetryDeclaration,
): Promise<string> {
  if (goal.retryable !== true) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_RETRY_NOT_ALLOWED",
      "Goal content does not allow retrying this terminal instance.",
    );
  }
  const scopeKind = goalScopeKind(scope);
  const scopeFilter = scopeKind === "record"
    ? "scope_kind = 'record' AND record_id = $4"
    : scopeKind === "story"
      ? "scope_kind = 'story' AND story_id = $4"
      : "scope_kind = 'worldline'";
  const scopeParams: string[] = scopeKind === "worldline"
    ? [scope.workspaceId, scope.worldId, scope.worldlineId]
    : [
        scope.workspaceId,
        scope.worldId,
        scope.worldlineId,
        scopeKind === "story"
          ? (scope as GoalStoryScope).storyId
          : (scope as GoalRuntimeScope).recordId,
      ];
  const goalKeyParam = scopeParams.length + 1;
  const previousResult = await client.query<{
    id: string;
    state: GoalState;
    attempt: number;
  }>(
    `SELECT id, state, attempt
     FROM goal_instances
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
       AND ${scopeFilter}
       AND goal_key = $${goalKeyParam}
     ORDER BY attempt DESC
     LIMIT 1
     FOR UPDATE`,
    [...scopeParams, goal.goalKey],
  );
  const previous = previousResult.rows[0];
  if (!previous) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_RETRY_SOURCE_NOT_FOUND",
      "Goal retry requires an existing terminal instance.",
    );
  }
  if (previous.state === "active") {
    throw new GoalRuntimeRepositoryError(
      "GOAL_RETRY_ACTIVE_EXISTS",
      "Goal retry is refused while an active attempt exists.",
    );
  }
  const attempt = previous.attempt + 1;
  const id = goalInstanceIdFor(scope, goal.goalKey, attempt);
  await client.query(
    `INSERT INTO goal_instances (
       workspace_id, world_id, worldline_id, record_id, story_id,
       scope_kind, id, goal_key,
       state, revision, progress, outcome, policy_version,
       attempt, supersedes_instance_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
               'active', 0, '{}'::jsonb, NULL, $9, $10, $11)`,
    [
      scope.workspaceId,
      scope.worldId,
      scope.worldlineId,
      scopeKind === "record" ? (scope as GoalRuntimeScope).recordId : null,
      scopeKind === "story" ? (scope as GoalStoryScope).storyId : null,
      scopeKind,
      id,
      goal.goalKey,
      goal.policyVersion,
      attempt,
      previous.id,
    ],
  );
  return id;
}

/**
 * 为本事务内已提交的正式事件 reconcile durable assessment jobs：只对该 Record
 * 仍 active 的每个 Goal × 每条事件一行。terminal Goal 永不被重新打开、翻转或
 * 重新排队；这条 active-only 边界就是 Goal runtime 的 reconcile 入口。
 *
 * - 作用域精确到 Record binding（world_id/worldline_id/record_id 均取自
 *   Record scope，不读 worlds.world_version）；world_version 的解析仍由
 *   claim 路径从 records.world_version 读取（Phase 4D）。
 * - dedupe：同一 (goal_instance_id, source_event_id) 重新 enqueue 时，只有
 *   已存在且 id 仍等于确定性派生值的行才允许无副作用 replay；natural key
 *   对应非派生 id 会抛出 identity conflict，绝不静默合并；job id 由
 *   goalAssessmentJobIdFor 确定性派生，digest 碰撞即 PK 冲突中止事务。
 * - 无 active Goal 或无事件时零写入（旧 base/genesis 路径无行为变化）。
 *
 * 返回实际插入的 job 数。
 */
export async function reconcileGoalAssessmentJobsForCommittedEvents(
  client: PoolClient,
  committed: GoalCommittedEventScope,
): Promise<number> {
  if (committed.eventIds.length === 0) return 0;
  const activeGoalResult = await client.query<{
    id: string | null;
    current_workspace_id: string | null;
  }>(
    `WITH current_scope AS (
       SELECT NULLIF(current_setting('realm.workspace_id', true), '') AS current_workspace_id
     )
     SELECT goal.id, current_scope.current_workspace_id
     FROM current_scope
     LEFT JOIN goal_instances AS goal
       ON current_scope.current_workspace_id = $1
      AND goal.workspace_id = $1
      AND goal.world_id = $2
      AND goal.worldline_id = $3
      AND goal.record_id = $4
      AND goal.scope_kind = 'record'
      AND goal.state = 'active'
     ORDER BY goal.id`,
    [
      committed.workspaceId,
      committed.worldId,
      committed.worldlineId,
      committed.recordId,
    ],
  );
  const currentWorkspaceId = activeGoalResult.rows[0]?.current_workspace_id ?? null;
  if (currentWorkspaceId !== committed.workspaceId) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_SCOPE_MISMATCH",
      "Goal assessment enqueue requires an exact workspace transaction scope.",
    );
  }
  const activeGoals = activeGoalResult.rows.filter(
    (row): row is { id: string; current_workspace_id: string } => row.id !== null,
  );
  if (activeGoals.length === 0) return 0;
  const jobIds: string[] = [];
  const goalInstanceIds: string[] = [];
  const sourceEventIds: string[] = [];
  for (const sourceEventId of committed.eventIds) {
    for (const goal of activeGoals) {
      jobIds.push(
        goalAssessmentJobIdFor(committed.workspaceId, goal.id, sourceEventId),
      );
      goalInstanceIds.push(goal.id);
      sourceEventIds.push(sourceEventId);
    }
  }
  const inserted = await client.query(
    `INSERT INTO goal_assessment_jobs (
       workspace_id, world_id, worldline_id, record_id,
       id, goal_instance_id, source_event_id, input
     )
     SELECT $1, $2, $3, $4,
            batch.job_id, batch.goal_instance_id, batch.source_event_id,
            '{}'::jsonb
     FROM unnest(
       $5::text[], $6::text[], $7::text[]
     ) AS batch(job_id, goal_instance_id, source_event_id)
     ON CONFLICT (workspace_id, goal_instance_id, source_event_id)
     DO UPDATE SET id = EXCLUDED.id
     WHERE goal_assessment_jobs.id = EXCLUDED.id
     RETURNING id`,
    [
      committed.workspaceId,
      committed.worldId,
      committed.worldlineId,
      committed.recordId,
      jobIds,
      goalInstanceIds,
      sourceEventIds,
    ],
  );
  if ((inserted.rowCount ?? 0) !== jobIds.length) {
    throw new GoalRuntimeRepositoryError(
      "GOAL_JOB_IDENTITY_CONFLICT",
      "A Goal assessment job identity conflicts with the deterministic source mapping.",
    );
  }
  return inserted.rowCount ?? 0;
}

/**
 * @deprecated Use reconcileGoalAssessmentJobsForCommittedEvents. The old name
 * remains as a source-compatible alias for existing Record commit hooks.
 */
export async function enqueueGoalAssessmentJobsForCommittedEvents(
  client: PoolClient,
  committed: GoalCommittedEventScope,
): Promise<number> {
  return reconcileGoalAssessmentJobsForCommittedEvents(client, committed);
}
