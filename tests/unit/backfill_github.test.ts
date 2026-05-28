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
  const repositoryBackfillState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
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
  expect(repositoryBackfillState.rows[0]!.count).toBe(1)
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
  expect(
    logs.some((line) => line.includes('  - repository 1/1 [public] octo-org/hello: commits for'))
  ).toBe(true)
  expect(
    logs.some((line) => line.includes('  - repository 1/1 [public] octo-org/hello: pull requests'))
  ).toBe(true)
  expect(
    logs.some((line) =>
      line.includes('  - repository 1/1 [public] octo-org/hello: repository snapshot and languages')
    )
  ).toBe(true)
  expect(logs.some((line) => line.includes('estimated minimum GitHub Search pacing'))).toBe(true)
  expect(logs.some((line) => line.includes('eta'))).toBe(true)
})

test('run skips repositories that already have successful backfill state', async () => {
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
  const fetch = mockGitHubFetch()
  let commitRequests = 0
  const countingFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('query RepositoryCommits')) commitRequests += 1
    }
    return fetch(url, init)
  }) as typeof fetch

  const args = {
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    fetch: countingFetch
  }

  await backfillGitHub.run(args)
  await backfillGitHub.run(args)

  expect(commitRequests).toBe(1)
  expect(logs.some((line) => line.includes('already complete'))).toBe(true)
})

test('run does not treat repository snapshots as backfill completion state', async () => {
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
  const repository = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_TEST_1',
    organization_id: null,
    owner_login: 'octo-org',
    name: 'hello',
    full_name: 'octo-org/hello',
    web_url: 'https://github.com/octo-org/hello',
    description: 'Test repo',
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
  await upserts.upsertRepositorySnapshot({
    repository_id: repository.id,
    captured_on: '2026-05-07',
    star_count: 10,
    fork_count: 2,
    is_archived: false,
    visibility: 'public'
  })

  const fetch = mockGitHubFetch()
  let commitRequests = 0
  const countingFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('query RepositoryCommits')) commitRequests += 1
    }
    return fetch(url, init)
  }) as typeof fetch

  await backfillGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    throughDate: '2026-05-07',
    fetch: countingFetch
  })

  const state = await db.query<{ status: string }>(
    'SELECT status FROM repository_backfill_state WHERE repository_id = $1',
    [repository.id]
  )

  expect(commitRequests).toBe(1)
  expect(state.rows[0]!.status).toBe('succeeded')
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
  expect(logs.join('\n')).toContain('[private] id:R_PRIVATE_1')
  expect(logs.join('\n')).not.toContain('octocat/secret')
})

test('run skips repositories that GitHub no longer resolves', async () => {
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
    fetch: mockGitHubFetchWithUnavailableRepository()
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(repositories.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.count).toBe(0)
  expect(logs.some((line) => line.includes('[public] octocat/deleted'))).toBe(true)
  expect(logs.some((line) => line.includes('is unavailable; skipping enrichment'))).toBe(true)
})

test('run can pause after a repository budget and resume remaining work', async () => {
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
  const args = {
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    repositoryLimit: 1,
    fetch: mockGitHubFetchWithTwoRepositories()
  }

  const first = await backfillGitHub.run(args)
  const firstState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
  )
  const second = await backfillGitHub.run(args)
  const secondState = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(first).toMatchObject({
    complete: false,
    repositoriesDiscovered: 2,
    repositoriesProcessed: 1,
    repositoriesDeferred: 1
  })
  expect(firstState.rows[0]!.count).toBe(1)
  expect(second).toMatchObject({
    complete: true,
    repositoriesDiscovered: 2,
    repositoriesProcessed: 1,
    repositoriesDeferred: 0
  })
  expect(secondState.rows[0]!.count).toBe(2)
  expect(commits.rows[0]!.count).toBe(2)
  expect(logs.some((line) => line.includes('deferred by budget'))).toBe(true)
  expect(logs.some((line) => line.includes('paused after 1 repository'))).toBe(true)
  expect(logs.some((line) => line.includes('already complete'))).toBe(true)
})

test('run can pause after a time budget before starting another repository', async () => {
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

  const originalDateNow = Date.now
  let nowCalls = 0
  Date.now = () => {
    nowCalls += 1
    return nowCalls <= 2 ? 0 : 10
  }

  try {
    const result = await backfillGitHub.run({
      identity: {
        accountId: account.id,
        externalLogin: account.external_login,
        externalId: account.external_id
      },
      token: 'test-token',
      maxRuntimeMs: 5,
      fetch: mockGitHubFetchWithTwoRepositories()
    })

    const state = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM repository_backfill_state'
    )
    const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

    expect(result).toMatchObject({
      complete: false,
      repositoriesDiscovered: 2,
      repositoriesProcessed: 1,
      repositoriesDeferred: 1
    })
    expect(state.rows[0]!.count).toBe(1)
    expect(commits.rows[0]!.count).toBe(1)
    expect(logs.some((line) => line.includes('deferred by time budget'))).toBe(true)
    expect(logs.some((line) => line.includes('paused after 1 repository'))).toBe(true)
  } finally {
    Date.now = originalDateNow
  }
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
              createdAt: `${currentYear}-01-01T00:00:00Z`
            }
          }
        })
      }

      if (body.query.includes('query Contributions')) {
        return jsonResponse({ data: githubContributionsFixture() })
      }

      if (body.query.includes('query RepositoryCommits')) {
        expect(body.variables?.author).toEqual({ id: 'U_TEST_1' })
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

      if (body.query.includes('query UserById')) {
        return jsonResponse({
          data: {
            node: {
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
                        messageHeadline: 'Private work',
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

function mockGitHubFetchWithUnavailableRepository(): typeof fetch {
  const currentYear = new Date().getUTCFullYear()

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
              createdAt: `${currentYear}-01-01T00:00:00Z`
            }
          }
        })
      }

      if (body.query.includes('query Contributions')) {
        return jsonResponse({
          data: githubContributionsWithRepository({
            id: 'R_DELETED_1',
            nameWithOwner: 'octocat/deleted',
            owner: { __typename: 'User', id: 'U_TEST_1', login: 'octocat' },
            isPrivate: false,
            isFork: false,
            isArchived: false,
            primaryLanguage: null,
            stargazerCount: 0,
            forkCount: 0,
            createdAt: '2020-01-01T00:00:00Z',
            pushedAt: null,
            defaultBranchRef: null,
            url: 'https://github.com/octocat/deleted',
            description: null
          })
        })
      }

      if (body.query.includes('query RepositoryCommits')) {
        return jsonResponse({
          data: { repository: null },
          errors: [
            {
              message: "Could not resolve to a Repository with the name 'octocat/deleted'."
            }
          ]
        })
      }
    }

    const parsed = new URL(url)

    if (parsed.pathname === '/user/repos') {
      return jsonResponse([])
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithTwoRepositories(): typeof fetch {
  const currentYear = new Date().getUTCFullYear()

  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: Record<string, string>
      }

      if (body.query.includes('query UserById')) {
        return jsonResponse({
          data: {
            node: {
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
        return jsonResponse({ data: githubContributionsWithRepository(publicRepositoryNode()) })
      }

      if (body.query.includes('query RepositoryCommits')) {
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
                        oid: name === 'secret' ? 'private-commit-1' : 'public-commit-1',
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
                edges: [{ size: 100, node: { name: isPrivate ? 'TypeScript' : 'Go' } }]
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
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'github_contributions_collection.json'), 'utf8')
  ) as {
    user: {
      contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
    }
  }
  const collection = fixture.user.contributionsCollection
  const repository = collection.commitContributionsByRepository[0]!.repository
  const contribution = { repository, contributions: { totalCount: 1 } }

  collection.totalIssueContributions = 1
  collection.totalPullRequestReviewContributions = 1
  collection.pullRequestContributionsByRepository = [contribution]
  collection.issueContributionsByRepository = [contribution]
  collection.pullRequestReviewContributionsByRepository = [contribution]

  return fixture
}

function publicRepositoryNode(): import('../../lib/providers/github/types.ts').GitHubRepositoryNode {
  return {
    id: 'R_TEST_1',
    nameWithOwner: 'octo-org/hello',
    owner: {
      __typename: 'Organization',
      id: 'O_TEST_1',
      login: 'octo-org',
      name: 'Octo Org',
      description: 'Example GitHub organization',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
      websiteUrl: 'https://example.com'
    },
    isPrivate: false,
    isFork: false,
    isArchived: false,
    primaryLanguage: { name: 'Go' },
    stargazerCount: 10,
    forkCount: 2,
    createdAt: '2020-01-01T00:00:00Z',
    pushedAt: '2026-05-07T12:00:00Z',
    defaultBranchRef: { name: 'main' },
    url: 'https://github.com/octo-org/hello',
    description: 'Test repo'
  }
}

function githubContributionsWithRepository(
  repository: import('../../lib/providers/github/types.ts').GitHubRepositoryNode
): {
  user: {
    contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
  }
} {
  return {
    user: {
      contributionsCollection: {
        totalCommitContributions: 1,
        totalIssueContributions: 0,
        totalPullRequestContributions: 0,
        totalPullRequestReviewContributions: 0,
        restrictedContributionsCount: 0,
        commitContributionsByRepository: [{ repository, contributions: { totalCount: 1 } }],
        pullRequestContributionsByRepository: [],
        pullRequestReviewContributionsByRepository: [],
        issueContributionsByRepository: []
      }
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
