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
    accountId: 'U_TEST_1',
    tokenEnv: 'GH_RO_CLASSIC_TOKEN',
    organizationPatTokens: [],
    ignore: {
      organizations: [],
      repositories: []
    }
  })
})

test('identity helper emits organization PAT token config', async () => {
  const output: string[] = []
  const fetch: Fetcher = async (url) => {
    expect(url).toBe('https://api.github.com/orgs/restricted-org')
    return jsonResponse({
      node_id: 'O_RESTRICTED_1',
      login: 'restricted-org',
      html_url: 'https://github.com/restricted-org'
    })
  }

  await identity.run(['github', 'organization-pat-token', 'restricted-org'], {
    fetch,
    token: undefined,
    write: (text) => output.push(text)
  })

  expect(JSON.parse(output.join(''))).toEqual({
    organizationId: 'O_RESTRICTED_1',
    tokenEnv: 'GH_RO_RESTRICTED_ORG_TOKEN'
  })
})

test('identity helper emits repository id for ignore lists', async () => {
  const output: string[] = []
  const fetch: Fetcher = async (url) => {
    expect(url).toBe('https://api.github.com/repos/octocat/octocat')
    return jsonResponse({
      node_id: 'R_PROFILE_1',
      full_name: 'octocat/octocat',
      html_url: 'https://github.com/octocat/octocat'
    })
  }

  await identity.run(['github', 'repository', 'octocat/octocat'], {
    fetch,
    token: undefined,
    write: (text) => output.push(text)
  })

  expect(JSON.parse(output.join(''))).toBe('R_PROFILE_1')
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
