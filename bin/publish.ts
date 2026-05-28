import fs from 'node:fs'
import path from 'node:path'
import * as config from '../lib/config.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubRepositoryById } from '../lib/providers/github/identity.ts'
import { publishGitHubFile, type GitHubPublishFileResult } from '../lib/providers/github/publish.ts'
import type { ProfileConfig, PublishTargetConfig } from '../lib/types/index.ts'

const DEFAULT_INPUT_PATH = 'rendered.md'

export interface PublishOptions {
  configPath?: string
  profileConfig?: ProfileConfig
  content?: string
  inputPath?: string
  message?: string
  fetch?: Fetcher
}

export async function publish(options: PublishOptions = {}): Promise<GitHubPublishFileResult[]> {
  const profileConfig = options.profileConfig ?? config.load(options.configPath)
  const content =
    options.content ??
    fs.readFileSync(options.inputPath ?? path.resolve(process.cwd(), DEFAULT_INPUT_PATH), 'utf8')
  const message = options.message ?? 'chore: update rendered readme'
  const results: GitHubPublishFileResult[] = []

  for (const target of profileConfig.publishTargets) {
    const result = await publishTarget(target, content, message, options.fetch)
    logger.info(
      `[publish] ${target.provider}/${result.repositoryFullName}@${target.branch}:${target.path} updated (${result.commitSha ?? result.sha ?? 'unknown sha'})`
    )
    results.push(result)
  }

  return results
}

async function publishTarget(
  target: PublishTargetConfig,
  content: string,
  message: string,
  fetch?: Fetcher
): Promise<GitHubPublishFileResult> {
  const token = process.env[target.tokenEnv]
  if (!token) throw new Error(`Missing ${target.tokenEnv}`)

  if (target.provider !== 'github') {
    throw new Error(`unsupported publish target provider in v1: ${target.provider}`)
  }

  const repository = await fetchGitHubRepositoryById(
    graphQLClient({ token, fetch }),
    target.repositoryId
  )
  return publishGitHubFile({
    token,
    repositoryFullName: repository.nameWithOwner,
    branch: target.branch,
    path: target.path,
    content,
    message,
    fetch
  })
}

if (import.meta.main) {
  publish().catch((err: unknown) => {
    logger.error(err)
    process.exitCode = 1
  })
}
