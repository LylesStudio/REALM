import assert from "node:assert/strict";
import type pg from "pg";
import { committedFactRequestFingerprintFor } from "../../modules/application/committed-fact-command.ts";
import { projectFinanceCommandFingerprintFor, type ProjectScope } from "../../modules/projects/public.ts";

type Input = Record<string, unknown>;
type Result = { status: string };
export function recordCommittedCalls<T extends object>(target: T) {
  const calls: { method: string; input: Input; result: Result; invoke: (input: Input) => Promise<Result> }[] = [];
  const proxy = new Proxy(target, {
    get(object, property) {
      const method = Reflect.get(object, property);
      if (typeof method !== "function") return method;
      const invoke = async (input: Input): Promise<Result> => Reflect.apply(method, object, [input]);
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(method, object, args);
        if (result?.status === "committed") {
          calls.push({ method: String(property), input: structuredClone(args[0]) as Input, result: structuredClone(result), invoke });
        }
        return result;
      };
    },
  });
  return { proxy, calls };
}
type Recording = ReturnType<typeof recordCommittedCalls>;

// Full row images include receipts/provenance/hashes, holdings/revisions,
// balances, project versions, events, and both Record and worldline cursors.
const tables = ["projects", "project_milestones", "project_story_links", "budget_allocations", "finance_accounts", "ledger_entries", "project_finance_command_groups", "obligations", "obligation_settlements", "committed_fact_commands", "character_assets", "member_relationship_revisions", "performance_assessments", "events", "record_heads", "worldlines"];
export async function commandAuthoritySnapshot(owner: pg.Pool, scope: ProjectScope) {
  const rows: Record<string, unknown> = {};
  for (const table of tables) {
    rows[table] = (await owner.query(
      `SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows
       FROM ${table} t WHERE workspace_id = $1 AND ${table === "worldlines" ? "id" : "worldline_id"} = $2`,
      [scope.workspaceId, scope.worldlineId],
    )).rows[0].rows;
  }
  return rows;
}

function changes(method: string, input: Input): Input[] {
  const candidates: Input[] = [];
  for (const field of ["amountMinor", "expectedBalanceMinor", "expectedOutstandingMinor", "principalMinor", "shareBps", "undeliveredCount", "expectedVersion", "expectedProjectVersion", "delta", "expectedRevision", "quantity"]) {
    if (typeof input[field] === "number") candidates.push({ ...input, [field]: input[field] === -1 ? -2 : input[field] + 1 });
  }
  for (const field of ["characterInstanceId", "assetDefinitionId", "subjectEntityKey", "objectEntityKey", "sourceEventId", "accountId", "obligationId", "projectId", "milestoneId", "semanticEventKey"]) {
    if (typeof input[field] === "string") candidates.push({ ...input, [field]: field === "semanticEventKey" ? "other.completed" : `${input[field]}_changed` });
  }
  if (method === "grantInventory") candidates.push({ ...input, recordId: `${input.recordId}_changed` });
  if (input.evidence) {
    const evidence = input.evidence as Input;
    for (const field of ["recordId", "sceneId"]) candidates.push({ ...input, evidence: { ...evidence, [field]: `${evidence[field]}_changed` } });
    const cursor = evidence.expectedWorldCursor as Input;
    candidates.push({ ...input, evidence: { ...evidence, expectedWorldCursor: { ...cursor, worldOrdinal: Number(cursor.worldOrdinal) + 1 } } });
  }
  if (input.actions) {
    const actions = structuredClone(input.actions) as Input[];
    actions[0] = { ...actions[0], amountMinor: Number(actions[0]!.amountMinor) + 1 };
    candidates.push({ ...input, actions });
  }
  if (method === "recordPerformanceAssessment") candidates.push({ ...input, evidenceEventIds: (input.evidenceEventIds as string[]).slice(0, 1) });
  return candidates;
}

export async function proveNativeLegacyReplay(owner: pg.Pool, scope: ProjectScope, families: { table: string; service: Recording; store: Recording; fact: boolean }[]) {
  const originals: { table: string; key: string; manifest: unknown }[] = [];
  try {
    for (const family of families) {
      const rows = await owner.query(`SELECT idempotency_key, result_manifest FROM ${family.table} WHERE workspace_id = $1 AND worldline_id = $2`, [scope.workspaceId, scope.worldlineId]);
      for (const row of rows.rows) originals.push({ table: family.table, key: row.idempotency_key, manifest: row.result_manifest });
      await owner.query(`UPDATE ${family.table} SET result_manifest = result_manifest -> 'result' WHERE workspace_id = $1 AND worldline_id = $2`, [scope.workspaceId, scope.worldlineId]);
    }
    const before = await commandAuthoritySnapshot(owner, scope);
    for (const family of families) {
      assert.deepEqual(new Set(family.service.calls.map((call) => call.method)), new Set(family.fact
        ? ["grantInventory", "adjustInventory", "reviseRelationship", "recordPerformanceAssessment"]
        : ["recordExpense", "recordIncome", "recordAdjustment", "confirmMilestone", "changeStage", "allocateBudget", "createObligation", "settleObligation", "applyRecordProjectFinance"]), "all native command kinds must be exercised");
      if (!family.fact) assert.ok(family.store.calls.some((call) => call.method === "commitExpense" && call.input.recordId === null && call.input.evidence), "expense with only evidence.recordId is covered");
      for (const call of family.service.calls) {
        for (const candidate of changes(call.method, call.input)) {
          await assert.rejects(call.invoke(candidate), { code: "IDEMPOTENCY_KEY_REUSE" }, `${call.method} changed candidate must refuse`);
        }
        assert.deepEqual(await call.invoke(call.input), { ...call.result, status: "replayed" }, `${call.method} exact native service replay`);
      }
      for (const call of family.store.calls) {
        assert.deepEqual(await call.invoke(call.input), { ...call.result, status: "replayed" }, `${call.method} exact native transaction recheck`);
        const original = call.input.request as Input & { command: string };
        for (const [field, value] of Object.entries(original)) {
          const changed = typeof value === "number" ? value + 1 : typeof value === "string" ? `${value}_changed` : null;
          if (changed === null) continue;
          const request = { ...original, [field]: changed };
          const fingerprint = family.fact ? committedFactRequestFingerprintFor(scope, request) : projectFinanceCommandFingerprintFor(scope, request);
          const candidate = { ...call.input, ...(field in call.input ? { [field]: changed } : {}), request };
          await assert.rejects(call.invoke({ ...candidate, requestFingerprint: fingerprint }), { code: "IDEMPOTENCY_KEY_REUSE" });
          // Supplying the original persisted hash with a changed canonical
          // request must not bypass the transaction-local gate either.
          await assert.rejects(call.invoke(candidate), { code: "IDEMPOTENCY_KEY_REUSE" });
        }
      }
    }
    assert.deepEqual(await commandAuthoritySnapshot(owner, scope), before, "native exact replay and rejected candidates write zero authoritative rows");
    // Exercise the tagged legacy reader branch too; neither provenance form
    // authorizes weaker matching or mutates the persisted hash/receipt.
    for (const family of families) {
      await owner.query(`UPDATE ${family.table} SET result_manifest = jsonb_build_object('provenance', 'legacy-result-v1', 'result', result_manifest) WHERE workspace_id = $1 AND worldline_id = $2`, [scope.workspaceId, scope.worldlineId]);
    }
    const tagged = await commandAuthoritySnapshot(owner, scope);
    for (const family of families) {
      for (const call of family.service.calls) assert.deepEqual(await call.invoke(call.input), { ...call.result, status: "replayed" });
      for (const call of family.store.calls) assert.deepEqual(await call.invoke(call.input), { ...call.result, status: "replayed" });
    }
    assert.deepEqual(await commandAuthoritySnapshot(owner, scope), tagged);
  } finally {
    // Preserve the surrounding restore fixture's modern provenance; only its
    // two explicit legacy fixtures below this proof intentionally omit JSON.
    for (const row of originals) await owner.query(`UPDATE ${row.table} SET result_manifest = $4::jsonb WHERE workspace_id = $1 AND worldline_id = $2 AND idempotency_key = $3`, [scope.workspaceId, scope.worldlineId, row.key, JSON.stringify(row.manifest)]);
  }
}
