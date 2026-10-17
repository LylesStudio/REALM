# Web bootstrap

Run the wrapper matching the host when Node is not installed yet:

```bash
# macOS/Linux
bash scripts/setup-web.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/setup-web.ps1
```

After Node is available, both wrappers hand off to the same `setup-web.mjs` CLI.

The CLI:

1. checks Node.js 22.13+, npm, PostgreSQL/pgvector, and Docker;
2. shows an installation action before it runs Homebrew or winget;
3. creates `.env.local` only when it is missing, or asks before changing local database keys;
4. installs npm dependencies when `node_modules` is absent;
5. starts a local PostgreSQL cluster or a loopback-only `pgvector/pgvector:pg17` Docker container;
6. applies migrations and the demo seed;
7. starts the dev server and opens the browser.

The read-only probe is:

```bash
node scripts/setup-web.mjs --check
```

For a non-interactive local setup after reviewing the plan:

```bash
node scripts/setup-web.mjs --yes
```

`--yes` does not make network installs safe by itself; review the command output and use it only on a machine you control.

## Database modes

### Local PostgreSQL

If PostgreSQL 17 and the `vector` extension are already available, REALM uses the local toolchain. On macOS, the CLI can offer:

```bash
brew install postgresql@17 pgvector
```

The local database remains on loopback. Existing `.env.local` model keys and provider settings are not rewritten by the bootstrap CLI.

### Docker fallback

If a complete local toolchain is unavailable and Docker is ready, the CLI uses the public `pgvector/pgvector:pg17` image. The container is:

- published only on `127.0.0.1`;
- named `realm-postgres` by default;
- persisted in the `realm-postgres-data` Docker volume;
- configured with local trust authentication because the port is loopback-only.

Do not publish the container port to a LAN interface without adding a real authentication and network policy. Stop the database without deleting the named volume when you want to preserve worlds and settings.

On Windows, Docker Desktop is the supported automatic fallback because compiling pgvector from source requires a Visual Studio C++ toolchain. The CLI can offer the Docker Desktop installation through winget, but Windows may require the user to start Docker Desktop and approve its own system prompts.

## What the CLI cannot do

If you call `setup-web.mjs` directly, Node.js must already be available. The macOS/Linux and Windows wrappers can offer to install Node through Homebrew or winget, then ask you to open a fresh terminal and run the launcher again. The bootstrap CLI does not silently overwrite an existing `.env.local`, delete data, expose the server to a LAN, or install model credentials.

The bootstrap path ships REALM from source with a single command.
