# GitHub Mapping

shiplog keeps the database schema provider-neutral. GitHub-specific collectors translate GitHub GraphQL and REST fields into the generic schema columns described in `docs/SCHEMA.md`.

This document records that translation.

## accounts

| shiplog column        | GitHub source            | Notes                                         |
| --------------------- | ------------------------ | --------------------------------------------- |
| `provider`            | literal `github`         | Identifies the source provider.               |
| `external_login`      | GraphQL `user.login`     | Current GitHub username.                      |
| `external_id`         | GraphQL `user.id`        | GitHub's global GraphQL node id for the user. |
| `external_url`        | GraphQL `user.url`       | GitHub profile URL.                           |
| `external_created_at` | GraphQL `user.createdAt` | GitHub account creation timestamp.            |

## organizations

| shiplog column   | GitHub source                          | Notes                                                      |
| ---------------- | -------------------------------------- | ---------------------------------------------------------- |
| `provider`       | literal `github`                       | Identifies the source provider.                            |
| `external_id`    | GraphQL repository owner `id`          | GitHub's global GraphQL node id for an organization owner. |
| `external_login` | GraphQL repository owner `login`       | GitHub organization login.                                 |
| `display_name`   | GraphQL repository owner `name`        | Optional display name.                                     |
| `description`    | GraphQL repository owner `description` | Optional organization description.                         |
| `avatar_url`     | GraphQL repository owner `avatarUrl`   | Optional avatar URL.                                       |
| `website_url`    | GraphQL repository owner `websiteUrl`  | Optional website URL.                                      |

## repositories

| shiplog column        | GitHub source                                            | Notes                                                                            |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `provider`            | literal `github`                                         | Identifies the source provider.                                                  |
| `external_id`         | GraphQL repository `id`                                  | GitHub's global GraphQL node id for the repository.                              |
| `stable_key`          | derived by shiplog                                       | Internal durable key derived from provider and external id.                      |
| `owner_login`         | GraphQL `repository.owner.login`                         | Repository owner login.                                                          |
| `name`                | GraphQL `repository.name` or parsed from `nameWithOwner` | Repository name without owner.                                                   |
| `full_name`           | GraphQL `repository.nameWithOwner`                       | GitHub `owner/repo` name.                                                        |
| `web_url`             | GraphQL `repository.url`                                 | Repository web URL.                                                              |
| `description`         | GraphQL `repository.description`                         | Optional repository description.                                                 |
| `visibility`          | GraphQL `repository.isPrivate`                           | Maps to `private` when true, otherwise `public`; use `unknown` when unavailable. |
| `is_fork`             | GraphQL `repository.isFork`                              | Fork flag.                                                                       |
| `is_archived`         | GraphQL `repository.isArchived`                          | Archived flag.                                                                   |
| `primary_language`    | GraphQL `repository.primaryLanguage.name`                | Optional primary language.                                                       |
| `default_branch`      | GraphQL `repository.defaultBranchRef.name`               | Optional default branch name.                                                    |
| `external_created_at` | GraphQL `repository.createdAt`                           | GitHub repository creation timestamp.                                            |
| `external_pushed_at`  | GraphQL `repository.pushedAt`                            | GitHub latest pushed timestamp.                                                  |

## repository_snapshots

| shiplog column | GitHub source                       | Notes                                                                              |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| `star_count`   | GraphQL `repository.stargazerCount` | GitHub calls stars "stargazers" in GraphQL. shiplog stores the generic star count. |
| `fork_count`   | GraphQL `repository.forkCount`      | Repository fork count.                                                             |
| `is_archived`  | GraphQL `repository.isArchived`     | Archived flag at snapshot time.                                                    |
| `visibility`   | GraphQL `repository.isPrivate`      | Maps to `private` when true, otherwise `public`; use `unknown` when unavailable.   |

## repository_languages

| shiplog column | GitHub source                                    | Notes                                                                           |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| `language`     | GraphQL `repository.languages.edges[].node.name` | Language name.                                                                  |
| `bytes`        | GraphQL `repository.languages.edges[].size`      | Number of bytes GitHub attributes to the language.                              |
| `percentage`   | computed by shiplog                              | `bytes / total_language_bytes`, stored as a fraction from `0.0000` to `1.0000`. |

## commits

| shiplog column     | GitHub source                     | Notes                                                                       |
| ------------------ | --------------------------------- | --------------------------------------------------------------------------- |
| `oid`              | GraphQL commit `oid`              | Git object id.                                                              |
| `committed_at`     | GraphQL commit `committedDate`    | Exact commit timestamp.                                                     |
| `committed_on`     | derived from `committedDate`      | UTC date portion used for daily rollups.                                    |
| `additions`        | GraphQL commit `additions`        | Lines added.                                                                |
| `deletions`        | GraphQL commit `deletions`        | Lines deleted.                                                              |
| `changed_files`    | GraphQL commit `changedFiles`     | Number of changed files.                                                    |
| `message_headline` | GraphQL commit `messageHeadline`  | First line of the commit message.                                           |
| `is_co_authored`   | GraphQL commit `author`/`authors` | True when the account appears in `authors` but is not the primary `author`. |

## pull_requests

| shiplog column        | GitHub source                                       | Notes                                                  |
| --------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| `external_id`         | REST `node_id` or GraphQL pull request `id`         | Stable GitHub global node id for the pull request.     |
| `number`              | REST/GraphQL pull request `number`                  | Repository-local pull request number.                  |
| `title`               | REST/GraphQL pull request `title`                   | Pull request title.                                    |
| `web_url`             | REST `html_url` or GraphQL `url`                    | Pull request web URL.                                  |
| `state`               | REST `state` plus merge state, or GraphQL `state`   | Maps to `OPEN`, `CLOSED`, or `MERGED`.                 |
| `external_created_at` | REST `created_at` or GraphQL `createdAt`            | Pull request creation timestamp.                       |
| `external_merged_at`  | REST `pull_request.merged_at` or GraphQL `mergedAt` | Pull request merge timestamp, if merged.               |
| `external_closed_at`  | REST `closed_at` or GraphQL `closedAt`              | Pull request close timestamp, if closed.               |
| `additions`           | GraphQL pull request `additions`                    | Lines added, when available.                           |
| `deletions`           | GraphQL pull request `deletions`                    | Lines deleted, when available.                         |
| `changed_files`       | GraphQL pull request `changedFiles`                 | Number of changed files, when available.               |
| `commits_count`       | GraphQL pull request commit connection `totalCount` | Number of commits in the pull request, when available. |

## pull_request_reviews

| shiplog column    | GitHub source                                | Notes                                                                            |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `external_id`     | REST review `node_id` or GraphQL review `id` | Stable GitHub global node id for the review.                                     |
| `pull_request_id` | resolved by shiplog                          | Internal reference when the reviewed pull request is known locally.              |
| `state`           | REST/GraphQL review `state`                  | Maps to `APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`, `DISMISSED`, or `PENDING`. |
| `submitted_at`    | REST `submitted_at` or GraphQL `submittedAt` | Exact review submission timestamp.                                               |
| `submitted_on`    | derived from submitted timestamp             | UTC date portion used for daily rollups.                                         |

## issues

| shiplog column        | GitHub source                              | Notes                                       |
| --------------------- | ------------------------------------------ | ------------------------------------------- |
| `external_id`         | REST issue `node_id` or GraphQL issue `id` | Stable GitHub global node id for the issue. |
| `number`              | REST/GraphQL issue `number`                | Repository-local issue number.              |
| `title`               | REST/GraphQL issue `title`                 | Issue title.                                |
| `web_url`             | REST `html_url` or GraphQL `url`           | Issue web URL.                              |
| `state`               | REST/GraphQL issue `state`                 | Maps to `OPEN` or `CLOSED`.                 |
| `external_created_at` | REST `created_at` or GraphQL `createdAt`   | Issue creation timestamp.                   |
| `external_closed_at`  | REST `closed_at` or GraphQL `closedAt`     | Issue close timestamp, if closed.           |

## daily_user_summary

| shiplog column                            | GitHub source                                                         | Notes                                                        |
| ----------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------ |
| `total_commit_contributions`              | GraphQL `contributionsCollection.totalCommitContributions`            | Provider-reported commit contribution count.                 |
| `total_pull_request_contributions`        | GraphQL `contributionsCollection.totalPullRequestContributions`       | Provider-reported pull request contribution count.           |
| `total_pull_request_review_contributions` | GraphQL `contributionsCollection.totalPullRequestReviewContributions` | Provider-reported pull request review contribution count.    |
| `total_issue_contributions`               | GraphQL `contributionsCollection.totalIssueContributions`             | Provider-reported issue contribution count.                  |
| `restricted_contributions_count`          | GraphQL `contributionsCollection.restrictedContributionsCount`        | Private or restricted contribution count reported by GitHub. |

## Daily Collector Coverage

`bin/collect_github.ts` maps one activity date at a time. It discovers active repositories from `contributionsCollection`, skips configured ignored repository and organization node IDs, upserts organization rows for repositories owned by GitHub organizations, upserts generic repository rows, captures repository snapshots when star/fork fields are present, ingests commit/PR/review/issue events, writes `daily_user_summary`, then derives `daily_repository_activity` from the event tables. Daily collect does not enumerate all readable private repositories; that wider reconciliation belongs to deep backfill. Commit ingestion scans default-branch history for the date window and filters locally for commits whose GitHub `author` or `authors` list includes the configured account, including `Co-authored-by` credits, so commits where the account is not the primary author are still captured.

## Historical Collect Coverage

The internal historical collect strategy starts from the account node's `createdAt`, walks each year through `contributionsCollection`, stores year-start `daily_user_summary` rows with `source = 'self_backfill'`, skips configured ignored repository and organization node IDs, then enriches discovered repositories. It imports commits only for years with observed commit contributions unless a private repository needs a full scan, imports authored pull requests and issues when contribution discovery indicates work, imports submitted reviews, captures repository language snapshots, and derives `daily_repository_activity` for every distinct event date. Successful repository enrichment writes `repository_backfill_state`, so reruns can skip already-finished repositories without conflating daily repository snapshots with backfill completion.

Backfill supports two modes. `fast` mode uses contribution-group repositories and GitHub's author-filtered commit history query so large repositories do not require broad default-branch scans for unrelated commits. `deep` mode trades runtime for reconciliation: it uses unfiltered commit history so `Co-authored-by` credits can be found, enumerates private repositories from REST `GET /user/repos?visibility=private` for the default read token, resolves configured organization node IDs to current logins, and enumerates configured organization repositories from REST `GET /orgs/{organization}/repos?type=all` with organization-specific read tokens. Commit history GraphQL pages request 50 commits at a time to reduce large-repository 5xx responses. Deep-mode private repositories discovered only through listing are treated as candidates and are written to `repositories` only after matching account activity is found. Authored private candidate proof uses a one-result author-filtered GraphQL history query per active repository year; credited/co-author proof uses a bounded unfiltered scan that stores cursor progress in `private_repository_probe_state`, then falls back to pull request, issue, and review probes once the credited scan is exhausted.

`bin/backfill.ts` is the provider-neutral dispatcher for this historical path. It resolves initialized accounts from `shiplog.config.json`, refreshes the current GitHub login from the stable account ID, and invokes `bin/backfill_github.ts`. `BACKFILL_MODE`, `BACKFILL_MAX_MINUTES`, and `BACKFILL_REPO_BUDGET_MINUTES` can choose the fast or deep path and cap unfinished repository work in a run. `BACKFILL_REPOSITORY_LIMIT` remains available for custom local runs that need a hard repository cap. The bundled `history` workflow exposes only `max_minutes` and `repo_budget_minutes`, defaulting to a 60-minute run cap and a 5-minute budget before starting another repository. Repository-level success, retry-wait, completed-step state, and private candidate probe cursors let later runs resume the remaining work without letting one transient repository error or very large private repository fail the whole backfill. Lost private or organization access is warning-only for the current run and is not written as permanent blocked state. `BACKFILL_REQUIRE_COMPLETE=true` is still available for local or custom workflows that need an incomplete paused run to exit unsuccessfully, but the bundled `history` workflow leaves it off so progressive history can render and publish after every bounded improvement.

`bin/repair.ts` is the provider-neutral dispatcher for explicit date or range repair. It validates `REPAIR_DATE` or `REPAIR_FROM`/`REPAIR_TO`, invokes the daily collector for those dates, and leaves the account checkpoint unchanged.

`bin/drift.ts` is the provider-neutral dispatcher for drift detection. For GitHub, it compares stored `daily_user_summary` totals with current `contributionsCollection` totals and enqueues chunked `maintenance_tasks` repair ranges when a day is missing or mismatched.

`bin/maintenance.ts` drains due `maintenance_tasks` rows. The initial task type is `repair_range`, which reruns daily collection for a queued date range without advancing the account checkpoint.

## Pending Mappings

`profile_snapshots` are documented as a schema concept, but the daily GitHub collector does not populate them yet.
