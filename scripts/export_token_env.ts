import fs from 'node:fs'
import * as config from '../lib/config.ts'
import type { ShiplogConfig } from '../lib/types/index.ts'

export type TokenEnvScope = 'read' | 'publish' | 'all'

const TOKEN_SECRETS_ENV = 'SHIPLOG_TOKEN_SECRETS_BASE64'
const TOKEN_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ExportTokenEnvOptions {
  addMask?: (value: string) => void
  configPath?: string
  encodedTokenSecrets?: string
  githubEnvPath?: string
  scope?: TokenEnvScope
}

export function tokenEnvNames(
  shiplogConfig: ShiplogConfig,
  scope: TokenEnvScope = 'all'
): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (name: string): void => {
    assertTokenEnvName(name)
    if (seen.has(name)) return
    seen.add(name)
    names.push(name)
  }

  if (scope === 'read' || scope === 'all') {
    for (const account of shiplogConfig.collect.accounts) {
      add(account.tokenEnv)
      for (const orgToken of account.organizationPatTokens) add(orgToken.tokenEnv)
    }
  }

  if (scope === 'publish' || scope === 'all') {
    for (const target of shiplogConfig.publish.targets) add(target.tokenEnv)
  }

  return names
}

export function exportTokenEnv(options: ExportTokenEnvOptions = {}): string[] {
  const scope = options.scope ?? 'all'
  const shiplogConfig = config.load(options.configPath)
  const names = tokenEnvNames(shiplogConfig, scope)
  const secrets = decodeTokenSecrets(options.encodedTokenSecrets ?? process.env[TOKEN_SECRETS_ENV])
  const missing = names.filter((name) => !secrets[name])

  if (missing.length > 0) {
    throw new Error(`Missing token secrets for: ${missing.join(', ')}`)
  }

  const githubEnvPath = options.githubEnvPath ?? process.env.GITHUB_ENV
  if (!githubEnvPath) {
    throw new Error('GITHUB_ENV is not set')
  }

  fs.appendFileSync(
    githubEnvPath,
    names
      .map((name) => {
        const value = secrets[name]!
        const line = formatGitHubEnvLine(name, value)
        options.addMask?.(value)
        return line
      })
      .join('')
  )

  return names
}

export function decodeTokenSecrets(encoded: string | undefined): Record<string, string> {
  if (!encoded) throw new Error(`Missing ${TOKEN_SECRETS_ENV}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch (error) {
    throw new Error(`${TOKEN_SECRETS_ENV} must be base64-encoded JSON`, { cause: error })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${TOKEN_SECRETS_ENV} must decode to a JSON object`)
  }

  const secrets: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    assertTokenEnvName(name)
    if (typeof value !== 'string') {
      throw new Error(`${TOKEN_SECRETS_ENV}.${name} must be a string`)
    }
    secrets[name] = value
  }

  return secrets
}

function formatGitHubEnvLine(name: string, value: string): string {
  assertTokenEnvName(name)
  if (/[\r\n]/.test(value)) {
    throw new Error(`${name} must be a single-line token secret`)
  }
  return `${name}=${value}\n`
}

function assertTokenEnvName(name: string): void {
  if (!TOKEN_ENV_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid token env name: ${name}`)
  }
}

function parseCliArgs(args: string[]): Pick<ExportTokenEnvOptions, 'configPath' | 'scope'> {
  const options: Pick<ExportTokenEnvOptions, 'configPath' | 'scope'> = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--config') {
      options.configPath = requireValue(args, i, arg)
      i += 1
      continue
    }
    if (arg === '--scope') {
      options.scope = parseScope(requireValue(args, i, arg))
      i += 1
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return options
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value) throw new Error(`Missing value for ${flag}`)
  return value
}

function parseScope(value: string): TokenEnvScope {
  if (value === 'read' || value === 'publish' || value === 'all') return value
  throw new Error(`Invalid token env scope: ${value}`)
}

if (import.meta.main) {
  try {
    const options = parseCliArgs(Bun.argv.slice(2))
    const exported = exportTokenEnv({
      ...options,
      addMask: (value) => console.log(`::add-mask::${value}`)
    })
    console.error(
      `[tokens] exported ${exported.length} ${options.scope ?? 'all'} token env var(s) from config`
    )
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  }
}
