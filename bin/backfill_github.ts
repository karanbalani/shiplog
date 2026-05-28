import * as db from '../lib/db.ts'
import { HttpError } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import {
  GitHubGraphQLError,
  isGitHubRepositoryUnavailableError
} from '../lib/providers/github/errors.ts'
import {
  privateRepositoryFailure,
  repositoryErrorSummary,
  repositoryLogLabel
} from '../lib/providers/github/logging.ts'
import * as queries from '../lib/providers/github/queries.ts'
import {
  GITHUB_SEARCH_REQUEST_INTERVAL_MS,
  restClient,
  type RestClient
} from '../lib/providers/github/rest.ts'
import { fetchGitHubAccountProfileById } from '../lib/providers/github/identity.ts'
import * as translate from '../lib/providers/github/translate.ts'
import type {
  GitHubCommitHistory,
  GitHubContributionsCollection,
  GitHubRepositoryNode,
  GitHubRestRepository,
  GitHubReviewItem,
  GitHubSearchPullRequestItem,
  GitHubSearchResult
} from '../lib/providers/github/types.ts'
import type {
  BackfillArgs,
  BackfillResult,
  RepositoryBackfillStateRow,
  VendorIdentity,
  VendorOrganizationToken
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

const BACKFILL_STEP_PULL_REQUESTS = 'pull_requests'
const BACKFILL_STEP_ISSUES = 'issues'
const BACKFILL_STEP_PULL_REQUEST_REVIEWS = 'pull_request_reviews'
const BACKFILL_STEP_SNAPSHOT = 'snapshot'

export async function run(args: BackfillArgs): Promise<BackfillResult> {
  const {
    identity,
    token,
    organizationTokens = [],
    ignoreOrganizationIds = [],
    ignoreRepositoryIds = [],
    throughDate,
    repositoryLimit,
    maxRuntimeMs,
    fetch
  } = args
  if (!identity) throw new Error('backfill_github: missing identity')
  if (!token) throw new Error('backfill_github: missing token')

  const startedAt = Date.now()
  const graphQL = graphQLClient({ token, fetch })
  const rest = restClient({ token, fetch })
  const defaultClients: GitHubClients = { graphQL, rest }
  const organizationClients = organizationClientMap(organizationTokens, fetch)
  const ignoredRepositories = ignoreSet(ignoreRepositoryIds)
  const ignoredOrganizations = ignoreSet(ignoreOrganizationIds)
  const user = await fetchGitHubAccountProfileById(graphQL, identity.externalId)
  const observedOn = throughDate ?? dates.yesterdayUTC()
  const years = dates.yearRange(
    new Date(user.externalCreatedAt).getUTCFullYear(),
    new Date(`${observedOn}T00:00:00Z`).getUTCFullYear()
  )
  const repositoriesByExternalId = new Map<string, RepositoryBackfillPlan>()

  const discoveryMessage = `[backfill] github/${identity.externalLogin}: discovering ${years.length} years of activity (${years[0]}-${years.at(-1)})`
  logger.info(discoveryMessage)

  for (const [index, year] of years.entries()) {
    const { from, to } = dates.yearWindow(year)
    const discoveryProgressMessage = `[backfill] github/${identity.externalLogin}: discovery ${index + 1}/${years.length} (${year})`
    logger.info(discoveryProgressMessage)
    const collection = await fetchContributionsCollection(graphQL, identity.externalLogin, from, to)

    collectActiveRepositories(
      collection,
      year,
      repositoriesByExternalId,
      ignoredRepositories,
      ignoredOrganizations
    )
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

  await collectAccessibleRepositories(
    rest,
    repositoriesByExternalId,
    ignoredRepositories,
    ignoredOrganizations
  )
  for (const organization of organizationTokens) {
    const clients = organizationClients.get(organization.externalId)
    if (!clients) continue
    await collectOrganizationRepositories(
      clients.rest,
      organization.externalLogin,
      repositoriesByExternalId,
      ignoredRepositories,
      ignoredOrganizations
    )
  }

  const repositoryCount = repositoriesByExternalId.size
  const plannedSearchCalls = countPlannedSearchRequests([...repositoriesByExternalId.values()])
  const estimatedSearchPacing = formatDuration(estimatedSearchRequestPacingMs(plannedSearchCalls))
  const discoveryCompleteMessage = `[backfill] github/${identity.externalLogin}: discovered ${repositoryCount} repositories; estimated minimum GitHub Search pacing ${estimatedSearchPacing}`
  logger.info(discoveryCompleteMessage)

  const repositoriesStartedAt = Date.now()
  let visitedRepositories = 0
  let processedRepositories = 0
  let deferredRepositories = 0
  let pausedByTimeBudget = false

  for (const repositoryPlan of repositoriesByExternalId.values()) {
    const repositoryNode = repositoryPlan.node
    const clients = clientsForRepository(repositoryNode, defaultClients, organizationClients)
    const organizationId = await upsertOrganizationFromRepositoryOwner(repositoryNode, observedOn)
    const repositoryInput = translate.repositoryFromGraphQLNode(
      repositoryNode,
      observedOn,
      organizationId
    )
    const repository = await upserts.upsertRepository(repositoryInput)
    const fullName = requiredString(repositoryInput.full_name, 'repository full name')
    const name = requiredString(repositoryInput.name, 'repository name')
    const visibility = repositoryNode.isPrivate ? 'private' : 'public'
    const logLabel = repositoryLogLabel(repositoryNode, fullName)
    const repositoryPosition = `${visitedRepositories + 1}/${repositoryCount}`
    const repositoryStartMessage = `[backfill] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel}`
    logger.info(repositoryStartMessage)

    let repositoryStatus = 'complete'
    try {
      const backfillState = await repositoryBackfillState(
        identity.accountId,
        repository.id,
        observedOn
      )
      const completedSteps = repositoryCompletedSteps(backfillState)
      if (backfillState?.status === 'succeeded') {
        repositoryStatus = 'already complete'
      } else if (backfillState?.status === 'skipped_permanent') {
        repositoryStatus = 'already skipped'
      } else if (
        !pausedByTimeBudget &&
        processedRepositories > 0 &&
        backfillTimeBudgetExceeded(startedAt, maxRuntimeMs)
      ) {
        pausedByTimeBudget = true
        repositoryStatus = 'deferred by time budget'
        deferredRepositories += 1
      } else if (pausedByTimeBudget) {
        repositoryStatus = 'deferred by time budget'
        deferredRepositories += 1
      } else if (repositoryLimit !== undefined && processedRepositories >= repositoryLimit) {
        repositoryStatus = 'deferred by budget'
        deferredRepositories += 1
      } else {
        processedRepositories += 1
        for (const year of commitYearsForPlan(repositoryPlan, years)) {
          const step = commitBackfillStep(year)
          const { from, to } = dates.yearWindow(year)
          if (completedSteps.has(step)) {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              `commits for ${year} already complete`
            )
          } else {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              `commits for ${year}`
            )
            await ingestCommits(
              clients.graphQL,
              repository.id,
              repositoryInput.owner_login,
              name,
              identity,
              from,
              to
            )
            await markBackfillStepSucceeded(
              identity.accountId,
              repository.id,
              observedOn,
              completedSteps,
              step
            )
          }
        }

        if (shouldSearchPullRequests(repositoryPlan)) {
          if (completedSteps.has(BACKFILL_STEP_PULL_REQUESTS)) {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              'pull requests already complete'
            )
          } else {
            logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'pull requests')
            await ingestPullRequests(clients.rest, repository.id, fullName, identity)
            await markBackfillStepSucceeded(
              identity.accountId,
              repository.id,
              observedOn,
              completedSteps,
              BACKFILL_STEP_PULL_REQUESTS
            )
          }
        }
        if (shouldSearchIssues(repositoryPlan)) {
          if (completedSteps.has(BACKFILL_STEP_ISSUES)) {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              'issues already complete'
            )
          } else {
            logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'issues')
            await ingestIssues(clients.rest, repository.id, fullName, identity)
            await markBackfillStepSucceeded(
              identity.accountId,
              repository.id,
              observedOn,
              completedSteps,
              BACKFILL_STEP_ISSUES
            )
          }
        }
        if (shouldSearchPullRequestReviews(repositoryPlan)) {
          if (completedSteps.has(BACKFILL_STEP_PULL_REQUEST_REVIEWS)) {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              'pull request reviews already complete'
            )
          } else {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              'pull request reviews'
            )
            await ingestPullRequestReviews(clients.rest, repository.id, fullName, identity)
            await markBackfillStepSucceeded(
              identity.accountId,
              repository.id,
              observedOn,
              completedSteps,
              BACKFILL_STEP_PULL_REQUEST_REVIEWS
            )
          }
        }
        let snapshotCaptured = true
        if (completedSteps.has(BACKFILL_STEP_SNAPSHOT)) {
          logRepositoryStep(
            identity,
            repositoryPosition,
            visibility,
            logLabel,
            'repository snapshot and languages already complete'
          )
        } else {
          logRepositoryStep(
            identity,
            repositoryPosition,
            visibility,
            logLabel,
            'repository snapshot and languages'
          )
          snapshotCaptured = await upsertRepositoryLanguageSnapshot(
            clients.graphQL,
            repository.id,
            repositoryInput.owner_login,
            name,
            observedOn
          )
          if (snapshotCaptured) {
            await markBackfillStepSucceeded(
              identity.accountId,
              repository.id,
              observedOn,
              completedSteps,
              BACKFILL_STEP_SNAPSHOT
            )
          }
        }
        if (snapshotCaptured) {
          await upserts.markRepositoryBackfillSucceeded(
            identity.accountId,
            repository.id,
            observedOn
          )
        }
      }
    } catch (error) {
      const errorSummary = repositoryErrorSummary(repositoryNode, error)

      if (isGitHubRepositoryUnavailableError(error)) {
        if (repositoryNode.isPrivate) throw privateRepositoryFailure(repositoryNode)

        repositoryStatus = 'skipped'
        await upserts.markRepositoryBackfillSkippedPermanent(
          identity.accountId,
          repository.id,
          observedOn,
          errorSummary
        )
        logger.warn(
          `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories + 1}/${repositoryCount} [${visibility}] ${logLabel} is unavailable; skipping enrichment (${errorSummary})`
        )
      } else if (isRetryableRepositoryBackfillError(error)) {
        repositoryStatus = 'retry later'
        deferredRepositories += 1
        await upserts.markRepositoryBackfillRetryWait(
          identity.accountId,
          repository.id,
          observedOn,
          errorSummary
        )
        logger.warn(
          `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories + 1}/${repositoryCount} [${visibility}] ${logLabel} hit a retryable provider error; will retry on a later run (${errorSummary})`
        )
      } else {
        throw error
      }
    }

    visitedRepositories += 1
    const progress = progressPercent(visitedRepositories, repositoryCount)
    const elapsed = formatDuration(Date.now() - repositoriesStartedAt)
    const eta = formatDuration(
      estimatedRemainingMs(repositoriesStartedAt, visitedRepositories, repositoryCount)
    )
    const repositoryCompleteMessage = `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories}/${repositoryCount} [${visibility}] ${logLabel} ${repositoryStatus} (${progress}%, elapsed ${elapsed}, eta ${eta})`
    logger.info(repositoryCompleteMessage)
  }

  logger.info(`[backfill] github/${identity.externalLogin}: rolling up activity dates`)
  await rollupDistinctActivityDates(identity.accountId)
  const result = {
    complete: deferredRepositories === 0,
    repositoriesDiscovered: repositoryCount,
    repositoriesProcessed: processedRepositories,
    repositoriesDeferred: deferredRepositories
  }

  if (result.complete) {
    const completeMessage = `[backfill] github/${identity.externalLogin}: complete in ${formatDuration(Date.now() - startedAt)}`
    logger.info(completeMessage)
  } else {
    logger.info(
      `[backfill] github/${identity.externalLogin}: paused after ${formatRepositoryCount(processedRepositories)}; ${formatRepositoryCount(deferredRepositories)} remaining`
    )
  }

  return result
}

function backfillTimeBudgetExceeded(startedAt: number, maxRuntimeMs: number | undefined): boolean {
  return maxRuntimeMs !== undefined && Date.now() - startedAt >= maxRuntimeMs
}

function formatRepositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

function logRepositoryStep(
  identity: VendorIdentity,
  repositoryPosition: string,
  visibility: string,
  logLabel: string,
  step: string
): void {
  const message = `[backfill] github/${identity.externalLogin}:   - repository ${repositoryPosition} [${visibility}] ${logLabel}: ${step}`
  logger.info(message)
}

function commitBackfillStep(year: number): string {
  return `commits:${year}`
}

function repositoryCompletedSteps(state: RepositoryBackfillStateRow | null): Set<string> {
  if (!state?.completed_steps.trim()) return new Set()
  return new Set(state.completed_steps.split(',').filter(Boolean))
}

function serializeRepositoryCompletedSteps(steps: Set<string>): string {
  return [...steps].sort().join(',')
}

async function markBackfillStepSucceeded(
  accountId: number,
  repositoryId: number,
  backfillThroughOn: string,
  completedSteps: Set<string>,
  step: string
): Promise<void> {
  completedSteps.add(step)
  await upserts.markRepositoryBackfillStepSucceeded(
    accountId,
    repositoryId,
    backfillThroughOn,
    serializeRepositoryCompletedSteps(completedSteps)
  )
}

interface GitHubClients {
  graphQL: GraphQLClient
  rest: RestClient
}

interface RepositoryBackfillPlan {
  node: GitHubRepositoryNode
  commitYears: Set<number>
  pullRequests: boolean
  pullRequestReviews: boolean
  issues: boolean
  fullScan: boolean
}

function organizationClientMap(
  organizationTokens: VendorOrganizationToken[],
  fetch: BackfillArgs['fetch']
): Map<string, GitHubClients> {
  return new Map(
    organizationTokens.map((orgToken) => [
      orgToken.externalId,
      {
        graphQL: graphQLClient({ token: orgToken.token, fetch }),
        rest: restClient({ token: orgToken.token, fetch })
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
  year: number,
  repositoriesByExternalId: Map<string, RepositoryBackfillPlan>,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): void {
  let mappedCommitContributions = 0
  let mappedPullRequestContributions = 0
  let mappedPullRequestReviewContributions = 0
  let mappedIssueContributions = 0

  for (const contribution of collection.commitContributionsByRepository) {
    const plan = upsertRepositoryPlan(
      repositoriesByExternalId,
      contribution.repository,
      ignoredRepositories,
      ignoredOrganizations
    )
    mappedCommitContributions += contribution.contributions.totalCount
    if (plan && contribution.contributions.totalCount > 0) plan.commitYears.add(year)
  }

  for (const contribution of collection.pullRequestContributionsByRepository) {
    const plan = upsertRepositoryPlan(
      repositoriesByExternalId,
      contribution.repository,
      ignoredRepositories,
      ignoredOrganizations
    )
    mappedPullRequestContributions += contribution.contributions.totalCount
    if (plan && contribution.contributions.totalCount > 0) plan.pullRequests = true
  }

  for (const contribution of collection.pullRequestReviewContributionsByRepository) {
    const plan = upsertRepositoryPlan(
      repositoriesByExternalId,
      contribution.repository,
      ignoredRepositories,
      ignoredOrganizations
    )
    mappedPullRequestReviewContributions += contribution.contributions.totalCount
    if (plan && contribution.contributions.totalCount > 0) plan.pullRequestReviews = true
  }

  for (const contribution of collection.issueContributionsByRepository) {
    const plan = upsertRepositoryPlan(
      repositoriesByExternalId,
      contribution.repository,
      ignoredRepositories,
      ignoredOrganizations
    )
    mappedIssueContributions += contribution.contributions.totalCount
    if (plan && contribution.contributions.totalCount > 0) plan.issues = true
  }

  if (collection.totalCommitContributions > mappedCommitContributions) {
    for (const plan of repositoriesByExternalId.values()) plan.commitYears.add(year)
  }
  if (collection.totalPullRequestContributions > mappedPullRequestContributions) {
    for (const plan of repositoriesByExternalId.values()) plan.pullRequests = true
  }
  if (collection.totalPullRequestReviewContributions > mappedPullRequestReviewContributions) {
    for (const plan of repositoriesByExternalId.values()) plan.pullRequestReviews = true
  }
  if (collection.totalIssueContributions > mappedIssueContributions) {
    for (const plan of repositoriesByExternalId.values()) plan.issues = true
  }
}

async function collectAccessibleRepositories(
  rest: RestClient,
  repositoriesByExternalId: Map<string, RepositoryBackfillPlan>,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): Promise<void> {
  for (let page = 1; ; page += 1) {
    const repositories = await rest<GitHubRestRepository[]>('/user/repos', {
      visibility: 'all',
      affiliation: 'owner,collaborator,organization_member',
      sort: 'full_name',
      direction: 'asc',
      per_page: 100,
      page
    })

    for (const repository of repositories) {
      const repositoryNode = translate.repositoryFromRestRepository(repository)
      if (shouldIgnoreRepository(repositoryNode, ignoredRepositories, ignoredOrganizations))
        continue
      const plan = upsertRepositoryPlan(
        repositoriesByExternalId,
        repositoryNode,
        ignoredRepositories,
        ignoredOrganizations
      )
      if (plan && repository.private) plan.fullScan = true
    }

    if (repositories.length < 100) return
  }
}

async function collectOrganizationRepositories(
  rest: RestClient,
  organization: string,
  repositoriesByExternalId: Map<string, RepositoryBackfillPlan>,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): Promise<void> {
  for (let page = 1; ; page += 1) {
    const repositories = await rest<GitHubRestRepository[]>(`/orgs/${organization}/repos`, {
      type: 'all',
      sort: 'full_name',
      direction: 'asc',
      per_page: 100,
      page
    })

    for (const repository of repositories) {
      const repositoryNode = translate.repositoryFromRestRepository(repository)
      if (shouldIgnoreRepository(repositoryNode, ignoredRepositories, ignoredOrganizations))
        continue
      const plan = upsertRepositoryPlan(
        repositoriesByExternalId,
        repositoryNode,
        ignoredRepositories,
        ignoredOrganizations
      )
      if (plan && repository.private) plan.fullScan = true
    }

    if (repositories.length < 100) return
  }
}

function upsertRepositoryPlan(
  repositoriesByExternalId: Map<string, RepositoryBackfillPlan>,
  repository: GitHubRepositoryNode,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): RepositoryBackfillPlan | null {
  if (shouldIgnoreRepository(repository, ignoredRepositories, ignoredOrganizations)) return null

  const existing = repositoriesByExternalId.get(repository.id)
  if (existing) return existing

  const plan: RepositoryBackfillPlan = {
    node: repository,
    commitYears: new Set(),
    pullRequests: false,
    pullRequestReviews: false,
    issues: false,
    fullScan: false
  }
  repositoriesByExternalId.set(repository.id, plan)
  return plan
}

function commitYearsForPlan(plan: RepositoryBackfillPlan, years: number[]): number[] {
  if (plan.fullScan) return years
  return years.filter((year) => plan.commitYears.has(year))
}

function shouldSearchPullRequests(plan: RepositoryBackfillPlan): boolean {
  return plan.fullScan || plan.pullRequests
}

function shouldSearchPullRequestReviews(plan: RepositoryBackfillPlan): boolean {
  return plan.fullScan || plan.pullRequestReviews
}

function shouldSearchIssues(plan: RepositoryBackfillPlan): boolean {
  return plan.fullScan || plan.issues
}

async function repositoryBackfillState(
  accountId: number,
  repositoryId: number,
  backfillThroughOn: string
): Promise<RepositoryBackfillStateRow | null> {
  const result = await db.query<RepositoryBackfillStateRow>(
    `SELECT *
       FROM repository_backfill_state
       WHERE account_id = $1
         AND repository_id = $2
         AND backfill_through_on = $3::date
       LIMIT 1`,
    [accountId, repositoryId, backfillThroughOn]
  )

  return result.rows[0] ?? null
}

function isRetryableRepositoryBackfillError(error: unknown): boolean {
  if (error instanceof HttpError) {
    if ([408, 429, 500, 502, 503, 504].includes(error.status)) return true
    if (error.status === 403) {
      const body = error.body.toLowerCase()
      return body.includes('rate limit') || body.includes('secondary rate')
    }
    return false
  }

  if (error instanceof GitHubGraphQLError) {
    return error.messages.some((message) => {
      const normalized = message.toLowerCase()
      return (
        normalized.includes('rate limit') ||
        normalized.includes('secondary rate') ||
        normalized.includes('abuse detection') ||
        normalized.includes('something went wrong') ||
        normalized.includes('timed out') ||
        normalized.includes('timeout') ||
        normalized.includes('service unavailable') ||
        normalized.includes('try again')
      )
    })
  }

  if (error instanceof Error) {
    const normalized = error.message.toLowerCase()
    return (
      normalized.includes('fetch failed') ||
      normalized.includes('network') ||
      normalized.includes('socket') ||
      normalized.includes('econnreset') ||
      normalized.includes('etimedout') ||
      normalized.includes('timed out') ||
      normalized.includes('timeout')
    )
  }

  return false
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
        since,
        until,
        cursor,
        author: { id: identity.externalId }
      }
    )

    const history: GitHubCommitHistory | undefined =
      data.repository?.defaultBranchRef?.target?.history
    if (!history) return

    for (const node of history.nodes) {
      if (!translate.commitIncludesIdentity(node, identity)) continue
      const commit = translate.commitFromGraphQLNode(node, identity, repositoryId, 'self_backfill')
      await upserts.upsertCommit(commit)
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
): Promise<boolean> {
  const data = await graphQL<RepositoryLanguagesResponse>(queries.REPOSITORY_LANGUAGES, {
    owner,
    name
  })
  if (!data.repository) return false

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

  return true
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
  return estimatedSearchRequestPacingMs(repositoryCount * searchCallsPerRepository)
}

function estimatedSearchRequestPacingMs(searchCalls: number): number {
  if (searchCalls <= 1) return 0
  return (searchCalls - 1) * GITHUB_SEARCH_REQUEST_INTERVAL_MS
}

function countPlannedSearchRequests(plans: RepositoryBackfillPlan[]): number {
  return plans.reduce((sum, plan) => {
    return (
      sum +
      Number(shouldSearchPullRequests(plan)) +
      Number(shouldSearchIssues(plan)) +
      Number(shouldSearchPullRequestReviews(plan))
    )
  }, 0)
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

function ignoreSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()))
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
