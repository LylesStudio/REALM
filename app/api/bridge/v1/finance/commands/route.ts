import {
  createProjectFinanceCommandService,
  ProjectFinanceCommandError,
  readRecordEvidence,
} from "../../../../../../modules/application/project-finance-command.ts";
import { ProjectFinanceError } from "../../../../../../modules/projects/public.ts";
import { createPostgresProjectFinanceCommandStore } from "../../../../../../database/postgres/project-finance-command-repository.ts";
import {
  authorizeProjectFinanceWrite,
  projectFinanceRouteError,
  resolveProjectFinanceContext,
} from "../../project-finance-context.ts";
import {
  runCommandWithStoryContinuation,
  storyContinuationMeta,
  type StoryContinuationOutcome,
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
    if (
      body.command !== "record_expense"
      && body.command !== "record_income"
      && body.command !== "record_adjustment"
      && body.command !== "allocate_budget"
      && body.command !== "create_obligation"
      && body.command !== "settle_obligation"
    ) {
      return projectFinanceRouteError(new ProjectFinanceCommandError(
        "COMMAND_INVALID",
        "Unsupported finance command.",
      ));
    }
    // F1b: one outer transaction carries the finance command store/service
    // AND the full Story continuation on the SAME client; cash/obligation
    // changes and every Story unlock commit once or roll back together.
    const { command: executed, continuation } = await runCommandWithStoryContinuation(
      context.database,
      context.scope,
      async (client) => {
        await authorizeProjectFinanceWrite(client, context);
        const service = createProjectFinanceCommandService({
          store: createPostgresProjectFinanceCommandStore(client),
        });
        if (body.command === "create_obligation") {
          return {
            kind: "create_obligation" as const,
            result: await service.createObligation({
              scope: context.scope,
              idempotencyKey,
              projectId: optionalText(body.projectId),
              kind: requiredKind(body.kind),
              principalMinor: requiredInteger(body.principalMinor),
              shareBps: body.shareBps === undefined || body.shareBps === null ? null : requiredInteger(body.shareBps),
              undeliveredCount: body.undeliveredCount === undefined || body.undeliveredCount === null
                ? 0
                : nonNegativeInteger(body.undeliveredCount),
            }),
          };
        }
        if (body.command === "settle_obligation") {
          return {
            kind: "settle_obligation" as const,
            result: await service.settleObligation({
              scope: context.scope,
              idempotencyKey,
              obligationId: requiredText(body.obligationId, "obligationId"),
              settlementKind: requiredSettlementKind(body.settlementKind),
              amountMinor: requiredInteger(body.amountMinor),
              expectedOutstandingMinor: nonNegativeInteger(body.expectedOutstandingMinor),
              expectedBalanceMinor: nonNegativeInteger(body.expectedBalanceMinor),
              accountId: optionalText(body.accountId),
              category: requiredText(body.category, "category"),
              memo: requiredText(body.memo, "memo"),
              occurredAt: requiredText(body.occurredAt, "occurredAt"),
            }),
          };
        }
        if (body.command === "allocate_budget") {
          return {
            kind: "allocate_budget" as const,
            result: await service.allocateBudget({
              scope: context.scope,
              projectId: requiredText(body.projectId, "projectId"),
              category: requiredText(body.category, "category"),
              amountMinor: requiredInteger(body.amountMinor),
              expectedVersion: requiredInteger(body.expectedVersion),
              idempotencyKey,
            }),
          };
        }
        const ledgerCommand = {
          scope: context.scope,
          accountId: optionalText(body.accountId),
          amountMinor: requiredInteger(body.amountMinor),
          category: requiredText(body.category, "category"),
          memo: requiredText(body.memo, "memo"),
          projectId: optionalText(body.projectId),
          recordId: optionalText(body.recordId),
          occurredAt: requiredText(body.occurredAt, "occurredAt"),
          idempotencyKey,
          expectedBalanceMinor: requiredInteger(body.expectedBalanceMinor),
          evidence,
        };
        return {
          kind: "ledger" as const,
          result: body.command === "record_income"
            ? await service.recordIncome(ledgerCommand)
            : body.command === "record_adjustment"
              ? await service.recordAdjustment({
                ...ledgerCommand,
                direction: body.direction === "income" ? "income" : "expense",
              })
              : await service.recordExpense(ledgerCommand),
        };
      },
    );
    // The response is constructed only after the outer COMMIT succeeded.
    if (executed.kind === "create_obligation") {
      const result = executed.result;
      return jsonData(context.scope, {
        status: result.status,
        commandGroupId: result.commandGroupId,
        obligationId: result.obligationId,
        kind: result.kind,
        outstandingMinor: result.outstandingMinor,
        undeliveredCount: result.undeliveredCount,
      }, continuation);
    }
    if (executed.kind === "settle_obligation") {
      const result = executed.result;
      return jsonData(context.scope, {
        status: result.status,
        commandGroupId: result.commandGroupId,
        obligationId: result.obligationId,
        kind: result.kind,
        outstandingMinor: result.outstandingMinor,
        undeliveredCount: result.undeliveredCount,
        cash: result.cash,
      }, continuation);
    }
    if (executed.kind === "allocate_budget") {
      const result = executed.result;
      return jsonData(context.scope, {
        status: result.status,
        commandGroupId: result.commandGroupId,
        eventKind: result.eventKind,
        projectId: result.projectId,
        category: result.category,
        amountMinor: result.amountMinor,
        version: result.version,
      }, continuation);
    }
    const result = executed.result;
    return jsonData(context.scope, {
      status: result.status,
      commandGroupId: result.commandGroupId,
      eventKind: result.eventKind,
      entry: {
        id: result.entry.id,
        amountMinor: result.entry.amountMinor,
        direction: result.entry.direction,
        category: result.entry.category,
        memo: result.entry.memo,
        projectId: result.entry.projectId,
        recordId: result.entry.recordId,
        occurredAt: result.entry.occurredAt,
      },
      cash: result.cash,
      ...(result.worldCursor ? { worldCursor: result.worldCursor } : {}),
    }, continuation);
  } catch (error) {
    return projectFinanceRouteError(error);
  }
}

function jsonData(
  scope: { worldId: string; worldlineId: string },
  data: unknown,
  continuation: StoryContinuationOutcome,
): Response {
  return Response.json({
    ok: true as const,
    data,
    meta: {
      worldId: scope.worldId,
      worldlineId: scope.worldlineId,
      projectionVersion: 1,
      ...storyContinuationMeta(continuation),
    },
  }, { headers: { "Cache-Control": "no-store" } });
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

function optionalText(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredText(value, "optional");
}

function requiredInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ProjectFinanceError("AMOUNT_INVALID", "Amount must be an integer.");
  }
  return value;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "Expected amount is invalid.");
  }
  return value;
}

function requiredKind(value: unknown): "loan" | "presale" | "revenue_share" {
  if (value !== "loan" && value !== "presale" && value !== "revenue_share") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "obligation kind is invalid.");
  }
  return value;
}

function requiredSettlementKind(value: unknown): "repayment" | "draw" | "share" {
  if (value !== "repayment" && value !== "draw" && value !== "share") {
    throw new ProjectFinanceCommandError("COMMAND_INVALID", "settlement kind is invalid.");
  }
  return value;
}
