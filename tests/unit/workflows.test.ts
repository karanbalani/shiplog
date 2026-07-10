import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const workflowsDir = path.join(import.meta.dir, '..', '..', '.github', 'workflows')

function workflow(name: string): string {
  return fs.readFileSync(path.join(workflowsDir, name), 'utf8')
}

test('publish workflow is named publish and only renders/publishes existing data', () => {
  const publish = workflow('publish.yml')

  expect(publish).toContain('name: publish')
  expect(publish).toContain('  prepare:')
  expect(publish).toContain('  publish:')
  expect(publish).toContain(
    'name: publish (${{ matrix.target.provider }}) (${{ matrix.target.owner }})'
  )
  expect(publish).toContain('fail-fast: false')
  expect(publish).toContain('target: ${{ fromJSON(needs.prepare.outputs.target_matrix) }}')
  expect(publish).toContain(
    'bun run tokens:export -- --scope publish --target-index "${{ matrix.target.target_index }}"'
  )
  expect(publish).toContain('bun run publish -- --target-index "${{ matrix.target.target_index }}"')
  expect(publish).not.toContain('bun run render')
  expect(publish).not.toContain('daily-publish')
  expect(publish).not.toContain('bun run init')
  expect(publish).not.toContain('bun run collect')
  expect(publish).not.toContain('bun run maintenance')
  expect(publish).not.toContain('bun run tokens:export -- --scope read')
})

test('workflows use the Node 24-compatible checkout action', () => {
  for (const entry of fs.readdirSync(workflowsDir)) {
    if (!entry.endsWith('.yml')) continue

    const contents = workflow(entry)
    expect(contents).not.toContain('actions/checkout@v4')
    expect(contents).toContain('actions/checkout@v6')
  }
})

test('every workflow job writes an always-run best-effort summary', () => {
  for (const entry of fs.readdirSync(workflowsDir)) {
    if (!entry.endsWith('.yml')) continue

    const contents = workflow(entry)
    const jobs = workflowJobs(contents)

    expect(Object.keys(jobs).length).toBeGreaterThan(0)
    for (const job of Object.values(jobs)) {
      const summaryStart = job.indexOf('      - name: Write run summary')
      const summary = job.slice(summaryStart)

      expect(summaryStart).toBeGreaterThan(0)
      expect(job.lastIndexOf('\n      - ')).toBe(summaryStart - 1)
      expect(countMatches(summary, /^        if: \$\{\{ always\(\) \}\}$/gm)).toBe(1)
      expect(countMatches(summary, /^        continue-on-error: true$/gm)).toBe(1)
      expect(summary).toContain('bun scripts/write_workflow_summary.ts')
      expect(summary).toContain('SHIPLOG_STEPS_JSON: >-')
      expect(summary).toContain('SHIPLOG_ERROR_DOCS_URL:')
      expect(summary).toContain('%s#shiplog-unknown-001')
      expect(summary).toContain('### How to fix')
      expect(summary).not.toContain('toJSON(steps)')
      expect(summary).not.toContain('.outputs')
    }
    expect(contents).not.toContain('|| true')
    expect(contents).not.toContain('set +e')
  }
})

test('workflow steps expose stable ids for summary diagnostics', () => {
  const expectedStepIds: Record<string, Record<string, string[]>> = {
    'ci.yml': {
      checks: [
        'checkout',
        'setup_bun',
        'install_dependencies',
        'format',
        'lint',
        'typecheck',
        'test'
      ]
    },
    'freshness.yml': {
      freshness: [
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
        'run_maintenance'
      ]
    },
    'history.yml': {
      history: [
        'checkout',
        'setup_bun',
        'install_dbmate',
        'install_dependencies',
        'write_config',
        'export_read_tokens',
        'wait_database',
        'run_migrations',
        'initialize_accounts',
        'backfill_history'
      ]
    },
    'housekeeping.yml': {
      'prune-error-events': [
        'checkout',
        'setup_bun',
        'install_dbmate',
        'install_dependencies',
        'wait_database',
        'run_migrations',
        'prune_errors'
      ]
    },
    'integrity.yml': {
      integrity: [
        'checkout',
        'setup_bun',
        'install_dbmate',
        'install_dependencies',
        'write_config',
        'export_read_tokens',
        'wait_database',
        'run_migrations',
        'initialize_accounts',
        'detect_drift',
        'repair_range',
        'run_maintenance'
      ]
    },
    'publish.yml': {
      prepare: [
        'checkout',
        'setup_bun',
        'install_dbmate',
        'install_dependencies',
        'write_config',
        'wait_database',
        'run_migrations',
        'build_targets'
      ],
      publish: [
        'checkout',
        'setup_bun',
        'install_dependencies',
        'write_config',
        'wait_database',
        'export_publish_token',
        'publish_readme'
      ]
    }
  }

  for (const [entry, expectedJobs] of Object.entries(expectedStepIds)) {
    const jobs = workflowJobs(workflow(entry))
    expect(Object.keys(jobs).sort()).toEqual(Object.keys(expectedJobs).sort())

    for (const [jobName, stepIds] of Object.entries(expectedJobs)) {
      const job = jobs[jobName]!
      for (const stepId of stepIds) {
        expect(job).toContain(`id: ${stepId}`)
        expect(job).toContain(`"${stepId}":"\${{ steps.${stepId}.outcome }}"`)
      }
    }
  }
})

test('decoded workflow configuration is schema-validated in its own step', () => {
  for (const entry of ['freshness.yml', 'history.yml', 'integrity.yml', 'publish.yml']) {
    const contents = workflow(entry)
    expect(countMatches(contents, /id: write_config/g)).toBe(
      countMatches(contents, /bun -e "import \{ load \} from '\.\/lib\/config\.ts'; load\(\)"/g)
    )
  }
})

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0
}

function workflowJobs(contents: string): Record<string, string> {
  const marker = '\njobs:\n'
  const jobsStart = contents.indexOf(marker)
  if (jobsStart < 0) return {}

  const body = `${contents.slice(jobsStart + marker.length)}\n  __end__:\n`
  const jobs: Record<string, string> = {}
  for (const match of body.matchAll(/^  ([A-Za-z0-9_-]+):\n([\s\S]*?)(?=^  [A-Za-z0-9_-]+:\n)/gm)) {
    const name = match[1]
    if (name && name !== '__end__') jobs[name] = match[2] ?? ''
  }
  return jobs
}
