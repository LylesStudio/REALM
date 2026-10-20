import pg, { type Pool, type PoolClient, type PoolConfig } from "pg";

export type WorkspaceDatabase = Pool | PoolClient;

export interface WorkspaceTransactionOptions {
  readOnly?: boolean;
  /** Required snapshot mode; caller-owned transactions are checked, never upgraded. */
  isolationLevel?: "repeatable read" | "serializable";
}

/** Serialize one accepted command identity before re-reading its receipt.
 * READ COMMITTED gives the post-lock SELECT a fresh snapshot. A caller-owned
 * snapshot transaction cannot safely turn a pre-lock miss into a new commit.
 */
export async function lockWorkspaceCommandKey(
  client: PoolClient,
  family: "fact" | "finance",
  scope: { workspaceId: string; worldId: string; worldlineId: string },
  idempotencyKey: string,
): Promise<void> {
  const mode = await client.query<{ isolation_level: string }>(
    `SELECT current_setting('transaction_isolation') AS isolation_level`,
  );
  if (mode.rows[0]?.isolation_level !== "read committed") {
    throw new Error("Command receipt serialization requires a READ COMMITTED transaction.");
  }
  const identity = JSON.stringify(["realm-command-key:v1", family,
    scope.workspaceId, scope.worldId, scope.worldlineId, idempotencyKey]);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [identity]);
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
  const isolationLevel = options.isolationLevel;
  if (isolationLevel !== undefined && isolationLevel !== "repeatable read" && isolationLevel !== "serializable") {
    throw new Error("The requested workspace snapshot isolation is not supported.");
  }

  const ownsClient = !isPoolClient(database);
  const client = ownsClient ? await database.connect() : database;
  const savepoint = "realm_workspace_scope";
  let createdSavepoint = false;
  let previousWorkspaceId: string | null = null;

  try {
    if (ownsClient) {
      const isolation = isolationLevel === "repeatable read" ? " ISOLATION LEVEL REPEATABLE READ"
        : isolationLevel === "serializable" ? " ISOLATION LEVEL SERIALIZABLE" : "";
      await client.query(`BEGIN${isolation}${options.readOnly === true ? " READ ONLY" : ""}`);
    } else {
      await client.query(`SAVEPOINT ${savepoint}`);
      createdSavepoint = true;
      if (isolationLevel !== undefined || options.readOnly !== undefined) {
        const mode = await client.query<{ isolation_level: string; read_only: string }>(
          `SELECT current_setting('transaction_isolation') AS isolation_level,
                  current_setting('transaction_read_only') AS read_only`,
        );
        const outer = mode.rows[0];
        if (isolationLevel !== undefined && outer?.isolation_level !== "serializable"
          && !(isolationLevel === "repeatable read" && outer?.isolation_level === "repeatable read")) {
          throw new Error("The provided transaction cannot supply the requested snapshot isolation.");
        }
        if (isolationLevel !== undefined && options.readOnly !== undefined
          && outer?.read_only !== (options.readOnly ? "on" : "off")) {
          throw new Error("The provided transaction cannot supply the requested read/write mode.");
        }
      }
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
      } else if (createdSavepoint) {
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
