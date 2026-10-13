/**
 * Engine-owned base 内容的规范版本/兼容声明（引擎升级计划 Slice 5）。
 *
 * base content provider 是引擎固有能力：不安装、不可卸载、不读取
 * install root / trust-store / 网络。本模块是它唯一的身份与版本真相：
 *
 * - `ENGINE_BASE_WORLD`：base 持久化绑定哨兵（worldId 空串 +
 *   `LOCAL_WORLD_VERSION`）。任何用户 `.realmworld` 包不得声明该身份
 *   （manifest 解析层 fail-closed 拒绝，见 realmworld-manifest.ts）；
 * - `ENGINE_BASE_CONTENT_VERSION`：当前引擎构建提供的 base 内容版本
 *   （严格 semver）。已安装 RealmWorld 包必须在 manifest
 *   `engineCompat.baseRange` 声明与该版本兼容的区间；引擎 base 版本变化
 *   （升级或 operator 切换/回滚）后，不再兼容的包在 mount/install/restore
 *   闸一律 fail-closed（稳定码 `BASE_VERSION_INCOMPATIBLE`），绝不静默
 *   降级或继续运行；
 * - `ENGINE_BASE_CONTENT_VERSIONS`：本引擎构建可实际 serve 的 base 内容
 *   版本全集（含当前版本；operator 只能在该集合内 activate/switch/
 *   rollback）。
 *
 * client-safe：只依赖 realm-save.ts 的哨兵常量与 realmworld-version.ts
 * 的严格 semver 解析，不 import node:* / pg / DB 模块。
 */
import { LOCAL_WORLD_VERSION } from "./realm-save.ts";
import {
  parseRealmWorldVersion,
  type RealmWorldVersionParts,
} from "./realmworld-version.ts";

/** base 持久化绑定的确定性哨兵身份（engine-owned，用户包不可冒充）。 */
export const ENGINE_BASE_WORLD: Readonly<{ worldId: string; worldVersion: string }> =
  Object.freeze({
    worldId: "",
    worldVersion: LOCAL_WORLD_VERSION,
  });

/** 当前引擎构建的 base 内容版本（严格 semver）。 */
export const ENGINE_BASE_CONTENT_VERSION = "1.0.0";

/** 本引擎构建可 serve 的 base 内容版本全集（含当前版本，升序、去重）。 */
export const ENGINE_BASE_CONTENT_VERSIONS: readonly string[] = Object.freeze([
  ENGINE_BASE_CONTENT_VERSION,
]);

/** 精确 base 哨兵身份判定（content 请求/world binding 共用）。 */
export function isEngineBaseWorldIdentity(worldId: string, worldVersion: string): boolean {
  return worldId === ENGINE_BASE_WORLD.worldId
    && worldVersion === ENGINE_BASE_WORLD.worldVersion;
}

/** 该 base 内容版本是否可由本引擎构建 serve（operator 切换/回滚的合法目标）。 */
export function isEngineBaseContentVersionServable(version: string): boolean {
  return ENGINE_BASE_CONTENT_VERSIONS.includes(version);
}

// ---------------------------------------------------------------------------
// base 版本区间文法（RealmWorld manifest `engineCompat.baseRange`）
// ---------------------------------------------------------------------------

/**
 * 有界确定性区间文法（非 npm semver 全量）：
 * - `*`：任意版本；
 * - 精确 `1.2.3`（等价 `=1.2.3`）；
 * - `^1.2.3`：兼容段 `>=1.2.3 <2.0.0`（0.x 按 semver 收缩：`^0.2.3` →
 *   `<0.3.0`，`^0.0.3` → `<0.0.4`）；
 * - `~1.2.3`：`>=1.2.3 <1.3.0`；
 * - 空格分隔的比较子合取：`>=1.0.0 <2.0.0`（`>`/`>=`/`<=`/`<`/`=`，
 *   1–8 个 token）。
 * 任何无法解析的形态返回 null——调用方必须 fail-closed。
 */

type RangeComparatorOp = ">" | ">=" | "<" | "<=" | "=";

interface RangeComparator {
  op: RangeComparatorOp;
  version: RealmWorldVersionParts;
}

export type EngineBaseVersionRange =
  | { kind: "any" }
  | { kind: "comparators"; comparators: readonly RangeComparator[] };

const MAX_RANGE_LENGTH = 256;
const MAX_RANGE_TOKENS = 8;
const COMPARATOR_RE = /^(>=|<=|>|<|=)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function compareParts(a: RealmWorldVersionParts, b: RealmWorldVersionParts): -1 | 0 | 1 {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return 0;
}

function comparatorForToken(token: string): RangeComparator | null {
  const match = COMPARATOR_RE.exec(token);
  if (!match) return null;
  return {
    op: (match[1] ?? "=") as RangeComparatorOp,
    version: {
      major: Number(match[2]),
      minor: Number(match[3]),
      patch: Number(match[4]),
    },
  };
}

/** 解析 base 版本区间；任何非文法形态返回 null（fail-closed）。 */
export function parseEngineBaseVersionRange(range: string): EngineBaseVersionRange | null {
  if (
    typeof range !== "string"
    || range.length === 0
    || range.length > MAX_RANGE_LENGTH
    || range.trim() !== range
  ) {
    return null;
  }
  if (range === "*") return { kind: "any" };
  const tokens = range.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_RANGE_TOKENS) return null;
  const comparators: RangeComparator[] = [];
  for (const token of tokens) {
    if (token.startsWith("^")) {
      const parts = parseRealmWorldVersion(token.slice(1));
      if (!parts) return null;
      // caret 上界：major>0 → <(major+1).0.0；major=0 且 minor>0 → <0.(minor+1).0；
      // 0.0.x → <0.0.(patch+1)。
      const upper: RealmWorldVersionParts = parts.major > 0
        ? { major: parts.major + 1, minor: 0, patch: 0 }
        : parts.minor > 0
          ? { major: 0, minor: parts.minor + 1, patch: 0 }
          : { major: 0, minor: 0, patch: parts.patch + 1 };
      comparators.push({ op: ">=", version: parts }, { op: "<", version: upper });
      continue;
    }
    if (token.startsWith("~")) {
      const parts = parseRealmWorldVersion(token.slice(1));
      if (!parts) return null;
      comparators.push(
        { op: ">=", version: parts },
        { op: "<", version: { major: parts.major, minor: parts.minor + 1, patch: 0 } },
      );
      continue;
    }
    const comparator = comparatorForToken(token);
    if (!comparator) return null;
    comparators.push(comparator);
  }
  return { kind: "comparators", comparators };
}

function satisfiesComparator(version: RealmWorldVersionParts, comparator: RangeComparator): boolean {
  const order = compareParts(version, comparator.version);
  switch (comparator.op) {
    case ">": return order > 0;
    case ">=": return order >= 0;
    case "<": return order < 0;
    case "<=": return order <= 0;
    case "=": return order === 0;
  }
}

/**
 * 区间匹配：range 无法解析或 version 非严格 semver 一律 false
 *（fail-closed——不兼容结论绝不依赖宽松解析）。
 */
export function isEngineBaseVersionSatisfied(range: string, version: string): boolean {
  const parsedRange = parseEngineBaseVersionRange(range);
  const parsedVersion = parseRealmWorldVersion(version);
  if (!parsedRange || !parsedVersion) return false;
  if (parsedRange.kind === "any") return true;
  return parsedRange.comparators.every((comparator) =>
    satisfiesComparator(parsedVersion, comparator));
}
