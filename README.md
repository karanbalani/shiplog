# shiplog

Daily snapshots of your forge activity into your own Postgres, rendered back into a GitHub profile README.

shiplog v1 is a forkable profile-README template. It collects GitHub activity into Neon Postgres, catches up from the last successful checkpoint, then renders a unified profile README from the database.

## Current Status

Implementation is in progress on the Bun + TypeScript foundation.

Completed so far:

- Bun project metadata in `package.json`
- Strict TypeScript config in `tsconfig.json`
- Example environment file in `.env.example`
- Dependency install with Bun
- Initial Postgres schema migrations in `db/migrations/`, one table per migration file
- Rollup view migrations for monthly, yearly, organization, language, and user activity
- Shared TypeScript schema, config, and vendor contracts in `lib/types/`
- Postgres pool, query, transaction, and close helpers in `lib/db.ts`
- UTC date helpers in `lib/utils/dates.ts`
- JSON Schema-backed shiplog config loader in `lib/config.ts`
- Fetch JSON helper with retry and timeout support in `lib/http.ts`
- GitHub provider API helpers in `lib/providers/github/`
- Schema-aware database upsert helpers and daily repository rollups in `lib/upserts.ts`
- GitHub daily collector in `bin/collect_github.ts`
- Internal GitHub historical collection strategy in `bin/backfill_github.ts`
- Backfill dispatcher in `bin/backfill.ts` that runs historical collection outside the daily collect workflow
- Repair dispatcher in `bin/repair.ts` that reruns specific daily windows without moving checkpoints
- Init dispatcher in `bin/init.ts` that creates and refreshes `users`/`accounts`
- Collect dispatcher in `bin/collect.ts` that runs full history when no checkpoint exists, then daily catch-up afterward
- README renderer in `bin/render.ts`
- GitHub Actions workflows for one-time account init, historical backfill, daily collection, and manual repair

Note: Bun 1.3 writes `bun.lock` by default. Older Bun versions wrote `bun.lockb`, which is what the original implementation plan mentions.

## Requirements

- Bun 1.3 or newer
- TypeScript, installed through `bun install`
- dbmate, needed once database migrations are added
- A Neon Postgres database
- A classic GitHub token with `read:user`, `repo`, and `read:org` scopes. The `repo` scope is required for private repository activity.

## Setup

Install dependencies:

```bash
bun install
```

`bun install` also runs the `prepare` script, which installs this repo's Git hooks by setting:

```bash
git config core.hooksPath .githooks
```

If hooks are not active in a fresh clone, install them manually:

```bash
bun run hooks:install
```

If Bun is installed but not on your shell `PATH`, run it by absolute path or add Bun's bin directory to your shell profile:

```bash
~/.bun/bin/bun install
```

## Postgres Database Setup

shiplog needs a Postgres database where the application role can create schema objects and then read/write the data it owns.

Create a dedicated role and database before running migrations. Run this as a Postgres admin user:

```sql
CREATE ROLE shiplog LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE shiplog OWNER shiplog;
```

Then connect to the new database as an admin and make sure the `shiplog` role can create objects in the `public` schema:

```sql
\connect shiplog

GRANT CONNECT ON DATABASE shiplog TO shiplog;
GRANT USAGE, CREATE ON SCHEMA public TO shiplog;
```

Use the `shiplog` role in `DATABASE_CONNECTION_STRING`:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:replace-with-a-strong-password@host:5432/shiplog?sslmode=verify-full
```

You can verify the application role can run migrations by connecting with `DATABASE_CONNECTION_STRING` and creating a temporary table:

```sql
CREATE TABLE shiplog_permission_check (id int);
DROP TABLE shiplog_permission_check;
```

On Neon, you can create the database and role from the Neon dashboard or SQL editor. The important requirement is the same: the role used by `DATABASE_CONNECTION_STRING` must be able to run migrations, which means it needs `CREATE` permission on the target schema. The `public` schema does not need to be owned by the `shiplog` role.

Create a local environment file:

```bash
cp .env.example .env
```

Then fill in:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:password@host:5432/shiplog?sslmode=verify-full
GH_RO_CLASSIC_TOKEN=ghp_xxx
GH_RW_REPO_TOKEN=github_pat_xxx
# Optional, only when an org requires a separate read token:
# GH_RO_RESTRICTED_ORG_PAT_TOKEN=github_pat_xxx
```

Optional logging controls:

```bash
SHIPLOG_LOG_LEVEL=info # debug, info, warn, error, silent
NO_COLOR=1             # disable ANSI colors
```

Create your shiplog config from the template:

```bash
cp shiplog.config.example.json shiplog.config.json
```

Then edit `shiplog.config.json`:

- Set `profile.displayName`.
- Run `bun run identity github <your-github-login>` and paste the returned account object into `collect.accounts[0]`.
- Set `collect.accounts[0].tokenEnv` to the read token env var, usually `GH_RO_CLASSIC_TOKEN`.
- Optionally run `bun run identity github organization-pat-token <org-login>` and add the returned object to `collect.accounts[0].organizationPatTokens[]` for organizations that need a separately authorized PAT.
- Run `bun run identity github publish-target <owner/repo>` and paste the returned object into `publish.targets[0]`.
- Set `publish.targets[0].tokenEnv` to `GH_RW_REPO_TOKEN`.

Config uses stable provider IDs for collect accounts, organization PAT tokens, ignored organizations, ignored repositories, and publish targets. shiplog resolves the current provider names at runtime so GitHub username, organization, and repository renames do not split history.

For ignore entries, use `bun run identity github organization <org-login>` for `collect.accounts[0].ignore.organizations[]` and `bun run identity github repository <owner/repo>` for `collect.accounts[0].ignore.repositories[]`. These helper lookups work without a token for public users, organizations, and repositories. Set `GH_RO_CLASSIC_TOKEN` only when the lookup needs authenticated access, such as a private repository.

The upstream org/template repo commits `shiplog.config.example.json`, not a real `shiplog.config.json`. `shiplog.config.json` is gitignored so local config does not accidentally get committed.

For GitHub Actions, store the config as a repository variable named `SHIPLOG_CONFIG_BASE64`. Generate the value from your local config:

```bash
base64 < shiplog.config.json | tr -d '\n'
```

Then decode it inside the workflow before running `bun run init`, `bun run backfill`, `bun run collect`, `bun run repair`, or `bun run render`:

```yaml
- name: Write shiplog config
  run: printf '%s' "$SHIPLOG_CONFIG_BASE64" | base64 -d > shiplog.config.json
  env:
    SHIPLOG_CONFIG_BASE64: ${{ vars.SHIPLOG_CONFIG_BASE64 }}
```

`SHIPLOG_CONFIG_BASE64` is configuration, not a secret. Keep `DATABASE_CONNECTION_STRING` and provider tokens in GitHub Secrets.

Required GitHub repository settings:

- Repository variable: `SHIPLOG_CONFIG_BASE64`
- Repository secret: `DATABASE_CONNECTION_STRING`
- Repository secret: `GH_RO_CLASSIC_TOKEN`
- Repository secret: `GH_RW_REPO_TOKEN`

Token responsibilities:

- `GH_RO_CLASSIC_TOKEN` reads GitHub activity for ingestion. Use a classic token with `read:user`, `repo`, and `read:org` so private repository activity is available.
- `GH_RW_REPO_TOKEN` authenticates README publishing commits for configured publish targets.

If an organization requires a separate read token, create another secret such as `GH_RO_RESTRICTED_ORG_PAT_TOKEN`, add the stable organization PAT token entry to `collect.accounts[0].organizationPatTokens`, and expose it in the workflow env next to `GH_RO_CLASSIC_TOKEN`.

The default workflows expose `GH_RW_REPO_TOKEN` to `bun run publish`. If a publish target uses a different `tokenEnv`, add that secret to the `Publish rendered README` step env as well.

After setting those values, run the `init` workflow once from GitHub Actions. It migrates and creates the configured account rows without collecting activity. Then run the separate `backfill` workflow to collect historical activity; during backfill, shiplog logs discovery progress, repository progress, elapsed time, and an approximate ETA. If `backfill` fails before completion, fix the error and rerun it; writes are upserted, completed repositories are skipped on the next run, and the account checkpoint advances only after backfill completes. The `collect` workflow then runs daily or manually. Normal collect runs catch up from each account's `last_successful_collect_on` checkpoint through UTC yesterday, then rechecks the recent `collect.lookbackDays` window. Use the `repair` workflow for explicit one-off date or range repair without moving the checkpoint. When `collect`, `backfill`, or `repair` succeeds, the `render` workflow regenerates `rendered.md` and publishes it to each configured target. The separate `ci` workflow handles formatting, linting, typechecking, and tests on pull requests and pushes to `main`.

## Development Commands

Run the TypeScript checker:

```bash
bun run typecheck
```

Check formatting for docs, JSON, TypeScript, and SQL migrations:

```bash
bun run format:check
```

Run the linter:

```bash
bun run lint
```

Format everything:

```bash
bun run format
```

Git hooks run the same checks before commits:

```bash
bun run precommit
bun run commitmsg:check .git/COMMIT_EDITMSG
```

The pre-commit hook runs formatting checks. The commit-msg hook requires lowercase Conventional Commit subjects, for example:

```text
feat(db): add accounts schema
fix(render): handle empty activity
chore: update dependencies
```

Run tests:

```bash
bun test
```

Run database migrations after the migration files exist:

```bash
bun run migrate
```

shiplog reads `DATABASE_CONNECTION_STRING` from the environment. For local smoke checks against a Neon dev branch:

```bash
export DATABASE_CONNECTION_STRING='postgres://shiplog:password@host:5432/shiplog?sslmode=verify-full'
bun run migrate
bun run migration:down
bun run migrate
```

Warm and verify the database connection before migrations or rendering:

```bash
bun run db:wait
```

This runs `SELECT now()` with retries, which helps wake hibernating Neon branches before the real work starts.

Roll back the most recent migration:

```bash
bun run migration:down
```

This wraps `dbmate rollback`. `dbmate down` is also available as an alias for rollback.

Inspect tables after migrating:

```bash
psql "$DATABASE_CONNECTION_STRING" -c '\dt'
```

Create a new migration:

```bash
bun run migration:new create_table_some_table
```

This wraps `dbmate new create_table_some_table` and creates a timestamped SQL file under `db/migrations/`. Migration names should follow `<up_action>_<object_type>_<object_name>`, for example `create_table_users`, `create_view_monthly_repository_activity`, or `alter_table_accounts_add_timezone`. Keep schema migrations small: one table or view per migration, with table-specific indexes in the same file.

Initialize the configured account rows after configuring `shiplog.config.json` and migrating the database:

```bash
bun run init
```

`init` is resumable. If it fails midway because of a provider or database error, rerun it after fixing the issue. Existing user and account rows are deduplicated by database constraints and upserts. `init` does not collect activity or move `accounts.last_successful_collect_on`; run `backfill` for historical ingestion after account setup succeeds.

Run historical backfill directly:

```bash
bun run backfill
```

`backfill` requires initialized account rows, runs complete historical collection through UTC yesterday, records repository-level backfill state, and advances `accounts.last_successful_collect_on` after a successful run. The GitHub Actions `backfill` workflow exposes the same path manually and triggers `render` after success.

Collect activity and regenerate the README:

```bash
bun run collect
```

By default, `collect` runs complete history when `accounts.last_successful_collect_on` is null. After that, it catches up every missing date from `accounts.last_successful_collect_on + 1` through UTC yesterday, rechecks the recent `collect.lookbackDays` window, and advances the checkpoint after each successful date. `collect.lookbackDays` defaults to `7`; set it to `0` to disable rolling rechecks.

Repair exactly one date without moving the checkpoint:

```bash
REPAIR_DATE=2026-05-07 bun run repair
```

Repair a historical range without moving the checkpoint:

```bash
REPAIR_FROM=2026-05-01 REPAIR_TO=2026-05-07 bun run repair
```

Render only:

```bash
bun run render
```

Publish the rendered README to configured targets:

```bash
bun run publish
```

## Implementation Notes

The v1 architecture is eight Bun-executed TypeScript binaries:

- `bin/init.ts`
- `bin/backfill.ts`
- `bin/collect.ts`
- `bin/repair.ts`
- `bin/collect_github.ts`
- `bin/backfill_github.ts`
- `bin/render.ts`
- `bin/publish.ts`

Shared code lives under `lib/`, GitHub-specific helpers under `lib/providers/github/`, and database migrations under `db/migrations/`.

Project conventions live in `docs/CONVENTIONS.md`. Frequently asked setup and operations questions live in `docs/FAQ.md`. Schema documentation lives in `docs/SCHEMA.md`. Provider-specific field mappings live in `docs/GITHUB_MAPPING.md`. Agent-facing guidance lives in `.agents/README.md`.

The GitHub daily collector currently resolves configured stable IDs to current GitHub logins/names, ingests active repositories from GitHub contribution data, merges in authenticated private repositories the configured read tokens can read, applies ignored repository/organization IDs, links GitHub organization-owned repositories to `organizations`, then writes commits, pull requests, pull request reviews, issues, repository snapshots, daily provider summaries, and daily repository activity rollups. Commit ingestion counts commits where the configured GitHub account appears in the commit authors list, including `Co-authored-by` credits.

The internal GitHub historical strategy resolves the stable account ID, uses the account creation year to walk contribution history by year, enumerates authenticated repositories the configured read tokens can read, applies ignored repository/organization IDs, links GitHub organization-owned repositories to `organizations`, writes yearly provider summaries, enriches repository snapshots/languages, ingests historical commits/PRs/reviews/issues, and derives daily repository activity for every distinct event date.

The init dispatcher reads `shiplog.config.json`, ensures the human `users` row exists, fetches provider account profile data, and writes `accounts`. It does not collect activity.

The backfill dispatcher reads `shiplog.config.json`, resolves initialized `accounts` by stable provider ID, refreshes the current login, runs complete provider history through UTC yesterday, and advances the account checkpoint after successful historical collection.

The collect dispatcher reads `shiplog.config.json`, resolves initialized `accounts` by stable provider ID, refreshes the current login, chooses complete history when the checkpoint is null, chooses an explicit `COLLECT_DATE` or repair range, or catches up every missing date through UTC yesterday before rechecking the recent `collect.lookbackDays` window. After a successful automatic run, it advances the account checkpoint.

The repair dispatcher requires `REPAIR_DATE` or `REPAIR_FROM`/`REPAIR_TO`, reruns the daily provider collector for those dates, and leaves the account checkpoint unchanged.

The renderer reads `TEMPLATE.md`, queries account-scoped activity from the database, fills generic placeholders, and writes `rendered.md`. It does not overwrite this repository's own `README.md`.

The publisher reads `rendered.md`, resolves each configured stable `repositoryId` to its current GitHub `owner/repo`, and writes to the configured `branch` and `path` with the target's `tokenEnv`.

CLI logs use `lib/logger.ts`, write to stderr, include ISO timestamps, support log levels, and colorize levels unless `NO_COLOR` is set.
