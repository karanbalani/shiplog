export interface VendorIdentity {
  accountId: number
  externalLogin: string
  externalId: string
}

export interface CollectArgs {
  identity: VendorIdentity
  token: string
  date: string
  fetch?: typeof fetch
}

export interface BackfillArgs {
  identity: VendorIdentity
  token: string
  fetch?: typeof fetch
}

export interface VendorModule {
  run(args: CollectArgs | BackfillArgs): Promise<void>
}
