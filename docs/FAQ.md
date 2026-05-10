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

After updating permissions, rerun the `init` workflow.

## Why did `ALTER SCHEMA public OWNER TO shiplog` fail?

Changing schema ownership is stricter than granting schema permissions. Postgres requires the current role to own the schema and be able to `SET ROLE` to the new owner. Managed Postgres providers often do not allow that from normal project roles.

shiplog does not require ownership of the `public` schema. It only needs:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO shiplog;
```

## Why does shiplog use two GitHub tokens?

The tokens have different jobs:

- `GH_RO_CLASSIC_TOKEN` reads GitHub activity for ingestion.
- `GH_RW_REPO_TOKEN` writes the rendered README commit.

Keeping them separate limits what each token can do.

## Why not name the secrets `GITHUB_*`?

GitHub reserves the `GITHUB_` prefix for built-in Actions environment variables. shiplog uses `GH_*` so user-defined secrets are clearly project-owned.

## Should I commit `profile_config.json`?

No. Commit `profile_config.example.json`, but keep `profile_config.json` local. The file is gitignored so forks do not inherit the upstream maintainer's personal config.

## How does GitHub Actions get `profile_config.json`?

Store the config as a repository variable named `SHIPLOG_CONFIG_BASE64`.

Generate it locally:

```bash
base64 < profile_config.json | tr -d '\n'
```

The workflows decode that value back into `profile_config.json` before running shiplog.

## Is `SHIPLOG_CONFIG_BASE64` a secret?

Usually no. It is configuration, not a credential. Keep tokens and the database connection string in GitHub Secrets.

If your config contains private repository names or other sensitive metadata, you may choose to store it as a secret instead and update the workflow reference accordingly.

## Which workflow should I run first?

Run `init` first. It migrates the database, creates the configured accounts, runs the one-time historical backfill, renders the README, and commits it.

After that, `collect` runs daily or manually. When `collect` succeeds, `render` updates the README.

## Why is the first backfill slow?

Historical backfill can make many provider API calls. For GitHub, shiplog deliberately throttles REST Search calls and waits when GitHub asks the client to retry later. This keeps the first backfill under provider limits instead of racing into rate-limit failures.

## What should I do if `init` fails during backfill?

Fix the error and rerun `init`. You do not need to truncate tables.

Backfill is designed to be resumable:

- `accounts.backfill_completed_at` is only set after provider backfill finishes.
- Most writes use database upserts or uniqueness constraints.
- Repeated rows are deduplicated on rerun.

Partial progress from the failed run is useful and should normally be kept.

## Why did GitHub return `API rate limit exceeded`?

GitHub has separate limits for some REST APIs, including search. shiplog throttles GitHub search requests, serializes ingestion workflows in GitHub Actions, and retries rate-limit responses using `Retry-After` or `X-RateLimit-Reset` headers.

If a token was already exhausted by another run or tool, shiplog may wait for the reset window before continuing. That is expected for first-time backfills.

## Why did collection run after I merged to `main`?

If `collect.yml` has a `push` trigger for `main`, merging a PR starts ingestion immediately. The intended setup is:

- `ci.yml` runs on pull requests and pushes to `main`.
- `collect.yml` runs on a daily schedule or manually.
- `render.yml` runs after a successful collect, or manually.

## Can I run only the renderer?

Yes:

```bash
bun run render
```

This reads the existing database state and writes `README.md`.

## Can I run shiplog locally?

Yes. Create `.env`, create `profile_config.json`, and export or load the required environment variables:

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
bun run collect
bun run render
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
- `self_backfill`: created during the historical backfill
- `external_import`: reserved for imported data

It is cheap provenance that helps debug whether a row came from live collection, backfill, or a future import path.

## Do I need to install Git hooks?

Usually `bun install` runs the `prepare` script and installs hooks automatically. If hooks are not active, run:

```bash
bun run hooks:install
```

The pre-commit hook checks formatting. The commit-msg hook enforces lowercase Conventional Commit messages.

## Where do provider-specific fields go?

Keep provider-specific logic in provider adapters, such as `lib/providers/github/`. The database schema stays provider-neutral.

GitHub-specific field mappings are documented in `docs/GITHUB_MAPPING.md`.
