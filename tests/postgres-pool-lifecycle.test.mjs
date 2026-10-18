import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;

test("scratch pool shutdown waits for actual client end before fixture DROP", {
  skip: !connectionString || !process.env.REALM_SCRATCH_POSTGRES_CONTAINER,
  timeout: 15_000,
}, async () => {
  const url = new URL(connectionString);
  assert.ok(["127.0.0.1", "localhost", "::1"].includes(url.hostname));
  const pool = new pg.Pool({ connectionString, max: 2 });
  const client = await pool.connect();
  await client.query("SELECT 1");
  let ended = false;
  client.once("end", () => { ended = true; });
  const closed = once(client, "end");
  client.release();
  try {
    await pool.end();
    assert.equal(ended, true, "pool.end must not let fixture DROP race the client's real end event");
  } finally {
    await closed;
  }
});

test("scratch callback shutdown drains every unrefed owned client without changing callback return shape", {
  skip: !connectionString || !process.env.REALM_SCRATCH_POSTGRES_CONTAINER,
  timeout: 15_000,
}, async () => {
  const pool = new pg.Pool({ connectionString, max: 2, allowExitOnIdle: true });
  const clients = await Promise.all([pool.connect(), pool.connect()]);
  let ended = 0;
  let refCalls = 0;
  const closed = clients.map((client) => {
    const ref = client.ref.bind(client);
    client.ref = () => { refCalls += 1; ref(); };
    client.once("end", () => { ended += 1; });
    const done = once(client, "end");
    client.release();
    return done;
  });
  try {
    await new Promise((resolve, reject) => {
      const returned = pool.end((error) => error ? reject(error) : resolve());
      assert.equal(returned, undefined);
    });
    assert.equal(ended, clients.length);
    assert.equal(refCalls, clients.length, "retain only the already-owned unrefed clients during shutdown");
  } finally {
    await Promise.all(closed);
  }
});
