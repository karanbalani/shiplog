import type { Fetcher } from '../../http.ts'

export interface VendorIdentity {
  accountId: number
  externalLogin: string
  externalId: string
}

export interface VendorOrganizationToken {
  organization: string
  token: string
  tokenEnv: string
}

export interface CollectArgs {
  identity: VendorIdentity
  token: string
  organizationTokens?: VendorOrganizationToken[]
  date: string
  fetch?: Fetcher
}

export interface BackfillArgs {
  identity: VendorIdentity
  token: string
  organizationTokens?: VendorOrganizationToken[]
  fetch?: Fetcher
}

export interface VendorModule {
  run(args: CollectArgs | BackfillArgs): Promise<void>
}
