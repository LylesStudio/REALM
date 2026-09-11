/**
 * v37 H.3：.realm 导出 CLI（与 route 同一 service 层）。
 * 用法：
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     scripts/realm-export.mjs --world <id> --mode <full|template|selection> \
 *       --out <path> [--stories a,b] [--records x,y] [--include-linked] \
 *       [--include-memberships]
 * 输出稳定 JSON 摘要（jobId/contentHash/archiveBytesHash/表计数/文件数），
 * 零凭据。loopback 由 createLocalPostgresPool 校验。
 */
import { writeFile } from "node:fs/promises";
import {
  createLocalPostgresPool,
  createRealmDevPostgresPool,
} from "../database/postgres/public.ts";
import { createWorldExportService } from "../modules/application/world-export-service.ts";
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
const worldId = typeof args.world === "string" ? args.world.trim() : "";
const mode = typeof args.mode === "string" ? args.mode.trim() : "";
const out = typeof args.out === "string" ? args.out.trim() : "";
if (!worldId || !out || !["full", "template", "selection"].includes(mode)) {
  fail("USAGE", "usage: realm-export.mjs --world <id> --mode <full|template|selection> --out <path> [--stories a,b] [--records x,y] [--include-linked] [--include-memberships]");
}

const transferUrl = process.env.REALM_TRANSFER_DATABASE_URL;
const runtimeUrl = process.env.REALM_RUNTIME_DATABASE_URL;
if (!transferUrl || !runtimeUrl) {
  fail("TRANSFER_NOT_PROVISIONED", "REALM_TRANSFER_DATABASE_URL / REALM_RUNTIME_DATABASE_URL are required.");
}

const splitIds = (value) => typeof value === "string"
  ? value.split(",").map((item) => item.trim()).filter(Boolean)
  : undefined;

const transferPool = createRealmDevPostgresPool(transferUrl, "realm-dev-transfer", { max: 2 });
const runtimePool = createLocalPostgresPool(runtimeUrl, {
  max: 2,
  application_name: "realm-cli",
});
try {
  const service = createWorldExportService({
    transferPool,
    runtimePool,
    workspaceId: LOCAL_RECORD_SCOPE.workspaceId,
    appVersion: "0.1.0",
  });
  const result = await service.exportWorld({
    worldId,
    mode,
    storyIds: splitIds(args.stories),
    recordIds: splitIds(args.records),
    includeLinked: args["include-linked"] === "true",
    includeMemberships: args["include-memberships"] === "true",
  }, LOCAL_RECORD_SCOPE.principalId);
  await writeFile(out, Buffer.from(result.bytes), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    out,
    jobId: result.jobId,
    contentHash: result.contentHash,
    archiveBytesHash: result.archiveBytesHash,
    tables: result.tableSummary.length,
    files: result.fileCount,
  })}\n`);
} finally {
  await transferPool.end().catch(() => undefined);
  await runtimePool.end().catch(() => undefined);
}
