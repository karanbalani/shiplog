import fs from 'node:fs'
import path from 'node:path'

export type WorkflowDiagnosticSeverity = 'warning' | 'error'

interface WorkflowDiagnosticDefinition {
  defaultSeverity: WorkflowDiagnosticSeverity
  title: string
  explanation: string
  remediation: string
  impact: string
}

export const WORKFLOW_DIAGNOSTICS = {
  'SHIPLOG-CONFIG-001': {
    defaultSeverity: 'error',
    title: 'Invalid or missing Shiplog configuration',
    explanation: 'Shiplog could not load a valid configuration for this run.',
    remediation:
      'Validate `SHIPLOG_CONFIG_BASE64` and the decoded `shiplog.config.json` against the documented schema, then rerun the workflow.',
    impact: 'Collection or publishing did not start, and no progress checkpoint was advanced.'
  },
  'SHIPLOG-SECRET-001': {
    defaultSeverity: 'error',
    title: 'Required repository secret is missing',
    explanation: 'A secret required by this workflow was not configured or was empty.',
    remediation:
      'Add the required Actions secret named by the failed setup step, then rerun the workflow.',
    impact: 'The affected operation did not start, and no progress checkpoint was advanced.'
  },
  'SHIPLOG-GITHUB-AUTH-001': {
    defaultSeverity: 'error',
    title: 'GitHub rejected a configured token',
    explanation: 'A GitHub token was expired, revoked, malformed, or lacked required access.',
    remediation:
      'Replace or reauthorize the affected GitHub token, confirm its repository or organization access, and rerun the workflow.',
    impact:
      'Activity requiring that token was not collected. Completed work from other scopes remains intact.'
  },
  'SHIPLOG-GITHUB-STATS-001': {
    defaultSeverity: 'warning',
    title: 'Optional commit statistics were unavailable',
    explanation:
      'GitHub could not calculate additions, deletions, or changed-file statistics for one or more commits.',
    remediation:
      'No immediate action is required. Recent dates retry automatically; an integrity repair can refresh older contribution-visible commits, while deep-only historical metrics may remain null.',
    impact:
      'Core commit activity and its checkpoint were preserved; known statistics were retained and unavailable new values were stored as null.'
  },
  'SHIPLOG-GITHUB-RATE-001': {
    defaultSeverity: 'error',
    title: 'GitHub API rate limit was reached',
    explanation:
      'GitHub stopped the operation because the active token had no remaining API capacity.',
    remediation:
      'Wait for the rate limit to reset, reduce overlapping runs, or use a token with suitable API capacity, then rerun.',
    impact:
      'The current scope stopped before its checkpoint advanced; previously saved activity remains intact.'
  },
  'SHIPLOG-DB-CONNECTION-001': {
    defaultSeverity: 'error',
    title: 'Database was unavailable',
    explanation: 'Shiplog could not establish a usable connection to Postgres.',
    remediation:
      'Verify `DATABASE_CONNECTION_STRING`, database availability, network access, and provider status, then rerun.',
    impact: 'No new activity was saved and no progress checkpoint was advanced.'
  },
  'SHIPLOG-DB-MIGRATION-001': {
    defaultSeverity: 'error',
    title: 'Database migration failed',
    explanation:
      'The database schema could not be brought to the version required by this Shiplog revision.',
    remediation:
      'Inspect the migration step, resolve the reported schema or permission problem, and rerun before collecting data.',
    impact:
      'Collection or publishing did not start; existing data and checkpoints were not intentionally changed.'
  },
  'SHIPLOG-MAINTENANCE-001': {
    defaultSeverity: 'error',
    title: 'Maintenance operation failed',
    explanation: 'A queued repair, drift check, or housekeeping operation did not complete.',
    remediation:
      'Open the failed maintenance step, resolve its documented prerequisite, and rerun the same workflow.',
    impact:
      'Unfinished maintenance remains retryable; successfully committed activity and checkpoints remain intact.'
  },
  'SHIPLOG-PUBLISH-001': {
    defaultSeverity: 'error',
    title: 'Publishing failed',
    explanation: 'Shiplog could not build a publish target or update its rendered README.',
    remediation:
      'Verify the publish target configuration, write-token access, and branch protection rules, then rerun publish.',
    impact:
      'Collected database activity was not changed; the target README may still show the previous render.'
  },
  'SHIPLOG-UNKNOWN-001': {
    defaultSeverity: 'error',
    title: 'Unexpected workflow failure',
    explanation: 'The workflow failed in a way Shiplog could not classify safely.',
    remediation:
      'Open the named failed step, use its final safe error message for diagnosis, and report a new issue if it repeats.',
    impact:
      'Assume the current operation did not reach its next checkpoint; previously committed data remains intact.'
  }
} as const satisfies Record<string, WorkflowDiagnosticDefinition>

export type WorkflowDiagnosticCode = keyof typeof WORKFLOW_DIAGNOSTICS

export const WORKFLOW_STEP_LABELS = {
  checkout: 'Check out repository',
  setup_bun: 'Set up Bun',
  install_dbmate: 'Install dbmate',
  install_dependencies: 'Install dependencies',
  write_config: 'Write Shiplog configuration',
  export_read_tokens: 'Export read tokens',
  wait_database: 'Wait for database',
  run_migrations: 'Run database migrations',
  initialize_accounts: 'Initialize accounts',
  collect_activity: 'Collect current activity',
  run_maintenance: 'Run queued maintenance',
  backfill_history: 'Improve historical activity',
  detect_drift: 'Detect activity drift',
  repair_range: 'Repair selected range',
  prune_errors: 'Prune error events',
  build_targets: 'Build publish targets',
  export_publish_token: 'Export publish token',
  publish_readme: 'Publish rendered README',
  format: 'Check formatting',
  lint: 'Lint',
  typecheck: 'Typecheck',
  test: 'Test'
} as const

export type WorkflowStepId = keyof typeof WORKFLOW_STEP_LABELS

export interface WorkflowDiagnosticInput {
  code: WorkflowDiagnosticCode
  severity?: WorkflowDiagnosticSeverity
  step?: WorkflowStepId
  recovered?: boolean
}

export interface WorkflowDiagnosticEvent {
  version: 1
  code: WorkflowDiagnosticCode
  severity: WorkflowDiagnosticSeverity
  step?: WorkflowStepId
  recovered: boolean
  timestamp: string
}

export interface WorkflowEnvironment {
  [name: string]: string | undefined
}

export interface WorkflowDiagnosticsPathOptions {
  path?: string
  env?: WorkflowEnvironment
}

export interface RecordWorkflowDiagnosticOptions extends WorkflowDiagnosticsPathOptions {
  now?: () => Date
}

export interface RenderWorkflowSummaryOptions {
  workflowName?: string
  jobName?: string
  jobStatus?: string
  stepsJson?: string
  diagnostics?: readonly WorkflowDiagnosticEvent[]
  errorDocsUrl?: string
}

export const DEFAULT_ERROR_DOCS_URL =
  'https://github.com/karanbalani/shiplog/blob/main/docs/ERRORS.md'

const DEFAULT_DIAGNOSTICS_FILENAME = 'shiplog-diagnostics.jsonl'
const MAX_DIAGNOSTIC_EVENTS = 100
const MAX_DYNAMIC_LABEL_LENGTH = 100
const FAILED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required',
  'startup_failure'
])

interface WorkflowStepState {
  id: WorkflowStepId
  outcome?: string
  conclusion?: string
}

interface AggregatedDiagnostic {
  code: WorkflowDiagnosticCode
  severity: WorkflowDiagnosticSeverity
  step?: WorkflowStepId
  count: number
}

export function resolveDiagnosticsPath(
  options: WorkflowDiagnosticsPathOptions = {}
): string | undefined {
  const env = options.env ?? process.env
  const explicitPath = options.path?.trim() || env.SHIPLOG_DIAGNOSTICS_PATH?.trim()
  if (explicitPath) return explicitPath

  const runnerTemp = env.RUNNER_TEMP?.trim()
  return runnerTemp ? path.join(runnerTemp, DEFAULT_DIAGNOSTICS_FILENAME) : undefined
}

/**
 * Appends a deliberately small, structured diagnostic event. This API does not accept raw errors,
 * response bodies, repository names, connection strings, or other free-form text.
 */
export function recordWorkflowDiagnostic(
  input: WorkflowDiagnosticInput,
  options: RecordWorkflowDiagnosticOptions = {}
): boolean {
  try {
    const diagnosticsPath = resolveDiagnosticsPath(options)
    if (!diagnosticsPath || !isWorkflowDiagnosticCode(input.code)) return false

    const definition = WORKFLOW_DIAGNOSTICS[input.code]
    const recovered = input.recovered === true
    const event: WorkflowDiagnosticEvent = {
      version: 1,
      code: input.code,
      severity: recovered
        ? 'warning'
        : normalizeSeverity(input.severity, definition.defaultSeverity),
      ...(isWorkflowStepId(input.step) ? { step: input.step } : {}),
      recovered,
      timestamp: (options.now ?? (() => new Date()))().toISOString()
    }

    fs.mkdirSync(path.dirname(diagnosticsPath), { recursive: true })
    fs.appendFileSync(diagnosticsPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

export function readWorkflowDiagnostics(
  diagnosticsPath: string | undefined
): WorkflowDiagnosticEvent[] {
  if (!diagnosticsPath) return []

  try {
    return fs
      .readFileSync(diagnosticsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-MAX_DIAGNOSTIC_EVENTS)
      .flatMap((line) => {
        try {
          const event = parseDiagnosticEvent(JSON.parse(line))
          return event ? [event] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function renderWorkflowSummary(options: RenderWorkflowSummaryOptions): string {
  const workflowName = safeDynamicLabel(options.workflowName, 'workflow')
  const jobName = safeDynamicLabel(options.jobName, 'job')
  const steps = parseWorkflowSteps(options.stepsJson)
  const failedStep = steps.find(isFailedStep)
  const statusFailed = normalizeJobStatus(options.jobStatus) === 'failure'
  const diagnostics = normalizeDiagnostics(options.diagnostics ?? [])

  if (statusFailed && !diagnostics.some((event) => event.severity === 'error')) {
    const code = diagnosticCodeForStep(failedStep?.id)
    diagnostics.push({
      version: 1,
      code,
      severity: 'error',
      ...(failedStep ? { step: failedStep.id } : {}),
      recovered: false,
      timestamp: new Date(0).toISOString()
    })
  }

  const aggregated = aggregateDiagnostics(diagnostics)
  const hasErrors = statusFailed || aggregated.some((event) => event.severity === 'error')
  const hasWarnings = aggregated.some((event) => event.severity === 'warning')
  const result = hasErrors
    ? { label: 'Failed', icon: '❌' }
    : hasWarnings
      ? { label: 'Completed with warnings', icon: '⚠️' }
      : { label: 'Succeeded', icon: '✅' }
  const lines = [
    `## Shiplog · ${workflowName}`,
    '',
    `**Result:** ${result.icon} ${result.label}`,
    `**Job:** ${jobName}`
  ]

  if (hasErrors && failedStep) {
    lines.push(`**Failed step:** \`${failedStep.id}\` — ${WORKFLOW_STEP_LABELS[failedStep.id]}`)
  }

  if (aggregated.length === 0) {
    lines.push('', 'All workflow steps completed. No Shiplog diagnostics were recorded.', '')
    return lines.join('\n')
  }

  lines.push('', '| Code | What happened | Data and checkpoint effect |', '| --- | --- | --- |')

  for (const diagnostic of aggregated) {
    const definition = WORKFLOW_DIAGNOSTICS[diagnostic.code]
    const occurrence = diagnostic.count > 1 ? ` (${diagnostic.count} occurrences)` : ''
    const docsUrl = `${safeErrorDocsUrl(options.errorDocsUrl)}#${errorCodeAnchor(diagnostic.code)}`
    lines.push(
      `| [\`${diagnostic.code}\`](${docsUrl}) | ${definition.explanation}${occurrence} | ${definition.impact} |`
    )
  }

  lines.push('', '### How to fix', '')
  for (const diagnostic of aggregated) {
    const definition = WORKFLOW_DIAGNOSTICS[diagnostic.code]
    lines.push(`- **${definition.title}:** ${definition.remediation}`)
  }
  lines.push('')

  return lines.join('\n')
}

/** Appends the summary when GitHub provides a summary file. Every failure path is a no-op. */
export function writeWorkflowSummaryFromEnv(env: WorkflowEnvironment = process.env): boolean {
  try {
    const summaryPath = env.GITHUB_STEP_SUMMARY?.trim()
    if (!summaryPath) return false

    const diagnostics = readWorkflowDiagnostics(resolveDiagnosticsPath({ env }))
    const markdown = renderWorkflowSummary({
      workflowName: env.SHIPLOG_WORKFLOW_NAME,
      jobName: env.SHIPLOG_JOB_NAME,
      jobStatus: env.SHIPLOG_JOB_STATUS,
      stepsJson: env.SHIPLOG_STEPS_JSON,
      diagnostics,
      errorDocsUrl: env.SHIPLOG_ERROR_DOCS_URL
    })
    fs.appendFileSync(summaryPath, markdown, { encoding: 'utf8' })
    return true
  } catch {
    return false
  }
}

export function errorCodeAnchor(code: WorkflowDiagnosticCode): string {
  return code.toLowerCase()
}

function parseDiagnosticEvent(value: unknown): WorkflowDiagnosticEvent | undefined {
  if (!isRecord(value) || value.version !== 1 || !isWorkflowDiagnosticCode(value.code)) {
    return undefined
  }

  const definition = WORKFLOW_DIAGNOSTICS[value.code]
  const recovered = value.recovered === true
  return {
    version: 1,
    code: value.code,
    severity: recovered ? 'warning' : normalizeSeverity(value.severity, definition.defaultSeverity),
    ...(isWorkflowStepId(value.step) ? { step: value.step } : {}),
    recovered,
    timestamp: safeTimestamp(value.timestamp)
  }
}

function normalizeDiagnostics(
  events: readonly WorkflowDiagnosticEvent[]
): WorkflowDiagnosticEvent[] {
  return events.slice(-MAX_DIAGNOSTIC_EVENTS).flatMap((event) => {
    const parsed = parseDiagnosticEvent(event)
    return parsed ? [parsed] : []
  })
}

function aggregateDiagnostics(events: readonly WorkflowDiagnosticEvent[]): AggregatedDiagnostic[] {
  const aggregated = new Map<string, AggregatedDiagnostic>()

  for (const event of events) {
    const key = `${event.code}:${event.step ?? ''}`
    const existing = aggregated.get(key)
    if (existing) {
      existing.count += 1
      if (event.severity === 'error') existing.severity = 'error'
      continue
    }

    aggregated.set(key, {
      code: event.code,
      severity: event.severity,
      ...(event.step ? { step: event.step } : {}),
      count: 1
    })
  }

  return [...aggregated.values()]
}

function parseWorkflowSteps(json: string | undefined): WorkflowStepState[] {
  if (!json?.trim()) return []

  try {
    const parsed: unknown = JSON.parse(json)
    if (Array.isArray(parsed)) {
      return parsed.flatMap((value) => {
        if (!isRecord(value) || !isWorkflowStepId(value.id)) return []
        return [workflowStepState(value.id, value)]
      })
    }
    if (!isRecord(parsed)) return []

    return Object.entries(parsed).flatMap(([id, value]) => {
      if (!isWorkflowStepId(id)) return []
      if (typeof value === 'string') return [{ id, conclusion: value }]
      if (!isRecord(value)) return []
      return [workflowStepState(id, value)]
    })
  } catch {
    return []
  }
}

function workflowStepState(id: WorkflowStepId, value: Record<string, unknown>): WorkflowStepState {
  return {
    id,
    ...(typeof value.outcome === 'string' ? { outcome: value.outcome } : {}),
    ...(typeof value.conclusion === 'string' ? { conclusion: value.conclusion } : {})
  }
}

function isFailedStep(step: WorkflowStepState): boolean {
  return (
    (step.conclusion !== undefined && FAILED_CONCLUSIONS.has(step.conclusion.toLowerCase())) ||
    (step.outcome !== undefined && FAILED_CONCLUSIONS.has(step.outcome.toLowerCase()))
  )
}

function diagnosticCodeForStep(step: WorkflowStepId | undefined): WorkflowDiagnosticCode {
  switch (step) {
    case 'write_config':
      return 'SHIPLOG-CONFIG-001'
    case 'export_read_tokens':
    case 'export_publish_token':
      return 'SHIPLOG-SECRET-001'
    case 'wait_database':
      return 'SHIPLOG-DB-CONNECTION-001'
    case 'run_migrations':
      return 'SHIPLOG-DB-MIGRATION-001'
    case 'run_maintenance':
    case 'detect_drift':
    case 'repair_range':
    case 'prune_errors':
      return 'SHIPLOG-MAINTENANCE-001'
    case 'build_targets':
    case 'publish_readme':
      return 'SHIPLOG-PUBLISH-001'
    default:
      return 'SHIPLOG-UNKNOWN-001'
  }
}

function normalizeJobStatus(status: string | undefined): 'success' | 'failure' {
  return status?.trim().toLowerCase() === 'success' ? 'success' : 'failure'
}

function normalizeSeverity(
  severity: unknown,
  fallback: WorkflowDiagnosticSeverity
): WorkflowDiagnosticSeverity {
  return severity === 'warning' || severity === 'error' ? severity : fallback
}

function safeTimestamp(value: unknown): string {
  if (typeof value !== 'string') return new Date(0).toISOString()
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? new Date(0).toISOString() : timestamp.toISOString()
}

function safeDynamicLabel(value: string | undefined, fallback: string): string {
  if (!value?.trim()) return fallback

  const collapsed = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127 ? ' ' : character
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  if (!collapsed || containsSensitiveDynamicText(collapsed)) return fallback

  const truncated = truncate(collapsed, MAX_DYNAMIC_LABEL_LENGTH)
  return truncated.replace(/([\\`*_[\]<>|])/g, '\\$1')
}

function containsSensitiveDynamicText(value: string): boolean {
  return (
    /(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\//i.test(value) ||
    /\b(?:github_pat_|gh[pousr]_|bearer\s+)[A-Za-z0-9_.-]+/i.test(value) ||
    /\b(?:token|secret|password|authorization)\s*[:=]/i.test(value) ||
    /\b(?:error|exception|stack trace|http\s+[45]\d\d)\b\s*:/i.test(value) ||
    /(?:^|\s)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\s|$)/.test(value)
  )
}

function truncate(value: string, maxLength: number): string {
  const characters = [...value]
  if (characters.length <= maxLength) return value
  return `${characters.slice(0, maxLength - 1).join('')}…`
}

function safeErrorDocsUrl(value: string | undefined): string {
  if (!value) return DEFAULT_ERROR_DOCS_URL

  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return DEFAULT_ERROR_DOCS_URL
    url.hash = ''
    return url.toString()
  } catch {
    return DEFAULT_ERROR_DOCS_URL
  }
}

function isWorkflowDiagnosticCode(value: unknown): value is WorkflowDiagnosticCode {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_DIAGNOSTICS, value)
}

function isWorkflowStepId(value: unknown): value is WorkflowStepId {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_STEP_LABELS, value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
