import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import * as config from '../lib/config.ts'
import type { Fetcher } from '../lib/http.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubRepositoryById } from '../lib/providers/github/identity.ts'
import type { ShiplogConfig, ShiplogPublishTargetConfig } from '../lib/types/index.ts'

const CONFIG_BASE64_ENV = 'SHIPLOG_CONFIG_BASE64'
const TOKEN_SECRETS_JSON_ENV = 'SHIPLOG_TOKEN_SECRETS_JSON'

export interface PublishTargetMatrixEntry {
  target_index: number
  provider: string
  owner: string
}

export interface BuildPublishTargetMatrixOptions {
  configBase64?: string
  tokenSecretsJson?: string
  fetch?: Fetcher
}

export async function buildPublishTargetMatrix(
  options: BuildPublishTargetMatrixOptions = {}
): Promise<PublishTargetMatrixEntry[]> {
  const shiplogConfig = loadConfigFromBase64(options.configBase64 ?? process.env[CONFIG_BASE64_ENV])
  const secrets = loadTokenSecretsJson(
    options.tokenSecretsJson ?? process.env[TOKEN_SECRETS_JSON_ENV]
  )

  return Promise.all(
    shiplogConfig.publish.targets.map((target, index) =>
      matrixEntryForTarget(target, index, secrets, options.fetch)
    )
  )
}

function loadConfigFromBase64(encoded: string | undefined): ShiplogConfig {
  if (!encoded) throw new Error(`Missing ${CONFIG_BASE64_ENV}`)
  return config.validate(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown)
}

function loadTokenSecretsJson(json: string | undefined): Record<string, string> {
  if (!json) throw new Error(`Missing ${TOKEN_SECRETS_JSON_ENV}`)
  const parsed = JSON.parse(json) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${TOKEN_SECRETS_JSON_ENV} must be a JSON object`)
  }

  const secrets: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') secrets[name] = value
  }
  return secrets
}

async function matrixEntryForTarget(
  target: ShiplogPublishTargetConfig,
  index: number,
  secrets: Record<string, string>,
  fetch?: Fetcher
): Promise<PublishTargetMatrixEntry> {
  if (target.provider !== 'github') {
    throw new Error(`unsupported publish target provider in v1: ${target.provider}`)
  }

  const token = secrets[target.tokenEnv]
  if (!token) throw new Error(`Missing token secrets for: ${target.tokenEnv}`)

  const repository = await fetchGitHubRepositoryById(
    graphQLClient({ token, fetch }),
    target.repositoryId
  )
  const [owner] = repository.nameWithOwner.split('/')
  if (!owner) throw new Error(`invalid GitHub repository full name: ${repository.nameWithOwner}`)

  return {
    target_index: index,
    provider: target.provider,
    owner
  }
}

if (import.meta.main) {
  buildPublishTargetMatrix()
    .then((matrix) => {
      const outputPath = process.env.GITHUB_OUTPUT
      if (!outputPath) throw new Error('GITHUB_OUTPUT is not set')
      fs.appendFileSync(outputPath, `target_matrix=${JSON.stringify(matrix)}\n`)
    })
    .catch((error: unknown) => {
      console.error(error)
      process.exitCode = 1
    })
}
