# REALM

**A self-hosted single-user research preview for worlds that grow through conversation.**

REALM combines a recoverable turn runtime, persistent character memory, world knowledge, and a paper-and-ink web interface. It is designed for local or controlled self-hosting—not as a public SaaS or a ready-made multiplayer service.

> **Current status:** `v0.1.0` · self-hosted single-user / research preview

[![CI](https://github.com/Silver-Aurora/REALM/actions/workflows/ci.yml/badge.svg)](https://github.com/Silver-Aurora/REALM/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)

## What is here

- Recoverable Turn Core with a single writer per Record;
- append-only Events, visibility projections, idempotent commands, and local SSE updates;
- DM, Narrator, Character Runner, rules, dice, presence, and self-play orchestration;
- persistent character memory, Record-local knowledge, scene crystallization, and Canon review;
- PostgreSQL + pgvector as the authoritative store, with RLS and least-privilege runtime roles;
- World / Story / Record navigation, knowledge graph views, and `.realm` export/import;
- multi-provider model settings, structured-output repair, cancellation, and fail-closed model boundaries;
- a responsive rectangular paper-and-ink interface.

## What is not promised yet

The public snapshot is intentionally honest about its limits:

- no public account system or production-grade multi-tenant identity;
- no public multiplayer service, relay, TURN/WebRTC, or internet deployment recipe;
- no rate-limit, billing, retention, or deletion policy for a hosted service;
- model latency, quality, and cost depend on the provider configured by the operator;
- desktop bundles, Android device validation, and cross-device LAN validation are outside this first web-focused snapshot.

Run REALM locally or on a network you control. Do not expose the default development server to the public internet without adding an authentication, proxy, backup, and operations layer appropriate for your deployment.

## Quick start

### Prerequisites

- Node.js `22.13+`;
- PostgreSQL 17 with `pgvector`;
- Docker, for the isolated PostgreSQL integration test suite;
- an optional OpenAI-compatible model service. Deterministic tests do not require a live model provider.

### Install

```bash
# macOS/Linux
bash scripts/setup-web.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup-web.ps1
```

If Node.js 22.13+ is already installed, `node scripts/setup-web.mjs` is equivalent.

The CLI checks Node.js, npm, PostgreSQL/pgvector, and Docker. After confirmation it can install the supported missing prerequisite, create or update only the local database settings in `.env.local`, run migrations and the demo seed, start REALM, and open the browser. Use `node scripts/setup-web.mjs --check` for a read-only environment report; use `--yes` only when you want to accept all proposed installation/configuration actions.

For details and the Docker fallback, see [Web bootstrap](./docs/WEB-BOOTSTRAP.md).


Configure a model provider through the local settings page. API keys belong only in the untracked `.env.local` or the local settings store; never commit them, paste them into issues, or include them in logs.

## Verification

```bash
npm test
npm run lint
npm run typecheck
```

`npm test` uses a disposable PostgreSQL scratch cluster for integration coverage. It must not fall back to a personal or production database. For a focused run:

```bash
npm run test:core
npm run test:lobby
npm run test:postgres-runtime
```

## Architecture at a glance

```text
player / self-play input
          │
          ▼
Runtime Scope ──► DM / Character / Narrator orchestration
          │                         │
          │                         ├─ Rule Pack / Action Receipt
          │                         └─ structured semantic output
          ▼
Record single-writer ──► append-only Events / Observations / Outbox
          │
          ├─ Delivery Projection + SSE
          ├─ Character Memory sync / prefetch
          ├─ Scene crystallization
          └─ Record-local knowledge + profile growth
```

| Area | Location |
|---|---|
| Web pages and API routes | `app/` |
| Application orchestration and Record service | `modules/application/` |
| DM, character, narrator, and presence orchestration | `modules/orchestration/` |
| Runtime and formal commits | `modules/runtime/` |
| Model gateway and structured-output safety | `modules/inference/` |
| Memory and recall | `modules/memory/` |
| World knowledge and Canon | `modules/world-knowledge/` |
| PostgreSQL repository, migrations, and seed | `database/postgres/` |
| Tests | `tests/` |

## Documentation

- [Desktop installation](./docs/DESKTOP-INSTALLATION.md)
- [Getting started](./docs/GETTING-STARTED.md)
- [Configuration](./docs/CONFIGURATION.md)
- [Self-hosting boundaries](./docs/SELF-HOSTING.md)
- [Architecture overview](./docs/architecture/SYSTEM-DESIGN.md)
- [Technical architecture](./docs/architecture/TECHNICAL-ARCHITECTURE.md)
- [PostgreSQL runtime contract](./docs/architecture/POSTGRESQL-RUNTIME-CONTRACT.md)
- [Local Record API contract](./docs/architecture/LOCAL-RECORD-API.md)
- [Model and memory runtime](./docs/architecture/MODEL-AND-MEMORY-RUNTIME.md)

Internal progress ledgers, agent rules, production evidence, private deployment records, and historical experiment logs are deliberately not part of this public snapshot.

## Contributing and security

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. For a security issue, follow [SECURITY.md](./SECURITY.md); never publish credentials, database contents, private network details, or real player data.

## License

REALM is released under the [Apache-2.0 License](./LICENSE).
