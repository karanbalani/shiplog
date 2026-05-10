import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import * as queries from '../lib/providers/github/queries.ts'
import { restClient, type RestClient } from '../lib/providers/github/rest.ts'
import * as translate from '../lib/providers/github/translate.ts'
import type {
  GitHubCommitHistory,
  GitHubContributionsCollection,
  GitHubRepositoryNode,
  GitHubReviewItem,
  GitHubSearchPullRequestItem,
  GitHubSearchResult
} from '../lib/providers/github/types.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'
import type { CollectArgs, VendorIdentity } from '../lib/types/index.ts'

export async function run(args: CollectArgs): Promise<void> {
  const { identity, token, date, fetch } = args
  if (!identity) throw new Error('collect_github: missing identity')
  if (!token) throw new Error('collect_github: missing token')
  if (!date) throw new Error('collect_github: missing date')

  const graphQL = graphQLClient({ token, fetch })
  const rest = restClient({ token, fetch })
  const { from, to } = dates.dayWindow(date)

  const data = await graphQL<{
    user: { contributionsCollection: GitHubContributionsCollection } | null
  }>(queries.CONTRIBUTIONS_COLLECTION, {
    login: identity.externalLogin,
    from,
    to
  })
  if (!data.user) {
    throw new Error(`collect_github: GitHub user not found: ${identity.externalLogin}`)
  }

  const collection = data.user.contributionsCollection
  const activeRepositories = collectActiveRepositories(collection)

  for (const repositoryNode of activeRepositories) {
    const repositoryInput = translate.repositoryFromGraphQLNode(repositoryNode, date)
    const repository = await upserts.upsertRepository(repositoryInput)
    const fullName = requiredString(repositoryInput.full_name, 'repository full name')
    const name = requiredString(repositoryInput.name, 'repository name')

    await upsertRepositorySnapshot(repository.id, repositoryNode, date)
    await ingestCommits(
      graphQL,
      repository.id,
      repositoryInput.owner_login,
      name,
      identity,
      from,
      to
    )
    await ingestPullRequests(rest, repository.id, fullName, identity, date)
    await ingestPullRequestReviews(rest, repository.id, fullName, identity, date)
    await ingestIssues(rest, repository.id, fullName, identity, date)
  }

  await upserts.upsertDailyUserSummary({
    account_id: identity.accountId,
    activity_on: date,
    total_commit_contributions: collection.totalCommitContributions,
    total_pull_request_contributions: collection.totalPullRequestContributions,
    total_pull_request_review_contributions: collection.totalPullRequestReviewContributions,
    total_issue_contributions: collection.totalIssueContributions,
    restricted_contributions_count: collection.restrictedContributionsCount,
    source: 'live'
  })

  await upserts.rollupDailyRepositoryActivity(identity.accountId, date)
}

export function collectActiveRepositories(
  collection: GitHubContributionsCollection
): GitHubRepositoryNode[] {
  const repositories = new Map<string, GitHubRepositoryNode>()

  for (const group of [
    collection.commitContributionsByRepository,
    collection.pullRequestContributionsByRepository,
    collection.pullRequestReviewContributionsByRepository,
    collection.issueContributionsByRepository
  ]) {
    for (const contribution of group) {
      repositories.set(contribution.repository.id, contribution.repository)
    }
  }

  return [...repositories.values()]
}

async function upsertRepositorySnapshot(
  repositoryId: number,
  repositoryNode: GitHubRepositoryNode,
  capturedOn: string
): Promise<void> {
  if (repositoryNode.stargazerCount === undefined && repositoryNode.forkCount === undefined) {
    return
  }

  await upserts.upsertRepositorySnapshot({
    repository_id: repositoryId,
    captured_on: capturedOn,
    star_count: repositoryNode.stargazerCount ?? null,
    fork_count: repositoryNode.forkCount ?? null,
    is_archived: repositoryNode.isArchived,
    visibility: repositoryNode.isPrivate ? 'private' : 'public'
  })
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
        translate.commitFromGraphQLNode(node, identity.accountId, repositoryId, 'live')
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
  identity: VendorIdentity,
  date: string
): Promise<void> {
  const items = new Map<string, GitHubSearchPullRequestItem>()

  for (const query of [
    `repo:${fullName} type:pr author:${identity.externalLogin} created:${date}..${date}`,
    `repo:${fullName} type:pr author:${identity.externalLogin} merged:${date}..${date}`,
    `repo:${fullName} type:pr author:${identity.externalLogin} closed:${date}..${date}`
  ]) {
    const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
      q: query,
      per_page: 100
    })

    for (const item of result.items) {
      items.set(item.node_id, item)
    }
  }

  for (const item of items.values()) {
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
      source: 'live'
    })
  }
}

async function ingestPullRequestReviews(
  rest: RestClient,
  repositoryId: number,
  fullName: string,
  identity: VendorIdentity,
  date: string
): Promise<void> {
  const reviewedPullRequests = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>(
    '/search/issues',
    {
      q: `repo:${fullName} type:pr reviewed-by:${identity.externalLogin}`,
      per_page: 100
    }
  )

  for (const pullRequest of reviewedPullRequests.items) {
    const reviews = await rest<GitHubReviewItem[]>(
      `/repos/${fullName}/pulls/${pullRequest.number}/reviews`,
      { per_page: 100 }
    )

    for (const review of reviews) {
      if (review.user?.login !== identity.externalLogin) continue
      if (!review.submitted_at || review.submitted_at.slice(0, 10) !== date) continue

      await upserts.upsertPullRequestReview({
        account_id: identity.accountId,
        external_id: review.node_id,
        pull_request_id: null,
        repository_id: repositoryId,
        state: review.state,
        submitted_at: review.submitted_at,
        submitted_on: review.submitted_at.slice(0, 10),
        source: 'live'
      })
    }
  }
}

async function ingestIssues(
  rest: RestClient,
  repositoryId: number,
  fullName: string,
  identity: VendorIdentity,
  date: string
): Promise<void> {
  const items = new Map<string, GitHubSearchPullRequestItem>()

  for (const query of [
    `repo:${fullName} type:issue author:${identity.externalLogin} created:${date}..${date}`,
    `repo:${fullName} type:issue author:${identity.externalLogin} closed:${date}..${date}`
  ]) {
    const result = await rest<GitHubSearchResult<GitHubSearchPullRequestItem>>('/search/issues', {
      q: query,
      per_page: 100
    })

    for (const item of result.items) {
      items.set(item.node_id, item)
    }
  }

  for (const item of items.values()) {
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
      source: 'live'
    })
  }
}

function requiredString(value: string | null, label: string): string {
  if (!value) throw new Error(`collect_github: missing ${label}`)
  return value
}
