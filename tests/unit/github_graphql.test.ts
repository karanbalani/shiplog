import { expect, test } from 'bun:test'
import type { Fetcher } from '../../lib/http.ts'
import { GitHubGraphQLError } from '../../lib/providers/github/errors.ts'
import { graphQLClient } from '../../lib/providers/github/graphql.ts'

test('graphQLClient throws a GraphQL error on empty success bodies', async () => {
  const fetch: Fetcher = async () => new Response('', { status: 200 })
  const graphQL = graphQLClient({ token: 'test-token', fetch })

  try {
    await graphQL('query Test { viewer { login } }')
    throw new Error('expected GraphQL request to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(GitHubGraphQLError)
    expect((error as GitHubGraphQLError).messages).toEqual(['empty graphql response'])
  }
})
