import { afterEach, beforeEach, expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as publish from '../../bin/publish.ts'
import type { Fetcher } from '../../lib/http.ts'
import * as logger from '../../lib/logger.ts'
import { fetchGitHubFileContent, publishGitHubFile } from '../../lib/providers/github/publish.ts'
import type { ShiplogConfig } from '../../lib/types/index.ts'

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

test('publishGitHubFile skips update when target content is unchanged', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const content = '# already current\n'
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      type: 'file',
      sha: 'existing-file-sha',
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
      html_url: 'https://github.com/octocat/octocat/blob/main/README.md'
    })
  }

  const result = await publishGitHubFile({
    token: 'write-token',
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: 'README.md',
    content,
    message: 'chore: update rendered readme',
    fetch
  })

  expect(calls).toHaveLength(1)
  expect(calls[0]!.url).toBe(
    'https://api.github.com/repos/octocat/octocat/contents/README.md?ref=main'
  )
  expect(calls[0]!.init?.method).toBeUndefined()
  expect(result).toMatchObject({
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: 'README.md',
    sha: 'existing-file-sha',
    commitSha: null,
    webUrl: 'https://github.com/octocat/octocat/blob/main/README.md',
    skipped: true
  })
})

test('fetchGitHubFileContent reads and decodes a target file', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetch: Fetcher = async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({
      type: 'file',
      sha: 'existing-file-sha',
      content: Buffer.from('{"version":1}\n', 'utf8').toString('base64'),
      encoding: 'base64'
    })
  }

  const content = await fetchGitHubFileContent({
    token: 'write-token',
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: '.shiplog/render.json',
    fetch
  })

  expect(content).toBe('{"version":1}\n')
  expect(calls[0]!.url).toBe(
    'https://api.github.com/repos/octocat/octocat/contents/.shiplog/render.json?ref=main'
  )
})

test('fetchGitHubFileContent returns null when the target file is missing', async () => {
  const content = await fetchGitHubFileContent({
    token: 'write-token',
    repositoryFullName: 'octocat/octocat',
    branch: 'main',
    path: '.shiplog/render.json',
    fetch: async () => new Response('{"message":"not found"}', { status: 404 })
  })

  expect(content).toBeNull()
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
    config: shiplogConfig(),
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

test('publish renders each target from that target render config', async () => {
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplog-publish-summary-'))
  const summaryPath = path.join(dir, 'summary.md')
  const published: Record<string, string> = {}

  const fetch: Fetcher = async (url, init) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { variables?: { id?: string } }
      const repository =
        body.variables?.id === 'R_PROFILE_2'
          ? {
              id: 'R_PROFILE_2',
              nameWithOwner: 'octocat/two',
              url: 'https://github.com/octocat/two'
            }
          : {
              id: 'R_PROFILE_1',
              nameWithOwner: 'octocat/one',
              url: 'https://github.com/octocat/one'
            }

      return jsonResponse({ data: { node: repository } })
    }

    if (url.includes('/contents/.shiplog/render.json?')) {
      const title = url.includes('/octocat/two/') ? 'Target Two' : 'Target One'
      return jsonResponse({
        type: 'file',
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            markdown: [
              {
                type: 'heading',
                level: 1,
                text: title
              }
            ]
          }),
          'utf8'
        ).toString('base64'),
        encoding: 'base64'
      })
    }

    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content: string }
      published[url] = Buffer.from(body.content, 'base64').toString('utf8')
      return jsonResponse({
        content: { sha: 'file-sha' },
        commit: { sha: 'commit-sha' }
      })
    }

    return new Response('{"message":"not found"}', { status: 404 })
  }

  const results = await publish.publish({
    config: multiTargetShiplogConfig(),
    summaryPath,
    fetch
  })

  expect(results).toHaveLength(2)
  expect(published['https://api.github.com/repos/octocat/one/contents/README.md']).toContain(
    '# Target One'
  )
  expect(published['https://api.github.com/repos/octocat/two/contents/PROFILE.md']).toContain(
    '# Target Two'
  )
  expect(published['https://api.github.com/repos/octocat/one/contents/README.md']).toContain(
    'Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).'
  )
  expect(published['https://api.github.com/repos/octocat/two/contents/PROFILE.md']).toContain(
    'Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).'
  )

  const summary = fs.readFileSync(summaryPath, 'utf8')
  expect(summary).toContain('## shiplog rendered README previews')
  expect(summary).toContain('<summary>octocat/one@main:README.md - updated (commit-sha)</summary>')
  expect(summary).toContain('<summary>octocat/two@main:PROFILE.md - updated (commit-sha)</summary>')
  expect(summary).toContain('```markdown\n# Target One')
  expect(summary).toContain('```markdown\n# Target Two')
})

test('publish can publish only one target index', async () => {
  process.env.GH_RW_REPO_TOKEN = 'target-write-token'
  const published: Record<string, string> = {}

  const fetch: Fetcher = async (url, init) => {
    if (url === 'https://api.github.com/graphql') {
      const body = JSON.parse(String(init?.body)) as { variables?: { id?: string } }
      expect(body.variables?.id).toBe('R_PROFILE_2')
      return jsonResponse({
        data: {
          node: {
            id: 'R_PROFILE_2',
            nameWithOwner: 'octocat/two',
            url: 'https://github.com/octocat/two'
          }
        }
      })
    }

    if (url.includes('/contents/.shiplog/render.json?')) {
      return jsonResponse({
        type: 'file',
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            markdown: [{ type: 'heading', level: 1, text: 'Only Target Two' }]
          }),
          'utf8'
        ).toString('base64'),
        encoding: 'base64'
      })
    }

    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { content: string }
      published[url] = Buffer.from(body.content, 'base64').toString('utf8')
      return jsonResponse({
        content: { sha: 'file-sha' },
        commit: { sha: 'commit-sha' }
      })
    }

    return new Response('{"message":"not found"}', { status: 404 })
  }

  const results = await publish.publish({
    config: multiTargetShiplogConfig(),
    targetIndex: 1,
    fetch
  })

  expect(results).toHaveLength(1)
  expect(published['https://api.github.com/repos/octocat/two/contents/PROFILE.md']).toContain(
    '# Only Target Two'
  )
  expect(published['https://api.github.com/repos/octocat/one/contents/README.md']).toBeUndefined()
})

test('publish reads an explicit input path for fixed-content publishing', async () => {
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
      config: shiplogConfig(),
      inputPath: 'rendered.md',
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
      config: shiplogConfig(),
      content: '# rendered\n',
      fetch: async () => jsonResponse({})
    })
  ).rejects.toThrow(/Missing GH_RW_REPO_TOKEN/)
})

function shiplogConfig(): ShiplogConfig {
  return {
    version: 1,
    profile: { displayName: 'Example User' },
    collect: {
      lookbackDays: 7,
      accounts: [
        {
          provider: 'github',
          accountId: 'U_TEST_1',
          tokenEnv: 'GH_RO_CLASSIC_TOKEN',
          organizationPatTokens: [],
          ignore: {
            organizations: [],
            repositories: []
          }
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

function multiTargetShiplogConfig(): ShiplogConfig {
  return {
    ...shiplogConfig(),
    publish: {
      targets: [
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_1',
          branch: 'main',
          path: 'README.md',
          tokenEnv: 'GH_RW_REPO_TOKEN'
        },
        {
          provider: 'github',
          repositoryId: 'R_PROFILE_2',
          branch: 'main',
          path: 'PROFILE.md',
          tokenEnv: 'GH_RW_REPO_TOKEN'
        }
      ]
    }
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
