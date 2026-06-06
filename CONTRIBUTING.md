# Contributing to shiplog

This guide is for people changing shiplog itself. If you want to fork and run shiplog for your own profile README, start with [SETUP_GUIDE.md](SETUP_GUIDE.md).

shiplog takes daily snapshots of your forge activity into your own Postgres, rendered back into a GitHub profile README.

shiplog v1 is a forkable profile-README template. It collects GitHub activity into Neon Postgres, catches up from the last successful checkpoint, then renders a unified profile README from the database.

## Current Status

The Bun + TypeScript foundation includes:

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
- Backfill dispatcher in `bin/backfill.ts` that runs progressive historical collection
- Repair dispatcher in `bin/repair.ts` that reruns specific daily windows without moving checkpoints
- Drift dispatcher in `bin/drift.ts` that checks stored daily summaries and queues repair work
- Maintenance dispatcher in `bin/maintenance.ts` that drains queued background repair work
- Error event housekeeping in `bin/errors.ts` that prunes short-lived diagnostic payloads
- Init dispatcher in `bin/init.ts` that creates and refreshes `users`/`accounts`
- Collect dispatcher in `bin/collect.ts` that runs daily catch-up and rolling lookback only
- README renderer in `bin/render.ts`
- GitHub Actions lanes for freshness, progressive history, integrity repair, housekeeping, and CI

Note: Bun 1.3 writes `bun.lock` by default. Older Bun versions wrote `bun.lockb`, which is what the original implementation plan mentions.

## Contributor Setup

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

For local database, token, config, and GitHub Actions setup, use [SETUP_GUIDE.md](SETUP_GUIDE.md). The same environment variables are used while developing.

Useful local logging controls:

```bash
SHIPLOG_LOG_LEVEL=info # debug, info, warn, error, silent
NO_COLOR=1             # disable ANSI colors
```

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

`backfill` requires initialized account rows, runs historical collection through UTC yesterday, and records repository-level backfill state. Set `BACKFILL_MODE=fast` for the quick path, or `BACKFILL_MODE=deep` for wider reconciliation that checks co-authored commits and probes readable private repositories GitHub did not return in contribution groups. Deep-mode private repository candidates are not written to `repositories` unless shiplog finds matching account activity. For authored commits, that proof is a one-result default-branch history query per active repository year; co-author proof is bounded so private candidate checks do not become a full private-org crawl. Set `BACKFILL_REPOSITORY_LIMIT=25` to process only that many unfinished repositories in one run, `BACKFILL_MAX_MINUTES=20` to cap a run, or `BACKFILL_REPO_BUDGET_MINUTES=5` to reserve time before starting another repository. If one repository hits an exhausted retryable provider error, such as a persistent 503, that repository is marked `retry_wait`, the remaining repositories continue, and a later run can retry it without replaying completed repository sub-steps. If a private repository or organization token loses access, shiplog warns and skips that scope for the current run without recording permanent blocked state, so a refreshed token can pick it up later. The GitHub Actions `history` workflow runs this path every 2 hours with progressive defaults: `mode=deep`, `max_minutes=30`, and `repo_budget_minutes=5`.

Collect activity:

```bash
bun run collect
```

`collect` catches up every missing date from `accounts.last_successful_collect_on + 1` through UTC yesterday, rechecks the recent `collect.lookbackDays` window, and advances the checkpoint after each successful date. When the checkpoint is null, `collect` processes only UTC yesterday; run `backfill` for complete historical ingestion. `collect.lookbackDays` defaults to `7`; set it to `0` to disable rolling rechecks.

Repair exactly one date without moving the checkpoint:

```bash
REPAIR_DATE=2026-05-07 bun run repair
```

Repair a historical range without moving the checkpoint:

```bash
REPAIR_FROM=2026-05-01 REPAIR_TO=2026-05-07 bun run repair
```

Detect drift and queue repair work:

```bash
bun run drift
```

`drift` checks recent stored `daily_user_summary` rows against provider contribution totals and enqueues `maintenance_tasks` repair ranges for missing or mismatched dates. By default it checks the last 14 UTC days through yesterday and chunks queued repairs into ranges of at most 7 days. Set `DRIFT_LOOKBACK_DAYS=0` to disable the default window, `DRIFT_REPAIR_CHUNK_DAYS=3` to queue smaller maintenance tasks, or use `DRIFT_FROM=2026-05-01 DRIFT_TO=2026-05-07 bun run drift` for an explicit range.

Run queued maintenance work:

```bash
bun run maintenance
```

`maintenance` drains due `maintenance_tasks` rows, currently starting with queued `repair_range` tasks. It reruns the same daily provider collector used by `repair`, leaves account checkpoints unchanged, records task attempts, and retries failed tasks later until `max_attempts` is reached. It also recovers stale `running` tasks whose worker lock is older than `MAINTENANCE_STALE_LOCK_MINUTES`, which defaults to `120`.

Prune short-lived diagnostic error events:

```bash
bun run errors:prune
```

`errors:prune` deletes rows from `error_events` older than `ERROR_EVENT_RETENTION_DAYS`, which defaults to `30`. The `housekeeping` GitHub Actions workflow runs this daily. Error event payloads are stored as full JSON without redaction, so treat database read access as access to provider error details, private names, and any context inserted by the caller. Workflows that record error events include the event id and a copyable lookup query in the GitHub Actions summary.

Render only:

```bash
bun run render
```

Publish the rendered README to configured targets:

```bash
bun run publish
```

## Implementation Notes

The v1 architecture is eleven Bun-executed TypeScript binaries:

- `bin/init.ts`
- `bin/backfill.ts`
- `bin/collect.ts`
- `bin/repair.ts`
- `bin/drift.ts`
- `bin/maintenance.ts`
- `bin/errors.ts`
- `bin/collect_github.ts`
- `bin/backfill_github.ts`
- `bin/render.ts`
- `bin/publish.ts`

Shared code lives under `lib/`, GitHub-specific helpers under `lib/providers/github/`, and database migrations under `db/migrations/`.

Project conventions live in `docs/CONVENTIONS.md`. Frequently asked setup and operations questions live in `docs/FAQ.md`. Schema documentation lives in `docs/SCHEMA.md`. Provider-specific field mappings live in `docs/GITHUB_MAPPING.md`. Agent-facing guidance lives in `.agents/README.md`.

The GitHub daily collector currently resolves configured stable IDs to current GitHub logins/names, ingests active repositories from GitHub contribution data, applies ignored repository/organization IDs, links GitHub organization-owned repositories to `organizations`, then writes commits, pull requests, pull request reviews, issues, repository snapshots, daily provider summaries, and daily repository activity rollups. It keeps the daily lane scoped to repositories GitHub reports as active; wider private repository and co-author reconciliation belongs to deep backfill. Commit ingestion counts commits where the configured GitHub account appears in the commit authors list, including `Co-authored-by` credits.

The internal GitHub historical strategy resolves the stable account ID, uses the account creation year to walk contribution history by year, applies ignored repository/organization IDs, links GitHub organization-owned repositories to `organizations`, writes yearly provider summaries, enriches repository snapshots/languages, ingests historical commits/PRs/reviews/issues, and derives daily repository activity for every distinct event date. Fast mode keeps this path focused on contribution-group repositories and primary-authored commit history. Deep mode enumerates readable private repository candidates, proves account activity before promotion, and scans unfiltered commit history for co-author reconciliation only after that gate. When a repository or time budget is set, it skips already-complete repositories, processes bounded unfinished repository work, records retryable repository failures as `retry_wait`, records completed repository sub-steps, stores incomplete private candidate probe cursors in `private_repository_probe_state`, and lets the next run resume from repository state. Lost private or organization access is treated as a warning-only skip for the current run, not as permanent repository state.

The init dispatcher reads `shiplog.config.json`, ensures the human `users` row exists, fetches provider account profile data, and writes `accounts`. It does not collect activity.

The backfill dispatcher reads `shiplog.config.json`, resolves initialized `accounts` by stable provider ID, refreshes the current login, and runs provider history through UTC yesterday. Fast mode is the quick path. Deep mode trades runtime for wider reconciliation of co-authored commits and private repository candidates.

The collect dispatcher reads `shiplog.config.json`, resolves initialized `accounts` by stable provider ID, refreshes the current login, catches up every missing date through UTC yesterday, and rechecks the recent `collect.lookbackDays` window. It never runs historical backfill or manual repair; after each successful automatic date, it advances the account checkpoint.

The repair dispatcher requires `REPAIR_DATE` or `REPAIR_FROM`/`REPAIR_TO`, reruns the daily provider collector for those dates, and leaves the account checkpoint unchanged.

The drift dispatcher checks stored daily provider summary totals against current provider totals, then enqueues maintenance repair ranges for missing or mismatched dates without changing collected activity itself.

The maintenance dispatcher reads due `maintenance_tasks`, atomically claims supported background work such as queued repair ranges, recovers stale running locks, and records success, retry, or permanent failure state.

The errors dispatcher prunes generic diagnostic rows from `error_events`. This table is intentionally not workflow state; callers can write full JSON payloads for investigation, and housekeeping keeps the table bounded by age.

The renderer reads `TEMPLATE.md`, queries account-scoped activity from the database, fills generic placeholders, and writes `rendered.md`. It does not overwrite this repository's own `README.md`.

The publisher reads `rendered.md`, resolves each configured stable `repositoryId` to its current GitHub `owner/repo`, and writes to the configured `branch` and `path` with the target's `tokenEnv`. When the remote file already matches `rendered.md`, it skips the write so no duplicate README commit is created.

CLI logs use `lib/logger.ts`, write to stderr, include ISO timestamps, support log levels, and colorize levels unless `NO_COLOR` is set.
