import { expect, test } from 'bun:test'
import * as queries from '../../lib/providers/github/queries.ts'

test('commit history queries request smaller pages for large repositories', () => {
  expect(queries.REPOSITORY_COMMITS_IN_WINDOW).toContain('history(first: 50')
  expect(queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW).toContain('history(first: 50')
  expect(queries.REPOSITORY_COMMITS_IN_WINDOW).not.toContain('history(first: 100')
  expect(queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW).not.toContain('history(first: 100')
})

test('ingestion queries use nullable changed-file statistics and provide stats-free fallbacks', () => {
  for (const query of [
    queries.REPOSITORY_COMMITS_IN_WINDOW,
    queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW
  ]) {
    expect(query).toContain('changedFiles: changedFilesIfAvailable')
    expect(query).not.toMatch(/\bchangedFiles\s*(?:\n|$)/)
  }

  for (const query of [
    queries.REPOSITORY_COMMITS_IN_WINDOW_WITHOUT_STATISTICS,
    queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW_WITHOUT_STATISTICS
  ]) {
    expect(query).not.toContain('additions')
    expect(query).not.toContain('deletions')
    expect(query).not.toContain('changedFiles')
    expect(query).toContain('messageHeadline')
    expect(query).toContain('authors(first: 100)')
  }
})

test('private credited-commit probe is lean and statistics-free', () => {
  const query = queries.REPOSITORY_CREDITED_COMMIT_IDENTITIES_IN_WINDOW

  expect(query).toContain('pageInfo { hasNextPage endCursor }')
  expect(query).toContain('author { user { id login } }')
  expect(query).toContain('authors(first: 100)')
  expect(query).not.toContain('committedDate')
  expect(query).not.toContain('messageHeadline')
  expect(query).not.toContain('additions')
  expect(query).not.toContain('deletions')
  expect(query).not.toContain('changedFiles')
})
