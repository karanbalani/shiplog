import { fetchJson, type Fetcher } from '../../http.ts'
import { GitHubGraphQLError } from './errors.ts'

const ENDPOINT = 'https://api.github.com/graphql'

export interface GraphQLClientOptions {
  token: string
  fetch?: Fetcher
}

export type GraphQLClient = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>
) => Promise<T>

export function graphQLClient({ token, fetch }: GraphQLClientOptions): GraphQLClient {
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
      fetch ? { fetch } : {}
    )

    if (body.errors?.length) {
      throw new GitHubGraphQLError(body.errors)
    }

    return body.data
  }
}
