import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as init from '../../bin/init.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { ProfileConfig } from '../../lib/types/index.ts'

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

test('run creates account from config identity and collects initial history', async () => {
  await init.run({
    profileConfig: profileConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })

  const users = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users')
  const accounts = await db.query<{
    external_login: string
    external_id: string
    last_successful_collect_on: Date | string | null
  }>('SELECT external_login, external_id, last_successful_collect_on FROM accounts')
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(users.rows[0]!.count).toBe(1)
  expect(accounts.rows[0]).toMatchObject({
    external_login: 'octocat',
    external_id: 'U_TEST_1'
  })
  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
  expect(commits.rows[0]!.count).toBe(1)
})

test('run skips initial history when collect checkpoint is current', async () => {
  await init.run({
    profileConfig: profileConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })
  await init.run({
    profileConfig: profileConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })

  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(commits.rows[0]!.count).toBe(1)
})

function profileConfig(): ProfileConfig {
  return {
    displayName: 'Example User',
    identities: [
      {
        provider: 'github',
        login: 'octocat',
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        organizationTokens: [],
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
        tokenEnv: 'GH_RW_REPO_TOKEN'
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
  const currentYear = new Date().getUTCFullYear()

  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes('query ViewerAndUser')) {
        return jsonResponse({
          data: {
            user: {
              id: 'U_TEST_1',
              login: 'octocat',
              name: 'Octocat',
              url: 'https://github.com/octocat',
              createdAt: `${currentYear}-01-01T00:00:00Z`
            }
          }
        })
      }

      if (body.query.includes('query Contributions')) {
        return jsonResponse({
          data: githubContributionsFixture()
        })
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
      return jsonResponse({
        total_count: 1,
        items: [
          {
            node_id: 'PR_TEST_1',
            number: 42,
            title: 'Improve collector',
            html_url: 'https://github.com/octo-org/hello/pull/42',
            state: 'closed',
            created_at: '2026-05-07T08:00:00Z',
            closed_at: '2026-05-07T10:00:00Z',
            pull_request: { merged_at: '2026-05-07T10:00:00Z' }
          }
        ]
      })
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
