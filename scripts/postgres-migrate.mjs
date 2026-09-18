import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = resolve(projectRoot, "database/postgres/migrations");
const connectionString = process.env.DATABASE_URL;

// 0030 briefly shipped in checkpoint 8e1912f with the same state grant plus
// activity grants. Accept that one exact historical checksum so a database
// that applied the checkpoint can continue to the immutable follow-up
// migrations; every other historical edit still fails closed.
const LEGACY_MIGRATION_CHECKSUMS = new Map([
  [
    "0030_character_instance_state.sql",
    {
      accepted: new Set(["a36800b96089a0742f47f1415fd2f202607d6e260f3f65ee11e5d9f0bc780837"]),
      current: "1d8cbb9a63de8f1570c20430604a02f45efb5b560a28e1f2e5784a2a9d5ec56c",
    },
  ],
  [
    "0035_keen_insight_concrete_discovery.sql",
    {
      accepted: new Set(["8a79ecf62f7a4b70e6bc65e46a245f119399b2b1e379b533309d120f400ebebc"]),
      current: "89e694af2c732a27f3e31c7aafcebc8efc4586094c686a6cc0e4576c4deba361",
    },
  ],
]);

if (!connectionString) {
  throw new Error("DATABASE_URL is required. Copy .env.example to .env.local.");
}

const databaseUrl = new URL(connectionString);
const hostname = databaseUrl.hostname.replace(/^\[|\]$/g, "");
if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
  throw new Error("M1 migrations are restricted to a local PostgreSQL host.");
}
if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
  throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
}
if ([...databaseUrl.searchParams].length > 0) {
  throw new Error(
    "DATABASE_URL query parameters are disabled so the local host cannot be overridden.",
  );
}
const database = decodeURIComponent(databaseUrl.pathname.replace(/^\//, ""));
if (!database || database.includes("/")) {
  throw new Error("DATABASE_URL must name exactly one local database.");
}
const port = databaseUrl.port ? Number(databaseUrl.port) : 5432;
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("DATABASE_URL contains an invalid PostgreSQL port.");
}

const client = new pg.Client({
  host: hostname,
  port,
  database,
  user: databaseUrl.username
    ? decodeURIComponent(databaseUrl.username)
    : undefined,
  password: databaseUrl.password
    ? decodeURIComponent(databaseUrl.password)
    : undefined,
  ssl: false,
});
await client.connect();

try {
  const endpoint = await client.query(`
    SELECT
      inet_server_addr()::text AS server_address,
      inet_server_port() AS server_port,
      current_database() AS database_name,
      current_setting('listen_addresses') AS listen_addresses
  `);
  const connected = endpoint.rows[0];
  const dockerLocal = process.env.REALM_POSTGRES_MODE === "docker";
  const serverAddress = connected.server_address?.replace(/\/\d+$/, "");
  if (!dockerLocal && !["127.0.0.1", "::1"].includes(serverAddress)) {
    throw new Error("Refusing to migrate a PostgreSQL server outside loopback.");
  }
  if (dockerLocal && !["*", "0.0.0.0", "::"].includes(connected.listen_addresses)) {
    throw new Error("Docker PostgreSQL listener does not match the explicit local container mode.");
  }
  const expectedServerPort = dockerLocal ? 5432 : port;
  if (connected.server_port !== expectedServerPort || connected.database_name !== database) {
    throw new Error("Connected PostgreSQL endpoint does not match DATABASE_URL.");
  }

  await client.query(
    `SELECT pg_advisory_lock(hashtext('realm_schema_migrations'))`,
  );
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS realm_schema_migrations (
        filename text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }

  const filenames = readdirSync(migrationDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();

  // v37 C4 drain：应用 0043（capability 最终 body）时 runner 先以
  // lock_timeout=30s 持 pg_advisory_lock(7200043)——阻塞即 capability
  // 在途 → no-go；持锁期间新 admission（pg_advisory_xact_lock 同 key）阻塞，
  // 解锁后以 0043 新 catalog 继续；runner 崩溃 → session 级锁随连接释放。

  for (const filename of filenames) {
    const sql = readFileSync(resolve(migrationDirectory, filename), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
    await client.query("BEGIN");
    try {
      const existing = await client.query(
        `SELECT checksum FROM realm_schema_migrations WHERE filename = $1 FOR UPDATE`,
        [filename],
      );
      if (existing.rowCount === 1) {
        if (existing.rows[0].checksum !== checksum) {
          const legacyChecksums = LEGACY_MIGRATION_CHECKSUMS.get(filename);
          if (
            !legacyChecksums?.accepted.has(existing.rows[0].checksum)
            || legacyChecksums.current !== checksum
          ) {
            throw new Error(`Applied migration was modified: ${filename}`);
          }
          console.warn(`accept legacy checksum for ${filename}; current SQL is immutable`);
        }
        await client.query("COMMIT");
        console.log(`skip  ${filename}`);
        continue;
      }

      // v37 C4：0043 应用前 drain 锁（同事务外不可取——session 级锁）。
      if (filename.startsWith("0043_")) {
        await client.query("COMMIT"); // 先释放 per-file 事务，取 session 锁
        await client.query("SET lock_timeout = '30s'");
        let drainHeld = false;
        try {
          await client.query("SELECT pg_advisory_lock(7200043)");
          drainHeld = true;
          console.log("drain lock 7200043 acquired for 0043");
        } catch (error) {
          throw new Error(
            `capability drain failed (in-flight admission holds 7200043): ${String(error)}`,
          );
        } finally {
          await client.query("SET lock_timeout = DEFAULT");
        }
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(
            `INSERT INTO realm_schema_migrations (filename, checksum) VALUES ($1, $2)`,
            [filename, checksum],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          if (drainHeld) {
            await client.query("SELECT pg_advisory_unlock(7200043)");
          }
        }
        console.log(`apply ${filename}`);
        continue;
      }
      await client.query(sql);
      await client.query(
        `INSERT INTO realm_schema_migrations (filename, checksum) VALUES ($1, $2)`,
        [filename, checksum],
      );
      await client.query("COMMIT");
      console.log(`apply ${filename}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const verification = await client.query(`
    SELECT
      current_database() AS database_name,
      current_setting('listen_addresses') AS listen_addresses,
      current_setting('port') AS port,
      (SELECT extversion FROM pg_extension WHERE extname = 'vector') AS vector_version,
      (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public') AS table_count
  `);
  const state = verification.rows[0];
  if (!dockerLocal && !["127.0.0.1", "localhost", "::1"].includes(state.listen_addresses)) {
    throw new Error("PostgreSQL is not restricted to a loopback listener.");
  }
  if (dockerLocal && !["*", "0.0.0.0", "::"].includes(state.listen_addresses)) {
    throw new Error("Docker PostgreSQL listener is not the explicit local container listener.");
  }
  console.log(
    `verified ${state.database_name} on ${state.listen_addresses}:${state.port}; pgvector ${state.vector_version}; ${state.table_count} tables`,
  );
} finally {
  try {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext('realm_schema_migrations'))`,
    );
  } catch {
    // Connection teardown releases the session-level lock as a final fence.
  }
  await client.end();
}
