# Desktop installation

REALM desktop packages are **unsigned preview builds**. They bundle the web application, a Node runtime, and a local PostgreSQL/pgvector runtime so end users do not need Node or PostgreSQL installed separately.

## macOS

Supported preview architectures:

- Apple Silicon: `darwin-arm64`;
- Intel: `darwin-x64` (experimental build line).

1. Download the DMG matching the Mac architecture.
2. Drag `REALM.app` to `Applications`.
3. On the first launch, macOS may say that the developer cannot be verified. In Finder, right-click the app, choose **Open**, and confirm.
4. REALM initializes its private local database and opens the local web interface.

The app requires macOS 12 or newer. It is not Developer ID signed or notarized yet. Do not disable Gatekeeper or delete quarantine attributes.

User data is stored under:

```text
~/Library/Application Support/REALM/
```

Removing the app does not remove this directory. Back it up before uninstalling or testing a new build.

## Windows

The first public packaging target is Windows x64.

1. Download the `realm-*-win-x64-unsigned.exe` installer.
2. Run the installer and accept the unsigned-preview warning if Windows SmartScreen shows one.
3. Launch REALM from the Start menu or desktop shortcut.
4. REALM initializes its private local database and opens the local web interface.

The installer keeps user data under:

```text
%LOCALAPPDATA%\REALM
```

Uninstalling removes application files but intentionally keeps this data directory. Delete it manually only after making a backup and deciding that the worlds and settings are no longer needed.

## What the packages do not include

- no model weights;
- no provider API key;
- no public relay or hosted account service;
- no automatic updater;
- no code signature or notarization in the preview channel.

Configure a model provider in the local settings page after startup.

## Building packages from source

Packaging is platform-native because PostgreSQL, pgvector, Mach-O rewriting, and NSIS depend on the target operating system.

### macOS package

Run on the matching native architecture:

```bash
npm ci
npm run desktop:macos:package -- --arch arm64
# or: npm run desktop:macos:package -- --arch x64
```

The pipeline builds the app, downloads and verifies pinned runtime inputs, compiles PostgreSQL and pgvector, audits the bundle, runs a fresh-data launcher smoke test, creates the DMG, and writes SHA256/SBOM metadata. It requires Xcode command-line tools and OpenSSL 3 headers.

### Windows package

The Windows pipeline needs Node 22, PowerShell, Visual Studio C++/MSVC, NSIS, and the pinned PostgreSQL/pgvector build inputs. The reference workflow is `.github/workflows/desktop-windows.yml`; the Linux contract test deliberately does not pretend to be a Windows build.

A Windows package is therefore currently easiest to produce in CI on `windows-latest`, not from a clean end-user machine.

## Web deployment without a release artifact

A source checkout can run the web application without a desktop release:

```bash
npm ci
cp .env.example .env.local
npm run db:postgres:bootstrap
npm run dev
```

This still requires Node.js 22.13+, PostgreSQL 17 with pgvector tooling, and Docker for the full scratch test suite. The current source path is **not** a clean-machine one-click installer:

- it does not install Node;
- it does not install PostgreSQL or pgvector for the operator;
- Windows source setup needs a PostgreSQL toolchain or an explicit external PostgreSQL service;
- the local database bootstrap is intended for controlled development/self-hosting, not public deployment.

A future one-command web bootstrap can wrap dependency detection, `.env.local` creation, database startup, migrations, seed, and server launch. For genuine zero-prerequisite setup on Windows/macOS, a Docker Compose path or a bundled runtime package is still required.
