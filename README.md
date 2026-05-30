# shiplog

Daily snapshots of your GitHub activity into your own Postgres, rendered back into a profile README.

shiplog is a forkable profile-README pipeline. You own the database, the GitHub Actions workflows keep it fresh, and the renderer publishes the generated README back to the profile repository you configure.

## What You Get

- GitHub activity collection for commits, pull requests, reviews, issues, repositories, languages, and organization context.
- A Postgres schema designed for historical activity and daily rollups.
- GitHub Actions lanes for freshness, progressive history, drift repair, and CI.
- A renderer that writes `rendered.md` locally and can publish it to configured README targets.
- Stable GitHub IDs in config so username, organization, and repository renames do not split history.

## Quick Start

1. Fork this repository.
2. Create a Postgres database. Neon is the intended hosted path, but any reachable Postgres database with schema creation permissions works.
3. Create GitHub tokens for read collection and README publishing.
4. Build `shiplog.config.json` from `shiplog.config.example.json`.
5. Store `SHIPLOG_CONFIG_BASE64` as a repository variable and token/database values as repository secrets.
6. Run the `freshness` workflow once from GitHub Actions.

After the first run, the scheduled workflows keep recent activity current, make bounded historical progress, repair drift, render `rendered.md`, and publish to your configured target.

## Requirements

- Bun 1.3 or newer.
- A Postgres database.
- A classic GitHub token with `read:user`, `read:org`, and `repo` scopes for ingestion. The `repo` scope is required if you want private repository activity.
- A GitHub token with write access to the repository where shiplog should publish the rendered README.

## Database Setup

Create a dedicated role and database before running migrations. Run this as a Postgres admin user:

```sql
CREATE ROLE shiplog LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE shiplog OWNER shiplog;
```

Then connect to the new database and grant schema permissions:

```sql
\connect shiplog

GRANT CONNECT ON DATABASE shiplog TO shiplog;
GRANT USAGE, CREATE ON SCHEMA public TO shiplog;
```

Use that role in `DATABASE_CONNECTION_STRING`:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:replace-with-a-strong-password@host:5432/shiplog?sslmode=verify-full
```

On Neon, you can create the database and role from the dashboard or SQL editor. The important part is that the role used by `DATABASE_CONNECTION_STRING` can run migrations.

## Local Setup

Install dependencies:

```bash
bun install
```

Create a local environment file:

```bash
cp .env.example .env
```

Fill in the values you need:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:password@host:5432/shiplog?sslmode=verify-full
GH_RO_CLASSIC_TOKEN=ghp_xxx
GH_RW_REPO_TOKEN=github_pat_xxx
# Optional, only when an org requires a separate read token:
# GH_RO_RESTRICTED_ORG_PAT_TOKEN=github_pat_xxx
```

Warm and verify the database connection:

```bash
bun run db:wait
```

Run migrations:

```bash
bun run migrate
```

## Configure shiplog

Create your config from the template:

```bash
cp shiplog.config.example.json shiplog.config.json
```

Then fill the stable GitHub IDs using the identity helpers:

```bash
bun run identity github <your-github-login>
bun run identity github publish-target <owner/repo>
```

Use the returned account object in `collect.accounts[0]`, and the returned publish target object in `publish.targets[0]`.

Common config fields:

- `profile.displayName`: name rendered in your profile README.
- `collect.accounts[0].tokenEnv`: usually `GH_RO_CLASSIC_TOKEN`.
- `collect.accounts[0].organizationPatTokens[]`: optional per-organization read tokens.
- `collect.accounts[0].ignore.organizations[]`: organization IDs to ignore.
- `collect.accounts[0].ignore.repositories[]`: repository IDs to ignore.
- `publish.targets[0].tokenEnv`: usually `GH_RW_REPO_TOKEN`.

Ignore entries can be resolved with:

```bash
bun run identity github organization <org-login>
bun run identity github repository <owner/repo>
```

The real `shiplog.config.json` is gitignored. Commit `shiplog.config.example.json`, not your local config.

## GitHub Actions Setup

For GitHub Actions, store the config as a repository variable named `SHIPLOG_CONFIG_BASE64`:

```bash
base64 < shiplog.config.json | tr -d '\n'
```

Required repository variable:

- `SHIPLOG_CONFIG_BASE64`

Required repository secrets:

- `DATABASE_CONNECTION_STRING`
- `GH_RO_CLASSIC_TOKEN`
- `GH_RW_REPO_TOKEN`

Optional repository secrets:

- Extra organization read tokens, such as `GH_RO_RESTRICTED_ORG_PAT_TOKEN`, if configured.

Token responsibilities:

- `GH_RO_CLASSIC_TOKEN` reads GitHub activity for ingestion.
- `GH_RW_REPO_TOKEN` publishes the rendered README to configured targets.

The default workflows expose `GH_RW_REPO_TOKEN` to `bun run publish`. If a publish target uses a different `tokenEnv`, add that secret to the `Publish rendered README` step environment.

## Workflows

- `freshness`: runs every 6 hours. Migrates, initializes accounts, collects recent activity, runs queued maintenance, renders, and publishes.
- `history`: runs every 2 hours. Makes bounded historical progress with deep-mode defaults.
- `integrity`: runs daily. Detects drift, queues repair work, runs maintenance, renders, and publishes.
- `ci`: runs formatting, linting, typechecking, and tests on pull requests and pushes to `main`.

Historical work is progressive. If a history run pauses because of repository or time budget, the workflow still succeeds and resumes remaining work later.

## Common Commands

```bash
bun run init
bun run backfill
bun run collect
bun run drift
bun run maintenance
bun run render
bun run publish
```

Repair one date:

```bash
REPAIR_DATE=2026-05-07 bun run repair
```

Repair a range:

```bash
REPAIR_FROM=2026-05-01 REPAIR_TO=2026-05-07 bun run repair
```

Rollback the most recent migration:

```bash
bun run migration:down
```

## Reference

- [FAQ](docs/FAQ.md): setup and operations questions.
- [Schema](docs/SCHEMA.md): tables, views, and timestamp semantics.
- [GitHub mapping](docs/GITHUB_MAPPING.md): how GitHub fields map into shiplog.
- [Conventions](docs/CONVENTIONS.md): project conventions.
- [Contributing](CONTRIBUTING.md): development commands, architecture notes, and contributor guidance.

## Contributing

If you want to change shiplog itself, start with [CONTRIBUTING.md](CONTRIBUTING.md). The README is for people forking and running the tool; contributor details live separately.
