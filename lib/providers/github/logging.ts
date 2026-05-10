import { gitHubErrorSummary } from './errors.ts'
import type { GitHubRepositoryNode } from './types.ts'

export function repositoryLogLabel(repository: GitHubRepositoryNode, fullName: string): string {
  return repository.isPrivate ? `id:${repository.id}` : fullName
}

export function repositoryErrorSummary(repository: GitHubRepositoryNode, error: unknown): string {
  if (repository.isPrivate) return 'details hidden for private repository'
  return gitHubErrorSummary(error)
}

export function privateRepositoryFailure(repository: GitHubRepositoryNode): Error {
  return new Error(
    `private GitHub repository id:${repository.id} failed during enrichment; details hidden to avoid leaking repository names`
  )
}
