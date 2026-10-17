# Getting started

The easiest path is the web bootstrap launcher, which runs REALM on your own machine.

## Start REALM

Use the launcher for your system:

```bash
# macOS/Linux
bash START-REALM-Linux.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup-web.ps1
```

On Windows, you can also double-click `START-REALM-Windows.cmd`. On macOS, double-click `START-REALM.command`.

The launcher checks Node.js, npm, PostgreSQL/pgvector, and Docker. It asks before installing supported missing tools, creates `.env.local`, initializes the database, loads the demo seed, starts the web server, and opens the browser.

Use this for a read-only check:

```bash
node scripts/setup-web.mjs --check
```

See [Web bootstrap](./WEB-BOOTSTRAP.md) for the supported modes and safety boundaries.

## Verify the checkout

```bash
npm test
npm run lint
npm run typecheck
```

The full test command uses an isolated scratch PostgreSQL cluster for integration coverage. It should not connect to a personal or production database.

## Desktop and source deployment

For macOS/Windows preview packages, see [Desktop installation](./DESKTOP-INSTALLATION.md). The source checkout itself boots with a single command via the web launcher.

## Troubleshooting

- **PostgreSQL connection errors:** check that PostgreSQL 17 is running, `pgvector` is installed, and the three connection variables point to the same local database.
- **Model errors:** verify provider settings and the local API endpoint. A missing key or authentication failure should be reported as a configuration failure, not retried forever.
- **Stale test data:** stop the local development database and use a disposable scratch cluster for tests. Do not delete data from a database that contains personal worlds without a backup and an explicit decision.
