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

export type BackfillMode = 'fast' | 'deep'

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
  backfillMode?: BackfillMode
  repositoryLimit?: number
  maxRuntimeMs?: number
  repoBudgetMs?: number
  fetch?: Fetcher
}

export interface BackfillResult {
  complete: boolean
  repositoriesDiscovered: number
  repositoriesProcessed: number
  repositoriesDeferred: number
  errorEventIds?: number[]
}

export interface VendorModule {
  run(args: CollectArgs | BackfillArgs): Promise<void | BackfillResult>
}
