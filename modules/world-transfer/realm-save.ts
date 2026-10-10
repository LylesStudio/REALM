/**
 * RealmWorld Phase 1A：`realm-save` v1 存档 manifest 契约（纯函数，无数据库
 * 副作用；不接任何 route）。
 *
 * 语义（docs/development/REALMWORLD-ENGINE-UPGRADE-PLAN.md §5/§6）：
 * - `.realm` 是运行存档；v1 manifest 只承载身份与引擎契约：
 *   `{ format, formatVersion, mode, engineApi, world }`；
 * - `mode: "base"` 是未挂载 RealmWorld 的基础/实验运行（`world === null`）；
 *   `"world-bound"` 绑定 `worldId + worldVersion`；
 * - 解析 fail-closed：未知顶层/嵌套字段、错误类型、空 identity、非法
 *   mode/format/version 一律拒绝；`formatVersion > 1` 单独分类；
 * - 版本兼容不是解析职责：`assessRealmSaveWorld` 把“同 worldId 版本不同”
 *   表达为可读取的 warning（数据而非异常），把“缺 World”表达为明确错误
 *   分类——绝不静默把 world-bound 存档降级成 base；
 * - 序列化键序冻结（format → formatVersion → mode → engineApi → world；
 *   嵌套 worldId → worldVersion），同输入同字节。
 */

export type RealmSaveErrorCode = "INVALID_SAVE" | "UNSUPPORTED_FORMAT_VERSION";

export class RealmSaveError extends Error {
  readonly code: RealmSaveErrorCode;
  constructor(code: RealmSaveErrorCode, message: string) {
    super(message);
    this.name = "RealmSaveError";
    this.code = code;
  }
}

/** 世界绑定的一级形态：base（无内容绑定）或 world-bound（worldId+版本）。 */
export type WorldBinding =
  | { kind: "base" }
  | { kind: "world"; worldId: string; worldVersion: string };

/** base mode / 本地自建世界的确定性哨兵版本（与 migration 0054 回填同值）。 */
export const LOCAL_WORLD_VERSION = "0.0.0-local";

export const REALM_SAVE_FORMAT = "realm-save";
export const REALM_SAVE_FORMAT_VERSION = 1;
/** 当前引擎实现的存档引擎契约主版本（"1.x" 系均可读）。 */
export const REALM_SAVE_ENGINE_API = "1.x";
const ENGINE_API_MAJOR_PATTERN = /^1\./;

export interface RealmSaveWorldRef {
  worldId: string;
  worldVersion: string;
}

export type RealmSaveMode = "base" | "world-bound";

export interface RealmSaveManifestV1 {
  format: typeof REALM_SAVE_FORMAT;
  formatVersion: typeof REALM_SAVE_FORMAT_VERSION;
  mode: RealmSaveMode;
  engineApi: string;
  world: RealmSaveWorldRef | null;
}

/** 挂载评估结果（数据而非异常）：warning 可读取，error 必须显式处理。 */
export type RealmSaveWorldAssessment =
  | { kind: "base" }
  | { kind: "ok"; worldId: string; worldVersion: string }
  | {
      kind: "warning";
      code: "WORLD_VERSION_MISMATCH";
      worldId: string;
      requiredVersion: string;
      installedVersion: string;
    }
  | { kind: "error"; code: "WORLD_NOT_INSTALLED"; worldId: string };

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new RealmSaveError("INVALID_SAVE", `unknown manifest key ${where}.${key}`);
    }
  }
}

/** 非空且无首尾空白（btrim 语义，与 DB CHECK 对齐）。 */
function requireIdentityString(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw new RealmSaveError("INVALID_SAVE", `manifest ${where} must be a string`);
  }
  if (value.trim().length === 0 || value.trim() !== value) {
    throw new RealmSaveError(
      "INVALID_SAVE",
      `manifest ${where} must be non-empty without surrounding whitespace`,
    );
  }
  return value;
}

function requireMode(value: unknown): RealmSaveMode {
  if (value !== "base" && value !== "world-bound") {
    throw new RealmSaveError("INVALID_SAVE", "manifest mode must be base|world-bound");
  }
  return value;
}

function requireEngineApi(value: unknown): string {
  if (typeof value !== "string") {
    throw new RealmSaveError("INVALID_SAVE", "manifest engineApi must be a string");
  }
  if (!ENGINE_API_MAJOR_PATTERN.test(value)) {
    throw new RealmSaveError(
      "INVALID_SAVE",
      "manifest engineApi is beyond the supported engine contract (1.x)",
    );
  }
  return value;
}

function requireWorldRef(value: unknown, mode: RealmSaveMode): RealmSaveWorldRef | null {
  if (value === null) {
    if (mode === "world-bound") {
      throw new RealmSaveError(
        "INVALID_SAVE",
        "world-bound save must carry a world identity",
      );
    }
    return null;
  }
  if (mode === "base") {
    throw new RealmSaveError("INVALID_SAVE", "base save must not carry a world identity");
  }
  if (!isPlainObject(value)) {
    throw new RealmSaveError("INVALID_SAVE", "manifest world must be an object or null");
  }
  assertExactKeys(value, ["worldId", "worldVersion"], "world");
  return {
    worldId: requireIdentityString(value.worldId, "world.worldId"),
    worldVersion: requireIdentityString(value.worldVersion, "world.worldVersion"),
  };
}

function requireManifestShape(manifest: RealmSaveManifestV1): RealmSaveManifestV1 {
  if (manifest.format !== REALM_SAVE_FORMAT) {
    throw new RealmSaveError("INVALID_SAVE", "manifest format must be realm-save");
  }
  if (manifest.formatVersion !== REALM_SAVE_FORMAT_VERSION) {
    throw new RealmSaveError("INVALID_SAVE", "manifest formatVersion must be 1");
  }
  return {
    format: REALM_SAVE_FORMAT,
    formatVersion: REALM_SAVE_FORMAT_VERSION,
    mode: requireMode(manifest.mode),
    engineApi: requireEngineApi(manifest.engineApi),
    world: requireWorldRef(manifest.world, manifest.mode),
  };
}

// ---------------------------------------------------------------------------
// 序列化 / 解析
// ---------------------------------------------------------------------------

/** 稳定序列化（键序冻结；无空格）。输入先经完整契约校验。 */
export function serializeRealmSaveManifest(manifest: RealmSaveManifestV1): string {
  const valid = requireManifestShape(manifest);
  const out: Record<string, unknown> = {
    format: valid.format,
    formatVersion: valid.formatVersion,
    mode: valid.mode,
    engineApi: valid.engineApi,
    world: valid.world === null
      ? null
      : { worldId: valid.world.worldId, worldVersion: valid.world.worldVersion },
  };
  return JSON.stringify(out);
}

/** 严格解析（fail-closed；未知字段/错误类型/非法值一律拒绝）。 */
export function parseRealmSaveManifest(input: string | Uint8Array): RealmSaveManifestV1 {
  const text = typeof input === "string" ? input : Buffer.from(input).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RealmSaveError("INVALID_SAVE", "save manifest is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new RealmSaveError("INVALID_SAVE", "save manifest must be an object");
  }
  assertExactKeys(
    parsed,
    ["format", "formatVersion", "mode", "engineApi", "world"],
    "",
  );
  if (parsed.format !== REALM_SAVE_FORMAT) {
    throw new RealmSaveError("INVALID_SAVE", "manifest format must be realm-save");
  }
  if (
    typeof parsed.formatVersion !== "number"
    || !Number.isInteger(parsed.formatVersion)
  ) {
    throw new RealmSaveError("INVALID_SAVE", "manifest formatVersion must be an integer");
  }
  if (parsed.formatVersion > REALM_SAVE_FORMAT_VERSION) {
    throw new RealmSaveError("UNSUPPORTED_FORMAT_VERSION", "manifest formatVersion > 1");
  }
  if (parsed.formatVersion !== REALM_SAVE_FORMAT_VERSION) {
    throw new RealmSaveError("INVALID_SAVE", "manifest formatVersion must be 1");
  }
  const mode = requireMode(parsed.mode);
  return {
    format: REALM_SAVE_FORMAT,
    formatVersion: REALM_SAVE_FORMAT_VERSION,
    mode,
    engineApi: requireEngineApi(parsed.engineApi),
    world: requireWorldRef(parsed.world, mode),
  };
}

// ---------------------------------------------------------------------------
// WorldBinding 映射与挂载评估
// ---------------------------------------------------------------------------

export function worldBindingFromManifest(manifest: RealmSaveManifestV1): WorldBinding {
  const valid = requireManifestShape(manifest);
  if (valid.mode === "base") return { kind: "base" };
  const world = valid.world as RealmSaveWorldRef;
  return { kind: "world", worldId: world.worldId, worldVersion: world.worldVersion };
}

/**
 * 数据库世界身份（`worlds.id` + `worlds.world_version`）→ `WorldBinding`。
 * `worldVersion === LOCAL_WORLD_VERSION` 表示 base（pre-contract 本地世界，
 * worldId 不参与绑定——绝不把 base 偷绑到某个 worldId）；其余合法版本必须
 * 携带严格 worldId。非法身份 fail-closed（RealmSaveError/INVALID_SAVE），
 * 绝不静默降级为 base。
 */
export function worldBindingFromWorldIdentity(identity: {
  worldId: unknown;
  worldVersion: unknown;
}): WorldBinding {
  const worldVersion = requireIdentityString(
    identity.worldVersion,
    "world.worldVersion",
  );
  if (worldVersion === LOCAL_WORLD_VERSION) return { kind: "base" };
  return {
    kind: "world",
    worldId: requireIdentityString(identity.worldId, "world.worldId"),
    worldVersion,
  };
}

export function realmSaveManifestFromBinding(
  binding: WorldBinding,
  engineApi: string = REALM_SAVE_ENGINE_API,
): RealmSaveManifestV1 {
  if (binding.kind === "base") {
    return requireManifestShape({
      format: REALM_SAVE_FORMAT,
      formatVersion: REALM_SAVE_FORMAT_VERSION,
      mode: "base",
      engineApi,
      world: null,
    });
  }
  return requireManifestShape({
    format: REALM_SAVE_FORMAT,
    formatVersion: REALM_SAVE_FORMAT_VERSION,
    mode: "world-bound",
    engineApi,
    world: requireWorldRef(
      { worldId: binding.worldId, worldVersion: binding.worldVersion },
      "world-bound",
    ),
  });
}

/**
 * 挂载评估（纯函数）。`resolveInstalledVersion` 返回 null 表示该 worldId
 * 未挂载。版本差异是 warning（可读取，引擎/界面负责显式提示）；缺 World
 * 是 error——调用方必须引导安装/选择，不得静默按 base 恢复。
 */
export function assessRealmSaveWorld(
  manifest: RealmSaveManifestV1,
  resolveInstalledVersion: (worldId: string) => string | null,
): RealmSaveWorldAssessment {
  const valid = requireManifestShape(manifest);
  if (valid.mode === "base") return { kind: "base" };
  const world = valid.world as RealmSaveWorldRef;
  const installedVersion = resolveInstalledVersion(world.worldId);
  if (installedVersion === null) {
    return { kind: "error", code: "WORLD_NOT_INSTALLED", worldId: world.worldId };
  }
  if (installedVersion !== world.worldVersion) {
    return {
      kind: "warning",
      code: "WORLD_VERSION_MISMATCH",
      worldId: world.worldId,
      requiredVersion: world.worldVersion,
      installedVersion,
    };
  }
  return { kind: "ok", worldId: world.worldId, worldVersion: world.worldVersion };
}
