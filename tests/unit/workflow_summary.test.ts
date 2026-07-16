import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  WORKFLOW_DIAGNOSTICS,
  WORKFLOW_STEP_LABELS,
  errorCodeAnchor,
  readWorkflowDiagnostics,
  recordWorkflowDiagnostic,
  renderWorkflowSummary,
  resolveDiagnosticsPath,
  writeWorkflowSummaryFromEnv,
  type WorkflowDiagnosticEvent
} from '../../lib/workflow_summary.ts'

const ROOT = path.join(import.meta.dir, '..', '..')

test('renders a concise success summary', () => {
  const summary = renderWorkflowSummary({
    workflowName: 'freshness',
    jobName: 'freshness',
    jobStatus: 'success',
    stepsJson: JSON.stringify({ collect_activity: { outcome: 'success' } })
  })

  expect(summary).toContain('## Shiplog · freshness')
  expect(summary).toContain('**Result:** ✅ Succeeded')
  expect(summary).toContain('No Shiplog diagnostics were recorded.')
  expect(summary).not.toContain('### How to fix')
})

test('renders recovered diagnostics as warnings with data impact and remediation', () => {
  const summary = renderWorkflowSummary({
    workflowName: 'history',
    jobName: 'history',
    jobStatus: 'success',
    diagnostics: [
      {
        ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'error', 'backfill_history'),
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        recovered: true
      }
    ]
  })

  expect(summary).toContain('**Result:** ⚠️ Completed with warnings')
  expect(summary).toContain('SHIPLOG-GITHUB-AUTH-001')
  expect(summary).toContain('#shiplog-github-auth-001')
  expect(summary).toContain('Completed work from other scopes remains intact')
  expect(summary).toContain('Replace or reauthorize the affected GitHub token')
  expect(summary).toContain('Token env: `GH_RO_CLASSIC_TOKEN` — warning only')
  expect(summary).not.toContain('**Result:** ❌ Failed')
})

test('deduplicates diagnostics by code while retaining steps, occurrences, and token context', () => {
  const diagnostics: WorkflowDiagnosticEvent[] = [
    {
      ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'collect_activity'),
      tokenEnv: 'GH_RO_GEEEEEEEZ_PAT_TOKEN'
    },
    {
      ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'run_maintenance'),
      tokenEnv: 'GH_RO_GEEEEEEEZ_PAT_TOKEN'
    },
    {
      ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'run_maintenance'),
      tokenEnv: 'GH_RO_GEEEEEEEZ_PAT_TOKEN'
    }
  ]
  const summary = renderWorkflowSummary({
    workflowName: 'freshness',
    jobName: 'freshness',
    jobStatus: 'success',
    diagnostics
  })

  expect(summary.match(/SHIPLOG-GITHUB-AUTH-001/g)).toHaveLength(1)
  expect(summary.match(/Replace or reauthorize the affected GitHub token/g)).toHaveLength(1)
  expect(summary).toContain('3 occurrences')
  expect(summary).toContain('Collect current activity')
  expect(summary).toContain('Run queued maintenance')
  expect(summary.match(/GH_RO_GEEEEEEEZ_PAT_TOKEN/g)).toHaveLength(1)
})

test('keeps per-token severity when one auth code contains warnings and errors', () => {
  const summary = renderWorkflowSummary({
    workflowName: 'history',
    jobName: 'history',
    jobStatus: 'failure',
    diagnostics: [
      {
        ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'backfill_history'),
        tokenEnv: 'GH_RO_GEEEEEEEZ_PAT_TOKEN'
      },
      {
        ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'error', 'backfill_history'),
        tokenEnv: 'GH_RO_CLASSIC_TOKEN'
      }
    ]
  })

  expect(summary.match(/SHIPLOG-GITHUB-AUTH-001/g)).toHaveLength(1)
  expect(summary.match(/Replace or reauthorize the affected GitHub token/g)).toHaveLength(1)
  expect(summary).toContain('**Result:** ❌ Failed')
  expect(summary).toContain('2 occurrences')
  expect(summary).toContain(
    '`GH_RO_CLASSIC_TOKEN` — caused run failure; `GH_RO_GEEEEEEEZ_PAT_TOKEN` — warning only'
  )
})

test('renders mixed recovered auth problems as warnings without duplicating remediation', () => {
  const summary = renderWorkflowSummary({
    workflowName: 'history',
    jobName: 'history',
    jobStatus: 'success',
    diagnostics: [
      {
        ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'backfill_history'),
        tokenEnv: 'GH_RO_GEEEEEEEZ_PAT_TOKEN',
        recovered: true
      },
      {
        ...diagnostic('SHIPLOG-GITHUB-AUTH-001', 'warning', 'backfill_history'),
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        recovered: true
      }
    ]
  })

  expect(summary).toContain('**Result:** ⚠️ Completed with warnings')
  expect(summary).toContain('2 occurrences')
  expect(summary).toContain('`GH_RO_GEEEEEEEZ_PAT_TOKEN` — warning only')
  expect(summary).toContain('`GH_RO_CLASSIC_TOKEN` — warning only')
  expect(summary.match(/Replace or reauthorize the affected GitHub token/g)).toHaveLength(1)
})

test('maps a failed stable step to a documented failure without hiding job failure', () => {
  const summary = renderWorkflowSummary({
    workflowName: 'freshness',
    jobName: 'freshness',
    jobStatus: 'failure',
    stepsJson: JSON.stringify({
      checkout: { outcome: 'success' },
      export_read_tokens: { outcome: 'failure', conclusion: 'failure' },
      collect_activity: { outcome: 'skipped' }
    })
  })

  expect(summary).toContain('**Result:** ❌ Failed')
  expect(summary).toContain('**Failed step:** `export_read_tokens` — Export read tokens')
  expect(summary).toContain('SHIPLOG-SECRET-001')
  expect(summary).toContain('no progress checkpoint was advanced')
})

test('does not render raw diagnostic fields, secrets, URLs, stacks, or repository names', () => {
  const unsafeEvent = {
    ...diagnostic('SHIPLOG-UNKNOWN-001', 'error', 'collect_activity'),
    error: 'Error: HTTP 401 body={"token":"ghp_supersecret"}',
    tokenEnv: 'ghp_supersecret',
    stack: 'at owner/private-repo/src/index.ts',
    database: 'postgres://user:password@db.example/shiplog'
  } as WorkflowDiagnosticEvent
  const summary = renderWorkflowSummary({
    workflowName: `history ${'x'.repeat(180)}`,
    jobName: 'owner/private-repo Error: ghp_supersecret postgres://user:password@host/db',
    jobStatus: 'failure',
    diagnostics: [unsafeEvent],
    stepsJson: JSON.stringify({
      collect_activity: {
        outcome: 'failure',
        outputs: { token: 'ghp_outputsecret', response: 'owner/private-repo' }
      }
    })
  })

  expect(summary).toContain('**Job:** job')
  expect(summary).toContain('…')
  expect(summary).not.toContain('supersecret')
  expect(summary).not.toContain('postgres://')
  expect(summary).not.toContain('owner/private-repo')
  expect(summary).not.toContain('body=')
  expect(summary).not.toContain('src/index.ts')
})

test('records safe JSONL diagnostics at an explicit path or under RUNNER_TEMP', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-workflow-diagnostic-'))
  const explicitPath = path.join(dir, 'nested', 'diagnostics.jsonl')
  const recorded = recordWorkflowDiagnostic(
    {
      code: 'SHIPLOG-GITHUB-STATS-001',
      severity: 'warning',
      step: 'backfill_history',
      tokenEnv: 'GH_RO_CLASSIC_TOKEN',
      recovered: true,
      // Prove extra runtime fields cannot enter the serialized event.
      error: 'ghp_must_not_be_written',
      token: 'github_pat_must_not_be_written'
    } as Parameters<typeof recordWorkflowDiagnostic>[0],
    { path: explicitPath, now: () => new Date('2026-07-10T12:00:00Z') }
  )

  expect(recorded).toBe(true)
  expect(resolveDiagnosticsPath({ env: { RUNNER_TEMP: dir } })).toBe(
    path.join(dir, 'shiplog-diagnostics.jsonl')
  )
  expect(readWorkflowDiagnostics(explicitPath)).toEqual([
    {
      version: 1,
      code: 'SHIPLOG-GITHUB-STATS-001',
      severity: 'warning',
      step: 'backfill_history',
      tokenEnv: 'GH_RO_CLASSIC_TOKEN',
      recovered: true,
      timestamp: '2026-07-10T12:00:00.000Z'
    }
  ])
  expect(fs.readFileSync(explicitPath, 'utf8')).not.toContain('must_not_be_written')
})

test('drops unsafe token context without dropping the diagnostic', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-workflow-token-redaction-'))
  const diagnosticsPath = path.join(dir, 'diagnostics.jsonl')
  const unsafeTokenEnvs = [
    'ghp_supersecret',
    'github_pat_supersecret',
    'abcdef0123456789abcdef0123456789abcdef01',
    'GH_TOKEN\n| leaked |',
    `GH_${'X'.repeat(130)}_TOKEN`
  ]

  for (const tokenEnv of unsafeTokenEnvs) {
    expect(
      recordWorkflowDiagnostic(
        {
          code: 'SHIPLOG-GITHUB-AUTH-001',
          step: 'collect_activity',
          tokenEnv,
          recovered: true
        },
        { path: diagnosticsPath }
      )
    ).toBe(true)
  }

  const diagnostics = readWorkflowDiagnostics(diagnosticsPath)
  expect(diagnostics).toHaveLength(unsafeTokenEnvs.length)
  expect(diagnostics.every((event) => event.tokenEnv === undefined)).toBe(true)
  const summary = renderWorkflowSummary({ jobStatus: 'success', diagnostics })
  expect(summary).toContain('SHIPLOG-GITHUB-AUTH-001')
  expect(summary).not.toContain('supersecret')
  expect(summary).not.toContain('leaked')
})

test('reads legacy version 1 diagnostics without token context', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-workflow-legacy-diagnostic-'))
  const diagnosticsPath = path.join(dir, 'diagnostics.jsonl')
  fs.writeFileSync(
    diagnosticsPath,
    `${JSON.stringify({
      version: 1,
      code: 'SHIPLOG-GITHUB-AUTH-001',
      severity: 'warning',
      step: 'backfill_history',
      recovered: true,
      timestamp: '2026-07-10T12:00:00.000Z'
    })}\n`
  )

  expect(readWorkflowDiagnostics(diagnosticsPath)).toEqual([
    {
      version: 1,
      code: 'SHIPLOG-GITHUB-AUTH-001',
      severity: 'warning',
      step: 'backfill_history',
      recovered: true,
      timestamp: '2026-07-10T12:00:00.000Z'
    }
  ])
})

test('summary writing appends when configured and is otherwise a best-effort no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-workflow-summary-'))
  const summaryPath = path.join(dir, 'summary.md')
  fs.writeFileSync(summaryPath, '# Existing summary\n\n')

  expect(
    writeWorkflowSummaryFromEnv({
      GITHUB_STEP_SUMMARY: summaryPath,
      RUNNER_TEMP: dir,
      SHIPLOG_WORKFLOW_NAME: 'ci',
      SHIPLOG_JOB_NAME: 'checks',
      SHIPLOG_JOB_STATUS: 'success',
      SHIPLOG_STEPS_JSON: JSON.stringify({ test: { conclusion: 'success' } })
    })
  ).toBe(true)

  const contents = fs.readFileSync(summaryPath, 'utf8')
  expect(contents).toStartWith('# Existing summary')
  expect(contents).toContain('## Shiplog · ci')
  expect(writeWorkflowSummaryFromEnv({})).toBe(false)
  expect(writeWorkflowSummaryFromEnv({ GITHUB_STEP_SUMMARY: dir })).toBe(false)
})

test('every stable code has a docs anchor and every requested step ID is mapped', () => {
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'ERRORS.md'), 'utf8')
  for (const code of Object.keys(WORKFLOW_DIAGNOSTICS) as (keyof typeof WORKFLOW_DIAGNOSTICS)[]) {
    expect(docs).toContain(`<a id="${errorCodeAnchor(code)}"></a>`)
  }

  expect(Object.keys(WORKFLOW_STEP_LABELS)).toEqual([
    'checkout',
    'setup_bun',
    'install_dbmate',
    'install_dependencies',
    'write_config',
    'export_read_tokens',
    'wait_database',
    'run_migrations',
    'initialize_accounts',
    'collect_activity',
    'run_maintenance',
    'backfill_history',
    'detect_drift',
    'repair_range',
    'prune_errors',
    'build_targets',
    'export_publish_token',
    'publish_readme',
    'format',
    'lint',
    'typecheck',
    'test'
  ])
})

function diagnostic(
  code: WorkflowDiagnosticEvent['code'],
  severity: WorkflowDiagnosticEvent['severity'],
  step: WorkflowDiagnosticEvent['step']
): WorkflowDiagnosticEvent {
  return {
    version: 1,
    code,
    severity,
    ...(step ? { step } : {}),
    recovered: severity === 'warning',
    timestamp: '2026-07-10T12:00:00.000Z'
  }
}
