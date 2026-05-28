import Ajv, { type ErrorObject, type Schema } from 'ajv'
import fs from 'node:fs'
import legacyProfileConfigSchema from '../schemas/profile_config.schema.json'
import shiplogConfigSchema from '../schemas/shiplog.config.schema.json'
import type { ProfileConfig, RenderKnobs, ShiplogConfig } from './types/index.ts'

export const CONFIG_FILE = 'shiplog.config.json'
export const LEGACY_CONFIG_FILE = 'profile_config.json'
export const DEFAULT_READ_TOKEN_ENV = 'GH_RO_CLASSIC_TOKEN'
export const DEFAULT_PUBLISH_TOKEN_ENV = 'GH_RW_REPO_TOKEN'
export const DEFAULT_PUBLISH_BRANCH = 'main'
export const DEFAULT_PUBLISH_PATH = 'README.md'
export const DEFAULT_RENDER: RenderKnobs = {
  topLanguagesCount: 7,
  topPublicProjectsCount: 6,
  lastYearWindowDays: 365
}

const ajv = new Ajv({
  allErrors: true,
  useDefaults: true
})

const validateShiplogConfig = ajv.compile<ShiplogConfig>(shiplogConfigSchema as Schema)
const validateLegacyProfileConfig = ajv.compile<LegacyProfileConfig>(
  legacyProfileConfigSchema as Schema
)

export function load(filePath = CONFIG_FILE): ProfileConfig {
  const raw = fs.readFileSync(resolveConfigPath(filePath), 'utf8')
  return validate(JSON.parse(raw) as unknown)
}

export function validate(value: unknown): ProfileConfig {
  const normalized = cloneJson(value)

  if (isLegacyConfigShape(normalized)) {
    if (validateLegacyProfileConfig(normalized)) {
      return normalizeLegacyConfig(stripSchemaField(normalized))
    }

    throw new Error(formatConfigErrors(validateLegacyProfileConfig.errors ?? []))
  }

  if (validateShiplogConfig(normalized)) {
    return normalizeShiplogConfig(stripSchemaField(normalized))
  }

  throw new Error(formatConfigErrors(validateShiplogConfig.errors ?? []))
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as unknown
}

function resolveConfigPath(filePath: string): string {
  if (filePath === CONFIG_FILE && !fs.existsSync(filePath) && fs.existsSync(LEGACY_CONFIG_FILE)) {
    return LEGACY_CONFIG_FILE
  }

  return filePath
}

function isLegacyConfigShape(value: unknown): value is LegacyProfileConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return 'identities' in value || 'publishTargets' in value || 'render' in value
}

function stripSchemaField<T extends { $schema?: unknown }>(config: T): Omit<T, '$schema'> {
  delete config.$schema
  return config
}

function normalizeShiplogConfig(config: Omit<ShiplogConfig, '$schema'>): ProfileConfig {
  return {
    displayName: config.profile?.displayName,
    identities: config.collect.accounts.map((account) => ({
      provider: account.provider,
      externalId: account.accountId,
      tokenEnv: account.tokenEnv ?? DEFAULT_READ_TOKEN_ENV,
      organizationTokens: (account.organizationTokens ?? []).map((organizationToken) => ({
        externalId: organizationToken.organizationId,
        tokenEnv: organizationToken.tokenEnv
      })),
      ignoreOrganizations: account.ignore?.organizations ?? [],
      ignoreRepositories: account.ignore?.repositories ?? []
    })),
    publishTargets: config.publish.targets.map((target) => ({
      provider: target.provider,
      repositoryId: target.repositoryId,
      branch: target.branch ?? DEFAULT_PUBLISH_BRANCH,
      path: target.path ?? DEFAULT_PUBLISH_PATH,
      tokenEnv: target.tokenEnv ?? DEFAULT_PUBLISH_TOKEN_ENV
    })),
    render: DEFAULT_RENDER
  }
}

function normalizeLegacyConfig(config: Omit<LegacyProfileConfig, '$schema'>): ProfileConfig {
  return {
    displayName: config.displayName,
    identities: config.identities.map((identity) => ({
      provider: identity.provider,
      externalId: identity.externalId,
      tokenEnv: identity.tokenEnv ?? DEFAULT_READ_TOKEN_ENV,
      organizationTokens: (identity.organizationTokens ?? []).map((organizationToken) => ({
        externalId: organizationToken.externalId,
        tokenEnv: organizationToken.tokenEnv
      })),
      ignoreOrganizations: (identity.ignoreOrganizations ?? []).map(
        (organization) => organization.externalId
      ),
      ignoreRepositories: (identity.ignoreRepositories ?? []).map(
        (repository) => repository.externalId
      )
    })),
    publishTargets: config.publishTargets.map((target) => ({
      provider: target.provider,
      repositoryId: target.repositoryId,
      branch: target.branch,
      path: target.path,
      tokenEnv: target.tokenEnv
    })),
    render: config.render ?? DEFAULT_RENDER
  }
}

function formatConfigErrors(errors: ErrorObject[]): string {
  const messages = errors.map(formatConfigError)
  return `${CONFIG_FILE} is invalid: ${messages.join('; ')}`
}

function formatConfigError(error: ErrorObject): string {
  if (error.instancePath === '/collect/accounts' && error.keyword === 'minItems') {
    return 'must define at least one collect account'
  }

  if (error.instancePath === '/identities' && error.keyword === 'minItems') {
    return 'must define at least one identity'
  }

  if (
    (error.instancePath === '/publish/targets' || error.instancePath === '/publishTargets') &&
    error.keyword === 'minItems'
  ) {
    return 'must define at least one publish target'
  }

  if (error.keyword === 'const' && error.instancePath.endsWith('/provider')) {
    return `${jsonPath(error.instancePath)} must be github in v1`
  }

  if (error.keyword === 'additionalProperties') {
    const property = String(error.params.additionalProperty)
    return `${jsonPath(error.instancePath)} must not include unknown property ${property}`
  }

  return `${jsonPath(error.instancePath)} ${error.message ?? 'is invalid'}`
}

function jsonPath(instancePath: string): string {
  if (!instancePath) return 'config'

  const path = instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.')

  return path || 'config'
}

interface LegacyProfileConfig {
  $schema?: string
  displayName?: string
  identities: LegacyIdentityConfig[]
  publishTargets: LegacyPublishTargetConfig[]
  render?: RenderKnobs
}

interface LegacyIdentityConfig {
  provider: ProfileConfig['identities'][number]['provider']
  externalId: string
  loginHint: string
  tokenEnv?: string
  organizationTokens?: LegacyOrganizationTokenConfig[]
  ignoreOrganizations?: LegacyIgnoredOrganizationConfig[]
  ignoreRepositories?: LegacyIgnoredRepositoryConfig[]
}

interface LegacyOrganizationTokenConfig {
  externalId: string
  loginHint: string
  tokenEnv: string
}

interface LegacyIgnoredOrganizationConfig {
  externalId: string
  loginHint: string
}

interface LegacyIgnoredRepositoryConfig {
  externalId: string
  nameHint: string
}

interface LegacyPublishTargetConfig {
  provider: ProfileConfig['publishTargets'][number]['provider']
  repositoryId: string
  repositoryHint: string
  branch: string
  path: string
  tokenEnv: string
}
