import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubAccountProfileById } from '../lib/providers/github/identity.ts'
import type { ShiplogCollectAccountConfig, ShiplogConfig, UserRow } from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export interface InitRunOptions {
  configPath?: string
  config?: ShiplogConfig
  fetch?: Fetcher
  now?: Date
}

export async function run(options: InitRunOptions = {}): Promise<void> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const user = await ensureUser(shiplogConfig.profile.displayName ?? null)
  const firstSeenOn = dates.yesterdayUTC(options.now)

  for (const accountConfig of shiplogConfig.collect.accounts) {
    const token = tokenForAccount(accountConfig)
    const accountProfile = await fetchAccountProfile(accountConfig, token, options.fetch)
    const account = await upserts.upsertAccount({
      user_id: user.id,
      provider: accountConfig.provider,
      external_login: accountProfile.externalLogin,
      external_id: accountProfile.externalId,
      external_url: accountProfile.externalUrl,
      external_created_at: accountProfile.externalCreatedAt,
      first_seen_on: firstSeenOn
    })
    logger.info(`[init] ${accountConfig.provider}/${account.external_login}: account ready`)
  }
}

export async function ensureUser(displayName: string | null): Promise<UserRow> {
  const existing = await db.query<UserRow>('SELECT * FROM users ORDER BY id LIMIT 1')
  if (existing.rows[0]) return existing.rows[0]

  return upserts.upsertUser({ display_name: displayName })
}

export async function fetchAccountProfile(
  accountConfig: ShiplogCollectAccountConfig,
  token: string,
  fetch?: Fetcher
): ReturnType<typeof fetchGitHubAccountProfileById> {
  if (accountConfig.provider !== 'github') {
    throw new Error(`unsupported provider in v1: ${accountConfig.provider}`)
  }

  const graphQL = graphQLClient({ token, fetch })
  return fetchGitHubAccountProfileById(graphQL, accountConfig.accountId)
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
