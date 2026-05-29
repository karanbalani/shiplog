import * as collect from './collect.ts'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubAccountProfileById } from '../lib/providers/github/identity.ts'
import * as queries from '../lib/providers/github/queries.ts'
import type { GitHubContributionsCollection } from '../lib/providers/github/types.ts'
import type {
  AccountRow,
  DailyUserSummaryRow,
  ShiplogCollectAccountConfig,
  ShiplogConfig
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

const DEFAULT_DRIFT_LOOKBACK_DAYS = 14
const DEFAULT_DRIFT_REPAIR_CHUNK_DAYS = 7
const DRIFT_REPAIR_PRIORITY = 20

type GitHubContributionTotals = Pick<
  GitHubContributionsCollection,
  | 'totalCommitContributions'
  | 'totalIssueContributions'
  | 'totalPullRequestContributions'
  | 'totalPullRequestReviewContributions'
  | 'restrictedContributionsCount'
>

export interface DriftRunOptions {
  configPath?: string
  config?: ShiplogConfig
  fetch?: Fetcher
  now?: Date
  fromDate?: string
  toDate?: string
  lookbackDays?: number
  repairChunkDays?: number
}

export interface DriftRunResult {
  accountsChecked: number
  datesChecked: number
  tasksEnqueued: number
}

interface DriftDateRequest {
  from?: string
  to?: string
}

interface DriftFinding {
  date: string
  reason: DriftReason
}

type DriftReason = 'missing_summary' | 'summary_totals_mismatch'

interface RepairRange {
  from: string
  to: string
  reason: DriftReason
}

export async function run(options: DriftRunOptions = {}): Promise<DriftRunResult> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const now = options.now ?? new Date()
  const yesterday = dates.yesterdayUTC(now)
  const checkDates = driftDates(driftDateRequest(options), yesterday, driftLookbackDays(options))

  if (checkDates.length === 0) {
    logger.info('[drift] no dates to check')
    return { accountsChecked: 0, datesChecked: 0, tasksEnqueued: 0 }
  }

  const repairChunkDays = driftRepairChunkDays(options)
  const result: DriftRunResult = { accountsChecked: 0, datesChecked: 0, tasksEnqueued: 0 }
  for (const accountConfig of shiplogConfig.collect.accounts) {
    const account = await collect.findAccount(accountConfig)
    const token = tokenForAccount(accountConfig)
    const graphQL = graphQLClient({ token, fetch: options.fetch })
    const refreshedAccount = await refreshAccount(accountConfig, account, graphQL)

    logger.info(
      `[drift] ${accountConfig.provider}/${refreshedAccount.external_login}: checking ${checkDates.length} day(s) (${checkDates[0]} to ${checkDates.at(-1)})`
    )

    const findings = await driftFindings(
      graphQL,
      refreshedAccount,
      refreshedAccount.external_login,
      checkDates
    )
    const ranges = repairRanges(findings, repairChunkDays)

    for (const range of ranges) {
      await upserts.enqueueMaintenanceRepairTask({
        account_id: refreshedAccount.id,
        target_from_on: range.from,
        target_to_on: range.to,
        reason: maintenanceReason(range.reason),
        priority: DRIFT_REPAIR_PRIORITY,
        next_run_at: now
      })
      result.tasksEnqueued += 1
      logger.warn(
        `[drift] ${accountConfig.provider}/${refreshedAccount.external_login}: queued repair ${range.from} to ${range.to} (${maintenanceReason(range.reason)})`
      )
    }

    if (ranges.length === 0) {
      logger.info(`[drift] ${accountConfig.provider}/${refreshedAccount.external_login}: no drift`)
    }

    result.accountsChecked += 1
    result.datesChecked += checkDates.length
  }

  return result
}

async function driftFindings(
  graphQL: GraphQLClient,
  account: AccountRow,
  login: string,
  checkDates: string[]
): Promise<DriftFinding[]> {
  const storedByDate = await dailyUserSummariesForRange(
    account.id,
    checkDates[0]!,
    checkDates.at(-1)!
  )
  const findings: DriftFinding[] = []

  for (const date of checkDates) {
    const stored = storedByDate.get(date)
    if (!stored) {
      findings.push({ date, reason: 'missing_summary' })
      continue
    }

    const current = await fetchContributionsTotalsForDate(graphQL, login, date)
    if (dailySummaryDrifted(stored, current)) {
      findings.push({ date, reason: 'summary_totals_mismatch' })
    }
  }

  return findings
}

async function dailyUserSummariesForRange(
  accountId: number,
  from: string,
  to: string
): Promise<Map<string, DailyUserSummaryRow>> {
  const result = await db.query<DailyUserSummaryRow>(
    `SELECT *
     FROM daily_user_summary
     WHERE account_id = $1
       AND activity_on BETWEEN $2::date AND $3::date`,
    [accountId, from, to]
  )

  return new Map(result.rows.map((row) => [dateOnly(row.activity_on), row]))
}

async function fetchContributionsTotalsForDate(
  graphQL: GraphQLClient,
  login: string,
  date: string
): Promise<GitHubContributionTotals> {
  const window = dates.contributionDayWindow(date)
  const data = await graphQL<{
    user: { contributionsCollection: GitHubContributionTotals } | null
  }>(queries.CONTRIBUTIONS_TOTALS, {
    login,
    from: window.from,
    to: window.to
  })

  if (!data.user) throw new Error(`drift: GitHub user not found: ${login}`)
  return data.user.contributionsCollection
}

function dailySummaryDrifted(
  stored: DailyUserSummaryRow,
  current: GitHubContributionTotals
): boolean {
  return (
    stored.total_commit_contributions !== current.totalCommitContributions ||
    stored.total_pull_request_contributions !== current.totalPullRequestContributions ||
    stored.total_pull_request_review_contributions !==
      current.totalPullRequestReviewContributions ||
    stored.total_issue_contributions !== current.totalIssueContributions ||
    stored.restricted_contributions_count !== current.restrictedContributionsCount
  )
}

async function refreshAccount(
  accountConfig: ShiplogCollectAccountConfig,
  account: AccountRow,
  graphQL: GraphQLClient
): Promise<AccountRow> {
  if (accountConfig.provider !== 'github') {
    throw new Error(`unsupported provider in v1: ${accountConfig.provider}`)
  }

  const profile = await fetchGitHubAccountProfileById(graphQL, account.external_id)
  return upserts.upsertAccount({
    user_id: account.user_id,
    provider: accountConfig.provider,
    external_login: profile.externalLogin,
    external_id: profile.externalId,
    external_url: profile.externalUrl,
    external_created_at: profile.externalCreatedAt,
    first_seen_on: dateOnly(account.first_seen_on)
  })
}

function repairRanges(findings: DriftFinding[], repairChunkDays: number): RepairRange[] {
  const ranges: RepairRange[] = []
  const sorted = [...findings].sort((left, right) => left.date.localeCompare(right.date))

  for (const finding of sorted) {
    const previous = ranges.at(-1)
    if (
      previous &&
      previous.reason === finding.reason &&
      addDays(previous.to, 1) === finding.date &&
      dateSpanDays(previous.from, finding.date) <= repairChunkDays
    ) {
      previous.to = finding.date
      continue
    }

    ranges.push({ from: finding.date, to: finding.date, reason: finding.reason })
  }

  return ranges
}

function maintenanceReason(reason: DriftReason): string {
  if (reason === 'missing_summary') return 'drift: missing daily summary'
  return 'drift: daily summary totals mismatch'
}

function driftDateRequest(options: DriftRunOptions): DriftDateRequest {
  return {
    from: optionalDate(options.fromDate ?? process.env.DRIFT_FROM),
    to: optionalDate(options.toDate ?? process.env.DRIFT_TO)
  }
}

function driftLookbackDays(options: DriftRunOptions): number {
  if (options.lookbackDays !== undefined) return assertLookbackDays(options.lookbackDays)

  const envLookbackDays = optionalDate(process.env.DRIFT_LOOKBACK_DAYS)
  if (envLookbackDays === undefined) return DEFAULT_DRIFT_LOOKBACK_DAYS

  return assertLookbackDays(Number(envLookbackDays))
}

function driftRepairChunkDays(options: DriftRunOptions): number {
  if (options.repairChunkDays !== undefined) {
    return assertPositiveInteger(options.repairChunkDays, 'repairChunkDays')
  }

  const envRepairChunkDays = optionalDate(process.env.DRIFT_REPAIR_CHUNK_DAYS)
  if (envRepairChunkDays === undefined) return DEFAULT_DRIFT_REPAIR_CHUNK_DAYS

  return assertPositiveInteger(Number(envRepairChunkDays), 'DRIFT_REPAIR_CHUNK_DAYS')
}

function driftDates(request: DriftDateRequest, yesterday: string, lookbackDays: number): string[] {
  if (request.from || request.to) {
    if (!request.from || !request.to) {
      throw new Error('DRIFT_FROM and DRIFT_TO must be set together')
    }

    assertDriftDate(request.from, 'DRIFT_FROM')
    assertDriftDate(request.to, 'DRIFT_TO')
    assertDateRangeOrder(request.from, request.to, 'DRIFT_FROM', 'DRIFT_TO')
    assertNotFutureDriftDate(request.to, yesterday, 'DRIFT_TO')
    return dateRange(request.from, request.to)
  }

  if (lookbackDays <= 0) return []

  return dateRange(addDays(yesterday, -(lookbackDays - 1)), yesterday)
}

function tokenForAccount(accountConfig: ShiplogCollectAccountConfig): string {
  const envName = accountConfig.tokenEnv || readOnlyTokenEnvName(accountConfig.provider)
  const token = process.env[envName]
  if (!token) throw new Error(`Missing ${envName}`)
  return token
}

function readOnlyTokenEnvName(provider: string): string {
  if (provider === 'github') return 'GH_RO_CLASSIC_TOKEN'
  return `${provider.toUpperCase()}_RO_CLASSIC_TOKEN`
}

function assertLookbackDays(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`DRIFT_LOOKBACK_DAYS must be a non-negative integer; got ${value}`)
  }

  return value
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}`)
  }

  return value
}

function optionalDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function assertDriftDate(driftDate: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(driftDate)) {
    throw new Error(`${label} must use YYYY-MM-DD format; got ${driftDate}`)
  }

  const parsed = new Date(`${driftDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== driftDate) {
    throw new Error(`${label} must be a valid calendar date; got ${driftDate}`)
  }
}

function assertDateRangeOrder(from: string, to: string, fromLabel: string, toLabel: string): void {
  if (from > to) {
    throw new Error(`${fromLabel} must be on or before ${toLabel}; got ${from} to ${to}`)
  }
}

function assertNotFutureDriftDate(driftDate: string, yesterday: string, label: string): void {
  if (driftDate > yesterday) {
    throw new Error(`${label} must be ${yesterday} or earlier; got ${driftDate}`)
  }
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d)
  }
  return out
}

function dateSpanDays(start: string, end: string): number {
  return (
    Math.floor(
      (new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) /
        (24 * 60 * 60 * 1000)
    ) + 1
  )
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function dateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10)
}

if (import.meta.main) {
  run()
    .catch((err: unknown) => {
      logger.error(err)
      process.exitCode = 1
    })
    .finally(async () => {
      await db.close()
    })
}
