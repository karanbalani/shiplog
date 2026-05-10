import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as collect from '../../bin/collect.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { ProfileConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GITHUB_API_TOKEN
const originalCollectDate = process.env.COLLECT_DATE

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GITHUB_API_TOKEN = 'test-token'
  delete process.env.COLLECT_DATE
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()

  restoreEnv('GITHUB_API_TOKEN', originalGitHubToken)
  restoreEnv('COLLECT_DATE', originalCollectDate)
})

test('run dispatches daily collection for configured account', async () => {
  await seedAccount()

  await collect.run({
    profileConfig: profileConfig(),
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

test('run uses COLLECT_DATE when date option is omitted', async () => {
  await seedAccount()
  process.env.COLLECT_DATE = '2026-05-07'

  await collect.run({
    profileConfig: profileConfig(),
    fetch: mockGitHubFetch()
  })

  const summaries = await db.query<{ activity_on: Date | string }>(
    'SELECT activity_on FROM daily_user_summary'
  )

  expect(dateOnly(summaries.rows[0]!.activity_on)).toBe('2026-05-07')
})

test('run throws when account has not been initialized', async () => {
  await expect(
    collect.run({
      profileConfig: profileConfig(),
      date: '2026-05-07',
      fetch: mockGitHubFetch()
    })
  ).rejects.toThrow(/run bun run init first/i)
})

async function seedAccount(): Promise<void> {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2026-01-01T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
}

function profileConfig(): ProfileConfig {
  return {
    displayName: 'Example User',
    identities: [
      {
        provider: 'github',
        login: 'octocat',
        ignoreOrganizations: [],
        ignoreRepositories: []
      }
    ],
    publishTargets: [
      {
        provider: 'github',
        repositoryFullName: 'octocat/octocat',
        branch: 'main',
        path: 'README.md',
        tokenEnv: 'GITHUB_README_TOKEN'
      }
    ],
    render: {
      topLanguagesCount: 7,
      topPublicProjectsCount: 6,
      lastYearWindowDays: 365
    }
  }
}

function mockGitHubFetch(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

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
                        messageHeadline: 'Ship it'
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
      path.join(import.meta.dir, '..', 'fixtures', 'github-contributions-collection.json'),
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
