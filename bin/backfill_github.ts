import * as db from '../lib/db.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import * as queries from '../lib/providers/github/queries.ts'
import {
  GITHUB_SEARCH_REQUEST_INTERVAL_MS,
  restClient,
  type RestClient
} from '../lib/providers/github/rest.ts'
import * as translate from '../lib/providers/github/translate.ts'
import type {
  GitHubCommitHistory,
  GitHubContributionsCollection,
  GitHubRepositoryNode,
  GitHubReviewItem,
  GitHubSearchPullRequestItem,
  GitHubSearchResult,
  GitHubUserCore
} from '../lib/providers/github/types.ts'
import type { BackfillArgs, VendorIdentity } from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export async function run(args: BackfillArgs): Promise<void> {
  const { identity, token, fetch } = args
  if (!identity) throw new Error('backfill_github: missing identity')
  if (!token) throw new Error('backfill_github: missing token')

  const startedAt = Date.now()
  const graphQL = graphQLClient({ token, fetch })
  const rest = restClient({ token, fetch })
  const user = await fetchGitHubUser(graphQL, identity.externalLogin)
  const years = dates.yearRange(
    new Date(user.createdAt).getUTCFullYear(),
    new Date().getUTCFullYear()
  )
  const observedOn = dates.yesterdayUTC()
  const repositoriesByExternalId = new Map<string, GitHubRepositoryNode>()

  logger.info(
    `[backfill] github/${identity.externalLogin}: discovering ${years.length} years of activity (${years[0]}-${years.at(-1)})`
  )

  for (const [index, year] of years.entries()) {
    const { from, to } = dates.yearWindow(year)
    logger.info(
      `[backfill] github/${identity.externalLogin}: discovery ${index + 1}/${years.length} (${year})`
    )
    const collection = await fetchContributionsCollection(graphQL, identity.externalLogin, from, to)

    collectActiveRepositories(collection, repositoriesByExternalId)
    await upserts.upsertDailyUserSummary({
      account_id: identity.accountId,
      activity_on: `${year}-01-01`,
      total_commit_contributions: collection.totalCommitContributions,
      total_pull_request_contributions: collection.totalPullRequestContributions,
      total_pull_request_review_contributions: collection.totalPullRequestReviewContributions,
      total_issue_contributions: collection.totalIssueContributions,
      restricted_contributions_count: collection.restrictedContributionsCount,
      source: 'self_backfill'
    })
  }

  const repositoryCount = repositoriesByExternalId.size
  logger.info(
    `[backfill] github/${identity.externalLogin}: discovered ${repositoryCount} repositories; estimated minimum GitHub Search pacing ${formatDuration(
      estimatedSearchPacingMs(repositoryCount)
    )}`
  )

  const repositoriesStartedAt = Date.now()
  let completedRepositories = 0

  for (const repositoryNode of repositoriesByExternalId.values()) {
    const organizationId = await upsertOrganizationFromRepositoryOwner(repositoryNode, observedOn)
    const repositoryInput = translate.repositoryFromGraphQLNode(
      repositoryNode,
      observedOn,
      organizationId
    )
    const repository = await upserts.upsertRepository(repositoryInput)
    const fullName = requiredString(repositoryInput.full_name, 'repository full name')
    const name = requiredString(repositoryInput.name, 'repository name')

    logger.info(
      `[backfill] github/${identity.externalLogin}: repository ${completedRepositories + 1}/${repositoryCount} ${fullName}`
    )

    for (const year of years) {
      const { from, to } = dates.yearWindow(year)
      await ingestCommits(
        graphQL,
        repository.id,
        repositoryInput.owner_login,
        name,
        identity,
        from,
        to
      )
    }

    await ingestPullRequests(rest, repository.id, fullName, identity)
    await ingestIssues(rest, repository.id, fullName, identity)
    await ingestPullRequestReviews(rest, repository.id, fullName, identity)
    await upsertRepositoryLanguageSnapshot(
      graphQL,
      repository.id,
      repositoryInput.owner_login,
      name,
      observedOn
    )

    completedRepositories += 1
    logger.info(
      `[backfill] github/${identity.externalLogin}: repository ${completedRepositories}/${repositoryCount} complete (${progressPercent(
        completedRepositories,
        repositoryCount
      )}%, elapsed ${formatDuration(Date.now() - repositoriesStartedAt)}, eta ${formatDuration(
        estimatedRemainingMs(repositoriesStartedAt, completedRepositories, repositoryCount)
      )})`
    )
  }

  logger.info(`[backfill] github/${identity.externalLogin}: rolling up activity dates`)
  await rollupDistinctActivityDates(identity.accountId)
  logger.info(
    `[backfill] github/${identity.externalLogin}: complete in ${formatDuration(Date.now() - startedAt)}`
  )
}

async function upsertOrganizationFromRepositoryOwner(
  repositoryNode: GitHubRepositoryNode,
  observedOn: string
): Promise<number | null> {
  const organizationInput = translate.organizationFromRepositoryOwner(
    repositoryNode.owner,
    observedOn
  )
  if (!organizationInput) return null

  const organization = await upserts.upsertOrganization(organizationInput)
  return organization.id
}

async function fetchGitHubUser(graphQL: GraphQLClient, login: string): Promise<GitHubUserCore> {
  const data = await graphQL<{ user: GitHubUserCore | null }>(queries.VIEWER_AND_USER, { login })
  if (!data.user) throw new Error(`backfill_github: GitHub user not found: ${login}`)
  return data.user
}

async function fetchContributionsCollection(
  graphQL: GraphQLClient,
  login: string,
  from: string,
  to: string
): Promise<GitHubContributionsCollection> {
  const data = await graphQL<{
    user: { contributionsCollection: GitHubContributionsCollection } | null
  }>(queries.CONTRIBUTIONS_COLLECTION, {
    login,
    from,
    to
  })
  if (!data.user) throw new Error(`backfill_github: GitHub user not found: ${login}`)
  return data.user.contributionsCollection
}

function collectActiveRepositories(
  collection: GitHubContributionsCollection,
  repositoriesByExternalId: Map<string, GitHubRepositoryNode>
): void {
  for (const group of [
    collection.commitContributionsByRepository,
    collection.pullRequestContributionsByRepository,
    collection.pullRequestReviewContributionsByRepository,
    collection.issueContributionsByRepository
  ]) {
    for (const contribution of group) {
      repositoriesByExternalId.set(contribution.repository.id, contribution.repository)
    }
  }
}

async function ingestCommits(
  graphQL: GraphQLClient,
  repositoryId: number,
  owner: string,
  name: string,
  identity: VendorIdentity,
  since: string,
  until: string
): Promise<void> {
  let cursor: string | null = null

  for (;;) {
    const data: RepositoryCommitsResponse = await graphQL<RepositoryCommitsResponse>(
      queries.REPOSITORY_COMMITS_IN_WINDOW,
      {
        owner,
        name,
        author: identity.externalId,
        since,
        until,
        cursor
      }
    )

    const history: GitHubCommitHistory | undefined =
      data.repository?.defaultBranchRef?.target?.history
    if (!history) return

    for (const node of history.nodes) {
      await upserts.upsertCommit(
        translate.commitFromGraphQLNode(node, identity.accountId, repositoryId, 'self_backfill')
      )
    }

    if (!history.pageInfo.hasNextPage) return
    cursor = history.pageInfo.endCursor
  }
}

interface RepositoryCommitsResponse {
  repository: {
    defaultBranchRef: {
      target: { history: GitHubCommitHistory } | null
    } | null
  } | null
}

async function ingestPullRequests(
  rest: RestClient,
  repositoryId: number,
  fullName: string,
  identity: VendorIdentity
): Promise<void> {
  const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
    q: `repo:${fullName} type:pr author:${identity.externalLogin}`,
    per_page: 100
  })

  for (const item of result.items) {
    const mergedAt = item.pull_request?.merged_at ?? null
    await upserts.upsertPullRequest({
      account_id: identity.accountId,
      external_id: item.node_id,
      repository_id: repositoryId,
      number: item.number,
      title: item.title,
      web_url: item.html_url,
      state: item.state === 'closed' ? (mergedAt ? 'MERGED' : 'CLOSED') : 'OPEN',
      external_created_at: item.created_at,
      external_merged_at: mergedAt,
      external_closed_at: item.closed_at,
      additions: null,
      deletions: null,
      changed_files: null,
      commits_count: null,
      source: 'self_backfill'
    })
  }
}

async function ingestIssues(
  rest: RestClient,
  repositoryId: number,
  fullName: string,
  identity: VendorIdentity
): Promise<void> {
  const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
    q: `repo:${fullName} type:issue author:${identity.externalLogin}`,
    per_page: 100
  })

  for (const item of result.items) {
    await upserts.upsertIssue({
      account_id: identity.accountId,
      external_id: item.node_id,
      repository_id: repositoryId,
      number: item.number,
      title: item.title,
      web_url: item.html_url,
      state: item.state === 'closed' ? 'CLOSED' : 'OPEN',
      external_created_at: item.created_at,
      external_closed_at: item.closed_at,
      source: 'self_backfill'
    })
  }
}

async function ingestPullRequestReviews(
  rest: RestClient,
  repositoryId: number,
  fullName: string,
  identity: VendorIdentity
): Promise<void> {
  const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
    q: `repo:${fullName} type:pr reviewed-by:${identity.externalLogin}`,
    per_page: 100
  })

  for (const pullRequest of result.items) {
    const reviews = await rest<GitHubReviewItem[]>(
      `/repos/${fullName}/pulls/${pullRequest.number}/reviews`,
      { per_page: 100 }
    )

    for (const review of reviews) {
      if (review.user?.login !== identity.externalLogin) continue
      if (!review.submitted_at) continue

      await upserts.upsertPullRequestReview({
        account_id: identity.accountId,
        external_id: review.node_id,
        pull_request_id: null,
        repository_id: repositoryId,
        state: review.state,
        submitted_at: review.submitted_at,
        submitted_on: review.submitted_at.slice(0, 10),
        source: 'self_backfill'
      })
    }
  }
}

async function upsertRepositoryLanguageSnapshot(
  graphQL: GraphQLClient,
  repositoryId: number,
  owner: string,
  name: string,
  capturedOn: string
): Promise<void> {
  const data = await graphQL<RepositoryLanguagesResponse>(queries.REPOSITORY_LANGUAGES, {
    owner,
    name
  })
  if (!data.repository) return

  await upserts.upsertRepositorySnapshot({
    repository_id: repositoryId,
    captured_on: capturedOn,
    star_count: data.repository.stargazerCount,
    fork_count: data.repository.forkCount,
    is_archived: data.repository.isArchived,
    visibility: data.repository.isPrivate ? 'private' : 'public'
  })

  for (const language of translate.languagesFromGraphQLEdges(data.repository.languages.edges)) {
    await upserts.upsertRepositoryLanguage({
      repository_id: repositoryId,
      captured_on: capturedOn,
      language: language.language,
      bytes: language.bytes,
      percentage: language.percentage
    })
  }
}

interface RepositoryLanguagesResponse {
  repository: {
    stargazerCount: number
    forkCount: number
    isArchived: boolean
    isPrivate: boolean
    languages: {
      edges: Array<{ size: number; node: { name: string } }>
    }
  } | null
}

async function rollupDistinctActivityDates(accountId: number): Promise<void> {
  const result = await db.query<{ activity_on: Date | string }>(
    `SELECT DISTINCT activity_on
     FROM (
       SELECT committed_on AS activity_on FROM commits WHERE account_id = $1
       UNION
       SELECT external_created_at::date AS activity_on FROM pull_requests WHERE account_id = $1
       UNION
       SELECT external_merged_at::date AS activity_on FROM pull_requests WHERE account_id = $1 AND external_merged_at IS NOT NULL
       UNION
       SELECT external_closed_at::date AS activity_on FROM pull_requests WHERE account_id = $1 AND external_closed_at IS NOT NULL
       UNION
       SELECT submitted_on AS activity_on FROM pull_request_reviews WHERE account_id = $1
       UNION
       SELECT external_created_at::date AS activity_on FROM issues WHERE account_id = $1
       UNION
       SELECT external_closed_at::date AS activity_on FROM issues WHERE account_id = $1 AND external_closed_at IS NOT NULL
     ) dates
     WHERE activity_on IS NOT NULL`,
    [accountId]
  )

  for (const row of result.rows) {
    await upserts.rollupDailyRepositoryActivity(
      accountId,
      dateOnly(row.activity_on),
      'self_backfill'
    )
  }
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}

export function estimatedSearchPacingMs(repositoryCount: number): number {
  const searchCallsPerRepository = 3
  const searchCalls = repositoryCount * searchCallsPerRepository
  if (searchCalls <= 1) return 0
  return (searchCalls - 1) * GITHUB_SEARCH_REQUEST_INTERVAL_MS
}

export function estimatedRemainingMs(
  startedAt: number,
  completed: number,
  total: number,
  now = Date.now()
): number {
  if (completed <= 0 || total <= 0 || completed >= total) return 0
  const elapsed = Math.max(0, now - startedAt)
  const averageMs = elapsed / completed
  return Math.max(0, Math.round(averageMs * (total - completed)))
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function progressPercent(completed: number, total: number): number {
  if (total <= 0) return 100
  return Math.min(100, Math.round((completed / total) * 100))
}

function requiredString(value: string | null, label: string): string {
  if (!value) throw new Error(`backfill_github: missing ${label}`)
  return value
}
