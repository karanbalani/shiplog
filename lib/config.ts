import Ajv, { type ErrorObject, type Schema } from 'ajv'
import fs from 'node:fs'
import shiplogConfigSchema from '../schemas/shiplog.config.schema.json'
import type { RenderKnobs, ShiplogConfig } from './types/index.ts'

export const CONFIG_FILE = 'shiplog.config.json'
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

export function load(filePath = CONFIG_FILE): ShiplogConfig {
  const raw = fs.readFileSync(filePath, 'utf8')
  return validate(JSON.parse(raw) as unknown)
}

export function validate(value: unknown): ShiplogConfig {
  const normalized = cloneJson(value)

  if (validateShiplogConfig(normalized)) {
    return stripSchemaField(normalized)
  }

  throw new Error(formatConfigErrors(validateShiplogConfig.errors ?? []))
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as unknown
}

function stripSchemaField<T extends { $schema?: unknown }>(config: T): T {
  delete config.$schema
  return config
}

function formatConfigErrors(errors: ErrorObject[]): string {
  const messages = errors.map(formatConfigError)
  return `${CONFIG_FILE} is invalid: ${messages.join('; ')}`
}

function formatConfigError(error: ErrorObject): string {
  if (error.instancePath === '/collect/accounts' && error.keyword === 'minItems') {
    return 'must define at least one collect account'
  }

  if (error.instancePath === '/publish/targets' && error.keyword === 'minItems') {
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
