# shiplog Conventions

This document captures project conventions that should stay consistent across implementation tasks.

## Runtime And Tooling

- Use Bun for package management, script execution, and tests.
- Use TypeScript with `strict: true`.
- Use dbmate for database migrations.
- Keep Git hooks repo-local in `.githooks/` and install them with `bun run hooks:install`.
- Commit messages must be Conventional Commits.
- Commit messages must use lowercase letters only.

## Formatting

- Run `bun run format` before large handoffs.
- Run `bun run format:check` before committing.
- Prettier formats TypeScript, JSON, Markdown, YAML, and other supported text files.
- `sql-formatter` formats SQL migrations.
- SQL migrations are excluded from Prettier so only one formatter owns SQL layout.

## Migrations

- Use one migration file per table or view.
- Migration filenames must follow `<timestamp>_<up_action>_<object_type>_<object_name>.sql`.
- The filename describes the `-- migrate:up` operation; the reverse belongs inside `-- migrate:down`.
- Do not repeat object prefixes in the filename when the object type already communicates them. For example, use `create_view_monthly_repository_activity.sql` for a view named `v_monthly_repository_activity`.
- Examples:
  - `20260507120000_create_table_users.sql`
  - `20260507120014_create_view_monthly_repository_activity.sql`
  - `20260507120030_create_materialized_view_monthly_repository_activity.sql`
  - `20260507120031_alter_table_accounts_add_timezone.sql`
  - `20260507120032_create_index_repositories_provider_owner.sql`
- Every migration must contain explicit `-- migrate:up` and `-- migrate:down` sections.
- Table migrations should include table-specific indexes in the same file.
- Prefer small, reviewable migrations over large bundled schema files.

## Schema Naming

- Prefer full words over abbreviations in schema object names.
- Use `organizations`, not `orgs`.
- Use `repositories`, not `repos`.
- Use `account_id` for foreign keys to `accounts`.
- Use `organization_id` and `repository_id` for foreign keys.
- Use `pull_request` in table and column names instead of `pr`, except metric columns already established as `prs_*` and `pr_reviews_*` in rollups.

## Domain Language

- A `user` is the human profile owner.
- An `account` is one provider account owned by a user.
- A `provider` is an external forge, for example `github`.
- `external_*` columns store values owned by the provider.
- An `organization` is a provider-side organization or group namespace.
- A `repository` is a provider-side source repository.
- A `snapshot` is observed state on a date.
- An `event` is point-in-time activity such as a commit, pull request, review, or issue.
- A `rollup` or `fact` is derived aggregate data such as `daily_repository_activity`.
- A `row` type is a database-read shape and should use snake_case column names.
- A `config` type describes `profile-config.json` or another user-authored config file.

## TypeScript Types

- Shared types live under `lib/types/`.
- Re-export public shared types from `lib/types/index.ts`.
- Domain enums live in `lib/types/domain/`.
- Config types live in `lib/types/config/`.
- Database row and view types live under `lib/types/db/`, with one file per type.
- Vendor runner contracts live in `lib/types/vendor/`.
- Use `*Row` for database-returned shapes.
- Define write-input types near the code that writes data, then promote them to shared types only when multiple modules need them.
- Avoid `Record` as a domain suffix because TypeScript already has `Record<K, V>`.

## Config

- User-authored JSON config is validated with JSON Schema.
- JSON schemas live under `schemas/`.
- Keep `schemas/profile-config.schema.json` as the source of truth for `profile-config.json` validation.
- The upstream org/template repo should commit `profile-config.example.json`, not a real `profile-config.json`.
- Personal forks or generated instances may commit their own `profile-config.json`; config must not contain secrets.
- Keep `lib/types/config/` aligned with the schema return shape.
- Keep `lib/config.ts` focused on loading, schema validation, default application, and typed return values.

## Utilities

- Generic helpers live under `lib/utils/`.
- Keep `lib/utils/` limited to helpers with no project-domain ownership, such as date or string utilities.
- Move domain-specific behavior into the relevant domain module instead of growing a generic utility module.
- Infrastructure modules such as `lib/db.ts` and `lib/http.ts` should live at the `lib/` root.

## Logging

- CLI status logs should use `lib/logger.ts`.
- Logs write to stderr so stdout stays available for command output.
- Logger output includes ISO timestamps and level labels.
- Supported levels are `debug`, `info`, `warn`, `error`, and `silent`.
- `SHIPLOG_LOG_LEVEL` controls runtime verbosity.
- `NO_COLOR=1` disables ANSI colors.

## Provider Neutrality

- Keep the schema provider-neutral.
- Keep `provider` as the provider key, for example `github`.
- Use `external_*` for IDs, logins, URLs, and timestamps that come from a provider.
- Do not use GitHub-specific names such as `node_id` in core schema columns.
- Provider-specific helpers live under `lib/providers/<provider>/`.
- Provider-specific collectors own translation into generic schema columns.
- Document vendor-specific field mapping in `docs/GITHUB_MAPPING.md`.

## Timestamp Semantics

- `created_at` and `updated_at` are database audit columns.
- `first_seen_on`, `last_seen_on`, `observed_on`, and `captured_on` describe shiplog observation or snapshot dates.
- Event timestamps such as `committed_at`, `submitted_at`, and `external_created_at` describe source-provider activity.
- Application upserts should set `updated_at = now()` on update paths.

## Tables

- Every table should have `created_at` and `updated_at`.
- Keep raw event provenance with `source` where useful.
- Keep `source` on `daily_*` tables as cheap provenance for generated or provider-reported facts.
- `daily_repository_activity` is a derived fact table from raw events.
- `daily_user_summary` stores provider-reported contribution totals that may not map one-to-one to raw event rows.

## Views

- Use `v_*` prefix for plain views.
- Use `mv_*` prefix for materialized views.
- Do not use a trailing `_v` suffix; reserve suffixes such as `_v2` for future versioning.
- Views are read-only projections and should be documented in `docs/SCHEMA.md`.

## Documentation

- Update `README.md` when user-facing setup or commands change.
- Update `docs/SCHEMA.md` when schema objects or columns change.
- Update `docs/GITHUB_MAPPING.md` when GitHub collector field mapping changes.
- Keep docs in sync with migrations before committing.
