import {
  encodeLedgerCursor,
  type FinanceProjectSummaryRead,
  type FinanceSummaryRead,
  type LedgerPageRead,
  type ProjectDetailRead,
  type ProjectSummaryRead,
  type ReadCursor,
  type WorkbenchSnapshot,
} from "./project-finance-read.ts";

export const PROJECT_FINANCE_API_V1_VERSION = 1 as const;

export interface ProjectFinanceApiMeta {
  worldId: string;
  worldlineId: string;
  readCursor: ReadCursor;
  projectionVersion: typeof PROJECT_FINANCE_API_V1_VERSION;
}

export interface ProjectSummaryApi {
  id: string;
  kind: ProjectSummaryRead["kind"];
  status: ProjectSummaryRead["status"];
  stage: ProjectSummaryRead["stage"];
  title: string;
  currency: "JPY";
  version: number;
  deadline: string | null;
  budgetUsage: ProjectSummaryRead["budgetUsage"];
  milestoneSummary: ProjectSummaryRead["milestoneSummary"];
  storyCount: number;
  recordCount: number;
}

export interface ProjectDetailApi extends ProjectSummaryApi {
  milestones: readonly {
    id: string;
    projectId: string;
    sequence: number;
    title: string;
    status: string;
    dueOn: string | null;
    completionEventId: string | null;
  }[];
  allocations: readonly {
    id: string;
    projectId: string;
    category: string;
    amountMinor: number;
    currency: "JPY";
    version: number;
  }[];
  stories: readonly {
    id: string;
    projectId: string;
    storyId: string;
    linkKind: string;
    title: string;
    status: string;
    premise: string;
    records: readonly {
      id: string;
      title: string;
      status: string;
    }[];
  }[];
}

export interface FinanceSummaryApi {
  currency: "JPY";
  cash: FinanceSummaryRead["cash"];
  accountCount: number;
  byProject: readonly FinanceProjectSummaryRead[];
}

export interface LedgerEntryApi {
  id: string;
  kind: "income" | "expense" | "adjustment";
  direction: "income" | "expense";
  amountMinor: number;
  currency: "JPY";
  category: string;
  memo: string;
  projectId: string | null;
  recordId: string | null;
  occurredAt: string;
}

export interface WorkbenchApiData {
  projects: readonly ProjectSummaryApi[];
  finance: FinanceSummaryApi;
  activeStoryCount: number;
  activeRecordCount: number;
}

export interface WorkbenchApiEnvelope {
  ok: true;
  data: WorkbenchApiData;
  meta: ProjectFinanceApiMeta;
}

export interface ProjectListApiEnvelope {
  ok: true;
  data: { projects: readonly ProjectSummaryApi[] };
  meta: ProjectFinanceApiMeta;
}

export interface ProjectDetailApiEnvelope {
  ok: true;
  data: { project: ProjectDetailApi };
  meta: ProjectFinanceApiMeta;
}

export interface FinanceSummaryApiEnvelope {
  ok: true;
  data: FinanceSummaryApi;
  meta: ProjectFinanceApiMeta;
}

export interface LedgerPageApiEnvelope {
  ok: true;
  data: {
    entries: readonly LedgerEntryApi[];
    nextCursor: string | null;
    hasMore: boolean;
  };
  meta: ProjectFinanceApiMeta;
}

export interface ProjectFinanceApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export function toWorkbenchApi(snapshot: WorkbenchSnapshot): WorkbenchApiEnvelope {
  return {
    ok: true,
    data: {
      projects: snapshot.projects.map(toProjectSummaryApi),
      finance: toFinanceSummaryApi(snapshot.finance),
      activeStoryCount: snapshot.activeStoryCount,
      activeRecordCount: snapshot.activeRecordCount,
    },
    meta: metaFor(snapshot),
  };
}

export function toProjectListApi(snapshot: WorkbenchSnapshot): ProjectListApiEnvelope {
  return {
    ok: true,
    data: { projects: snapshot.projects.map(toProjectSummaryApi) },
    meta: metaFor(snapshot),
  };
}

export function toProjectDetailApi(
  snapshot: WorkbenchSnapshot,
  project: ProjectDetailRead,
): ProjectDetailApiEnvelope {
  return {
    ok: true,
    data: { project: mapProjectDetail(project) },
    meta: metaFor(snapshot),
  };
}

export function toFinanceSummaryEnvelope(snapshot: WorkbenchSnapshot): FinanceSummaryApiEnvelope {
  return {
    ok: true,
    data: toFinanceSummaryApi(snapshot.finance),
    meta: metaFor(snapshot),
  };
}

export function toFinanceSummaryApi(input: FinanceSummaryRead): FinanceSummaryApi {
  return {
    currency: input.currency,
    cash: { ...input.cash },
    accountCount: input.accountCount,
    byProject: input.byProject.map((item) => ({
      projectId: item.projectId,
      budgetUsage: { ...item.budgetUsage },
    })),
  };
}

export function toLedgerPageApi(
  snapshot: Pick<WorkbenchSnapshot, "scope" | "readCursor" | "projectionVersion">,
  page: LedgerPageRead,
): LedgerPageApiEnvelope {
  return {
    ok: true,
    data: {
      entries: page.entries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        direction: entry.direction,
        amountMinor: entry.amountMinor,
        currency: entry.currency,
        category: entry.category,
        memo: entry.memo,
        projectId: entry.projectId,
        recordId: entry.recordId,
        occurredAt: entry.occurredAt,
      })),
      nextCursor: page.nextCursor ? encodeLedgerCursor(page.nextCursor) : null,
      hasMore: page.hasMore,
    },
    meta: metaFor(snapshot),
  };
}

function toProjectSummaryApi(input: ProjectSummaryRead): ProjectSummaryApi {
  return {
    id: input.id,
    kind: input.kind,
    status: input.status,
    stage: input.stage,
    title: input.title,
    currency: input.currency,
    version: input.version,
    deadline: input.deadline,
    budgetUsage: { ...input.budgetUsage },
    milestoneSummary: { ...input.milestoneSummary },
    storyCount: input.storyCount,
    recordCount: input.recordCount,
  };
}

function mapProjectDetail(input: ProjectDetailRead): ProjectDetailApi {
  return {
    ...toProjectSummaryApi(input),
    milestones: input.milestones.map((milestone) => ({
      id: milestone.id,
      projectId: milestone.projectId,
      sequence: milestone.sequence,
      title: milestone.title,
      status: milestone.status,
      dueOn: milestone.dueOn,
      completionEventId: milestone.completionEventId,
    })),
    allocations: input.allocations.map((allocation) => ({
      id: allocation.id,
      projectId: allocation.projectId,
      category: allocation.category,
      amountMinor: allocation.amountMinor,
      currency: allocation.currency,
      version: allocation.version,
    })),
    stories: input.stories.map((story) => ({
      id: story.id,
      projectId: story.projectId,
      storyId: story.storyId,
      linkKind: story.linkKind,
      title: story.title,
      status: story.status,
      premise: story.premise,
      records: story.records.map((record) => ({ ...record })),
    })),
  };
}

function metaFor(input: Pick<WorkbenchSnapshot, "scope" | "readCursor" | "projectionVersion">): ProjectFinanceApiMeta {
  return {
    worldId: input.scope.worldId,
    worldlineId: input.scope.worldlineId,
    readCursor: { ...input.readCursor },
    projectionVersion: input.projectionVersion,
  };
}
