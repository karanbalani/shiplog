import type { Fetcher } from '../../http.ts'

export interface VendorIdentity {
  accountId: number
  externalLogin: string
  externalId: string
}

export interface VendorOrganizationToken {
  externalId: string
  externalLogin: string
  token: string
  tokenEnv: string
}

export interface CollectArgs {
  identity: VendorIdentity
  token: string
  organizationTokens?: VendorOrganizationToken[]
  ignoreOrganizationIds?: string[]
  ignoreRepositoryIds?: string[]
  date: string
  fetch?: Fetcher
}

export interface BackfillArgs {
  identity: VendorIdentity
  token: string
  organizationTokens?: VendorOrganizationToken[]
  ignoreOrganizationIds?: string[]
  ignoreRepositoryIds?: string[]
  throughDate?: string
  repositoryLimit?: number
  fetch?: Fetcher
}

export interface BackfillResult {
  complete: boolean
  repositoriesDiscovered: number
  repositoriesProcessed: number
  repositoriesDeferred: number
}

export interface VendorModule {
  run(args: CollectArgs | BackfillArgs): Promise<void | BackfillResult>
}
