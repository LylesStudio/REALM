import { createLocalPostgresPool, seedPostgresDemo, seedPostgresDemoPropagationTopology } from "../database/postgres/public.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.local.");
}

const pool = createLocalPostgresPool(connectionString, { max: 1 });

try {
  const role = await pool.query(`
    SELECT
      current_user,
      has_table_privilege(current_user, 'workspaces', 'INSERT') AS can_bootstrap
  `);
  if (role.rows[0]?.can_bootstrap !== true) {
    throw new Error(
      "Demo bootstrap requires the one-shot local migration owner; realm_runtime is intentionally read/write-limited.",
    );
  }

  const seeded = await seedPostgresDemo(pool);
  // 批次 T11-B：demo 世界传播拓扑种子（幂等；迁移 0025 的表）。
  await seedPostgresDemoPropagationTopology(pool);
  console.log(
    `verified local demo ${seeded.workspaceId}/${seeded.recordId} for ${seeded.principalId}`,
  );
} finally {
  await pool.end();
}
