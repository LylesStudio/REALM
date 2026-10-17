import { resolveRequestPrincipal,sessionProofFromRequest,unauthorizedResponse } from '../../../auth-context.ts';
import { getSharedRuntimePool,resolveMembershipRole } from '../../../world-scope.ts';
import { createPostgresRecordRuntimeScopeRepository } from '../../../../../database/postgres/record-scope.ts';
import { LOCAL_RECORD_SCOPE } from '../../../../../modules/application/local-record-service.ts';
import { requestRecordGoalAssessment } from '../../../../../modules/application/record-goal-management.ts';
import { RuntimeInvariantError } from '../../../../../modules/runtime/public.ts';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const error=(code:string,status:number)=>Response.json({ok:false,error:{code,message:'Goal assessment was not requested.'}},
  {status,headers:{'Cache-Control':'no-store'}});
export async function POST(request:Request):Promise<Response> {
  const principalId=resolveRequestPrincipal(request,LOCAL_RECORD_SCOPE.principalId);
  if (!principalId || !sessionProofFromRequest(request)) return unauthorizedResponse();
  if(request.headers.get('origin')!==new URL(request.url).origin || request.headers.get('sec-fetch-site')==='cross-site') return error('GOAL_ORIGIN_REJECTED',403);
  if(request.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json') return error('GOAL_COMMAND_INVALID',400);
  try {
    const text=await request.text();
    if(Buffer.byteLength(text,'utf8')>4096) return error('GOAL_COMMAND_INVALID',413);
    let body:unknown;
    try {body=JSON.parse(text);} catch {return error('GOAL_COMMAND_INVALID',400);}
    if(!body || typeof body!=='object' || Array.isArray(body)) return error('GOAL_COMMAND_INVALID',400);
    const row=body as Record<string,unknown>;
    if(Object.keys(row).some(key=>!['recordId','goalInstanceId','expectedHead'].includes(key))
      || typeof row.recordId!=='string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(row.recordId)
      || typeof row.goalInstanceId!=='string' || !/^[A-Za-z0-9._:-]{1,160}$/.test(row.goalInstanceId)
      || !row.expectedHead || typeof row.expectedHead!=='object' || Array.isArray(row.expectedHead)) return error('GOAL_COMMAND_INVALID',400);
    const head=row.expectedHead as Record<string,unknown>;
    if(Object.keys(head).some(key=>!['recordVersion','ordinal'].includes(key))
      || ![head.recordVersion,head.ordinal].every(value=>typeof value==='number' && Number.isSafeInteger(value) && value>=0)
      || (head.recordVersion===0)!==(head.ordinal===0)) return error('GOAL_COMMAND_INVALID',400);
    const url=process.env.REALM_RUNTIME_DATABASE_URL;
    if(!url) return error('LOCAL_RUNTIME_NOT_INITIALIZED',503);
    const pool=getSharedRuntimePool(url);
    const scope=await createPostgresRecordRuntimeScopeRepository(pool).resolve({...LOCAL_RECORD_SCOPE,principalId,recordId:row.recordId});
    if(!scope) return error('GOAL_NOT_FOUND',404);
    const role=await resolveMembershipRole(pool,{workspaceId:scope.workspaceId,worldId:scope.worldId,principalId});
    if(!role) return error('GOAL_NOT_FOUND',404);
    if(role!=='owner') return error('GOAL_FORBIDDEN',403);
    const status=await requestRecordGoalAssessment(pool,{scope,principalId,goalInstanceId:row.goalInstanceId,
      expectedHead:{recordVersion:head.recordVersion as number,ordinal:head.ordinal as number}});
    return Response.json({ok:true,data:{status}},{headers:{'Cache-Control':'no-store'}});
  } catch(cause) {
    if(cause instanceof RuntimeInvariantError) {
      if(cause.code==='GOAL_FORBIDDEN') return error(cause.code,403);
      if(cause.code==='GOAL_NOT_FOUND') return error(cause.code,404);
      if(['GOAL_READ_ONLY','GOAL_WRITE_CONFLICT','GOAL_INSTANCE_TERMINAL'].includes(cause.code)) return error(cause.code,409);
    }
    return error('GOAL_ASSESSMENT_UNAVAILABLE',503);
  }
}
