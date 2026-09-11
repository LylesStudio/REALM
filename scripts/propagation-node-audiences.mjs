import {
  createLocalPostgresPool,
  withWorkspaceTransaction,
} from "../database/postgres/public.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";
import {
  createPostgresPropagationNodeAudienceGovernance,
  PropagationNodeAudienceError,
} from "../database/postgres/propagation-node-audiences.ts";

/**
 * 批次 T11-H + v37 H.3：propagation node→continuity 治理映射维护脚本。
 *
 * v37 起 add 不再直写表：经 0043 capability function
 * `append_propagation_node_audience`（函数内 worlds FOR KEY SHARE + active
 * 断言 + owner 校验为最终闸门；0042 中间态 fail-closed），调用事务内先行
 * `pg_advisory_xact_lock(7200043)` admission（C4，governance 模块内建）。
 * CLI 自有池静态 application_name='realm-cli'（非 worker）。
 *
 * 用法：
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     scripts/propagation-node-audiences.mjs list --world <worldId>
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     scripts/propagation-node-audiences.mjs add --world <worldId> \
 *       --node <nodeKey> --continuity <continuityId> --principal <principalId>
 *
 * 只支持 list/add；mapping 是 append-only 治理事实，不提供 delete/update。
 * 输出为稳定 JSON，不含连接串/凭据。--principal 必填（CLI 不从 argv 接受
 * 任意身份而无函数内 owner 重验——函数内校验是最终闸门）。
 */

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (entry.startsWith("--")) {
      args[entry.slice(2)] = argv[index + 1];
      index += 1;
    } else {
      args._.push(entry);
    }
  }
  return args;
}

function fail(code, message, details = {}) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, ...details } })}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
const worldId = typeof args.world === "string" ? args.world.trim() : "";

if (!command || !["list", "add"].includes(command) || !worldId) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: {
      code: "USAGE",
      message: "usage: propagation-node-audiences.mjs <list|add> --world <id> [--node <key> --continuity <id> --principal <id>]",
    },
  })}\n`);
  process.exit(2);
}

const connectionString = process.env.REALM_RUNTIME_DATABASE_URL;
if (!connectionString) {
  fail("NO_RUNTIME_DATABASE_URL", "REALM_RUNTIME_DATABASE_URL is required.");
}

// CLI 自有池：静态 application_name='realm-cli'（v37 C3）。
const pool = createLocalPostgresPool(connectionString, {
  max: 2,
  application_name: "realm-cli",
});

try {
  // 本机单 workspace 部署：world 解析在本地 workspace 内进行（RLS 需要
  // 事务内 GUC——realm_runtime 无跨 workspace 旁路）。
  const workspaceId = LOCAL_RECORD_SCOPE.workspaceId;
  const worldlineId = await withWorkspaceTransaction(
    pool,
    workspaceId,
    async (client) => {
      const world = await client.query(
        `SELECT id FROM worlds
         WHERE workspace_id = $1 AND id = $2 ORDER BY created_at ASC, id ASC LIMIT 1`,
        [workspaceId, worldId],
      );
      if (!world.rows[0]) {
        fail("WORLD_NOT_FOUND", "unknown world", { world: worldId });
      }
      const worldline = await client.query(
        `SELECT id FROM worldlines
         WHERE workspace_id = $1 AND world_id = $2
         ORDER BY created_at ASC, id ASC LIMIT 1`,
        [workspaceId, worldId],
      );
      if (!worldline.rows[0]) {
        fail("WORLDLINE_NOT_FOUND", "world has no worldline", { world: worldId });
      }
      return worldline.rows[0].id;
    },
  );
  const scope = { workspaceId, worldId, worldlineId };

  if (command === "list") {
    const [nodes, routes, continuities, mappings] = await withWorkspaceTransaction(
      pool,
      workspaceId,
      async (client) => Promise.all([
        client.query(
          `SELECT node_key, clearance, active FROM propagation_nodes
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY node_key`,
          [workspaceId, worldId, worldlineId],
        ),
        client.query(
          `SELECT from_node, to_node, channel, recipient FROM propagation_routes
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY id`,
          [workspaceId, worldId, worldlineId],
        ),
        client.query(
          `SELECT id, status FROM character_continuities
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
             AND status = 'active'
           ORDER BY id`,
          [workspaceId, worldId, worldlineId],
        ),
        client.query(
          `SELECT node_key, continuity_id FROM propagation_node_audiences
           WHERE workspace_id = $1 AND world_id = $2 AND worldline_id = $3
           ORDER BY node_key, continuity_id`,
          [workspaceId, worldId, worldlineId],
        ),
      ]),
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      world: worldId,
      worldline: worldlineId,
      nodes: nodes.rows,
      routes: routes.rows,
      continuities: continuities.rows,
      mappings: mappings.rows,
    })}\n`);
  } else {
    const nodeKey = typeof args.node === "string" ? args.node.trim() : "";
    const continuityId = typeof args.continuity === "string" ? args.continuity.trim() : "";
    const principalId = typeof args.principal === "string" ? args.principal.trim() : "";
    if (!nodeKey || !continuityId || !principalId) {
      fail("USAGE", "add requires --node, --continuity and --principal");
    }
    try {
      const added = await createPostgresPropagationNodeAudienceGovernance(pool)
        .append(scope, principalId, { nodeKey, continuityId });
      process.stdout.write(`${JSON.stringify({
        ok: true,
        world: worldId,
        worldline: worldlineId,
        node: nodeKey,
        continuity: continuityId,
        added,
      })}\n`);
    } catch (error) {
      if (error instanceof PropagationNodeAudienceError) {
        fail(error.code, error.message, { world: worldId, node: nodeKey, continuity: continuityId });
      }
      throw error;
    }
  }
} finally {
  await pool.end();
}
