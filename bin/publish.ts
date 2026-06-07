import fs from 'node:fs'
import path from 'node:path'
import * as config from '../lib/config.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubRepositoryById } from '../lib/providers/github/identity.ts'
import { publishGitHubFile, type GitHubPublishFileResult } from '../lib/providers/github/publish.ts'
import type { ShiplogConfig, ShiplogPublishTargetConfig } from '../lib/types/index.ts'
import { render } from './render.ts'

export interface PublishOptions {
  configPath?: string
  config?: ShiplogConfig
  content?: string
  inputPath?: string
  message?: string
  summaryPath?: string | null
  targetIndex?: number
  fetch?: Fetcher
}

interface PublishPreview {
  content: string
  result: GitHubPublishFileResult
  status: string
}

export async function publish(options: PublishOptions = {}): Promise<GitHubPublishFileResult[]> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  const explicitContent = explicitPublishContent(options)
  const message = options.message ?? 'chore: update rendered readme'
  const results: GitHubPublishFileResult[] = []
  const previews: PublishPreview[] = []

  for (const target of publishTargets(shiplogConfig, options.targetIndex)) {
    const content =
      explicitContent ??
      (await render({
        config: shiplogConfig,
        target,
        fetch: options.fetch
      }))
    const result = await publishTarget(target, content, message, options.fetch)
    const status = result.skipped
      ? `unchanged (${result.sha ?? 'unknown sha'})`
      : `updated (${result.commitSha ?? result.sha ?? 'unknown sha'})`
    logger.info(
      `[publish] ${target.provider}/${result.repositoryFullName}@${target.branch}:${target.path} ${status}`
    )
    results.push(result)
    previews.push({ content, result, status })
  }

  writePublishSummary(previews, options.summaryPath ?? process.env.GITHUB_STEP_SUMMARY ?? null)
  return results
}

function publishTargets(
  shiplogConfig: ShiplogConfig,
  targetIndex: number | undefined
): ShiplogPublishTargetConfig[] {
  if (targetIndex === undefined) return shiplogConfig.publish.targets

  assertTargetIndex(targetIndex)
  const target = shiplogConfig.publish.targets[targetIndex]
  if (!target) throw new Error(`publish target index ${targetIndex} is out of range`)
  return [target]
}

function assertTargetIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`publish target index must be a non-negative integer`)
  }
}

function explicitPublishContent(options: PublishOptions): string | null {
  if (options.content !== undefined) return options.content
  if (!options.inputPath) return null
  return fs.readFileSync(path.resolve(process.cwd(), options.inputPath), 'utf8')
}

function writePublishSummary(previews: PublishPreview[], summaryPath: string | null): void {
  if (!summaryPath || previews.length === 0) return

  fs.appendFileSync(
    summaryPath,
    [
      '## shiplog rendered README previews',
      '',
      ...previews.map((preview) => previewSummary(preview))
    ].join('\n')
  )
}

function previewSummary(preview: PublishPreview): string {
  const label = `${preview.result.repositoryFullName}@${preview.result.branch}:${preview.result.path}`
  const fence = markdownFenceFor(preview.content)

  return [
    `<details>`,
    `<summary>${escapeHtml(label)} - ${escapeHtml(preview.status)}</summary>`,
    '',
    `${fence}markdown`,
    preview.content.trimEnd(),
    fence,
    '',
    `</details>`,
    ''
  ].join('\n')
}

function markdownFenceFor(markdown: string): string {
  const longestRun = Math.max(
    0,
    ...Array.from(markdown.matchAll(/`+/g), (match) => match[0].length)
  )
  return '`'.repeat(Math.max(3, longestRun + 1))
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

async function publishTarget(
  target: ShiplogPublishTargetConfig,
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

function parseCliArgs(args: string[]): Pick<PublishOptions, 'configPath' | 'targetIndex'> {
  const options: Pick<PublishOptions, 'configPath' | 'targetIndex'> = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--config') {
      options.configPath = requireValue(args, i, arg)
      i += 1
      continue
    }
    if (arg === '--target-index') {
      options.targetIndex = parseTargetIndex(requireValue(args, i, arg))
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

function parseTargetIndex(value: string): number {
  const targetIndex = Number(value)
  assertTargetIndex(targetIndex)
  return targetIndex
}

if (import.meta.main) {
  try {
    const options = parseCliArgs(Bun.argv.slice(2))
    publish(options).catch((err: unknown) => {
      logger.error(err)
      process.exitCode = 1
    })
  } catch (err) {
    logger.error(err)
    process.exitCode = 1
  }
}
