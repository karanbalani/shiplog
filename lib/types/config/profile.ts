import type { Provider } from '../domain/enums.ts'

export interface IdentityConfig {
  provider: Provider
  externalId: string
  loginHint: string
  tokenEnv: string
  organizationTokens: OrganizationTokenConfig[]
  ignoreOrganizations: IgnoredOrganizationConfig[]
  ignoreRepositories: IgnoredRepositoryConfig[]
}

export interface OrganizationTokenConfig {
  externalId: string
  loginHint: string
  tokenEnv: string
}

export interface IgnoredOrganizationConfig {
  externalId: string
  loginHint: string
}

export interface IgnoredRepositoryConfig {
  externalId: string
  nameHint: string
}

export interface PublishTargetConfig {
  provider: Provider
  repositoryId: string
  repositoryHint: string
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
