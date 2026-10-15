import { GENESIS_CREATION_REQUEST_ID } from "../modules/application/world-genesis-contract.ts";

const KEY = "realm.genesis.pending-request.v1";
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
function browserStorage(): PendingStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
/** Only an opaque request ID is stored, never drafts, prompts, settings or tokens. */
export function readPendingGenesisRequest(storage = browserStorage()): string | null {
  try {
    const id = storage?.getItem(KEY);
    return typeof id === "string" && GENESIS_CREATION_REQUEST_ID.test(id) ? id : null;
  } catch { return null; }
}
export function savePendingGenesisRequest(id: string, storage = browserStorage()): void {
  if (!GENESIS_CREATION_REQUEST_ID.test(id)) return;
  try { storage?.setItem(KEY, id); } catch { /* Storage unavailable: in-memory retry still works. */ }
}
export function clearPendingGenesisRequest(id: string, storage = browserStorage()): void {
  try { if (storage?.getItem(KEY) === id) storage.removeItem(KEY); } catch { /* Best effort. */ }
}
