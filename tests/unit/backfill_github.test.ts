import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as backfillGitHub from '../../bin/backfill_github.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()
})

test('run backfills GitHub history into generic schema tables', async () => {
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: `${new Date().getUTCFullYear()}-01-01T00:00:00Z`,
    first_seen_on: '2026-05-07'
  })

  await backfillGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    fetch: mockGitHubFetch()
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories'
  )
  const organizations = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM organizations'
  )
  const linkedRepositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories WHERE organization_id IS NOT NULL'
  )
  const repositorySnapshots = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_snapshots'
  )
  const repositoryLanguages = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_languages'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const pullRequests = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_requests'
  )
  const reviews = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_request_reviews'
  )
  const issues = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM issues')
  const summaries = await db.query<{ source: string; total_commit_contributions: number }>(
    'SELECT source, total_commit_contributions FROM daily_user_summary'
  )
  const activity = await db.query<{
    commits: number
    prs_merged: number
    pr_reviews_total: number
    issues_closed: number
    source: string
  }>('SELECT * FROM daily_repository_activity')

  expect(repositories.rows[0]!.count).toBe(1)
  expect(organizations.rows[0]!.count).toBe(1)
  expect(linkedRepositories.rows[0]!.count).toBe(1)
  expect(repositorySnapshots.rows[0]!.count).toBe(1)
  expect(repositoryLanguages.rows[0]!.count).toBe(2)
  expect(commits.rows[0]!.count).toBe(1)
  expect(pullRequests.rows[0]!.count).toBe(1)
  expect(reviews.rows[0]!.count).toBe(1)
  expect(issues.rows[0]!.count).toBe(1)
  expect(summaries.rows[0]).toMatchObject({
    source: 'self_backfill',
    total_commit_contributions: 3
  })
  expect(activity.rows[0]).toMatchObject({
    commits: 1,
    prs_merged: 1,
    pr_reviews_total: 1,
    issues_closed: 1,
    source: 'self_backfill'
  })
  expect(logs.some((line) => line.includes('[public] octo-org/hello'))).toBe(true)
  expect(logs.some((line) => line.includes('estimated minimum GitHub Search pacing'))).toBe(true)
  expect(logs.some((line) => line.includes('eta'))).toBe(true)
})

test('run backfills accessible private repositories outside contribution groups', async () => {
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: `${new Date().getUTCFullYear()}-01-01T00:00:00Z`,
    first_seen_on: '2026-05-07'
  })

  await backfillGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    fetch: mockGitHubFetchWithPrivateRepository()
  })

  const repositories = await db.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM repositories WHERE visibility = 'private'"
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const activity = await db.query<{ commits: number }>(
    'SELECT commits FROM daily_repository_activity'
  )

  expect(repositories.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.count).toBe(1)
  expect(activity.rows[0]!.commits).toBe(1)
  expect(logs.some((line) => line.includes('[private] octocat/secret'))).toBe(true)
})

test('estimatedSearchPacingMs estimates minimum GitHub search throttle time', () => {
  expect(backfillGitHub.estimatedSearchPacingMs(0)).toBe(0)
  expect(backfillGitHub.estimatedSearchPacingMs(1)).toBe(5000)
  expect(backfillGitHub.estimatedSearchPacingMs(2)).toBe(12500)
})

test('estimatedRemainingMs estimates from elapsed completed work', () => {
  expect(backfillGitHub.estimatedRemainingMs(1000, 2, 5, 7000)).toBe(9000)
  expect(backfillGitHub.estimatedRemainingMs(1000, 0, 5, 7000)).toBe(0)
  expect(backfillGitHub.estimatedRemainingMs(1000, 5, 5, 7000)).toBe(0)
})

test('formatDuration produces compact human-readable durations', () => {
  expect(backfillGitHub.formatDuration(12_400)).toBe('12s')
  expect(backfillGitHub.formatDuration(90_000)).toBe('1m 30s')
  expect(backfillGitHub.formatDuration(3_660_000)).toBe('1h 1m')
})

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
      return jsonResponse({
        total_count: 1,
        items: [
          {
            node_id: 'ISSUE_TEST_1',
            number: 7,
            title: 'Question',
            html_url: 'https://github.com/octo-org/hello/issues/7',
            state: 'closed',
            created_at: '2026-05-07T07:00:00Z',
            closed_at: '2026-05-07T13:00:00Z'
          }
        ]
      })
    }

    if (parsed.pathname === '/search/issues' && q.includes('reviewed-by:')) {
      return jsonResponse({
        total_count: 1,
        items: [
          {
            node_id: 'PR_REVIEWED_1',
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

    if (parsed.pathname === '/repos/octo-org/hello/pulls/42/reviews') {
      return jsonResponse([
        {
          node_id: 'REVIEW_TEST_1',
          user: { login: 'octocat' },
          state: 'APPROVED',
          submitted_at: '2026-05-07T09:00:00Z'
        }
      ])
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithPrivateRepository(): typeof fetch {
  const currentYear = new Date().getUTCFullYear()

  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: Record<string, string>
      }

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
          data: {
            user: {
              contributionsCollection: {
                totalCommitContributions: 1,
                totalIssueContributions: 0,
                totalPullRequestContributions: 0,
                totalPullRequestReviewContributions: 0,
                restrictedContributionsCount: 0,
                commitContributionsByRepository: [],
                pullRequestContributionsByRepository: [],
                pullRequestReviewContributionsByRepository: [],
                issueContributionsByRepository: []
              }
            }
          }
        })
      }

      if (body.query.includes('query RepositoryCommits')) {
        expect(body.variables?.name).toBe('secret')
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
                        oid: 'private-commit-1',
                        committedDate: '2026-05-07T12:34:56Z',
                        additions: 4,
                        deletions: 1,
                        changedFiles: 2,
                        messageHeadline: 'Private work'
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
              stargazerCount: 0,
              forkCount: 0,
              isArchived: false,
              isPrivate: true,
              languages: {
                edges: [{ size: 100, node: { name: 'TypeScript' } }]
              }
            }
          }
        })
      }
    }

    const parsed = new URL(url)

    if (parsed.pathname === '/user/repos') {
      return jsonResponse([
        {
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
      ])
    }

    if (parsed.pathname === '/search/issues') {
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
    fs.readFileSync(path.join(FIXTURES, 'github_contributions_collection.json'), 'utf8')
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
