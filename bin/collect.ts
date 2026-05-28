import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import {
  fetchGitHubAccountProfileById,
  fetchGitHubOrganizationById
} from '../lib/providers/github/identity.ts'
import type {
  AccountRow,
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
  fetch?: Fetcher
  now?: Date
}

export async function run(options: CollectRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const requestedDate = options.date ?? process.env.COLLECT_DATE
  const yesterday = dates.yesterdayUTC(options.now)
  const lookbackDays = shiplogConfig.collect.lookbackDays ?? config.DEFAULT_COLLECT_LOOKBACK_DAYS

  for (const accountConfig of shiplogConfig.collect.accounts) {
    const account = await findAccount(accountConfig)
    const ignoreOrganizationIds = accountConfig.ignore.organizations
    const ignoreRepositoryIds = accountConfig.ignore.repositories

    if (!requestedDate && !account.last_successful_collect_on) {
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

    const vendor = await importVendorCollector(accountConfig.provider)
    const collectDates = collectDatesForAccount(account, yesterday, requestedDate, lookbackDays)

    if (collectDates.length === 0) {
      logger.info(
        `[collect] ${accountConfig.provider}/${account.external_login}: already collected through ${yesterday}`
      )
      continue
    }

    const token = tokenForAccount(accountConfig)
    const organizationPatTokens = await organizationPatTokensForAccount(
      accountConfig,
      options.fetch
    )
    const refreshedAccount = await refreshAccount(accountConfig, account, token, options.fetch)
    const identity = vendorIdentity(refreshedAccount)

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
      if (!requestedDate) {
        await upserts.markCollectSuccess(refreshedAccount.id, collectDate)
      }
    }
  }
}

export function collectDatesForAccount(
  account: AccountRow,
  yesterday: string,
  requestedDate?: string,
  lookbackDays = config.DEFAULT_COLLECT_LOOKBACK_DAYS
): string[] {
  if (requestedDate) {
    assertNotFutureCollectDate(requestedDate, yesterday)
    return [requestedDate]
  }

  const lastSuccessfulCollectOn = account.last_successful_collect_on
    ? dateOnly(account.last_successful_collect_on)
    : null
  const missingStart = lastSuccessfulCollectOn ? addDays(lastSuccessfulCollectOn, 1) : yesterday
  const missingDates = missingStart <= yesterday ? dateRange(missingStart, yesterday) : []
  const lookbackDates = lookbackDatesForAccount(lastSuccessfulCollectOn, yesterday, lookbackDays)

  return dedupeDates([...missingDates, ...lookbackDates])
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

function assertNotFutureCollectDate(collectDate: string, yesterday: string): void {
  if (collectDate > yesterday) {
    throw new Error(`COLLECT_DATE must be ${yesterday} or earlier; got ${collectDate}`)
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
