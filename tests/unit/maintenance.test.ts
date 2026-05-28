import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as maintenance from '../../bin/maintenance.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { AccountRow, ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GH_RO_CLASSIC_TOKEN

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GH_RO_CLASSIC_TOKEN = 'test-token'
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()

  if (originalGitHubToken === undefined) {
    delete process.env.GH_RO_CLASSIC_TOKEN
  } else {
    process.env.GH_RO_CLASSIC_TOKEN = originalGitHubToken
  }
})

test('run executes due repair tasks without moving the collect checkpoint', async () => {
  const account = await seedAccount({ lastSuccessfulCollectOn: '2026-05-01' })
  await upserts.enqueueMaintenanceRepairTask({
    account_id: account.id,
    target_from_on: '2026-05-07',
    target_to_on: '2026-05-07',
    reason: 'drift',
    next_run_at: '2026-05-08T00:00:00Z'
  })

  await maintenance.run({
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
  const tasks = await db.query<{ status: string; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM maintenance_tasks'
  )

  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-07')
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-01')
  expect(tasks.rows[0]).toMatchObject({
    status: 'succeeded',
    attempts: 1,
    last_error: null
  })
})

test('enqueueMaintenanceRepairTask deduplicates pending repair work', async () => {
  const account = await seedAccount()

  const first = await upserts.enqueueMaintenanceRepairTask({
    account_id: account.id,
    target_from_on: '2026-05-05',
    target_to_on: '2026-05-07',
    priority: 1,
    reason: 'lookback'
  })
  const second = await upserts.enqueueMaintenanceRepairTask({
    account_id: account.id,
    target_from_on: '2026-05-05',
    target_to_on: '2026-05-07',
    priority: 5,
    reason: 'drift'
  })

  const tasks = await db.query<{ count: number; priority: number; reason: string }>(
    'SELECT COUNT(*)::int AS count, MAX(priority)::int AS priority, MAX(reason) AS reason FROM maintenance_tasks'
  )

  expect(second.id).toBe(first.id)
  expect(tasks.rows[0]).toMatchObject({ count: 1, priority: 5, reason: 'drift' })
})

test('enqueueMaintenanceRepairTask reopens succeeded repair work', async () => {
  const account = await seedAccount()
  const first = await upserts.enqueueMaintenanceRepairTask({
    account_id: account.id,
    target_from_on: '2026-05-05',
    target_to_on: '2026-05-07',
    reason: 'initial repair'
  })

  await upserts.markMaintenanceTaskRunning(first.id)
  await upserts.markMaintenanceTaskSucceeded(first.id)

  const reopened = await upserts.enqueueMaintenanceRepairTask({
    account_id: account.id,
    target_from_on: '2026-05-05',
    target_to_on: '2026-05-07',
    reason: 'new drift',
    next_run_at: '2026-05-08T00:00:00Z'
  })

  expect(reopened.id).toBe(first.id)
  expect(reopened).toMatchObject({
    status: 'pending',
    attempts: 0,
    reason: 'new drift',
    locked_at: null,
    started_at: null,
    completed_at: null,
    last_error: null
  })
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

      if (body.query.includes('query RepositoryLanguages')) {
        return jsonResponse({
          data: {
            repository: {
              stargazerCount: 10,
              forkCount: 2,
              isArchived: false,
              isPrivate: false,
              languages: {
                edges: [
                  { size: 800, node: { name: 'Go' } },
                  { size: 200, node: { name: 'Shell' } }
                ]
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

function githubCommitActor(): import('../../lib/providers/github/types.ts').GitHubCommitActor {
  return {
    name: 'octocat',
    email: 'octocat@example.com',
    user: { id: 'U_TEST_1', login: 'octocat' }
  }
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

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}
