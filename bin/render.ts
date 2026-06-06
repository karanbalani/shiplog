import fs from 'node:fs'
import path from 'node:path'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import type { Fetcher } from '../lib/http.ts'
import * as logger from '../lib/logger.ts'
import { graphQLClient } from '../lib/providers/github/graphql.ts'
import { fetchGitHubRepositoryById } from '../lib/providers/github/identity.ts'
import { fetchGitHubFileContent } from '../lib/providers/github/publish.ts'
import * as renderConfig from '../lib/render_config.ts'
import type {
  ShiplogConfig,
  ShiplogPublishTargetConfig,
  TargetRenderBlock,
  TargetRenderConfig,
  TargetRenderTableColumn
} from '../lib/types/index.ts'

const DEFAULT_OUTPUT_PATH = 'rendered.md'
const SHIPLOG_FOOTER_TEXT =
  'Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).'
const SHIPLOG_FOOTER = `<sub>${SHIPLOG_FOOTER_TEXT}</sub>`
const INLINE_BADGE_STYLE = 'flat-square'
const LANGUAGE_COLORS: Record<string, string> = {
  Astro: 'ff5d01',
  CSS: '563d7c',
  Dart: '00b4ab',
  Dockerfile: '384d54',
  Go: '00add8',
  HTML: 'e34c26',
  Java: 'b07219',
  JavaScript: 'f1e05a',
  Kotlin: 'a97bff',
  Python: '3572a5',
  Rust: 'dea584',
  Shell: '89e051',
  TypeScript: '3178c6',
  Vue: '41b883',
  Default: '555555'
}

export interface RenderOptions {
  configPath?: string
  config?: ShiplogConfig
  targetRenderConfig?: TargetRenderConfig
  targetRenderConfigPath?: string
  target?: ShiplogPublishTargetConfig
  template?: string
  templatePath?: string
  outputPath?: string
  fetch?: Fetcher
  now?: Date
}

interface AccountLinkRow {
  provider: string
  external_login: string
  external_url: string | null
  external_created_at: Date | string | null
}

interface ActivityTotalsRow {
  commits: number | string | null
  lines_added: number | string | null
  lines_deleted: number | string | null
  pull_requests_opened: number | string | null
  pull_requests_merged: number | string | null
  pull_request_reviews: number | string | null
  issues_opened: number | string | null
  issues_closed: number | string | null
}

interface OrganizationActivityRow {
  organization: string
  commits: number | string | null
  pull_requests: number | string | null
  reviews: number | string | null
  issues: number | string | null
  lines_added: number | string | null
  lines_deleted: number | string | null
}

interface RepositoryActivityRow {
  full_name: string | null
  web_url: string | null
  commits: number | string | null
  pull_requests: number | string | null
  reviews: number | string | null
  lines_added: number | string | null
  lines_deleted: number | string | null
}

interface LanguageActivityRow {
  language: string
  commits: number | string | null
}

interface AccountFilter {
  sql: string
  params: unknown[]
}

interface RenderQueryRow {
  [column: string]: unknown
}

export async function render(options: RenderOptions = {}): Promise<string> {
  const shiplogConfig = options.config ?? config.load(options.configPath)
  if (!options.template && !options.templatePath) {
    const targetRenderConfig = await loadTargetRenderConfig(shiplogConfig, options)
    if (targetRenderConfig) {
      return renderTargetConfig(shiplogConfig, targetRenderConfig)
    }
  }

  const template =
    options.template ??
    fs.readFileSync(options.templatePath ?? path.resolve(process.cwd(), 'TEMPLATE.md'), 'utf8')
  const now = options.now ?? new Date()

  const context: Record<string, string> = {
    ACCOUNT_AGE: await accountAge(shiplogConfig, now),
    ACCOUNT_LINKS: await accountLinks(shiplogConfig, now),
    DISPLAY_NAME: displayName(shiplogConfig),
    LANGUAGE_ROWS: await languageRows(shiplogConfig, now),
    LAST_YEAR_WINDOW_DAYS: String(config.DEFAULT_RENDER.lastYearWindowDays),
    ORGANIZATION_ROWS: await organizationRows(shiplogConfig, now),
    PROFILE_STATS_ROWS: await profileStatsRows(shiplogConfig, now),
    STATS_ROWS: await statsRows(shiplogConfig, now),
    TOP_REPOSITORIES: await topRepositories(shiplogConfig, now)
  }

  let output = template
  for (const [key, value] of Object.entries(context)) {
    output = output.replaceAll(`{{ ${key} }}`, value)
  }

  return appendShiplogFooter(output)
}

export async function run(options: RenderOptions = {}): Promise<void> {
  const output = await render(options)
  const outputPath = options.outputPath ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_PATH)
  fs.writeFileSync(outputPath, output)
  logger.info(`[render] wrote ${outputPath}`)
}

async function loadTargetRenderConfig(
  shiplogConfig: ShiplogConfig,
  options: RenderOptions
): Promise<TargetRenderConfig | null> {
  if (options.targetRenderConfig) return options.targetRenderConfig
  if (options.targetRenderConfigPath) return renderConfig.load(options.targetRenderConfigPath)

  const targetConfig = await fetchTargetRenderConfig(shiplogConfig, options.target, options.fetch)
  if (targetConfig) return targetConfig

  const fallbackPath = path.resolve(
    import.meta.dir,
    '..',
    renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH
  )
  if (!fs.existsSync(fallbackPath)) return null

  logger.info(`[render] using fallback ${renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH}`)
  return renderConfig.load(fallbackPath)
}

async function fetchTargetRenderConfig(
  shiplogConfig: ShiplogConfig,
  targetOverride?: ShiplogPublishTargetConfig,
  fetch?: Fetcher
): Promise<TargetRenderConfig | null> {
  const target = targetOverride ?? shiplogConfig.publish.targets[0]
  if (!target) return null
  if (target.provider !== 'github')
    throw new Error(`unsupported publish target provider in v1: ${target.provider}`)

  const token = process.env[target.tokenEnv]
  if (!token) return null

  const repository = await fetchGitHubRepositoryById(
    graphQLClient({ token, fetch }),
    target.repositoryId
  )
  const content = await fetchGitHubFileContent({
    token,
    repositoryFullName: repository.nameWithOwner,
    branch: target.branch,
    path: renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH,
    fetch
  })

  if (!content) {
    const fallbackPath = path.resolve(
      import.meta.dir,
      '..',
      renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH
    )
    if (!fs.existsSync(fallbackPath)) return null

    logger.info(`[render] using fallback ${renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH}`)
    return renderConfig.load(fallbackPath)
  }

  logger.info(
    `[render] loaded ${renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH} from ${target.provider}/${repository.nameWithOwner}@${target.branch}`
  )
  try {
    return renderConfig.validate(JSON.parse(content) as unknown)
  } catch (error) {
    throw new Error(
      `failed to load ${renderConfig.DEFAULT_TARGET_RENDER_CONFIG_PATH} from ${target.provider}/${repository.nameWithOwner}@${target.branch}: ${errorMessage(error)}`,
      { cause: error }
    )
  }
}

async function renderTargetConfig(
  shiplogConfig: ShiplogConfig,
  targetRenderConfig: TargetRenderConfig
): Promise<string> {
  const context: Record<string, unknown> = {
    profile: {
      displayName: displayName(shiplogConfig)
    },
    ...(await runTargetRenderQueries(targetRenderConfig))
  }

  return appendShiplogFooter(`${renderTargetBlocks(targetRenderConfig.markdown, context)}\n`)
}

function appendShiplogFooter(markdown: string): string {
  const trimmed = markdown.trimEnd()
  if (trimmed.includes(SHIPLOG_FOOTER_TEXT)) return `${trimmed}\n`
  return `${trimmed}\n\n${SHIPLOG_FOOTER}\n`
}

async function runTargetRenderQueries(
  targetRenderConfig: TargetRenderConfig
): Promise<Record<string, unknown>> {
  const queries = Object.entries(targetRenderConfig.queries ?? {})
  if (queries.length === 0) return {}

  const results: Record<string, unknown> = {}

  for (const [name, query] of queries) {
    try {
      assertSelectQuery(query.sql, name)
      const result = await db.query<RenderQueryRow>(query.sql)
      results[name] = query.mode === 'one' ? (result.rows[0] ?? {}) : result.rows
    } catch (error) {
      throw new Error(`render query ${name} failed: ${errorMessage(error)}`, { cause: error })
    }
  }

  return results
}

function renderTargetBlocks(blocks: TargetRenderBlock[], context: Record<string, unknown>): string {
  return blocks
    .map((block, index) => {
      try {
        return renderTargetBlock(block, context)
      } catch (error) {
        throw new Error(
          `render markdown block ${index + 1} (${block.type}) failed: ${errorMessage(error)}`,
          { cause: error }
        )
      }
    })
    .join('\n\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertSelectQuery(sql: string, name: string): void {
  const stripped = stripLeadingSqlComments(sql).trim()
  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    throw new Error(`render query ${name} must start with SELECT or WITH`)
  }

  if (hasStatementSeparator(stripped.replace(/;+[\s\n\r]*$/, ''))) {
    throw new Error(`render query ${name} must contain only one SELECT statement`)
  }

  const writableKeyword = firstWritableSqlKeyword(stripped)
  if (writableKeyword) {
    throw new Error(`render query ${name} must not include ${writableKeyword}`)
  }
}

function stripLeadingSqlComments(sql: string): string {
  let value = sql.trimStart()

  while (value.startsWith('--') || value.startsWith('/*')) {
    if (value.startsWith('--')) {
      const index = value.indexOf('\n')
      value = index === -1 ? '' : value.slice(index + 1).trimStart()
      continue
    }

    const index = value.indexOf('*/')
    value = index === -1 ? '' : value.slice(index + 2).trimStart()
  }

  return value
}

function hasStatementSeparator(sql: string): boolean {
  return scanSql(sql, {
    onNormalChar: (char) => char === ';'
  })
}

function firstWritableSqlKeyword(sql: string): string | null {
  const match = sqlNormalText(sql).match(
    /\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|CALL|DO|COPY|VACUUM)\b/i
  )
  return match?.[1]?.toUpperCase() ?? null
}

function sqlNormalText(sql: string): string {
  let text = ''
  scanSql(sql, {
    onNormalChar: (char) => {
      text += char
      return false
    }
  })
  return text
}

function scanSql(
  sql: string,
  options: {
    onNormalChar?: (char: string, index: number) => boolean | number
    onCopiedText?: (text: string) => void
  }
): boolean {
  let state: 'normal' | 'singleQuote' | 'doubleQuote' | 'lineComment' | 'blockComment' = 'normal'

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]!
    const next = sql[index + 1]

    if (state === 'singleQuote') {
      options.onCopiedText?.(char)
      if (char === "'" && next === "'") {
        options.onCopiedText?.(next)
        index += 1
        continue
      }
      if (char === "'") state = 'normal'
      continue
    }

    if (state === 'doubleQuote') {
      options.onCopiedText?.(char)
      if (char === '"') state = 'normal'
      continue
    }

    if (state === 'lineComment') {
      options.onCopiedText?.(char)
      if (char === '\n') state = 'normal'
      continue
    }

    if (state === 'blockComment') {
      options.onCopiedText?.(char)
      if (char === '*' && next === '/') {
        options.onCopiedText?.(next)
        index += 1
        state = 'normal'
      }
      continue
    }

    if (char === "'") {
      options.onCopiedText?.(char)
      state = 'singleQuote'
      continue
    }

    if (char === '"') {
      options.onCopiedText?.(char)
      state = 'doubleQuote'
      continue
    }

    if (char === '-' && next === '-') {
      options.onCopiedText?.(char)
      options.onCopiedText?.(next)
      index += 1
      state = 'lineComment'
      continue
    }

    if (char === '/' && next === '*') {
      options.onCopiedText?.(char)
      options.onCopiedText?.(next)
      index += 1
      state = 'blockComment'
      continue
    }

    const result = options.onNormalChar?.(char, index)
    if (result === true) return true
    if (typeof result === 'number') {
      index += result - 1
      continue
    }
    if (result === false) continue

    options.onCopiedText?.(char)
  }

  return false
}

function renderTargetBlock(block: TargetRenderBlock, context: Record<string, unknown>): string {
  if (block.type === 'heading') {
    return `${'#'.repeat(block.level)} ${interpolate(block.text, context)}`
  }

  if (block.type === 'paragraph') {
    return interpolate(block.text, context)
  }

  if (block.type === 'rawMarkdown') {
    return interpolate(block.content, context)
  }

  if (block.type === 'divider') {
    return '---'
  }

  if (block.type === 'table') {
    return renderTableBlock(block.query, block.columns, context)
  }

  return renderListBlock(block.query, block.value, context)
}

function renderTableBlock(
  queryName: string,
  columns: TargetRenderTableColumn[],
  context: Record<string, unknown>
): string {
  const rows = rowsForQuery(queryName, context)
  const header = `| ${columns.map((column) => escapeTableCell(interpolate(column.label, context))).join(' | ')} |`
  const separator = `| ${columns.map(() => '---').join(' | ')} |`
  const body = rows.map((row) => {
    const rowContext = { ...context, ...row, row }
    return `| ${columns.map((column) => escapeTableCell(interpolate(column.value, rowContext))).join(' | ')} |`
  })

  return [header, separator, ...body].join('\n')
}

function renderListBlock(
  queryName: string,
  valueTemplate: string,
  context: Record<string, unknown>
): string {
  return rowsForQuery(queryName, context)
    .map((row) => `- ${interpolate(valueTemplate, { ...context, ...row, row })}`)
    .join('\n')
}

function rowsForQuery(queryName: string, context: Record<string, unknown>): RenderQueryRow[] {
  const value = context[queryName]
  if (!Array.isArray(value)) {
    throw new Error(`render block query ${queryName} must use mode "many"`)
  }

  return value as RenderQueryRow[]
}

function interpolate(template: string, context: Record<string, unknown>): string {
  return template.replaceAll(/{{\s*([A-Za-z_][A-Za-z0-9_.]*)\s*}}/g, (_, path: string) =>
    formatTemplateValue(resolvePath(context, path))
  )
}

function resolvePath(context: Record<string, unknown>, valuePath: string): unknown {
  let value: unknown = context
  for (const part of valuePath.split('.')) {
    if (!value || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }

  return value
}

function formatTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function escapeTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\s*\n\s*/g, '<br>')
}

async function profileStatsRows(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const allTime = await activityTotals(shiplogConfig)
  const recent = await activityTotals(
    shiplogConfig,
    dateDaysAgo(now, config.DEFAULT_RENDER.lastYearWindowDays)
  )
  const languages = await languageActivityRows(shiplogConfig, now)
  const allTimeRows = richMetricRows(allTime)
  const recentRows = richMetricRows(recent)
  const rowCount = Math.max(allTimeRows.length, recentRows.length, languages.length)
  const rows: string[] = []

  for (let index = 0; index < rowCount; index += 1) {
    const language = languages[index]
    rows.push(
      `| ${allTimeRows[index] ?? ''} | ${recentRows[index] ?? ''} | ${
        language ? languageBadge(language) : ''
      } |`
    )
  }

  return rows.join('\n')
}

async function accountAge(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const filter = accountFilter(shiplogConfig, 'accounts', 1)
  const result = await db.query<{ external_created_at: Date | string | null }>(
    `SELECT MIN(external_created_at) AS external_created_at
     FROM accounts
     WHERE ${filter.sql}`,
    filter.params
  )

  const createdAt = result.rows[0]?.external_created_at
  if (!createdAt) return 'unknown'
  return formatNumber(completedYearsSince(createdAt, now))
}

async function accountLinks(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const filter = accountFilter(shiplogConfig, 'accounts', 1)
  const result = await db.query<AccountLinkRow>(
    `SELECT provider, external_login, external_url, external_created_at
     FROM accounts
     WHERE ${filter.sql}
     ORDER BY provider, external_login`,
    filter.params
  )

  if (result.rows.length === 0) return '- no tracked accounts yet'

  return result.rows
    .map((row) => {
      const label = `${row.provider}/${row.external_login}`
      const linkedLabel = row.external_url ? `[${label}](${row.external_url})` : label
      return `- ${linkedLabel} ${accountAgeBadge(row.external_created_at, now)}`
    })
    .join('\n')
}

async function statsRows(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const allTime = await activityTotals(shiplogConfig)
  const recent = await activityTotals(
    shiplogConfig,
    dateDaysAgo(now, config.DEFAULT_RENDER.lastYearWindowDays)
  )

  return [
    metricRow('Commits', allTime.commits, recent.commits),
    metricRow('Lines added', allTime.lines_added, recent.lines_added),
    metricRow('Lines deleted', allTime.lines_deleted, recent.lines_deleted),
    metricRow('Pull requests opened', allTime.pull_requests_opened, recent.pull_requests_opened),
    metricRow('Pull requests merged', allTime.pull_requests_merged, recent.pull_requests_merged),
    metricRow('Pull request reviews', allTime.pull_request_reviews, recent.pull_request_reviews),
    metricRow('Issues opened', allTime.issues_opened, recent.issues_opened),
    metricRow('Issues closed', allTime.issues_closed, recent.issues_closed)
  ].join('\n')
}

async function organizationRows(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const filter = accountFilter(shiplogConfig, 'a', 2)
  const result = await db.query<OrganizationActivityRow>(
    `SELECT
       COALESCE(o.display_name, o.external_login) AS organization,
       COALESCE(SUM(d.commits), 0)::int AS commits,
       COALESCE(SUM(d.prs_opened), 0)::int AS pull_requests,
       COALESCE(SUM(d.pr_reviews_total), 0)::int AS reviews,
       COALESCE(SUM(d.issues_opened), 0)::int AS issues,
       COALESCE(SUM(d.lines_added), 0)::int AS lines_added,
       COALESCE(SUM(d.lines_deleted), 0)::int AS lines_deleted
     FROM daily_repository_activity d
     JOIN accounts a ON a.id = d.account_id
     JOIN repositories r ON r.id = d.repository_id
     JOIN organizations o ON o.id = r.organization_id
     WHERE d.activity_on >= $1::date
       AND ${filter.sql}
     GROUP BY o.id, o.display_name, o.external_login
     ORDER BY commits DESC, organization ASC
     LIMIT 10`,
    [dateDaysAgo(now, config.DEFAULT_RENDER.lastYearWindowDays), ...filter.params]
  )

  if (result.rows.length === 0) return '| - | - | - |'

  return result.rows
    .map((row) => `| **${row.organization}** | ${activitySummary(row)} | ${lineBadges(row)} |`)
    .join('\n')
}

async function languageRows(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const rows = await languageActivityRows(shiplogConfig, now)

  if (rows.length === 0) return '| - | 0 |'

  return rows.map((row) => `| ${row.language} | ${formatNumber(row.commits)} |`).join('\n')
}

async function languageActivityRows(
  shiplogConfig: ShiplogConfig,
  now: Date
): Promise<LanguageActivityRow[]> {
  const filter = accountFilter(shiplogConfig, 'a', 3)
  const result = await db.query<LanguageActivityRow>(
    `SELECT
       r.primary_language AS language,
       COALESCE(SUM(d.commits), 0)::int AS commits
     FROM daily_repository_activity d
     JOIN accounts a ON a.id = d.account_id
     JOIN repositories r ON r.id = d.repository_id
     WHERE d.activity_on >= $1::date
       AND r.primary_language IS NOT NULL
       AND ${filter.sql}
     GROUP BY r.primary_language
     ORDER BY commits DESC, language ASC
     LIMIT $2`,
    [
      dateDaysAgo(now, config.DEFAULT_RENDER.lastYearWindowDays),
      config.DEFAULT_RENDER.topLanguagesCount,
      ...filter.params
    ]
  )

  return result.rows
}

async function topRepositories(shiplogConfig: ShiplogConfig, now: Date): Promise<string> {
  const filter = accountFilter(shiplogConfig, 'a', 3)
  const result = await db.query<RepositoryActivityRow>(
    `SELECT
       r.full_name,
       r.web_url,
       COALESCE(SUM(d.commits), 0)::int AS commits,
       COALESCE(SUM(d.prs_opened), 0)::int AS pull_requests,
       COALESCE(SUM(d.pr_reviews_total), 0)::int AS reviews,
       COALESCE(SUM(d.lines_added), 0)::int AS lines_added,
       COALESCE(SUM(d.lines_deleted), 0)::int AS lines_deleted
     FROM daily_repository_activity d
     JOIN accounts a ON a.id = d.account_id
     JOIN repositories r ON r.id = d.repository_id
     WHERE d.activity_on >= $1::date
       AND r.visibility = 'public'
       AND r.redacted = false
       AND ${filter.sql}
     GROUP BY r.id, r.full_name, r.web_url
     ORDER BY commits DESC, pull_requests DESC, reviews DESC, full_name ASC
     LIMIT $2`,
    [
      dateDaysAgo(now, config.DEFAULT_RENDER.lastYearWindowDays),
      config.DEFAULT_RENDER.topPublicProjectsCount,
      ...filter.params
    ]
  )

  if (result.rows.length === 0) {
    return '_(no public activity in the configured window yet)_'
  }

  return result.rows
    .map((row) => {
      const label = row.full_name ?? 'unknown repository'
      const linkedLabel = row.web_url ? `[**${label}**](${row.web_url})` : `**${label}**`
      return `- ${linkedLabel} - ${activitySummary(row)} ${lineBadges(row)}`
    })
    .join('\n')
}

async function activityTotals(
  shiplogConfig: ShiplogConfig,
  fromDate?: string
): Promise<ActivityTotalsRow> {
  const filter = accountFilter(shiplogConfig, 'a', fromDate ? 2 : 1)
  const datePredicate = fromDate ? 'd.activity_on >= $1::date AND' : ''
  const params = fromDate ? [fromDate, ...filter.params] : filter.params

  const result = await db.query<ActivityTotalsRow>(
    `SELECT
       COALESCE(SUM(d.commits), 0)::int AS commits,
       COALESCE(SUM(d.lines_added), 0)::int AS lines_added,
       COALESCE(SUM(d.lines_deleted), 0)::int AS lines_deleted,
       COALESCE(SUM(d.prs_opened), 0)::int AS pull_requests_opened,
       COALESCE(SUM(d.prs_merged), 0)::int AS pull_requests_merged,
       COALESCE(SUM(d.pr_reviews_total), 0)::int AS pull_request_reviews,
       COALESCE(SUM(d.issues_opened), 0)::int AS issues_opened,
       COALESCE(SUM(d.issues_closed), 0)::int AS issues_closed
     FROM daily_repository_activity d
     JOIN accounts a ON a.id = d.account_id
     WHERE ${datePredicate} ${filter.sql}`,
    params
  )

  return (
    result.rows[0] ?? {
      commits: 0,
      lines_added: 0,
      lines_deleted: 0,
      pull_requests_opened: 0,
      pull_requests_merged: 0,
      pull_request_reviews: 0,
      issues_opened: 0,
      issues_closed: 0
    }
  )
}

function accountFilter(
  shiplogConfig: ShiplogConfig,
  tableAlias: string,
  startIndex: number
): AccountFilter {
  const params: unknown[] = []
  const clauses = shiplogConfig.collect.accounts.map((account) => {
    const providerIndex = startIndex + params.length
    const externalIdIndex = providerIndex + 1
    params.push(account.provider, account.accountId)
    return `(${tableAlias}.provider = $${providerIndex} AND ${tableAlias}.external_id = $${externalIdIndex})`
  })

  return { sql: `(${clauses.join(' OR ')})`, params }
}

function displayName(shiplogConfig: ShiplogConfig): string {
  return shiplogConfig.profile.displayName ?? 'shiplog user'
}

function completedYearsSince(value: Date | string, now: Date): number {
  const startedAt = value instanceof Date ? value : new Date(value)
  let years = now.getUTCFullYear() - startedAt.getUTCFullYear()
  const anniversaryThisYear = new Date(
    Date.UTC(now.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate())
  )

  if (now < anniversaryThisYear) years -= 1
  return Math.max(0, years)
}

function accountAgeBadge(value: Date | string | null, now: Date): string {
  if (!value) return '`age: unknown`'
  return `\`age: ${completedYearsSince(value, now)} years\``
}

function dateDaysAgo(now: Date, days: number): string {
  const date = new Date(now)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function metricRow(label: string, allTime: unknown, recent: unknown): string {
  return `| ${label} | ${formatNumber(allTime)} | ${formatNumber(recent)} |`
}

function richMetricRows(row: ActivityTotalsRow): string[] {
  return [
    `🔥 **${formatNumber(row.commits)}** commits`,
    `🟢 **${formatNumber(row.lines_added)}** lines added`,
    `🔴 **${formatNumber(row.lines_deleted)}** lines deleted`,
    `🔀 **${formatNumber(row.pull_requests_opened)}** PRs opened`,
    `✅ **${formatNumber(row.pull_requests_merged)}** PRs merged`,
    `👀 **${formatNumber(row.pull_request_reviews)}** PR reviews`,
    `📋 **${formatNumber(row.issues_opened)}** issues opened`,
    `☑️ **${formatNumber(row.issues_closed)}** issues closed`
  ]
}

function activitySummary(row: OrganizationActivityRow | RepositoryActivityRow): string {
  const issues = 'issues' in row ? ` · 📋 **${formatNumber(row.issues)}** issues` : ''
  return `🔥 **${formatNumber(row.commits)}** commits · 🔀 **${formatNumber(
    row.pull_requests
  )}** PRs · 👀 **${formatNumber(row.reviews)}** reviews${issues}`
}

function languageBadge(row: LanguageActivityRow): string {
  return badge('', `${row.language} ${formatNumber(row.commits)}`, languageColor(row.language))
}

function lineBadges(row: Pick<OrganizationActivityRow, 'lines_added' | 'lines_deleted'>): string {
  return `${badge('', `+${formatNumber(row.lines_added)}`, 'brightgreen')} ${badge(
    '',
    `-${formatNumber(row.lines_deleted)}`,
    'red'
  )}`
}

function badge(label: string, message: string, color: string): string {
  const params = new URLSearchParams({
    style: INLINE_BADGE_STYLE,
    label,
    message,
    color
  })

  return `![${message}](https://img.shields.io/static/v1?${params.toString()})`
}

function languageColor(language: string): string {
  return LANGUAGE_COLORS[language] ?? LANGUAGE_COLORS.Default ?? '555555'
}

function formatNumber(value: unknown): string {
  return Number(value ?? 0).toLocaleString('en-US')
}

if (import.meta.main) {
  run()
    .catch((err: unknown) => {
      logger.error(err)
      process.exitCode = 1
    })
    .finally(async () => {
      await db.close()
    })
}
