import type { QueryResultRow } from "pg";
import {
  normalizeBudgetAllocation,
  normalizeProject,
  normalizeProjectMilestone,
  type BudgetAllocation,
  type Project,
  type ProjectMilestone,
  type ProjectScope,
} from "../../modules/projects/public.ts";
import {
  ProjectFinanceReadError,
  type ProjectStoryLinkRead,
} from "../../modules/application/project-finance-read.ts";
import {
  withWorkspaceTransaction,
  type WorkspaceDatabase,
} from "./workspace-transaction.ts";

export interface ProjectRepositoryRead {
  projects: readonly Project[];
  milestones: readonly ProjectMilestone[];
  allocations: readonly BudgetAllocation[];
  stories: readonly ProjectStoryLinkRead[];
}

export interface ProjectRepository {
  read(scope: ProjectScope, projectId?: string | null): Promise<ProjectRepositoryRead>;
}

interface ProjectRow extends QueryResultRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  kind: string;
  status: string;
  stage: string;
  title: string;
  currency: string;
  version: string | number;
  deadline: string | null;
  owner_id: string | null;
}

interface MilestoneRow extends QueryResultRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  project_id: string;
  sequence: string | number;
  title: string;
  status: string;
  due_on: string | null;
  completion_event_id: string | null;
}

interface AllocationRow extends QueryResultRow {
  workspace_id: string;
  world_id: string;
  worldline_id: string;
  id: string;
  project_id: string;
  category: string;
  amount_minor: string | number;
  currency: string;
  version: string | number;
}

interface StoryLinkRow extends QueryResultRow {
  link_id: string;
  project_id: string;
  story_id: string;
  link_kind: string;
  story_title: string;
  story_status: string;
  story_premise: string;
  record_id: string | null;
  record_title: string | null;
  record_status: string | null;
}

export function createPostgresProjectRepository(
  database: WorkspaceDatabase,
): ProjectRepository {
  return {
    async read(scope, projectId = null) {
      const normalizedProjectId = projectId ?? null;
      try {
        return await withWorkspaceTransaction(
          database,
          scope.workspaceId,
          async (client) => {
            const projectsResult = await client.query<ProjectRow>(
              `SELECT workspace_id, world_id, worldline_id, id,
                      kind, status, stage, title, currency,
                      version, deadline::text AS deadline, owner_id
               FROM projects
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND worldline_id = $3
                 AND ($4::text IS NULL OR id = $4)
               ORDER BY created_at ASC, id ASC`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, normalizedProjectId],
            );
            const projects = projectsResult.rows.map((row) => normalizeProjectRow(row));
            const projectIds = projects.map((project) => project.id);
            if (projectIds.length === 0) {
              return { projects, milestones: [], allocations: [], stories: [] };
            }

            const milestonesResult = await client.query<MilestoneRow>(
              `SELECT workspace_id, world_id, worldline_id, id,
                      project_id, sequence, title, status,
                      due_on::text AS due_on, completion_event_id
               FROM project_milestones
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND worldline_id = $3
                 AND project_id = ANY($4::text[])
               ORDER BY project_id ASC, sequence ASC, id ASC`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, projectIds],
            );
            const milestones = milestonesResult.rows.map((row) => normalizeMilestoneRow(row));

            const allocationsResult = await client.query<AllocationRow>(
              `SELECT workspace_id, world_id, worldline_id, id,
                      project_id, category, amount_minor, currency, version
               FROM budget_allocations
               WHERE workspace_id = $1
                 AND world_id = $2
                 AND worldline_id = $3
                 AND project_id = ANY($4::text[])
               ORDER BY project_id ASC, category ASC, id ASC`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, projectIds],
            );
            const allocations = allocationsResult.rows.map((row) => normalizeAllocationRow(row));

            const storiesResult = await client.query<StoryLinkRow>(
              `SELECT link.id AS link_id,
                      link.project_id,
                      link.story_id,
                      link.link_kind,
                      story.title AS story_title,
                      story.status AS story_status,
                      story.premise AS story_premise,
                      record.id AS record_id,
                      record.title AS record_title,
                      record.status AS record_status
               FROM project_story_links AS link
               JOIN stories AS story
                 ON story.workspace_id = link.workspace_id
                AND story.world_id = link.world_id
                AND story.worldline_id = link.worldline_id
                AND story.id = link.story_id
               LEFT JOIN records AS record
                 ON record.workspace_id = story.workspace_id
                AND record.world_id = story.world_id
                AND record.worldline_id = story.worldline_id
                AND record.story_id = story.id
               WHERE link.workspace_id = $1
                 AND link.world_id = $2
                 AND link.worldline_id = $3
                 AND link.project_id = ANY($4::text[])
               ORDER BY link.project_id ASC, link.created_at ASC, link.id ASC,
                        record.created_at ASC NULLS LAST, record.id ASC NULLS LAST`,
              [scope.workspaceId, scope.worldId, scope.worldlineId, projectIds],
            );
            return {
              projects,
              milestones,
              allocations,
              stories: groupStoryLinks(storiesResult.rows),
            };
          },
          { readOnly: true },
        );
      } catch (error) {
        if (error instanceof ProjectFinanceReadError) throw error;
        throw new ProjectFinanceReadError(
          "PROJECT_FINANCE_READ_FAILED",
          "Project facts could not be read.",
        );
      }
    },
  };
}

function normalizeProjectRow(row: ProjectRow): Project {
  try {
    return normalizeProject({
      workspaceId: row.workspace_id,
      worldId: row.world_id,
      worldlineId: row.worldline_id,
      id: row.id,
      kind: row.kind,
      status: row.status,
      stage: row.stage,
      title: row.title,
      currency: row.currency,
      version: safeInteger(row.version, "project version"),
      deadline: row.deadline,
      ownerId: row.owner_id,
    });
  } catch {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Project row is invalid.");
  }
}

function normalizeMilestoneRow(row: MilestoneRow): ProjectMilestone {
  try {
    return normalizeProjectMilestone({
      workspaceId: row.workspace_id,
      worldId: row.world_id,
      worldlineId: row.worldline_id,
      id: row.id,
      projectId: row.project_id,
      sequence: safeInteger(row.sequence, "milestone sequence"),
      title: row.title,
      status: row.status,
      dueOn: row.due_on,
      completionEventId: row.completion_event_id,
    });
  } catch {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Project milestone row is invalid.");
  }
}

function normalizeAllocationRow(row: AllocationRow): BudgetAllocation {
  try {
    return normalizeBudgetAllocation({
      workspaceId: row.workspace_id,
      worldId: row.world_id,
      worldlineId: row.worldline_id,
      id: row.id,
      projectId: row.project_id,
      category: row.category,
      amountMinor: safeInteger(row.amount_minor, "allocation amount"),
      currency: row.currency,
      version: safeInteger(row.version, "allocation version"),
    });
  } catch {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Budget allocation row is invalid.");
  }
}

function groupStoryLinks(rows: readonly StoryLinkRow[]): readonly ProjectStoryLinkRead[] {
  const grouped = new Map<string, ProjectStoryLinkRead>();
  for (const row of rows) {
    let link = grouped.get(row.link_id);
    if (!link) {
      if (
        !row.link_id
        || !row.project_id
        || !row.story_id
        || !row.story_title
        || !row.story_status
        || row.story_premise === null
        || (row.link_kind !== "primary" && row.link_kind !== "related")
      ) {
        throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Project story link row is invalid.");
      }
      link = {
        id: row.link_id,
        projectId: row.project_id,
        storyId: row.story_id,
        linkKind: row.link_kind,
        title: row.story_title,
        status: row.story_status,
        premise: row.story_premise,
        records: [],
      };
      grouped.set(row.link_id, link);
    }
    if (row.record_id !== null) {
      if (row.record_title === null || row.record_status === null) {
        throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", "Project record link row is invalid.");
      }
      link.records = [
        ...link.records,
        {
          id: row.record_id,
          title: row.record_title,
          status: row.record_status,
        },
      ];
    }
  }
  return [...grouped.values()];
}

function safeInteger(value: string | number, label: string): number {
  const normalized = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new ProjectFinanceReadError("PROJECT_FINANCE_ROW_INVALID", `${label} is outside the safe integer range.`);
  }
  return normalized;
}
