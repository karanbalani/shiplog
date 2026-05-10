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
GITHUB_API_TOKEN=ghp_xxx
```

Create your profile config from the template:

```bash
cp profile-config.example.json profile-config.json
```

Then edit `profile-config.json`:

- Set `displayName`.
- Set `identities[0].login` to your GitHub username.
- Set `publishTargets[0].repositoryFullName` to the repository that should receive the rendered README, usually `your-github-login/your-github-login` for a GitHub profile README.
- Set `publishTargets[0].tokenEnv` to the secret name your workflow will expose for pushing the rendered README.

The upstream org/template repo commits `profile-config.example.json`, not a real `profile-config.json`. Your personal fork or generated instance can commit its own `profile-config.json`; it should not contain secrets.

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

The pre-commit hook runs `bun run format:check`. The commit-msg hook requires Conventional Commit subjects and lowercase-only commit messages, for example:

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

Run the one-time backfill after configuring `profile-config.json` and migrating the database:

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

Shared code will live under `lib/`, GitHub-specific helpers under `lib/providers/github/`, and database migrations under `db/migrations/`.

Project conventions live in `docs/CONVENTIONS.md`. Schema documentation lives in `docs/SCHEMA.md`. Provider-specific field mappings live in `docs/GITHUB_MAPPING.md`. Agent-facing guidance lives in `.agents/README.md`.

Until the first TypeScript source file is added, `bun run typecheck` may report that `tsconfig.json` has no input files. That goes away once the planned `bin/`, `lib/`, or `tests/` TypeScript files are created.
