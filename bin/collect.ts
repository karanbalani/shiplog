import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import {
  fetchGitHubAccountProfileById,
  fetchGitHubOrganizationById
} from '../lib/providers/github/identity.ts'
import * as queries from '../lib/providers/github/queries.ts'
import type { GitHubContributionsCollection } from '../lib/providers/github/types.ts'
import type {
  AccountRow,
  DailyUserSummaryRow,
  ShiplogCollectAccountConfig,
  ShiplogConfig,
  VendorOrganizationToken,
  VendorIdentity,
  VendorModule
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export interface CollectRunOptions {
  configPath?: string
  config?: ShiplogConfig
  date?: string
  fromDate?: string
  toDate?: string
  driftFromDate?: string
  driftToDate?: string
  fetch?: Fetcher
  now?: Date
}

export interface CollectDateRequest {
  date?: string
  from?: string
  to?: string
}

export interface DriftCheckRequest {
  from?: string
  to?: string
}

type GitHubContributionTotals = Pick<
  GitHubContributionsCollection,
  | 'totalCommitContributions'
  | 'totalIssueContributions'
  | 'totalPullRequestContributions'
  | 'totalPullRequestReviewContributions'
  | 'restrictedContributionsCount'
>

export async function run(options: CollectRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const dateRequest = collectDateRequest(options)
  const driftRequest = driftCheckRequest(options)
  const yesterday = dates.yesterdayUTC(options.now)
  const lookbackDays = shiplogConfig.collect.lookbackDays ?? config.DEFAULT_COLLECT_LOOKBACK_DAYS
  assertCompatibleExplicitRequests(dateRequest, driftRequest)

  for (const accountConfig of shiplogConfig.collect.accounts) {
    const account = await findAccount(accountConfig)
    const ignoreOrganizationIds = accountConfig.ignore.organizations
    const ignoreRepositoryIds = accountConfig.ignore.repositories

    if (
      !hasExplicitCollectRequest(dateRequest) &&
      !hasDriftCheckRequest(driftRequest) &&
      !account.last_successful_collect_on
    ) {
      const token = tokenForAccount(accountConfig)
      const organizationPatTokens = await organizationPatTokensForAccount(
        accountConfig,
        options.fetch
      )
      const refreshedAccount = await refreshAccount(accountConfig, account, token, options.fetch)
      const identity = vendorIdentity(refreshedAccount)

      logger.info(
        `[collect] ${accountConfig.provider}/${refreshedAccount.external_login}: no checkpoint found; collecting complete history through ${yesterday}`
      )
      const historicalVendor = await importVendorHistoricalCollector(accountConfig.provider)
      await historicalVendor.run({
        identity,
        token,
        organizationTokens: organizationPatTokens,
        ignoreOrganizationIds,
        ignoreRepositoryIds,
        throughDate: yesterday,
        fetch: options.fetch
      })
      await upserts.markCollectSuccess(refreshedAccount.id, yesterday)
      continue
    }

    const automaticCollectDates = hasDriftCheckRequest(driftRequest)
      ? null
      : collectDatesForAccount(account, yesterday, dateRequest, lookbackDays)

    if (automaticCollectDates?.length === 0) {
      logger.info(
        `[collect] ${accountConfig.provider}/${account.external_login}: already collected through ${yesterday}`
      )
      continue
    }

    const token = tokenForAccount(accountConfig)
    const refreshedAccount = await refreshAccount(accountConfig, account, token, options.fetch)
    const identity = vendorIdentity(refreshedAccount)
    const collectDates = hasDriftCheckRequest(driftRequest)
      ? await driftedCollectDates(
          graphQLClient({ token, fetch: options.fetch }),
          refreshedAccount,
          identity.externalLogin,
          driftRequest,
          yesterday
        )
      : automaticCollectDates!

    if (collectDates.length === 0) {
      logger.info(
        `[collect] ${accountConfig.provider}/${refreshedAccount.external_login}: no drift detected`
      )
      continue
    }

    const organizationPatTokens = await organizationPatTokensForAccount(
      accountConfig,
      options.fetch
    )
    const vendor = await importVendorCollector(accountConfig.provider)

    logger.info(
      `[collect] ${accountConfig.provider}/${refreshedAccount.external_login}: ${collectDates.length} day(s) (${collectDates[0]} to ${collectDates.at(-1)})`
    )

    for (const [index, collectDate] of collectDates.entries()) {
      logger.info(
        `[collect] ${accountConfig.provider}/${refreshedAccount.external_login}: ${index + 1}/${collectDates.length} ${collectDate}`
      )
      await vendor.run({
        identity,
        token,
        organizationTokens: organizationPatTokens,
        ignoreOrganizationIds,
        ignoreRepositoryIds,
        date: collectDate,
        fetch: options.fetch
      })
      if (!hasExplicitCollectRequest(dateRequest) && !hasDriftCheckRequest(driftRequest)) {
        await upserts.markCollectSuccess(refreshedAccount.id, collectDate)
      }
    }
  }
}

export function collectDatesForAccount(
  account: AccountRow,
  yesterday: string,
  request: CollectDateRequest = {},
  lookbackDays = config.DEFAULT_COLLECT_LOOKBACK_DAYS
): string[] {
  if (request.date) {
    if (request.from || request.to) {
      throw new Error('COLLECT_DATE cannot be combined with COLLECT_FROM or COLLECT_TO')
    }
    assertCollectDate(request.date, 'COLLECT_DATE')
    assertNotFutureCollectDate(request.date, yesterday, 'COLLECT_DATE')
    return [request.date]
  }

  if (request.from || request.to) {
    if (!request.from || !request.to) {
      throw new Error('COLLECT_FROM and COLLECT_TO must be set together')
    }
    assertCollectDate(request.from, 'COLLECT_FROM')
    assertCollectDate(request.to, 'COLLECT_TO')
    assertDateRangeOrder(request.from, request.to, 'COLLECT_FROM', 'COLLECT_TO')
    assertNotFutureCollectDate(request.to, yesterday, 'COLLECT_TO')
    return dateRange(request.from, request.to)
  }

  const lastSuccessfulCollectOn = account.last_successful_collect_on
    ? dateOnly(account.last_successful_collect_on)
    : null
  const missingStart = lastSuccessfulCollectOn ? addDays(lastSuccessfulCollectOn, 1) : yesterday
  const missingDates = missingStart <= yesterday ? dateRange(missingStart, yesterday) : []
  const lookbackDates = lookbackDatesForAccount(lastSuccessfulCollectOn, yesterday, lookbackDays)

  return dedupeDates([...missingDates, ...lookbackDates])
}

async function driftedCollectDates(
  graphQL: GraphQLClient,
  account: AccountRow,
  login: string,
  request: DriftCheckRequest,
  yesterday: string
): Promise<string[]> {
  const driftDates = driftCheckDates(request, yesterday)
  const storedByDate = await dailyUserSummariesForRange(
    account.id,
    driftDates[0]!,
    driftDates.at(-1)!
  )
  const out: string[] = []

  logger.info(`[collect] github/${login}: drift check ${driftDates.length} day(s)`)

  for (const date of driftDates) {
    const stored = storedByDate.get(date)
    if (!stored) {
      logger.warn(`[collect] github/${login}: missing summary for ${date}; re-collecting`)
      out.push(date)
      continue
    }

    const current = await fetchContributionsCollectionForDate(graphQL, login, date)

    if (dailySummaryDrifted(stored, current)) {
      logger.warn(`[collect] github/${login}: drift detected for ${date}; re-collecting`)
      out.push(date)
    }
  }

  return out
}

function driftCheckDates(request: DriftCheckRequest, yesterday: string): string[] {
  if (!request.from || !request.to) {
    throw new Error('DRIFT_CHECK_FROM and DRIFT_CHECK_TO must be set together')
  }
  assertCollectDate(request.from, 'DRIFT_CHECK_FROM')
  assertCollectDate(request.to, 'DRIFT_CHECK_TO')
  assertDateRangeOrder(request.from, request.to, 'DRIFT_CHECK_FROM', 'DRIFT_CHECK_TO')
  assertNotFutureCollectDate(request.to, yesterday, 'DRIFT_CHECK_TO')

  return dateRange(request.from, request.to)
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

async function fetchContributionsCollectionForDate(
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

  if (!data.user) throw new Error(`collect: GitHub user not found: ${login}`)
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

export async function findAccount(accountConfig: ShiplogCollectAccountConfig): Promise<AccountRow> {
  const result = await db.query<AccountRow>(
    `SELECT *
     FROM accounts
     WHERE provider = $1 AND external_id = $2
     LIMIT 1`,
    [accountConfig.provider, accountConfig.accountId]
  )

  if (!result.rows[0]) {
    throw new Error(
      `No account row for ${accountConfig.provider}/${accountConfig.accountId}; run bun run init first`
    )
  }

  return result.rows[0]
}

async function refreshAccount(
  accountConfig: ShiplogCollectAccountConfig,
  account: AccountRow,
  token: string,
  fetch?: Fetcher
): Promise<AccountRow> {
  if (accountConfig.provider !== 'github') {
    throw new Error(`unsupported provider in v1: ${accountConfig.provider}`)
  }

  const profile = await fetchGitHubAccountProfileById(
    graphQLClient({ token, fetch }),
    account.external_id
  )
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

async function importVendorCollector(provider: string): Promise<VendorModule> {
  if (provider !== 'github') throw new Error(`unsupported provider in v1: ${provider}`)
  return (await import('./collect_github.ts')) as VendorModule
}

async function importVendorHistoricalCollector(provider: string): Promise<VendorModule> {
  if (provider !== 'github') throw new Error(`unsupported provider in v1: ${provider}`)
  return (await import('./backfill_github.ts')) as VendorModule
}

function tokenForAccount(accountConfig: ShiplogCollectAccountConfig): string {
  const envName = accountConfig.tokenEnv || readOnlyTokenEnvName(accountConfig.provider)
  const token = process.env[envName]
  if (!token) throw new Error(`Missing ${envName}`)
  return token
}

async function organizationPatTokensForAccount(
  accountConfig: ShiplogCollectAccountConfig,
  fetch?: Fetcher
): Promise<VendorOrganizationToken[]> {
  if (accountConfig.provider !== 'github') {
    throw new Error(`unsupported provider in v1: ${accountConfig.provider}`)
  }

  const tokens: VendorOrganizationToken[] = []
  for (const orgToken of accountConfig.organizationPatTokens) {
    const token = process.env[orgToken.tokenEnv]
    if (!token) throw new Error(`Missing ${orgToken.tokenEnv}`)

    const organization = await fetchGitHubOrganizationById(
      graphQLClient({ token, fetch }),
      orgToken.organizationId
    )
    tokens.push({
      externalId: organization.externalId,
      externalLogin: organization.externalLogin,
      tokenEnv: orgToken.tokenEnv,
      token
    })
  }

  return tokens
}

function readOnlyTokenEnvName(provider: string): string {
  if (provider === 'github') return 'GH_RO_CLASSIC_TOKEN'
  return `${provider.toUpperCase()}_RO_CLASSIC_TOKEN`
}

function vendorIdentity(account: AccountRow): VendorIdentity {
  return {
    accountId: account.id,
    externalLogin: account.external_login,
    externalId: account.external_id
  }
}

function collectDateRequest(options: CollectRunOptions): CollectDateRequest {
  return {
    date: optionalDate(options.date ?? process.env.COLLECT_DATE),
    from: optionalDate(options.fromDate ?? process.env.COLLECT_FROM),
    to: optionalDate(options.toDate ?? process.env.COLLECT_TO)
  }
}

function driftCheckRequest(options: CollectRunOptions): DriftCheckRequest {
  return {
    from: optionalDate(options.driftFromDate ?? process.env.DRIFT_CHECK_FROM),
    to: optionalDate(options.driftToDate ?? process.env.DRIFT_CHECK_TO)
  }
}

function optionalDate(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function hasExplicitCollectRequest(request: CollectDateRequest): boolean {
  return Boolean(request.date || request.from || request.to)
}

function hasDriftCheckRequest(request: DriftCheckRequest): boolean {
  return Boolean(request.from || request.to)
}

function assertCompatibleExplicitRequests(
  collectRequest: CollectDateRequest,
  driftRequest: DriftCheckRequest
): void {
  if (hasExplicitCollectRequest(collectRequest) && hasDriftCheckRequest(driftRequest)) {
    throw new Error(
      'drift checks cannot be combined with COLLECT_DATE, COLLECT_FROM, or COLLECT_TO'
    )
  }
}

function assertCollectDate(collectDate: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(collectDate)) {
    throw new Error(`${label} must use YYYY-MM-DD format; got ${collectDate}`)
  }

  const parsed = new Date(`${collectDate}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== collectDate) {
    throw new Error(`${label} must be a valid calendar date; got ${collectDate}`)
  }
}

function assertDateRangeOrder(from: string, to: string, fromLabel: string, toLabel: string): void {
  if (from > to) {
    throw new Error(`${fromLabel} must be on or before ${toLabel}; got ${from} to ${to}`)
  }
}

function assertNotFutureCollectDate(collectDate: string, yesterday: string, label: string): void {
  if (collectDate > yesterday) {
    throw new Error(`${label} must be ${yesterday} or earlier; got ${collectDate}`)
  }
}

function lookbackDatesForAccount(
  lastSuccessfulCollectOn: string | null,
  yesterday: string,
  lookbackDays: number
): string[] {
  if (!lastSuccessfulCollectOn || lookbackDays <= 0) return []

  const lookbackStart = addDays(yesterday, -(lookbackDays - 1))
  const lookbackEnd = lastSuccessfulCollectOn < yesterday ? lastSuccessfulCollectOn : yesterday
  if (lookbackStart > lookbackEnd) return []

  return dateRange(lookbackStart, lookbackEnd)
}

function dedupeDates(dates: string[]): string[] {
  return [...new Set(dates)]
}

function dateRange(start: string, end: string): string[] {
  const out: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(d)
  }
  return out
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
