import type { Provider } from '../domain/enums.ts'

export interface IdentityConfig {
  provider: Provider
  login: string
  tokenEnv: string
  organizationTokens: OrganizationTokenConfig[]
  ignoreOrganizations: string[]
  ignoreRepositories: string[]
}

export interface OrganizationTokenConfig {
  organization: string
  tokenEnv: string
}

export interface PublishTargetConfig {
  provider: Provider
  repositoryFullName: string
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
