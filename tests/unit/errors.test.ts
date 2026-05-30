import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as errors from '../../bin/errors.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()
})

test('prune deletes error events older than the retention window', async () => {
  await db.query(
    `INSERT INTO error_events (created_at, payload)
     VALUES
       ('2026-04-30T00:00:00Z', '{"source":"old"}'::jsonb),
       ('2026-05-01T00:00:00Z', '{"source":"cutoff"}'::jsonb),
       ('2026-05-15T00:00:00Z', '{"source":"new"}'::jsonb)`
  )

  const deleted = await errors.prune({
    now: new Date('2026-05-31T00:00:00Z'),
    retentionDays: 30
  })
  const remaining = await db.query<{ source: string }>(
    `SELECT payload->>'source' AS source
     FROM error_events
     ORDER BY created_at`
  )

  expect(deleted).toBe(1)
  expect(remaining.rows.map((row) => row.source)).toEqual(['cutoff', 'new'])
})

function createMigratedPool(): Pool {
  const mem = newDb()
  const adapter = mem.adapters.createPg()

  for (const filename of fs.readdirSync(MIGRATIONS).sort()) {
    if (!filename.endsWith('.sql') || filename.includes('create_view')) continue
    mem.public.none(loadMigration(filename))
  }

  return new adapter.Pool() as unknown as Pool
}

function loadMigration(filename: string): string {
  return fs
    .readFileSync(path.join(MIGRATIONS, filename), 'utf8')
    .split(/-- migrate:down/)[0]!
    .replace(/^-- migrate:up\s*/m, '')
}
