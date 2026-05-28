import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as publish from '../../bin/publish.ts'
import type { Fetcher } from '../../lib/http.ts'
import * as logger from '../../lib/logger.ts'
import { publishGitHubFile } from '../../lib/providers/github/publish.ts'
import type { ProfileConfig } from '../../lib/types/index.ts'

let previousWriteToken: string | undefined

beforeEach(() => {
  previousWriteToken = process.env.GH_RW_REPO_TOKEN
  delete process.env.GH_RW_REPO_TOKEN
  logger.configureLogger({ level: 'silent', write: () => undefined })
})

afterEach(() => {
  if (previousWriteToken === undefined) {
    delete process.env.GH_RW_REPO_TOKEN
  } else {
    process.env.GH_RW_REPO_TOKEN = previousWriteToken
  }
  logger.resetLogger()
})

test('publishGitHubFile creates target file when it does not exist', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    if (init?.method === 'PUT') {
      return jsonResponse({
        content: {
          sha: 'new-file-sha',
          html_url: 'https://github.com/octocat/octocat/blob/main/README.md'
        },
        commit: { sha: 'new-commit-sha' }
      })
    }

    return new Response('{"message":"not found"}', { status: 404 })
  }

  const result = await publishGitHubFile({
    token: 'write-token',
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: 'README.md',
    content: '# hello\n',
    message: 'chore: update rendered readme',
    fetch
  })

  expect(calls).toHaveLength(2)
  expect(calls[0]!.url).toBe(
    'https://api.github.com/repos/octocat/octocat/contents/README.md?ref=main'
  )
  expect(calls[1]!.url).toBe('https://api.github.com/repos/octocat/octocat/contents/README.md')
  const body = JSON.parse(String(calls[1]!.init?.body)) as {
    message: string
    content: string
    branch: string
    sha?: string
  }
  expect(body).toMatchObject({
    message: 'chore: update rendered readme',
    content: Buffer.from('# hello\n', 'utf8').toString('base64'),
    branch: 'main'
  })
  expect(body.sha).toBeUndefined()
  expect(result.commitSha).toBe('new-commit-sha')
})

test('publishGitHubFile updates target file when it already exists', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    if (init?.method === 'PUT') {
      return jsonResponse({
        content: { sha: 'updated-file-sha' },
        commit: { sha: 'updated-commit-sha' }
      })
    }

    return jsonResponse({ type: 'file', sha: 'existing-file-sha' })
  }

  await publishGitHubFile({
    token: 'write-token',
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: 'docs/profile.md',
    content: 'hello',
    message: 'update docs profile',
    fetch
  })

  expect(calls[0]!.url).toBe(
    'https://api.github.com/repos/octocat/octocat/contents/docs/profile.md?ref=main'
  )
  expect(calls[1]!.url).toBe(
    'https://api.github.com/repos/octocat/octocat/contents/docs/profile.md'
  )
  const body = JSON.parse(String(calls[1]!.init?.body)) as { sha?: string }
  expect(body.sha).toBe('existing-file-sha')
})

test('publish uses configured publish targets and token env vars', async () => {
  const logs: string[] = []
  const calls: Array<{ url: string; init?: RequestInit }> = []
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'
  logger.configureLogger({ colors: false, write: (line) => logs.push(line) })

  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    if (url === 'https://api.github.com/graphql') {
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

    if (init?.method === 'PUT') {
      return jsonResponse({
        content: { sha: 'file-sha' },
        commit: { sha: 'commit-sha' }
      })
    }

    return new Response('{"message":"not found"}', { status: 404 })
  }

  const results = await publish.publish({
    profileConfig: profileConfig(),
    content: '# rendered\n',
    fetch
  })

  expect(results).toHaveLength(1)
  expect(calls[2]!.init?.headers).toMatchObject({
    Authorization: 'Bearer target-write-token'
  })
  expect(
    logs.some((line) => line.includes('[publish] github/octocat/octocat@main:README.md'))
  ).toBe(true)
})

test('publish reads rendered.md by default', async () => {
  const previousCwd = process.cwd()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-publish-default-'))
  fs.writeFileSync(path.join(dir, 'rendered.md'), '# rendered from file\n')
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'

  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    if (url === 'https://api.github.com/graphql') {
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

    if (init?.method === 'PUT') {
      return jsonResponse({
        content: { sha: 'file-sha' },
        commit: { sha: 'commit-sha' }
      })
    }

    return new Response('{"message":"not found"}', { status: 404 })
  }

  try {
    process.chdir(dir)
    await publish.publish({
      profileConfig: profileConfig(),
      fetch
    })
  } finally {
    process.chdir(previousCwd)
  }

  const body = JSON.parse(String(calls[2]!.init?.body)) as { content: string }
  expect(body.content).toBe(Buffer.from('# rendered from file\n', 'utf8').toString('base64'))
})

test('publish fails when target token env var is missing', async () => {
  await expect(
    publish.publish({
      profileConfig: profileConfig(),
      content: '# rendered\n',
      fetch: async () => jsonResponse({})
    })
  ).rejects.toThrow(/Missing GH_RW_REPO_TOKEN/)
})

function profileConfig(): ProfileConfig {
  return {
    displayName: 'Example User',
    identities: [
      {
        provider: 'github',
        externalId: 'U_TEST_1',
        loginHint: 'octocat',
        tokenEnv: 'GH_RO_CLASSIC_TOKEN',
        organizationTokens: [],
        ignoreOrganizations: [],
        ignoreRepositories: []
      }
    ],
    publishTargets: [
      {
        provider: 'github',
        repositoryId: 'R_PROFILE_1',
        repositoryHint: 'octocat/octocat',
        branch: 'main',
        path: 'README.md',
        tokenEnv: 'GH_RW_REPO_TOKEN'
      }
    ],
    render: {
      topLanguagesCount: 7,
      topPublicProjectsCount: 6,
      lastYearWindowDays: 365
    }
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
