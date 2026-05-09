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

## Development Commands

Run the TypeScript checker:

```bash
bun run typecheck
```

Run tests:

```bash
bun test
```

Run database migrations after the migration files exist:

```bash
bun run migrate
```

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

Shared code will live under `lib/`, GitHub-specific helpers under `bin/_github/`, and database migrations under `db/migrations/`.

Until the first TypeScript source file is added, `bun run typecheck` may report that `tsconfig.json` has no input files. That goes away once the planned `bin/`, `lib/`, or `tests/` TypeScript files are created.
