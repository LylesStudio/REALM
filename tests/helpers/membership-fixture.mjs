/**
 * GUI 成员资格 fixture（仅测试）：把当前会话 principal 在 demo 世界的
 * membership 提升为 owner。用于验收 owner 操作面（如 T11-I 受众映射治理）——
 * T10 后登录默认只给 player 席位，owner 旅程必须由 fixture 显式建立。
 * 双护栏：REALM_GUI_SCRATCH=1 + loopback admin 连接；绝不触共享库。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pg = require("pg");

export async function promoteDemoMembershipToOwner(adminConnectionString, principalId) {
  if (process.env.REALM_GUI_SCRATCH !== "1") {
    throw new Error("membership fixtures require the isolated GUI scratch runner.");
  }
  const url = new URL(adminConnectionString ?? "");
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("membership fixtures require a loopback scratch PostgreSQL.");
  }
  if (typeof principalId !== "string" || !principalId.startsWith("principal_")) {
    throw new Error("principalId must be a session-derived principal id.");
  }
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    const result = await client.query(
      `UPDATE player_world_memberships SET role = 'owner'
       WHERE workspace_id = 'ws_demo' AND world_id = 'world_ember_coast'
         AND principal_id = $1 AND role <> 'owner'`,
      [principalId],
    );
    if ((result.rowCount ?? 0) > 1) {
      throw new Error("membership fixture must touch at most one row");
    }
    return true;
  } finally {
    await client.end();
  }
}
