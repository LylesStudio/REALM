import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const migrationDirectory = resolve(projectRoot, "database/postgres/migrations");
const connectionString = process.env.DATABASE_URL;

// Migration checksums are canonicalized to LF so source checkout line endings
// do not alter the ledger. The historical map below is only for exact known
// semantic checkpoints; selected entries may request an idempotent reconciliation
// before their ledger receipt is converged. Every other content edit fails closed.
const LEGACY_MIGRATION_CHECKSUMS = new Map([
  [
    "0014_scene_crystallization_grants.sql",
    {
      // Historical variant observed in an existing Windows database.
      accepted: new Set([
        "d339e9d58db0e118a5361fa4c401367c7a5a4c95f349e95372962fdc5e754d46",
        "62cc7aadf1b5f8aa17cab96977436abfd9857421116bd3050c89d2341cd099e4",
      ]),
      current: "d2ad52bb658f00767c30cbada27a85eb9b407685998288967001c399f810e9c9",
      reapply: true,
    },
  ],
  [
    "0015_account_ui_language.sql",
    {
      // Historical variant observed in an existing Windows database.
      accepted: new Set([
        "68d3786e29566d8bc3810ae498f9c31a81039808e1335823f1fdd7836c70e603",
        "a3f333e932ae7a69bf3dfa9ec9734b9892ad058eda876d40995bb7a5fdb13409",
      ]),
      current: "6fb3380d464d033ab64e71cb180b6482951dacb5dab7729d942e63aaee0a2b14",
      reapply: true,
    },
  ],
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

// The pre-release public snapshot 53e9f5a0b0eafca24659bf877f27c205912250ab
// changed only documentation references in these already-applied migrations.
// The stored values below are the exact LF/CRLF checksums observed in that
// snapshot. Keep this allowlist exact: a later SQL edit must still fail closed.
const LEGACY_PUBLIC_SNAPSHOT_COMMENT_CHECKSUMS = [
  [
    "0016_world_files.sql",
    "4d8bdd10b5f965fcd9d18fe263110a78edaf91d39a00f04f37af0a5ed8b07cf3",
    "be40c8821a57658377132407a7625e9b923b504c269076c1df314f7c9d83df41",
    "a0140a3ba2d4572f5bf13488f60d3a30a58d3c33fd59775cd5b497eff3a25b15",
  ],
  [
    "0017_account_last_opened.sql",
    "7d27d5410811590e8bc8883d678c0a4608a5d0519c141f347229b8dce76d6cb1",
    "f4411501cd31d9bd6e0eeffe30d23a5d81c01e352e05f365b113fcba15516233",
    "d76dd5b22fe9f495023cf4837e49a1502d7cef8a11a6ae62bd40b5fb6bdc03e0",
  ],
  [
    "0019_record_first_nights.sql",
    "339a0a87acdb44181de00c3b0afe8221adb83e8d9bc7688bdb20efad6f0552ef",
    "b5269f93fabce262ab25ba4f90cacd28a76643bf420068c30f065c8cc3ee0742",
    "5625e4a1cac9f8d2d75d25f910a6f42df68a70d7afa7af94dba8bf1b55d64850",
  ],
  [
    "0020_record_self_play_sessions.sql",
    "6442d0a079d6a8c563946991006494d5d4a9ff2056436231813274de8c741e98",
    "2f5dc0caeb16a9e414fd991b3b7e6ec26dbd79ad7942afcaf8ab067988cf93a3",
    "fb9aa4869828bb34592f6292f009e8ae10516e43eede2bf542c00c2a8f47c9cf",
  ],
  [
    "0021_world_admin.sql",
    "983169670dc587bb8eb20c722f43101b46bdbe671c67db70295803f1777776e5",
    "f649ee8195fc2308f8156d149dda60b71af0af568a22a3721276e28047f410dc",
    "f9f0264ab371c8e6b3e9afbb3cd37c42fc60157ba0b21c55a66cc2bf9a0167b2",
  ],
  [
    "0022_worldline_merge_grants.sql",
    "de36c3a3fe3c97b2df4ac98e1980827ea13719307d54a7c4e4f30b6c2f943b01",
    "60d237169f34a796aedad9004a08ec9ecb9fed9b17f300211bef507cd9297d9f",
    "48d615982c0bc2e08330e4910bc268d5040e5478eaf705bd4a676cbead3d81b0",
  ],
  [
    "0023_library_runtime_grants.sql",
    "ea905c5b54589cddd6da4b615697af94bfbfbcc49db4c511bc4a080bd639dab5",
    "871f4d45f39fb87569ec2a9129d5beb88e13c54af0fb946a45a116888354cc2a",
    "687326bdf27712acc2ccbbce4d9a39d40311a3601a476596b0ac1d7b63da28b4",
  ],
  [
    "0024_graph_invalidation_events.sql",
    "ff2f6a9a81e7b14dbee372cfbaa724211eac74f3cf0ca5c2145ed2189afd49a3",
    "3c25e8ce130ee20c8f8f23364752be9dcb4a041c03a69044dda58c8097139cbb",
    "60e47643812ff8f161de37edd01887eb8fc14f850a09e263f27e720c97446587",
  ],
  [
    "0025_propagation_topology_semantic_scope.sql",
    "b2639e3ffb3b28ccbdfd1711590536cd91ba91dca38ba7894f5e6924121cb68d",
    "fa5c88a163ccdfc419cb23cdef11b11b169021c7190055784b75354136e05119",
    "f9f849c75ab8aabc2859b982d1828cd0366dd7cbd28375596064f46ec665ac19",
  ],
  [
    "0026_canon_security_audience.sql",
    "bd529dfb2a2c1b4e0ca9663ee7309091e5945569f0d5ea64cac1a02d5ffacb33",
    "d28fa4bf367fe7100538831f5b9b7f88853301bfdc89979808e1cfce6a94795b",
    "6efbfc3c056b7ca7306f4787c22386ca72b54e54b7324264cf80c3dd61eb35d4",
  ],
  [
    "0039_scene_weather_snapshot.sql",
    "4cf5d99bd7d066e14b7d9b3f0e37ed8713ba0c2e8c114a595646cd5edacdb0f1",
    "68277ddeed43eb85a05f3b045b694d22543f8f04bd55dbcfe220d81a2a889a2f",
    "32ce7cf2d88bdbe99afb9593b60016eaab118d6a07146a0a6cce31c411df991e",
  ],
  [
    "0040_scene_display_time_snapshot.sql",
    "2d82ca8f4e8b5dd5cd3db934151e389b1c65c9017ea9a87e6d17e36c554ddc3e",
    "c4ea868de7a7fd6f0d87100d7c84d57739e8702487c5d4ef1313bbe2d2a45c50",
    "5867a446338bad55d71cd1498d0d32559172d2833fb2a12b5f7d87c92ec7285e",
  ],
  [
    "0045_lobby_rooms.sql",
    "14955ba1817d0a78487c13c4b7aecebbf4974b1ec4eb74d820dbd3d2aa7b4c6d",
    "739bd2a3b262b66d878b34d82300c3c4ce976d44a2c52b7ded929a2f0c745adc",
    "8ca04fff1dc20a0ea74d2a46779ba27d6c0edcc247bd9b9d685c878ad5500d07",
  ],
  [
    "0046_lobby_room_world_link.sql",
    "6178fc7078cda1322de257281fff0915919fa02e3bc692781938ad7eab066ae0",
    "67d11c044e50ea29a931153c34e2645818b065c27e3c68b0e399a91dfb83f1e1",
    "6b88da88188285d4dd430c007c9332bfdad61565fd899a30a861ebbdaf171aca",
  ],
  [
    "0047_lobby_host_lease.sql",
    "019957003d45d126fd56db511a74e75569fffef88e6dc43de61b2da7d8bf1771",
    "6bc8db5d17a0cc478931bc78adfc58eabcc300a0ae92686a2330ca5753e0d5bb",
    "e107deaeb5cc75c439ea13ee6a2e9fe16d4ee01f91c42af37d1a0ff20fe3280a",
  ],
];
for (const [filename, storedChecksum, currentChecksum, historicalLfChecksum] of LEGACY_PUBLIC_SNAPSHOT_COMMENT_CHECKSUMS) {
  LEGACY_MIGRATION_CHECKSUMS.set(filename, {
    accepted: new Set([storedChecksum, historicalLfChecksum]),
    current: currentChecksum,
    convergeLedger: true,
  });
}

function readMigrationChecksums(filename) {
  const sql = readFileSync(resolve(migrationDirectory, filename), "utf8");
  const normalizedSql = sql.replace(/\r\n/g, "\n");
  const checksum = createHash("sha256").update(normalizedSql).digest("hex");
  const legacyLineEndingChecksum = createHash("sha256")
    .update(normalizedSql.replace(/\n/g, "\r\n"))
    .digest("hex");
  return { sql, checksum, legacyLineEndingChecksum };
}

function classifyAppliedChecksum(filename, storedChecksum, checksums) {
  const legacyChecksums = LEGACY_MIGRATION_CHECKSUMS.get(filename);
  const acceptedLineEnding = storedChecksum === checksums.legacyLineEndingChecksum;
  const acceptedHistorical =
    legacyChecksums?.accepted.has(storedChecksum)
    && legacyChecksums.current === checksums.checksum;
  return {
    acceptedHistorical,
    acceptedLineEnding,
    unresolved: storedChecksum !== checksums.checksum
      && !acceptedLineEnding
      && !acceptedHistorical,
  };
}

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

  const appliedRows = await client.query(
    `SELECT filename, checksum FROM realm_schema_migrations ORDER BY filename`,
  );
  const appliedByFilename = new Map(
    appliedRows.rows.map((row) => [row.filename, row.checksum]),
  );
  const unresolvedMismatches = [];
  for (const filename of filenames) {
    const storedChecksum = appliedByFilename.get(filename);
    if (!storedChecksum) {
      continue;
    }
    const checksums = readMigrationChecksums(filename);
    const classification = classifyAppliedChecksum(filename, storedChecksum, checksums);
    if (classification.unresolved) {
      unresolvedMismatches.push({
        filename,
        storedChecksum,
        currentChecksum: checksums.checksum,
        legacyLineEndingChecksum: checksums.legacyLineEndingChecksum,
      });
    }
  }
  if (unresolvedMismatches.length > 0) {
    console.error("migration checksum inventory (all unresolved mismatches):");
    for (const mismatch of unresolvedMismatches) {
      console.error(
        `  ${mismatch.filename}: stored ${mismatch.storedChecksum}, current ${mismatch.currentChecksum}, CRLF ${mismatch.legacyLineEndingChecksum}`,
      );
    }
  }

  // v37 C4 drain：应用 0043（capability 最终 body）时 runner 先以
  // lock_timeout=30s 持 pg_advisory_lock(7200043)——阻塞即 capability
  // 在途 → no-go；持锁期间新 admission（pg_advisory_xact_lock 同 key）阻塞，
  // 解锁后以 0043 新 catalog 继续；runner 崩溃 → session 级锁随连接释放。

  for (const filename of filenames) {
    const { sql, checksum, legacyLineEndingChecksum } = readMigrationChecksums(filename);
    await client.query("BEGIN");
    try {
      const existing = await client.query(
        `SELECT checksum FROM realm_schema_migrations WHERE filename = $1 FOR UPDATE`,
        [filename],
      );
      if (existing.rowCount === 1) {
        let ledgerConverged = false;
        if (existing.rows[0].checksum !== checksum) {
          const storedChecksum = existing.rows[0].checksum;
          const legacyChecksums = LEGACY_MIGRATION_CHECKSUMS.get(filename);
          const acceptedLineEnding = storedChecksum === legacyLineEndingChecksum;
          const acceptedHistorical =
            legacyChecksums?.accepted.has(storedChecksum)
            && legacyChecksums.current === checksum;
          if (!acceptedLineEnding && !acceptedHistorical) {
            throw new Error(
              `Applied migration was modified: ${filename} (stored ${storedChecksum}, current ${checksum})`,
            );
          }
          if (acceptedHistorical && legacyChecksums.reapply) {
            await client.query(sql);
            await client.query(
              `UPDATE realm_schema_migrations SET checksum = $2 WHERE filename = $1`,
              [filename, checksum],
            );
            ledgerConverged = true;
            console.warn(
              `reapply legacy migration ${filename}; ledger converged to current SQL`,
            );
          } else if (acceptedHistorical && legacyChecksums.convergeLedger) {
            await client.query(
              `UPDATE realm_schema_migrations SET checksum = $2 WHERE filename = $1`,
              [filename, checksum],
            );
            ledgerConverged = true;
            console.warn(
              `converge legacy metadata-only migration ${filename}; SQL body unchanged`,
            );
          } else {
            const compatibilityKind = acceptedLineEnding ? "line-ending" : "historical";
            console.warn(
              `accept legacy ${compatibilityKind} checksum for ${filename}; current SQL is immutable`,
            );
          }
        }
        await client.query("COMMIT");
        console.log(`${ledgerConverged ? "reconcile" : "skip"}  ${filename}`);
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
