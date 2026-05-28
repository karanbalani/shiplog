# shiplog Schema

This document explains the v1 Postgres schema. Tables and views are created by dbmate migrations in `db/migrations/`, with one schema object per migration file.

## Timestamp Semantics

shiplog uses three timestamp/date families:

- `created_at` and `updated_at` are database audit columns. They describe when shiplog created or last updated the row.
- `first_seen_on`, `last_seen_on`, `observed_on`, and `captured_on` describe shiplog's observation or snapshot dates.
- Provider and event timestamps, such as `external_created_at`, `committed_at`, and `submitted_at`, describe when something happened on the source provider.

`created_at` and `updated_at` default to `now()` on insert. Application upserts should set `updated_at = now()` on update paths.

Every table has an `id BIGSERIAL PRIMARY KEY` row identity. Natural grains and deduplication rules are enforced separately with `UNIQUE (...)` constraints.

## users

One row per human profile owner. v1 normally has exactly one user row, but the schema keeps users separate from provider identities so future versions can support multiple forges.

| Column         | Type          | Notes                                                                       |
| -------------- | ------------- | --------------------------------------------------------------------------- |
| `id`           | `BIGSERIAL`   | Primary key.                                                                |
| `display_name` | `TEXT`        | Optional human-readable name rendered into the profile README.              |
| `created_at`   | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`   | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

## accounts

One row per external forge account connected to a user, such as a GitHub account.

| Column                       | Type          | Notes                                                                                                           |
| ---------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`                         | `BIGSERIAL`   | Primary key.                                                                                                    |
| `user_id`                    | `BIGINT`      | Required reference to `users.id`.                                                                               |
| `provider`                   | `TEXT`        | Provider key. Must be one of `github`, `gitlab`, `bitbucket`, or `gitea`. v1 only implements GitHub collection. |
| `external_login`             | `TEXT`        | Current account login on the provider, for example a GitHub username. Mutable; not used as the durable key.     |
| `external_id`                | `TEXT`        | Stable provider-side account id. GitHub maps its GraphQL node id here.                                          |
| `external_url`               | `TEXT`        | Optional profile URL on the provider.                                                                           |
| `external_created_at`        | `TIMESTAMPTZ` | Provider-side account creation timestamp. Used for historical collection bounds and account age rendering.      |
| `first_seen_on`              | `DATE`        | Date shiplog first observed this identity.                                                                      |
| `last_successful_collect_on` | `DATE`        | Latest target date successfully collected for this account. Used by `bun run collect` to catch up missed days.  |
| `captured_at`                | `TIMESTAMPTZ` | Timestamp when this identity row was captured or refreshed. Defaults to `now()`.                                |
| `created_at`                 | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.                                         |
| `updated_at`                 | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`.                                     |

Constraints and indexes:

- `UNIQUE (user_id, provider)` allows one account per provider per user in v1.
- `UNIQUE (provider, external_id)` deduplicates accounts by stable provider id.
- `idx_accounts_user` speeds lookups by `user_id`.

Collection checkpoint:

- When `last_successful_collect_on` is null, automatic collect runs the complete historical collection path.
- After the first complete collection, automatic collect runs process every date from `last_successful_collect_on + 1` through UTC yesterday, then reprocess the recent `collect.lookbackDays` window.
- `last_successful_collect_on` is advanced after successful automatic collection.
- Manual `COLLECT_DATE`, or `COLLECT_FROM` plus `COLLECT_TO`, reprocesses requested repair dates without advancing the checkpoint, and safely dedupes on rerun.
- Manual `DRIFT_CHECK_FROM` plus `DRIFT_CHECK_TO` compares stored daily account-level contribution totals with fresh provider totals, then reprocesses only missing or mismatched dates without advancing the checkpoint.

## profile_snapshots

Daily account-level profile metrics for a provider identity.

| Column               | Type          | Notes                                                                       |
| -------------------- | ------------- | --------------------------------------------------------------------------- |
| `id`                 | `BIGSERIAL`   | Primary key.                                                                |
| `account_id`         | `BIGINT`      | Required reference to `accounts.id`.                                        |
| `captured_on`        | `DATE`        | Snapshot date.                                                              |
| `followers_count`    | `INT`         | Follower count on that date, when available.                                |
| `following_count`    | `INT`         | Following count on that date, when available.                               |
| `public_repos_count` | `INT`         | Public repository count on that date, when available.                       |
| `created_at`         | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`         | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (account_id, captured_on)` stores one profile snapshot per account per date.

## organizations

Provider organizations seen through repositories or provider metadata.

| Column           | Type          | Notes                                                                       |
| ---------------- | ------------- | --------------------------------------------------------------------------- |
| `id`             | `BIGSERIAL`   | Primary key.                                                                |
| `provider`       | `TEXT`        | Provider key, such as `github`.                                             |
| `external_id`    | `TEXT`        | Stable provider-side organization id. GitHub maps its GraphQL node id here. |
| `external_login` | `TEXT`        | Current organization login or slug on the provider. Mutable across renames. |
| `display_name`   | `TEXT`        | Optional organization display name.                                         |
| `description`    | `TEXT`        | Optional organization description.                                          |
| `avatar_url`     | `TEXT`        | Optional avatar image URL.                                                  |
| `website_url`    | `TEXT`        | Optional website URL.                                                       |
| `first_seen_on`  | `DATE`        | First date shiplog observed the org.                                        |
| `last_seen_on`   | `DATE`        | Most recent date shiplog observed the org.                                  |
| `created_at`     | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`     | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (provider, external_id)` deduplicates organizations by stable provider id.

## repositories

Repository dimension table. This stores stable repository metadata, not daily metrics.

| Column                | Type          | Notes                                                                                    |
| --------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| `id`                  | `BIGSERIAL`   | Primary key.                                                                             |
| `provider`            | `TEXT`        | Provider key, such as `github`.                                                          |
| `external_id`         | `TEXT`        | Stable provider-side repository id. GitHub maps its GraphQL node id here.                |
| `stable_key`          | `TEXT`        | Internal stable unique key derived from provider identity for durable references.        |
| `organization_id`     | `BIGINT`      | Optional reference to `organizations.id` when the repository belongs to an organization. |
| `owner_login`         | `TEXT`        | Repository owner login.                                                                  |
| `name`                | `TEXT`        | Repository name without owner.                                                           |
| `full_name`           | `TEXT`        | Provider full name, for example `owner/repo`.                                            |
| `web_url`             | `TEXT`        | Repository web URL.                                                                      |
| `description`         | `TEXT`        | Repository description.                                                                  |
| `visibility`          | `TEXT`        | Must be `public`, `private`, or `unknown`.                                               |
| `is_fork`             | `BOOLEAN`     | Whether the repository is a fork, when known.                                            |
| `is_archived`         | `BOOLEAN`     | Whether the repository is archived, when known.                                          |
| `primary_language`    | `TEXT`        | Provider-reported primary language, when available.                                      |
| `default_branch`      | `TEXT`        | Default branch name, when available.                                                     |
| `external_created_at` | `TIMESTAMPTZ` | Provider-side repository creation timestamp.                                             |
| `external_pushed_at`  | `TIMESTAMPTZ` | Provider-side latest pushed timestamp.                                                   |
| `first_seen_on`       | `DATE`        | First date shiplog observed the repository.                                              |
| `last_seen_on`        | `DATE`        | Most recent date shiplog observed the repository.                                        |
| `redacted`            | `BOOLEAN`     | True when details should be hidden. Defaults to `false`.                                 |
| `created_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.                  |
| `updated_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`.              |

Constraints and indexes:

- `UNIQUE (stable_key)` keeps the internal key durable and unique.
- `UNIQUE (provider, external_id)` deduplicates repositories by stable provider id.
- `idx_repositories_organization` speeds organization rollups.
- `idx_repositories_provider_owner` speeds provider-owner lookups.

## repository_snapshots

Daily or periodic repository metrics that change over time.

| Column          | Type          | Notes                                                                       |
| --------------- | ------------- | --------------------------------------------------------------------------- |
| `id`            | `BIGSERIAL`   | Primary key.                                                                |
| `repository_id` | `BIGINT`      | Required reference to `repositories.id`.                                    |
| `captured_on`   | `DATE`        | Snapshot date.                                                              |
| `star_count`    | `INT`         | Star count on the snapshot date.                                            |
| `fork_count`    | `INT`         | Fork count on the snapshot date.                                            |
| `is_archived`   | `BOOLEAN`     | Archived state on the snapshot date.                                        |
| `visibility`    | `TEXT`        | Visibility on the snapshot date.                                            |
| `created_at`    | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`    | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (repository_id, captured_on)` stores one snapshot per repository per date.

## repository_languages

Language breakdown snapshots for repositories.

| Column          | Type           | Notes                                                                       |
| --------------- | -------------- | --------------------------------------------------------------------------- |
| `id`            | `BIGSERIAL`    | Primary key.                                                                |
| `repository_id` | `BIGINT`       | Required reference to `repositories.id`.                                    |
| `captured_on`   | `DATE`         | Snapshot date.                                                              |
| `language`      | `TEXT`         | Language name as reported by the provider.                                  |
| `bytes`         | `BIGINT`       | Number of bytes attributed to the language.                                 |
| `percentage`    | `NUMERIC(7,4)` | Fraction of repository language bytes, stored from `0.0000` to `1.0000`.    |
| `created_at`    | `TIMESTAMPTZ`  | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`    | `TIMESTAMPTZ`  | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (repository_id, captured_on, language)` stores one language entry per repository per snapshot date.

## commits

Individual commits attributed to an account.

| Column             | Type          | Notes                                                                       |
| ------------------ | ------------- | --------------------------------------------------------------------------- |
| `id`               | `BIGSERIAL`   | Primary key.                                                                |
| `account_id`       | `BIGINT`      | Required reference to `accounts.id`.                                        |
| `oid`              | `TEXT`        | Commit object id, such as a Git SHA.                                        |
| `repository_id`    | `BIGINT`      | Required reference to `repositories.id`.                                    |
| `committed_on`     | `DATE`        | Commit date in UTC. Used for daily rollups.                                 |
| `committed_at`     | `TIMESTAMPTZ` | Exact commit timestamp.                                                     |
| `additions`        | `INT`         | Lines added, when available.                                                |
| `deletions`        | `INT`         | Lines deleted, when available.                                              |
| `changed_files`    | `INT`         | Number of changed files, when available.                                    |
| `message_headline` | `TEXT`        | First line of the commit message.                                           |
| `is_co_authored`   | `BOOLEAN`     | True when the account was credited through a GitHub co-author entry.        |
| `source`           | `TEXT`        | Must be `live`, `self_backfill`, or `external_import`.                      |
| `captured_at`      | `TIMESTAMPTZ` | Timestamp when shiplog captured the row. Defaults to `now()`.               |
| `created_at`       | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`       | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints and indexes:

- `UNIQUE (account_id, oid)` deduplicates commits for an account.
- `idx_commits_account_date` speeds account/day lookups.
- `idx_commits_repository_date` speeds repository/day rollups.

## pull_requests

Pull requests authored by a provider identity.

| Column                | Type          | Notes                                                                       |
| --------------------- | ------------- | --------------------------------------------------------------------------- |
| `id`                  | `BIGSERIAL`   | Primary key.                                                                |
| `account_id`          | `BIGINT`      | Required reference to `accounts.id`.                                        |
| `external_id`         | `TEXT`        | Stable provider-side pull request id. GitHub REST maps `node_id` here.      |
| `repository_id`       | `BIGINT`      | Required reference to `repositories.id`.                                    |
| `number`              | `INT`         | Repository-local pull request number.                                       |
| `title`               | `TEXT`        | Pull request title.                                                         |
| `web_url`             | `TEXT`        | Pull request web URL.                                                       |
| `state`               | `TEXT`        | Must be `OPEN`, `CLOSED`, or `MERGED`.                                      |
| `external_created_at` | `TIMESTAMPTZ` | Provider-side pull request creation timestamp.                              |
| `external_merged_at`  | `TIMESTAMPTZ` | Provider-side merge timestamp, if merged.                                   |
| `external_closed_at`  | `TIMESTAMPTZ` | Provider-side close timestamp, if closed.                                   |
| `additions`           | `INT`         | Lines added, when available.                                                |
| `deletions`           | `INT`         | Lines deleted, when available.                                              |
| `changed_files`       | `INT`         | Number of changed files, when available.                                    |
| `commits_count`       | `INT`         | Number of commits in the pull request, when available.                      |
| `source`              | `TEXT`        | Must be `live`, `self_backfill`, or `external_import`.                      |
| `captured_at`         | `TIMESTAMPTZ` | Timestamp when shiplog captured the row. Defaults to `now()`.               |
| `created_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints and indexes:

- `UNIQUE (repository_id, number)` deduplicates pull requests within a repository.
- `UNIQUE (account_id, external_id)` deduplicates provider-side pull requests for an account.
- `idx_pull_requests_account_external_created` speeds account/provider-created-at lookups.

## pull_request_reviews

Pull request reviews submitted by a provider identity.

| Column            | Type          | Notes                                                                            |
| ----------------- | ------------- | -------------------------------------------------------------------------------- |
| `id`              | `BIGSERIAL`   | Primary key.                                                                     |
| `account_id`      | `BIGINT`      | Required reference to `accounts.id`.                                             |
| `external_id`     | `TEXT`        | Stable provider-side review id. GitHub REST maps `node_id` here.                 |
| `pull_request_id` | `BIGINT`      | Optional reference to `pull_requests.id` when the reviewed PR is known locally.  |
| `repository_id`   | `BIGINT`      | Required reference to `repositories.id`.                                         |
| `state`           | `TEXT`        | Must be `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, or `PENDING`. |
| `submitted_at`    | `TIMESTAMPTZ` | Exact review submission timestamp.                                               |
| `submitted_on`    | `DATE`        | Review submission date in UTC. Used for daily rollups.                           |
| `source`          | `TEXT`        | Must be `live`, `self_backfill`, or `external_import`.                           |
| `captured_at`     | `TIMESTAMPTZ` | Timestamp when shiplog captured the row. Defaults to `now()`.                    |
| `created_at`      | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.          |
| `updated_at`      | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`.      |

Constraints and indexes:

- `UNIQUE (account_id, external_id)` deduplicates reviews for an account.
- `idx_pull_request_reviews_account_date` speeds account/day lookups.

## issues

Issues authored by a provider identity.

| Column                | Type          | Notes                                                                       |
| --------------------- | ------------- | --------------------------------------------------------------------------- |
| `id`                  | `BIGSERIAL`   | Primary key.                                                                |
| `account_id`          | `BIGINT`      | Required reference to `accounts.id`.                                        |
| `external_id`         | `TEXT`        | Stable provider-side issue id. GitHub REST maps `node_id` here.             |
| `repository_id`       | `BIGINT`      | Required reference to `repositories.id`.                                    |
| `number`              | `INT`         | Repository-local issue number.                                              |
| `title`               | `TEXT`        | Issue title.                                                                |
| `web_url`             | `TEXT`        | Issue web URL.                                                              |
| `state`               | `TEXT`        | Must be `OPEN` or `CLOSED`.                                                 |
| `external_created_at` | `TIMESTAMPTZ` | Provider-side issue creation timestamp.                                     |
| `external_closed_at`  | `TIMESTAMPTZ` | Provider-side issue close timestamp, if closed.                             |
| `source`              | `TEXT`        | Must be `live`, `self_backfill`, or `external_import`.                      |
| `captured_at`         | `TIMESTAMPTZ` | Timestamp when shiplog captured the row. Defaults to `now()`.               |
| `created_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`          | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (repository_id, number)` deduplicates issues within a repository.
- `UNIQUE (account_id, external_id)` deduplicates provider-side issues for an account.

## daily_repository_activity

Daily fact table rolled up from commits, pull requests, reviews, and issues by account, date, and repository.

| Column                         | Type          | Notes                                                                       |
| ------------------------------ | ------------- | --------------------------------------------------------------------------- |
| `id`                           | `BIGSERIAL`   | Primary key.                                                                |
| `account_id`                   | `BIGINT`      | Required reference to `accounts.id`.                                        |
| `activity_on`                  | `DATE`        | Activity date in UTC.                                                       |
| `repository_id`                | `BIGINT`      | Required reference to `repositories.id`.                                    |
| `commits`                      | `INT`         | Number of commits. Defaults to `0`.                                         |
| `lines_added`                  | `INT`         | Total added lines from commits, when available.                             |
| `lines_deleted`                | `INT`         | Total deleted lines from commits, when available.                           |
| `files_changed`                | `INT`         | Total changed files from commits, when available.                           |
| `prs_opened`                   | `INT`         | Pull requests opened on this date. Defaults to `0`.                         |
| `prs_merged`                   | `INT`         | Pull requests merged on this date. Defaults to `0`.                         |
| `prs_closed_unmerged`          | `INT`         | Pull requests closed without merge on this date. Defaults to `0`.           |
| `pr_reviews_total`             | `INT`         | Reviews submitted on this date. Defaults to `0`.                            |
| `pr_reviews_approved`          | `INT`         | Approved reviews submitted on this date.                                    |
| `pr_reviews_changes_requested` | `INT`         | Change-request reviews submitted on this date.                              |
| `pr_reviews_commented`         | `INT`         | Comment-only reviews submitted on this date.                                |
| `issues_opened`                | `INT`         | Issues opened on this date. Defaults to `0`.                                |
| `issues_closed`                | `INT`         | Issues closed on this date. Defaults to `0`.                                |
| `source`                       | `TEXT`        | Must be `live_rollup`, `self_backfill`, or `external_import`.               |
| `captured_at`                  | `TIMESTAMPTZ` | Timestamp when shiplog captured or refreshed the row. Defaults to `now()`.  |
| `created_at`                   | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.     |
| `updated_at`                   | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`. |

Constraints:

- `UNIQUE (account_id, activity_on, repository_id)` stores one daily fact row per account, date, and repository.

## daily_user_summary

Daily provider-level contribution totals from the provider API. This captures totals that may include private or restricted contributions not visible as individual events.

| Column                                    | Type          | Notes                                                                                     |
| ----------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| `id`                                      | `BIGSERIAL`   | Primary key.                                                                              |
| `account_id`                              | `BIGINT`      | Required reference to `accounts.id`.                                                      |
| `activity_on`                             | `DATE`        | Activity date. Historical collect uses year-start sentinel dates for yearly summary rows. |
| `total_commit_contributions`              | `INT`         | Provider-reported commit contribution count.                                              |
| `total_pull_request_contributions`        | `INT`         | Provider-reported pull request contribution count.                                        |
| `total_pull_request_review_contributions` | `INT`         | Provider-reported pull request review contribution count.                                 |
| `total_issue_contributions`               | `INT`         | Provider-reported issue contribution count.                                               |
| `restricted_contributions_count`          | `INT`         | Provider-reported private or restricted contribution count.                               |
| `source`                                  | `TEXT`        | Must be `live`, `self_backfill`, or `external_import`.                                    |
| `captured_at`                             | `TIMESTAMPTZ` | Timestamp when shiplog captured or refreshed the row. Defaults to `now()`.                |
| `created_at`                              | `TIMESTAMPTZ` | Audit timestamp for when shiplog inserted the row. Defaults to `now()`.                   |
| `updated_at`                              | `TIMESTAMPTZ` | Audit timestamp for when shiplog last updated the row. Defaults to `now()`.               |

Constraints:

- `UNIQUE (account_id, activity_on)` stores one summary row per account per activity date.

## Relationship Summary

- `users` owns `accounts`.
- `accounts` owns profile snapshots and all user-attributed event/fact rows.
- `organizations` can own `repositories`.
- `repositories` owns repository snapshots, language snapshots, and all repository-scoped event/fact rows.
- Raw event tables are `commits`, `pull_requests`, `pull_request_reviews`, and `issues`.
- `daily_repository_activity` is a rollup of raw event tables.
- `daily_user_summary` stores provider-reported contribution totals that may not map one-to-one to raw event rows.

## Views

Views are read-only projections over the base tables. They are created by dedicated dbmate migrations after the tables they depend on.

| View                            | Purpose                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `v_monthly_repository_activity` | Aggregates `daily_repository_activity` by account, `month_start`, and repository.            |
| `v_yearly_repository_activity`  | Aggregates `daily_repository_activity` by account, year, and repository.                     |
| `v_organization_activity`       | Aggregates account activity by year and organization through `repositories.organization_id`. |
| `v_language_activity`           | Aggregates account activity by year and repository primary language.                         |
| `v_user_yearly_activity`        | Aggregates account activity up to the human `users` level by year.                           |
