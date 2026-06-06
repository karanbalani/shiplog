# shiplog setup guide

This guide is for people who want to fork shiplog and run it for their own profile README.

## 1. Fork the repository

Fork this repository into your GitHub account. The fork will run the bundled GitHub Actions workflows and publish the rendered README to whichever target repository you configure.

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

<details>
<summary>Optional read-only role for Render Studio</summary>

If you use a browser-only tool such as shiplog Render Studio to preview README rendering against your database, create a separate read-only role. Do not use the migration/write role in browser tools.

Run this as a Postgres admin user or database owner:

```sql
CREATE ROLE shiplog_readonly LOGIN PASSWORD 'replace-with-a-strong-readonly-password';

GRANT CONNECT ON DATABASE shiplog TO shiplog_readonly;
GRANT USAGE ON SCHEMA public TO shiplog_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO shiplog_readonly;
```

The `GRANT SELECT ON ALL TABLES` line covers tables and views that already exist. Add default privileges too so future tables and views created by Shiplog migrations are automatically readable by `shiplog_readonly`. Run this while connected as the `shiplog` role used by `DATABASE_CONNECTION_STRING`:

```sql
ALTER DEFAULT PRIVILEGES IN SCHEMA public
GRANT SELECT ON TABLES TO shiplog_readonly;
```

Use this role only for read-only preview tools:

```bash
SHIPLOG_READONLY_DATABASE_CONNECTION_STRING=postgres://shiplog_readonly:replace-with-a-strong-readonly-password@host:5432/shiplog?sslmode=verify-full
```

Keep GitHub Actions on the normal `DATABASE_CONNECTION_STRING`; Shiplog workflows still need the write role for migrations, collection, maintenance, and publishing.

</details>

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
- see any organization-specific PAT variables needed for restricted organizations

The generated JSON is useful for review, but the GitHub Actions setup only needs the Base64 value and the environment variable list from the builder.

The real `shiplog.config.json` is gitignored. Commit `shiplog.config.example.json`, not your local config.

shiplog stores stable GitHub node IDs in config. That keeps history together when users, organizations, or repositories are renamed. The config builder resolves public GitHub IDs for you. If it cannot resolve a private repository or restricted organization from the browser, it shows the `gh api` command to run with the right local token, then lets you paste the returned node ID back into the builder.

<details>
<summary>Optional manual config fallback</summary>

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

Generate the Base64 workflow value from the local config:

```bash
base64 < shiplog.config.json | tr -d '\n'
```

</details>

## 4. Configure GitHub Actions

Store the Base64 config as a repository variable named `SHIPLOG_CONFIG_BASE64`.

Copy this value from the config builder.

Required repository variable:

- `SHIPLOG_CONFIG_BASE64`

Then create GitHub repository secrets for the token env names listed by the config builder.

The default names are usually:

- `GH_RO_CLASSIC_TOKEN`: reads GitHub activity for ingestion.
- `GH_RW_REPO_TOKEN`: publishes the rendered README to configured targets.

If your config includes organization-specific read tokens or custom publish token names, create repository secrets with those exact names too.

Required repository secrets:

- `DATABASE_CONNECTION_STRING`
- `GH_RO_CLASSIC_TOKEN`
- `GH_RW_REPO_TOKEN`
- any extra `tokenEnv` names from your config

Organization-specific PATs are for organizations where your default read token cannot see all required repositories. Add the organization in the config builder and create a repository secret with the env var name it gives you. The workflows read `shiplog.config.json`, export only the token names needed by the current job from GitHub's normal secrets context, and do not need per-organization edits.

Token scopes:

- Collection token: classic GitHub token with `read:user`, `read:org`, and `repo`.
- Publish token: GitHub token with write access to each configured publish target repository.

The `repo` scope is required if you want private repository activity.

The `publish` workflow exports publish token names from config before rendering and publishing. If a publish target uses a different `tokenEnv`, create a repository secret with that name; no workflow edit is needed.

## 5. Optional: Customize README rendering

By default, shiplog uses the fallback render config committed in this repository at `.shiplog/render.json`.

To customize the generated README, add a render config to the target profile repository:

```text
target-profile-repo/
  .shiplog/
    render.json
  README.md
```

The target `.shiplog/render.json` defines SQL queries and Markdown blocks. During publish, Shiplog renders each configured target independently in its own GitHub Actions matrix job: if that target repository has `.shiplog/render.json`, Shiplog uses it; otherwise Shiplog uses the fallback config bundled in this repository. The generated content is published back to the configured target path. If one target fails, the other target jobs keep running; the workflow still reports a failure so the broken target is visible.

Example block shape:

```json
{
  "version": 1,
  "queries": {
    "repositories": {
      "mode": "many",
      "sql": "SELECT r.full_name, r.web_url, SUM(d.commits)::int AS commits FROM daily_repository_activity d JOIN repositories r ON r.id = d.repository_id GROUP BY r.id, r.full_name, r.web_url ORDER BY commits DESC LIMIT 10"
    }
  },
  "markdown": [
    {
      "type": "heading",
      "level": 1,
      "text": "Hi, I'm {{ profile.displayName }}"
    },
    {
      "type": "table",
      "query": "repositories",
      "columns": [
        { "label": "Repository", "value": "[{{ full_name }}]({{ web_url }})" },
        { "label": "Commits", "value": "{{ commits }}" }
      ]
    }
  ]
}
```

Render queries are plain read-only Postgres SQL against your Shiplog tables. Use normal SQL for filtering, such as querying `accounts` for one account or using `CURRENT_DATE - INTERVAL '365 days'` for recent activity. Shiplog automatically appends this footer to every rendered README: `<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>`. See [docs/RENDER_CONFIG.md](docs/RENDER_CONFIG.md) for examples and [schemas/render.config.schema.json](schemas/render.config.schema.json) for the full config shape.

## 6. Run the first workflow

Run the `freshness` workflow once from GitHub Actions to migrate the database, initialize the configured accounts, and collect current activity.

After the first run, the scheduled workflows keep recent activity current, make bounded historical progress, repair drift, and publish one rendered README snapshot per day. If you want to publish immediately after the first collection, run `publish` manually once.

<details>
<summary>Optional local verification</summary>

Local verification is optional. The default setup path is GitHub Actions first.

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
# GH_RO_ACME_PAT_TOKEN=github_pat_xxx
```

Use the exact token environment variable names from the config builder if you changed the defaults.

Then run:

```bash
bun run db:wait
bun run migrate
bun run init
bun run render
```

</details>

## Workflows

- `freshness`: runs every 6 hours. Migrates, initializes accounts, collects recent activity, and runs queued maintenance.
- `history`: runs every 2 hours. Makes bounded historical progress with deep-mode defaults.
- `integrity`: runs daily. Detects drift, queues repair work, and runs maintenance.
- `publish`: runs daily. Builds a target matrix, renders each configured publish target from the current database state, and publishes only when that target content changed.
- `housekeeping`: runs daily. Prunes diagnostic `error_events` older than 30 days.
- `ci`: runs formatting, linting, typechecking, and tests on pull requests and pushes to `main`.

Historical work is progressive. If a history run pauses because of repository or time budget, the workflow still succeeds and resumes remaining work later.
If a workflow records diagnostic error events, its GitHub Actions summary includes the event id and copyable SQL for querying the full JSON payload.

<details>
<summary>Optional local commands</summary>

```bash
bun run init
bun run backfill
bun run collect
bun run drift
bun run maintenance
bun run errors:prune
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

</details>

## More Reference

- [FAQ](docs/FAQ.md)
- [Schema](docs/SCHEMA.md)
- [GitHub mapping](docs/GITHUB_MAPPING.md)
- [Contributing](CONTRIBUTING.md)
