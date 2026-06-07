import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as db from '../../lib/db.ts'
import type {
  AccountRow,
  DailyRepositoryActivityRow,
  PullRequestRow,
  RepositoryRow
} from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
})

afterEach(async () => {
  await db.close()
})

test('upsertUser inserts and returns the created row', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })

  expect(user.id).toBeGreaterThan(0)
  expect(user.display_name).toBe('Example User')
  expect(user.created_at).toBeDefined()
  expect(user.updated_at).toBeDefined()
})

test('upsertAccount is idempotent on provider and external id', async () => {
  const user = await upserts.upsertUser({ display_name: 'Test User' })

  const first = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_12345',
    external_url: 'https://github.com/octocat',
    external_created_at: '2008-04-01T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const second = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_12345',
    external_url: 'https://github.com/octocat-v2',
    external_created_at: '2008-04-01T00:00:00Z',
    first_seen_on: '2026-05-08'
  })

  expect(first.id).toBe(second.id)
  expect(second.external_url).toBe('https://github.com/octocat-v2')
})

test('upsertRepository inserts then updates on provider and external id', async () => {
  const first = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_1',
    organization_id: null,
    owner_login: 'octocat',
    name: 'hello',
    full_name: 'octocat/hello',
    web_url: 'https://github.com/octocat/hello',
    description: 'first',
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'Go',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-07T12:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07',
    redacted: false
  })
  const second = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_1',
    organization_id: null,
    owner_login: 'octocat',
    name: 'hello',
    full_name: 'octocat/hello',
    web_url: 'https://github.com/octocat/hello',
    description: 'second',
    visibility: 'public',
    is_fork: false,
    is_archived: true,
    primary_language: 'Rust',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-08T12:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-08',
    redacted: false
  })

  expect(first.id).toBe(second.id)
  expect(second.stable_key).toHaveLength(64)
  expect(second.is_archived).toBe(true)
  expect(second.primary_language).toBe('Rust')
  expect(second.description).toBe('second')
})

test('upsertRepository preserves manual redaction during sync updates', async () => {
  const first = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_REDACTED_1',
    organization_id: null,
    owner_login: 'octocat',
    name: 'secret',
    full_name: 'octocat/secret',
    web_url: 'https://github.com/octocat/secret',
    description: 'manual redaction',
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'TypeScript',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-07T12:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07',
    redacted: true
  })
  const second = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_REDACTED_1',
    organization_id: null,
    owner_login: 'octocat',
    name: 'secret',
    full_name: 'octocat/secret',
    web_url: 'https://github.com/octocat/secret',
    description: 'sync update',
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'TypeScript',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-08T12:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-08',
    redacted: false
  })

  expect(first.redacted).toBe(true)
  expect(second.id).toBe(first.id)
  expect(second.description).toBe('sync update')
  expect(second.redacted).toBe(true)
})

test('upsertRepository handles repository renames by stable provider id', async () => {
  const { account, repository } = await seedAccountAndRepository()
  await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.id,
    oid: 'rename-safe-commit',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T12:00:00Z',
    additions: 10,
    deletions: 2,
    changed_files: 1,
    message_headline: 'before rename',
    source: 'live'
  })

  const renamed = await upserts.upsertRepository({
    provider: repository.provider,
    external_id: repository.external_id,
    organization_id: null,
    owner_login: 'renamed-owner',
    name: 'renamed-repo',
    full_name: 'renamed-owner/renamed-repo',
    web_url: 'https://github.com/renamed-owner/renamed-repo',
    description: 'renamed repository',
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'TypeScript',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-08T12:00:00Z',
    first_seen_on: '2026-05-08',
    last_seen_on: '2026-05-08',
    redacted: false
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories WHERE external_id = $1',
    [repository.external_id]
  )
  const commits = await db.query<{ repository_id: number }>(
    'SELECT repository_id FROM commits WHERE oid = $1',
    ['rename-safe-commit']
  )

  expect(renamed.id).toBe(repository.id)
  expect(renamed.owner_login).toBe('renamed-owner')
  expect(renamed.name).toBe('renamed-repo')
  expect(renamed.full_name).toBe('renamed-owner/renamed-repo')
  expect(repositories.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.repository_id).toBe(repository.id)
})

test('upsertOrganization handles organization renames by stable provider id', async () => {
  const first = await upserts.upsertOrganization({
    provider: 'github',
    external_id: 'O_RENAMED_1',
    external_login: 'old-org',
    display_name: 'Old Org',
    description: 'before rename',
    avatar_url: 'https://avatars.githubusercontent.com/u/1',
    website_url: 'https://old.example.com',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07'
  })
  const second = await upserts.upsertOrganization({
    provider: 'github',
    external_id: 'O_RENAMED_1',
    external_login: 'new-org',
    display_name: 'New Org',
    description: 'after rename',
    avatar_url: 'https://avatars.githubusercontent.com/u/1',
    website_url: 'https://new.example.com',
    first_seen_on: '2026-05-08',
    last_seen_on: '2026-05-08'
  })

  const organizations = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM organizations WHERE external_id = $1',
    ['O_RENAMED_1']
  )

  expect(second.id).toBe(first.id)
  expect(second.external_login).toBe('new-org')
  expect(second.display_name).toBe('New Org')
  expect(second.description).toBe('after rename')
  expect(organizations.rows[0]!.count).toBe(1)
})

test('upsertCommit dedupes on account and oid', async () => {
  const { account, repository } = await seedAccountAndRepository()

  const first = await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.id,
    oid: 'abc123',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T12:00:00Z',
    additions: 10,
    deletions: 2,
    changed_files: 1,
    message_headline: 'first',
    source: 'live'
  })
  const second = await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.id,
    oid: 'abc123',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T12:00:00Z',
    additions: 15,
    deletions: 3,
    changed_files: 2,
    message_headline: 'second',
    source: 'live'
  })

  expect(first.id).toBe(second.id)
  expect(second.additions).toBe(15)
  expect(second.message_headline).toBe('second')
})

test('upsertPullRequest updates state on second write', async () => {
  const { account, repository } = await seedAccountAndRepository()

  await upserts.upsertPullRequest({
    account_id: account.id,
    external_id: 'PR_1',
    repository_id: repository.id,
    number: 42,
    title: 'Fix bug',
    web_url: 'https://github.com/octocat/hello/pull/42',
    state: 'OPEN',
    external_created_at: '2026-05-07T08:00:00Z',
    external_merged_at: null,
    external_closed_at: null,
    additions: 5,
    deletions: 3,
    changed_files: 2,
    commits_count: 1,
    source: 'live'
  })
  const merged = await upserts.upsertPullRequest({
    account_id: account.id,
    external_id: 'PR_1',
    repository_id: repository.id,
    number: 42,
    title: 'Fix bug',
    web_url: 'https://github.com/octocat/hello/pull/42',
    state: 'MERGED',
    external_created_at: '2026-05-07T08:00:00Z',
    external_merged_at: '2026-05-08T10:00:00Z',
    external_closed_at: '2026-05-08T10:00:00Z',
    additions: 5,
    deletions: 3,
    changed_files: 2,
    commits_count: 1,
    source: 'live'
  })

  const rows = await db.query<PullRequestRow>(
    'SELECT * FROM pull_requests WHERE external_id = $1',
    ['PR_1']
  )

  expect(merged.state).toBe('MERGED')
  expect(rows.rows[0]!.external_merged_at).not.toBeNull()
})

test('rollupDailyRepositoryActivity computes counts from event tables', async () => {
  const { account, repository } = await seedAccountAndRepository()

  await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.id,
    oid: 'a',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T08:00:00Z',
    additions: 10,
    deletions: 0,
    changed_files: 1,
    message_headline: null,
    source: 'live'
  })
  await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.id,
    oid: 'b',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T09:00:00Z',
    additions: 5,
    deletions: 3,
    changed_files: 2,
    message_headline: null,
    source: 'live'
  })
  await upserts.upsertPullRequest({
    account_id: account.id,
    external_id: 'PR_2',
    repository_id: repository.id,
    number: 2,
    title: 'Ship',
    web_url: 'https://github.com/octocat/hello/pull/2',
    state: 'MERGED',
    external_created_at: '2026-05-07T08:00:00Z',
    external_merged_at: '2026-05-07T11:00:00Z',
    external_closed_at: '2026-05-07T11:00:00Z',
    additions: null,
    deletions: null,
    changed_files: null,
    commits_count: null,
    source: 'live'
  })
  await upserts.upsertPullRequestReview({
    account_id: account.id,
    external_id: 'R_1',
    pull_request_id: null,
    repository_id: repository.id,
    state: 'APPROVED',
    submitted_at: '2026-05-07T12:00:00Z',
    submitted_on: '2026-05-07',
    source: 'live'
  })
  await upserts.upsertIssue({
    account_id: account.id,
    external_id: 'I_1',
    repository_id: repository.id,
    number: 7,
    title: 'Question',
    web_url: 'https://github.com/octocat/hello/issues/7',
    state: 'CLOSED',
    external_created_at: '2026-05-07T07:00:00Z',
    external_closed_at: '2026-05-07T13:00:00Z',
    source: 'live'
  })

  await upserts.rollupDailyRepositoryActivity(account.id, '2026-05-07')

  const rows = await db.query<DailyRepositoryActivityRow>(
    `SELECT *
     FROM daily_repository_activity
     WHERE account_id = $1 AND activity_on = $2 AND repository_id = $3`,
    [account.id, '2026-05-07', repository.id]
  )
  const row = rows.rows[0]!

  expect(row.commits).toBe(2)
  expect(row.lines_added).toBe(15)
  expect(row.lines_deleted).toBe(3)
  expect(row.files_changed).toBe(3)
  expect(row.prs_opened).toBe(1)
  expect(row.prs_merged).toBe(1)
  expect(row.pr_reviews_total).toBe(1)
  expect(row.pr_reviews_approved).toBe(1)
  expect(row.issues_opened).toBe(1)
  expect(row.issues_closed).toBe(1)
})

test('markCollectSuccess advances the checkpoint', async () => {
  const { account } = await seedAccountAndRepository()

  expect(account.last_successful_collect_on).toBeNull()

  await upserts.markCollectSuccess(account.id, '2026-05-07')
  const first = await db.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [account.id])

  await upserts.markCollectSuccess(account.id, '2026-05-06')
  const second = await db.query<AccountRow>('SELECT * FROM accounts WHERE id = $1', [account.id])

  expect(dateOnly(first.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
  expect(dateOnly(second.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('recordErrorEvent stores full payload and returns the event id', async () => {
  const event = await upserts.recordErrorEvent({
    source: 'backfill',
    phase: 'private_candidate_activity_probe',
    token: 'unredacted-test-token',
    error: {
      message: 'private repository octocat/secret failed'
    }
  })

  const stored = await db.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM error_events WHERE id = $1',
    [event.id]
  )

  expect(event.id).toBeGreaterThan(0)
  expect(stored.rows[0]!.payload).toMatchObject({
    source: 'backfill',
    phase: 'private_candidate_activity_probe',
    token: 'unredacted-test-token',
    error: {
      message: 'private repository octocat/secret failed'
    }
  })
})

test('pruneErrorEventsBefore deletes only older diagnostic events', async () => {
  await db.query(
    `INSERT INTO error_events (created_at, payload)
     VALUES
       ('2026-04-30T00:00:00Z', '{"source":"old"}'::jsonb),
       ('2026-05-15T00:00:00Z', '{"source":"new"}'::jsonb)`
  )

  const deleted = await upserts.pruneErrorEventsBefore('2026-05-01T00:00:00Z')
  const remaining = await db.query<{ source: string }>(
    `SELECT payload->>'source' AS source
     FROM error_events
     ORDER BY created_at`
  )

  expect(deleted).toBe(1)
  expect(remaining.rows.map((row) => row.source)).toEqual(['new'])
})

async function seedAccountAndRepository(): Promise<{
  account: AccountRow
  repository: RepositoryRow
}> {
  const user = await upserts.upsertUser({ display_name: 'Seed' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: `seed-${crypto.randomUUID()}`,
    external_id: `U_${crypto.randomUUID()}`,
    external_url: 'https://github.com/seed',
    external_created_at: '2020-01-01T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const repository = await upserts.upsertRepository({
    provider: 'github',
    external_id: `R_${crypto.randomUUID()}`,
    organization_id: null,
    owner_login: 'octocat',
    name: 'hello',
    full_name: 'octocat/hello',
    web_url: 'https://github.com/octocat/hello',
    description: null,
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'Go',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-07T12:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07',
    redacted: false
  })

  return { account, repository }
}

function createMigratedPool(): Pool {
  const mem = newDb()
  const adapter = mem.adapters.createPg()

  for (const filename of fs.readdirSync(MIGRATIONS).sort()) {
    if (!filename.endsWith('.sql') || filename.includes('create_view')) continue
    mem.public.none(loadMigration(filename))
  }

  return new adapter.Pool() as unknown as Pool
}

function loadMigration(filename: string): string {
  return fs
    .readFileSync(path.join(MIGRATIONS, filename), 'utf8')
    .split(/-- migrate:down/)[0]!
    .replace(/^-- migrate:up\s*/m, '')
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}
