/**
 * 分支树客户端类型与 normalize（对应 modules/application/branch-tree.ts）。
 * fail-closed：形状非法的负载整树视为不可用（调用方显示 error + retry）。
 */

export interface BranchTreeCursor {
  tick: number;
  ordinal: number;
}

export interface BranchTreeRecord {
  id: string;
  storyId: string;
  title: string;
  status: string;
  timelineKind: string;
  linkedRecordId: string | null;
  start: BranchTreeCursor;
  end: BranchTreeCursor | null;
  head: BranchTreeCursor;
}

export interface BranchTreeStory {
  id: string;
  title: string;
  status: string;
  start: BranchTreeCursor;
  end: BranchTreeCursor | null;
}

export interface BranchTreeWorldline {
  id: string;
  label: string;
  status: string;
  parentWorldlineId: string | null;
  fork: BranchTreeCursor | null;
  head: BranchTreeCursor;
  createdAt: string;
  stories: BranchTreeStory[];
  records: BranchTreeRecord[];
}

export interface BranchTreeMerge {
  id: string;
  sourceWorldlineA: string;
  sourceWorldlineB: string;
  mergedWorldlineId: string | null;
  status: string;
}

export interface BranchTree {
  world: { id: string; name: string; status: string };
  currentRecordId: string | null;
  currentWorldlineId: string | null;
  worldlines: BranchTreeWorldline[];
  merges: BranchTreeMerge[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cursor(value: unknown): BranchTreeCursor | null {
  if (!isRecord(value)) return null;
  const tick = Number(value.tick);
  const ordinal = Number(value.ordinal);
  if (
    !Number.isSafeInteger(tick) || tick < 0
    || !Number.isSafeInteger(ordinal) || ordinal < 0
  ) {
    return null;
  }
  return { tick, ordinal };
}

function nullableCursor(value: unknown): BranchTreeCursor | null {
  if (value === null || value === undefined) return null;
  return cursor(value);
}

/** 解析失败返回 null（fail-closed），绝不返回半截树。 */
export function normalizeBranchTree(payload: unknown): BranchTree | null {
  if (!isRecord(payload) || payload.ok !== true || !isRecord(payload.tree)) {
    return null;
  }
  const tree = payload.tree;
  if (!isRecord(tree.world) || !Array.isArray(tree.worldlines)) return null;
  const worldlines: BranchTreeWorldline[] = [];
  for (const raw of tree.worldlines) {
    if (!isRecord(raw)) return null;
    const head = cursor(raw.head);
    if (!head) return null;
    const fork = raw.parentWorldlineId === null ? null : nullableCursor(raw.fork);
    if (raw.parentWorldlineId !== null && raw.parentWorldlineId !== undefined && !fork) {
      return null;
    }
    const stories: BranchTreeStory[] = [];
    for (const rawStory of Array.isArray(raw.stories) ? raw.stories : []) {
      if (!isRecord(rawStory)) return null;
      const start = cursor(rawStory.start);
      if (!start) return null;
      stories.push({
        id: text(rawStory.id),
        title: text(rawStory.title),
        status: text(rawStory.status),
        start,
        end: nullableCursor(rawStory.end),
      });
    }
    const records: BranchTreeRecord[] = [];
    for (const rawRecord of Array.isArray(raw.records) ? raw.records : []) {
      if (!isRecord(rawRecord)) return null;
      const start = cursor(rawRecord.start);
      const recordHead = cursor(rawRecord.head);
      if (!start || !recordHead) return null;
      records.push({
        id: text(rawRecord.id),
        storyId: text(rawRecord.storyId),
        title: text(rawRecord.title),
        status: text(rawRecord.status),
        timelineKind: text(rawRecord.timelineKind),
        linkedRecordId: typeof rawRecord.linkedRecordId === "string"
          ? rawRecord.linkedRecordId
          : null,
        start,
        end: nullableCursor(rawRecord.end),
        head: recordHead,
      });
    }
    worldlines.push({
      id: text(raw.id),
      label: text(raw.label),
      status: text(raw.status),
      parentWorldlineId: typeof raw.parentWorldlineId === "string"
        ? raw.parentWorldlineId
        : null,
      fork,
      head,
      createdAt: text(raw.createdAt),
      stories,
      records,
    });
  }
  const merges: BranchTreeMerge[] = [];
  for (const raw of Array.isArray(tree.merges) ? tree.merges : []) {
    if (!isRecord(raw)) return null;
    merges.push({
      id: text(raw.id),
      sourceWorldlineA: text(raw.sourceWorldlineA),
      sourceWorldlineB: text(raw.sourceWorldlineB),
      mergedWorldlineId: typeof raw.mergedWorldlineId === "string"
        ? raw.mergedWorldlineId
        : null,
      status: text(raw.status),
    });
  }
  return {
    world: {
      id: text(tree.world.id),
      name: text(tree.world.name),
      status: text(tree.world.status),
    },
    currentRecordId: typeof tree.currentRecordId === "string"
      ? tree.currentRecordId
      : null,
    currentWorldlineId: typeof tree.currentWorldlineId === "string"
      ? tree.currentWorldlineId
      : null,
    worldlines,
    merges,
  };
}
