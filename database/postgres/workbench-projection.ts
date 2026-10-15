import type { PoolClient } from "pg";
import {
  deriveBudgetUsage,
  type BudgetAllocation,
  type Project,
  type ProjectMilestone,
  type ProjectScope,
} from "../../modules/projects/public.ts";
import {
  deriveCashPosition,
  type CashPosition,
} from "../../modules/finance/public.ts";
import {
  ProjectFinanceReadError,
  WORKBENCH_PROJECTION_VERSION,
  type FinanceProjectSummaryRead,
  type FinanceSummaryRead,
  type ProjectDetailRead,
  type ProjectMilestoneCounts,
  type ProjectSummaryRead,
  type ReadCursor,
  type WorkbenchSnapshot,
  type ProjectFinanceReadProjection,
} from "../../modules/application/project-finance-read.ts";
import {
  createPostgresProjectRepository,
  type ProjectRepositoryRead,
} from "./project-repository.ts";
import {
  createPostgresFinanceRepository,
  type FinanceRepositoryRead,
} from "./finance-repository.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export function createPostgresWorkbenchProjection(
  database: WorkspaceDatabase,
): ProjectFinanceReadProjection {
  return {
    async loadWorkbench(scope) {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const projectRead = await createPostgresProjectRepository(client).read(scope);
          const financeRead = await createPostgresFinanceRepository(client).read(scope);
          const readCursor = await readWorldlineCursor(client, scope);
          return buildWorkbenchSnapshot(scope, projectRead, financeRead, readCursor);
        },
        { readOnly: true },
      );
    },

    async loadProject(scope, projectId) {
      const snapshot = await this.loadWorkbench(scope);
      return snapshot.projectDetails.get(projectId) ?? null;
    },

    async loadLedger(scope, query) {
      return withWorkspaceTransaction(
        database,
        scope.workspaceId,
        async (client) => {
          const page = await createPostgresFinanceRepository(client).readPage(scope, query);
          const readCursor = await readWorldlineCursor(client, scope);
          return { readCursor, page };
        },
        { readOnly: true },
      );
    },
  };
}

function buildWorkbenchSnapshot(
  scope: ProjectScope,
  projectRead: ProjectRepositoryRead,
  financeRead: FinanceRepositoryRead,
  readCursor: ReadCursor,
): WorkbenchSnapshot {
  const projects = projectRead.projects.map((project) => {
    const allocations = projectRead.allocations.filter(
      (allocation) => allocation.projectId === project.id,
    );
    const budgetUsage = deriveBudgetUsage(scope, project.id, allocations, financeRead.entries);
    const milestones = projectRead.milestones.filter(
      (milestone) => milestone.projectId === project.id,
    );
    const stories = projectRead.stories.filter(
      (story) => story.projectId === project.id,
    );
    return {
      ...project,
      budgetUsage,
      milestoneSummary: countMilestones(milestones),
      storyCount: stories.length,
      recordCount: stories.reduce((total, story) => total + story.records.length, 0),
    } satisfies ProjectSummaryRead;
  });

  const projectDetails = new Map<string, ProjectDetailRead>();
  for (const project of projects) {
    projectDetails.set(project.id, {
      ...project,
      milestones: projectRead.milestones.filter((milestone) => milestone.projectId === project.id),
      allocations: projectRead.allocations.filter((allocation) => allocation.projectId === project.id),
      stories: projectRead.stories.filter((story) => story.projectId === project.id),
    });
  }

  const activeStoryIds = new Set(
    projectRead.stories
      .filter((story) => story.status === "active")
      .map((story) => story.storyId),
  );
  const activeRecordCount = projectRead.stories.reduce(
    (total, story) => total + story.records.filter((record) => record.status === "active").length,
    0,
  );

  return {
    scope: { ...scope },
    readCursor,
    projectionVersion: WORKBENCH_PROJECTION_VERSION,
    projects,
    projectDetails,
    finance: buildFinanceSummary(projectRead.projects, projectRead.allocations, financeRead),
    activeStoryCount: activeStoryIds.size,
    activeRecordCount,
  };
}

function buildFinanceSummary(
  projects: readonly Project[],
  allocations: readonly BudgetAllocation[],
  financeRead: FinanceRepositoryRead,
): FinanceSummaryRead {
  const positionByAccount = financeRead.accounts.map((account) =>
    deriveCashPosition(
      account,
      financeRead.entries.filter((entry) => entry.accountId === account.id),
    )
  );
  const cash: CashPosition = {
    currency: "JPY",
    openingBalanceMinor: sum(positionByAccount.map((position) => position.openingBalanceMinor)),
    incomeMinor: sum(positionByAccount.map((position) => position.incomeMinor)),
    expenseMinor: sum(positionByAccount.map((position) => position.expenseMinor)),
    adjustmentMinor: sum(positionByAccount.map((position) => position.adjustmentMinor)),
    balanceMinor: sum(positionByAccount.map((position) => position.balanceMinor)),
    entryCount: sum(positionByAccount.map((position) => position.entryCount)),
  };

  const byProject: FinanceProjectSummaryRead[] = projects.map((project) => ({
    projectId: project.id,
    budgetUsage: deriveBudgetUsage(
      {
        workspaceId: project.workspaceId,
        worldId: project.worldId,
        worldlineId: project.worldlineId,
      },
      project.id,
      allocations.filter((allocation) => allocation.projectId === project.id),
      financeRead.entries,
    ),
  }));
  return {
    currency: "JPY",
    cash,
    accountCount: financeRead.accounts.length,
    byProject,
  };
}

function countMilestones(milestones: readonly ProjectMilestone[]): ProjectMilestoneCounts {
  const result = {
    planned: 0,
    active: 0,
    completed: 0,
    cancelled: 0,
  };
  for (const milestone of milestones) {
    result[milestone.status] += 1;
  }
  return result;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total)) {
      throw new ProjectFinanceReadError(
        "PROJECT_FINANCE_ROW_INVALID",
        "A derived finance amount exceeds the safe integer range.",
      );
    }
  }
  return total;
}

async function readWorldlineCursor(
  client: PoolClient,
  scope: ProjectScope,
): Promise<ReadCursor> {
  const result = await client.query<{ head_tick: string | number; head_ordinal: string | number }>(
    `SELECT head_tick, head_ordinal
     FROM worldlines
     WHERE workspace_id = $1 AND world_id = $2 AND id = $3`,
    [scope.workspaceId, scope.worldId, scope.worldlineId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new ProjectFinanceReadError(
      "PROJECT_FINANCE_READ_FAILED",
      "The Workbench Worldline cursor could not be read.",
    );
  }
  const tick = safeCursorInteger(row.head_tick);
  const ordinal = safeCursorInteger(row.head_ordinal);
  return { tick, ordinal };
}

function safeCursorInteger(value: string | number): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Worldline cursor is invalid.");
  }
  return normalized;
}
