/**
 * v37 H.3：.realm 导入 CLI（与 route 同一 service 层）。
 * 用法：
 *   # dry-run（校验 + 报告，不写内容）
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     scripts/realm-import.mjs --file <path> --mode <preserve|copy> \
 *       [--copy-key <key>]
 *   # execute（需 dry-run 的 jobId）
 *   ... --file <path> --execute <jobId>
 *   # cancel
 *   ... --cancel <jobId>
 * 输出稳定 JSON 摘要，零凭据。
 */
import { readFile } from "node:fs/promises";
import { createRealmDevPostgresPool } from "../database/postgres/public.ts";
import { createWorldImportService } from "../modules/application/world-import-service.ts";
import { LOCAL_RECORD_SCOPE } from "../modules/application/local-record-service.ts";

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

function fail(code, message) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message } })}\n`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const file = typeof args.file === "string" ? args.file.trim() : "";
const execute = typeof args.execute === "string" ? args.execute.trim() : "";
const cancel = typeof args.cancel === "string" ? args.cancel.trim() : "";
const mode = typeof args.mode === "string" ? args.mode.trim() : "preserve";
const copyKey = typeof args["copy-key"] === "string" ? args["copy-key"].trim() : undefined;

if (cancel && !file) {
  // cancel 不需要文件。
} else if (!file && !cancel) {
  fail("USAGE", "usage: realm-import.mjs --file <path> [--mode preserve|copy [--copy-key k]] | --execute <jobId> --file <path> | --cancel <jobId>");
}

const transferUrl = process.env.REALM_TRANSFER_DATABASE_URL;
if (!transferUrl) {
  fail("TRANSFER_NOT_PROVISIONED", "REALM_TRANSFER_DATABASE_URL is required.");
}

const pool = createRealmDevPostgresPool(transferUrl, "realm-dev-transfer", { max: 2 });
try {
  const service = createWorldImportService({
    transferPool: pool,
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
  });
  if (cancel) {
    const result = await service.cancel({ jobId: cancel });
    process.stdout.write(`${JSON.stringify({
      ok: true, jobId: cancel, status: result.status, idempotent: result.idempotent,
    })}\n`);
  } else if (execute) {
    const bytes = await readFile(file);
    const result = await service.execute({
      bytes: new Uint8Array(bytes),
      jobId: execute,
      operatorPrincipal: LOCAL_RECORD_SCOPE.principalId,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      jobId: result.jobId,
      worldId: result.worldId,
      alreadyImported: result.alreadyImported,
      report: result.report,
    })}\n`);
  } else {
    const bytes = await readFile(file);
    const result = await service.dryRun({
      bytes: new Uint8Array(bytes),
      importMode: mode,
      copyKey,
      operatorPrincipal: LOCAL_RECORD_SCOPE.principalId,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      jobId: result.jobId,
      report: result.report,
      ...(result.alreadyImported ? { alreadyImported: true } : {}),
      ...(result.alreadyValidated ? { alreadyValidated: true } : {}),
    })}\n`);
  }
} finally {
  await pool.end().catch(() => undefined);
}
