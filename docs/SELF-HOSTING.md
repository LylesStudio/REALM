# Self-hosting boundaries

REALM is designed to run under the control of its operator. This page describes the minimum safe boundary; it is not a production deployment blueprint.

## Local mode

The safest mode is loopback-only:

- bind the web server to `127.0.0.1`;
- keep PostgreSQL on a local interface or a private socket;
- keep `.env.local` and model settings on the machine;
- use the disposable scratch harness for integration tests;
- back up user-created worlds before migrations or experiments.

## Controlled LAN mode

If you explicitly allow another device on a trusted LAN:

- bind only to the intended interface;
- add an access gate and a reverse proxy appropriate for your network;
- do not treat a LAN address as authentication;
- do not expose PostgreSQL directly to the LAN;
- monitor model-provider spend and response failures;
- document how data is backed up, retained, and deleted.

This release runs as a local single-player world system. Operating it beyond one machine belongs to the LAN section above and requires the listed access controls.

## Data boundary

Events, memories, character profiles, world knowledge, and imported world files are operator data. They may contain personal or sensitive narrative content. Restrict filesystem, database, backup, and model-provider access accordingly.

The public repository contains source code, synthetic fixtures, migrations, and generic documentation. It does not contain a production database, real worlds, user conversations, model keys, or private operations records.
