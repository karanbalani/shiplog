import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as init from '../../bin/init.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
const originalGitHubToken = process.env.GH_RO_CLASSIC_TOKEN

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
  process.env.GH_RO_CLASSIC_TOKEN = 'test-token'
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()

  if (originalGitHubToken === undefined) {
    delete process.env.GH_RO_CLASSIC_TOKEN
  } else {
    process.env.GH_RO_CLASSIC_TOKEN = originalGitHubToken
  }
})

test('run creates account from config identity without collecting history', async () => {
  await init.run({
    config: shiplogConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })

  const users = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users')
  const accounts = await db.query<{
    external_login: string
    external_id: string
    last_successful_collect_on: Date | string | null
  }>('SELECT external_login, external_id, last_successful_collect_on FROM accounts')
  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')

  expect(users.rows[0]!.count).toBe(1)
  expect(accounts.rows[0]).toMatchObject({
    external_login: 'octocat',
    external_id: 'U_TEST_1'
  })
  expect(accounts.rows[0]!.last_successful_collect_on).toBeNull()
  expect(commits.rows[0]!.count).toBe(0)
})

test('run is idempotent for account setup', async () => {
  await init.run({
    config: shiplogConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })
  await init.run({
    config: shiplogConfig(),
    fetch: mockGitHubFetch(),
    now: new Date('2026-05-08T00:00:00Z')
  })

  const commits = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM commits')
  const users = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM users')
  const accounts = await db.query<{ count: number }>('SELECT COUNT(*)::int AS count FROM accounts')

  expect(users.rows[0]!.count).toBe(1)
  expect(accounts.rows[0]!.count).toBe(1)
  expect(commits.rows[0]!.count).toBe(0)
})

function shiplogConfig(): ShiplogConfig {
  return {
    version: 1,
    profile: { displayName: 'Example User' },
    collect: {
      lookbackDays: 7,
      accounts: [
        {
          provider: 'github',
          accountId: 'U_TEST_1',
          tokenEnv: 'GH_RO_CLASSIC_TOKEN',
          organizationPatTokens: [],
          ignore: {
            organizations: [],
            repositories: []
          }
        }
      ]
    },
    publish: {
      targets: [
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_1',
          branch: 'main',
          path: 'README.md',
          tokenEnv: 'GH_RW_REPO_TOKEN'
        }
      ]
    }
  }
}

function mockGitHubFetch(): typeof fetch {
  const currentYear = new Date().getUTCFullYear()

  return (async (url: string, init?: RequestInit) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { query: string }

      if (body.query.includes('query UserById')) {
        return jsonResponse({
          data: {
            node: {
              id: 'U_TEST_1',
              login: 'octocat',
              name: 'Octocat',
              url: 'https://github.com/octocat',
              createdAt: `${currentYear}-01-01T00:00:00Z`
            }
          }
        })
      }
    }

    return new Response(`unexpected request: ${url}`, { status: 500 })
  }) as typeof fetch
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

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
