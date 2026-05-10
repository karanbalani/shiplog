import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

let pool: Pool | null = null

export function getPool(): Pool {
  if (pool) return pool

  const connectionString = process.env.DATABASE_CONNECTION_STRING
  if (!connectionString) {
    throw new Error(
      'DATABASE_CONNECTION_STRING is not set. define DATABASE_CONNECTION_STRING in .env or your shell.'
    )
  }

  pool = new Pool({
    connectionString,
    max: 4,
    ssl: connectionString.includes('sslmode=require') ? { rejectUnauthorized: false } : false
  })

  return pool
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  q: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(q, params)
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()

  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

export async function close(): Promise<void> {
  if (!pool) return

  await pool.end()
  pool = null
}

export function __setPoolForTests(testPool: Pool | null): void {
  pool = testPool
}
