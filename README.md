# shiplog

Daily snapshots of your forge activity into your own Postgres, rendered back into a GitHub profile README.

shiplog v1 is a forkable profile-README template. It collects GitHub activity into Neon Postgres, runs a one-time historical backfill, then renders a unified `README.md` from the database.

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
- JSON Schema-backed profile config loader in `lib/config.ts`
- Fetch JSON helper with retry and timeout support in `lib/http.ts`
- GitHub provider API helpers in `lib/providers/github/`
- Schema-aware database upsert helpers and daily repository rollups in `lib/upserts.ts`
- GitHub daily collector in `bin/collect_github.ts`
- GitHub historical backfill walker in `bin/backfill_github.ts`
- Init dispatcher in `bin/init.ts` that creates `users`/`accounts` and runs first-time backfill
- Daily collect dispatcher in `bin/collect.ts`
- README renderer in `bin/render.ts`
- GitHub Actions workflows for one-time init and daily collection

Note: Bun 1.3 writes `bun.lock` by default. Older Bun versions wrote `bun.lockb`, which is what the original implementation plan mentions.

## Requirements

- Bun 1.3 or newer
- TypeScript, installed through `bun install`
- dbmate, needed once database migrations are added
- A Neon Postgres database
- A GitHub token with `read:user`, `repo`, and `read:org` scopes

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

Create a local environment file:

```bash
cp .env.example .env
```

Then fill in:

```bash
DATABASE_URL=postgres://user:password@host:5432/shiplog?sslmode=require
GITHUB_RO_CLASSIC_TOKEN=ghp_xxx
GITHUB_RW_REPO_TOKEN=github_pat_xxx
```

Optional logging controls:

```bash
SHIPLOG_LOG_LEVEL=info # debug, info, warn, error, silent
NO_COLOR=1             # disable ANSI colors
```

Create your profile config from the template:

```bash
cp profile_config.example.json profile_config.json
```

Then edit `profile_config.json`:

- Set `displayName`.
- Set `identities[0].login` to your GitHub username.
- Set `publishTargets[0].repositoryFullName` to the repository that should receive the rendered README, usually `your-github-login/your-github-login` for a GitHub profile README.
- Set `publishTargets[0].tokenEnv` to `GITHUB_RW_REPO_TOKEN`.

The upstream org/template repo commits `profile_config.example.json`, not a real `profile_config.json`. `profile_config.json` is gitignored so local config does not accidentally get committed.

For GitHub Actions, store the config as a repository variable named `SHIPLOG_CONFIG_BASE64`. Generate the value from your local config:

```bash
base64 < profile_config.json | tr -d '\n'
```

Then decode it inside the workflow before running `bun run init`, `bun run collect`, or `bun run render`:

```yaml
- name: Write profile config
  run: printf '%s' "$SHIPLOG_CONFIG_BASE64" | base64 -d > profile_config.json
  env:
    SHIPLOG_CONFIG_BASE64: ${{ vars.SHIPLOG_CONFIG_BASE64 }}
```

`SHIPLOG_CONFIG_BASE64` is configuration, not a secret. Keep `DATABASE_URL` and provider tokens in GitHub Secrets.

Required GitHub repository settings:

- Repository variable: `SHIPLOG_CONFIG_BASE64`
- Repository secret: `DATABASE_URL`
- Repository secret: `GITHUB_RO_CLASSIC_TOKEN`
- Repository secret: `GITHUB_RW_REPO_TOKEN`

Token responsibilities:

- `GITHUB_RO_CLASSIC_TOKEN` reads GitHub activity for ingestion.
- `GITHUB_RW_REPO_TOKEN` authenticates README publishing commits.

After setting those values, run the `init` workflow once from GitHub Actions. It migrates, backfills, renders, and commits the initial README. The `collect` workflow then runs daily, on pushes to `main`, or manually. When `collect` succeeds, the `render` workflow regenerates and commits `README.md`.

## Development Commands

Run the TypeScript checker:

```bash
bun run typecheck
```

Check formatting for docs, JSON, TypeScript, and SQL migrations:

```bash
bun run format:check
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

dbmate reads `DATABASE_URL` from the environment. For local smoke checks against a Neon dev branch:

```bash
export DATABASE_URL='postgres://user:password@host:5432/shiplog?sslmode=require'
dbmate up
dbmate rollback
dbmate up
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
psql "$DATABASE_URL" -c '\dt'
```

Create a new migration:

```bash
bun run migration:new create_table_some_table
```

This wraps `dbmate new create_table_some_table` and creates a timestamped SQL file under `db/migrations/`. Migration names should follow `<up_action>_<object_type>_<object_name>`, for example `create_table_users`, `create_view_monthly_repository_activity`, or `alter_table_accounts_add_timezone`. Keep schema migrations small: one table or view per migration, with table-specific indexes in the same file.

Run the one-time backfill after configuring `profile_config.json` and migrating the database:

```bash
bun run init
```

Collect yesterday's activity and regenerate the README:

```bash
bun run collect
```

Render only:

```bash
bun run render
```

## Implementation Notes

The v1 architecture is five Bun-executed TypeScript binaries:

- `bin/init.ts`
- `bin/collect.ts`
- `bin/collect_github.ts`
- `bin/backfill_github.ts`
- `bin/render.ts`

Shared code lives under `lib/`, GitHub-specific helpers under `lib/providers/github/`, and database migrations under `db/migrations/`.

Project conventions live in `docs/CONVENTIONS.md`. Schema documentation lives in `docs/SCHEMA.md`. Provider-specific field mappings live in `docs/GITHUB_MAPPING.md`. Agent-facing guidance lives in `.agents/README.md`.

The GitHub daily collector currently ingests active repositories from GitHub contribution data, links GitHub organization-owned repositories to `organizations`, then writes commits, pull requests, pull request reviews, issues, repository snapshots, daily provider summaries, and daily repository activity rollups.

The GitHub backfill walker uses the account creation year to walk contribution history by year, discovers active repositories, links GitHub organization-owned repositories to `organizations`, writes yearly provider summaries, enriches repository snapshots/languages, ingests historical commits/PRs/reviews/issues, and derives daily repository activity for every distinct event date.

The init dispatcher reads `profile_config.json`, ensures the human `users` row exists, fetches provider account profile data, writes `accounts`, runs backfill for accounts where `backfill_completed_at` is null, then marks the account as backfilled.

The daily collect dispatcher reads `profile_config.json`, resolves initialized `accounts`, chooses `COLLECT_DATE` or UTC yesterday, and invokes the matching provider collector for each configured identity.

The renderer reads `TEMPLATE.md`, queries account-scoped activity from the database, fills generic placeholders, and writes `README.md`.

CLI logs use `lib/logger.ts`, write to stderr, include ISO timestamps, support log levels, and colorize levels unless `NO_COLOR` is set.
