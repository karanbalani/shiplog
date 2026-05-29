import * as logger from '../../logger.ts'
import type { RestClient } from './rest.ts'
import type { GitHubReviewItem, GitHubSearchPullRequestItem, GitHubSearchResult } from './types.ts'

const GITHUB_REST_PAGE_SIZE = 100
const GITHUB_SEARCH_RESULT_LIMIT = 1000
const DAY_MS = 24 * 60 * 60 * 1000

export interface GitHubSearchDateSplit {
  qualifier: string
  from: string
  to: string
}

export async function fetchSearchIssueItems(
  rest: RestClient,
  query: string,
  options: { dateSplit?: GitHubSearchDateSplit } = {}
): Promise<GitHubSearchPullRequestItem[]> {
  if (options.dateSplit) {
    const items = new Map<string, GitHubSearchPullRequestItem>()
    await fetchSearchIssueItemsForDateRange(rest, query, options.dateSplit, items)
    return [...items.values()]
  }

  return fetchSearchIssueItemsForQuery(rest, query, {
    warnOnLimit: (totalCount) => warnSearchLimitWithoutQuery({ totalCount })
  })
}

async function fetchSearchIssueItemsForDateRange(
  rest: RestClient,
  baseQuery: string,
  dateSplit: GitHubSearchDateSplit,
  items: Map<string, GitHubSearchPullRequestItem>
): Promise<void> {
  const from = parseDateOnly(dateSplit.from)
  const to = parseDateOnly(dateSplit.to)
  if (from.getTime() > to.getTime()) return

  const query = `${baseQuery} ${dateSplit.qualifier}:${formatDateOnly(from)}..${formatDateOnly(to)}`
  const firstPage = await fetchSearchIssuePage(rest, query, 1)

  if (firstPage.total_count > GITHUB_SEARCH_RESULT_LIMIT) {
    const split = splitDateRange(from, to)
    if (split) {
      await fetchSearchIssueItemsForDateRange(
        rest,
        baseQuery,
        { ...dateSplit, from: formatDateOnly(split.left.from), to: formatDateOnly(split.left.to) },
        items
      )
      await fetchSearchIssueItemsForDateRange(
        rest,
        baseQuery,
        {
          ...dateSplit,
          from: formatDateOnly(split.right.from),
          to: formatDateOnly(split.right.to)
        },
        items
      )
      return
    }
  }

  const pageItems = await fetchSearchIssueItemsForQuery(rest, query, {
    firstPage,
    warnOnLimit: (totalCount) =>
      warnSearchLimitWithoutQuery({
        totalCount,
        qualifier: dateSplit.qualifier,
        from: formatDateOnly(from),
        to: formatDateOnly(to)
      })
  })
  for (const item of pageItems) items.set(item.node_id, item)
}

async function fetchSearchIssueItemsForQuery(
  rest: RestClient,
  query: string,
  options: {
    firstPage?: GitHubSearchResult<GitHubSearchPullRequestItem>
    warnOnLimit: (totalCount: number) => void
  }
): Promise<GitHubSearchPullRequestItem[]> {
  const items: GitHubSearchPullRequestItem[] = []
  const firstPage = options.firstPage ?? (await fetchSearchIssuePage(rest, query, 1))
  items.push(...firstPage.items)
  if (firstPage.items.length < GITHUB_REST_PAGE_SIZE) return items

  if (items.length >= Math.min(firstPage.total_count, GITHUB_SEARCH_RESULT_LIMIT)) {
    if (firstPage.total_count > GITHUB_SEARCH_RESULT_LIMIT)
      options.warnOnLimit(firstPage.total_count)
    return items
  }

  for (let page = 2; ; page += 1) {
    const result = await fetchSearchIssuePage(rest, query, page)
    items.push(...result.items)

    if (result.items.length < GITHUB_REST_PAGE_SIZE) return items
    if (items.length >= Math.min(result.total_count, GITHUB_SEARCH_RESULT_LIMIT)) {
      if (result.total_count > GITHUB_SEARCH_RESULT_LIMIT) {
        options.warnOnLimit(result.total_count)
      }
      return items
    }
  }
}

async function fetchSearchIssuePage(
  rest: RestClient,
  query: string,
  page: number
): Promise<GitHubSearchResult<GitHubSearchPullRequestItem>> {
  return rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
    q: query,
    per_page: GITHUB_REST_PAGE_SIZE,
    page
  })
}

function warnSearchLimitWithoutQuery(
  context:
    | {
        totalCount: number
        qualifier?: string
        from?: string
        to?: string
      }
    | undefined
): void {
  const totalCount = context?.totalCount ?? GITHUB_SEARCH_RESULT_LIMIT + 1
  const range =
    context?.qualifier && context.from && context.to
      ? ` for ${context.qualifier}:${context.from}..${context.to}`
      : ''
  logger.warn(
    `[github] search returned ${totalCount} matches${range}; only the first ${GITHUB_SEARCH_RESULT_LIMIT} are available from GitHub Search`
  )
}

function splitDateRange(
  from: Date,
  to: Date
): { left: { from: Date; to: Date }; right: { from: Date; to: Date } } | null {
  const days = Math.floor((to.getTime() - from.getTime()) / DAY_MS)
  if (days <= 0) return null

  const mid = new Date(from.getTime() + Math.floor(days / 2) * DAY_MS)
  return {
    left: { from, to: mid },
    right: { from: new Date(mid.getTime() + DAY_MS), to }
  }
}

function parseDateOnly(value: string): Date {
  const dateOnly = value.slice(0, 10)
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateOnly)
  if (!match) throw new Error(`expected YYYY-MM-DD date, received "${value}"`)

  const [, year, month, day] = match
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export async function fetchPullRequestReviews(
  rest: RestClient,
  fullName: string,
  pullRequestNumber: number
): Promise<GitHubReviewItem[]> {
  const reviews: GitHubReviewItem[] = []

  for (let page = 1; ; page += 1) {
    const pageReviews = await rest<GitHubReviewItem[]>(
      `/repos/${fullName}/pulls/${pullRequestNumber}/reviews`,
      { per_page: GITHUB_REST_PAGE_SIZE, page }
    )
    reviews.push(...pageReviews)

    if (pageReviews.length < GITHUB_REST_PAGE_SIZE) return reviews
  }
}
