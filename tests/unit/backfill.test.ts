import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as backfill from '../../bin/backfill.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')
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

test('run backfills initialized accounts through yesterday and advances checkpoint', async () => {
  await seedAccount()

  await backfill.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    fetch: mockGitHubFetch()
  })

  const accounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const state = await db.query<{ status: string; backfill_through_on: Date | string }>(
    'SELECT status, backfill_through_on FROM repository_backfill_state'
  )

  expect(dateOnly(accounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
  expect(commits.rows[0]!.count).toBe(1)
  expect(state.rows[0]).toMatchObject({ status: 'succeeded' })
  expect(dateOnly(state.rows[0]!.backfill_through_on)).toBe('2026-05-07')
})

test('run with repository limit advances checkpoint only after all repositories complete', async () => {
  await seedAccount()
  const fetch = mockGitHubFetch({ includePrivateRepository: true })

  await backfill.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    repositoryLimit: 1,
    fetch
  })

  const partialAccounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  const partialState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
  )

  await backfill.run({
    config: shiplogConfig(),
    now: new Date('2026-05-08T00:00:00Z'),
    repositoryLimit: 1,
    fetch
  })

  const completeAccounts = await db.query<{ last_successful_collect_on: Date | string | null }>(
    'SELECT last_successful_collect_on FROM accounts'
  )
  const completeState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
  )

  expect(partialAccounts.rows[0]!.last_successful_collect_on).toBeNull()
  expect(partialState.rows[0]!.count).toBe(1)
  expect(dateOnly(completeAccounts.rows[0]!.last_successful_collect_on!)).toBe('2026-05-07')
  expect(completeState.rows[0]!.count).toBe(2)
})

test('run throws when account has not been initialized', async () => {
  await expect(
    backfill.run({
      config: shiplogConfig(),
      now: new Date('2026-05-08T00:00:00Z'),
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

function mockGitHubFetch(options: { includePrivateRepository?: boolean } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: Record<string, unknown>
      }

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
        expect(body.variables?.author).toEqual({ id: 'U_TEST_1' })
        const name = body.variables?.name
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
                        oid: name === 'secret' ? 'private-commit-1' : 'abc123',
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
        const isPrivate = body.variables?.name === 'secret'
        return jsonResponse({
          data: {
            repository: {
              stargazerCount: isPrivate ? 0 : 10,
              forkCount: isPrivate ? 0 : 2,
              isArchived: false,
              isPrivate,
              languages: {
                edges: [
                  { size: 800, node: { name: isPrivate ? 'TypeScript' : 'Go' } },
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
      return jsonResponse(options.includePrivateRepository ? [privateRepositoryFixture()] : [])
    }

    if (q.includes('repo:octocat/secret')) {
      return jsonResponse({ total_count: 0, items: [] })
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

function privateRepositoryFixture(): import('../../lib/providers/github/types.ts').GitHubRestRepository {
  return {
    node_id: 'R_PRIVATE_1',
    name: 'secret',
    full_name: 'octocat/secret',
    private: true,
    fork: false,
    archived: false,
    language: 'TypeScript',
    stargazers_count: 0,
    forks_count: 0,
    created_at: '2024-01-01T00:00:00Z',
    pushed_at: '2026-05-07T12:00:00Z',
    default_branch: 'main',
    html_url: 'https://github.com/octocat/secret',
    description: 'private test repository',
    owner: {
      login: 'octocat',
      node_id: 'U_TEST_1',
      type: 'User',
      avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
    }
  }
}

function githubContributionsFixture(): {
  user: {
    contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
  }
} {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'github_contributions_collection.json'), 'utf8')
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
