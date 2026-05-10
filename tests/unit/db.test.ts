import { afterEach, beforeEach, expect, test } from 'bun:test'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as db from '../../lib/db.ts'

const originalDatabaseConnectionString = process.env.DATABASE_CONNECTION_STRING

beforeEach(() => {
  db.__setPoolForTests(createTestPool())
})

afterEach(async () => {
  await db.close()

  if (originalDatabaseConnectionString === undefined) {
    delete process.env.DATABASE_CONNECTION_STRING
  } else {
    process.env.DATABASE_CONNECTION_STRING = originalDatabaseConnectionString
  }
})

test('query runs sql against the configured pool', async () => {
  const result = await db.query<{ answer: number }>('SELECT $1::int AS answer', [42])

  expect(result.rows[0]!.answer).toBe(42)
})

test('withTransaction commits when callback succeeds', async () => {
  await db.query('CREATE TABLE things (id int PRIMARY KEY, name text NOT NULL)')

  const result = await db.withTransaction(async (client) => {
    await client.query('INSERT INTO things (id, name) VALUES ($1, $2)', [1, 'shiplog'])
    return 'committed'
  })

  const rows = await db.query<{ name: string }>('SELECT name FROM things WHERE id = $1', [1])

  expect(result).toBe('committed')
  expect(rows.rows[0]!.name).toBe('shiplog')
})

test('withTransaction rolls back when callback fails', async () => {
  const queries: string[] = []
  let released = false

  db.__setPoolForTests({
    connect: async () =>
      ({
        query: async (q: string) => {
          queries.push(q)
          return { rows: [] }
        },
        release: () => {
          released = true
        }
      }) as never,
    end: async () => undefined
  } as never)

  await expect(
    db.withTransaction(async () => {
      throw new Error('boom')
    })
  ).rejects.toThrow(/boom/)

  expect(queries).toEqual(['BEGIN', 'ROLLBACK'])
  expect(released).toBe(true)
})

test('close resets the pool', async () => {
  await db.close()
  delete process.env.DATABASE_CONNECTION_STRING

  expect(() => db.getPool()).toThrow(/DATABASE_CONNECTION_STRING is not set/)
})

function createTestPool(): Pool {
  const mem = newDb()
  const adapter = mem.adapters.createPg()
  return new adapter.Pool() as unknown as Pool
}
