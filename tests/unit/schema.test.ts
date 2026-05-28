import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'

const MIGRATIONS_DIR = path.join(import.meta.dir, '..', '..', 'db', 'migrations')

test('table migrations use surrogate primary keys', () => {
  const tableMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql') && filename.includes('_create_table_'))

  expect(tableMigrations.length).toBeGreaterThan(0)

  for (const filename of tableMigrations) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
    expect(sql, filename).toMatch(/CREATE TABLE\s+[a-z_]+\s+\(\s+id BIGSERIAL PRIMARY KEY,/)
    expect(sql, filename).not.toMatch(/PRIMARY KEY\s+\([^)]+\)/)
  }
})

test('table migrations create one table each', () => {
  const tableMigrations = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((filename) => filename.endsWith('.sql') && filename.includes('_create_table_'))

  for (const filename of tableMigrations) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
    const createTableMatches = sql.match(/CREATE TABLE\s+[a-z_]+\s*\(/g) ?? []
    expect(createTableMatches, filename).toHaveLength(1)
  }
})
