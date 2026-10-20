import { createInstalledRealmWorldCommandPolicyResolver } from "../../../../../../modules/world-transfer/realmworld-command-policy.ts";
import { readRealmWorldVerifier } from "../../../../realmworld/env.ts";
import {
  createProjectFinanceCommandService,
  PROJECT_STAGES,
  ProjectFinanceCommandError,
  readRecordEvidence,
  type ProjectFinanceAction,
  type ProjectStage,
} from "../../../../../../modules/application/project-finance-command.ts";
import { createPostgresProjectFinanceCommandStore } from "../../../../../../database/postgres/project-finance-command-repository.ts";
import {
  authorizeProjectFinanceWrite,
  projectFinanceRouteError,
  resolveProjectFinanceContext,
} from "../../project-finance-context.ts";
import {
  runCommandWithStoryContinuation,
  storyContinuationMeta,
} from "../../../../../../modules/application/story-graph-continuation.ts";

export const runtime = "nodejs";

const MAX_TEXT = 256;

export async function POST(request: Request): Promise<Response> {
  try {
    const context = await resolveProjectFinanceContext(request, { access: "write" });
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return projectFinanceRouteError(new ProjectFinanceCommandError(
        "COMMAND_INVALID",
        "Idempotency-Key is required.",
      ));
    }
    const body = await readBody(request);
    const evidence = readRecordEvidence(body);
    // F1b: one outer transaction carries the command store/service AND the
    // full Story continuation on the SAME client; everything commits once or
    // rolls back together. A replayed historical receipt reports an explicit
    // blocked continuation instead of a fake success.
    const { command: executed, continuation } = await runCommandWithStoryContinuation(
      context.database,
      context.scope,
      async (client) => {
        await authorizeProjectFinanceWrite(client, context);
        const service = createProjectFinanceCommandService({
          store: createPostgresProjectFinanceCommandStore(client, { resolveCommandPolicy: async binding => {
            const verifier = await readRealmWorldVerifier();
            if (!verifier) return null;
            return createInstalledRealmWorldCommandPolicyResolver(verifier)(binding);
          } }),
        });
        if (body.command === "change_stage") {
          return {
            kind: "change_stage" as const,
            result: await service.changeStage({
              scope: context.scope,
              projectId: requiredText(body.projectId, "projectId"),
              stage: requiredText(body.stage, "stage"),
              expectedProjectVersion: requiredInteger(body.expectedProjectVersion),
              idempotencyKey,
              evidence,
            }),
          };
        }
        if (body.command === "apply_project_finance") {
          return {
            kind: "apply_project_finance" as const,
            result: await service.applyRecordProjectFinance({
              scope: context.scope,
              idempotencyKey,
              evidence,
              actions: readActions(body.actions),
            }),
          };
        }
        if (body.command === "confirm_milestone") {
          return {
            kind: "confirm_milestone" as const,
            result: await service.confirmMilestone({
              scope: context.scope,
              projectId: requiredText(body.projectId, "projectId"),
              milestoneId: requiredText(body.milestoneId, "milestoneId"),
              expectedProjectVersion: requiredInteger(body.expectedProjectVersion),
              idempotencyKey,
              evidence,
              // Optional World-declared semantic completion key; validated
              // generically by the command service, never interpreted by the engine.
              semanticEventKey: body.semanticEventKey === undefined
                ? undefined
                : requiredText(body.semanticEventKey, "semanticEventKey"),
            }),
          };
        }
        throw new ProjectFinanceCommandError("COMMAND_INVALID", "Unsupported project command.");
      },
    );
    // The response is constructed only after the outer COMMIT succeeded.
    const meta = {
      worldId: context.scope.worldId,
      worldlineId: context.scope.worldlineId,
      projectionVersion: 1,
      ...storyContinuationMeta(continuation),
    };
    if (executed.kind === "change_stage") {
      const result = executed.result;
      return Response.json({
        ok: true as const,
        data: {
          status: result.status,
          commandGroupId: result.commandGroupId,
          eventKind: result.eventKind,
          projectId: result.projectId,
          stage: result.stage,
          projectVersion: result.projectVersion,
          ...(result.worldCursor ? { worldCursor: result.worldCursor } : {}),
        },
        meta,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (executed.kind === "apply_project_finance") {
      const result = executed.result;
      return Response.json({
        ok: true as const,
        data: {
          status: result.status,
          commandGroupId: result.commandGroupId,
          ...(result.worldCursor ? { worldCursor: result.worldCursor } : {}),
        },
        meta,
      }, { headers: { "Cache-Control": "no-store" } });
    }
    const result = executed.result;
    return Response.json({
      ok: true as const,
      data: {
        status: result.status,
        commandGroupId: result.commandGroupId,
        eventKind: result.eventKind,
        projectId: result.projectId,
        milestoneId: result.milestoneId,
        projectVersion: result.projectVersion,
        ...(result.worldCursor ? { worldCursor: result.worldCursor } : {}),
        ...(result.semanticEventKey ? { semanticEventKey: result.semanticEventKey } : {}),
        ...(result.requestPolicy ? { requestPolicy: result.requestPolicy } : {}),
      },
      meta,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return projectFinanceRouteError(error);
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Command body must be JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Command body must be an object.");
  }
  return body as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MAX_TEXT) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", `${field} is invalid.`);
  }
  return value.trim();
}

function requiredInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Expected version is invalid.");
  }
  return value;
}

function readActions(value: unknown): ProjectFinanceAction[] {
  if (!Array.isArray(value)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "actions must be a list.");
  }
  return value.map((action) => {
    if (action === null || typeof action !== "object" || Array.isArray(action)) {
      throw new ProjectFinanceCommandError("COMMAND_INVALID", "action is invalid.");
    }
    const record = action as Record<string, unknown>;
    if (record.command === "change_stage") {
      return {
        command: "change_stage" as const,
        projectId: requiredText(record.projectId, "projectId"),
        stage: readStage(requiredText(record.stage, "stage")),
        expectedProjectVersion: requiredInteger(record.expectedProjectVersion),
      };
    }
    if (record.command === "confirm_milestone") {
      return {
        command: "confirm_milestone" as const,
        projectId: requiredText(record.projectId, "projectId"),
        milestoneId: requiredText(record.milestoneId, "milestoneId"),
        expectedProjectVersion: requiredInteger(record.expectedProjectVersion),
      };
    }
    if (record.command === "record_expense") {
      return {
        command: "record_expense" as const,
        accountId: optionalText(record.accountId),
        amountMinor: positiveInteger(record.amountMinor),
        category: requiredText(record.category, "category"),
        memo: requiredText(record.memo, "memo"),
        projectId: optionalText(record.projectId),
        occurredAt: requiredText(record.occurredAt, "occurredAt"),
        expectedBalanceMinor: nonNegativeInteger(record.expectedBalanceMinor),
      };
    }
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "action is invalid.");
  });
}

function readStage(value: string): ProjectStage {
  if (!(PROJECT_STAGES as readonly string[]).includes(value)) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "stage is invalid.");
  }
  return value as ProjectStage;
}

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, "optional");
}

function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "amountMinor is invalid.");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "expectedBalanceMinor is invalid.");
  }
  return value;
}
