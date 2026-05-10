import { HttpError } from '../../http.ts'

export interface GitHubGraphQLErrorItem {
  message: string
}

export class GitHubGraphQLError extends Error {
  readonly messages: string[]

  constructor(errors: GitHubGraphQLErrorItem[]) {
    const messages = errors.map((error) => error.message)
    super(`graphql error: ${messages.join('; ')}`)
    this.name = 'GitHubGraphQLError'
    this.messages = messages
  }
}

export function isGitHubRepositoryUnavailableError(error: unknown): boolean {
  if (error instanceof GitHubGraphQLError) {
    return error.messages.some(isRepositoryUnavailableMessage)
  }

  if (error instanceof HttpError) {
    if (error.status === 404) return true

    const body = error.body.toLowerCase()
    return (
      error.status === 422 &&
      (body.includes('repository') || body.includes('repo:') || body.includes('/repos/'))
    )
  }

  return error instanceof Error && isRepositoryUnavailableMessage(error.message)
}

export function gitHubErrorSummary(error: unknown): string {
  if (error instanceof GitHubGraphQLError) return error.messages.join('; ')
  if (error instanceof HttpError) return `HTTP ${error.status}: ${error.body.slice(0, 160)}`
  if (error instanceof Error) return error.message
  return String(error)
}

function isRepositoryUnavailableMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('could not resolve to a repository') ||
    normalized.includes('repository not found') ||
    normalized.includes('not found')
  )
}
