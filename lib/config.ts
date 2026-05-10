import Ajv, { type ErrorObject, type Schema } from 'ajv'
import fs from 'node:fs'
import profileConfigSchema from '../schemas/profile_config.schema.json'
import type { ProfileConfig, RenderKnobs } from './types/index.ts'

export const DEFAULT_RENDER: RenderKnobs = {
  topLanguagesCount: 7,
  topPublicProjectsCount: 6,
  lastYearWindowDays: 365
}

const ajv = new Ajv({
  allErrors: true,
  useDefaults: true
})

const validateProfileConfig = ajv.compile<ProfileConfig>(profileConfigSchema as Schema)

export function load(filePath = 'profile_config.json'): ProfileConfig {
  const raw = fs.readFileSync(filePath, 'utf8')
  return validate(JSON.parse(raw) as unknown)
}

export function validate(value: unknown): ProfileConfig {
  const normalized = cloneJson(value)

  if (validateProfileConfig(normalized)) {
    return stripSchemaField(normalized)
  }

  throw new Error(formatConfigErrors(validateProfileConfig.errors ?? []))
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as unknown
}

function stripSchemaField(config: ProfileConfig & { $schema?: unknown }): ProfileConfig {
  delete config.$schema
  return config
}

function formatConfigErrors(errors: ErrorObject[]): string {
  const messages = errors.map(formatConfigError)
  return `profile_config.json is invalid: ${messages.join('; ')}`
}

function formatConfigError(error: ErrorObject): string {
  if (error.instancePath === '/identities' && error.keyword === 'minItems') {
    return 'must define at least one identity'
  }

  if (error.instancePath === '/publishTargets' && error.keyword === 'minItems') {
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
