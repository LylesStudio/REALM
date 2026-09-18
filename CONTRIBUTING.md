# Contributing to REALM

Thank you for taking an interest in REALM.

The public repository is a **self-hosted single-user / research preview**. The runtime, memory pipeline, world knowledge, and PostgreSQL contracts are evolving quickly. Please make the scope of a change explicit and keep the public documentation honest about what is not supported.

## Before you start

1. Read [README.md](./README.md) and [docs/](./docs/).
2. Read [LICENSE](./LICENSE) and [SECURITY.md](./SECURITY.md).
3. For a larger behavior change, open an issue describing the goal, affected boundaries, and verification plan before coding.
4. Never submit real user content, database dumps, model keys, access tokens, private network addresses, or operational logs.

## Local verification

Requirements: Node.js 22.13+, PostgreSQL 17 with pgvector, and Docker for the disposable PostgreSQL test cluster.

```bash
npm ci
cp .env.example .env.local
npm test
npm run lint
npm run typecheck
git diff --check
```

Focused checks are welcome during development, but a pull request should include the full commands and their actual exit codes.

## Engineering boundaries

- Preserve Record single-writer semantics and append-only Events.
- Preserve RLS, visibility/audience checks, and least-privilege runtime roles.
- Treat model output as untrusted data; it must not become authorization, dice results, or historical fact without a server-side contract.
- Add a focused regression before implementing a behavior change.
- Keep commits small and scoped. Use Conventional Commit messages such as `feat:`, `fix:`, `docs:`, or `test:`.
- Do not introduce a hosted-service promise in code or documentation unless the required identity, rate-limit, cost, retention, and deletion boundaries are implemented and tested.

## Data and test isolation

Integration tests must use the repository's disposable scratch harness. They must not write to a personal or production database and must clean temporary databases, containers, ports, and generated artifacts on success and failure.

Do not commit:

- `.env.local` or any real configuration;
- local settings, backups, logs, screenshots, traces, or build output;
- real worlds, conversations, player profiles, Feishu data, or provider data;
- generated desktop/Android bundles unless a separate release policy explicitly covers them.

## Pull requests

A useful pull request explains:

- what changed and why;
- which security, visibility, persistence, or model boundaries it touches;
- the exact verification commands and results;
- known limitations and unmeasured environments.

Reviewers will pay particular attention to authorization boundaries, hidden writes, unnecessary synchronous waits, and documentation that overstates support.
