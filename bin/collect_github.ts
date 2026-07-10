import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import {
  isGitHubCommitStatisticsUnavailableError,
  isGitHubCredentialRejectedError,
  isGitHubRateLimitError,
  isGitHubRepositoryUnavailableError
} from '../lib/providers/github/errors.ts'
import {
  privateRepositoryFailure,
  repositoryErrorSummary,
  repositoryLogLabel
} from '../lib/providers/github/logging.ts'
import {
  fetchPullRequestReviews,
  fetchSearchIssueItems
} from '../lib/providers/github/pagination.ts'
import * as logger from '../lib/logger.ts'
import * as queries from '../lib/providers/github/queries.ts'
import { restClient, type RestClient } from '../lib/providers/github/rest.ts'
import * as translate from '../lib/providers/github/translate.ts'
import type {
  GitHubCommitHistory,
  GitHubCommitNode,
  GitHubContributionsCollection,
  GitHubRepositoryNode,
  GitHubSearchPullRequestItem
} from '../lib/providers/github/types.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'
import type { CollectArgs, VendorIdentity, VendorOrganizationToken } from '../lib/types/index.ts'
import { recordWorkflowDiagnostic } from '../lib/workflow_summary.ts'

export async function run(args: CollectArgs): Promise<void> {
  const {
    identity,
    token,
    organizationTokens = [],
    ignoreOrganizationIds = [],
    ignoreRepositoryIds = [],
    date,
    fetch
  } = args
  if (!identity) throw new Error('collect_github: missing identity')
  if (!token) throw new Error('collect_github: missing token')
  if (!date) throw new Error('collect_github: missing date')

  const graphQL = graphQLClient({ token, fetch })
  const rest = restClient({ token, fetch })
  const defaultClients: GitHubClients = { graphQL, rest }
  const organizationClients = organizationClientMap(organizationTokens, fetch)
  const ignoredRepositories = ignoreSet(ignoreRepositoryIds)
  const ignoredOrganizations = ignoreSet(ignoreOrganizationIds)
  const commitWindow = dates.dayWindow(date)
  const contributionWindow = dates.contributionDayWindow(date)

  const data = await graphQL<{
    user: { contributionsCollection: GitHubContributionsCollection } | null
  }>(queries.CONTRIBUTIONS_COLLECTION, {
    login: identity.externalLogin,
    from: contributionWindow.from,
    to: contributionWindow.to
  })
  if (!data.user) {
    throw new Error(`collect_github: GitHub user not found: ${identity.externalLogin}`)
  }

  const collection = data.user.contributionsCollection
  const activeRepositories = collectActiveRepositories(
    collection,
    ignoredRepositories,
    ignoredOrganizations
  )

  const repositoryCount = activeRepositories.length
  let completedRepositories = 0

  for (const repositoryNode of activeRepositories) {
    const clients = clientsForRepository(repositoryNode, defaultClients, organizationClients)
    const organizationId = await upsertOrganizationFromRepositoryOwner(repositoryNode, date)
    const repositoryInput = translate.repositoryFromGraphQLNode(
      repositoryNode,
      date,
      organizationId
    )
    const repository = await upserts.upsertRepository(repositoryInput)
    const fullName = requiredString(repositoryInput.full_name, 'repository full name')
    const name = requiredString(repositoryInput.name, 'repository name')
    const visibility = repositoryNode.isPrivate ? 'private' : 'public'
    const logLabel = repositoryLogLabel(repositoryNode, fullName)
    const repositoryPosition = `${completedRepositories + 1}/${repositoryCount}`
    const repositoryStartMessage = `[collect] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel}`
    logger.info(repositoryStartMessage)

    let repositoryStatus = 'complete'
    logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'repository snapshot')
    await upsertRepositorySnapshot(repository.id, repositoryNode, date)
    try {
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'commits')
      await ingestCommits(
        clients.graphQL,
        repository.id,
        repositoryInput.owner_login,
        name,
        identity,
        commitWindow.from,
        commitWindow.to
      )
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'pull requests')
      await ingestPullRequests(clients.rest, repository.id, fullName, identity, date)
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'pull request reviews')
      await ingestPullRequestReviews(clients.rest, repository.id, fullName, identity, date)
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'issues')
      await ingestIssues(clients.rest, repository.id, fullName, identity, date)
    } catch (error) {
      if (clients.organizationTokenEnv && isGitHubCredentialRejectedError(error)) {
        repositoryStatus = 'skipped'
        logger.warn(
          `[collect] github/${identity.externalLogin}: [SHIPLOG-GITHUB-AUTH-001] GitHub rejected optional organization token ${clients.organizationTokenEnv}; repository [${visibility}] ${logLabel} was skipped for this run; rotate or re-authorize the token and rerun`
        )
        recordWorkflowDiagnostic({
          code: 'SHIPLOG-GITHUB-AUTH-001',
          step: 'collect_activity',
          recovered: true
        })
      } else if (repositoryNode.isPrivate && isGitHubRateLimitError(error)) {
        recordWorkflowDiagnostic({
          code: 'SHIPLOG-GITHUB-RATE-001',
          step: 'collect_activity'
        })
        throw privateRepositoryFailure(repositoryNode)
      } else if (repositoryNode.isPrivate && isGitHubCredentialRejectedError(error)) {
        recordWorkflowDiagnostic({
          code: 'SHIPLOG-GITHUB-AUTH-001',
          step: 'collect_activity'
        })
        throw privateRepositoryFailure(repositoryNode)
      } else if (!isGitHubRepositoryUnavailableError(error)) {
        if (repositoryNode.isPrivate) throw privateRepositoryFailure(repositoryNode)
        throw error
      } else {
        repositoryStatus = 'skipped'
        logger.warn(
          `[collect] github/${identity.externalLogin}: repository [${visibility}] ${logLabel} is unavailable; skipping enrichment (${repositoryErrorSummary(
            repositoryNode,
            error
          )})`
        )
      }
    }

    completedRepositories += 1
    const repositoryCompleteMessage = `[collect] github/${identity.externalLogin}: repository ${completedRepositories}/${repositoryCount} [${visibility}] ${logLabel} ${repositoryStatus}`
    logger.info(repositoryCompleteMessage)
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

function logRepositoryStep(
  identity: VendorIdentity,
  repositoryPosition: string,
  visibility: string,
  logLabel: string,
  step: string
): void {
  const message = `[collect] github/${identity.externalLogin}:   - repository ${repositoryPosition} [${visibility}] ${logLabel}: ${step}`
  logger.info(message)
}

interface GitHubClients {
  graphQL: GraphQLClient
  rest: RestClient
  organizationTokenEnv?: string
}

function organizationClientMap(
  organizationTokens: VendorOrganizationToken[],
  fetch: CollectArgs['fetch']
): Map<string, GitHubClients> {
  return new Map(
    organizationTokens.map((orgToken) => [
      orgToken.externalId,
      {
        graphQL: graphQLClient({ token: orgToken.token, fetch }),
        rest: restClient({ token: orgToken.token, fetch }),
        organizationTokenEnv: orgToken.tokenEnv
      }
    ])
  )
}

function clientsForRepository(
  repositoryNode: GitHubRepositoryNode,
  defaultClients: GitHubClients,
  organizationClients: Map<string, GitHubClients>
): GitHubClients {
  return (
    (repositoryNode.owner.id ? organizationClients.get(repositoryNode.owner.id) : undefined) ??
    defaultClients
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

export function collectActiveRepositories(
  collection: GitHubContributionsCollection,
  ignoredRepositories: Set<string> = new Set(),
  ignoredOrganizations: Set<string> = new Set()
): GitHubRepositoryNode[] {
  const repositories = new Map<string, GitHubRepositoryNode>()

  for (const group of [
    collection.commitContributionsByRepository,
    collection.pullRequestContributionsByRepository,
    collection.pullRequestReviewContributionsByRepository,
    collection.issueContributionsByRepository
  ]) {
    for (const contribution of group) {
      if (
        shouldIgnoreRepository(contribution.repository, ignoredRepositories, ignoredOrganizations)
      ) {
        continue
      }
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
    const history = await fetchCommitHistory(graphQL, owner, name, identity, since, until, cursor)
    if (!history) return

    for (const node of history.nodes) {
      if (!translate.commitIncludesIdentity(node, identity)) continue
      await upserts.upsertCommit(
        translate.commitFromGraphQLNode(node, identity, repositoryId, 'live')
      )
    }

    if (!history.pageInfo.hasNextPage) return
    cursor = history.pageInfo.endCursor
  }
}

async function fetchCommitHistory(
  graphQL: GraphQLClient,
  owner: string,
  name: string,
  identity: VendorIdentity,
  since: string,
  until: string,
  cursor: string | null
): Promise<GitHubCommitHistory | undefined> {
  const variables = { owner, name, since, until, cursor }

  try {
    const data = await graphQL<RepositoryCommitsResponse>(
      queries.REPOSITORY_COMMITS_IN_WINDOW,
      variables
    )
    const history = data.repository?.defaultBranchRef?.target?.history
    if (history && hasUnavailableCommitStatistics(history)) {
      logger.warn(
        `[collect] github/${identity.externalLogin}: [SHIPLOG-GITHUB-STATS-001] GitHub returned unavailable optional commit statistics; preserving the commits with null metrics`
      )
      recordWorkflowDiagnostic({
        code: 'SHIPLOG-GITHUB-STATS-001',
        step: 'collect_activity',
        recovered: true
      })
    }
    return history
  } catch (error) {
    if (!isGitHubCommitStatisticsUnavailableError(error)) throw error

    logger.warn(
      `[collect] github/${identity.externalLogin}: [SHIPLOG-GITHUB-STATS-001] GitHub could not calculate optional commit statistics; retrying the same page without statistics`
    )
    recordWorkflowDiagnostic({
      code: 'SHIPLOG-GITHUB-STATS-001',
      step: 'collect_activity',
      recovered: true
    })
    const data = await graphQL<RepositoryCommitsWithoutStatisticsResponse>(
      queries.REPOSITORY_COMMITS_IN_WINDOW_WITHOUT_STATISTICS,
      variables
    )
    const history = data.repository?.defaultBranchRef?.target?.history
    return history ? commitHistoryWithUnavailableStatistics(history) : undefined
  }
}

interface RepositoryCommitsResponse {
  repository: {
    defaultBranchRef: {
      target: { history: GitHubCommitHistory } | null
    } | null
  } | null
}

type GitHubCommitWithoutStatistics = Omit<
  GitHubCommitNode,
  'additions' | 'deletions' | 'changedFiles'
>

interface GitHubCommitHistoryWithoutStatistics extends Omit<GitHubCommitHistory, 'nodes'> {
  nodes: GitHubCommitWithoutStatistics[]
}

interface RepositoryCommitsWithoutStatisticsResponse {
  repository: {
    defaultBranchRef: {
      target: { history: GitHubCommitHistoryWithoutStatistics } | null
    } | null
  } | null
}

function commitHistoryWithUnavailableStatistics(
  history: GitHubCommitHistoryWithoutStatistics
): GitHubCommitHistory {
  return {
    ...history,
    nodes: history.nodes.map((node) => ({
      ...node,
      additions: null,
      deletions: null,
      changedFiles: null
    }))
  }
}

function hasUnavailableCommitStatistics(history: GitHubCommitHistory): boolean {
  return history.nodes.some(
    (node) => node.additions === null || node.deletions === null || node.changedFiles === null
  )
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
    for (const item of await fetchSearchIssueItems(rest, query)) {
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
  const reviewedPullRequests = await fetchSearchIssueItems(
    rest,
    `repo:${fullName} type:pr reviewed-by:${identity.externalLogin}`,
    { dateSplit: { qualifier: 'updated', from: date, to: todayOrLater(date) } }
  )

  for (const pullRequest of reviewedPullRequests) {
    const reviews = await fetchPullRequestReviews(rest, fullName, pullRequest.number)

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
    for (const item of await fetchSearchIssueItems(rest, query)) {
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

function ignoreSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()))
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10)
}

function todayOrLater(date: string): string {
  const today = todayUTC()
  return today > date ? today : date
}

function shouldIgnoreRepository(
  repository: GitHubRepositoryNode,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): boolean {
  if (ignoredRepositories.has(repository.id.toLowerCase())) return true
  const ownerId = repository.owner.id
  return Boolean(ownerId && ignoredOrganizations.has(ownerId.toLowerCase()))
}
