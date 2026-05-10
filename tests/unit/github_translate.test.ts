import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import * as translate from '../../lib/providers/github/translate.ts'
import type { GitHubRepositoryNode } from '../../lib/providers/github/types.ts'

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures')

test('repositoryFromGraphQLNode maps GraphQL repository to schema-shaped row', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'github_contributions_collection.json'), 'utf8')
  ) as {
    user: {
      contributionsCollection: {
        commitContributionsByRepository: Array<{ repository: GitHubRepositoryNode }>
      }
    }
  }
  const node = fixture.user.contributionsCollection.commitContributionsByRepository[0]!.repository

  const row = translate.repositoryFromGraphQLNode(node, '2026-05-07')

  expect(row.provider).toBe('github')
  expect(row.external_id).toBe('R_TEST_1')
  expect(row.full_name).toBe('octo-org/hello')
  expect(row.name).toBe('hello')
  expect(row.web_url).toBe('https://github.com/octo-org/hello')
  expect(row.owner_login).toBe('octo-org')
  expect(row.visibility).toBe('public')
  expect(row.primary_language).toBe('Go')
  expect(row.default_branch).toBe('main')
  expect(row.first_seen_on).toBe('2026-05-07')
  expect(row.last_seen_on).toBe('2026-05-07')
})

test('organizationFromRepositoryOwner maps GitHub organization owner', () => {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'github_contributions_collection.json'), 'utf8')
  ) as {
    user: {
      contributionsCollection: {
        commitContributionsByRepository: Array<{ repository: GitHubRepositoryNode }>
      }
    }
  }
  const owner =
    fixture.user.contributionsCollection.commitContributionsByRepository[0]!.repository.owner

  const row = translate.organizationFromRepositoryOwner(owner, '2026-05-07')

  expect(row).toMatchObject({
    provider: 'github',
    external_id: 'O_TEST_1',
    external_login: 'octo-org',
    display_name: 'Octo Org',
    first_seen_on: '2026-05-07',
    last_seen_on: '2026-05-07'
  })
})

test('commitFromGraphQLNode maps commit fields and dates', () => {
  const row = translate.commitFromGraphQLNode(
    {
      oid: 'abc123',
      committedDate: '2024-03-14T12:34:56Z',
      additions: 100,
      deletions: 20,
      changedFiles: 5,
      messageHeadline: 'Refactor X'
    },
    1,
    2,
    'live'
  )

  expect(row.account_id).toBe(1)
  expect(row.repository_id).toBe(2)
  expect(row.oid).toBe('abc123')
  expect(row.committed_on).toBe('2024-03-14')
  expect(row.committed_at).toBe('2024-03-14T12:34:56Z')
  expect(row.changed_files).toBe(5)
  expect(row.source).toBe('live')
})

test('languagesFromGraphQLEdges computes percentages', () => {
  const languages = translate.languagesFromGraphQLEdges([
    { size: 800, node: { name: 'Go' } },
    { size: 200, node: { name: 'Shell' } }
  ])

  expect(languages).toEqual([
    { language: 'Go', bytes: 800, percentage: 0.8 },
    { language: 'Shell', bytes: 200, percentage: 0.2 }
  ])
})
