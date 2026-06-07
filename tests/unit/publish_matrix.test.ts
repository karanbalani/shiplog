import { Buffer } from 'node:buffer'
import { expect, test } from 'bun:test'
import { buildPublishTargetMatrix } from '../../scripts/build_publish_matrix.ts'
import type { Fetcher } from '../../lib/http.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'

test('buildPublishTargetMatrix resolves target owners for workflow job names', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      data: {
        node: {
          id: 'R_PROFILE_1',
          nameWithOwner: 'octocat/octocat',
          url: 'https://github.com/octocat/octocat'
        }
      }
    })
  }

  const matrix = await buildPublishTargetMatrix({
    configBase64: encodedConfig(shiplogConfig()),
    tokenSecretsJson: JSON.stringify({ GH_RW_REPO_TOKEN: 'target-token' }),
    fetch
  })

  expect(matrix).toEqual([
    {
      target_index: 0,
      provider: 'github',
      owner: 'octocat'
    }
  ])
  expect(calls[0]).toMatchObject({
    url: 'https://api.github.com/graphql'
  })
  expect(calls[0]!.init?.headers).toMatchObject({
    Authorization: 'Bearer target-token'
  })
})

test('buildPublishTargetMatrix reports missing publish token secret', async () => {
  await expect(
    buildPublishTargetMatrix({
      configBase64: encodedConfig(shiplogConfig()),
      tokenSecretsJson: '{}',
      fetch: async () => jsonResponse({ data: { node: null } })
    })
  ).rejects.toThrow(/Missing token secrets for: GH_RW_REPO_TOKEN/)
})

function encodedConfig(shiplogConfig: ShiplogConfig): string {
  return Buffer.from(JSON.stringify(shiplogConfig), 'utf8').toString('base64')
}

function shiplogConfig(): ShiplogConfig {
  return {
    version: 1,
    profile: { displayName: 'Example User' },
    collect: {
      lookbackDays: 7,
      accounts: [
        {
          provider: 'github',
          accountId: 'U_PROFILE_1',
          tokenEnv: 'GH_RO_CLASSIC_TOKEN',
          organizationPatTokens: [],
          ignore: { organizations: [], repositories: [] }
        }
      ]
    },
    publish: {
      targets: [
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_1',
          branch: 'main',
          path: 'README.md',
          tokenEnv: 'GH_RW_REPO_TOKEN'
        }
      ]
    }
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  })
}
