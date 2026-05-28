import { fetchJson, type FetchJsonOptions, type Fetcher } from '../../http.ts'
import { GitHubGraphQLError } from './errors.ts'

const ENDPOINT = 'https://api.github.com/graphql'
const DEFAULT_GRAPHQL_RETRIES = 6
const DEFAULT_GRAPHQL_RETRY_DELAY_MS = 1_000
const TEST_GRAPHQL_RETRY_DELAY_MS = 1

export interface GraphQLClientOptions {
  token: string
  fetch?: Fetcher
  fetchJsonOptions?: Omit<FetchJsonOptions, 'fetch'>
}

export type GraphQLClient = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>
) => Promise<T>

export function graphQLClient({
  token,
  fetch,
  fetchJsonOptions = {}
}: GraphQLClientOptions): GraphQLClient {
  return async function graphQL<T = unknown>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    const body = await fetchJson<{
      data: T
      errors?: Array<{ message: string }>
    }>(
      ENDPOINT,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'shiplog'
        },
        body: JSON.stringify({ query, variables })
      },
      {
        retries: DEFAULT_GRAPHQL_RETRIES,
        retryDelayMs: fetch ? TEST_GRAPHQL_RETRY_DELAY_MS : DEFAULT_GRAPHQL_RETRY_DELAY_MS,
        timeoutMs: 60_000,
        ...fetchJsonOptions,
        ...(fetch ? { fetch } : {})
      }
    )

    if (body.errors?.length) {
      throw new GitHubGraphQLError(body.errors)
    }

    return body.data
  }
}
