# Changelog

Important changes for public releases are recorded here. Unreleased work is not a promise of a hosted product.

## [Unreleased]

- Prepare the first public source snapshot.
- Document local installation, configuration, contribution, security, and data boundaries.

## [0.1.0] - 2026-09-06

### Added

- Recoverable Turn Core, Record single-writer flow, and append-only Event submission.
- DM, Narrator, Character Runner, rules, dice, presence, and self-play orchestration.
- Persistent character memory, scene crystallization, world knowledge, and Canon review.
- PostgreSQL + pgvector persistence with RLS, least privilege, and visibility projections.
- World / Story / Record navigation and `.realm` export/import primitives.
- Multi-provider model settings, structured-output tolerance, cancellation, and local test infrastructure.

### Known limitations

- Self-hosted single-user / research preview only.
- Public multiplayer identity, hosted operations, billing, retention, and deletion policy are not included.
- Provider latency, quality, and cost depend on the operator's configuration.
