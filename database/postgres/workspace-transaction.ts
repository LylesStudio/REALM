import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";

export type WorkspaceDatabase = Pool | PoolClient;

export interface WorkspaceTransactionOptions {
  readOnly?: boolean;
}

function isPoolClient(database: WorkspaceDatabase): database is PoolClient {
  return "release" in database && typeof database.release === "function";
}

/**
 * Runs work under one transaction-local PostgreSQL workspace scope.
 *
 * A provided PoolClient is wrapped in a savepoint so callers can compose this
 * helper inside an existing transaction without committing or rolling it back.
 */
export async function withWorkspaceTransaction<T>(
  database: WorkspaceDatabase,
  workspaceId: string,
  work: (client: PoolClient) => Promise<T>,
  options: WorkspaceTransactionOptions = {},
): Promise<T> {
  const normalizedWorkspaceId = workspaceId.trim();
  if (!normalizedWorkspaceId) {
    throw new Error("A server-side workspace scope is required.");
  }

  const ownsClient = !isPoolClient(database);
  const client = ownsClient ? await database.connect() : database;
  const savepoint = "realm_workspace_scope";
  let previousWorkspaceId: string | null = null;

  try {
    if (ownsClient) {
      await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    } else {
      await client.query(`SAVEPOINT ${savepoint}`);
      const previousScope = await client.query<{ workspace_id: string | null }>(
        `SELECT current_setting('realm.workspace_id', true) AS workspace_id`,
      );
      previousWorkspaceId = previousScope.rows[0]?.workspace_id ?? null;
    }
    await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [
      normalizedWorkspaceId,
    ]);
    const result = await work(client);
    if (ownsClient) {
      await client.query("COMMIT");
    } else {
      await client.query(`SELECT set_config('realm.workspace_id', $1, true)`, [
        previousWorkspaceId ?? "",
      ]);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    }
    return result;
  } catch (error) {
    try {
      if (ownsClient) {
        await client.query("ROLLBACK");
      } else {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      }
    } catch {
      // Preserve the original repository error; the pool discards broken clients.
    }
    throw error;
  } finally {
    if (ownsClient) client.release();
  }
}

/** Creates a local-only Pool unless tests inject their own Pool/PoolClient. */
export function createLocalPostgresPool(
  connectionString = process.env.DATABASE_URL,
  overrides: PoolConfig = {},
): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required for the local PostgreSQL adapter.");
  }
  const url = new URL(connectionString);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error("The PostgreSQL adapter is restricted to a loopback host.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }
  if ([...url.searchParams].length > 0) {
    throw new Error("DATABASE_URL query parameters are not allowed.");
  }

  const port = url.port ? Number(url.port) : 5432;
  const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !databaseName) {
    throw new Error("DATABASE_URL must include a valid local port and database name.");
  }

  // Test-only tuning may adjust pool behavior, but it must never replace the
  // endpoint whose locality was validated above.
  const poolTuning: PoolConfig = { ...overrides };
  for (const key of [
    "connectionString",
    "host",
    "port",
    "database",
    "user",
    "password",
    "ssl",
  ] as const) {
    delete poolTuning[key];
  }

  return new pg.Pool({
    ...poolTuning,
    host,
    port,
    database: databaseName,
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    ssl: false,
    max: poolTuning.max ?? 8,
    idleTimeoutMillis: poolTuning.idleTimeoutMillis ?? 10_000,
    allowExitOnIdle: poolTuning.allowExitOnIdle ?? true,
  });
}
