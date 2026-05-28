import type { RestClient } from './rest.ts'
import type { GitHubReviewItem, GitHubSearchPullRequestItem, GitHubSearchResult } from './types.ts'

const GITHUB_REST_PAGE_SIZE = 100
const GITHUB_SEARCH_RESULT_LIMIT = 1000

export async function fetchSearchIssueItems(
  rest: RestClient,
  query: string
): Promise<GitHubSearchPullRequestItem[]> {
  const items: GitHubSearchPullRequestItem[] = []

  for (let page = 1; ; page += 1) {
    const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
      q: query,
      per_page: GITHUB_REST_PAGE_SIZE,
      page
    })
    items.push(...result.items)

    if (result.items.length < GITHUB_REST_PAGE_SIZE) return items
    if (items.length >= Math.min(result.total_count, GITHUB_SEARCH_RESULT_LIMIT)) return items
  }
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
