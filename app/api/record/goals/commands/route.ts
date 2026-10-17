import { resolveRequestPrincipal, sessionProofFromRequest, unauthorizedResponse } from '../../../auth-context.ts';
import { getSharedRuntimePool, resolveMembershipRole } from '../../../world-scope.ts';
import { createPostgresRecordRuntimeScopeRepository } from '../../../../../database/postgres/record-scope.ts';
import { LOCAL_RECORD_SCOPE } from '../../../../../modules/application/local-record-service.ts';
import { executeRecordGoalCommand, normalizeRecordGoalCommand } from '../../../../../modules/application/record-goal-command.ts';
import { loadRecordGoalManagement } from '../../../../../modules/application/record-goal-management.ts';
import { RuntimeInvariantError } from '../../../../../modules/runtime/public.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
function error(code: string, status: number) {
  return Response.json({ ok: false, error: { code, message: 'Goal command was not committed.' } }, { status, headers: { 'Cache-Control': 'no-store' } });
}
export async function GET(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request,LOCAL_RECORD_SCOPE.principalId);
  if (!principalId || !sessionProofFromRequest(request)) return unauthorizedResponse();
  const recordId = new URL(request.url).searchParams.get('recordId');
  if (!recordId || !/^[A-Za-z0-9._:-]{1,160}$/.test(recordId)) return error('GOAL_COMMAND_INVALID',400);
  const url = process.env.REALM_RUNTIME_DATABASE_URL;
  if (!url) return error('LOCAL_RUNTIME_NOT_INITIALIZED',503);
  try {
    const pool = getSharedRuntimePool(url);
    const scope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({...LOCAL_RECORD_SCOPE,principalId,recordId});
    if (!scope) return error('GOAL_NOT_FOUND',404);
    const role = await resolveMembershipRole(pool,{workspaceId:scope.workspaceId,worldId:scope.worldId,principalId});
    if (!role) return error('GOAL_NOT_FOUND',404);
    if (role!=='owner') return error('GOAL_FORBIDDEN',403);
    const data = await loadRecordGoalManagement(pool,{scope,principalId});
    return Response.json({ok:true,data},{headers:{'Cache-Control':'no-store'}});
  } catch(cause) {
    if (cause instanceof RuntimeInvariantError && cause.code==='GOAL_FORBIDDEN') return error('GOAL_FORBIDDEN',403);
    return error('GOAL_COMMAND_UNAVAILABLE',503);
  }
}

export async function POST(request: Request): Promise<Response> {
  const principalId = resolveRequestPrincipal(request, LOCAL_RECORD_SCOPE.principalId);
  if (!principalId) return unauthorizedResponse();
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') {
    return error('GOAL_ORIGIN_REJECTED', 403);
  }
  const proof = sessionProofFromRequest(request);
  if (!proof) return unauthorizedResponse();
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return error('GOAL_COMMAND_INVALID', 400);
  const key = request.headers.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) return error('GOAL_COMMAND_INVALID', 400);
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 65536) return error('GOAL_COMMAND_INVALID', 413);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return error('GOAL_COMMAND_INVALID', 400); }
    const command = normalizeRecordGoalCommand(parsed);
    const url = process.env.REALM_RUNTIME_DATABASE_URL;
    if (!url) return error('LOCAL_RUNTIME_NOT_INITIALIZED', 503);
    const pool = getSharedRuntimePool(url);
    const scope = await createPostgresRecordRuntimeScopeRepository(pool).resolve({ ...LOCAL_RECORD_SCOPE, principalId, recordId: command.recordId });
    if (!scope) return error('GOAL_NOT_FOUND', 404);
    const role = await resolveMembershipRole(pool, { workspaceId: scope.workspaceId, worldId: scope.worldId, principalId });
    if (!role) return error('GOAL_NOT_FOUND', 404);
    if (role !== 'owner') return error('GOAL_FORBIDDEN', 403);
    const data = await executeRecordGoalCommand(pool, { scope, principalId, sessionProof: proof, idempotencyKey: key, command });
    return Response.json({ ok: true, data }, { status: command.operation === 'create' && data.status !== 'replayed' ? 201 : 200, headers: { 'Cache-Control': 'no-store' } });
  } catch (cause) {
    const code = cause instanceof RuntimeInvariantError ? cause.code
      : cause instanceof Error ? cause.message : '';
    if (['GOAL_COMMAND_INVALID', 'GOAL_DRAFT_INVALID', 'GOAL_DRAFT_UNKNOWN_FIELD', 'GOAL_CHANGE_POLICY_INVALID', 'GOAL_HEAD_INVALID'].includes(code)) return error(code, 400);
    if (code === 'GOAL_NOT_FOUND') return error(code, 404);
    if (code === 'GOAL_FORBIDDEN' || code.startsWith('CAPABILITY_SESSION_')) return error('GOAL_FORBIDDEN', 403);
    if (['GOAL_FIXED', 'GOAL_DEFINITION_FIXED', 'GOAL_DEFINITION_UNCHANGED', 'GOAL_INSTANCE_TERMINAL', 'GOAL_WRITE_CONFLICT', 'GOAL_IDEMPOTENCY_KEY_REUSED', 'GOAL_READ_ONLY', 'GOAL_AUTHORING_POLICY_REQUIRED'].includes(code)) return error(code, 409);
    return error('GOAL_COMMAND_UNAVAILABLE', 503);
  }
}
