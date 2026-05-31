import { expect, test } from 'bun:test'
import * as queries from '../../lib/providers/github/queries.ts'

test('commit history queries request smaller pages for large repositories', () => {
  expect(queries.REPOSITORY_COMMITS_IN_WINDOW).toContain('history(first: 50')
  expect(queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW).toContain('history(first: 50')
  expect(queries.REPOSITORY_COMMITS_IN_WINDOW).not.toContain('history(first: 100')
  expect(queries.REPOSITORY_AUTHORED_COMMITS_IN_WINDOW).not.toContain('history(first: 100')
})
