import type {
  TargetRenderBlock,
  TargetRenderConfig,
  TargetRenderTableColumn
} from './types/index.ts'

export const SHIPLOG_FOOTER_TEXT =
  'Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).'
export const SHIPLOG_FOOTER = `<sub>${SHIPLOG_FOOTER_TEXT}</sub>`
const DEFAULT_REPEAT_SEPARATOR = '  \n'

export type TargetRenderQueryRow = Record<string, unknown>
export type TargetRenderQueryRunner = (
  sql: string,
  queryName: string
) => Promise<TargetRenderQueryRow[]>

export interface BuildTargetRenderContextOptions {
  config: TargetRenderConfig
  profile: {
    displayName: string
  }
  queryRunner: TargetRenderQueryRunner
}

export interface RenderTargetConfigWithRunnerOptions extends BuildTargetRenderContextOptions {}

export async function renderTargetConfigWithRunner(
  options: RenderTargetConfigWithRunnerOptions
): Promise<string> {
  const context = await buildTargetRenderContext(options)
  return appendShiplogFooter(`${renderTargetMarkdown(options.config.markdown, context)}\n`)
}

export async function buildTargetRenderContext(
  options: BuildTargetRenderContextOptions
): Promise<Record<string, unknown>> {
  return {
    profile: {
      displayName: options.profile.displayName
    },
    ...(await runTargetRenderQueries(options.config, options.queryRunner))
  }
}

export function appendShiplogFooter(markdown: string): string {
  const trimmed = markdown.trimEnd()
  if (trimmed.includes(SHIPLOG_FOOTER_TEXT)) return `${trimmed}\n`
  return `${trimmed}\n\n${SHIPLOG_FOOTER}\n`
}

export function renderTargetMarkdown(
  blocks: TargetRenderBlock[],
  context: Record<string, unknown>
): string {
  const renderedBlocks: string[] = []

  for (const [index, block] of blocks.entries()) {
    try {
      if (!isTargetBlockVisible(block, context)) continue
      renderedBlocks.push(renderTargetBlock(block, context))
    } catch (error) {
      throw new Error(
        `render markdown block ${index + 1} (${block.type}) failed: ${errorMessage(error)}`,
        { cause: error }
      )
    }
  }

  return renderedBlocks.join('\n\n')
}

export function validateTargetRenderSql(sql: string, queryName: string): void {
  const stripped = stripLeadingSqlComments(sql).trim()
  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    throw new Error(`render query ${queryName} must start with SELECT or WITH`)
  }

  if (hasStatementSeparator(stripped.replace(/;+[\s\n\r]*$/, ''))) {
    throw new Error(`render query ${queryName} must contain only one SELECT statement`)
  }

  const writableKeyword = firstWritableSqlKeyword(stripped)
  if (writableKeyword) {
    throw new Error(`render query ${queryName} must not include ${writableKeyword}`)
  }
}

async function runTargetRenderQueries(
  config: TargetRenderConfig,
  queryRunner: TargetRenderQueryRunner
): Promise<Record<string, unknown>> {
  const queries = Object.entries(config.queries ?? {})
  if (queries.length === 0) return {}

  const results: Record<string, unknown> = {}

  for (const [name, query] of queries) {
    try {
      validateTargetRenderSql(query.sql, name)
      const rows = await queryRunner(query.sql, name)
      results[name] = query.mode === 'one' ? (rows[0] ?? {}) : rows
    } catch (error) {
      throw new Error(`render query ${name} failed: ${errorMessage(error)}`, { cause: error })
    }
  }

  return results
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

  if (block.type === 'list') {
    return renderListBlock(block.query, block.value, context)
  }

  return renderRepeatBlock(
    block.query,
    block.template,
    block.separator ?? DEFAULT_REPEAT_SEPARATOR,
    context
  )
}

function isTargetBlockVisible(block: TargetRenderBlock, context: Record<string, unknown>): boolean {
  if (!block.visibleWhen) return true

  const queryName = block.visibleWhen.query
  if (!Object.prototype.hasOwnProperty.call(context, queryName)) {
    throw new Error(`visibleWhen query ${queryName} was not found`)
  }

  const rows = rowsForQuery(queryName, context)
  return rows.length > 0 === block.visibleWhen.hasRows
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

function renderRepeatBlock(
  queryName: string,
  template: string,
  separator: string,
  context: Record<string, unknown>
): string {
  return rowsForQuery(queryName, context)
    .map((row) => interpolate(template, { ...context, ...row, row }))
    .join(separator)
}

function rowsForQuery(queryName: string, context: Record<string, unknown>): TargetRenderQueryRow[] {
  const value = context[queryName]
  if (!Array.isArray(value)) {
    throw new Error(`render block query ${queryName} must use mode "many"`)
  }

  return value as TargetRenderQueryRow[]
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
