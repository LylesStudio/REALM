import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ProjectScope } from "../../modules/projects/public.ts";
import { ProjectFinanceCommandError, type RecordEvidence } from "../../modules/application/project-finance-command.ts";
import { CommandPolicyError, normalizeCommandMaterializations, validateCommandMaterializations,
  type CommandMaterializations, type CommandPolicyResolver, type ResolvedCommandPolicy, type RequestPolicy,
} from "../../modules/world-transfer/realmworld-command-policy.ts";

/** Catalog capability only. It grants no policy authority and never masks query errors. */
export async function hasCommandMaterializationsSchema(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ command_materializations_available: boolean }>(
    `SELECT to_regclass('public.realmworld_command_materializations') IS NOT NULL AS command_materializations_available`, []);
  if (result.rows.length !== 1 || typeof result.rows[0]?.command_materializations_available !== "boolean") throw new CommandPolicyError();
  return result.rows[0].command_materializations_available;
}
export async function readCommandMaterializations(client: PoolClient, scope: ProjectScope): Promise<CommandMaterializations | undefined> {
  if (!await hasCommandMaterializationsSchema(client)) return undefined;
  const result = await client.query<{
    schema_version: number; world_version: string; content_hash: string; policy_version: string;
    project_key: string; milestone_key: string; project_id: string; milestone_id: string; story_id: string; record_id: string; link_kind: string;
  }>(`SELECT schema_version, world_version, content_hash, policy_version, project_key, milestone_key,
       project_id, milestone_id, story_id, record_id, link_kind
     FROM realmworld_command_materializations
     WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
     ORDER BY project_key, milestone_key LIMIT 257`, [scope.workspaceId, scope.worldId, scope.worldlineId]);
  if (!result.rows.length) return undefined;
  const first = result.rows[0]!;
  if (result.rows.some(r => r.schema_version !== 1 || r.link_kind !== "primary" || r.world_version !== first.world_version
    || r.content_hash !== first.content_hash || r.policy_version !== first.policy_version)) throw new CommandPolicyError();
  return normalizeCommandMaterializations({ format: "realmworld-command-materializations", schemaVersion: 1,
    worldVersion: first.world_version, contentHash: first.content_hash, policyVersion: first.policy_version,
    rows: result.rows.map(r => ({ projectKey: r.project_key, milestoneKey: r.milestone_key, projectId: r.project_id,
      milestoneId: r.milestone_id, storyId: r.story_id, recordId: r.record_id })) });
}
export async function insertCommandMaterializations(client: PoolClient, scope: ProjectScope, map: CommandMaterializations): Promise<void> {
  for (const r of map.rows) await client.query(`INSERT INTO realmworld_command_materializations (
    workspace_id, world_id, worldline_id, schema_version, world_version, content_hash, policy_version,
    project_key, milestone_key, project_id, milestone_id, story_id, record_id, link_kind
  ) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11,$12,'primary')`,
  [scope.workspaceId, scope.worldId, scope.worldlineId, map.worldVersion, map.contentHash, map.policyVersion,
    r.projectKey, r.milestoneKey, r.projectId, r.milestoneId, r.storyId, r.recordId]);
}
export function commandMaterializationPlan(scope: ProjectScope, policy: ResolvedCommandPolicy, storyId: string, recordId: string): CommandMaterializations {
  const id = (domain: string, prefix: string, ...parts: string[]) => prefix + createHash("sha256")
    .update(JSON.stringify([domain, scope.workspaceId, scope.worldId, scope.worldlineId, policy.contentHash, ...parts]), "utf8").digest("hex");
  return normalizeCommandMaterializations({ format: "realmworld-command-materializations", schemaVersion: 1,
    worldVersion: policy.worldVersion, contentHash: policy.contentHash, policyVersion: policy.policyVersion,
    rows: policy.document.projects.flatMap(p => p.milestones.map(m => ({ projectKey: p.projectKey, milestoneKey: m.milestoneKey,
      projectId: id("realmworld-project:v1", "project_realm_", p.projectKey),
      milestoneId: id("realmworld-milestone:v1", "milestone_realm_", p.projectKey, m.milestoneKey), storyId, recordId }))) });
}
function localized(text: Record<string, string>, locale: string) { return text[locale] ?? text[locale.split("-")[0]!] ?? text.en ?? text[Object.keys(text).sort()[0]!]!; }
export async function materializeCommandPolicy(client: PoolClient, scope: ProjectScope, policy: ResolvedCommandPolicy, storyId: string, recordId: string, locale: string): Promise<void> {
  const map = commandMaterializationPlan(scope, policy, storyId, recordId);
  for (const p of policy.document.projects) {
    const projectId = map.rows.find(r => r.projectKey === p.projectKey)!.projectId;
    await client.query(`INSERT INTO projects (workspace_id, world_id, worldline_id, id, kind, status, stage, title, currency, deadline, owner_id, version)
      VALUES ($1,$2,$3,$4,$5,'planned','planning',$6,'JPY',NULL,NULL,1)`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, projectId, p.kind, localized(p.title, locale)]);
    const linkId = "project_story_link_realm_" + createHash("sha256").update(JSON.stringify([
      "realmworld-project-story-link:v1", scope.workspaceId, scope.worldId, scope.worldlineId, policy.contentHash, p.projectKey, storyId,
    ]), "utf8").digest("hex");
    await client.query(`INSERT INTO project_story_links (workspace_id, world_id, worldline_id, id, project_id, story_id, link_kind)
      VALUES ($1,$2,$3,$4,$5,$6,'primary')`, [scope.workspaceId, scope.worldId, scope.worldlineId, linkId, projectId, storyId]);
    for (const [index, m] of p.milestones.entries()) await client.query(`INSERT INTO project_milestones (
      workspace_id, world_id, worldline_id, id, project_id, sequence, title, status, due_on, completion_record_id, completion_event_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'planned',NULL,NULL,NULL)`,
    [scope.workspaceId, scope.worldId, scope.worldlineId, map.rows.find(r => r.projectKey === p.projectKey && r.milestoneKey === m.milestoneKey)!.milestoneId,
      projectId, index + 1, localized(m.title, locale)]);
  }
  await insertCommandMaterializations(client, scope, map);
}
export async function verifyInstalledCommandPolicy(client: PoolClient, scope: ProjectScope, policy: ResolvedCommandPolicy, storyId: string, recordId: string): Promise<void> {
  const existing = await readCommandMaterializations(client, scope);
  // Legacy instances are replayable but are never backfilled or granted new admission.
  if (!existing) return;
  validateCommandMaterializations(existing, policy);
  const expected = commandMaterializationPlan(scope, policy, storyId, recordId);
  const sorted = (map: CommandMaterializations) => map.rows.map(r => JSON.stringify(r)).sort();
  if (JSON.stringify(sorted(existing)) !== JSON.stringify(sorted(expected))) throw new CommandPolicyError();
}
export async function admitSemanticMilestone(client: PoolClient, input: {
  scope: ProjectScope; projectId: string; milestoneId: string; semanticEventKey: string; evidence?: RecordEvidence | null;
}, resolver?: CommandPolicyResolver): Promise<RequestPolicy> {
  const { scope, evidence } = input;
  let map: CommandMaterializations, policy: ResolvedCommandPolicy;
  try {
    const loaded = await readCommandMaterializations(client, scope); if (!loaded || !resolver) throw new CommandPolicyError(); map = loaded;
    const resolved = await resolver({ worldId: scope.worldId, worldVersion: map.worldVersion });
    if (!resolved || resolved.worldId !== scope.worldId) throw new CommandPolicyError(); policy = resolved;
    validateCommandMaterializations(map, policy);
  } catch { throw new ProjectFinanceCommandError("BUSINESS_POLICY_MISSING", "A verified command policy is unavailable."); }
  const row = map.rows.find(r => r.projectId === input.projectId && r.milestoneId === input.milestoneId);
  const binding = row && policy.document.bindings.find(b => b.projectKey === row.projectKey && b.milestoneKey === row.milestoneKey && b.semanticEventKey === input.semanticEventKey);
  if (!row || !binding) throw new ProjectFinanceCommandError("BUSINESS_POLICY_MISSING", "A command binding is unavailable.");
  if (!evidence || evidence.visibility !== "public" || evidence.recordId !== row.recordId) throw new ProjectFinanceCommandError("COMMAND_INVALID", "Public bound Record evidence is required.");
  const args = [scope.workspaceId, scope.worldId, scope.worldlineId];
  const qualified = await client.query<{ world_version: string }>(
    "SELECT world_version FROM public.command_policy_record_version_locked($1, $2, $3, $4, $5, $6)",
    [...args, row.recordId, row.storyId, row.projectId]);
  if (!qualified.rows[0]) throw new ProjectFinanceCommandError("COMMAND_INVALID", "Record evidence is not bound to this project.");
  if (qualified.rows[0].world_version !== map.worldVersion) throw new ProjectFinanceCommandError("BUSINESS_POLICY_MISSING", "The Record policy version is unavailable.");
  const prerequisiteRows = binding.all.map(a => map.rows.find(r => r.projectKey === row.projectKey && r.milestoneKey === a.milestoneKey)!);
  const locked = await client.query<{ id: string; status: string; completion_record_id: string | null; completion_event_id: string | null }>(`SELECT id, status, completion_record_id, completion_event_id FROM project_milestones
    WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3 AND project_id = $4 AND id = ANY($5::text[])
    ORDER BY id FOR UPDATE`, [...args, row.projectId, [...new Set([row.milestoneId, ...prerequisiteRows.map(r => r.milestoneId)])].sort()]);
  for (const prior of prerequisiteRows) {
    const m = locked.rows.find(m => m.id === prior.milestoneId);
    if (!m || m.status !== "completed" || m.completion_record_id !== row.recordId || !m.completion_event_id) throw new ProjectFinanceCommandError("BUSINESS_PRECONDITION_FAILED", "A business prerequisite is not satisfied.");
    const support = await client.query(`SELECT e.id FROM events AS e
      JOIN visibility_policies AS v ON v.workspace_id = e.workspace_id AND v.world_id = e.world_id AND v.worldline_id = e.worldline_id AND v.record_id = e.record_id AND v.id = e.visibility_policy_id AND v.policy_kind = 'public'
      WHERE e.workspace_id = $1 AND e.world_id = $2 AND e.worldline_id = $3 AND e.record_id = $4 AND e.id = $5
        AND e.event_kind = 'project.milestone.confirmed' AND e.payload->>'projectId' = $6 AND e.payload->>'milestoneId' = $7`,
    [...args, row.recordId, m.completion_event_id, row.projectId, prior.milestoneId]);
    if (support.rowCount !== 1) throw new ProjectFinanceCommandError("BUSINESS_PRECONDITION_FAILED", "A business prerequisite is not satisfied.");
  }
  return { schemaVersion: 1, contentHash: map.contentHash, policyVersion: map.policyVersion, bindingKey: binding.bindingKey };
}
