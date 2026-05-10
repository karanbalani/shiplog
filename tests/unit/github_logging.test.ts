import { expect, test } from 'bun:test'
import { repositoryErrorSummary, repositoryLogLabel } from '../../lib/providers/github/logging.ts'
import type { GitHubRepositoryNode } from '../../lib/providers/github/types.ts'

test('repositoryLogLabel hides private repository names', () => {
  expect(repositoryLogLabel(repository({ isPrivate: true }), 'octocat/secret')).toBe(
    'id:R_PRIVATE_1'
  )
})

test('repositoryLogLabel keeps public repository names readable', () => {
  expect(repositoryLogLabel(repository({ isPrivate: false }), 'octocat/public')).toBe(
    'octocat/public'
  )
})

test('repositoryErrorSummary hides private repository error details', () => {
  const summary = repositoryErrorSummary(
    repository({ isPrivate: true }),
    new Error("Could not resolve to a Repository with the name 'octocat/secret'.")
  )

  expect(summary).toBe('details hidden for private repository')
  expect(summary).not.toContain('octocat/secret')
})

test('repositoryErrorSummary keeps public repository error details', () => {
  const summary = repositoryErrorSummary(
    repository({ isPrivate: false }),
    new Error("Could not resolve to a Repository with the name 'octocat/public'.")
  )

  expect(summary).toContain('octocat/public')
})

function repository(options: { isPrivate: boolean }): GitHubRepositoryNode {
  return {
    id: options.isPrivate ? 'R_PRIVATE_1' : 'R_PUBLIC_1',
    nameWithOwner: options.isPrivate ? 'octocat/secret' : 'octocat/public',
    owner: { login: 'octocat' },
    isPrivate: options.isPrivate,
    isFork: false,
    isArchived: false,
    primaryLanguage: null,
    defaultBranchRef: { name: 'main' }
  }
}
