# shiplog setup guide

This guide is for people who want to fork shiplog and run it for their own profile README.

## 1. Fork the repository

Fork this repository into your GitHub account. The fork will run the bundled GitHub Actions workflows and publish the rendered README to whichever target repository you configure.

Install dependencies if you want to run commands locally:

```bash
bun install
```

## 2. Create a Postgres database

shiplog needs a Postgres database where the application role can create schema objects and read/write the data it owns. Neon is the intended hosted path, but any reachable Postgres database with schema creation permissions works.

Create a dedicated role and database as a Postgres admin user:

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

## 3. Build the config

Open the [shiplog config builder](https://shiplog.karanbalani.tech/config-builder/).

Use it to:

- enter your display name and GitHub username
- add collection sources
- add publish targets
- resolve public GitHub IDs in the browser
- copy `shiplog.config.json`
- copy the Base64 value for GitHub Actions
- see the exact environment variables your config needs

Save the generated JSON locally as `shiplog.config.json` if you want to run shiplog from your machine.

The real `shiplog.config.json` is gitignored. Commit `shiplog.config.example.json`, not your local config.

### Manual fallback

If you prefer to build the config by hand, copy the example:

```bash
cp shiplog.config.example.json shiplog.config.json
```

Common config fields:

- `profile.displayName`: name rendered in your profile README.
- `collect.accounts[0].tokenEnv`: usually `GH_RO_CLASSIC_TOKEN`.
- `collect.accounts[0].organizationPatTokens[]`: optional per-organization read tokens.
- `collect.accounts[0].ignore.organizations[]`: organization IDs to ignore.
- `collect.accounts[0].ignore.repositories[]`: repository IDs to ignore.
- `publish.targets[0].tokenEnv`: usually `GH_RW_REPO_TOKEN`.

shiplog stores stable GitHub node IDs in config. That keeps history together when users, organizations, or repositories are renamed. The config builder resolves public GitHub IDs for you. If it cannot resolve a private repository or restricted organization from the browser, it shows the `gh api` command to run with the right local token, then lets you paste the returned node ID back into the builder.

If you are building the config by hand, use the local identity helper commands:

Resolve your GitHub account:

```bash
bun run identity github <your-github-login>
```

Resolve a publish target:

```bash
bun run identity github publish-target <owner/repo>
```

Use the returned account object in `collect.accounts[0]`, and the returned publish target object in `publish.targets[0]`.

Optional ignore entries:

```bash
bun run identity github organization <org-login>
bun run identity github repository <owner/repo>
```

These helper lookups work without a token for public users, organizations, and repositories. Set `GH_RO_CLASSIC_TOKEN` locally when the lookup needs authenticated access, such as a private repository.

## 4. Configure GitHub Actions

Store the Base64 config as a repository variable named `SHIPLOG_CONFIG_BASE64`.

If you used the config builder, copy the Base64 value from the builder.

If you created `shiplog.config.json` manually, generate the value locally:

```bash
base64 < shiplog.config.json | tr -d '\n'
```

Required repository variable:

- `SHIPLOG_CONFIG_BASE64`

Required repository secrets:

- `DATABASE_CONNECTION_STRING`

Then create the GitHub token secrets listed by the config builder.

The default names are usually:

- `GH_RO_CLASSIC_TOKEN`: reads GitHub activity for ingestion.
- `GH_RW_REPO_TOKEN`: publishes the rendered README to configured targets.

If your config includes organization-specific read tokens or custom publish token names, create secrets with those exact names too.

Token scopes:

- Collection token: classic GitHub token with `read:user`, `read:org`, and `repo`.
- Publish token: GitHub token with write access to each configured publish target repository.

The `repo` scope is required if you want private repository activity.

The default workflows expose `GH_RW_REPO_TOKEN` to `bun run publish`. If a publish target uses a different `tokenEnv`, add that secret to the `Publish rendered README` step environment.

## 5. Run the first workflow

Run the `freshness` workflow once from GitHub Actions.

After the first run, the scheduled workflows keep recent activity current, make bounded historical progress, repair drift, render `rendered.md`, and publish to your configured target.

## Optional Local Verification

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

Use the exact token environment variable names from the config builder if you changed the defaults.

Then run:

```bash
bun run db:wait
bun run migrate
bun run init
bun run render
```

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

## More Reference

- [FAQ](docs/FAQ.md)
- [Schema](docs/SCHEMA.md)
- [GitHub mapping](docs/GITHUB_MAPPING.md)
- [Contributing](CONTRIBUTING.md)
