/**
 * RealmWorld 版本比较（Phase 4D）：严格 semver X.Y.Z 数字三元组。
 * 禁止字典序比较（"1.10.0" > "1.9.0"）；不接受预发布/构建元数据/前导零
 * 等宽松形态——v1 只需要精确的三段数字版本，非法形态 fail-closed。
 */

export interface RealmWorldVersionParts {
  major: number;
  minor: number;
  patch: number;
}

const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** 解析严格 semver；非法形态（含前后空白）返回 null（调用方 fail-closed）。 */
export function parseRealmWorldVersion(value: string): RealmWorldVersionParts | null {
  const match = STRICT_SEMVER.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** 三段数字逐位比较；任一非法返回 null（绝不退化字典序）。 */
export function compareRealmWorldVersions(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseRealmWorldVersion(a);
  const right = parseRealmWorldVersion(b);
  if (!left || !right) return null;
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return 0;
}
