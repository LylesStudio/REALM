import { createHash } from "node:crypto";

import {
  deriveCashPosition,
  normalizeFinanceAccount,
  normalizeLedgerEntry,
  type FinanceAccount,
  type LedgerEntry,
} from "../finance/public.ts";
import type { ProjectScope } from "../projects/public.ts";

export class ProjectFinanceRuntimeSaveError extends Error {
  readonly code: "RUNTIME_SAVE_INVALID" | "IDEMPOTENCY_KEY_REUSE";

  constructor(code: "RUNTIME_SAVE_INVALID" | "IDEMPOTENCY_KEY_REUSE", message: string) {
    super(message);
    this.name = "ProjectFinanceRuntimeSaveError";
    this.code = code;
  }
}

export interface ProjectFinanceRuntimeMilestone {
  id: string;
  projectId: string;
  status: "planned" | "active" | "completed" | "cancelled";
  completionRecordId: string | null;
  completionEventId: string | null;
}

export interface ProjectFinanceRuntimeCommandGroup {
  id: string;
  idempotencyKey: string;
  requestFingerprint: string;
}

export interface ProjectFinanceRuntimeSnapshot {
  format: "realm-project-finance-save";
  formatVersion: 1;
  scope: { worldId: string; worldlineId: string };
  accounts: readonly FinanceAccount[];
  ledger: readonly LedgerEntry[];
  commandGroups: readonly ProjectFinanceRuntimeCommandGroup[];
  milestones: readonly ProjectFinanceRuntimeMilestone[];
}

export interface ProjectFinanceRuntimeState {
  accounts: FinanceAccount[];
  ledger: LedgerEntry[];
  commandGroups: ProjectFinanceRuntimeCommandGroup[];
  milestones: ProjectFinanceRuntimeMilestone[];
}

const MILESTONE_STATUSES = new Set(["planned", "active", "completed", "cancelled"]);

export function buildProjectFinanceRuntimeSnapshot(
  scope: ProjectScope,
  state: ProjectFinanceRuntimeState,
): ProjectFinanceRuntimeSnapshot {
  const snapshot: ProjectFinanceRuntimeSnapshot = {
    format: "realm-project-finance-save",
    formatVersion: 1,
    scope: { worldId: scope.worldId, worldlineId: scope.worldlineId },
    accounts: state.accounts.map((account) => normalizeFinanceAccount(account)),
    ledger: state.ledger.map((entry) => normalizeLedgerEntry(entry)),
    commandGroups: state.commandGroups.map((group) => ({ ...group })),
    milestones: state.milestones.map((milestone) => normalizeMilestone(milestone)),
  };
  assertNoClientBalance(snapshot);
  return snapshot;
}

export function applyProjectFinanceRuntimeSnapshot(
  scope: ProjectScope,
  current: ProjectFinanceRuntimeState,
  snapshot: ProjectFinanceRuntimeSnapshot,
): { status: "committed" | "replayed"; state: ProjectFinanceRuntimeState; balanceMinor: number } {
  if (snapshot.format !== "realm-project-finance-save" || snapshot.formatVersion !== 1) {
    throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "Project finance runtime save format is invalid.");
  }
  if (snapshot.scope.worldId !== scope.worldId || snapshot.scope.worldlineId !== scope.worldlineId) {
    throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "Project finance runtime save scope does not match.");
  }
  assertNoClientBalance(snapshot);
  const incomingGroups = snapshot.commandGroups.map((group) => ({ ...group }));
  for (const group of incomingGroups) {
    const existing = current.commandGroups.find((item) => item.idempotencyKey === group.idempotencyKey);
    if (existing && existing.requestFingerprint !== group.requestFingerprint) {
      throw new ProjectFinanceRuntimeSaveError(
        "IDEMPOTENCY_KEY_REUSE",
        "This idempotency key was already used for a different command.",
      );
    }
  }
  const replayed = incomingGroups.every((group) => current.commandGroups.some((item) => (
    item.idempotencyKey === group.idempotencyKey
    && item.requestFingerprint === group.requestFingerprint
  )));
  if (replayed && incomingGroups.length > 0) {
    return {
      status: "replayed",
      state: current,
      balanceMinor: balanceOf(scope, current),
    };
  }
  const ledgerIds = new Set(current.ledger.map((entry) => entry.id));
  const nextLedger = [...current.ledger];
  for (const entry of snapshot.ledger) {
    const normalized = normalizeLedgerEntry({ ...entry, ...scope });
    if (ledgerIds.has(normalized.id)) continue;
    ledgerIds.add(normalized.id);
    nextLedger.push(normalized);
  }
  const accountIds = new Set(current.accounts.map((account) => account.id));
  const nextAccounts = [...current.accounts];
  for (const account of snapshot.accounts) {
    const normalized = normalizeFinanceAccount({ ...account, ...scope });
    if (accountIds.has(normalized.id)) continue;
    accountIds.add(normalized.id);
    nextAccounts.push(normalized);
  }
  const groupKeys = new Set(current.commandGroups.map((group) => group.idempotencyKey));
  const nextGroups = [...current.commandGroups];
  for (const group of incomingGroups) {
    if (groupKeys.has(group.idempotencyKey)) continue;
    groupKeys.add(group.idempotencyKey);
    nextGroups.push(group);
  }
  const milestoneIds = new Set(current.milestones.map((milestone) => milestone.id));
  const nextMilestones = current.milestones.map((milestone) => ({ ...milestone }));
  for (const milestone of snapshot.milestones) {
    const normalized = normalizeMilestone(milestone);
    if ((normalized.completionRecordId === null) !== (normalized.completionEventId === null)) {
      throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "Milestone evidence must be stored together.");
    }
    const index = nextMilestones.findIndex((item) => item.id === normalized.id);
    if (index === -1) {
      milestoneIds.add(normalized.id);
      nextMilestones.push(normalized);
      continue;
    }
    const existing = nextMilestones[index]!;
    if (
      existing.completionRecordId !== normalized.completionRecordId
      || existing.completionEventId !== normalized.completionEventId
    ) {
      throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "Milestone evidence does not match the saved record.");
    }
  }
  const state = {
    accounts: nextAccounts,
    ledger: nextLedger,
    commandGroups: nextGroups,
    milestones: nextMilestones,
  };
  return { status: "committed", state, balanceMinor: balanceOf(scope, state) };
}

export function projectFinanceRuntimeSnapshotHash(snapshot: ProjectFinanceRuntimeSnapshot): string {
  return createHash("sha256").update(stable(snapshot)).digest("hex");
}

function balanceOf(scope: ProjectScope, state: ProjectFinanceRuntimeState): number {
  return state.accounts.reduce((total, account) => {
    const entries = state.ledger.filter((entry) => entry.accountId === account.id);
    return total + deriveCashPosition(normalizeFinanceAccount({ ...account, ...scope }), entries).balanceMinor;
  }, 0);
}

function normalizeMilestone(milestone: ProjectFinanceRuntimeMilestone): ProjectFinanceRuntimeMilestone {
  if (!MILESTONE_STATUSES.has(milestone.status)) {
    throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "Milestone status is invalid.");
  }
  return {
    id: milestone.id,
    projectId: milestone.projectId,
    status: milestone.status,
    completionRecordId: milestone.completionRecordId,
    completionEventId: milestone.completionEventId,
  };
}

function assertNoClientBalance(value: unknown): void {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) assertNoClientBalance(item);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(value, "balanceMinor")) {
      throw new ProjectFinanceRuntimeSaveError("RUNTIME_SAVE_INVALID", "A client balance cannot enter a runtime save.");
    }
    for (const item of Object.values(value)) assertNoClientBalance(item);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
