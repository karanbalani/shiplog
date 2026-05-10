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
  const collectDate = options.date ?? process.env.COLLECT_DATE ?? dates.yesterdayUTC(options.now)

  for (const identityConfig of profileConfig.identities) {
    const token = tokenForIdentity(identityConfig)
    const account = await findAccount(identityConfig)
    const vendor = await importVendorCollector(identityConfig.provider)

    logger.info(`[collect] ${identityConfig.provider}/${account.external_login}: ${collectDate}`)
    await vendor.run({
      identity: vendorIdentity(account),
      token,
      date: collectDate,
      fetch: options.fetch
    })
  }
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
  if (provider === 'github') return 'GITHUB_RO_CLASSIC_TOKEN'
  return `${provider.toUpperCase()}_RO_CLASSIC_TOKEN`
}

function vendorIdentity(account: AccountRow): VendorIdentity {
  return {
    accountId: account.id,
    externalLogin: account.external_login,
    externalId: account.external_id
  }
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
