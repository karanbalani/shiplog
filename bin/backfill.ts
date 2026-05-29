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
  BackfillArgs,
  BackfillMode,
  BackfillResult,
  ShiplogCollectAccountConfig,
  ShiplogConfig,
  VendorIdentity,
  VendorModule,
  VendorOrganizationToken
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export interface BackfillRunOptions {
  configPath?: string
  config?: ShiplogConfig
  fetch?: Fetcher
  now?: Date
  backfillMode?: BackfillMode
  repositoryLimit?: number
  maxRuntimeMinutes?: number
  requireComplete?: boolean
}

export async function run(options: BackfillRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const throughDate = dates.yesterdayUTC(options.now)
  const backfillMode = backfillModeOption(options)
  const repositoryLimit = backfillRepositoryLimit(options)
  const maxRuntimeMs = backfillMaxRuntimeMs(options)
  const requireComplete = backfillRequireComplete(options)
  const incompleteRuns: string[] = []

  for (const accountConfig of shiplogConfig.collect.accounts) {
    const account = await findAccount(accountConfig)
    const token = tokenForAccount(accountConfig)
    const organizationTokens = await organizationPatTokensForAccount(accountConfig, options.fetch)
    const refreshedAccount = await refreshAccount(accountConfig, account, token, options.fetch)
    const identity = vendorIdentity(refreshedAccount)
    const vendor = await importVendorHistoricalCollector(accountConfig.provider)

    logger.info(
      `[backfill] ${accountConfig.provider}/${refreshedAccount.external_login}: collecting complete history through ${throughDate}`
    )

    const result = await vendor.run({
      identity,
      token,
      organizationTokens,
      ignoreOrganizationIds: accountConfig.ignore.organizations,
      ignoreRepositoryIds: accountConfig.ignore.repositories,
      throughDate,
      backfillMode,
      repositoryLimit,
      maxRuntimeMs,
      fetch: options.fetch
    } satisfies BackfillArgs)

    if (backfillComplete(result)) {
      await upserts.markCollectSuccess(refreshedAccount.id, throughDate)
    } else {
      const message = `[backfill] ${accountConfig.provider}/${refreshedAccount.external_login}: paused with ${formatRepositoryCount(result.repositoriesDeferred)} remaining; rerun backfill to continue`
      logger.info(message)
      incompleteRuns.push(message)
    }
  }

  if (requireComplete && incompleteRuns.length > 0) {
    throw new Error(incompleteRuns.join('; '))
  }
}

function backfillModeOption(options: BackfillRunOptions): BackfillMode {
  const value = options.backfillMode ?? process.env.BACKFILL_MODE ?? 'fast'
  if (value === 'fast' || value === 'deep') return value
  throw new Error(`BACKFILL_MODE must be fast or deep; got ${value}`)
}

function backfillRepositoryLimit(options: BackfillRunOptions): number | undefined {
  if (options.repositoryLimit !== undefined) {
    return assertPositiveInteger(options.repositoryLimit, 'repositoryLimit')
  }

  const envValue = process.env.BACKFILL_REPOSITORY_LIMIT?.trim()
  if (!envValue) return undefined

  return assertPositiveInteger(Number(envValue), 'BACKFILL_REPOSITORY_LIMIT')
}

function backfillMaxRuntimeMs(options: BackfillRunOptions): number | undefined {
  if (options.maxRuntimeMinutes !== undefined) {
    return minutesToMs(assertPositiveNumber(options.maxRuntimeMinutes, 'maxRuntimeMinutes'))
  }

  const envValue = process.env.BACKFILL_MAX_MINUTES?.trim()
  if (!envValue) return undefined

  return minutesToMs(assertPositiveNumber(Number(envValue), 'BACKFILL_MAX_MINUTES'))
}

function backfillRequireComplete(options: BackfillRunOptions): boolean {
  if (options.requireComplete !== undefined) return options.requireComplete

  const envValue = process.env.BACKFILL_REQUIRE_COMPLETE?.trim().toLowerCase()
  if (!envValue) return false
  if (['1', 'true', 'yes'].includes(envValue)) return true
  if (['0', 'false', 'no'].includes(envValue)) return false
  throw new Error(`BACKFILL_REQUIRE_COMPLETE must be true or false; got ${envValue}`)
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer; got ${value}`)
  }

  return value
}

function assertPositiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number; got ${value}`)
  }

  return value
}

function minutesToMs(minutes: number): number {
  return Math.round(minutes * 60 * 1000)
}

function backfillComplete(
  result: void | BackfillResult
): result is void | (BackfillResult & { complete: true }) {
  return !result || result.complete
}

function formatRepositoryCount(count: number): string {
  return `${count} ${count === 1 ? 'repository' : 'repositories'}`
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
