/**
 * Scratch-test-only pg shutdown fence. pg-pool 8 resolves end() after removing
 * clients from its bookkeeping, before their sockets emit the actual end event.
 * A fixture's subsequent DROP ... WITH (FORCE) can then race those clients and
 * surface an uncaught 57P01. Keep production pools unchanged and preserve errors.
 */
import { once } from "node:events";
import pg from "pg";

if (!process.env.REALM_SCRATCH_POSTGRES_CONTAINER) {
  throw new Error("The PostgreSQL shutdown fence is restricted to the scratch test child.");
}

const originalEnd = pg.Pool.prototype.end;
pg.Pool.prototype.end = function end(callback) {
  // Deliberately pinned to the installed pg-pool 8 ownership list. Fail closed
  // if a driver upgrade changes this shape, rather than silently skipping waits.
  if (!Array.isArray(this._clients)) {
    throw new Error("Unsupported pg-pool client ownership shape.");
  }
  const clientsEnded = this._clients.filter((client) => !client._ended).map((client) => {
    // Shared runtime pools unref idle sockets. Hold only their already-owned
    // clients during shutdown so Node cannot exit with an unresolved end wait.
    client.ref();
    return once(client, "end");
  });
  const finished = Promise.all([originalEnd.call(this), ...clientsEnded]).then(() => undefined);
  if (typeof callback === "function") {
    finished.then(() => callback(), (error) => callback(error));
    return;
  }
  return finished;
};
