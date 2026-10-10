import assert from "node:assert/strict";
import test from "node:test";
import {
  createDurableWorkerHost,
  type DurableWorkerHostHooks,
} from "../modules/application/durable-worker-host.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeHooks {
  hooks: DurableWorkerHostHooks;
  state: {
    acquired: number;
    released: number;
    closed: number;
    healthChecks: number;
    started: number;
    cycles: number;
  };
  logs: string[];
  /** Test-controlled cycle behavior; defaults to an idle cycle. */
  cycle: () => Promise<boolean>;
}

function fakeHost(options: {
  idleMinMs?: number;
  idleMaxMs?: number;
  cycle?: () => Promise<boolean>;
  health?: () => Promise<void>;
  acquire?: () => Promise<() => Promise<void>>;
  onStart?: () => Promise<void>;
}): FakeHooks & { host: ReturnType<typeof createDurableWorkerHost> } {
  const state = {
    acquired: 0,
    released: 0,
    closed: 0,
    healthChecks: 0,
    started: 0,
    cycles: 0,
  };
  const logs: string[] = [];
  const fake: FakeHooks = {
    state,
    logs,
    cycle: options.cycle ?? (async () => false),
    hooks: {
      acquireLock: options.acquire ?? (async () => {
        state.acquired += 1;
        return async () => {
          state.released += 1;
        };
      }),
      checkHealth: options.health ?? (async () => {
        state.healthChecks += 1;
      }),
      ...(options.onStart
        ? {
          onStart: async () => {
            state.started += 1;
            await options.onStart!();
          },
        }
        : {}),
      runCycle: async () => {
        state.cycles += 1;
        return fake.cycle();
      },
      close: async () => {
        state.closed += 1;
      },
      alreadyStartedError: () => new Error("host already started"),
    },
  };
  const host = createDurableWorkerHost({
    idleMinMs: options.idleMinMs ?? 10,
    idleMaxMs: options.idleMaxMs ?? 40,
    logger: (line) => logs.push(line),
    hooks: fake.hooks,
  });
  return { host, ...fake };
}

test("stop wakes the idle backoff sleeper and releases the lock exactly once", async () => {
  const { host, state } = fakeHost({ idleMinMs: 60_000, idleMaxMs: 60_000 });
  const started = host.start();
  while (state.cycles < 1) await sleep(5);
  const stopBegin = Date.now();
  await host.stop();
  await started;
  const elapsed = Date.now() - stopBegin;
  assert.ok(
    elapsed < 5_000,
    `stop must wake the idle sleeper immediately, took ${elapsed}ms`,
  );
  assert.equal(state.acquired, 1);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
});

test("repeated start throws the runtime supplied error; repeated stop is idempotent", async () => {
  const { host, state } = fakeHost({});
  const started = host.start();
  await assert.rejects(host.start(), /host already started/);
  // stop is memoized: concurrent and sequential stops share one cleanup.
  await Promise.all([host.stop(), host.stop()]);
  await host.stop();
  await started;
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
});

test("stop before start resolves without acquiring a lock", async () => {
  const { host, state } = fakeHost({});
  await host.stop();
  await host.stop();
  assert.equal(state.acquired, 0);
  assert.equal(state.closed, 1);
});

test("stop before start shuts the host down: a later start fails closed", async () => {
  const { host, state } = fakeHost({});
  await host.stop();
  await assert.rejects(host.start(), /shut down/);
  await assert.rejects(host.start(), /shut down/);
  assert.equal(state.acquired, 0);
  assert.equal(state.released, 0);
  assert.equal(state.closed, 1);
});

test("stop racing a deferred acquireLock releases the late handle exactly once", async () => {
  let resolveAcquire: ((release: () => Promise<void>) => void) | undefined;
  const { host, state } = fakeHost({
    acquire: () =>
      new Promise<() => Promise<void>>((resolve) => {
        state.acquired += 1;
        resolveAcquire = resolve;
      }),
  });
  const started = host.start();
  // stop() while acquireLock is still pending: resources close immediately,
  // no release handle exists yet.
  await host.stop();
  assert.equal(state.closed, 1);
  assert.equal(state.released, 0);
  // The deferred lock resolves after the shutdown: the host must release it
  // at once instead of leaking the advisory lock.
  resolveAcquire!(async () => {
    state.released += 1;
  });
  await started;
  assert.equal(state.acquired, 1);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
  // The host stays shut down afterwards.
  await assert.rejects(host.start(), /already started/);
});

test("a cycle failure is contained, logged as a bounded code and the loop continues", async () => {
  const outage = Object.assign(new Error("connection dropped"), { code: "ECONNRESET" });
  let failures = 0;
  const { host, state, logs } = fakeHost({
    cycle: async () => {
      if (failures < 3) {
        failures += 1;
        throw outage;
      }
      return false;
    },
  });
  const started = host.start();
  while (state.cycles < 6) await sleep(5);
  await host.stop();
  await started;
  assert.ok(state.cycles >= 6, "the loop must survive cycle failures");
  assert.deepEqual(
    logs.filter((line) => line.startsWith("cycle error=")),
    ["cycle error=ECONNRESET", "cycle error=ECONNRESET", "cycle error=ECONNRESET"],
  );
});

test("health failure releases the advisory lock and runtime resources", async () => {
  const { host, state } = fakeHost({
    health: async () => {
      throw new Error("schema unavailable");
    },
  });
  await assert.rejects(host.start(), /schema unavailable/);
  assert.equal(state.acquired, 1);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
  // stop after a failed start stays idempotent and does not release twice.
  await host.stop();
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
});

test("lock contention failure releases runtime resources without a release handle", async () => {
  const { host, state } = fakeHost({
    acquire: async () => {
      throw new Error("another instance holds the advisory lock");
    },
  });
  await assert.rejects(host.start(), /another instance holds the advisory lock/);
  assert.equal(state.released, 0);
  assert.equal(state.closed, 1);
});

test("startup work failure after health releases the advisory lock", async () => {
  const { host, state } = fakeHost({
    onStart: async () => {
      throw new Error("stale recovery failed");
    },
  });
  await assert.rejects(host.start(), /stale recovery failed/);
  assert.equal(state.healthChecks, 1);
  assert.equal(state.released, 1);
  assert.equal(state.closed, 1);
});

test("host logs never leak raw error messages or secret-like values", async () => {
  const secretLike = "postgresql://worker:s3cr3t-token@db.internal:5432/realm?api_key=abc123";
  const leaking = Object.assign(
    new Error(`FATAL: password authentication failed for ${secretLike}`),
    { code: "28P01" },
  );
  const { host, logs } = fakeHost({
    cycle: async () => {
      throw leaking;
    },
  });
  const started = host.start();
  while (logs.length < 2) await sleep(5);
  await host.stop();
  await started;
  const joined = logs.join("\n");
  assert.equal(joined.includes("s3cr3t-token"), false);
  assert.equal(joined.includes("db.internal"), false);
  assert.equal(joined.includes("api_key"), false);
  assert.equal(joined.includes("password authentication"), false);
  assert.ok(logs.every((line) => line === "cycle error=28P01"));

  const codeless = new Error(`bearer s3cr3t-token expired at db.internal`);
  const second = fakeHost({
    cycle: async () => {
      throw codeless;
    },
  });
  const secondStarted = second.host.start();
  while (second.logs.length < 1) await sleep(5);
  await second.host.stop();
  await secondStarted;
  assert.deepEqual(second.logs, ["cycle error=unknown"]);
});

test("host degrades secret-like or unbounded error.code values to unknown", async () => {
  const hostileCodes = [
    "postgresql://worker:s3cr3t-token@db.internal:5432/realm?api_key=abc123",
    "28P01 password authentication failed",
    "ECONNRESET\npostgresql://worker:s3cr3t-token@db.internal",
    "Bearer s3cr3t-token",
    `x`.repeat(81),
  ];
  for (const code of hostileCodes) {
    const leaking = Object.assign(new Error("cycle failed"), { code });
    const { host, logs } = fakeHost({
      cycle: async () => {
        throw leaking;
      },
    });
    const started = host.start();
    while (logs.length < 1) await sleep(5);
    await host.stop();
    await started;
    assert.deepEqual(logs, ["cycle error=unknown"], `code must not reach logs: ${code}`);
    const joined = logs.join("\n");
    assert.equal(joined.includes("s3cr3t-token"), false);
    assert.equal(joined.includes("db.internal"), false);
  }
});

test("idle backoff doubles up to the cap and a productive cycle resets it", async () => {
  const stamps: number[] = [];
  const outcomes = [false, false, false, true, false, false];
  let index = 0;
  const { host, state } = fakeHost({
    idleMinMs: 20,
    idleMaxMs: 50,
    cycle: async () => {
      stamps.push(Date.now());
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      return outcome;
    },
  });
  const started = host.start();
  while (state.cycles < outcomes.length + 1) await sleep(5);
  await host.stop();
  await started;
  const gaps = stamps.slice(1).map((stamp, i) => stamp - stamps[i]!);
  // 20 → 40 → 50 (cap) → reset after work → 20 → 40.
  assert.ok(gaps[0]! >= 15, `first idle gap ${gaps[0]} should honor idleMinMs=20`);
  assert.ok(gaps[1]! >= 30, `second idle gap ${gaps[1]} should roughly double`);
  assert.ok(gaps[2]! >= 40, `third idle gap ${gaps[2]} should approach the cap`);
  assert.ok(
    gaps.every((gap) => gap <= 200),
    `idle backoff must stay bounded by idleMaxMs=50 (plus scheduling slack): ${gaps}`,
  );
  assert.ok(
    gaps[3]! < gaps[2]!,
    `a productive cycle must reset the backoff (gap after work=${gaps[3]}, before=${gaps[2]})`,
  );
  assert.ok(gaps[4]! >= 15, `backoff restarts from idleMinMs after the reset`);
});
