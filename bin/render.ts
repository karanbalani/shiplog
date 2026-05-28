import fs from 'node:fs'
import path from 'node:path'
import * as config from '../lib/config.ts'
import * as db from '../lib/db.ts'
import * as logger from '../lib/logger.ts'
import type { ProfileConfig } from '../lib/types/index.ts'

const DEFAULT_OUTPUT_PATH = 'rendered.md'
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
  profileConfig?: ProfileConfig
  template?: string
  templatePath?: string
  outputPath?: string
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

export async function render(options: RenderOptions = {}): Promise<string> {
  const profileConfig = options.profileConfig ?? config.load(options.configPath)
  const template =
    options.template ??
    fs.readFileSync(options.templatePath ?? path.resolve(process.cwd(), 'TEMPLATE.md'), 'utf8')
  const now = options.now ?? new Date()

  const context: Record<string, string> = {
    ACCOUNT_AGE: await accountAge(profileConfig, now),
    ACCOUNT_LINKS: await accountLinks(profileConfig, now),
    DISPLAY_NAME: displayName(profileConfig),
    LANGUAGE_ROWS: await languageRows(profileConfig, now),
    LAST_YEAR_WINDOW_DAYS: String(profileConfig.render.lastYearWindowDays),
    ORGANIZATION_ROWS: await organizationRows(profileConfig, now),
    PROFILE_STATS_ROWS: await profileStatsRows(profileConfig, now),
    STATS_ROWS: await statsRows(profileConfig, now),
    TOP_REPOSITORIES: await topRepositories(profileConfig, now)
  }

  let output = template
  for (const [key, value] of Object.entries(context)) {
    output = output.replaceAll(`{{ ${key} }}`, value)
  }

  return output
}

export async function run(options: RenderOptions = {}): Promise<void> {
  const output = await render(options)
  const outputPath = options.outputPath ?? path.resolve(process.cwd(), DEFAULT_OUTPUT_PATH)
  fs.writeFileSync(outputPath, output)
  logger.info(`[render] wrote ${outputPath}`)
}

async function profileStatsRows(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const allTime = await activityTotals(profileConfig)
  const recent = await activityTotals(
    profileConfig,
    dateDaysAgo(now, profileConfig.render.lastYearWindowDays)
  )
  const languages = await languageActivityRows(profileConfig, now)
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

async function accountAge(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const filter = accountFilter(profileConfig, 'accounts', 1)
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

async function accountLinks(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const filter = accountFilter(profileConfig, 'accounts', 1)
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

async function statsRows(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const allTime = await activityTotals(profileConfig)
  const recent = await activityTotals(
    profileConfig,
    dateDaysAgo(now, profileConfig.render.lastYearWindowDays)
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

async function organizationRows(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const filter = accountFilter(profileConfig, 'a', 2)
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
    [dateDaysAgo(now, profileConfig.render.lastYearWindowDays), ...filter.params]
  )

  if (result.rows.length === 0) return '| - | - | - |'

  return result.rows
    .map((row) => `| **${row.organization}** | ${activitySummary(row)} | ${lineBadges(row)} |`)
    .join('\n')
}

async function languageRows(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const rows = await languageActivityRows(profileConfig, now)

  if (rows.length === 0) return '| - | 0 |'

  return rows.map((row) => `| ${row.language} | ${formatNumber(row.commits)} |`).join('\n')
}

async function languageActivityRows(
  profileConfig: ProfileConfig,
  now: Date
): Promise<LanguageActivityRow[]> {
  const filter = accountFilter(profileConfig, 'a', 3)
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
      dateDaysAgo(now, profileConfig.render.lastYearWindowDays),
      profileConfig.render.topLanguagesCount,
      ...filter.params
    ]
  )

  return result.rows
}

async function topRepositories(profileConfig: ProfileConfig, now: Date): Promise<string> {
  const filter = accountFilter(profileConfig, 'a', 3)
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
      dateDaysAgo(now, profileConfig.render.lastYearWindowDays),
      profileConfig.render.topPublicProjectsCount,
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
  profileConfig: ProfileConfig,
  fromDate?: string
): Promise<ActivityTotalsRow> {
  const filter = accountFilter(profileConfig, 'a', fromDate ? 2 : 1)
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
  profileConfig: ProfileConfig,
  tableAlias: string,
  startIndex: number
): AccountFilter {
  const params: unknown[] = []
  const clauses = profileConfig.identities.map((identity) => {
    const providerIndex = startIndex + params.length
    const externalIdIndex = providerIndex + 1
    params.push(identity.provider, identity.externalId)
    return `(${tableAlias}.provider = $${providerIndex} AND ${tableAlias}.external_id = $${externalIdIndex})`
  })

  return { sql: `(${clauses.join(' OR ')})`, params }
}

function displayName(profileConfig: ProfileConfig): string {
  return profileConfig.displayName ?? 'shiplog user'
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
