import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as collect from '../../bin/collect.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { AccountRow, ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'
import { readWorkflowDiagnostics } from '../../lib/workflow_summary.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GH_RO_CLASSIC_TOKEN
const originalOrganizationToken = process.env.GH_RO_TEST_ORG_PAT_TOKEN
const originalCollectDate = process.env.COLLECT_DATE
const originalWorkflowDiagnosticsPath = process.env.SHIPLOG_DIAGNOSTICS_PATH

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GH_RO_CLASSIC_TOKEN = 'test-token'
  delete process.env.GH_RO_TEST_ORG_PAT_TOKEN
  delete process.env.COLLECT_DATE
  delete process.env.SHIPLOG_DIAGNOSTICS_PATH
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()

  restoreEnv('GH_RO_CLASSIC_TOKEN', originalGitHubToken)
  restoreEnv('GH_RO_TEST_ORG_PAT_TOKEN', originalOrganizationToken)
  restoreEnv('COLLECT_DATE', originalCollectDate)
  restoreEnv('SHIPLOG_DIAGNOSTICS_PATH', originalWorkflowDiagnosticsPath)
})

test('run collects yesterday when no checkpoint exists without backfilling history', async () => {
  await seedAccount()

  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{
    activity_on: Date | string
    total_commit_contributions: number
  }>('SELECT activity_on, total_commit_contributions FROM daily_user_summary')
  const activity = await db.query<{ commits: number }>(
    'SELECT commits FROM daily_repository_activity'
  )
  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  const backfillState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
  )

  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-07')
  expect(summaries.rows[0]!.total_commit_contributions).toBe(3)
  expect(activity.rows[0]!.commits).toBe(1)
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
  expect(backfillState.rows[0]!.count).toBe(0)
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
  expect(collect.collectDatesForAccount(accountRow('2026-05-05'), '2026-05-07', 3)).toEqual([
    '2026-05-06',
    '2026-05-07',
    '2026-05-05'
  ])
})

test('run refreshes renamed account login by stable external id', async () => {
  await seedAccount({ externalLogin: 'old-octocat', lastSuccessfulCollectOn: '2026-05-06' })

  await collect.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const accounts = await db.query<{ external_login: string }>(
    'SELECT external_login FROM accounts WHERE external_id = $1',
    ['U_TEST_1']
  )

  expect(accounts.rows[0]!.external_login).toBe('octocat')
})

test('run ignores legacy COLLECT_DATE env', async () => {
  await seedAccount({ lastSuccessfulCollectOn: '2026-05-07' })
  process.env.COLLECT_DATE = '2026-05-08'

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

test('runDates warns and skips a rejected optional organization token with its log prefix', async () => {
  await seedAccount()
  process.env.GH_RO_TEST_ORG_PAT_TOKEN = 'rejected-org-secret'
  const shiplog = shiplogConfig()
  shiplog.collect.accounts[0]!.organizationPatTokens = [
    { organizationId: 'O_TEST_1', tokenEnv: 'GH_RO_TEST_ORG_PAT_TOKEN' }
  ]
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const diagnosticsPath = temporaryDiagnosticsPath('optional-org-auth')
  process.env.SHIPLOG_DIAGNOSTICS_PATH = diagnosticsPath
  const primaryFetch = mockGitHubFetch()
  const fetch = (async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (
        body.query.includes('query OrganizationById') &&
        authorization === 'Bearer rejected-org-secret'
      ) {
        return new Response('Bad credentials', { status: 401 })
      }
    }
    return primaryFetch(String(url), init)
  }) as typeof globalThis.fetch

  const processedAccounts = await collect.runDates({
    config: shiplog,
    dates: ['2026-05-07'],
    logPrefix: 'maintenance',
    fetch
  })

  const summaries = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM daily_user_summary'
  )
  const output = logs.join('\n')
  expect(processedAccounts).toBe(1)
  expect(summaries.rows[0]!.count).toBe(1)
  expect(output).toContain('[maintenance] github/octocat')
  expect(output).toContain('SHIPLOG-GITHUB-AUTH-001')
  expect(output).toContain('GH_RO_TEST_ORG_PAT_TOKEN')
  expect(output).not.toContain('rejected-org-secret')
  expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
    expect.objectContaining({
      code: 'SHIPLOG-GITHUB-AUTH-001',
      severity: 'warning',
      step: 'run_maintenance',
      tokenEnv: 'GH_RO_TEST_ORG_PAT_TOKEN',
      recovered: true
    })
  ])
})

test('run records a rate limit while resolving an optional organization token', async () => {
  await seedAccount()
  process.env.GH_RO_TEST_ORG_PAT_TOKEN = 'rate-limited-org-secret'
  const shiplog = shiplogConfig()
  shiplog.collect.accounts[0]!.organizationPatTokens = [
    { organizationId: 'O_TEST_1', tokenEnv: 'GH_RO_TEST_ORG_PAT_TOKEN' }
  ]
  const diagnosticsPath = temporaryDiagnosticsPath('org-rate-limit')
  process.env.SHIPLOG_DIAGNOSTICS_PATH = diagnosticsPath
  const primaryFetch = mockGitHubFetch()
  const fetch = (async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (
        body.query.includes('query OrganizationById') &&
        authorization === 'Bearer rate-limited-org-secret'
      ) {
        return new Response('API rate limit exceeded', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0' }
        })
      }
    }
    return primaryFetch(String(url), init)
  }) as typeof globalThis.fetch

  await expect(
    collect.run({ config: shiplog, now: new Date('2026-05-08T00:00:00Z'), fetch })
  ).rejects.toThrow(/HTTP 403/i)

  expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
    expect.objectContaining({
      code: 'SHIPLOG-GITHUB-RATE-001',
      severity: 'error',
      step: 'collect_activity',
      tokenEnv: 'GH_RO_TEST_ORG_PAT_TOKEN',
      recovered: false
    })
  ])
})

test('run keeps a rejected primary token fatal and does not advance its checkpoint', async () => {
  await seedAccount()
  process.env.GH_RO_CLASSIC_TOKEN = 'rejected-primary-secret'
  const diagnosticsPath = temporaryDiagnosticsPath('primary-auth')
  process.env.SHIPLOG_DIAGNOSTICS_PATH = diagnosticsPath
  const fetch = (async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')
    if (
      url === 'https://api.github.com/graphql' &&
      authorization === 'Bearer rejected-primary-secret'
    ) {
      return new Response('Bad credentials', { status: 401 })
    }
    return new Response('unexpected request', { status: 500 })
  }) as typeof globalThis.fetch

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch
    })
  ).rejects.toThrow(/HTTP 401/i)

  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  expect(accounts.rows[0]!.last_successful_collect_on).toBeNull()
  expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
    expect.objectContaining({
      code: 'SHIPLOG-GITHUB-AUTH-001',
      severity: 'error',
      step: 'collect_activity',
      tokenEnv: 'GH_RO_CLASSIC_TOKEN',
      recovered: false
    })
  ])
})

test('run records an exhausted GitHub rate limit and keeps the checkpoint unchanged', async () => {
  await seedAccount()
  const diagnosticsPath = temporaryDiagnosticsPath('rate-limit')
  process.env.SHIPLOG_DIAGNOSTICS_PATH = diagnosticsPath
  const fetch = (async () =>
    new Response('API rate limit exceeded', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0' }
    })) as unknown as typeof globalThis.fetch

  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch
    })
  ).rejects.toThrow(/HTTP 403/i)

  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  expect(accounts.rows[0]!.last_successful_collect_on).toBeNull()
  expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
    expect.objectContaining({
      code: 'SHIPLOG-GITHUB-RATE-001',
      severity: 'error',
      step: 'collect_activity',
      tokenEnv: 'GH_RO_CLASSIC_TOKEN',
      recovered: false
    })
  ])
})

test('run throws when account has not been initialized', async () => {
  await expect(
    collect.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/run bun run init first/i)
})

async function seedAccount(
  options: { externalLogin?: string; lastSuccessfulCollectOn?: string } = {}
): Promise<void> {
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

function temporaryDiagnosticsPath(label: string): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `shiplog-collect-${label}-`)),
    'diagnostics.jsonl'
  )
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}
