import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as collectGitHub from '../../bin/collect_github.ts'
import * as db from '../../lib/db.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
})

afterEach(async () => {
  await db.close()
})

test('run collects GitHub activity into generic schema tables', async () => {
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
