import { existsSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const postgresRoot = process.env.REALM_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const dataDirectory = resolve(projectRoot, ".local/postgres/data");
const logPath = resolve(projectRoot, ".local/postgres/postgres.log");
const socketDirectory = "/tmp/realm-pg";
const host = "127.0.0.1";
const port = "55432";
const database = "realm_dev";
const action = process.argv[2] ?? "status";

function executable(name) {
  const path = resolve(postgresRoot, name);
  if (!existsSync(path)) {
    throw new Error(
      `Local PostgreSQL executable not found: ${path}. Install postgresql@17 locally or set REALM_POSTGRES_BIN.`,
    );
  }
  return path;
}

function run(name, args, options = {}) {
  const result = spawnSync(executable(name), args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (!options.allowFailure && result.status !== 0) {
    const detail = options.capture
      ? [result.stderr, result.stdout].filter(Boolean).join("\n").trim()
      : "";
    throw new Error(`${name} failed${detail ? `: ${detail}` : "."}`);
  }
  return result;
}

function controlStatus() {
  return run("pg_ctl", ["-D", dataDirectory, "status"], {
    allowFailure: true,
    capture: true,
  });
}

function readiness() {
  return run(
    "pg_isready",
    ["-h", host, "-p", port, "-d", database],
    { allowFailure: true, capture: true },
  );
}

function initialize() {
  if (existsSync(resolve(dataDirectory, "PG_VERSION"))) return;
  mkdirSync(resolve(projectRoot, ".local/postgres"), { recursive: true });
  run("initdb", [
    "-D",
    dataDirectory,
    "--encoding=UTF8",
    "--locale=C",
    "--auth-local=trust",
    "--auth-host=trust",
  ]);
}

function ensureDatabase() {
  const lookup = run(
    "psql",
    [
      "-h",
      host,
      "-p",
      port,
      "-d",
      "postgres",
      "-tAc",
      `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
    ],
    { capture: true },
  );
  if (lookup.stdout.trim() === "1") return;
  run("createdb", ["-h", host, "-p", port, database]);
}

switch (action) {
  case "start": {
    initialize();
    mkdirSync(socketDirectory, { recursive: true });
    if (controlStatus().status !== 0) {
      if (readiness().status === 0) {
        throw new Error(
          `${host}:${port} is already used by a PostgreSQL server outside this project cluster.`,
        );
      }
      run("pg_ctl", [
        "-D",
        dataDirectory,
        "-l",
        logPath,
        "-o",
        `-h ${host} -p ${port} -k ${socketDirectory}`,
        "-w",
        "start",
      ]);
    }
    ensureDatabase();
    if (readiness().status !== 0) {
      throw new Error("Realm PostgreSQL started but did not become ready.");
    }
    console.log(`Realm PostgreSQL is local-only at ${host}:${port}/${database}.`);
    break;
  }
  case "stop": {
    if (controlStatus().status === 0) {
      run("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"]);
    }
    console.log("Realm PostgreSQL is stopped.");
    break;
  }
  case "status": {
    const controlled = controlStatus();
    const ready = readiness();
    if (controlled.status === 0 && ready.status === 0) {
      process.stdout.write(controlled.stdout);
      process.stdout.write(ready.stdout);
    } else {
      const detail = [controlled.stderr, ready.stdout, ready.stderr]
        .filter(Boolean)
        .join("\n")
        .trim();
      console.error(
        `Realm PostgreSQL is not ready${detail ? `:\n${detail}` : "."}`,
      );
      process.exitCode = 1;
    }
    break;
  }
  default:
    throw new Error("Usage: node scripts/local-postgres.mjs start|stop|status");
}
