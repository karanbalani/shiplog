# FAQ

## Do I need to update `DATABASE_CONNECTION_STRING` if I see an SSL warning?

Yes. Update the connection string value from:

```text
sslmode=require
```

to:

```text
sslmode=verify-full
```

Example:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:password@host:5432/shiplog?sslmode=verify-full
```

You do not need to rotate the database password. This change keeps the current `pg` behavior explicit and avoids the `pg-connection-string` warning about future SSL mode semantics.

## Where should I update the database connection string?

Update every place that stores the connection string:

- GitHub repository secret: `DATABASE_CONNECTION_STRING`
- Local `.env`, if you run shiplog locally
- Any local shell export you use for smoke testing

## Should `DATABASE_CONNECTION_STRING` be called a URL, URI, or connection string?

shiplog uses `DATABASE_CONNECTION_STRING` because the value contains the full connection material: protocol, user, password, host, database, and connection parameters.

## What database permissions does shiplog need?

shiplog should use a dedicated Postgres role, usually named `shiplog`, against a dedicated database, usually also named `shiplog`.

The role must be able to:

- connect to the database
- create tables, indexes, and views during migrations
- read and write the tables it owns

Run this as a Postgres admin user:

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

Use that role in the connection string:

```bash
DATABASE_CONNECTION_STRING=postgres://shiplog:replace-with-a-strong-password@host:5432/shiplog?sslmode=verify-full
```

Verify the role can create objects by connecting with `DATABASE_CONNECTION_STRING` and running:

```sql
CREATE TABLE shiplog_permission_check (id int);
DROP TABLE shiplog_permission_check;
```

## Why did migrations fail with `permission denied for schema public`?

The database connection works, but the role does not have permission to create objects in the `public` schema.

Fix it by using a role that can create objects in the target schema, or grant the current role schema permissions:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO shiplog;
```

After updating permissions, rerun the `freshness` workflow.

## Why did `ALTER SCHEMA public OWNER TO shiplog` fail?

Changing schema ownership is stricter than granting schema permissions. Postgres requires the current role to own the schema and be able to `SET ROLE` to the new owner. Managed Postgres providers often do not allow that from normal project roles.

shiplog does not require ownership of the `public` schema. It only needs:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO shiplog;
```

## Why does shiplog use two GitHub tokens?

The tokens have different jobs:

- `GH_RO_CLASSIC_TOKEN` reads GitHub activity for ingestion. Use a classic token with `read:user`, `repo`, and `read:org`; the `repo` scope lets shiplog read private repository activity.
- `GH_RW_REPO_TOKEN` writes rendered README commits for configured publish targets.

Keeping them separate limits what each token can do.

If a publish target uses a `tokenEnv` other than `GH_RW_REPO_TOKEN`, expose that secret in the `daily-publish` workflow's `Publish rendered README` step env. The bundled ingestion steps already expose the example `GH_RO_RESTRICTED_ORG_PAT_TOKEN` secret for organization-specific reads; add more env mappings if your config uses additional read-token names. GitHub Actions secrets are not available to scripts unless the workflow maps them into environment variables.

## How does shiplog collect private repository activity?

GitHub contribution groups are useful for discovering active repositories, but private repositories can be omitted from those grouped lists depending on token access and GitHub visibility rules. Daily collect stays scoped to contribution-group repositories so the scheduled lane remains short and predictable.

Historical backfill has two modes. `fast` mode uses contribution groups and avoids broad private repository enumeration. `deep` mode also reads authenticated private repository lists and organization-specific private repository lists, but those repositories are treated as candidates: shiplog probes them for matching account activity and only writes them to `repositories` after it finds commits, pull requests, issues, or reviews for the configured account. Public repositories are collected when GitHub reports contribution activity for them, not merely because a token can list them.

For private repository candidates, authored commit proof is quick: shiplog asks GitHub for one matching default-branch commit by the configured account per active repository year. Co-authored commit proof cannot be filtered as tightly by GitHub, so deep mode uses a small bounded scan, stores the commit cursor in `private_repository_probe_state` when the scan is incomplete, and resumes on later runs before falling back to pull request, issue, and review probes. This keeps private access useful without turning every scheduled run into a full organization crawl.

If an organization blocks or requires separate authorization for the default classic token, add an organization-specific read token to `shiplog.config.json`:

```json
{
  "organizationPatTokens": [
    {
      "organizationId": "O_kgDO...",
      "tokenEnv": "GH_RO_RESTRICTED_ORG_PAT_TOKEN"
    }
  ]
}
```

Find the stable organization PAT token config with `bun run identity github organization-pat-token restricted-org`. Repository metadata, commits, pull requests, issues, and reviews for that organization will use the organization-specific token, even if the organization is later renamed.

Private repository names are stored in the database when your token can read them and matching activity exists, but they are not printed in workflow logs. Log lines use the provider repository id for private repositories, for example `id:R_abc123`, so a public Actions run does not leak private repository names.

If a private repository, default token, or organization token loses access, shiplog logs a warning and skips that scope for the current run. It does not mark the org or repository permanently blocked, so refreshing the token or restoring access lets a later run continue from the data already stored.

## Why did GitHub say it could not resolve a repository during backfill?

GitHub can include a repository in historical contribution groups even when that repository can no longer be resolved by its current `owner/name`. Common causes are deleted repositories, renamed repositories, transferred repositories, or repositories that the token can no longer access.

shiplog treats this as a repository-level skip. It keeps the repository row discovered from contribution metadata, logs that enrichment was skipped, and continues collecting the rest of the account. Rerunning later is safe because database writes are deduplicated with upserts and unique keys.

## Why not name the secrets `GITHUB_*`?

GitHub reserves the `GITHUB_` prefix for built-in Actions environment variables. shiplog uses `GH_*` so user-defined secrets are clearly project-owned.

## Should I commit `shiplog.config.json`?

No. Commit `shiplog.config.example.json`, but keep `shiplog.config.json` local. The file is gitignored so forks do not inherit the upstream maintainer's personal config.

## How does GitHub Actions get `shiplog.config.json`?

Store the config as a repository variable named `SHIPLOG_CONFIG_BASE64`.

Generate it locally:

```bash
base64 < shiplog.config.json | tr -d '\n'
```

The workflows decode that value back into `shiplog.config.json` before running shiplog.

## Is `SHIPLOG_CONFIG_BASE64` a secret?

Usually no. It is configuration, not a credential. Keep tokens and the database connection string in GitHub Secrets.

If your config contains private repository names or other sensitive metadata, you may choose to store it as a secret instead and update the workflow reference accordingly.

## Which workflow should I run first?

Run `freshness` first. It migrates the database, initializes configured accounts, collects current activity, and runs queued maintenance.

After that, leave the scheduled lanes on. `freshness` keeps recent data current every 6 hours. `history` runs every 2 hours and makes bounded historical improvements. `integrity` runs daily to detect drift, queue repairs, and drain maintenance work. `daily-publish` runs once per day to collect any final current activity, drain queued maintenance, render, and publish only when the target content changed. Dispatch `integrity` manually with `operation=repair` for an explicit one-off date or range repair, then dispatch `daily-publish` manually if you want the repaired state published before the next daily run.

## What happens if daily collect fails for a few days?

shiplog keeps a simple checkpoint on each account:

```text
accounts.last_successful_collect_on
```

When the checkpoint is null, collect processes only UTC yesterday. After that, normal collect runs process every missing date from the day after that checkpoint through UTC yesterday, then recheck the recent `collect.lookbackDays` window. After each automatic run succeeds, shiplog advances the checkpoint. Complete historical ingestion belongs to `backfill`.

This means a failed or skipped freshness run can usually be fixed by rerunning `freshness`; the collect command inside it will catch up missed dates automatically. The rolling lookback defaults to 7 days and can be disabled with `collect.lookbackDays: 0`.

If you want to repair or inspect one specific day without moving the checkpoint, run:

```bash
REPAIR_DATE=2026-05-07 bun run repair
```

If you want to repair a historical range without moving the checkpoint, run with `REPAIR_FROM` and `REPAIR_TO` together:

```bash
REPAIR_FROM=2026-05-01 REPAIR_TO=2026-05-07 bun run repair
```

In GitHub Actions, dispatch `integrity` with `operation=repair` and optional `repair_date`, `repair_from`, and `repair_to` inputs for the same purpose. The next normal collect run may safely reprocess those dates if they are still part of the checkpoint gap or rolling lookback window.

For set-and-forget consistency, the scheduled `integrity` workflow checks a bounded recent window outside normal collect. It enqueues `maintenance_tasks` repair ranges for missing or mismatched daily summaries, chunks those repairs to at most 7 days by default, and then drains queued maintenance work. If a maintenance run dies after claiming a task, a later integrity or freshness run recovers stale locks after `MAINTENANCE_STALE_LOCK_MINUTES`, which defaults to `120`.

## Why is historical backfill slow?

Historical backfill can make many provider API calls. For GitHub, shiplog deliberately throttles REST Search calls and waits when GitHub asks the client to retry later. This keeps backfill under provider limits instead of racing into rate-limit failures.

Use `fast` mode for first value. It skips broad private repository candidate scans and asks GitHub for commits authored by the configured account, which avoids walking unrelated default-branch history on large repositories. Use `deep` mode later when you want slower reconciliation for co-authored commits and readable private repositories that GitHub omitted from contribution groups. Deep-mode private repository full scans limit commit queries to the repository's own created-to-pushed year window instead of the account's full lifetime.

GitHub Search exposes at most the first 1000 matches for one query. shiplog splits large date-bounded searches into smaller windows; if one day still reaches that ceiling, it logs a warning so the gap is visible.

During historical backfill, shiplog logs:

- yearly discovery progress
- discovered repository count
- estimated minimum GitHub Search pacing time
- repository progress
- elapsed time and approximate ETA

## What should I do if historical collection fails or pauses?

Fix the error and rerun `history` or `bun run backfill`. You do not need to truncate tables.

Historical backfill is designed to be resumable:

- `accounts.last_successful_collect_on` stays null until the complete historical collect succeeds.
- Most writes use database upserts or uniqueness constraints.
- Repeated rows are deduplicated on rerun.
- Completed repositories are tracked in `repository_backfill_state`; set `BACKFILL_MODE`, `BACKFILL_MAX_MINUTES`, `BACKFILL_REPO_BUDGET_MINUTES`, or the history workflow's matching inputs to choose the fast or deep path and process large accounts in smaller chunks. `BACKFILL_REPOSITORY_LIMIT` remains available for custom local runs that need a hard cap. The scheduled history workflow defaults to `mode=deep`, `max_minutes=30`, and `repo_budget_minutes=5`.
- Incomplete private repository candidate commit probes are tracked in `private_repository_probe_state`, so a large readable private repository can continue from its last commit cursor instead of starting over. Budgeted runs revisit incomplete private probes while there is enough runtime left for another repository budget.
- A budgeted history run that pauses is still useful progress. In GitHub Actions it writes a step summary and resumes the remaining repositories on the next scheduled run. The next `daily-publish` run renders and publishes the best current database state.
- If a single repository still gets a retryable provider error after request retries are exhausted, shiplog marks that repository `retry_wait`, continues with other repositories, and lets a later run retry the incomplete repository. Reruns skip completed repository sub-steps before retrying the failed work.
- If a private repository or organization token loses access, shiplog warns and skips that scope for the current run without marking it permanently blocked.

Partial progress is useful and should normally be kept.

## Why did GitHub return `API rate limit exceeded`?

GitHub has separate limits for some REST APIs, including search. shiplog throttles GitHub search requests, serializes ingestion workflows in GitHub Actions, retries rate-limit responses using `Retry-After` or `X-RateLimit-Reset` headers, and splits large date-bounded searches into smaller windows before falling back to GitHub's 1,000-result search cap.

If a token was already exhausted by another run or tool, shiplog may wait for the reset window before continuing. That is expected for first-time historical collects.

## Why did ingestion run after I merged to `main`?

Only `ci.yml` should run on pushes to `main`. If an ingestion lane has a `push` trigger, merging a PR starts data movement immediately. The intended setup is:

- `ci.yml` runs on pull requests and pushes to `main`.
- `freshness.yml` runs scheduled or manually for current collection and queued maintenance.
- `history.yml` runs scheduled or manually for progressive historical improvement.
- `integrity.yml` runs scheduled or manually for drift detection, repair, and queued maintenance.
- `daily-publish.yml` runs scheduled or manually for final current collection, queued maintenance, render, and publish.

## Can I run only the renderer?

Yes:

```bash
bun run render
```

This reads the existing database state and writes `rendered.md`. It does not overwrite this repository's own `README.md`.

## Can I publish an already rendered README?

Yes:

```bash
bun run publish
```

This reads local `rendered.md` and writes it to each `publish.targets[]` entry in `shiplog.config.json`. If the target file already has the same content, publishing skips the write and does not create a commit.

## Can I run shiplog locally?

Yes. Create `.env`, create `shiplog.config.json`, and export or load the required environment variables:

```bash
DATABASE_CONNECTION_STRING=postgres://user:password@host:5432/shiplog?sslmode=verify-full
GH_RO_CLASSIC_TOKEN=ghp_xxx
GH_RW_REPO_TOKEN=github_pat_xxx
```

Then run:

```bash
bun install
bun run migrate
bun run init
bun run backfill
bun run collect
bun run drift
bun run maintenance
bun run render
bun run publish
```

## What should I do if Neon is hibernating?

Run:

```bash
bun run db:wait
```

This runs `SELECT now()` with retries before the real database work starts. The GitHub workflows already do this before migrations and rendering.

## How do I roll back a migration?

Run:

```bash
bun run migration:down
```

This wraps `dbmate rollback`, which rolls back the latest applied migration.

## How do I create a new migration?

Run:

```bash
bun run migration:new create_table_some_table
```

Migration names should follow `<up_action>_<object_type>_<object_name>`, for example `create_table_users` or `alter_table_accounts_add_timezone`.

## Are the `v_*` objects materialized views?

No. `v_*` means plain view.

When shiplog adds materialized views, they should use the `mv_*` prefix.

## What does `source` mean in daily tables?

`source` records where a row came from. For example:

- `live` or `live_rollup`: collected during a daily run
- `self_backfill`: created during historical collect
- `external_import`: reserved for imported data

It is cheap provenance that helps debug whether a row came from live collection, historical collection, or a future import path.

## Do I need to install Git hooks?

Usually `bun install` runs the `prepare` script and installs hooks automatically. If hooks are not active, run:

```bash
bun run hooks:install
```

The pre-commit hook checks formatting. The commit-msg hook enforces lowercase Conventional Commit messages.

## Where do provider-specific fields go?

Keep provider-specific logic in provider adapters, such as `lib/providers/github/`. The database schema stays provider-neutral.

GitHub-specific field mappings are documented in `docs/GITHUB_MAPPING.md`.
