/**
 * v37 Y1：导出 service（H.1 route 与 CLI 共用）。
 * - 请求 scope 校验（D.3 唯一字段集；full/template 禁 storyIds/recordIds；
 *   selection 至少一个非空）；
 * - displayName 预解析（runtime 池；realm_transfer 不读 accounts）；
 * - 调用 world-transfer-repository 的 F.4 导出事务。
 */
import type { Pool } from "pg";
import {
  WorldTransferError,
  createWorldTransferExporter,
  type ExportRequestScope,
  type ExportResult,
} from "../../database/postgres/world-transfer-repository.ts";

export class WorldExportRequestError extends Error {
  readonly code = "INVALID_REQUEST" as const;
  constructor(message: string) {
    super(message);
    this.name = "WorldExportRequestError";
  }
}

export function normalizeExportScope(body: unknown): ExportRequestScope {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new WorldExportRequestError("请求体必须是 JSON 对象。");
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["worldId", "mode", "storyIds", "recordIds", "includeLinked", "includeMemberships"]
      .includes(key)) {
      throw new WorldExportRequestError(`未知字段：${key}`);
    }
  }
  const worldId = typeof record.worldId === "string" ? record.worldId.trim() : "";
  if (!worldId) throw new WorldExportRequestError("worldId 必填。");
  const mode = record.mode;
  if (mode !== "full" && mode !== "template" && mode !== "selection") {
    throw new WorldExportRequestError("mode 必须是 full | template | selection。");
  }
  const idList = (value: unknown, name: string): string[] | undefined => {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)
      || !value.every((x) => typeof x === "string" && x.trim().length > 0)) {
      throw new WorldExportRequestError(`${name} 必须是非空字符串数组。`);
    }
    return value.map((x) => (x as string).trim());
  };
  const storyIds = idList(record.storyIds, "storyIds");
  const recordIds = idList(record.recordIds, "recordIds");
  if ((mode === "full" || mode === "template")
    && (storyIds !== undefined || recordIds !== undefined)) {
    throw new WorldExportRequestError("full/template 模式不允许 storyIds/recordIds。");
  }
  if (mode === "selection"
    && !((storyIds?.length ?? 0) > 0 || (recordIds?.length ?? 0) > 0)) {
    throw new WorldExportRequestError("selection 模式要求 storyIds/recordIds 至少一个非空。");
  }
  const flag = (value: unknown, name: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      throw new WorldExportRequestError(`${name} 必须是布尔值。`);
    }
    return value;
  };
  return {
    worldId,
    mode,
    storyIds,
    recordIds,
    includeLinked: flag(record.includeLinked, "includeLinked"),
    includeMemberships: flag(record.includeMemberships, "includeMemberships"),
  };
}

export function createWorldExportService(options: {
  transferPool: Pool;
  runtimePool: Pool;
  workspaceId: string;
  appVersion: string;
}) {
  const exporter = createWorldTransferExporter(options.transferPool);
  return {
    async exportWorld(
      scope: ExportRequestScope,
      operatorPrincipal: string,
    ): Promise<ExportResult> {
      // displayName 预解析（runtime 池读 accounts；transfer 池不读）。
      const accounts = await options.runtimePool.query<{
        principal_id: string;
        display_name: string;
      }>(
        `SELECT principal_id, display_name FROM accounts WHERE workspace_id = $1`,
        [options.workspaceId],
      );
      const displayNames = new Map(
        accounts.rows.map((row) => [row.principal_id, row.display_name]),
      );
      return exporter.exportWorld({
        workspaceId: options.workspaceId,
        request: scope,
        operatorPrincipal,
        appVersion: options.appVersion,
        displayNames,
      });
    },
  };
}

export { WorldTransferError };
