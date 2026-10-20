/** Stable PostgreSQL event projection validation shared by archive and witness codecs. */
import type { RealmRuntimeSaveEventV1, RealmRuntimeSaveRestorableEvent, RealmRuntimeSaveRestorableEventKind } from "./realm-runtime-save.ts";
import { RealmRuntimeSaveError } from "./runtime-save-primitives.ts";
import { isPlainObject, isJsonValue, assertExactKeys, requireField, requireIdentity, requireInteger } from "./runtime-save-validation.ts";

// Mirrors the events.event_kind CHECK constraint (migration 0062): server
// command evidence events (project/finance) are restorable committed facts.
const RESTORABLE_EVENT_KINDS: ReadonlySet<string> = new Set([
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

/**
 * Validate the PostgreSQL event projection before any restore transaction is
 * opened. This keeps foreign-key identifiers from the source archive as data,
 * never as target SQL identifiers, and rejects old/minimal fixtures that do
 * not contain enough information for a faithful event-row restore.
 */
export function normalizeRealmRuntimeSaveEventForRestore(
  event: RealmRuntimeSaveEventV1,
  index = 0,
): RealmRuntimeSaveRestorableEvent {
  if (!RESTORABLE_EVENT_KINDS.has(event.kind)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} kind is not restorable`);
  }
  if (event.recordVersion <= 0) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} recordVersion must be > 0 for restore`);
  }
  if (!isPlainObject(event.payload)) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} payload projection is invalid`);
  }
  assertExactKeys(
    event.payload,
    [
      "content",
      "speakerName",
      "actorParticipantId",
      "sceneId",
      "visibilityPolicyId",
      "worldTick",
      "worldOrdinal",
      "calendarId",
      "displayTime",
      "eventPayload",
    ],
    `record.events[${index}].payload`,
  );
  const content = requireField(event.payload, "content", `record.events[${index}].payload`);
  const speakerName = requireField(event.payload, "speakerName", `record.events[${index}].payload`);
  const actorParticipantId = requireField(event.payload, "actorParticipantId", `record.events[${index}].payload`);
  const sceneId = requireField(event.payload, "sceneId", `record.events[${index}].payload`);
  const visibilityPolicyId = requireField(event.payload, "visibilityPolicyId", `record.events[${index}].payload`);
  const worldTick = requireField(event.payload, "worldTick", `record.events[${index}].payload`);
  const worldOrdinal = requireField(event.payload, "worldOrdinal", `record.events[${index}].payload`);
  const calendarId = requireField(event.payload, "calendarId", `record.events[${index}].payload`);
  const displayTime = requireField(event.payload, "displayTime", `record.events[${index}].payload`);
  const eventPayload = requireField(event.payload, "eventPayload", `record.events[${index}].payload`);
  if (
    typeof content !== "string"
    || typeof speakerName !== "string"
    || (actorParticipantId !== null && typeof actorParticipantId !== "string")
    || typeof calendarId !== "string"
    || typeof displayTime !== "string"
    || typeof sceneId !== "string"
    || typeof visibilityPolicyId !== "string"
    || !isPlainObject(eventPayload)
    || !isJsonValue(eventPayload)
  ) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} payload fields are invalid`);
  }
  if (!calendarId.trim()) {
    throw new RealmRuntimeSaveError("INVALID_SAVE", `runtime event ${index} calendarId is empty`);
  }
  return {
    eventId: event.eventId,
    recordVersion: event.recordVersion,
    ordinal: event.ordinal,
    kind: event.kind as RealmRuntimeSaveRestorableEventKind,
    content,
    speakerName,
    sourceActorParticipantId: actorParticipantId,
    sourceSceneId: requireIdentity(sceneId, `record.events[${index}].payload.sceneId`),
    sourceVisibilityPolicyId: requireIdentity(
      visibilityPolicyId,
      `record.events[${index}].payload.visibilityPolicyId`,
    ),
    worldTick: requireInteger(worldTick, `record.events[${index}].payload.worldTick`, 0),
    worldOrdinal: requireInteger(worldOrdinal, `record.events[${index}].payload.worldOrdinal`, 0),
    calendarId: calendarId.trim(),
    displayTime,
    eventPayload,
  };
}
