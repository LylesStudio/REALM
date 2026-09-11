/**
 * 批次 T10-B3：路由内部故障的脱敏结构化诊断
 * （docs/development/T10-B3-ROUTE-OBSERVABILITY.md）。
 *
 * 字段白名单：route/stage/errorType/code。绝不输出连接串、环境变量值、
 * 凭据、error.message/stack（可能带连接串）、请求 payload、claim/source
 * id、完整 SQL 或世界线内容。业务结果（业务 404/输入 400）不调用本助手。
 */
export function logRouteInternalError(input: {
  route: string;
  stage: string;
  error: unknown;
}): void {
  console.error(
    `[realm] route internal failure ${JSON.stringify({
      route: input.route,
      stage: input.stage,
      errorType: sanitizeErrorType(input.error),
      code: sanitizeErrorCode(input.error),
    })}`,
  );
}

/** 错误构造名白名单规整：XxxError 形态透传，其余归 "Error"/"unknown"。 */
function sanitizeErrorType(error: unknown): string {
  if (error instanceof Error) {
    const name = error.constructor?.name ?? error.name;
    return typeof name === "string" && /^[A-Za-z]*Error$/.test(name)
      ? name
      : "Error";
  }
  return "unknown";
}

/** 仅 errno（E 开头）或 5 位 SQLSTATE 带出，其余统一为 "unknown"。 */
function sanitizeErrorCode(error: unknown): string {
  const code = error instanceof Error
    ? (error as { code?: unknown }).code
    : undefined;
  if (typeof code !== "string") return "unknown";
  const isErrno = /^E[A-Z0-9_]{2,19}$/.test(code);
  const isSqlState = /^[0-9A-Z]{5}$/.test(code);
  return isErrno || isSqlState ? code : "unknown";
}
