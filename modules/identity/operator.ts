/**
 * 全局 operator 判定（server-only）。
 *
 * 唯一授权来源：服务端环境变量 REALM_OPERATOR_PRINCIPALS——逗号分隔的
 * 精确 principal ID 列表。空缺/空白一律视为「无 operator」，调用方必须
 * fail-closed；不支持任何通配符/前缀匹配。principal 只能来自已验证的
 * session（principalFromRequest）或本地单用户 fallback；request
 * body/query 自报的 principal 与 world membership role（含 owner）都不
 * 构成 operator。值不是 secret，但绝不写入日志/响应。
 */

/** 解析 allowlist（每次调用现读环境：测试与运行期改配置都即时生效）。 */
export function operatorPrincipals(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlySet<string> {
  const raw = environment.REALM_OPERATOR_PRINCIPALS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0),
  );
}

/** 精确命中即 operator；null/空 principal 或空 allowlist 一律 false。 */
export function isOperatorPrincipal(
  principalId: string | null | undefined,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!principalId) return false;
  return operatorPrincipals(environment).has(principalId);
}
