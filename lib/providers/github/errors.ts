import { HttpError } from '../../http.ts'

const ERROR_TOKEN_ENVS = new WeakMap<object, string>()

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

/** Associates a configured token environment-variable name with an error without wrapping it. */
export function attributeGitHubErrorTokenEnv(error: unknown, tokenEnv: string): void {
  const reference = errorReference(error)
  const normalizedTokenEnv = tokenEnv.trim()
  if (reference && normalizedTokenEnv) ERROR_TOKEN_ENVS.set(reference, normalizedTokenEnv)
}

export function githubErrorTokenEnv(error: unknown): string | undefined {
  const reference = errorReference(error)
  return reference ? ERROR_TOKEN_ENVS.get(reference) : undefined
}

/**
 * Returns true only when GitHub has clearly rejected a credential or its
 * organization access. This is deliberately narrower than a generic 403:
 * GitHub also uses 403 for rate limiting, which callers must keep fatal or
 * retryable rather than silently treating as an optional-token failure.
 */
export function isGitHubCredentialRejectedError(error: unknown): boolean {
  if (isGitHubRateLimitError(error)) return false

  if (error instanceof HttpError) {
    if (error.status === 401) return true
    if (error.status !== 403) return false

    const body = error.body.toLowerCase()
    return isCredentialAccessMessage(body)
  }

  if (error instanceof GitHubGraphQLError) {
    return (
      error.messages.length > 0 &&
      error.messages.every(
        (message) => !isRateLimitMessage(message) && isCredentialAccessMessage(message)
      )
    )
  }

  return false
}

/** Returns true only for explicit GitHub primary or secondary rate-limit responses. */
export function isGitHubRateLimitError(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status !== 403 && error.status !== 429) return false
    return (
      error.headers.has('retry-after') ||
      error.headers.get('x-ratelimit-remaining') === '0' ||
      isRateLimitMessage(error.body)
    )
  }

  return (
    error instanceof GitHubGraphQLError &&
    error.messages.length > 0 &&
    error.messages.every(isRateLimitMessage)
  )
}

/**
 * GitHub can return field-level GraphQL errors when its diff service cannot
 * calculate a commit's optional statistics. Only a response made up entirely
 * of those known errors is safe to retry with a statistics-free query.
 */
export function isGitHubCommitStatisticsUnavailableError(error: unknown): boolean {
  return (
    error instanceof GitHubGraphQLError &&
    error.messages.length > 0 &&
    error.messages.every(isCommitStatisticsUnavailableMessage)
  )
}

export function isGitHubRepositoryUnavailableError(error: unknown): boolean {
  if (error instanceof GitHubGraphQLError) {
    return error.messages.length > 0 && error.messages.every(isRepositoryUnavailableMessage)
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

function isCredentialAccessMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('bad credentials') ||
    normalized.includes('requires authentication') ||
    normalized.includes('resource not accessible by personal access token') ||
    normalized.includes('resource protected by organization saml enforcement') ||
    normalized.includes('oauth app access restrictions')
  )
}

function isRateLimitMessage(message: string): boolean {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('rate limit') ||
    normalized.includes('secondary rate') ||
    normalized.includes('abuse detection')
  )
}

function isCommitStatisticsUnavailableMessage(message: string): boolean {
  return /^the (?:additions|deletions|changed\s*files) count for this commit is unavailable\.?$/i.test(
    message.trim()
  )
}

function errorReference(error: unknown): object | undefined {
  if ((typeof error === 'object' && error !== null) || typeof error === 'function') return error
  return undefined
}
