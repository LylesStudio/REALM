# PostgreSQL Runtime Contract v1

This document describes the M1 authoritative-storage contract implemented by
`database/postgres/migrations/`. It is local-only and does not configure,
contact, or provision any external database.

## Migration

The ordered files under `database/postgres/migrations/` are safe to apply
repeatedly to the same database. `0001_runtime_contract.sql` creates the base
Runtime Contract; `0002_runtime_contract_hardening.sql` adds append-only Event
enforcement, normalized visibility audiences, immutable context snapshots, and
local application roles. `0003_runtime_repository.sql` freezes recoverable Turn
checkpoints and canonical Outbox states. `0004_runtime_security_hardening.sql`
binds Scene visibility policies to their Event Scene and reconciles the runtime
role to adapter-only privileges. No migration deletes committed Events.
`0005_hybrid_memory.sql` adds the time-safe hybrid Character memory ledger.
`0006_action_state_ledger.sql` adds Character skill ownership, revisioned asset
balances, active effects, and append-only Action Receipts.

Migration files intentionally contain no `BEGIN` or `COMMIT`. The migration
runner owns one atomic transaction per file, including its advisory lock and
migration-ledger update. Do not apply only part of a file.

The migration assumes PostgreSQL 16+ with pgvector already available to the
local PostgreSQL installation. The hardening migration creates the local
`realm_runtime` and `realm_control` login roles, but embeds no password and does
not create databases, network listeners, or external resources.

## Contract boundaries

- Every tenant-owned row carries `workspace_id`.
- Every relationship between tenant-owned tables includes `workspace_id` in
  the foreign key, preventing a row from attaching to another workspace.
- Scoped tables have forced row-level security. A repository transaction must
  execute `SET LOCAL realm.workspace_id = '<workspace-id>'` before reading or
  writing them; an absent setting denies access. Queries must still include
  `workspace_id` so indexes and intent remain explicit.
- `world_tick + world_ordinal` is the total causal order within one worldline.
- `record_ordinal` is the continuous append order within one Record.
- `record_heads` allocates Record versions and Record ordinals; `worldlines`
  allocates the world cursor. A formal commit must lock both rows in the fixed
  order described below.
- An idempotency key is unique inside one Record, while its request fingerprint
  detects reuse with different input.
- Visibility policies are immutable audience snapshots. Their compatibility
  array is normalized into `visibility_policy_audiences`, whose composite
  foreign keys reject cross-Record or unknown CharacterInstances. An Event can
  only bind a fully reconciled snapshot; audiences cannot be changed or
  expanded after commit. Membership changes produce a new policy version.
- Observations store both occurrence and availability cursors. A character may
  only consume an observation once the latter cursor has been reached.
- Context manifests are protected control-plane data, not player projections or
  model context.
- `context_snapshots` stores the exact immutable context projection used for an
  inference, including consumer scope, causal cutoff, protocol/cache identity,
  hashes, and token count. It is protected control-plane data as well.
  Implementation status (verified at HEAD `dd7e6ed`): the table, immutability
  trigger and role grants exist (migration `0002`), but no TypeScript production
  code currently reads or writes `context_manifests`/`context_snapshots` — the
  only source reference marks them as excluded from export
  (`modules/world-transfer/export-matrix.ts:129-130`). The audit structure is
  provisioned; the production write path is not yet wired.
- Events are append-only at both the privilege and trigger layers. Corrections
  are new Events; committed rows are never updated or deleted.
- Action Receipts are append-only and reference their source Event. Asset costs
  and Character effects are applied inside the same formal commit transaction;
  the runtime role may update only asset balance/revision and effect lifecycle
  columns, never delete ledger history.
- The pgvector column is a nullable future hook. M1 neither creates embeddings
  nor performs vector retrieval.

## Role and RLS threat boundary

- `realm_runtime` is the ordinary repository/worker role. It may read delivery
  inputs, append formal Events, Observations and Outbox messages, and update only
  the explicitly granted recovery/head columns. It cannot access `workspaces`,
  `context_manifests` or `context_snapshots`, and has no table DELETE privilege.
- `realm_control` is the control-plane role. It may read and append protected
  manifests and snapshots for diagnostics and perform one-shot local bootstrap.
- Both roles are reconciled as `LOGIN`, `NOSUPERUSER`, `NOCREATEDB`,
  `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`, and `NOBYPASSRLS`. Neither role
  may own the database, schema, Runtime Contract tables, or migration functions.
- Forced RLS scopes every tenant relation, including normalized audiences and
  context snapshots. Each transaction must set `realm.workspace_id` from a
  trusted authenticated request before touching scoped rows. This setting is a
  repository boundary, not authentication: clients must never receive either
  database credential or arbitrary SQL access.
- The migration owner, database owner, superusers, roles granted `BYPASSRLS`,
  and roles that can disable triggers remain outside the application threat
  boundary. Reserve them for local migrations and maintenance. Do not grant
  either application role membership in a privileged role.

## Formal commit boundary

The repository adapter executes the following as one PostgreSQL transaction:

1. set the transaction-local `realm.workspace_id` value;
2. lock the matching `record_heads` row with `SELECT ... FOR UPDATE`;
3. lock that Record's `worldlines` row with `SELECT ... FOR UPDATE`;
4. verify expected version and command fingerprint;
5. allocate `record_version` and `record_ordinal` from `record_heads`, and the
   global `world_tick + world_ordinal` cursor from `worldlines`;
6. append committed `events`, deterministic `observations`, and any source
   `action_receipts`;
7. atomically consume authorized asset balances and apply/remove authorized
   Character effects;
8. advance both `record_heads` and `worldlines` before releasing either lock;
9. append deduplicated `outbox` rows;
10. mark the command and Turn complete;
11. commit.

Every formal writer uses this lock order—Record head first, worldline second—to
avoid deadlocks. A batch spanning multiple Records is not part of the v1 formal
commit; if added later it must define one globally sorted lock order.

Model or Fake-provider inference must finish before that transaction begins.

## Local composition

- `DATABASE_URL` belongs only to one-shot migration/bootstrap maintenance.
- `REALM_RUNTIME_DATABASE_URL` must explicitly name the `realm_runtime` user and
  is the only connection accepted by the long-running Application Service.
- Both URLs must target a query-free loopback PostgreSQL endpoint.
- `npm run db:postgres:bootstrap` starts the project-owned local cluster, applies
  migrations and verifies the demo fixture without rewriting progressed heads.
- The active Node/Vinext process never seeds and never receives the maintenance
  connection.

## Verification

The independent test can run without PostgreSQL:

```sh
node --test tests/postgres-schema-contract.test.mjs
```

It checks table coverage, repeatability declarations, workspace-qualified
relationships, temporal ordering, visibility, idempotency, recovery, outbox,
manifest protection, and the pgvector hook.

The required real-PostgreSQL gate is:

```sh
npm run test:postgres-runtime
```

It verifies migration upgrades and rollback, least privileges, recoverable
Turn release, Event/Observation/head/Outbox atomicity, stale-writer fencing,
visibility projection, world time cutoffs, asset/effect idempotency, and
cross-Workspace denial.

## T-series authorization provenance

Appended by batch T10-B19-A (spec: `docs/development/T10-B19-A-PG-CONTRACT-PROVENANCE.md`).
This chapter records where the experience batches' `realm_runtime` grants come
from. It changes no SQL, no privilege and no runtime behavior; the authoritative
statements remain the migration files themselves (0013–0023, read verbatim at
the time of writing).

| Migration | Batch / capability | `realm_runtime` grant surface | Safety boundary |
|---|---|---|---|
| 0013_membership_insert_grant | DEPLOY-AUTH sign-in joins the default world | INSERT ON player_world_memberships | no UPDATE/DELETE; the omniscience-immutability trigger posture is unchanged |
| 0014_scene_crystallization_grants | SCENE-CRYSTALLIZATION write-back | column-level INSERT on scenes (11 columns); UPDATE (settings) ON worlds | append-oriented scenes — existing rows can never be updated or deleted (grant shape plus table COMMENT); settings merge only |
| 0015_account_ui_language | I18N-CENTRALIZED per-account UI language | UPDATE (ui_language) ON accounts | column-level, three-language CHECK |
| 0016_world_files | TAVERN-IMPORT binary world files | SELECT, INSERT ON world_files | ENABLE+FORCE RLS (realm_workspace_isolation); immutable blobs, no UPDATE/DELETE |
| 0017_account_last_opened | Batch S default-entry "last opened" memory | UPDATE (last_world_id, last_record_id) ON accounts | column-level, two columns only |
| 0018_account_last_opened_fk_set_null | Batch S FK fix | (no grants) | targeted SET NULL (last_record_id); zero privilege change |
| 0019_record_first_nights | T1 first-night ledger | SELECT, INSERT, UPDATE | ENABLE+FORCE RLS |
| 0020_record_self_play_sessions | T7 world self-play sessions | SELECT, INSERT, UPDATE | ENABLE+FORCE RLS plus the single-active ledger contract |
| 0021_world_admin | T8 world admin console | UPDATE (status, updated_at) ON worlds; DELETE ON worlds | column-level UPDATE; DELETE is gated fail-closed by the service layer (zero-event worlds only; demo and recorded worlds refused) |
| 0022_worldline_merge_grants | T10-B1 worldline merge scope repair | INSERT ON worldlines, stories, records | topology rows only; no UPDATE/DELETE |
| 0023_library_runtime_grants | T10-B7 owner-pool exception sinking | table-level INSERT on 11 tables (worlds, character_definitions, character_continuities, character_instances, participants, record_heads, skill_definitions, asset_definitions, effect_definitions, character_skills, character_assets); column-level UPDATE on participants(is_active) and player_world_memberships(role) | the minimal grant set after the owner-pool exceptions were sunk — deliberately not a blanket grant; it does not re-cover the 0013–0022 historical grants |

Boundary statements:

- `realm_control` and maintenance roles stay separate from the long-running
  Application Service: every T-series grant above targets `realm_runtime`
  only; `DATABASE_URL` remains one-shot maintenance (see Local composition).
- The only blanket grant in the migration chain is in 0006 and targets
  `realm_control` (control plane), outside the T-series surface; no T-series
  migration gives `realm_runtime` a blanket grant.
- The T10-B7/B8 owner-pool sinking and the T10-B18 D1/Drizzle tooling
  retirement changed no PostgreSQL authoritative SQL — migrations 0001–0023
  are byte-identical to their original application.
- propagation and semantic-conflict remain contract-only-deferred (T10-B9-A):
  the grants recorded here (including the 0011 tables) are not evidence of
  runtime wiring, and nothing in this chapter implies they are connected to
  the active runtime.
- A DB grant is not a business-semantics loosening, in three forms:
  `worlds DELETE` (0021) is fail-closed at the service layer (zero-event
  worlds only, owner gate, demo refusal); column-level UPDATEs
  (0014/0015/0017/0021/0023) are constrained by CHECK/trigger and application
  semantics; append-only surfaces (scenes, topology, ledgers) permit INSERT
  while history stays immutable.
