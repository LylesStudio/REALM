/**
 * World-declared semantic event keys (engine closure / E7).
 *
 * A semantic event key is World/content vocabulary (for example a
 * World-declared completion signal such as `concert.completed`) carried by a
 * generic formal engine event (project.milestone.confirmed payload). The
 * engine validates shape and authorization but never interprets the
 * vocabulary. Shape validation alone is NOT authorization: a key may only be
 * emitted when the installed World declares it (`worlds.settings.declaredEvents`,
 * materialized from the signed RealmWorld package at instantiation). A browser
 * or client cannot forge authorization — declarations enter only through
 * engine-owned genesis/instantiation writes.
 */

/** Dotted lowercase segments; bounded; never an engine-owned event kind. */
export const SEMANTIC_EVENT_KEY_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)*$/;
export const SEMANTIC_EVENT_KEY_MAX_LENGTH = 120;
export const MAX_DECLARED_SEMANTIC_EVENTS = 64;

/** Engine-owned formal event kinds (migration 0062 events_kind_check). */
export const ENGINE_EVENT_KINDS: ReadonlySet<string> = new Set([
  "utterance.committed",
  "narration.committed",
  "action.transaction.committed",
  "system.correction.committed",
  "goal.transition.committed",
  "project.created",
  "project.stage.changed",
  "project.milestone.confirmed",
  "finance.budget.allocated",
  "finance.income.recorded",
  "finance.expense.recorded",
  "finance.adjustment.recorded",
]);

export function isSemanticEventKey(value: unknown): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && value.length <= SEMANTIC_EVENT_KEY_MAX_LENGTH
    && SEMANTIC_EVENT_KEY_PATTERN.test(value)
    && !ENGINE_EVENT_KINDS.has(value)
  );
}

/**
 * Parse a World declaration list. Returns null for a malformed declaration
 * (caller fails closed), a deduplicated list otherwise. Absent → [].
 */
export function parseDeclaredSemanticEvents(value: unknown): readonly string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_DECLARED_SEMANTIC_EVENTS) return null;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isSemanticEventKey(entry) || seen.has(entry)) return null;
    seen.add(entry);
  }
  return [...seen];
}

/**
 * Authorization read at command/restore time: the declared key set from a
 * worlds.settings JSON document. A malformed declaration authorizes nothing
 * (fail closed); the engine writes settings itself, so malformed content is
 * evidence of tampering, not a World vocabulary.
 */
export function declaredSemanticEventsFromWorldSettings(settings: unknown): ReadonlySet<string> {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    return new Set();
  }
  const parsed = parseDeclaredSemanticEvents(
    (settings as Readonly<Record<string, unknown>>).declaredEvents,
  );
  return new Set(parsed ?? []);
}
