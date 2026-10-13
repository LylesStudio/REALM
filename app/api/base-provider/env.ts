/**
 * Base provider operator 路由共享环境（Slice 5）。
 *
 * base content provider 是 engine-owned、不安装、不可卸载；operator
 * lifecycle 只管理 trust-store 文档中的活动 base 内容版本段（包兼容闸
 * `engineCompat.baseRange` 的对照版本）。路由只返回版本号与稳定机器码，
 * 绝不泄露 installRoot、trust-store 路径、keyId 或任何签名细节。
 */
import {
  ENGINE_BASE_CONTENT_VERSION,
  ENGINE_BASE_CONTENT_VERSIONS,
} from "../../../modules/world-transfer/engine-base.ts";
import { parseRealmWorldVersion } from "../../../modules/world-transfer/realmworld-version.ts";
import {
  mutateRealmWorldTrustStoreFile,
  readRealmWorldTrustStoreFile,
  resolveEngineBaseActiveVersion,
} from "../../../modules/world-transfer/realmworld-trust-store.ts";
import {
  RealmWorldTrustStoreError,
  type RealmWorldTrustStoreDocumentV1,
} from "../../../modules/world-transfer/realmworld-signature.ts";

export function baseErrorResponse(code: string, message: string, status: number): Response {
  return Response.json(
    { ok: false as const, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** player-safe 状态投影：只含版本号，不含任何路径/密钥材料。 */
export function baseProviderStatus(document: RealmWorldTrustStoreDocumentV1 | null) {
  return {
    activeVersion: document
      ? resolveEngineBaseActiveVersion(document)
      : ENGINE_BASE_CONTENT_VERSION,
    previousVersion: document?.base?.previousVersion ?? null,
    engineVersion: ENGINE_BASE_CONTENT_VERSION,
    servableVersions: [...ENGINE_BASE_CONTENT_VERSIONS],
    declared: document?.base !== undefined,
  } as const;
}

/** 读取 operator trust-store；缺配置/不可读/无效 → null（调用方 503）。 */
export async function readBaseProviderDocument(): Promise<{
  path: string;
  document: RealmWorldTrustStoreDocumentV1;
} | null> {
  const path = process.env.REALM_REALMWORLD_TRUST_STORE;
  if (!path) return null;
  try {
    return { path, document: await readRealmWorldTrustStoreFile(path) };
  } catch {
    return null;
  }
}

/**
 * 读 → 纯变更 → 原子写。纯变更幂等返回原文档时不落盘（changed=false）。
 */
export async function mutateBaseProviderDocument(
  path: string,
  mutate: (document: RealmWorldTrustStoreDocumentV1) => RealmWorldTrustStoreDocumentV1,
): Promise<{ document: RealmWorldTrustStoreDocumentV1; changed: boolean }> {
  const current = await readRealmWorldTrustStoreFile(path);
  const next = mutate(current);
  // 规范化文档的结构相等 = 幂等 replay（纯变更可能返回重新校验的新引用）。
  if (next === current || JSON.stringify(next) === JSON.stringify(current)) {
    return { document: next, changed: false };
  }
  await mutateRealmWorldTrustStoreFile(path, () => next);
  return { document: next, changed: true };
}

/** 请求体 version 字段校验（严格 semver；有界）。 */
export function parseBaseVersionField(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return null;
  return parseRealmWorldVersion(value) ? value : null;
}

/** trust-store 变更错误 → 稳定 HTTP 映射（绝不回显原始 message 的细节）。 */
export function baseLifecycleErrorResponse(error: unknown): Response | null {
  if (!(error instanceof RealmWorldTrustStoreError)) return null;
  switch (error.code) {
    case "BASE_VERSION_INVALID":
      return baseErrorResponse(error.code, "base version is invalid.", 400);
    case "BASE_VERSION_UNSUPPORTED":
      return baseErrorResponse(error.code, "base version is not servable by this engine.", 422);
    case "BASE_ALREADY_ACTIVE":
      return baseErrorResponse(error.code, "base content is already active; use switch.", 409);
    case "BASE_NOT_ACTIVE":
      return baseErrorResponse(error.code, "base content is not active; use activate.", 409);
    case "BASE_ROLLBACK_UNAVAILABLE":
      return baseErrorResponse(error.code, "no previous base version is recorded.", 409);
    case "TRUST_STORE_UNREADABLE":
    case "TRUST_STORE_WRITE_FAILED":
    case "TRUST_STORE_INVALID":
      return baseErrorResponse("BASE_PROVIDER_UNAVAILABLE", "base provider store is unavailable.", 503);
    default:
      return baseErrorResponse("BASE_PROVIDER_FAILED", "base provider operation failed.", 500);
  }
}
