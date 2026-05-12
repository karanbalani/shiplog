import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newDb } from 'pg-mem'
import type { Pool } from 'pg'
import * as render from '../../bin/render.ts'
import * as db from '../../lib/db.ts'
import * as logger from '../../lib/logger.ts'
import type { ProfileConfig } from '../../lib/types/index.ts'
import * as upserts from '../../lib/upserts.ts'

const MIGRATIONS = path.join(import.meta.dir, '..', '..', 'db', 'migrations')

beforeEach(() => {
  db.__setPoolForTests(createMigratedPool())
  logger.configureLogger({ level: 'silent', write: () => undefined })
})

afterEach(async () => {
  await db.close()
  logger.resetLogger()
})

test('render replaces template placeholders with database activity', async () => {
  await seedActivity()

  const output = await render.render({
    profileConfig: profileConfig(),
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

test('run writes rendered markdown to the requested output path', async () => {
  await seedActivity()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-render-'))
  const outputPath = path.join(dir, 'README.md')

  await render.run({
    profileConfig: profileConfig(),
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
      profileConfig: profileConfig(),
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

function profileConfig(): ProfileConfig {
  return {
    displayName: 'Example User',
    identities: [
      {
        provider: 'github',
        login: 'octocat',
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        organizationTokens: [],
        ignoreOrganizations: [],
        ignoreRepositories: []
      }
    ],
    publishTargets: [
      {
        provider: 'github',
        repositoryFullName: 'octocat/octocat',
        branch: 'main',
        path: 'README.md',
        tokenEnv: 'GH_RW_REPO_TOKEN'
      }
    ],
    render: {
      topLanguagesCount: 7,
      topPublicProjectsCount: 6,
      lastYearWindowDays: 365
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
