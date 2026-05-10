import crypto from 'node:crypto'
import * as db from './db.ts'
import type {
  AccountRow,
  CommitRow,
  DailyRepositoryActivityRow,
  DailyUserSummaryRow,
  IssueRow,
  OrganizationRow,
  ProfileSnapshotRow,
  PullRequestReviewRow,
  PullRequestRow,
  RepositoryLanguageRow,
  RepositoryRow,
  RepositorySnapshotRow,
  RollupSource,
  UserRow
} from './types/index.ts'

export type NewUserRow = Pick<UserRow, 'display_name'>

export type NewAccountRow = Omit<
  AccountRow,
  'id' | 'last_successful_collect_on' | 'captured_at' | 'created_at' | 'updated_at'
>

export type NewProfileSnapshotRow = Omit<ProfileSnapshotRow, 'id' | 'created_at' | 'updated_at'>

export type NewOrganizationRow = Omit<OrganizationRow, 'id' | 'created_at' | 'updated_at'>

export type NewRepositoryRow = Omit<
  RepositoryRow,
  'id' | 'stable_key' | 'created_at' | 'updated_at'
>

export type NewRepositorySnapshotRow = Omit<
  RepositorySnapshotRow,
  'id' | 'created_at' | 'updated_at'
>

export type NewRepositoryLanguageRow = Omit<
  RepositoryLanguageRow,
  'id' | 'created_at' | 'updated_at'
>

export type NewCommitRow = Omit<CommitRow, 'id' | 'captured_at' | 'created_at' | 'updated_at'>

export type NewPullRequestRow = Omit<
  PullRequestRow,
  'id' | 'captured_at' | 'created_at' | 'updated_at'
>

export type NewPullRequestReviewRow = Omit<
  PullRequestReviewRow,
  'id' | 'captured_at' | 'created_at' | 'updated_at'
>

export type NewIssueRow = Omit<IssueRow, 'id' | 'captured_at' | 'created_at' | 'updated_at'>

export type NewDailyUserSummaryRow = Omit<
  DailyUserSummaryRow,
  'id' | 'captured_at' | 'created_at' | 'updated_at'
>

export type NewDailyRepositoryActivityRow = Omit<
  DailyRepositoryActivityRow,
  'id' | 'captured_at' | 'created_at' | 'updated_at'
>

export async function upsertUser(row: NewUserRow): Promise<UserRow> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (display_name)
     VALUES ($1)
     RETURNING *`,
    [row.display_name]
  )

  return result.rows[0]!
}

export async function upsertAccount(row: NewAccountRow): Promise<AccountRow> {
  const result = await db.query<AccountRow>(
    `INSERT INTO accounts
       (user_id, provider, external_login, external_id, external_url, external_created_at, first_seen_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (provider, external_id) DO UPDATE
       SET external_login = EXCLUDED.external_login,
           external_url = EXCLUDED.external_url,
           external_created_at = EXCLUDED.external_created_at,
           first_seen_on = CASE
             WHEN accounts.first_seen_on <= EXCLUDED.first_seen_on THEN accounts.first_seen_on
             ELSE EXCLUDED.first_seen_on
           END,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.user_id,
      row.provider,
      row.external_login,
      row.external_id,
      row.external_url,
      row.external_created_at,
      row.first_seen_on
    ]
  )

  return result.rows[0]!
}

export async function markCollectSuccess(accountId: number, collectedOn: string): Promise<void> {
  await db.query(
    `UPDATE accounts
     SET last_successful_collect_on = CASE
           WHEN last_successful_collect_on IS NULL THEN $2::date
           WHEN last_successful_collect_on < $2::date THEN $2::date
           ELSE last_successful_collect_on
         END,
         updated_at = now()
     WHERE id = $1`,
    [accountId, collectedOn]
  )
}

export async function upsertProfileSnapshot(
  row: NewProfileSnapshotRow
): Promise<ProfileSnapshotRow> {
  const result = await db.query<ProfileSnapshotRow>(
    `INSERT INTO profile_snapshots
       (account_id, captured_on, followers_count, following_count, public_repos_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id, captured_on) DO UPDATE
       SET followers_count = EXCLUDED.followers_count,
           following_count = EXCLUDED.following_count,
           public_repos_count = EXCLUDED.public_repos_count,
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.captured_on,
      row.followers_count,
      row.following_count,
      row.public_repos_count
    ]
  )

  return result.rows[0]!
}

export async function upsertOrganization(row: NewOrganizationRow): Promise<OrganizationRow> {
  const result = await db.query<OrganizationRow>(
    `INSERT INTO organizations
       (provider, external_id, external_login, display_name, description, avatar_url, website_url,
        first_seen_on, last_seen_on)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (provider, external_id) DO UPDATE
       SET external_login = EXCLUDED.external_login,
           display_name = EXCLUDED.display_name,
           description = EXCLUDED.description,
           avatar_url = EXCLUDED.avatar_url,
           website_url = EXCLUDED.website_url,
           first_seen_on = CASE
             WHEN organizations.first_seen_on <= EXCLUDED.first_seen_on THEN organizations.first_seen_on
             ELSE EXCLUDED.first_seen_on
           END,
           last_seen_on = CASE
             WHEN organizations.last_seen_on >= EXCLUDED.last_seen_on THEN organizations.last_seen_on
             ELSE EXCLUDED.last_seen_on
           END,
           updated_at = now()
     RETURNING *`,
    [
      row.provider,
      row.external_id,
      row.external_login,
      row.display_name,
      row.description,
      row.avatar_url,
      row.website_url,
      row.first_seen_on,
      row.last_seen_on
    ]
  )

  return result.rows[0]!
}

export async function upsertRepository(row: NewRepositoryRow): Promise<RepositoryRow> {
  const stableKey = stableRepositoryKey(row.provider, row.external_id)
  const result = await db.query<RepositoryRow>(
    `INSERT INTO repositories
       (provider, external_id, stable_key, organization_id, owner_login, name, full_name, web_url,
        description, visibility, is_fork, is_archived, primary_language, default_branch,
        external_created_at, external_pushed_at, first_seen_on, last_seen_on, redacted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     ON CONFLICT (provider, external_id) DO UPDATE
       SET organization_id = EXCLUDED.organization_id,
           owner_login = EXCLUDED.owner_login,
           name = EXCLUDED.name,
           full_name = EXCLUDED.full_name,
           web_url = EXCLUDED.web_url,
           description = EXCLUDED.description,
           visibility = EXCLUDED.visibility,
           is_fork = EXCLUDED.is_fork,
           is_archived = EXCLUDED.is_archived,
           primary_language = EXCLUDED.primary_language,
           default_branch = EXCLUDED.default_branch,
           external_created_at = EXCLUDED.external_created_at,
           external_pushed_at = EXCLUDED.external_pushed_at,
           first_seen_on = CASE
             WHEN repositories.first_seen_on <= EXCLUDED.first_seen_on THEN repositories.first_seen_on
             ELSE EXCLUDED.first_seen_on
           END,
           last_seen_on = CASE
             WHEN repositories.last_seen_on >= EXCLUDED.last_seen_on THEN repositories.last_seen_on
             ELSE EXCLUDED.last_seen_on
           END,
           redacted = EXCLUDED.redacted,
           updated_at = now()
     RETURNING *`,
    [
      row.provider,
      row.external_id,
      stableKey,
      row.organization_id,
      row.owner_login,
      row.name,
      row.full_name,
      row.web_url,
      row.description,
      row.visibility,
      row.is_fork,
      row.is_archived,
      row.primary_language,
      row.default_branch,
      row.external_created_at,
      row.external_pushed_at,
      row.first_seen_on,
      row.last_seen_on,
      row.redacted
    ]
  )

  return result.rows[0]!
}

export async function upsertRepositorySnapshot(
  row: NewRepositorySnapshotRow
): Promise<RepositorySnapshotRow> {
  const result = await db.query<RepositorySnapshotRow>(
    `INSERT INTO repository_snapshots
       (repository_id, captured_on, star_count, fork_count, is_archived, visibility)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (repository_id, captured_on) DO UPDATE
       SET star_count = EXCLUDED.star_count,
           fork_count = EXCLUDED.fork_count,
           is_archived = EXCLUDED.is_archived,
           visibility = EXCLUDED.visibility,
           updated_at = now()
     RETURNING *`,
    [
      row.repository_id,
      row.captured_on,
      row.star_count,
      row.fork_count,
      row.is_archived,
      row.visibility
    ]
  )

  return result.rows[0]!
}

export async function upsertRepositoryLanguage(
  row: NewRepositoryLanguageRow
): Promise<RepositoryLanguageRow> {
  const result = await db.query<RepositoryLanguageRow>(
    `INSERT INTO repository_languages
       (repository_id, captured_on, language, bytes, percentage)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (repository_id, captured_on, language) DO UPDATE
       SET bytes = EXCLUDED.bytes,
           percentage = EXCLUDED.percentage,
           updated_at = now()
     RETURNING *`,
    [row.repository_id, row.captured_on, row.language, row.bytes, row.percentage]
  )

  return result.rows[0]!
}

export async function upsertCommit(row: NewCommitRow): Promise<CommitRow> {
  const result = await db.query<CommitRow>(
    `INSERT INTO commits
       (account_id, oid, repository_id, committed_on, committed_at, additions, deletions,
        changed_files, message_headline, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (account_id, oid) DO UPDATE
       SET repository_id = EXCLUDED.repository_id,
           committed_on = EXCLUDED.committed_on,
           committed_at = EXCLUDED.committed_at,
           additions = EXCLUDED.additions,
           deletions = EXCLUDED.deletions,
           changed_files = EXCLUDED.changed_files,
           message_headline = EXCLUDED.message_headline,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.oid,
      row.repository_id,
      row.committed_on,
      row.committed_at,
      row.additions,
      row.deletions,
      row.changed_files,
      row.message_headline,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function upsertPullRequest(row: NewPullRequestRow): Promise<PullRequestRow> {
  const result = await db.query<PullRequestRow>(
    `INSERT INTO pull_requests
       (account_id, external_id, repository_id, number, title, web_url, state, external_created_at,
        external_merged_at, external_closed_at, additions, deletions, changed_files, commits_count, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (repository_id, number) DO UPDATE
       SET account_id = EXCLUDED.account_id,
           external_id = EXCLUDED.external_id,
           title = EXCLUDED.title,
           web_url = EXCLUDED.web_url,
           state = EXCLUDED.state,
           external_created_at = EXCLUDED.external_created_at,
           external_merged_at = EXCLUDED.external_merged_at,
           external_closed_at = EXCLUDED.external_closed_at,
           additions = EXCLUDED.additions,
           deletions = EXCLUDED.deletions,
           changed_files = EXCLUDED.changed_files,
           commits_count = EXCLUDED.commits_count,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.external_id,
      row.repository_id,
      row.number,
      row.title,
      row.web_url,
      row.state,
      row.external_created_at,
      row.external_merged_at,
      row.external_closed_at,
      row.additions,
      row.deletions,
      row.changed_files,
      row.commits_count,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function upsertPullRequestReview(
  row: NewPullRequestReviewRow
): Promise<PullRequestReviewRow> {
  const result = await db.query<PullRequestReviewRow>(
    `INSERT INTO pull_request_reviews
       (account_id, external_id, pull_request_id, repository_id, state, submitted_at, submitted_on, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, external_id) DO UPDATE
       SET pull_request_id = EXCLUDED.pull_request_id,
           repository_id = EXCLUDED.repository_id,
           state = EXCLUDED.state,
           submitted_at = EXCLUDED.submitted_at,
           submitted_on = EXCLUDED.submitted_on,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.external_id,
      row.pull_request_id,
      row.repository_id,
      row.state,
      row.submitted_at,
      row.submitted_on,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function upsertIssue(row: NewIssueRow): Promise<IssueRow> {
  const result = await db.query<IssueRow>(
    `INSERT INTO issues
       (account_id, external_id, repository_id, number, title, web_url, state,
        external_created_at, external_closed_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (repository_id, number) DO UPDATE
       SET account_id = EXCLUDED.account_id,
           external_id = EXCLUDED.external_id,
           title = EXCLUDED.title,
           web_url = EXCLUDED.web_url,
           state = EXCLUDED.state,
           external_created_at = EXCLUDED.external_created_at,
           external_closed_at = EXCLUDED.external_closed_at,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.external_id,
      row.repository_id,
      row.number,
      row.title,
      row.web_url,
      row.state,
      row.external_created_at,
      row.external_closed_at,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function upsertDailyUserSummary(
  row: NewDailyUserSummaryRow
): Promise<DailyUserSummaryRow> {
  const result = await db.query<DailyUserSummaryRow>(
    `INSERT INTO daily_user_summary
       (account_id, activity_on, total_commit_contributions, total_pull_request_contributions,
        total_pull_request_review_contributions, total_issue_contributions,
        restricted_contributions_count, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (account_id, activity_on) DO UPDATE
       SET total_commit_contributions = EXCLUDED.total_commit_contributions,
           total_pull_request_contributions = EXCLUDED.total_pull_request_contributions,
           total_pull_request_review_contributions = EXCLUDED.total_pull_request_review_contributions,
           total_issue_contributions = EXCLUDED.total_issue_contributions,
           restricted_contributions_count = EXCLUDED.restricted_contributions_count,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.activity_on,
      row.total_commit_contributions,
      row.total_pull_request_contributions,
      row.total_pull_request_review_contributions,
      row.total_issue_contributions,
      row.restricted_contributions_count,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function upsertDailyRepositoryActivity(
  row: NewDailyRepositoryActivityRow
): Promise<DailyRepositoryActivityRow> {
  const result = await db.query<DailyRepositoryActivityRow>(
    `INSERT INTO daily_repository_activity
       (account_id, activity_on, repository_id, commits, lines_added, lines_deleted, files_changed,
        prs_opened, prs_merged, prs_closed_unmerged, pr_reviews_total, pr_reviews_approved,
        pr_reviews_changes_requested, pr_reviews_commented, issues_opened, issues_closed, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (account_id, activity_on, repository_id) DO UPDATE
       SET commits = EXCLUDED.commits,
           lines_added = EXCLUDED.lines_added,
           lines_deleted = EXCLUDED.lines_deleted,
           files_changed = EXCLUDED.files_changed,
           prs_opened = EXCLUDED.prs_opened,
           prs_merged = EXCLUDED.prs_merged,
           prs_closed_unmerged = EXCLUDED.prs_closed_unmerged,
           pr_reviews_total = EXCLUDED.pr_reviews_total,
           pr_reviews_approved = EXCLUDED.pr_reviews_approved,
           pr_reviews_changes_requested = EXCLUDED.pr_reviews_changes_requested,
           pr_reviews_commented = EXCLUDED.pr_reviews_commented,
           issues_opened = EXCLUDED.issues_opened,
           issues_closed = EXCLUDED.issues_closed,
           source = EXCLUDED.source,
           captured_at = now(),
           updated_at = now()
     RETURNING *`,
    [
      row.account_id,
      row.activity_on,
      row.repository_id,
      row.commits,
      row.lines_added,
      row.lines_deleted,
      row.files_changed,
      row.prs_opened,
      row.prs_merged,
      row.prs_closed_unmerged,
      row.pr_reviews_total,
      row.pr_reviews_approved,
      row.pr_reviews_changes_requested,
      row.pr_reviews_commented,
      row.issues_opened,
      row.issues_closed,
      row.source
    ]
  )

  return result.rows[0]!
}

export async function rollupDailyRepositoryActivity(
  accountId: number,
  activityOn: string,
  source: RollupSource = 'live_rollup'
): Promise<void> {
  const facts = new Map<number, NewDailyRepositoryActivityRow>()

  const commits = await db.query<CommitAggregateRow>(
    `SELECT
       repository_id,
       COUNT(*)::int AS commits,
       COALESCE(SUM(additions), 0)::int AS lines_added,
       COALESCE(SUM(deletions), 0)::int AS lines_deleted,
       COALESCE(SUM(changed_files), 0)::int AS files_changed
     FROM commits
     WHERE account_id = $1 AND committed_on = $2::date
     GROUP BY repository_id`,
    [accountId, activityOn]
  )
  for (const row of commits.rows) {
    const fact = dailyFact(facts, accountId, activityOn, row.repository_id, source)
    fact.commits = toNumber(row.commits)
    fact.lines_added = toNumber(row.lines_added)
    fact.lines_deleted = toNumber(row.lines_deleted)
    fact.files_changed = toNumber(row.files_changed)
  }

  const pullRequests = await db.query<PullRequestAggregateRow>(
    `SELECT
       repository_id,
       SUM(CASE WHEN external_created_at::date = $2::date THEN 1 ELSE 0 END)::int AS prs_opened,
       SUM(CASE WHEN external_merged_at::date = $2::date THEN 1 ELSE 0 END)::int AS prs_merged,
       SUM(CASE WHEN external_closed_at::date = $2::date AND external_merged_at IS NULL THEN 1 ELSE 0 END)::int AS prs_closed_unmerged
     FROM pull_requests
     WHERE account_id = $1
       AND (
         external_created_at::date = $2::date
         OR external_merged_at::date = $2::date
         OR external_closed_at::date = $2::date
       )
     GROUP BY repository_id`,
    [accountId, activityOn]
  )
  for (const row of pullRequests.rows) {
    const fact = dailyFact(facts, accountId, activityOn, row.repository_id, source)
    fact.prs_opened = toNumber(row.prs_opened)
    fact.prs_merged = toNumber(row.prs_merged)
    fact.prs_closed_unmerged = toNumber(row.prs_closed_unmerged)
  }

  const reviews = await db.query<ReviewAggregateRow>(
    `SELECT
       repository_id,
       COUNT(*)::int AS pr_reviews_total,
       SUM(CASE WHEN state = 'APPROVED' THEN 1 ELSE 0 END)::int AS pr_reviews_approved,
       SUM(CASE WHEN state = 'CHANGES_REQUESTED' THEN 1 ELSE 0 END)::int AS pr_reviews_changes_requested,
       SUM(CASE WHEN state = 'COMMENTED' THEN 1 ELSE 0 END)::int AS pr_reviews_commented
     FROM pull_request_reviews
     WHERE account_id = $1 AND submitted_on = $2::date
     GROUP BY repository_id`,
    [accountId, activityOn]
  )
  for (const row of reviews.rows) {
    const fact = dailyFact(facts, accountId, activityOn, row.repository_id, source)
    fact.pr_reviews_total = toNumber(row.pr_reviews_total)
    fact.pr_reviews_approved = toNumber(row.pr_reviews_approved)
    fact.pr_reviews_changes_requested = toNumber(row.pr_reviews_changes_requested)
    fact.pr_reviews_commented = toNumber(row.pr_reviews_commented)
  }

  const issues = await db.query<IssueAggregateRow>(
    `SELECT
       repository_id,
       SUM(CASE WHEN external_created_at::date = $2::date THEN 1 ELSE 0 END)::int AS issues_opened,
       SUM(CASE WHEN external_closed_at::date = $2::date THEN 1 ELSE 0 END)::int AS issues_closed
     FROM issues
     WHERE account_id = $1
       AND (
         external_created_at::date = $2::date
         OR external_closed_at::date = $2::date
       )
     GROUP BY repository_id`,
    [accountId, activityOn]
  )
  for (const row of issues.rows) {
    const fact = dailyFact(facts, accountId, activityOn, row.repository_id, source)
    fact.issues_opened = toNumber(row.issues_opened)
    fact.issues_closed = toNumber(row.issues_closed)
  }

  for (const fact of facts.values()) {
    await upsertDailyRepositoryActivity(fact)
  }
}

export function stableRepositoryKey(provider: string, externalId: string): string {
  return crypto.createHash('sha256').update(`${provider}:${externalId}`).digest('hex')
}

interface CommitAggregateRow {
  repository_id: number
  commits: number | string
  lines_added: number | string
  lines_deleted: number | string
  files_changed: number | string
}

interface PullRequestAggregateRow {
  repository_id: number
  prs_opened: number | string
  prs_merged: number | string
  prs_closed_unmerged: number | string
}

interface ReviewAggregateRow {
  repository_id: number
  pr_reviews_total: number | string
  pr_reviews_approved: number | string
  pr_reviews_changes_requested: number | string
  pr_reviews_commented: number | string
}

interface IssueAggregateRow {
  repository_id: number
  issues_opened: number | string
  issues_closed: number | string
}

function dailyFact(
  facts: Map<number, NewDailyRepositoryActivityRow>,
  accountId: number,
  activityOn: string,
  repositoryId: number,
  source: RollupSource
): NewDailyRepositoryActivityRow {
  const existing = facts.get(repositoryId)
  if (existing) return existing

  const fact: NewDailyRepositoryActivityRow = {
    account_id: accountId,
    activity_on: activityOn,
    repository_id: repositoryId,
    commits: 0,
    lines_added: null,
    lines_deleted: null,
    files_changed: null,
    prs_opened: 0,
    prs_merged: 0,
    prs_closed_unmerged: 0,
    pr_reviews_total: 0,
    pr_reviews_approved: null,
    pr_reviews_changes_requested: null,
    pr_reviews_commented: null,
    issues_opened: 0,
    issues_closed: 0,
    source
  }

  facts.set(repositoryId, fact)
  return fact
}

function toNumber(value: number | string | null): number {
  return Number(value ?? 0)
}
