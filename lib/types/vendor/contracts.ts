import type { Fetcher } from '../../http.ts'

export interface VendorIdentity {
  accountId: number
  externalLogin: string
  externalId: string
}

export interface CollectArgs {
  identity: VendorIdentity
  token: string
  date: string
  fetch?: Fetcher
}

export interface BackfillArgs {
  identity: VendorIdentity
  token: string
  fetch?: Fetcher
}

export interface VendorModule {
  run(args: CollectArgs | BackfillArgs): Promise<void>
}
