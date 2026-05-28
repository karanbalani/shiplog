import type { Provider } from '../domain/enums.ts'

export interface IdentityConfig {
  provider: Provider
  externalId: string
  tokenEnv: string
  organizationTokens: OrganizationTokenConfig[]
  ignoreOrganizations: string[]
  ignoreRepositories: string[]
}

export interface OrganizationTokenConfig {
  externalId: string
  tokenEnv: string
}

export interface PublishTargetConfig {
  provider: Provider
  repositoryId: string
  branch: string
  path: string
  tokenEnv: string
}

export interface RenderKnobs {
  topLanguagesCount: number
  topPublicProjectsCount: number
  lastYearWindowDays: number
}

export interface ProfileConfig {
  displayName?: string
  identities: IdentityConfig[]
  publishTargets: PublishTargetConfig[]
  render: RenderKnobs
}

export interface ShiplogConfig {
  $schema?: string
  version: 1
  profile?: ShiplogProfileConfig
  collect: ShiplogCollectConfig
  publish: ShiplogPublishConfig
}

export interface ShiplogProfileConfig {
  displayName?: string
}

export interface ShiplogCollectConfig {
  accounts: ShiplogCollectAccountConfig[]
}

export interface ShiplogCollectAccountConfig {
  provider: Provider
  accountId: string
  tokenEnv?: string
  organizationTokens?: ShiplogOrganizationTokenConfig[]
  ignore?: ShiplogIgnoreConfig
}

export interface ShiplogOrganizationTokenConfig {
  organizationId: string
  tokenEnv: string
}

export interface ShiplogIgnoreConfig {
  organizations?: string[]
  repositories?: string[]
}

export interface ShiplogPublishConfig {
  targets: ShiplogPublishTargetConfig[]
}

export interface ShiplogPublishTargetConfig {
  provider: Provider
  repositoryId: string
  branch?: string
  path?: string
  tokenEnv?: string
}
