import { expect, test } from 'bun:test'
import { HttpError } from '../../lib/http.ts'
import {
  GitHubGraphQLError,
  isGitHubCommitStatisticsUnavailableError,
  isGitHubCredentialRejectedError,
  isGitHubRateLimitError,
  isGitHubRepositoryUnavailableError
} from '../../lib/providers/github/errors.ts'

test('credential classifier accepts only known authentication and access failures', () => {
  expect(isGitHubCredentialRejectedError(httpError(401, 'Bad credentials'))).toBe(true)
  expect(
    isGitHubCredentialRejectedError(
      httpError(403, 'Resource not accessible by personal access token')
    )
  ).toBe(true)
  expect(
    isGitHubCredentialRejectedError(
      new GitHubGraphQLError([
        { message: 'Resource not accessible by personal access token' },
        { message: 'Bad credentials' }
      ])
    )
  ).toBe(true)
})

test('credential classifier keeps rate limits, server failures, and mixed errors fatal', () => {
  expect(isGitHubCredentialRejectedError(httpError(403, 'API rate limit exceeded'))).toBe(false)
  expect(
    isGitHubCredentialRejectedError(
      httpError(403, 'API rate limit exceeded; resource not accessible by personal access token')
    )
  ).toBe(false)
  expect(isGitHubCredentialRejectedError(httpError(503, 'Service unavailable'))).toBe(false)
  expect(
    isGitHubCredentialRejectedError(
      new GitHubGraphQLError([
        { message: 'API rate limit exceeded; resource not accessible by personal access token' }
      ])
    )
  ).toBe(false)
  expect(
    isGitHubCredentialRejectedError(
      new GitHubGraphQLError([
        { message: 'Bad credentials' },
        { message: 'Something went wrong while executing your query.' }
      ])
    )
  ).toBe(false)
  expect(isGitHubCredentialRejectedError(new Error('fetch failed'))).toBe(false)
})

test('rate-limit classifier accepts explicit rate responses and rejects mixed errors', () => {
  expect(isGitHubRateLimitError(httpError(403, 'API rate limit exceeded'))).toBe(true)
  expect(
    isGitHubRateLimitError(
      new HttpError(
        'https://api.github.com/graphql',
        429,
        'slow down',
        new Headers({ 'retry-after': '60' })
      )
    )
  ).toBe(true)
  expect(
    isGitHubRateLimitError(
      new GitHubGraphQLError([{ message: 'You have exceeded a secondary rate limit.' }])
    )
  ).toBe(true)
  expect(
    isGitHubRateLimitError(
      new GitHubGraphQLError([
        { message: 'API rate limit exceeded' },
        { message: 'Something went wrong while executing your query.' }
      ])
    )
  ).toBe(false)
  expect(isGitHubRateLimitError(httpError(403, 'Resource not accessible'))).toBe(false)
})

test('commit-stat classifier accepts only pure known field-unavailable errors', () => {
  expect(
    isGitHubCommitStatisticsUnavailableError(
      new GitHubGraphQLError([
        { message: 'The additions count for this commit is unavailable.' },
        { message: 'The deletions count for this commit is unavailable.' },
        { message: 'The changed files count for this commit is unavailable.' }
      ])
    )
  ).toBe(true)

  expect(
    isGitHubCommitStatisticsUnavailableError(
      new GitHubGraphQLError([
        { message: 'The changedFiles count for this commit is unavailable.' }
      ])
    )
  ).toBe(true)

  expect(
    isGitHubCommitStatisticsUnavailableError(
      new GitHubGraphQLError([
        { message: 'The additions count for this commit is unavailable.' },
        { message: 'Could not resolve to a Repository.' }
      ])
    )
  ).toBe(false)
  expect(
    isGitHubCommitStatisticsUnavailableError(
      new GitHubGraphQLError([{ message: 'Service unavailable' }])
    )
  ).toBe(false)
  expect(isGitHubCommitStatisticsUnavailableError(httpError(503, 'Service unavailable'))).toBe(
    false
  )
})

test('repository-unavailable classifier does not swallow mixed GraphQL errors', () => {
  expect(
    isGitHubRepositoryUnavailableError(
      new GitHubGraphQLError([{ message: 'Could not resolve to a Repository.' }])
    )
  ).toBe(true)
  expect(
    isGitHubRepositoryUnavailableError(
      new GitHubGraphQLError([
        { message: 'Could not resolve to a Repository.' },
        { message: 'Something went wrong while executing your query.' }
      ])
    )
  ).toBe(false)
})

function httpError(status: number, body: string): HttpError {
  return new HttpError('https://api.github.com/graphql', status, body, new Headers())
}
