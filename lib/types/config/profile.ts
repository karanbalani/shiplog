import type { Provider } from '../domain/enums.ts'

export interface IdentityConfig {
  provider: Provider
  login: string
  readmeHost?: boolean
  trackedOrganizations?: string[]
  ignoreRepositories?: string[]
}

export interface RenderKnobs {
  topLanguagesCount: number
  topPublicProjectsCount: number
  lastYearWindowDays: number
}

export interface ProfileConfig {
  displayName?: string
  identities: IdentityConfig[]
  featuredProject?: {
    label: string
    github?: string
    website?: string
    description?: string
  } | null
  render: RenderKnobs
}
