import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as collectGitHub from '../../bin/collect_github.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import * as upserts from '../../lib/upserts.ts'
import { readWorkflowDiagnostics } from '../../lib/workflow_summary.ts'

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

test('run collects GitHub activity into generic schema tables', async () => {
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
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
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const pullRequests = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_requests'
  )
  const reviews = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_request_reviews'
  )
  const issues = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM issues')
  const summaries = await db.query<{
    total_commit_contributions: number
    total_pull_request_contributions: number
  }>('SELECT total_commit_contributions, total_pull_request_contributions FROM daily_user_summary')
  const activity = await db.query<{
    commits: number
    prs_opened: number
    prs_merged: number
    pr_reviews_total: number
    issues_opened: number
    issues_closed: number
  }>('SELECT * FROM daily_repository_activity')

  expect(repositories.rows[0]!.count).toBe(1)
  expect(organizations.rows[0]!.count).toBe(1)
  expect(linkedRepositories.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.count).toBe(1)
  expect(pullRequests.rows[0]!.count).toBe(1)
  expect(reviews.rows[0]!.count).toBe(1)
  expect(issues.rows[0]!.count).toBe(1)
  expect(summaries.rows[0]!.total_commit_contributions).toBe(3)
  expect(summaries.rows[0]!.total_pull_request_contributions).toBe(1)
  expect(activity.rows[0]!).toMatchObject({
    commits: 1,
    prs_opened: 1,
    prs_merged: 1,
    pr_reviews_total: 1,
    issues_opened: 1,
    issues_closed: 1
  })
  expect(logs.some((line) => line.includes('[collect] github/octocat: repository 1/1'))).toBe(true)
  expect(
    logs.some((line) => line.includes('  - repository 1/1 [public] octo-org/hello: commits'))
  ).toBe(true)
  expect(
    logs.some((line) =>
      line.includes('  - repository 1/1 [public] octo-org/hello: pull request reviews')
    )
  ).toBe(true)
})

test('run paginates daily search results and review details', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const paginated = mockGitHubFetchWithPaginatedDailyActivity()

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: paginated.fetch
  })

  const pullRequests = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_requests'
  )
  const reviews = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM pull_request_reviews'
  )

  expect(paginated.pullRequestPages).toEqual([1, 2])
  expect(paginated.reviewPages).toEqual([1, 2])
  expect(pullRequests.rows[0]!.count).toBe(101)
  expect(reviews.rows[0]!.count).toBe(101)
})

test('run ignores repositories through stable repository and organization ids', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    ignoreOrganizationIds: ['O_TEST_1'],
    ignoreRepositoryIds: ['R_UNUSED_1'],
    date: '2026-05-07',
    fetch: mockGitHubFetch()
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const activity = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM daily_repository_activity'
  )
  const summaries = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM daily_user_summary'
  )

  expect(repositories.rows[0]!.count).toBe(0)
  expect(commits.rows[0]!.count).toBe(0)
  expect(activity.rows[0]!.count).toBe(0)
  expect(summaries.rows[0]!.count).toBe(1)
})

test('run keeps daily collect scoped to contribution-group repositories', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: mockGitHubFetchWithReadablePrivateRepositoryOutsideContributionGroups()
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories'
  )
  const summaries = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM daily_user_summary'
  )

  expect(repositories.rows[0]!.count).toBe(0)
  expect(summaries.rows[0]!.count).toBe(1)
})

test('run uses organization token for organization-owned repositories', async () => {
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'default-token',
    organizationTokens: [
      {
        externalId: 'O_RESTRICTED_1',
        externalLogin: 'restricted-org',
        tokenEnv: 'GH_RO_RESTRICTED_ORG_TOKEN',
        token: 'org-token'
      }
    ],
    date: '2026-05-07',
    fetch: mockGitHubFetchWithOrganizationToken()
  })

  const repositories = await db.query<{
    full_name: string
    visibility: string
    owner_login: string
  }>('SELECT full_name, visibility, owner_login FROM repositories ORDER BY full_name')
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(repositories.rows).toEqual([
    {
      full_name: 'restricted-org/secret',
      visibility: 'private',
      owner_login: 'restricted-org'
    }
  ])
  expect(commits.rows[0]!.count).toBe(1)
  expect(logs.join('\n')).toContain('[private] id:R_RESTRICTED_1')
  expect(logs.join('\n')).not.toContain('restricted-org/secret')
})

test('run records primary auth rejection before sanitizing a private repository failure', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const diagnosticsPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-collect-private-auth-')),
    'diagnostics.jsonl'
  )
  const previousDiagnosticsPath = process.env.SHIPLOG_DIAGNOSTICS_PATH
  process.env.SHIPLOG_DIAGNOSTICS_PATH = diagnosticsPath

  try {
    await expect(
      collectGitHub.run({
        identity: {
          accountId: account.id,
          externalLogin: account.external_login,
          externalId: account.external_id
        },
        token: 'expired-primary-token',
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        date: '2026-05-07',
        fetch: mockGitHubFetchWithPrivatePrimaryAuthRejection()
      })
    ).rejects.toThrow(/private GitHub repository id:R_RESTRICTED_1 failed during enrichment/)

    expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
      expect.objectContaining({
        code: 'SHIPLOG-GITHUB-AUTH-001',
        severity: 'error',
        step: 'collect_activity',
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        recovered: false
      })
    ])
    expect(fs.readFileSync(diagnosticsPath, 'utf8')).not.toContain('restricted-org/secret')
  } finally {
    if (previousDiagnosticsPath === undefined) delete process.env.SHIPLOG_DIAGNOSTICS_PATH
    else process.env.SHIPLOG_DIAGNOSTICS_PATH = previousDiagnosticsPath
  }
})

test('run uses a same-day contribution window and half-open commit window', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: mockGitHubFetchWithWindowAssertions()
  })

  const summaries = await db.query<{ total_commit_contributions: number }>(
    'SELECT total_commit_contributions FROM daily_user_summary'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(summaries.rows[0]!.total_commit_contributions).toBe(3)
  expect(commits.rows[0]!.count).toBe(1)
})

test('run counts co-authored commits and stores a marker', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: mockGitHubFetchWithCoAuthoredCommit()
  })

  const commits = await db.query<{
    oid: string
    is_co_authored: boolean
    additions: number
    deletions: number
  }>('SELECT oid, is_co_authored, additions, deletions FROM commits ORDER BY oid')
  const activity = await db.query<{ commits: number; lines_added: number; lines_deleted: number }>(
    'SELECT commits, lines_added, lines_deleted FROM daily_repository_activity'
  )

  expect(commits.rows).toEqual([
    { oid: 'authored', is_co_authored: false, additions: 10, deletions: 2 },
    { oid: 'coauthored', is_co_authored: true, additions: 5, deletions: 1 }
  ])
  expect(activity.rows[0]!).toMatchObject({
    commits: 2,
    lines_added: 15,
    lines_deleted: 3
  })
})

test('run retries a commit page without statistics and stores nullable metrics', async () => {
  const logs: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const mock = mockGitHubFetchWithCommitStatisticsError()
  const args = {
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: mock.fetch
  }

  await collectGitHub.run(args)

  const commits = await db.query<{
    oid: string
    additions: number | null
    deletions: number | null
    changed_files: number | null
  }>('SELECT oid, additions, deletions, changed_files FROM commits')

  expect(mock.commitQueries).toEqual(['with-statistics', 'without-statistics'])
  expect(commits.rows).toEqual([
    {
      oid: 'large-merge',
      additions: null,
      deletions: null,
      changed_files: null
    }
  ])
  expect(logs.join('\n')).toContain('SHIPLOG-GITHUB-STATS-001')

  const repository = await db.query<{ id: number }>('SELECT id FROM repositories')
  await upserts.upsertCommit({
    account_id: account.id,
    repository_id: repository.rows[0]!.id,
    oid: 'large-merge',
    committed_on: '2026-05-07',
    committed_at: '2026-05-07T12:34:56Z',
    additions: 120,
    deletions: 45,
    changed_files: 18,
    message_headline: 'Large merge',
    source: 'live'
  })

  await collectGitHub.run(args)
  const preserved = await db.query<{
    additions: number | null
    deletions: number | null
    changed_files: number | null
  }>('SELECT additions, deletions, changed_files FROM commits')

  expect(preserved.rows).toEqual([{ additions: 120, deletions: 45, changed_files: 18 }])
})

test('run does not recover from mixed commit-stat and unrelated GraphQL errors', async () => {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const mock = mockGitHubFetchWithCommitStatisticsError({ mixed: true })

  await expect(
    collectGitHub.run({
      identity: {
        accountId: account.id,
        externalLogin: account.external_login,
        externalId: account.external_id
      },
      token: 'test-token',
      date: '2026-05-07',
      fetch: mock.fetch
    })
  ).rejects.toThrow(/something went wrong/i)

  expect(mock.commitQueries).toEqual(['with-statistics'])
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  expect(commits.rows[0]!.count).toBe(0)
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
    external_created_at: '2011-01-25T00:00:00Z',
    first_seen_on: '2026-05-07'
  })

  await collectGitHub.run({
    identity: {
      accountId: account.id,
      externalLogin: account.external_login,
      externalId: account.external_id
    },
    token: 'test-token',
    date: '2026-05-07',
    fetch: mockGitHubFetchWithUnavailableRepository()
  })

  const repositories = await db.query<{ count: number }>(
    'SELECT COUNT(*)::int AS count FROM repositories'
  )
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const summaries = await db.query<{ total_commit_contributions: number }>(
    'SELECT total_commit_contributions FROM daily_user_summary'
  )

  expect(repositories.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.count).toBe(0)
  expect(summaries.rows[0]!.total_commit_contributions).toBe(1)
  expect(logs.some((line) => line.includes('[public] octocat/deleted'))).toBe(true)
  expect(logs.some((line) => line.includes('is unavailable; skipping enrichment'))).toBe(true)
})

test('collectActiveRepositories deduplicates repositories across contribution groups', () => {
  const fixture = githubContributionsFixture()
  const repository = fixture.user.contributionsCollection.commitContributionsByRepository[0]!

  fixture.user.contributionsCollection.pullRequestContributionsByRepository.push(repository)
  fixture.user.contributionsCollection.issueContributionsByRepository.push(repository)

  const repositories = collectGitHub.collectActiveRepositories(fixture.user.contributionsCollection)

  expect(repositories).toHaveLength(1)
  expect(repositories[0]!.id).toBe('R_TEST_1')
})

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
      if (q.includes('created:')) {
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

      return jsonResponse({ total_count: 0, items: [] })
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

    if (parsed.pathname === '/search/issues' && q.includes('type:issue author:')) {
      if (q.includes('created:')) {
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

      return jsonResponse({ total_count: 0, items: [] })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithPaginatedDailyActivity(): {
  fetch: typeof fetch
  pullRequestPages: number[]
  reviewPages: number[]
} {
  const pullRequestPages: number[] = []
  const reviewPages: number[] = []

  return {
    pullRequestPages,
    reviewPages,
    fetch: (async (url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body)) as { query: string }

        if (body.query.includes('query Contributions')) {
          return jsonResponse({
            data: githubContributionsWithPullRequestActivity({
              pullRequests: 101,
              pullRequestReviews: 1
            })
          })
        }

        if (body.query.includes('query RepositoryCommits')) {
          return jsonResponse({
            data: {
              repository: {
                defaultBranchRef: {
                  target: {
                    history: {
                      totalCount: 0,
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: []
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
        if (!q.includes('created:')) return jsonResponse({ total_count: 0, items: [] })

        const page = Number(parsed.searchParams.get('page') ?? '1')
        pullRequestPages.push(page)
        return jsonResponse({
          total_count: 101,
          items: paginatedPullRequestItems(page)
        })
      }

      if (parsed.pathname === '/search/issues' && q.includes('reviewed-by:')) {
        return jsonResponse({
          total_count: 1,
          items: [pullRequestItem(42)]
        })
      }

      if (parsed.pathname === '/repos/octo-org/hello/pulls/42/reviews') {
        const page = Number(parsed.searchParams.get('page') ?? '1')
        reviewPages.push(page)
        return jsonResponse(paginatedReviewItems(page))
      }

      if (parsed.pathname === '/search/issues') {
        return jsonResponse({ total_count: 0, items: [] })
      }

      return new Response(`unexpected request: ${url}`, { status: 500 })
    }) as typeof fetch
  }
}

function mockGitHubFetchWithOrganizationToken(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization')

    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes('query Contributions')) {
        expect(authorization).toBe('Bearer default-token')
        return jsonResponse({ data: githubContributionsWithRepository(restrictedRepositoryNode()) })
      }

      if (body.query.includes('query RepositoryCommits')) {
        expect(authorization).toBe('Bearer org-token')
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
                        oid: 'org-commit-1',
                        committedDate: '2026-05-07T12:34:56Z',
                        additions: 8,
                        deletions: 2,
                        changedFiles: 1,
                        messageHeadline: 'Restricted org work',
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

    if (parsed.pathname === '/search/issues') {
      expect(authorization).toBe('Bearer org-token')
      return jsonResponse({ total_count: 0, items: [] })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithPrivatePrimaryAuthRejection(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.includes('query Contributions')) {
        return jsonResponse({ data: githubContributionsWithRepository(restrictedRepositoryNode()) })
      }
      return new Response('Bad credentials', { status: 401 })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithReadablePrivateRepositoryOutsideContributionGroups(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes('query Contributions')) {
        return jsonResponse({
          data: {
            user: {
              contributionsCollection: {
                totalCommitContributions: 0,
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
        return jsonResponse({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    totalCount: 0,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: []
                  }
                }
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
          node_id: 'R_PRIVATE_OUTSIDE_DAILY_1',
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
          description: 'readable private repository without daily activity',
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

function mockGitHubFetchWithWindowAssertions(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables: Record<string, unknown>
      }

      if (body.query.includes('query Contributions')) {
        expect(body.variables.from).toBe('2026-05-07T00:00:00Z')
        expect(body.variables.to).toBe('2026-05-07T23:59:59Z')
        return jsonResponse({ data: githubContributionsFixture() })
      }

      if (body.query.includes('query RepositoryCommits')) {
        expect(body.variables.since).toBe('2026-05-07T00:00:00Z')
        expect(body.variables.until).toBe('2026-05-08T00:00:00Z')
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
                        oid: 'window-commit-1',
                        committedDate: '2026-05-07T12:34:56Z',
                        additions: 10,
                        deletions: 2,
                        changedFiles: 3,
                        messageHeadline: 'Check windows',
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

    if (parsed.pathname === '/user/repos') {
      return jsonResponse([])
    }

    if (parsed.pathname === '/search/issues') {
      return jsonResponse({ total_count: 0, items: [] })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithCoAuthoredCommit(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as {
        query: string
        variables?: Record<string, unknown>
      }

      if (body.query.includes('query Contributions')) {
        return jsonResponse({ data: githubContributionsFixture() })
      }

      if (body.query.includes('query RepositoryCommits')) {
        expect(body.variables?.author).toBeUndefined()
        return jsonResponse({
          data: {
            repository: {
              defaultBranchRef: {
                target: {
                  history: {
                    totalCount: 3,
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        oid: 'authored',
                        committedDate: '2026-05-07T10:00:00Z',
                        additions: 10,
                        deletions: 2,
                        changedFiles: 1,
                        messageHeadline: 'Authored work',
                        author: githubCommitActor(),
                        authors: { nodes: [githubCommitActor()] }
                      },
                      {
                        oid: 'coauthored',
                        committedDate: '2026-05-07T11:00:00Z',
                        additions: 5,
                        deletions: 1,
                        changedFiles: 2,
                        messageHeadline: 'Co-authored work',
                        author: githubCommitActor({
                          id: 'U_TEAMMATE',
                          login: 'teammate',
                          name: 'Teammate'
                        }),
                        authors: {
                          nodes: [
                            githubCommitActor({
                              id: 'U_TEAMMATE',
                              login: 'teammate',
                              name: 'Teammate'
                            }),
                            githubCommitActor()
                          ]
                        }
                      },
                      {
                        oid: 'unrelated',
                        committedDate: '2026-05-07T12:00:00Z',
                        additions: 100,
                        deletions: 50,
                        changedFiles: 3,
                        messageHeadline: 'Someone else',
                        author: githubCommitActor({
                          id: 'U_SOMEONE_ELSE',
                          login: 'someone-else',
                          name: 'Someone Else'
                        }),
                        authors: {
                          nodes: [
                            githubCommitActor({
                              id: 'U_SOMEONE_ELSE',
                              login: 'someone-else',
                              name: 'Someone Else'
                            })
                          ]
                        }
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

    if (parsed.pathname === '/user/repos') {
      return jsonResponse([])
    }

    if (parsed.pathname === '/search/issues') {
      return jsonResponse({ total_count: 0, items: [] })
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function mockGitHubFetchWithUnavailableRepository(): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

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

function mockGitHubFetchWithCommitStatisticsError(options: { mixed?: boolean } = {}): {
  fetch: typeof fetch
  commitQueries: string[]
} {
  const commitQueries: string[] = []

  return {
    commitQueries,
    fetch: (async (url: string, init?: RequestInit) => {
      if (url === 'https://api.github.com/graphql') {
        const body = JSON.parse(String(init?.body)) as { query: string }

        if (body.query.includes('query Contributions')) {
          return jsonResponse({ data: githubContributionsFixture() })
        }

        if (body.query.includes('query RepositoryCommitsWithoutStatistics')) {
          commitQueries.push('without-statistics')
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
                          oid: 'large-merge',
                          committedDate: '2026-05-07T12:34:56Z',
                          messageHeadline: 'Large merge',
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

        if (body.query.includes('query RepositoryCommits(')) {
          commitQueries.push('with-statistics')
          return jsonResponse({
            data: { repository: null },
            errors: [
              { message: 'The additions count for this commit is unavailable.' },
              ...(options.mixed
                ? [{ message: 'Something went wrong while executing your query.' }]
                : [{ message: 'The deletions count for this commit is unavailable.' }])
            ]
          })
        }
      }

      const parsed = new URL(url)
      if (parsed.pathname === '/search/issues') {
        return jsonResponse({ total_count: 0, items: [] })
      }

      return new Response(`unexpected request: ${url}`, { status: 500 })
    }) as typeof fetch
  }
}

function githubCommitActor(
  overrides: {
    id?: string
    login?: string
    name?: string
    email?: string
  } = {}
): import('../../lib/providers/github/types.ts').GitHubCommitActor {
  const id = overrides.id ?? 'U_TEST_1'
  const login = overrides.login ?? 'octocat'
  const name = overrides.name ?? 'octocat'
  return {
    name,
    email: overrides.email ?? `${login}@example.com`,
    user: { id, login }
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

function paginatedPullRequestItems(
  page: number
): import('../../lib/providers/github/types.ts').GitHubSearchPullRequestItem[] {
  if (page === 1) {
    return Array.from({ length: 100 }, (_value, index) => pullRequestItem(index + 1))
  }
  if (page === 2) return [pullRequestItem(101)]
  return []
}

function pullRequestItem(
  number: number
): import('../../lib/providers/github/types.ts').GitHubSearchPullRequestItem {
  return {
    node_id: `PR_PAGE_${number}`,
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/octo-org/hello/pull/${number}`,
    state: 'closed',
    created_at: '2026-05-07T08:00:00Z',
    closed_at: '2026-05-07T10:00:00Z',
    pull_request: { merged_at: '2026-05-07T10:00:00Z' }
  }
}

function paginatedReviewItems(
  page: number
): import('../../lib/providers/github/types.ts').GitHubReviewItem[] {
  if (page === 1) {
    return Array.from({ length: 100 }, (_value, index) => reviewItem(index + 1))
  }
  if (page === 2) return [reviewItem(101)]
  return []
}

function reviewItem(
  number: number
): import('../../lib/providers/github/types.ts').GitHubReviewItem {
  return {
    node_id: `REVIEW_PAGE_${number}`,
    user: { login: 'octocat' },
    state: 'APPROVED',
    submitted_at: '2026-05-07T09:00:00Z'
  }
}

function githubContributionsWithPullRequestActivity({
  pullRequests = 0,
  pullRequestReviews = 0
}: {
  pullRequests?: number
  pullRequestReviews?: number
}): {
  user: {
    contributionsCollection: import('../../lib/providers/github/types.ts').GitHubContributionsCollection
  }
} {
  const repository =
    githubContributionsFixture().user.contributionsCollection.commitContributionsByRepository[0]!
      .repository

  return {
    user: {
      contributionsCollection: {
        totalCommitContributions: 0,
        totalIssueContributions: 0,
        totalPullRequestContributions: pullRequests,
        totalPullRequestReviewContributions: pullRequestReviews,
        restrictedContributionsCount: 0,
        commitContributionsByRepository: [],
        pullRequestContributionsByRepository:
          pullRequests > 0 ? [{ repository, contributions: { totalCount: pullRequests } }] : [],
        pullRequestReviewContributionsByRepository:
          pullRequestReviews > 0
            ? [{ repository, contributions: { totalCount: pullRequestReviews } }]
            : [],
        issueContributionsByRepository: []
      }
    }
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

function restrictedRepositoryNode(): import('../../lib/providers/github/types.ts').GitHubRepositoryNode {
  return {
    id: 'R_RESTRICTED_1',
    nameWithOwner: 'restricted-org/secret',
    owner: {
      __typename: 'Organization',
      id: 'O_RESTRICTED_1',
      login: 'restricted-org',
      avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4'
    },
    isPrivate: true,
    isFork: false,
    isArchived: false,
    primaryLanguage: { name: 'TypeScript' },
    stargazerCount: 0,
    forkCount: 0,
    createdAt: '2024-01-01T00:00:00Z',
    pushedAt: '2026-05-07T12:00:00Z',
    defaultBranchRef: { name: 'main' },
    url: 'https://github.com/restricted-org/secret',
    description: 'restricted test repository'
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
