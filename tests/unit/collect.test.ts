import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as collect from '../../bin/collect.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { AccountRow, ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GH_RO_CLASSIC_TOKEN
const originalCollectDate = process.env.COLLECT_DATE
const originalCollectFrom = process.env.COLLECT_FROM
const originalCollectTo = process.env.COLLECT_TO
const originalDriftCheckFrom = process.env.DRIFT_CHECK_FROM
const originalDriftCheckTo = process.env.DRIFT_CHECK_TO

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GH_RO_CLASSIC_TOKEN = 'test-token'
  delete process.env.COLLECT_DATE
  delete process.env.COLLECT_FROM
  delete process.env.COLLECT_TO
  delete process.env.DRIFT_CHECK_FROM
  delete process.env.DRIFT_CHECK_TO
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()

  restoreEnv('GH_RO_CLASSIC_TOKEN', originalGitHubToken)
  restoreEnv('COLLECT_DATE', originalCollectDate)
  restoreEnv('COLLECT_FROM', originalCollectFrom)
  restoreEnv('COLLECT_TO', originalCollectTo)
  restoreEnv('DRIFT_CHECK_FROM', originalDriftCheckFrom)
  restoreEnv('DRIFT_CHECK_TO', originalDriftCheckTo)
})

test('run dispatches daily collection for configured account', async () => {
  await seedAccount()

  await collect.run({
    config: shiplogConfig(),
    date: '2026-05-07',
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{
    activity_on: Date | string
    total_commit_contributions: number
  }>('SELECT activity_on, total_commit_contributions FROM daily_user_summary')
  const activity = await db.query<{ commits: number }>(
    'SELECT commits FROM daily_repository_activity'
  )

  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-07')
  expect(summaries.rows[0]!.total_commit_contributions).toBe(3)
  expect(activity.rows[0]!.commits).toBe(1)
})

test('run catches up missing collect dates and advances checkpoint', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-05' })

  await collect.run({
    config: shiplogConfig({ lookbackDays: 0 }),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{ activity_on: Date | string }>(
    'SELECT activity_on FROM daily_user_summary ORDER BY activity_on'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(summaries.rows.map((row) => dateOnly(row.activity_on))).toEqual([
    '2026-05-06',
    '2026-05-07'
  ])
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('run skips automatic collect when account is already current', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })

  await collect.run({
    config: shiplogConfig({ lookbackDays: 0 }),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: async () => {
      throw new Error('fetch should not be called')
    }
  })

  const summaries = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM daily_user_summary'
  )

  expect(summaries.rows[0]!.count).toBe(0)
})

test('run rechecks configured lookback dates when account is already current', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })

  await collect.run({
    config: shiplogConfig({ lookbackDays: 3 }),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{ activity_on: Date | string }>(
    'SELECT activity_on FROM daily_user_summary ORDER BY activity_on'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(summaries.rows.map((row) => dateOnly(row.activity_on))).toEqual([
    '2026-05-05',
    '2026-05-06',
    '2026-05-07'
  ])
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('collectDatesForAccount processes new dates before lookback dates', () => {
  expect(collect.collectDatesForAccount(accountRow('2026-05-05'), '2026-05-07', {}, 3)).toEqual([
    '2026-05-06',
    '2026-05-07',
    '2026-05-05'
  ])
})

test('run uses COLLECT_DATE when date option is omitted', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-05' })
  process.env.COLLECT_DATE = '2026-05-07'

  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{ activity_on: Date | string }>(
    'SELECT activity_on FROM daily_user_summary'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-07')
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-05')
})

test('run uses COLLECT_FROM and COLLECT_TO without moving the checkpoint', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-01' })
  process.env.COLLECT_FROM = '2026-05-05'
  process.env.COLLECT_TO = '2026-05-07'

  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{ activity_on: Date | string }>(
    'SELECT activity_on FROM daily_user_summary ORDER BY activity_on'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(summaries.rows.map((row) => dateOnly(row.activity_on))).toEqual([
    '2026-05-05',
    '2026-05-06',
    '2026-05-07'
  ])
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-01')
})

test('run drift-checks a range and re-collects mismatched summaries only', async () => {
  const account = await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  await seedDailySummary(account.id, '2026-05-05', { commits: 3, pullRequests: 1 })
  await seedDailySummary(account.id, '2026-05-06', { commits: 0, pullRequests: 0 })
  process.env.DRIFT_CHECK_FROM = '2026-05-05'
  process.env.DRIFT_CHECK_TO = '2026-05-06'

  const calls = { commitRequests: 0 }
  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: countingGitHubFetch(calls)
  })

  const summaries = await db.query<{
    activity_on: Date | string
    total_commit_contributions: number
    total_pull_request_contributions: number
  }>(
    'SELECT activity_on, total_commit_contributions, total_pull_request_contributions FROM daily_user_summary ORDER BY activity_on'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(calls.commitRequests).toBe(1)
  expect(summaries.rows.map((row) => dateOnly(row.activity_on))).toEqual([
    '2026-05-05',
    '2026-05-06'
  ])
  expect(summaries.rows[1]).toMatchObject({
    total_commit_contributions: 3,
    total_pull_request_contributions: 1
  })
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('run drift-checks a clean range without re-collecting', async () => {
  const account = await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  await seedDailySummary(account.id, '2026-05-05', { commits: 3, pullRequests: 1 })
  process.env.DRIFT_CHECK_FROM = '2026-05-05'
  process.env.DRIFT_CHECK_TO = '2026-05-05'

  const calls = { commitRequests: 0 }
  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: countingGitHubFetch(calls)
  })

  expect(calls.commitRequests).toBe(0)
})

test('run drift-checks missing summaries and re-collects them', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  process.env.DRIFT_CHECK_FROM = '2026-05-05'
  process.env.DRIFT_CHECK_TO = '2026-05-05'

  const calls = { commitRequests: 0 }
  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: countingGitHubFetch(calls)
  })

  const summaries = await db.query<{
    activity_on: Date | string
    total_commit_contributions: number
  }>('SELECT activity_on, total_commit_contributions FROM daily_user_summary')
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )

  expect(calls.commitRequests).toBe(1)
  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-05')
  expect(summaries.rows[0]!.total_commit_contributions).toBe(3)
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
})

test('run refreshes renamed account login by stable external id', async () => {
  await seedAccount({ externalLogin: 'old-octocat' })

  await collect.run({
    config: shiplogConfig(),
    date: '2026-05-07',
    fetch: mockGitHubFetch()
  })

  const accounts = await db.query<{ external_login: string }>(
    'SELECT external_login FROM accounts WHERE external_id = $1',
    ['U_TEST_1']
  )

  expect(accounts.rows[0]!.external_login).toBe('octocat')
})

test('run rejects future COLLECT_DATE', async () => {
  await seedAccount()
  process.env.COLLECT_DATE = '2026-05-08'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/COLLECT_DATE.*2026-05-07.*2026-05-08/)
})

test('run rejects incomplete collect ranges', async () => {
  await seedAccount()
  process.env.COLLECT_FROM = '2026-05-05'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/COLLECT_FROM and COLLECT_TO/)
})

test('run rejects collect date mixed with collect range', async () => {
  await seedAccount()
  process.env.COLLECT_DATE = '2026-05-07'
  process.env.COLLECT_FROM = '2026-05-05'
  process.env.COLLECT_TO = '2026-05-07'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/COLLECT_DATE cannot be combined/)
})

test('run rejects invalid collect range dates', async () => {
  await seedAccount()
  process.env.COLLECT_FROM = '2026-05-08'
  process.env.COLLECT_TO = '2026-05-07'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/COLLECT_FROM must be on or before COLLECT_TO/)
})

test('run rejects incomplete drift check ranges', async () => {
  await seedAccount()
  process.env.DRIFT_CHECK_FROM = '2026-05-05'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/DRIFT_CHECK_FROM and DRIFT_CHECK_TO/)
})

test('run rejects drift checks mixed with collect requests', async () => {
  await seedAccount()
  process.env.COLLECT_DATE = '2026-05-07'
  process.env.DRIFT_CHECK_FROM = '2026-05-05'
  process.env.DRIFT_CHECK_TO = '2026-05-07'

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/drift checks cannot be combined/)
})

test('run throws when account has not been initialized', async () => {
  await expect(
    collect.run({
      config: shiplogConfig(),
      date: '2026-05-07',
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/run bun run init first/i)
})

async function seedAccount(
  options: { externalLogin?: string; lastSuccessfulCollectOn?: string } = {}
): Promise<AccountRow> {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: options.externalLogin ?? 'octocat',
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

function shiplogConfig(options: { lookbackDays?: number } = {}): ShiplogConfig {
  return {
    version: 1,
    profile: { displayName: 'Example User' },
    collect: {
      lookbackDays: options.lookbackDays ?? 7,
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

function accountRow(lastSuccessfulCollectOn: string | null): AccountRow {
  return {
    id: 1,
    user_id: 1,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2026-01-01T00:00:00Z',
    first_seen_on: '2026-05-07',
    last_successful_collect_on: lastSuccessfulCollectOn,
    captured_at: '2026-05-07T00:00:00Z',
    created_at: '2026-05-07T00:00:00Z',
    updated_at: '2026-05-07T00:00:00Z'
  }
}

function mockGitHubFetch(): typeof fetch {
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

      if (body.query.includes('query Contributions')) {
        return jsonResponse({ data: githubContributionsFixture() })
      }

      if (body.query.includes('query RepositoryCommits')) {
        return jsonResponse({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    totalCount: 1,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        oid: 'abc123',
                        committedDate: '2026-05-07T12:34:56Z',
                        additions: 10,
                        deletions: 2,
                        changedFiles: 3,
                        messageHeadline: 'Ship it',
                        author: githubCommitActor(),
                        authors: { nodes: [githubCommitActor()] }
                      }
                    ]
                  }
                }
              }
            }
          }
        })
      }
    }

    const parsed = new URL(url)
    const q = parsed.searchParams.get('q') ?? ''

    if (parsed.pathname === '/user/repos') {
      return jsonResponse([])
    }

    if (parsed.pathname === '/search/issues' && q.includes('type:pr author:')) {
      return jsonResponse({ total_count: 0, items: [] })
    }

    if (parsed.pathname === '/search/issues' && q.includes('type:issue author:')) {
      return jsonResponse({ total_count: 0, items: [] })
    }

    if (parsed.pathname === '/search/issues' && q.includes('reviewed-by:')) {
      return jsonResponse({ total_count: 0, items: [] })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function countingGitHubFetch(calls: { commitRequests: number }): typeof fetch {
  const baseFetch = mockGitHubFetch()
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('query RepositoryCommits')) calls.commitRequests += 1
    }

    return baseFetch(url, init)
  }) as typeof fetch
}

function githubContributionsFixture(): {
  user: {
    contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
  }
} {
  return JSON.parse(
    fs.readFileSync(
      path.join(import.meta.dir, '..', 'fixtures', 'github_contributions_collection.json'),
      'utf8'
    )
  ) as {
    user: {
      contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
    }
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function githubCommitActor(): import('../../lib/providers/github/types.ts').GitHubCommitActor {
  return {
    name: 'octocat',
    email: 'octocat@example.com',
    user: { id: 'U_TEST_1', login: 'octocat' }
  }
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
