import path from 'node:path'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import type {
  AccountRow,
  IdentityConfig,
  ProfileConfig,
  VendorIdentity,
  VendorModule
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export interface CollectRunOptions {
  configPath?: string
  profileConfig?: ProfileConfig
  date?: string
  fetch?: Fetcher
  now?: Date
}

export async function run(options: CollectRunOptions = {}): Promise<void> {
  const profileConfig =
    options.profileConfig ??
    config.load(options.configPath ?? path.resolve(process.cwd(), 'profile_config.json'))
  const requestedDate = options.date ?? process.env.COLLECT_DATE
  const yesterday = dates.yesterdayUTC(options.now)

  for (const identityConfig of profileConfig.identities) {
    const token = tokenForIdentity(identityConfig)
    const account = await findAccount(identityConfig)
    const vendor = await importVendorCollector(identityConfig.provider)
    const collectDates = collectDatesForAccount(account, yesterday, requestedDate)

    if (collectDates.length === 0) {
      logger.info(
        `[collect] ${identityConfig.provider}/${account.external_login}: already collected through ${yesterday}`
      )
      continue
    }

    logger.info(
      `[collect] ${identityConfig.provider}/${account.external_login}: ${collectDates.length} day(s) (${collectDates[0]} to ${collectDates.at(-1)})`
    )

    for (const [index, collectDate] of collectDates.entries()) {
      logger.info(
        `[collect] ${identityConfig.provider}/${account.external_login}: ${index + 1}/${collectDates.length} ${collectDate}`
      )
      await vendor.run({
        identity: vendorIdentity(account),
        token,
        date: collectDate,
        fetch: options.fetch
      })
      if (!requestedDate) {
        await upserts.markCollectSuccess(account.id, collectDate)
      }
    }
  }
}

export function collectDatesForAccount(
  account: AccountRow,
  yesterday: string,
  requestedDate?: string
): string[] {
  if (requestedDate) {
    assertNotFutureCollectDate(requestedDate, yesterday)
    return [requestedDate]
  }

  const lastSuccessfulCollectOn = account.last_successful_collect_on
    ? dateOnly(account.last_successful_collect_on)
    : null
  const start = lastSuccessfulCollectOn ? addDays(lastSuccessfulCollectOn, 1) : yesterday
  if (start > yesterday) return []

  return dateRange(start, yesterday)
}

export async function findAccount(identityConfig: IdentityConfig): Promise<AccountRow> {
  const result = await db.query<AccountRow>(
    `SELECT *
     FROM accounts
     WHERE provider = $1 AND external_login = $2
     LIMIT 1`,
    [identityConfig.provider, identityConfig.login]
  )

  if (!result.rows[0]) {
    throw new Error(
      `No account row for ${identityConfig.provider}/${identityConfig.login}; run bun run init first`
    )
  }

  return result.rows[0]
}

async function importVendorCollector(provider: string): Promise<VendorModule> {
  if (provider !== 'github') throw new Error(`unsupported provider in v1: ${provider}`)
  return (await import('./collect_github.ts')) as VendorModule
}

function tokenForIdentity(identityConfig: IdentityConfig): string {
  const envName = readOnlyTokenEnvName(identityConfig.provider)
  const token = process.env[envName]
  if (!token) throw new Error(`Missing ${envName}`)
  return token
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
