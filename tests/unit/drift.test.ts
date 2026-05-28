import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as drift from '../../bin/drift.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { AccountRow, ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GH_RO_CLASSIC_TOKEN
const originalDriftFrom = process.env.DRIFT_FROM
const originalDriftTo = process.env.DRIFT_TO
const originalDriftLookbackDays = process.env.DRIFT_LOOKBACK_DAYS

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GH_RO_CLASSIC_TOKEN = 'test-token'
  delete process.env.DRIFT_FROM
  delete process.env.DRIFT_TO
  delete process.env.DRIFT_LOOKBACK_DAYS
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()
  restoreEnv('GH_RO_CLASSIC_TOKEN', originalGitHubToken)
  restoreEnv('DRIFT_FROM', originalDriftFrom)
  restoreEnv('DRIFT_TO', originalDriftTo)
  restoreEnv('DRIFT_LOOKBACK_DAYS', originalDriftLookbackDays)
})

test('run queues repair work for mismatched daily summaries without mutating collected data', async () => {
  const account = await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  await seedDailySummary(account.id, '2026-05-05', { commits: 3, pullRequests: 1 })
  await seedDailySummary(account.id, '2026-05-06', { commits: 0, pullRequests: 0 })

  const result = await drift.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fromDate: '2026-05-05',
    toDate: '2026-05-06',
    fetch: mockGitHubFetch()
  })

  const tasks = await db.query<{
    status: string
    priority: number
    target_from_on: Date | string
    target_to_on: Date | string
    reason: string | null
  }>('SELECT status, priority, target_from_on, target_to_on, reason FROM maintenance_tasks')
  const summaries = await db.query<{
    total_commit_contributions: number
    total_pull_request_contributions: number
  }>(
    `SELECT total_commit_contributions, total_pull_request_contributions
     FROM daily_user_summary
     WHERE activity_on = '2026-05-06'::date`
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(result).toEqual({ accountsChecked: 1, datesChecked: 2, tasksEnqueued: 1 })
  expect(tasks.rows).toHaveLength(1)
  expect(tasks.rows[0]).toMatchObject({
    status: 'pending',
    priority: 20,
    reason: 'drift: daily summary totals mismatch'
  })
  expect(dateOnly(tasks.rows[0]!.target_from_on)).toBe('2026-05-06')
  expect(dateOnly(tasks.rows[0]!.target_to_on)).toBe('2026-05-06')
  expect(summaries.rows[0]).toMatchObject({
    total_commit_contributions: 0,
    total_pull_request_contributions: 0
  })
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('run groups adjacent missing summaries into one repair range', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  const calls = { totalsRequests: 0 }

  const result = await drift.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fromDate: '2026-05-05',
    toDate: '2026-05-06',
    fetch: mockGitHubFetch(calls)
  })

  const tasks = await db.query<{
    target_from_on: Date | string
    target_to_on: Date | string
    reason: string | null
  }>('SELECT target_from_on, target_to_on, reason FROM maintenance_tasks')

  expect(result).toEqual({ accountsChecked: 1, datesChecked: 2, tasksEnqueued: 1 })
  expect(calls.totalsRequests).toBe(0)
  expect(dateOnly(tasks.rows[0]!.target_from_on)).toBe('2026-05-05')
  expect(dateOnly(tasks.rows[0]!.target_to_on)).toBe('2026-05-06')
  expect(tasks.rows[0]!.reason).toBe('drift: missing daily summary')
})

test('run does not queue work when stored summaries match provider totals', async () => {
  const account = await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  await seedDailySummary(account.id, '2026-05-05', { commits: 3, pullRequests: 1 })
  const calls = { totalsRequests: 0 }

  const result = await drift.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fromDate: '2026-05-05',
    toDate: '2026-05-05',
    fetch: mockGitHubFetch(calls)
  })

  const tasks = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM maintenance_tasks'
  )

  expect(result).toEqual({ accountsChecked: 1, datesChecked: 1, tasksEnqueued: 0 })
  expect(calls.totalsRequests).toBe(1)
  expect(tasks.rows[0]!.count).toBe(0)
})

test('run rejects incomplete drift ranges', async () => {
  await seedAccount()

  await expect(
    drift.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fromDate: '2026-05-05',
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/DRIFT_FROM and DRIFT_TO/)
})

async function seedAccount(
  options: { lastSuccessfulCollectOn?: string } = {}
): Promise<AccountRow> {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2026-01-01T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  if (options.lastSuccessfulCollectOn) {
    await upserts.markCollectSuccess(account.id, options.lastSuccessfulCollectOn)
  }

  return account
}

async function seedDailySummary(
  accountId: number,
  date: string,
  totals: { commits: number; pullRequests: number }
): Promise<void> {
  await upserts.upsertDailyUserSummary({
    account_id: accountId,
    activity_on: date,
    total_commit_contributions: totals.commits,
    total_pull_request_contributions: totals.pullRequests,
    total_pull_request_review_contributions: 0,
    total_issue_contributions: 0,
    restricted_contributions_count: 0,
    source: 'live'
  })
}

function shiplogConfig(): ShiplogConfig {
  return {
    version: 1,
    profile: { displayName: 'Example User' },
    collect: {
      lookbackDays: 7,
      accounts: [
        {
          provider: 'github',
          accountId: 'U_TEST_1',
          tokenEnv: 'GH_RO_CLASSIC_TOKEN',
          organizationPatTokens: [],
          ignore: {
            organizations: [],
            repositories: []
          }
        }
      ]
    },
    publish: {
      targets: [
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_1',
          branch: 'main',
          path: 'README.md',
          tokenEnv: 'GH_RW_REPO_TOKEN'
        }
      ]
    }
  }
}

function mockGitHubFetch(calls: { totalsRequests: number } = { totalsRequests: 0 }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes('query UserById')) {
        return jsonResponse({
          data: {
            node: {
              id: 'U_TEST_1',
              login: 'octocat',
              name: 'Octocat',
              url: 'https://github.com/octocat',
              createdAt: '2026-01-01T00:00:00Z'
            }
          }
        })
      }

      if (body.query.includes('query ContributionsTotals')) {
        calls.totalsRequests += 1
        return jsonResponse({
          data: {
            user: {
              contributionsCollection: {
                totalCommitContributions: 3,
                totalIssueContributions: 0,
                totalPullRequestContributions: 1,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0
              }
            }
          }
        })
      }
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
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

function restoreEnv(name: string, originalValue: string | undefined): void {
  if (originalValue === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = originalValue
  }
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}
