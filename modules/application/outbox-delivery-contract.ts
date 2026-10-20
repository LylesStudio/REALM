import {
  RuntimeInvariantError,
  type ClaimOutboxInput,
  type JsonValue,
  type RuntimeOutboxMessage,
  type SettleOutboxInput,
} from "../runtime/public.ts";

export type RestoreDelivery = "disabled" | "record-events-v2";
export type RecordCommittedBody = Record<string, JsonValue> & {
  recordId: string;
  eventIds: string[];
};
export type OutboxDeliveryMessage<T extends JsonValue = JsonValue> =
  | (RuntimeOutboxMessage<T> & { origin?: "runtime-turn" })
  | (Omit<RuntimeOutboxMessage<RecordCommittedBody>, "turnId" | "topic"> & {
      origin: "record-events-restore-v1";
      turnId: null;
      topic: "record.events.committed";
    });
export interface OutboxDeliveryRepository<T extends JsonValue = JsonValue> {
  listOutboxMessages(input: { now: string; limit: number }): Promise<readonly OutboxDeliveryMessage<T>[]>;
  claimOutbox(input: ClaimOutboxInput): Promise<OutboxDeliveryMessage<T>>;
  settleOutbox(input: SettleOutboxInput): Promise<OutboxDeliveryMessage<T>>;
}
export type OutboxDeliveryBody =
  | { origin: "runtime-turn"; turnId: string; topic: string; payload: JsonValue }
  | { origin: "record-events-restore-v1"; turnId: null; topic: "record.events.committed"; payload: RecordCommittedBody };

export function normalizeRestoreDelivery(value: unknown): RestoreDelivery {
  if (value === undefined) return "disabled";
  if (value === "disabled" || value === "record-events-v2") return value;
  throw new RuntimeInvariantError("OUTBOX_RESTORE_DELIVERY_CONFIG_INVALID", "Restore delivery requires an exact supported mode.");
}

export class OutboxDeliveryMessageInvalid extends RuntimeInvariantError {
  constructor() {
    super("OUTBOX_DELIVERY_MESSAGE_INVALID", "The Outbox delivery message is invalid.");
  }
}

export function isRecordCommittedBody(value: unknown, recordId: string): value is RecordCommittedBody {
  return isJsonObject(value)
    && value.recordId === recordId
    && Array.isArray(value.eventIds)
    && value.eventIds.every((id) => typeof id === "string" && /^[A-Za-z0-9._:-]+$/.test(id));
}

/** A delivery projection only. It never grants authenticity or changes stored JSON. */
export function decodeOutboxDeliveryBody(input: {
  turnId: unknown;
  recordId: string;
  topic: string;
  restoreDeliveryKind: unknown;
  payload: unknown;
}, restoreDelivery: RestoreDelivery): OutboxDeliveryBody {
  const native = typeof input.turnId === "string" && input.turnId.trim().length > 0
    && (input.restoreDeliveryKind === null || input.restoreDeliveryKind === undefined);
  const restored = restoreDelivery === "record-events-v2" && input.turnId === null
    && input.restoreDeliveryKind === "record-events-v1" && input.topic === "record.events.committed";
  if (!native && !restored) throw new OutboxDeliveryMessageInvalid();
  const envelope = isJsonObject(input.payload) ? input.payload : null;
  const wrapped = envelope !== null && Object.hasOwn(envelope, "__realmRuntimePayload");
  if (!wrapped && !restored) throw new OutboxDeliveryMessageInvalid();
  const body = wrapped ? envelope.__realmRuntimePayload : input.payload;
  if (!isJsonValue(body)) throw new OutboxDeliveryMessageInvalid();
  if (input.topic === "record.events.committed" && !isRecordCommittedBody(body, input.recordId)) {
    throw new OutboxDeliveryMessageInvalid();
  }
  if (restored) {
    if (!isRecordCommittedBody(body, input.recordId)) throw new OutboxDeliveryMessageInvalid();
    return { origin: "record-events-restore-v1", turnId: null, topic: "record.events.committed", payload: structuredClone(body) };
  }
  // This check also narrows the original unknown without forging a turn identity.
  if (typeof input.turnId !== "string") throw new OutboxDeliveryMessageInvalid();
  return { origin: "runtime-turn", turnId: input.turnId, topic: input.topic, payload: structuredClone(body) };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value);
}
function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = Object.values(value).every((child) => isJsonValue(child, ancestors));
  ancestors.delete(value);
  return valid;
}
