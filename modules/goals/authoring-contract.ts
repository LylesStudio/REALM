/** Client-safe draft admission; no providers, runtime authority or Node dependencies. */
export type RecordGoalChangePolicy = 'fixed' | 'evolving';
export interface RecordGoalDraft {
  title: string;
  description: string;
  successConditions: readonly string[];
  failureConditions: readonly string[];
  settlementConditions: readonly string[];
  changePolicy: RecordGoalChangePolicy;
  visible: boolean;
}
export interface RecordGoalManagementSnapshot {
  recordId: string;
  canCreate: boolean;
  head: { recordVersion: number; ordinal: number };
  goals: readonly {
    goalInstanceId: string; goalKey: string; definitionVersion: number; revision: number;
    draft: RecordGoalDraft; state: 'active' | 'completed' | 'failed' | 'settled';
    resolutionKind?: 'natural' | 'withdrawn' | 'superseded';
    progressSummary: string; completedCriteria: readonly number[];
    supersedesInstanceId: string | null; changeReason: string | null;
    canRevise: boolean; canWithdraw: boolean; assessmentState: string | null;
  }[];
}

export const MAX_RECORD_GOALS = 8;
export const RECORD_GOAL_DRAFT_SCHEMA_NOTE = 'array (0–8) of {"title": string <=160 chars, "description": string <=4000 chars, "successConditions": 1–8 nonempty strings <=2048 chars each, "failureConditions": 0–8 nonempty strings, "settlementConditions": 0–8 nonempty strings, "changePolicy": "fixed" | "evolving", "visible": boolean}. No identities, versions, progress, outcomes, scores or authority fields.';
export const RECORD_GOAL_DRAFTING_POLICY = 'Record Goals are persistent directions, not scene.objective or a one-turn player intent. Include 0–2 useful initial Goals when the concept supports them; no Goal is also valid. fixed locks the definition, not progress or success/failure; evolving authorizes later evidence-backed engine changes. Preserve the player\'s selected policy unless explicitly asked to change it. Use explicit observable success/failure/settlement criteria, not declarations of player consent or actions. Default visibility to true unless the player explicitly requests a hidden Goal. The player reviews the complete draft before creation.';
export class RecordGoalDraftError extends Error {
  readonly code: string;
  constructor(code: 'GOAL_DRAFT_INVALID' | 'GOAL_DRAFT_UNKNOWN_FIELD' | 'GOAL_CHANGE_POLICY_INVALID') {
    super('Record Goal draft is invalid.');
    this.name = 'RecordGoalDraftError';
    this.code = code;
  }
}
function invalid(code: ConstructorParameters<typeof RecordGoalDraftError>[0] = 'GOAL_DRAFT_INVALID'): never {
  throw new RecordGoalDraftError(code);
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) invalid();
  return value.trim();
}
function conditions(value: unknown, required: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > 8 || (required && !value.length)) invalid();
  const result = value.map(item => text(item, 2048));
  if (new Set(result).size !== result.length) invalid();
  return Object.freeze(result);
}
export function normalizeRecordGoalDraft(value: unknown): RecordGoalDraft {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>;
  const keys = ['title','description','successConditions','failureConditions','settlementConditions','changePolicy','visible'];
  if (Object.keys(row).some(key => !keys.includes(key))) invalid('GOAL_DRAFT_UNKNOWN_FIELD');
  if (row.changePolicy !== 'fixed' && row.changePolicy !== 'evolving') invalid('GOAL_CHANGE_POLICY_INVALID');
  if (typeof row.visible !== 'boolean') invalid();
  return Object.freeze({ title: text(row.title,160), description: text(row.description,4000),
    successConditions: conditions(row.successConditions,true),
    failureConditions: conditions(row.failureConditions === undefined ? [] : row.failureConditions,false),
    settlementConditions: conditions(row.settlementConditions === undefined ? [] : row.settlementConditions,false),
    changePolicy: row.changePolicy, visible: row.visible });
}
export function normalizeRecordGoalDrafts(value: unknown): readonly RecordGoalDraft[] {
  if (!Array.isArray(value) || value.length > MAX_RECORD_GOALS) invalid();
  const result = value.map(normalizeRecordGoalDraft);
  if (new Set(result.map(item => JSON.stringify(item))).size !== result.length) invalid();
  return Object.freeze(result);
}
