import { afterEach, expect, test } from 'bun:test'
import * as logger from '../../lib/logger.ts'
import { fetchSearchIssueItems } from '../../lib/providers/github/pagination.ts'
import type { RestClient } from '../../lib/providers/github/rest.ts'
import type { GitHubSearchPullRequestItem } from '../../lib/providers/github/types.ts'

afterEach(() => {
  logger.resetLogger()
})

test('fetchSearchIssueItems warns when GitHub search result limit is reached', async () => {
  const logs: string[] = []
  const pages: number[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const rest: RestClient = async <T = unknown>(
    _path: string,
    params: Record<string, string | number | undefined> = {}
  ) => {
    pages.push(Number(params.page))
    return {
      total_count: 1001,
      items: Array.from({ length: 100 }, (_value, index) =>
        searchItem((Number(params.page) - 1) * 100 + index + 1)
      )
    } as T
  }

  const items = await fetchSearchIssueItems(
    rest,
    'repo:private-org/private-repo type:pr author:octocat'
  )

  expect(items).toHaveLength(1000)
  expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  expect(logs.some((line) => line.includes('1001') && line.includes('1000'))).toBe(true)
  expect(logs.join('\n')).not.toContain('private-org/private-repo')
})

test('fetchSearchIssueItems splits capped search result windows', async () => {
  const logs: string[] = []
  const queries: string[] = []
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })
  const rest: RestClient = async <T = unknown>(
    _path: string,
    params: Record<string, string | number | undefined> = {}
  ) => {
    const query = String(params.q)
    queries.push(query)

    if (query.includes('created:2026-01-01..2026-01-04')) {
      return { total_count: 1001, items: [searchItem(999)] } as T
    }
    if (query.includes('created:2026-01-01..2026-01-02')) {
      return { total_count: 2, items: [searchItem(1), searchItem(2)] } as T
    }
    if (query.includes('created:2026-01-03..2026-01-04')) {
      return { total_count: 2, items: [searchItem(3), searchItem(4)] } as T
    }

    throw new Error(`unexpected query: ${query}`)
  }

  const items = await fetchSearchIssueItems(
    rest,
    'repo:private-org/private-repo type:pr author:octocat',
    { dateSplit: { qualifier: 'created', from: '2026-01-01', to: '2026-01-04' } }
  )

  expect(items.map((item) => item.number)).toEqual([1, 2, 3, 4])
  expect(queries).toEqual([
    'repo:private-org/private-repo type:pr author:octocat created:2026-01-01..2026-01-04',
    'repo:private-org/private-repo type:pr author:octocat created:2026-01-01..2026-01-02',
    'repo:private-org/private-repo type:pr author:octocat created:2026-01-03..2026-01-04'
  ])
  expect(logs).toEqual([])
})

function searchItem(number: number): GitHubSearchPullRequestItem {
  return {
    node_id: `PR_${number}`,
    number,
    title: `Pull request ${number}`,
    html_url: `https://github.com/example/repo/pull/${number}`,
    state: 'closed',
    created_at: '2026-05-07T08:00:00Z',
    closed_at: '2026-05-07T10:00:00Z',
    pull_request: { merged_at: '2026-05-07T10:00:00Z' }
  }
}
