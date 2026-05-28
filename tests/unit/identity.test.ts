import { expect, test } from 'bun:test'
import * as identity from '../../bin/identity.ts'
import type { Fetcher } from '../../lib/http.ts'

test('identity helper emits user config without requiring a token', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const output: string[] = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      node_id: 'U_TEST_1',
      login: 'therealpandey',
      html_url: 'https://github.com/therealpandey'
    })
  }

  await identity.run(['github', 'therealpandey'], {
    fetch,
    token: undefined,
    write: (text) => output.push(text)
  })

  expect(calls[0]!.url).toBe('https://api.github.com/users/therealpandey')
  expect(calls[0]!.init?.headers).not.toHaveProperty('Authorization')
  expect(JSON.parse(output.join(''))).toEqual({
    provider: 'github',
    externalId: 'U_TEST_1',
    loginHint: 'therealpandey',
    tokenEnv: 'GH_RO_CLASSIC_TOKEN',
    organizationTokens: [],
    ignoreOrganizations: [],
    ignoreRepositories: []
  })
})

test('identity helper emits publish target config from repository lookup', async () => {
  const output: string[] = []
  const fetch: Fetcher = async (url, init) => {
    expect(url).toBe('https://api.github.com/repos/octocat/octocat')
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-token' })
    return jsonResponse({
      node_id: 'R_PROFILE_1',
      full_name: 'octocat/octocat',
      html_url: 'https://github.com/octocat/octocat'
    })
  }

  await identity.run(['github', 'publish-target', 'octocat/octocat'], {
    fetch,
    token: 'test-token',
    write: (text) => output.push(text)
  })

  expect(JSON.parse(output.join(''))).toEqual({
    provider: 'github',
    repositoryId: 'R_PROFILE_1',
    repositoryHint: 'octocat/octocat',
    branch: 'main',
    path: 'README.md',
    tokenEnv: 'GH_RW_REPO_TOKEN'
  })
})

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
