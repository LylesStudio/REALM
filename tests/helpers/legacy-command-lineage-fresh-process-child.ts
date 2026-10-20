import pg from "pg";
import { createPostgresRealmRuntimeSaveReader } from "../../database/postgres/realm-runtime-save-repository.ts";
import { buildRealmRuntimeSaveArchive } from "../../modules/world-transfer/realm-runtime-save.ts";


const [workspaceId, recordId, principalId, ...extra] = process.argv.slice(2);
if (!workspaceId || !recordId || !principalId || extra.length || !process.env.REALM_RUNTIME_DATABASE_URL) throw new Error("Invalid save child arguments.");
const pool = new pg.Pool({ connectionString: process.env.REALM_RUNTIME_DATABASE_URL, max: 1 });
let archiveBase64: string;
try {
  const archive = await createPostgresRealmRuntimeSaveReader(pool).load({ workspaceId, recordId, principalId, purpose: "whole-closure-backup" as const });
  if (!archive) throw new Error("Record missing.");
  archiveBase64 = Buffer.from(buildRealmRuntimeSaveArchive(archive)).toString("base64");
} finally {
  await pool.end();
}
process.stdout.write(`${JSON.stringify({ mode: "save", pid: process.pid, poolsClosed: true, workspaceId, recordId, archiveBase64 })}\n`);
