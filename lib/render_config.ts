import Ajv, { type ErrorObject, type Schema } from 'ajv'
import fs from 'node:fs'
import renderConfigSchema from '../schemas/render.config.schema.json'
import type { TargetRenderConfig } from './types/index.ts'

export const DEFAULT_TARGET_RENDER_CONFIG_PATH = '.shiplog/render.json'

const ajv = new Ajv({
  allErrors: true,
  useDefaults: true
})

const validateTargetRenderConfig = ajv.compile<TargetRenderConfig>(renderConfigSchema as Schema)

export function load(filePath = DEFAULT_TARGET_RENDER_CONFIG_PATH): TargetRenderConfig {
  const raw = fs.readFileSync(filePath, 'utf8')
  return validate(JSON.parse(raw) as unknown)
}

export function validate(value: unknown): TargetRenderConfig {
  const normalized = cloneJson(value)

  if (validateTargetRenderConfig(normalized)) {
    return stripSchemaField(normalized)
  }

  throw new Error(formatRenderConfigErrors(validateTargetRenderConfig.errors ?? []))
}

function cloneJson(value: unknown): unknown {
  if (value === undefined) return undefined
  return JSON.parse(JSON.stringify(value)) as unknown
}

function stripSchemaField<T extends { $schema?: unknown }>(config: T): T {
  delete config.$schema
  return config
}

function formatRenderConfigErrors(errors: ErrorObject[]): string {
  const messages = errors.map(formatRenderConfigError)
  return `${DEFAULT_TARGET_RENDER_CONFIG_PATH} is invalid: ${messages.join('; ')}`
}

function formatRenderConfigError(error: ErrorObject): string {
  if (error.instancePath === '/markdown' && error.keyword === 'minItems') {
    return 'must define at least one markdown block'
  }

  if (error.keyword === 'additionalProperties') {
    const property = String(error.params.additionalProperty)
    return `${jsonPath(error.instancePath)} must not include unknown property ${property}`
  }

  return `${jsonPath(error.instancePath)} ${error.message ?? 'is invalid'}`
}

function jsonPath(instancePath: string): string {
  if (!instancePath) return 'render config'

  const path = instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.')

  return path || 'render config'
}
