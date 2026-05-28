import type { Provider } from '../domain/enums.ts'

export interface RenderKnobs {
  topLanguagesCount: number
  topPublicProjectsCount: number
  lastYearWindowDays: number
}

export interface ShiplogConfig {
  $schema?: string
  version: 1
  profile: ShiplogProfileConfig
  collect: ShiplogCollectConfig
  publish: ShiplogPublishConfig
}

export interface ShiplogProfileConfig {
  displayName?: string
}

export interface ShiplogCollectConfig {
  lookbackDays: number
  accounts: ShiplogCollectAccountConfig[]
}

export interface ShiplogCollectAccountConfig {
  provider: Provider
  accountId: string
  tokenEnv: string
  organizationPatTokens: ShiplogOrganizationPatTokenConfig[]
  ignore: ShiplogIgnoreConfig
}

export interface ShiplogOrganizationPatTokenConfig {
  organizationId: string
  tokenEnv: string
}

export interface ShiplogIgnoreConfig {
  organizations: string[]
  repositories: string[]
}

export interface ShiplogPublishConfig {
  targets: ShiplogPublishTargetConfig[]
}

export interface ShiplogPublishTargetConfig {
  provider: Provider
  repositoryId: string
  branch: string
  path: string
  tokenEnv: string
}
