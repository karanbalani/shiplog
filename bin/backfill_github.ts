import * as db from '../lib/db.ts'
import { HttpError } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import {
  GitHubGraphQLError,
  isGitHubCommitStatisticsUnavailableError,
  isGitHubCredentialRejectedError,
  isGitHubRateLimitError,
  isGitHubRepositoryUnavailableError
} from '../lib/providers/github/errors.ts'
import { repositoryErrorSummary, repositoryLogLabel } from '../lib/providers/github/logging.ts'
import {
  fetchPullRequestReviews,
  fetchSearchIssueItems,
  type GitHubSearchDateSplit
} from '../lib/providers/github/pagination.ts'
import * as queries from '../lib/providers/github/queries.ts'
import {
  GITHUB_SEARCH_REQUEST_INTERVAL_MS,
  restClient,
  type RestClient
} from '../lib/providers/github/rest.ts'
import { fetchGitHubAccountProfileById } from '../lib/providers/github/identity.ts'
import * as translate from '../lib/providers/github/translate.ts'
import type { NewRepositoryRow } from '../lib/upserts.ts'
import type {
  GitHubCommitHistory,
  GitHubCommitIdentityNode,
  GitHubCommitNode,
  GitHubContributionsCollection,
  GitHubRepositoryNode,
  GitHubRestRepository
} from '../lib/providers/github/types.ts'
import type {
  BackfillArgs,
  BackfillMode,
  BackfillResult,
  PrivateRepositoryProbeStateRow,
  RepositoryBackfillStateRow,
  RepositoryRow,
  VendorIdentity,
  VendorOrganizationToken
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'
import { recordWorkflowDiagnostic } from '../lib/workflow_summary.ts'

const BACKFILL_STEP_PULL_REQUESTS = 'pull_requests'
const BACKFILL_STEP_ISSUES = 'issues'
const BACKFILL_STEP_PULL_REQUEST_REVIEWS = 'pull_request_reviews'
const BACKFILL_STEP_SNAPSHOT = 'snapshot'
const DEFAULT_BACKFILL_MODE: BackfillMode = 'fast'
const PRIVATE_CANDIDATE_CREDITED_PROBE_PAGE_LIMIT = 2

type CommitScanMode = 'authored' | 'credited'
type PrivateCandidateActivityResult = 'matched' | 'no_match' | 'incomplete'

export async function run(args: BackfillArgs): Promise<BackfillResult> {
  const {
    identity,
    token,
    tokenEnv,
    organizationTokens = [],
    ignoreOrganizationIds = [],
    ignoreRepositoryIds = [],
    throughDate,
    backfillMode = DEFAULT_BACKFILL_MODE,
    repositoryLimit,
    maxRuntimeMs,
    repoBudgetMs,
    fetch
  } = args
  if (!identity) throw new Error('backfill_github: missing identity')
  if (!token) throw new Error('backfill_github: missing token')

  const startedAt = Date.now()
  const graphQL = graphQLClient({ token, fetch })
  const rest = restClient({ token, fetch })
  const defaultClients: GitHubClients = { graphQL, rest, tokenEnv }
  const organizationClients = organizationClientMap(organizationTokens, fetch)
  const ignoredRepositories = ignoreSet(ignoreRepositoryIds)
  const ignoredOrganizations = ignoreSet(ignoreOrganizationIds)
  const user = await fetchGitHubAccountProfileById(graphQL, identity.externalId)
  const observedOn = throughDate ?? dates.yesterdayUTC()
  const years = dates.yearRange(
    new Date(user.externalCreatedAt).getUTCFullYear(),
    new Date(`${observedOn}T00:00:00Z`).getUTCFullYear()
  )
  const firstDiscoveryYear = years[0] ?? new Date(`${observedOn}T00:00:00Z`).getUTCFullYear()
  const repositoriesByExternalId = new Map<string, RepositoryBackfillPlan>()
  const commitScanMode = backfillMode === 'deep' ? 'credited' : 'authored'

  const discoveryMessage = `[backfill] github/${identity.externalLogin}: discovering ${years.length} years of activity (${years[0]}-${years.at(-1)}) in ${backfillMode} mode`
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

  if (backfillMode === 'deep') {
    try {
      await collectAccessiblePrivateRepositories(
        rest,
        repositoriesByExternalId,
        ignoredRepositories,
        ignoredOrganizations
      )
    } catch (error) {
      if (isGitHubCredentialRejectedError(error)) throw error
      if (!isSkippableAccessError(error)) throw error
      logger.warn(
        `[backfill] github/${identity.externalLogin}: skipped default private repository discovery for this run (${errorMessage(error)})`
      )
    }
    for (const organization of organizationTokens) {
      const clients = organizationClients.get(organization.externalId)
      if (!clients) continue
      try {
        await collectOrganizationRepositories(
          clients.rest,
          organization.externalLogin,
          repositoriesByExternalId,
          ignoredRepositories,
          ignoredOrganizations
        )
      } catch (error) {
        if (isGitHubCredentialRejectedError(error)) {
          logger.warn(
            `[backfill] github/${identity.externalLogin}: [SHIPLOG-GITHUB-AUTH-001] GitHub rejected optional organization token ${organization.tokenEnv}; skipping private repository discovery for that organization scope; rotate or re-authorize the token and rerun`
          )
          recordWorkflowDiagnostic({
            code: 'SHIPLOG-GITHUB-AUTH-001',
            step: 'backfill_history',
            tokenEnv: organization.tokenEnv,
            recovered: true
          })
          continue
        }
        if (!isSkippableAccessError(error)) throw error
        logger.warn(
          `[backfill] github/${identity.externalLogin}: skipped private repository discovery for organization ${organization.externalLogin} in this run (${errorMessage(error)})`
        )
      }
    }
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
  const errorEventIds: number[] = []
  let pausedByTimeBudget = false
  const repositoryPositions = new Map(
    [...repositoriesByExternalId.values()].map((plan, index) => [
      plan.node.id,
      `${index + 1}/${repositoryCount}`
    ])
  )
  const incompletePrivateProbePlans = new Map<string, RepositoryBackfillPlan>()

  for (const repositoryPlan of repositoriesByExternalId.values()) {
    const repositoryNode = repositoryPlan.node
    const clients = clientsForRepository(repositoryNode, defaultClients, organizationClients)
    const displayRepositoryInput = translate.repositoryFromGraphQLNode(repositoryNode, observedOn)
    const fullName = requiredString(displayRepositoryInput.full_name, 'repository full name')
    const name = requiredString(displayRepositoryInput.name, 'repository name')
    const visibility = repositoryNode.isPrivate ? 'private' : 'public'
    const logLabel = repositoryLogLabel(repositoryNode, fullName)
    const repositoryPosition =
      repositoryPositions.get(repositoryNode.id) ?? `${visitedRepositories + 1}/${repositoryCount}`
    const searchDateSplit = repositoryCreatedSearchDateSplit(
      repositoryNode,
      firstDiscoveryYear,
      observedOn
    )
    const repositoryStartMessage = `[backfill] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel}`
    logger.info(repositoryStartMessage)

    let repositoryStatus = 'complete'
    let repository: RepositoryRow | null = null
    let isUnpromotedCandidate = false
    try {
      const existingRepository = repositoryPlan.candidateOnly
        ? await existingRepositoryByExternalId(repositoryNode.id)
        : null
      isUnpromotedCandidate = repositoryPlan.candidateOnly && !existingRepository

      if (
        !pausedByTimeBudget &&
        processedRepositories > 0 &&
        backfillTimeBudgetExceeded(startedAt, maxRuntimeMs, repoBudgetMs)
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

        if (isUnpromotedCandidate) {
          logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'activity probe')
          const activity = await privateCandidateHasActivity(
            clients,
            repositoryPlan,
            displayRepositoryInput.owner_login,
            name,
            fullName,
            identity,
            years,
            searchDateSplit,
            observedOn,
            commitScanMode
          )

          if (activity === 'incomplete') {
            repositoryStatus = 'probe incomplete'
            deferredRepositories += 1
            incompletePrivateProbePlans.set(repositoryNode.id, repositoryPlan)
          } else if (activity === 'no_match') {
            repositoryStatus = 'no matching activity'
            processedRepositories -= 1
          } else {
            logRepositoryStep(
              identity,
              repositoryPosition,
              visibility,
              logLabel,
              'promote private candidate'
            )
            const promoted = await upsertRepositoryForPlan(repositoryNode, observedOn)
            repository = promoted.repository
            repositoryStatus = await processRepositoryBackfill({
              clients,
              repositoryPlan,
              repository,
              repositoryInput: promoted.repositoryInput,
              fullName,
              name,
              identity,
              years,
              observedOn,
              searchDateSplit,
              repositoryPosition,
              visibility,
              logLabel,
              commitScanMode
            })
            if (!repositoryStatusCountsAsProcessed(repositoryStatus)) processedRepositories -= 1
          }
        } else {
          const upserted = await upsertRepositoryForPlan(repositoryNode, observedOn)
          repository = upserted.repository
          repositoryStatus = await processRepositoryBackfill({
            clients,
            repositoryPlan,
            repository,
            repositoryInput: upserted.repositoryInput,
            fullName,
            name,
            identity,
            years,
            observedOn,
            searchDateSplit,
            repositoryPosition,
            visibility,
            logLabel,
            commitScanMode
          })
          if (!repositoryStatusCountsAsProcessed(repositoryStatus)) processedRepositories -= 1
        }
      }
    } catch (error) {
      const errorSummary = repositoryErrorSummary(repositoryNode, error)

      if (isGitHubCredentialRejectedError(error)) {
        const recovered = await canRecoverRepositoryCredentialRejection(
          repositoryNode,
          clients,
          defaultClients,
          identity
        )
        if (!recovered) throw error

        const primaryTokenRejected = !clients.organizationTokenEnv
        repositoryStatus = primaryTokenRejected ? 'retry later' : 'skipped for now'
        if (primaryTokenRejected) {
          deferredRepositories += 1
          if (repository) {
            await upserts.markRepositoryBackfillRetryWait(
              identity.accountId,
              repository.id,
              observedOn,
              errorSummary
            )
          }
        }
        recordRecoveredRepositoryCredentialRejection({
          identity,
          clients,
          repositoryPosition,
          visibility,
          logLabel
        })
      } else if (isGitHubRepositoryUnavailableError(error)) {
        if (repositoryNode.isPrivate) {
          repositoryStatus = 'skipped for now'
          logger.warn(
            `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories + 1}/${repositoryCount} [${visibility}] ${logLabel} is inaccessible in this run; skipping without recording a permanent state (${errorSummary})`
          )
        } else {
          repositoryStatus = 'skipped'
          if (repository) {
            await upserts.markRepositoryBackfillSkippedPermanent(
              identity.accountId,
              repository.id,
              observedOn,
              errorSummary
            )
          }
          logger.warn(
            `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories + 1}/${repositoryCount} [${visibility}] ${logLabel} is unavailable; skipping enrichment (${errorSummary})`
          )
        }
      } else if (repositoryNode.isPrivate && isSkippableAccessError(error)) {
        repositoryStatus = 'skipped for now'
        logger.warn(
          `[backfill] github/${identity.externalLogin}: repository ${visitedRepositories + 1}/${repositoryCount} [${visibility}] ${logLabel} is inaccessible in this run; skipping without recording a permanent state (${errorSummary})`
        )
      } else if (isRetryableRepositoryBackfillError(error)) {
        recordRetryableGitHubRateDiagnostic(error, clients.tokenEnv)
        repositoryStatus = 'retry later'
        deferredRepositories += 1
        const errorEvent = await recordBackfillErrorEvent({
          identity,
          repository,
          repositoryNode,
          fullName,
          name,
          observedOn,
          phase: isUnpromotedCandidate ? 'private_candidate_activity_probe' : 'repository_backfill',
          backfillMode,
          commitScanMode,
          repositoryPosition,
          error
        })
        errorEventIds.push(errorEvent.id)
        if (repository) {
          await upserts.markRepositoryBackfillRetryWait(
            identity.accountId,
            repository.id,
            observedOn,
            errorSummary
          )
        }
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

  while (
    maxRuntimeMs !== undefined &&
    incompletePrivateProbePlans.size > 0 &&
    !pausedByTimeBudget
  ) {
    if (backfillTimeBudgetExceeded(startedAt, maxRuntimeMs, repoBudgetMs)) {
      pausedByTimeBudget = true
      break
    }

    logger.info(
      `[backfill] github/${identity.externalLogin}: crunching ${formatIncompletePrivateProbeCount(incompletePrivateProbePlans.size)}`
    )

    for (const repositoryPlan of incompletePrivateProbePlans.values()) {
      if (backfillTimeBudgetExceeded(startedAt, maxRuntimeMs, repoBudgetMs)) {
        pausedByTimeBudget = true
        break
      }

      const repositoryNode = repositoryPlan.node
      const clients = clientsForRepository(repositoryNode, defaultClients, organizationClients)
      const displayRepositoryInput = translate.repositoryFromGraphQLNode(repositoryNode, observedOn)
      const fullName = requiredString(displayRepositoryInput.full_name, 'repository full name')
      const name = requiredString(displayRepositoryInput.name, 'repository name')
      const visibility = repositoryNode.isPrivate ? 'private' : 'public'
      const logLabel = repositoryLogLabel(repositoryNode, fullName)
      const repositoryPosition =
        repositoryPositions.get(repositoryNode.id) ??
        `${visitedRepositories + 1}/${repositoryCount}`
      const searchDateSplit = repositoryCreatedSearchDateSplit(
        repositoryNode,
        firstDiscoveryYear,
        observedOn
      )

      let repositoryStatus = 'probe incomplete'
      let repository: RepositoryRow | null = null
      try {
        logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'activity probe')
        const activity = await privateCandidateHasActivity(
          clients,
          repositoryPlan,
          displayRepositoryInput.owner_login,
          name,
          fullName,
          identity,
          years,
          searchDateSplit,
          observedOn,
          commitScanMode
        )

        if (activity === 'incomplete') {
          repositoryStatus = 'probe incomplete'
        } else if (activity === 'no_match') {
          incompletePrivateProbePlans.delete(repositoryNode.id)
          deferredRepositories -= 1
          processedRepositories -= 1
          repositoryStatus = 'no matching activity'
        } else {
          incompletePrivateProbePlans.delete(repositoryNode.id)
          logRepositoryStep(
            identity,
            repositoryPosition,
            visibility,
            logLabel,
            'promote private candidate'
          )
          const promoted = await upsertRepositoryForPlan(repositoryNode, observedOn)
          repository = promoted.repository
          repositoryStatus = await processRepositoryBackfill({
            clients,
            repositoryPlan,
            repository,
            repositoryInput: promoted.repositoryInput,
            fullName,
            name,
            identity,
            years,
            observedOn,
            searchDateSplit,
            repositoryPosition,
            visibility,
            logLabel,
            commitScanMode
          })
          if (!repositoryStatusCountsAsProcessed(repositoryStatus)) processedRepositories -= 1
          deferredRepositories -= 1
        }
      } catch (error) {
        const errorSummary = repositoryErrorSummary(repositoryNode, error)

        if (isGitHubCredentialRejectedError(error)) {
          const recovered = await canRecoverRepositoryCredentialRejection(
            repositoryNode,
            clients,
            defaultClients,
            identity
          )
          if (!recovered) throw error

          incompletePrivateProbePlans.delete(repositoryNode.id)
          const primaryTokenRejected = !clients.organizationTokenEnv
          repositoryStatus = primaryTokenRejected ? 'retry later' : 'skipped for now'
          if (primaryTokenRejected && repository) {
            await upserts.markRepositoryBackfillRetryWait(
              identity.accountId,
              repository.id,
              observedOn,
              errorSummary
            )
          }
          recordRecoveredRepositoryCredentialRejection({
            identity,
            clients,
            repositoryPosition,
            visibility,
            logLabel
          })
        } else if (isGitHubRepositoryUnavailableError(error) || isSkippableAccessError(error)) {
          incompletePrivateProbePlans.delete(repositoryNode.id)
          repositoryStatus = 'skipped for now'
          logger.warn(
            `[backfill] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel} is inaccessible in this run; skipping without recording a permanent state (${errorSummary})`
          )
        } else if (isRetryableRepositoryBackfillError(error)) {
          recordRetryableGitHubRateDiagnostic(error, clients.tokenEnv)
          repositoryStatus = 'retry later'
          incompletePrivateProbePlans.delete(repositoryNode.id)
          const errorEvent = await recordBackfillErrorEvent({
            identity,
            repository,
            repositoryNode,
            fullName,
            name,
            observedOn,
            phase: repository ? 'repository_backfill' : 'private_candidate_activity_probe',
            backfillMode,
            commitScanMode,
            repositoryPosition,
            error
          })
          errorEventIds.push(errorEvent.id)
          if (repository) {
            await upserts.markRepositoryBackfillRetryWait(
              identity.accountId,
              repository.id,
              observedOn,
              errorSummary
            )
          }
          logger.warn(
            `[backfill] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel} hit a retryable provider error; will retry on a later run (${errorSummary})`
          )
        } else {
          throw error
        }
      }

      const progress = progressPercent(visitedRepositories, repositoryCount)
      const elapsed = formatDuration(Date.now() - repositoriesStartedAt)
      const eta = formatDuration(
        estimatedRemainingMs(repositoriesStartedAt, visitedRepositories, repositoryCount)
      )
      const repositoryCompleteMessage = `[backfill] github/${identity.externalLogin}: repository ${repositoryPosition} [${visibility}] ${logLabel} ${repositoryStatus} (${progress}%, elapsed ${elapsed}, eta ${eta})`
      logger.info(repositoryCompleteMessage)
    }
  }

  logger.info(`[backfill] github/${identity.externalLogin}: rolling up activity dates`)
  await rollupDistinctActivityDates(identity.accountId)
  const result = {
    complete: deferredRepositories === 0,
    repositoriesDiscovered: repositoryCount,
    repositoriesProcessed: processedRepositories,
    repositoriesDeferred: deferredRepositories,
    errorEventIds
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

function backfillTimeBudgetExceeded(
  startedAt: number,
  maxRuntimeMs: number | undefined,
  repoBudgetMs = 0
): boolean {
  if (maxRuntimeMs === undefined) return false
  const elapsedMs = Date.now() - startedAt
  if (repoBudgetMs <= 0) return elapsedMs >= maxRuntimeMs
  return elapsedMs + repoBudgetMs > maxRuntimeMs
}

function formatRepositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
}

function formatIncompletePrivateProbeCount(count: number): string {
  return `${count} incomplete private ${count === 1 ? 'probe' : 'probes'}`
}

function repositoryStatusCountsAsProcessed(status: string): boolean {
  return status !== 'already complete' && status !== 'already skipped'
}

interface RecordBackfillErrorEventOptions {
  identity: VendorIdentity
  repository: RepositoryRow | null
  repositoryNode: GitHubRepositoryNode
  fullName: string
  name: string
  observedOn: string
  phase: string
  backfillMode: BackfillMode
  commitScanMode: CommitScanMode
  repositoryPosition: string
  error: unknown
}

async function recordBackfillErrorEvent({
  identity,
  repository,
  repositoryNode,
  fullName,
  name,
  observedOn,
  phase,
  backfillMode,
  commitScanMode,
  repositoryPosition,
  error
}: RecordBackfillErrorEventOptions): Promise<{ id: number }> {
  return upserts.recordErrorEvent({
    source: 'backfill',
    operation: 'backfill',
    provider: 'github',
    phase,
    account: {
      id: identity.accountId,
      externalLogin: identity.externalLogin,
      externalId: identity.externalId
    },
    subject: {
      type: 'repository',
      id: repository?.id ?? null,
      externalId: repositoryNode.id,
      owner: repositoryNode.owner.login,
      name,
      fullName,
      private: repositoryNode.isPrivate,
      position: repositoryPosition
    },
    error: {
      kind: errorKind(error),
      retryable: true,
      message: errorMessage(error),
      details: errorDetails(error)
    },
    context: {
      backfillThroughOn: observedOn,
      backfillMode,
      commitScanMode
    }
  })
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

function commitBackfillStep(year: number, commitScanMode: CommitScanMode): string {
  if (commitScanMode === 'authored') return `commits_authored:${year}`
  return `commits:${year}`
}

function commitBackfillStepCompleted(
  completedSteps: Set<string>,
  year: number,
  commitScanMode: CommitScanMode
): boolean {
  if (completedSteps.has(commitBackfillStep(year, commitScanMode))) return true
  return commitScanMode === 'authored' && completedSteps.has(commitBackfillStep(year, 'credited'))
}

function repositoryCompletedSteps(state: RepositoryBackfillStateRow | null): Set<string> {
  if (!state?.completed_steps.trim()) return new Set()
  return new Set(state.completed_steps.split(',').filter(Boolean))
}

function privateProbeCompletedYears(state: PrivateRepositoryProbeStateRow | null): Set<number> {
  if (!state?.completed_commit_years.trim()) return new Set()
  return new Set(
    state.completed_commit_years
      .split(',')
      .map((year) => Number(year))
      .filter((year) => Number.isInteger(year))
  )
}

function serializePrivateProbeCompletedYears(years: Set<number>): string {
  return [...years].sort((a, b) => a - b).join(',')
}

function repositoryBackfillCompleteForMode(
  state: RepositoryBackfillStateRow | null,
  completedSteps: Set<string>,
  repositoryPlan: RepositoryBackfillPlan,
  years: number[],
  commitScanMode: CommitScanMode
): boolean {
  if (state?.status !== 'succeeded') return false

  for (const year of commitYearsForPlan(repositoryPlan, years)) {
    if (!commitBackfillStepCompleted(completedSteps, year, commitScanMode)) return false
  }
  if (shouldSearchPullRequests(repositoryPlan) && !completedSteps.has(BACKFILL_STEP_PULL_REQUESTS))
    return false
  if (shouldSearchIssues(repositoryPlan) && !completedSteps.has(BACKFILL_STEP_ISSUES)) return false
  if (
    shouldSearchPullRequestReviews(repositoryPlan) &&
    !completedSteps.has(BACKFILL_STEP_PULL_REQUEST_REVIEWS)
  )
    return false
  return completedSteps.has(BACKFILL_STEP_SNAPSHOT)
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

interface UpsertedRepositoryPlan {
  repository: RepositoryRow
  repositoryInput: NewRepositoryRow
}

async function upsertRepositoryForPlan(
  repositoryNode: GitHubRepositoryNode,
  observedOn: string
): Promise<UpsertedRepositoryPlan> {
  const organizationId = await upsertOrganizationFromRepositoryOwner(repositoryNode, observedOn)
  const repositoryInput = translate.repositoryFromGraphQLNode(
    repositoryNode,
    observedOn,
    organizationId
  )
  const repository = await upserts.upsertRepository(repositoryInput)

  return { repository, repositoryInput }
}

async function existingRepositoryByExternalId(externalId: string): Promise<RepositoryRow | null> {
  const result = await db.query<RepositoryRow>(
    `SELECT *
     FROM repositories
     WHERE provider = 'github' AND external_id = $1
     LIMIT 1`,
    [externalId]
  )

  return result.rows[0] ?? null
}

interface ProcessRepositoryBackfillOptions {
  clients: GitHubClients
  repositoryPlan: RepositoryBackfillPlan
  repository: RepositoryRow
  repositoryInput: NewRepositoryRow
  fullName: string
  name: string
  identity: VendorIdentity
  years: number[]
  observedOn: string
  searchDateSplit: GitHubSearchDateSplit
  repositoryPosition: string
  visibility: string
  logLabel: string
  commitScanMode: CommitScanMode
}

async function processRepositoryBackfill({
  clients,
  repositoryPlan,
  repository,
  repositoryInput,
  fullName,
  name,
  identity,
  years,
  observedOn,
  searchDateSplit,
  repositoryPosition,
  visibility,
  logLabel,
  commitScanMode
}: ProcessRepositoryBackfillOptions): Promise<string> {
  const backfillState = await repositoryBackfillState(identity.accountId, repository.id, observedOn)
  const completedSteps = repositoryCompletedSteps(backfillState)
  if (
    repositoryBackfillCompleteForMode(
      backfillState,
      completedSteps,
      repositoryPlan,
      years,
      commitScanMode
    )
  )
    return 'already complete'
  if (backfillState?.status === 'skipped_permanent') return 'already skipped'

  for (const year of commitYearsForPlan(repositoryPlan, years)) {
    const step = commitBackfillStep(year, commitScanMode)
    const { from, to } = dates.yearWindow(year)
    if (commitBackfillStepCompleted(completedSteps, year, commitScanMode)) {
      logRepositoryStep(
        identity,
        repositoryPosition,
        visibility,
        logLabel,
        `commits for ${year} already complete`
      )
    } else {
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, `commits for ${year}`)
      await ingestCommits(
        clients.graphQL,
        repository.id,
        repositoryInput.owner_login,
        name,
        identity,
        from,
        to,
        commitScanMode
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
      await ingestPullRequests(clients.rest, repository.id, fullName, identity, searchDateSplit)
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
      await ingestIssues(clients.rest, repository.id, fullName, identity, searchDateSplit)
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
      logRepositoryStep(identity, repositoryPosition, visibility, logLabel, 'pull request reviews')
      await ingestPullRequestReviews(
        clients.rest,
        repository.id,
        fullName,
        identity,
        searchDateSplit,
        observedOn
      )
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
    await upserts.markRepositoryBackfillSucceeded(identity.accountId, repository.id, observedOn)
  }

  return 'complete'
}

interface GitHubClients {
  graphQL: GraphQLClient
  rest: RestClient
  tokenEnv?: string
  organizationTokenEnv?: string
}

interface RepositoryBackfillPlan {
  node: GitHubRepositoryNode
  commitYears: Set<number>
  pullRequests: boolean
  pullRequestReviews: boolean
  issues: boolean
  fullScan: boolean
  candidateOnly: boolean
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
        rest: restClient({ token: orgToken.token, fetch }),
        tokenEnv: orgToken.tokenEnv,
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

async function canRecoverRepositoryCredentialRejection(
  repositoryNode: GitHubRepositoryNode,
  clients: GitHubClients,
  defaultClients: GitHubClients,
  identity: VendorIdentity
): Promise<boolean> {
  if (clients.organizationTokenEnv) return true
  if (!repositoryNode.isPrivate || clients !== defaultClients) return false

  try {
    await fetchGitHubAccountProfileById(defaultClients.graphQL, identity.externalId)
    return true
  } catch {
    return false
  }
}

interface RecoveredRepositoryCredentialOptions {
  identity: VendorIdentity
  clients: GitHubClients
  repositoryPosition: string
  visibility: string
  logLabel: string
}

function recordRecoveredRepositoryCredentialRejection({
  identity,
  clients,
  repositoryPosition,
  visibility,
  logLabel
}: RecoveredRepositoryCredentialOptions): void {
  const tokenEnv = clients.tokenEnv
  const tokenLabel = tokenEnv ? ` ${tokenEnv}` : ''
  if (clients.organizationTokenEnv) {
    logger.warn(
      `[backfill] github/${identity.externalLogin}: [SHIPLOG-GITHUB-AUTH-001] GitHub rejected optional organization token${tokenLabel}; repository ${repositoryPosition} [${visibility}] ${logLabel} was skipped for this run; rotate or re-authorize the token and rerun`
    )
  } else {
    logger.warn(
      `[backfill] github/${identity.externalLogin}: [SHIPLOG-GITHUB-AUTH-001] GitHub rejected default read token${tokenLabel} for repository ${repositoryPosition} [${visibility}] ${logLabel}; account access still validates, so the repository was deferred to a later run`
    )
  }
  recordWorkflowDiagnostic({
    code: 'SHIPLOG-GITHUB-AUTH-001',
    step: 'backfill_history',
    tokenEnv,
    recovered: true
  })
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

async function collectAccessiblePrivateRepositories(
  rest: RestClient,
  repositoriesByExternalId: Map<string, RepositoryBackfillPlan>,
  ignoredRepositories: Set<string>,
  ignoredOrganizations: Set<string>
): Promise<void> {
  for (let page = 1; ; page += 1) {
    const repositories = await rest<GitHubRestRepository[]>('/user/repos', {
      visibility: 'private',
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
      const existing = repositoriesByExternalId.get(repository.node_id)
      if (existing) {
        if (repository.private) existing.fullScan = true
        continue
      }
      if (!repository.private) continue
      const plan = upsertRepositoryPlan(
        repositoriesByExternalId,
        repositoryNode,
        ignoredRepositories,
        ignoredOrganizations,
        { candidateOnly: true }
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
      const existing = repositoriesByExternalId.get(repository.node_id)
      if (existing) {
        if (repository.private) existing.fullScan = true
        continue
      }
      if (!repository.private) continue
      const plan = upsertRepositoryPlan(
        repositoriesByExternalId,
        repositoryNode,
        ignoredRepositories,
        ignoredOrganizations,
        { candidateOnly: true }
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
  ignoredOrganizations: Set<string>,
  options: { candidateOnly?: boolean } = {}
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
    fullScan: false,
    candidateOnly: options.candidateOnly ?? false
  }
  repositoriesByExternalId.set(repository.id, plan)
  return plan
}

function commitYearsForPlan(plan: RepositoryBackfillPlan, years: number[]): number[] {
  if (plan.fullScan) return repositoryActiveYears(plan.node, years)
  return years.filter((year) => plan.commitYears.has(year))
}

function repositoryActiveYears(repository: GitHubRepositoryNode, years: number[]): number[] {
  const createdYear = yearFromIso(repository.createdAt)
  const pushedYear = yearFromIso(repository.pushedAt)

  return years.filter((year) => {
    if (createdYear !== null && year < createdYear) return false
    if (pushedYear !== null && year > pushedYear) return false
    return true
  })
}

function repositoryCreatedSearchDateSplit(
  repository: GitHubRepositoryNode,
  firstDiscoveryYear: number,
  observedOn: string
): GitHubSearchDateSplit {
  return {
    qualifier: 'created',
    from: dateOnlyFromIso(repository.createdAt) ?? `${firstDiscoveryYear}-01-01`,
    to: observedOn
  }
}

function yearFromIso(value: string | null | undefined): number | null {
  if (!value) return null

  const year = new Date(value).getUTCFullYear()
  return Number.isFinite(year) ? year : null
}

function dateOnlyFromIso(value: string | null | undefined): string | null {
  if (!value) return null

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

function dateOnlyFromValue(value: Date | string | null | undefined): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return dateOnlyFromIso(value)
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
         AND backfill_through_on <= $3::date
       ORDER BY backfill_through_on DESC
       LIMIT 1`,
    [accountId, repositoryId, backfillThroughOn]
  )

  return result.rows[0] ?? null
}

async function privateRepositoryProbeState(
  accountId: number,
  repositoryExternalId: string,
  backfillThroughOn: string
): Promise<PrivateRepositoryProbeStateRow | null> {
  const result = await db.query<PrivateRepositoryProbeStateRow>(
    `SELECT *
       FROM private_repository_probe_state
       WHERE account_id = $1
         AND repository_external_id = $2
         AND backfill_through_on <= $3::date
       ORDER BY backfill_through_on DESC
       LIMIT 1`,
    [accountId, repositoryExternalId, backfillThroughOn]
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
        normalized.includes('empty graphql response') ||
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

function recordRetryableGitHubRateDiagnostic(error: unknown, tokenEnv?: string): void {
  if (!isGitHubRateLimitError(error)) return
  recordWorkflowDiagnostic({
    code: 'SHIPLOG-GITHUB-RATE-001',
    step: 'backfill_history',
    tokenEnv,
    recovered: true
  })
}

function isSkippableAccessError(error: unknown): boolean {
  if (isRetryableRepositoryBackfillError(error)) return false

  if (error instanceof HttpError) {
    return [403, 404].includes(error.status)
  }

  if (error instanceof GitHubGraphQLError) {
    return error.messages.some(isSkippableAccessMessage)
  }

  if (error instanceof Error) {
    return isSkippableAccessMessage(error.message)
  }

  return false
}

function isSkippableAccessMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('resource not accessible') ||
    normalized.includes('could not resolve to a repository') ||
    normalized.includes('repository not found') ||
    normalized.includes('not found')
  )
}

function errorKind(error: unknown): string {
  if (error instanceof HttpError) return `http_${error.status}`
  if (error instanceof GitHubGraphQLError) return 'github_graphql'
  if (error instanceof Error) {
    const normalized = error.message.toLowerCase()
    if (normalized.includes('timed out') || normalized.includes('timeout')) return 'timeout'
    if (normalized.includes('network')) return 'network'
    if (normalized.includes('socket')) return 'socket'
    return error.name || 'error'
  }
  return 'unknown'
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof HttpError) {
    return {
      name: error.name,
      status: error.status,
      message: error.message,
      body: error.body,
      headers: Object.fromEntries(error.headers.entries())
    }
  }

  if (error instanceof GitHubGraphQLError) {
    return {
      name: error.name,
      message: error.message,
      messages: error.messages,
      stack: error.stack
    }
  }

  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack
    }
  }

  return { value: error }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpError) return `HTTP ${error.status}: ${error.body.slice(0, 160)}`
  if (error instanceof GitHubGraphQLError) return error.messages.join('; ')
  if (error instanceof Error) return error.message
  return String(error)
}

async function ingestCommits(
  graphQL: GraphQLClient,
  repositoryId: number,
  owner: string,
  name: string,
  identity: VendorIdentity,
  since: string,
  until: string,
  commitScanMode: CommitScanMode
): Promise<void> {
  let cursor: string | null = null

  for (;;) {
    const history = await fetchCommitHistory(
      graphQL,
      owner,
      name,
      identity,
      since,
      until,
      cursor,
      commitScanMode
    )
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

async function privateCandidateHasActivity(
  clients: GitHubClients,
  repositoryPlan: RepositoryBackfillPlan,
  owner: string,
  name: string,
  fullName: string,
  identity: VendorIdentity,
  years: number[],
  dateSplit: GitHubSearchDateSplit,
  observedOn: string,
  commitScanMode: CommitScanMode
): Promise<PrivateCandidateActivityResult> {
  const probeState = await privateRepositoryProbeState(
    identity.accountId,
    repositoryPlan.node.id,
    observedOn
  )
  if (probeState?.status === 'matched') return 'matched'
  if (
    probeState?.status === 'no_match' &&
    dateOnlyFromValue(probeState.backfill_through_on) === observedOn
  ) {
    return 'no_match'
  }

  const resumableProbeState = probeState?.status === 'running' ? probeState : null
  const completedCommitYears = privateProbeCompletedYears(resumableProbeState)
  const authoredProbeIsCurrent =
    resumableProbeState !== null &&
    dateOnlyFromValue(resumableProbeState.backfill_through_on) === observedOn

  if (!authoredProbeIsCurrent) {
    for (const year of commitYearsForPlan(repositoryPlan, years)) {
      const { from, to } = dates.yearWindow(year)
      if (await repositoryHasAuthoredCommit(clients.graphQL, owner, name, identity, from, to)) {
        await upserts.markPrivateRepositoryProbeMatched(
          identity.accountId,
          repositoryPlan.node.id,
          observedOn
        )
        return 'matched'
      }
    }
  }

  if (commitScanMode === 'credited') {
    const commitProbeResult = await probePrivateCandidateCreditedCommits(
      clients.graphQL,
      repositoryPlan,
      owner,
      name,
      identity,
      years,
      observedOn,
      resumableProbeState,
      completedCommitYears
    )
    if (commitProbeResult !== 'no_match') return commitProbeResult
  }

  if (shouldSearchPullRequests(repositoryPlan)) {
    const pullRequests = await fetchSearchIssueItems(
      clients.rest,
      `repo:${fullName} type:pr author:${identity.externalLogin}`,
      { dateSplit }
    )
    if (pullRequests.length > 0) {
      await upserts.markPrivateRepositoryProbeMatched(
        identity.accountId,
        repositoryPlan.node.id,
        observedOn
      )
      return 'matched'
    }
  }

  if (shouldSearchIssues(repositoryPlan)) {
    const issues = await fetchSearchIssueItems(
      clients.rest,
      `repo:${fullName} type:issue author:${identity.externalLogin}`,
      { dateSplit }
    )
    if (issues.length > 0) {
      await upserts.markPrivateRepositoryProbeMatched(
        identity.accountId,
        repositoryPlan.node.id,
        observedOn
      )
      return 'matched'
    }
  }

  if (shouldSearchPullRequestReviews(repositoryPlan)) {
    const reviewedPullRequests = await fetchSearchIssueItems(
      clients.rest,
      `repo:${fullName} type:pr reviewed-by:${identity.externalLogin}`,
      { dateSplit }
    )
    if (
      reviewedPullRequests.some(
        (pullRequest) => !pullRequest.closed_at || pullRequest.closed_at.slice(0, 10) <= observedOn
      )
    ) {
      await upserts.markPrivateRepositoryProbeMatched(
        identity.accountId,
        repositoryPlan.node.id,
        observedOn
      )
      return 'matched'
    }
  }

  await upserts.markPrivateRepositoryProbeNoMatch(
    identity.accountId,
    repositoryPlan.node.id,
    observedOn,
    serializePrivateProbeCompletedYears(completedCommitYears)
  )
  return 'no_match'
}

async function repositoryHasAuthoredCommit(
  graphQL: GraphQLClient,
  owner: string,
  name: string,
  identity: VendorIdentity,
  since: string,
  until: string
): Promise<boolean> {
  const data = await graphQL<RepositoryCommitExistsResponse>(
    queries.REPOSITORY_AUTHORED_COMMIT_EXISTS_IN_WINDOW,
    {
      owner,
      name,
      author: { id: identity.externalId },
      since,
      until
    }
  )

  return Boolean(data.repository?.defaultBranchRef?.target?.history.nodes.length)
}

interface RepositoryCommitExistsResponse {
  repository: {
    defaultBranchRef: {
      target: { history: { nodes: Array<{ oid: string }> } } | null
    } | null
  } | null
}

async function probePrivateCandidateCreditedCommits(
  graphQL: GraphQLClient,
  repositoryPlan: RepositoryBackfillPlan,
  owner: string,
  name: string,
  identity: VendorIdentity,
  years: number[],
  observedOn: string,
  probeState: PrivateRepositoryProbeStateRow | null,
  completedYears: Set<number>
): Promise<PrivateCandidateActivityResult> {
  let pages = 0

  for (const year of commitYearsForPlan(repositoryPlan, years)) {
    if (completedYears.has(year)) continue

    const { from, to } = dates.yearWindow(year)
    let cursor =
      probeState?.status === 'running' && probeState.commit_year === year
        ? probeState.commit_cursor
        : null

    for (;;) {
      if (pages >= PRIVATE_CANDIDATE_CREDITED_PROBE_PAGE_LIMIT) {
        await upserts.markPrivateRepositoryProbeRunning(
          identity.accountId,
          repositoryPlan.node.id,
          observedOn,
          year,
          cursor,
          serializePrivateProbeCompletedYears(completedYears)
        )
        return 'incomplete'
      }

      pages += 1
      const history = await fetchCommitIdentityHistory(graphQL, owner, name, from, to, cursor)
      if (!history) {
        completedYears.add(year)
        break
      }
      if (history.nodes.some((node) => translate.commitIncludesIdentity(node, identity))) {
        await upserts.markPrivateRepositoryProbeMatched(
          identity.accountId,
          repositoryPlan.node.id,
          observedOn
        )
        return 'matched'
      }
      if (!history.pageInfo.hasNextPage) {
        completedYears.add(year)
        break
      }
      cursor = history.pageInfo.endCursor
    }
  }

  return 'no_match'
}

async function fetchCommitHistory(
  graphQL: GraphQLClient,
  owner: string,
  name: string,
  identity: VendorIdentity,
  since: string,
  until: string,
  cursor: string | null,
  commitScanMode: CommitScanMode
): Promise<GitHubCommitHistory | undefined> {
  const query =
    commitScanMode === 'authored'
      ? queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW
      : queries.REPOSITORY_COMMITS_IN_WINDOW
  const queryWithoutStatistics =
    commitScanMode === 'authored'
      ? queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW_WITHOUT_STATISTICS
      : queries.REPOSITORY_COMMITS_IN_WINDOW_WITHOUT_STATISTICS
  const variables: Record<string, unknown> = {
    owner,
    name,
    since,
    until,
    cursor
  }
  if (commitScanMode === 'authored') variables.author = { id: identity.externalId }

  try {
    const data = await graphQL<RepositoryCommitsResponse>(query, variables)
    const history = data.repository?.defaultBranchRef?.target?.history
    if (history && hasUnavailableCommitStatistics(history)) {
      logger.warn(
        `[backfill] github/${identity.externalLogin}: [SHIPLOG-GITHUB-STATS-001] GitHub returned unavailable optional commit statistics; preserving the commits with null metrics`
      )
      recordWorkflowDiagnostic({
        code: 'SHIPLOG-GITHUB-STATS-001',
        step: 'backfill_history',
        recovered: true
      })
    }
    return history
  } catch (error) {
    if (!isGitHubCommitStatisticsUnavailableError(error)) throw error

    logger.warn(
      `[backfill] github/${identity.externalLogin}: [SHIPLOG-GITHUB-STATS-001] GitHub could not calculate optional commit statistics; retrying the same page without statistics`
    )
    recordWorkflowDiagnostic({
      code: 'SHIPLOG-GITHUB-STATS-001',
      step: 'backfill_history',
      recovered: true
    })
    const data = await graphQL<RepositoryCommitsWithoutStatisticsResponse>(
      queryWithoutStatistics,
      variables
    )
    const history = data.repository?.defaultBranchRef?.target?.history
    return history ? commitHistoryWithUnavailableStatistics(history) : undefined
  }
}

async function fetchCommitIdentityHistory(
  graphQL: GraphQLClient,
  owner: string,
  name: string,
  since: string,
  until: string,
  cursor: string | null
): Promise<GitHubCommitIdentityHistory | undefined> {
  const data = await graphQL<RepositoryCommitIdentitiesResponse>(
    queries.REPOSITORY_CREDITED_COMMIT_IDENTITIES_IN_WINDOW,
    { owner, name, since, until, cursor }
  )

  return data.repository?.defaultBranchRef?.target?.history
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

interface GitHubCommitIdentityHistory {
  pageInfo: GitHubCommitHistory['pageInfo']
  nodes: GitHubCommitIdentityNode[]
}

interface RepositoryCommitIdentitiesResponse {
  repository: {
    defaultBranchRef: {
      target: { history: GitHubCommitIdentityHistory } | null
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
  dateSplit: GitHubSearchDateSplit
): Promise<void> {
  const items = await fetchSearchIssueItems(
    rest,
    `repo:${fullName} type:pr author:${identity.externalLogin}`,
    { dateSplit }
  )

  for (const item of items) {
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
  identity: VendorIdentity,
  dateSplit: GitHubSearchDateSplit
): Promise<void> {
  const items = await fetchSearchIssueItems(
    rest,
    `repo:${fullName} type:issue author:${identity.externalLogin}`,
    { dateSplit }
  )

  for (const item of items) {
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
  identity: VendorIdentity,
  dateSplit: GitHubSearchDateSplit,
  observedOn: string
): Promise<void> {
  const pullRequests = await fetchSearchIssueItems(
    rest,
    `repo:${fullName} type:pr reviewed-by:${identity.externalLogin}`,
    { dateSplit }
  )

  for (const pullRequest of pullRequests) {
    const reviews = await fetchPullRequestReviews(rest, fullName, pullRequest.number)

    for (const review of reviews) {
      if (review.user?.login !== identity.externalLogin) continue
      if (!review.submitted_at) continue
      if (review.submitted_at.slice(0, 10) > observedOn) continue

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
