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
  expect(publish).toContain('  publish:')
  expect(publish).toContain('bun run render')
  expect(publish).toContain('bun run publish')
  expect(publish).toContain('bun run tokens:export -- --scope publish')
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
