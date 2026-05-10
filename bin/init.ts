import path from 'node:path'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient, type GraphQLClient } from '../lib/providers/github/graphql.ts'
import * as queries from '../lib/providers/github/queries.ts'
import type { GitHubUserCore } from '../lib/providers/github/types.ts'
import type {
  AccountRow,
  IdentityConfig,
  ProfileConfig,
  UserRow,
  VendorIdentity,
  VendorModule
} from '../lib/types/index.ts'
import * as upserts from '../lib/upserts.ts'
import * as dates from '../lib/utils/dates.ts'

export interface InitRunOptions {
  configPath?: string
  profileConfig?: ProfileConfig
  fetch?: Fetcher
  now?: Date
}

interface GitHubAccountProfile {
  externalLogin: string
  externalId: string
  externalUrl: string
  externalCreatedAt: string
}

export async function run(options: InitRunOptions = {}): Promise<void> {
  const profileConfig =
    options.profileConfig ??
    config.load(options.configPath ?? path.resolve(process.cwd(), 'profile_config.json'))
  const user = await ensureUser(profileConfig.displayName ?? null)
  const firstSeenOn = dates.yesterdayUTC(options.now)
  let didBackfill = false

  for (const identityConfig of profileConfig.identities) {
    const token = tokenForIdentity(identityConfig)
    const accountProfile = await fetchAccountProfile(identityConfig, token, options.fetch)
    const account = await upserts.upsertAccount({
      user_id: user.id,
      provider: identityConfig.provider,
      external_login: accountProfile.externalLogin,
      external_id: accountProfile.externalId,
      external_url: accountProfile.externalUrl,
      external_created_at: accountProfile.externalCreatedAt,
      first_seen_on: firstSeenOn
    })

    if (account.backfill_completed_at) {
      logger.info(`[init] ${identityConfig.provider}/${account.external_login}: already backfilled`)
      continue
    }

    logger.info(`[init] ${identityConfig.provider}/${account.external_login}: backfilling`)
    const vendor = await importVendorBackfill(identityConfig.provider)
    await vendor.run({
      identity: vendorIdentity(account),
      token,
      fetch: options.fetch
    })
    await upserts.markBackfillComplete(account.id)
    didBackfill = true
  }

  if (didBackfill) {
    logger.info('[init] backfill complete')
  }
}

export async function ensureUser(displayName: string | null): Promise<UserRow> {
  const existing = await db.query<UserRow>('SELECT * FROM users ORDER BY id LIMIT 1')
  if (existing.rows[0]) return existing.rows[0]

  return upserts.upsertUser({ display_name: displayName })
}

export async function fetchAccountProfile(
  identityConfig: IdentityConfig,
  token: string,
  fetch?: Fetcher
): Promise<GitHubAccountProfile> {
  if (identityConfig.provider !== 'github') {
    throw new Error(`unsupported provider in v1: ${identityConfig.provider}`)
  }

  const graphQL = graphQLClient({ token, fetch })
  return fetchGitHubAccountProfile(graphQL, identityConfig.login)
}

async function fetchGitHubAccountProfile(
  graphQL: GraphQLClient,
  login: string
): Promise<GitHubAccountProfile> {
  const data = await graphQL<{ user: GitHubUserCore | null }>(queries.VIEWER_AND_USER, { login })
  if (!data.user) throw new Error(`GitHub user not found: ${login}`)

  return {
    externalLogin: data.user.login,
    externalId: data.user.id,
    externalUrl: data.user.url,
    externalCreatedAt: data.user.createdAt
  }
}

async function importVendorBackfill(provider: string): Promise<VendorModule> {
  if (provider !== 'github') throw new Error(`unsupported provider in v1: ${provider}`)
  return (await import('./backfill_github.ts')) as VendorModule
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
