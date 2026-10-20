import { readFile, writeFile } from "node:fs/promises";
import { POST as projectCommandsPOST } from "../../app/api/bridge/v1/projects/commands/route.ts";
import { POST as ordinarySavePOST } from "../../app/api/record/save/route.ts";
import { POST as ordinaryRestorePOST } from "../../app/api/record/restore/route.ts";
import { POST as factCommandsPOST } from "../../app/api/bridge/v1/facts/commands/route.ts";
import { POST as whole_saveRoutePOST } from "../../app/api/record/backup/route.ts";
import { endSharedRuntimePools } from "../../app/api/world-scope.ts";
import { createSessionValue } from "../../modules/identity/auth.ts";
import { parseRealmRuntimeSaveArchive } from "../../modules/world-transfer/realm-runtime-save.ts";
import { installTestSessionSecret } from "./session-proof.ts";


installTestSessionSecret();

interface CommandPayload {
  mode: "command";
  principalId: string;
  worldId: string;
  worldlineId: string;
  projectId: string;
  milestoneId: string;
  expectedProjectVersion: number;
  idempotencyKey: string;
}

interface SavePayload {
  mode: "save";
  principalId: string;
  recordId: string;
  artifactPath: string;
}

/**
 * Legacy combined payload (command then save in ONE process). Supported
 * ONLY for the immutable external probe
 * iris-f1c-review/full-restore-handler-fresh-process.test.ts, which pins
 * this original contract; the permanent in-repo test always sends an
 * explicit typed mode and runs two independent sequential processes.
 */
interface LegacyCombinedPayload {
  mode?: undefined;
  principalId: string;
  worldId: string;
  worldlineId: string;
  projectId: string;
  milestoneId: string;
  expectedProjectVersion: number;
  recordId: string;
  idempotencyKey: string;
  artifactPath: string;
}

interface OrdinaryRestorePayload {
  mode:"ordinary-restore";principalId:string;worldId:string;artifactPath:string;idempotencyKey:string;
}
interface OrdinaryContinuePayload {
  mode:"ordinary-continue";principalId:string;worldId:string;worldlineId:string;recordId:string;
  characterInstanceId:string;assetDefinitionId:string;sourceEventId:string;idempotencyKey:string;
}
interface OrdinarySavePayload extends Omit<SavePayload,"mode"> {mode:"ordinary-save";}
type ChildPayload = CommandPayload | SavePayload | LegacyCombinedPayload | OrdinarySavePayload | OrdinaryRestorePayload | OrdinaryContinuePayload;

const payloadPath = process.argv[2];
if (!payloadPath) {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, failed: true, reason: "payload path missing" })}\n`);
  process.exit(1);
}
const payload = JSON.parse(await readFile(payloadPath, "utf8")) as ChildPayload;

function authedJson(principalId: string, url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `realm_session=${createSessionValue(principalId)}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function runCommand(input: Omit<CommandPayload, "mode">): Promise<Record<string, unknown>> {
  // Actual target projects command route: explicit restored worldlineId,
  // persisted server-side definition only — no caller-held definition.
  const commandResponse = await projectCommandsPOST(authedJson(
    input.principalId,
    `http://localhost/api/bridge/v1/projects/commands?worldId=${input.worldId}&worldlineId=${input.worldlineId}`,
    {
      command: "confirm_milestone",
      projectId: input.projectId,
      milestoneId: input.milestoneId,
      expectedProjectVersion: input.expectedProjectVersion,
    },
    { "idempotency-key": input.idempotencyKey },
  ));
  const commandBody = await commandResponse.json() as {
    ok?: boolean;
    meta?: { worldlineId?: string; storyUnlocks?: { storyId: string; nodeKey: string; recordId: string }[] };
  };
  return {
    mode: "command",
    commandStatus: commandResponse.status,
    commandWorldlineId: commandBody.meta?.worldlineId ?? null,
    storyUnlocks: commandBody.meta?.storyUnlocks ?? null,
  };
}

async function runSave(input: Omit<SavePayload, "mode">, ordinary = false): Promise<Record<string, unknown>> {
  // Ordinary save route with only recordId; the server derives the
  // persisted binding from the database in THIS fresh process. The
  // archive bytes become the artifact the parent re-parses and
  // re-restores.
  const saveResponse = await (ordinary?ordinarySavePOST:whole_saveRoutePOST)(authedJson(input.principalId, ordinary?"http://localhost/api/record/save":"http://localhost/api/record/backup", { recordId: input.recordId }));
  const archiveBytes = new Uint8Array(await saveResponse.arrayBuffer());
  let save: {
    definitionHash: string | null;
    sourceBinding: unknown;
    encoreState: string | null;
  } | null = null;
  if (saveResponse.status === 200) {
    await writeFile(input.artifactPath, archiveBytes);
    const parsed = parseRealmRuntimeSaveArchive(archiveBytes);
    save = {
      definitionHash: parsed.domain?.storyDefinitions?.[0]?.definitionHash ?? null,
      sourceBinding: parsed.domain?.storyDefinitions?.[0]?.sourceBinding ?? null,
      encoreState: parsed.domain?.storyNodes.find((node) => node.nodeKey === "encore")?.state ?? null,
    };
  }
  return { mode: "save", saveStatus: saveResponse.status, save };
}

try {
  let result: Record<string, unknown>;
  if (payload.mode === "ordinary-restore") {
    const bytes=new Uint8Array(await readFile(payload.artifactPath));
    const response=await ordinaryRestorePOST(new Request('http://localhost/api/record/restore',{method:'POST',headers:{
      cookie:`realm_session=${createSessionValue(payload.principalId)}`,'content-type':'application/vnd.realm.save+zip',
      'x-realm-target-world':payload.worldId,'idempotency-key':payload.idempotencyKey},body:bytes}));
    result={mode:payload.mode,restoreStatus:response.status,target:await response.json()};
  } else if (payload.mode === "ordinary-continue") {
    const response=await factCommandsPOST(authedJson(payload.principalId,
      `http://localhost/api/bridge/v1/facts/commands?worldId=${payload.worldId}&worldlineId=${payload.worldlineId}`,
      {command:'grant_inventory',recordId:payload.recordId,characterInstanceId:payload.characterInstanceId,
       assetDefinitionId:payload.assetDefinitionId,quantity:1,sourceEventId:payload.sourceEventId},
      {'idempotency-key':payload.idempotencyKey}));
    const body=await response.json();result={mode:payload.mode,commandStatus:response.status,command:body};
  } else if (payload.mode === "ordinary-save") {
    result=await runSave(payload,true);
  } else if (payload.mode === "command") {
    result = await runCommand(payload);
  } else if (payload.mode === "save") {
    result = await runSave(payload);
  } else {
    // Legacy combined contract for the immutable external probe only.
    const command = await runCommand(payload);
    const save = await runSave(payload);
    result = { ...command, ...save, mode: undefined };
  }
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...result })}\n`);
  // Close every route pool before exiting so the parent can rely on full
  // commit + connection teardown before it spawns the second process.
  await endSharedRuntimePools();
  process.exit(0);
} catch {
  // Never print secrets or full error objects — a safe marker only.
  process.stdout.write(`${JSON.stringify({ pid: process.pid, mode: payload.mode, failed: true })}\n`);
  try {
    await endSharedRuntimePools();
  } catch { /* best effort */ }
  process.exit(1);
}
