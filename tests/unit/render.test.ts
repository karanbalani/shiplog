import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as render from '../../bin/render.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import * as renderConfig from '../../lib/render_config.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')
let previousWriteToken: string | undefined

beforeEach(() => {
  previousWriteToken = process.env.GH_RW_REPO_TOKEN
  delete process.env.GH_RW_REPO_TOKEN
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
})

afterEach(async () => {
  if (previousWriteToken === undefined) {
    delete process.env.GH_RW_REPO_TOKEN
  } else {
    process.env.GH_RW_REPO_TOKEN = previousWriteToken
  }
  await db.close()
  logger.resetLogger()
})

test('render replaces template placeholders with database activity', async () => {
  await seedActivity()

  const output = await render.render({
    config: shiplogConfig(),
    template: testTemplate(),
    now: new Date('2026-05-10T00:00:00Z')
  })

  expect(output).toContain('# Hi, Example User')
  expect(output).toContain('account age: 6')
  expect(output).toContain('🔥 **5** commits')
  expect(output).toContain('![TypeScript 5]')
  expect(output).toContain('| Commits | 5 | 5 |')
  expect(output).toContain('| Lines added | 100 | 100 |')
  expect(output).toContain('| **Octo Org** | 🔥 **5** commits · 🔀 **2** PRs')
  expect(output).toContain('![+100]')
  expect(output).toContain('![-20]')
  expect(output).toContain('| TypeScript | 5 |')
  expect(output).toContain(
    '- [**octo-org/hello**](https://github.com/octo-org/hello) - 🔥 **5** commits · 🔀 **2** PRs · 👀 **4** reviews'
  )
  expect(output).toContain('- [github/octocat](https://github.com/octocat) `age: 6 years`')
  expect(output).not.toContain('{{')
})

test('render builds markdown from target render config', async () => {
  await seedActivity()

  const output = await render.render({
    config: shiplogConfig(),
    targetRenderConfig: {
      version: 1,
      queries: {
        summary: {
          mode: 'one',
          sql: `
            SELECT
              COALESCE(SUM(d.commits), 0)::int AS commits,
              COALESCE(SUM(d.prs_opened), 0)::int AS pull_requests
            FROM daily_repository_activity d
            WHERE d.activity_on >= CURRENT_DATE - INTERVAL '365 days'
          `
        },
        repositories: {
          mode: 'many',
          sql: `
            SELECT
              r.full_name,
              r.web_url,
              COALESCE(SUM(d.commits), 0)::int AS commits
            FROM daily_repository_activity d
            JOIN repositories r ON r.id = d.repository_id
            WHERE r.visibility = 'public'
              AND r.redacted = false
            GROUP BY r.id, r.full_name, r.web_url
            ORDER BY commits DESC
          `
        }
      },
      markdown: [
        {
          type: 'heading',
          level: 1,
          text: "Hi, I'm {{ profile.displayName }}"
        },
        {
          type: 'paragraph',
          text: 'I shipped {{ summary.commits }} commits and opened {{ summary.pull_requests }} PRs.'
        },
        {
          type: 'table',
          query: 'repositories',
          columns: [
            {
              label: 'Repository',
              value: '[{{ full_name }}]({{ web_url }})'
            },
            {
              label: 'Commits',
              value: '{{ commits }}'
            }
          ]
        },
        {
          type: 'divider'
        },
        {
          type: 'rawMarkdown',
          content: '<sub>Rendered by shiplog.</sub>'
        }
      ]
    },
    now: new Date('2026-05-10T00:00:00Z')
  })

  expect(output).toContain("# Hi, I'm Example User")
  expect(output).toContain('I shipped 5 commits and opened 2 PRs.')
  expect(output).toContain('| Repository | Commits |')
  expect(output).toContain('| [octo-org/hello](https://github.com/octo-org/hello) | 5 |')
  expect(output).toContain('---')
  expect(output).toContain('<sub>Rendered by shiplog.</sub>')
  expect(output).not.toContain('{{')
})

test('render rejects target render queries that are not select statements', async () => {
  await seedActivity()

  await expect(
    render.render({
      config: shiplogConfig(),
      targetRenderConfig: {
        version: 1,
        queries: {
          bad: {
            mode: 'many',
            sql: 'DELETE FROM commits'
          }
        },
        markdown: [
          {
            type: 'list',
            query: 'bad',
            value: '{{ oid }}'
          }
        ]
      }
    })
  ).rejects.toThrow(/must start with SELECT or WITH/)
})

test('render rejects writable target render queries hidden inside CTEs', async () => {
  await seedActivity()

  await expect(
    render.render({
      config: shiplogConfig(),
      targetRenderConfig: {
        version: 1,
        queries: {
          bad: {
            mode: 'many',
            sql: 'WITH deleted AS (DELETE FROM commits RETURNING oid) SELECT oid FROM deleted'
          }
        },
        markdown: [
          {
            type: 'list',
            query: 'bad',
            value: '{{ oid }}'
          }
        ]
      }
    })
  ).rejects.toThrow(/must not include DELETE/)
})

test('render does not support built-in SQL parameters in target render queries', async () => {
  await seedActivity()

  await expect(
    render.render({
      config: shiplogConfig(),
      targetRenderConfig: {
        version: 1,
        queries: {
          summary: {
            mode: 'one',
            sql: 'SELECT COUNT(*)::int AS commits FROM daily_repository_activity WHERE account_id = ANY(:account_ids)'
          }
        },
        markdown: [{ type: 'paragraph', text: '{{ summary.commits }} commits' }]
      }
    })
  ).rejects.toThrow(/syntax error|invalid syntax|Unexpected token|account_ids/i)
})

test('render reports target repository context for invalid remote render config', async () => {
  await seedActivity()
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'

  await expect(
    render.render({
      config: shiplogConfig(),
      fetch: async (url) => {
        if (url === 'https://api.github.com/graphql') {
          return jsonResponse({
            data: {
              node: {
                id: 'R_PROFILE_1',
                nameWithOwner: 'octocat/octocat',
                url: 'https://github.com/octocat/octocat'
              }
            }
          })
        }

        return jsonResponse({
          type: 'file',
          content: Buffer.from('{"version":1,"markdown":[]}', 'utf8').toString('base64'),
          encoding: 'base64'
        })
      }
    })
  ).rejects.toThrow(/failed to load \.shiplog\/render\.json from github\/octocat\/octocat@main/i)
})

test('render reports block context when markdown references a one-row query as a list', async () => {
  await seedActivity()

  await expect(
    render.render({
      config: shiplogConfig(),
      targetRenderConfig: {
        version: 1,
        queries: {
          summary: {
            mode: 'one',
            sql: 'SELECT 1::int AS commits'
          }
        },
        markdown: [
          {
            type: 'list',
            query: 'summary',
            value: '{{ commits }}'
          }
        ]
      }
    })
  ).rejects.toThrow(/render markdown block 1 \(list\) failed/)
})

test('render loads target render config from the configured publish target', async () => {
  await seedActivity()
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'
  const calls: string[] = []

  const output = await render.render({
    config: shiplogConfig(),
    fetch: async (url) => {
      calls.push(url)
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({
          data: {
            node: {
              id: 'R_PROFILE_1',
              nameWithOwner: 'octocat/octocat',
              url: 'https://github.com/octocat/octocat'
            }
          }
        })
      }

      return jsonResponse({
        type: 'file',
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            markdown: [
              {
                type: 'heading',
                level: 1,
                text: 'Remote {{ profile.displayName }}'
              }
            ]
          }),
          'utf8'
        ).toString('base64'),
        encoding: 'base64'
      })
    },
    now: new Date('2026-05-10T00:00:00Z')
  })

  expect(output).toBe(
    '# Remote Example User\n\n<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>\n'
  )
  expect(calls).toContain(
    'https://api.github.com/repos/octocat/octocat/contents/.shiplog/render.json?ref=main'
  )
})

test('render uses the shipped fallback render config when target config is unavailable', async () => {
  const fallbackConfig = renderConfig.load(
    path.join(import.meta.dir, '..', '..', '.shiplog', 'render.json')
  )
  const queryNameBySql = new Map(
    Object.entries(fallbackConfig.queries ?? {}).map(([queryName, query]) => [query.sql, queryName])
  )

  db.__setPoolForTests({
    query: async (sql: string) => {
      const queryName = queryNameBySql.get(sql)

      if (queryName === 'intro') {
        return {
          rows: [
            {
              github_login: 'octocat',
              github_url: 'https://github.com/octocat',
              github_tenure: '6 years',
              github_years_badge: '6%20years'
            }
          ]
        }
      }

      if (queryName === 'snapshot') {
        return {
          rows: [
            { metric: '🔥 Commits', all_time: '5', last_365_days: '5' },
            { metric: '⭐️ Owned stars', all_time: '10', last_365_days: '3' }
          ]
        }
      }

      if (queryName === 'organizations') {
        return {
          rows: [
            {
              organization: 'Octo Org',
              web_url: 'https://github.com/octo-org',
              coverage: '1 repos',
              commits: '5',
              prs: '2',
              lines: '+100 / -20'
            }
          ]
        }
      }

      if (queryName === 'active_projects') {
        return {
          rows: [
            {
              full_name: 'octo-org/hello',
              web_url: 'https://github.com/octo-org/hello',
              commits: '5',
              lines_added: '100',
              lines_removed: '20'
            }
          ]
        }
      }

      return { rows: [] }
    },
    end: async () => undefined
  } as never)

  const output = await render.render({
    config: shiplogConfig(),
    now: new Date('2026-05-10T00:00:00Z')
  })

  expect(output).toContain('# Hey there! I am Example User. 👋')
  expect(output).toContain('Joined GitHub 6 years ago.')
  expect(output).toContain('| Metric | All Time | Last 365 days |')
  expect(output).toContain(
    '| [Octo Org](https://github.com/octo-org) | 1 repos | 5 | 2 | +100 / -20 |'
  )
  expect(output).toContain(
    '[octo-org/hello](https://github.com/octo-org/hello) - 🔥 5 commits, +100 -20'
  )
  expect(output).toContain(
    '<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>'
  )
})

test('run writes rendered markdown to the requested output path', async () => {
  await seedActivity()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-render-'))
  const outputPath = path.join(dir, 'README.md')

  await render.run({
    config: shiplogConfig(),
    template: '# {{ DISPLAY_NAME }}\n{{ ACCOUNT_LINKS }}\n',
    outputPath,
    now: new Date('2026-05-10T00:00:00Z')
  })

  expect(fs.readFileSync(outputPath, 'utf8')).toContain('# Example User')
})

test('run writes rendered.md by default without overwriting README.md', async () => {
  await seedActivity()
  const previousCwd = process.cwd()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-render-default-'))
  const readmePath = path.join(dir, 'README.md')
  const renderedPath = path.join(dir, 'rendered.md')
  fs.writeFileSync(readmePath, '# Project README\n')

  try {
    process.chdir(dir)
    await render.run({
      config: shiplogConfig(),
      template: '# {{ DISPLAY_NAME }}\n{{ ACCOUNT_LINKS }}\n',
      now: new Date('2026-05-10T00:00:00Z')
    })
  } finally {
    process.chdir(previousCwd)
  }

  expect(fs.readFileSync(renderedPath, 'utf8')).toContain('# Example User')
  expect(fs.readFileSync(readmePath, 'utf8')).toBe('# Project README\n')
})

async function seedActivity(): Promise<void> {
  const user = await upserts.upsertUser({ display_name: 'Example User' })
  const account = await upserts.upsertAccount({
    user_id: user.id,
    provider: 'github',
    external_login: 'octocat',
    external_id: 'U_TEST_1',
    external_url: 'https://github.com/octocat',
    external_created_at: '2020-01-01T00:00:00Z',
    first_seen_on: '2026-05-07'
  })
  const organization = await upserts.upsertOrganization({
    provider: 'github',
    external_id: 'O_TEST_1',
    external_login: 'octo-org',
    display_name: 'Octo Org',
    description: null,
    avatar_url: null,
    website_url: null,
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07'
  })
  const repository = await upserts.upsertRepository({
    provider: 'github',
    external_id: 'R_TEST_1',
    organization_id: organization.id,
    owner_login: 'octo-org',
    name: 'hello',
    full_name: 'octo-org/hello',
    web_url: 'https://github.com/octo-org/hello',
    description: 'test repository',
    visibility: 'public',
    is_fork: false,
    is_archived: false,
    primary_language: 'TypeScript',
    default_branch: 'main',
    external_created_at: '2020-01-01T00:00:00Z',
    external_pushed_at: '2026-05-07T00:00:00Z',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07',
    redacted: false
  })

  await upserts.upsertDailyRepositoryActivity({
    account_id: account.id,
    activity_on: '2026-05-07',
    repository_id: repository.id,
    commits: 5,
    lines_added: 100,
    lines_deleted: 20,
    files_changed: 3,
    prs_opened: 2,
    prs_merged: 1,
    prs_closed_unmerged: 0,
    pr_reviews_total: 4,
    pr_reviews_approved: 2,
    pr_reviews_changes_requested: 1,
    pr_reviews_commented: 1,
    issues_opened: 1,
    issues_closed: 0,
    source: 'live_rollup'
  })
}

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

function testTemplate(): string {
  return [
    '# Hi, {{ DISPLAY_NAME }}',
    'account age: {{ ACCOUNT_AGE }}',
    '{{ PROFILE_STATS_ROWS }}',
    '{{ LAST_YEAR_WINDOW_DAYS }}',
    '{{ STATS_ROWS }}',
    '{{ LANGUAGE_ROWS }}',
    '{{ ORGANIZATION_ROWS }}',
    '{{ TOP_REPOSITORIES }}',
    '{{ ACCOUNT_LINKS }}'
  ].join('\n')
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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
