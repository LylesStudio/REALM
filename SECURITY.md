# Security Policy

## Supported scope

The public REALM snapshot is a self-hosted single-user / research preview. It is not a public multi-tenant service. Do not expose a default development instance directly to the internet.

The operator is responsible for network placement, PostgreSQL access, backups, model-provider configuration, authentication in front of the service, rate limits, cost controls, retention, and deletion.

## Reporting a vulnerability

Please do not publish exploitable details, credentials, database contents, model keys, private network addresses, or real user data in a public issue.

For the GitHub repository, use a private security report or security advisory when available. If private reporting is not enabled, contact the maintainer through a private channel listed on the maintainer profile and include:

- the affected commit or version;
- the smallest reproducible steps;
- impact and affected boundary;
- a suggested mitigation, if known.

Please redact personal information, player input, world content, access tokens, and provider responses.

## Known boundaries

- The local access/session model is not a production public identity system.
- Model providers and databases are operator-managed; secrets must stay outside Git, issues, logs, and model prompts.
- PostgreSQL RLS and visibility projections are part of the runtime contract. Do not bypass them for convenience.
- Production-grade hosted-service controls are not included in this research preview.

## Dependencies and supply chain

Dependency updates must include the lockfile and should be reviewed in CI. A new runtime dependency should be justified in the pull request, including its source and license.
