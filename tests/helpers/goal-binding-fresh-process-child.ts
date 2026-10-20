/** AUTHORED / NOT_RUN. Read-only discovery in an independent scratch process. */
import assert from "node:assert/strict";
import pg from "pg";
import { withWorkspaceTransaction } from "../../database/postgres/workspace-transaction.ts";
import { loadGoalContentBinding } from "../../database/postgres/goal-content-binding-repository.ts";
import { createGoalContentBindingSource, verifyGoalContentBinding } from "../../modules/application/goal-content-binding-source.ts";
if(!process.env.REALM_SCRATCH_POSTGRES_CONTAINER || !process.env.REALM_RUNTIME_DATABASE_URL) throw new Error("scratch runner required");
const scope=JSON.parse(process.env.REALM_GOAL_DISCOVERY_SCOPE ?? "null") as {workspaceId:string;worldId:string;worldlineId:string};
assert.ok(scope?.workspaceId && scope.worldId && scope.worldlineId);
const pool=new pg.Pool({connectionString:process.env.REALM_RUNTIME_DATABASE_URL,max:1});
try {
  const found=await withWorkspaceTransaction(pool,scope.workspaceId,async client=>{
    const rows=await client.query<{id:string;scope_kind:string}>(`SELECT id,scope_kind FROM goal_instances
      WHERE workspace_id=$1 AND world_id=$2 AND worldline_id=$3 ORDER BY scope_kind,id`,[scope.workspaceId,scope.worldId,scope.worldlineId]);
    for(const row of rows.rows) await verifyGoalContentBinding(await loadGoalContentBinding(client,scope.workspaceId,row.id),createGoalContentBindingSource());
    return rows.rows;
  },{readOnly:true,isolationLevel:"repeatable read"});
  process.stdout.write(JSON.stringify({count:found.length,kinds:found.map(r=>r.scope_kind).sort()})+"\n");
} finally {await pool.end();}
