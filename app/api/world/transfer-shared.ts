/**
 * v37 H.1 共享：transfer 池解析 + 错误 → HTTP 分类映射。
 * 全部路由 Cache-Control: no-store；transfer 池 = realm-dev 专用 wrapper
 * （component 'realm-dev-transfer'，max 2——C3）。
 */
import type { Pool } from "pg";
import { createRealmDevPostgresPool } from "../../../database/postgres/realm-dev-pool.ts";
import { WorldTransferError } from "../../../database/postgres/world-transfer-repository.ts";
import { WorldImportError } from "../../../modules/application/world-import-service.ts";
import { WorldExportRequestError } from "../../../modules/application/world-export-service.ts";

let sharedTransferPool: Pool | null = null;

/** transfer 池（单例；未配置 → null → 503 TRANSFER_NOT_PROVISIONED）。 */
export function getTransferPool(): Pool | null {
  const connectionString = process.env.REALM_TRANSFER_DATABASE_URL;
  if (!connectionString) return null;
  if (!sharedTransferPool) {
    sharedTransferPool = createRealmDevPostgresPool(
      connectionString,
      "realm-dev-transfer",
      { max: 2 },
    );
    sharedTransferPool.on("error", () => undefined);
  }
  return sharedTransferPool;
}

/** 测试回收（进程级单例）。 */
export async function endTransferPool(): Promise<void> {
  const pool = sharedTransferPool;
  sharedTransferPool = null;
  await pool?.end().catch(() => undefined);
}

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  CLIENT_DISCONNECTED: 400,
  NOT_OWNER: 403,
  WORLD_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  INCOMPLETE_CLOSURE: 409,
  TEMPLATE_UNSUPPORTED_BRANCH: 409,
  PACK_MISMATCH: 409,
  WORLD_EXISTS: 409,
  ID_COLLISION: 409,
  JOB_STATE_CONFLICT: 409,
  PACK_TOO_LARGE: 413,
  INVALID_PACK: 422,
  SIZE_SPOOF: 422,
  CRC_MISMATCH: 422,
  HASH_MISMATCH: 422,
  PACK_RATIO_EXCEEDED: 422,
  PACK_LIMIT_EXCEEDED: 422,
  COPY_INELIGIBLE: 422,
  ARCHIVE_PACK_NOT_IMPORTABLE: 422,
  UNSUPPORTED_FORMAT_VERSION: 422,
  MIGRATION_REQUIRED: 503,
  TRANSFER_NOT_PROVISIONED: 503,
};

/** 统一错误映射（从不泄露内部细节；details 仅结构化安全字段）。 */
export function transferRouteError(error: unknown): Response {
  const code = error instanceof WorldTransferError
      || error instanceof WorldImportError
      || error instanceof WorldExportRequestError
    ? (error as { code: string }).code
    : "INTERNAL";
  const status = ERROR_STATUS[code] ?? 500;
  const details = error instanceof WorldTransferError || error instanceof WorldImportError
    ? (error as { details?: unknown }).details
    : undefined;
  return Response.json(
    {
      ok: false as const,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
        ...(details !== undefined ? { details } : {}),
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** multipart 前置：Content-Length > BODY_MAX → 不读体 413。 */
export function contentLengthOversized(request: Request, maxBytes: number): boolean {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  return Number.isFinite(contentLength) && contentLength > maxBytes;
}
