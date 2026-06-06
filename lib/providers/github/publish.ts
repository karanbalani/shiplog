import { Buffer } from 'node:buffer'
import { fetchJson, HttpError, type Fetcher } from '../../http.ts'

const BASE_URL = 'https://api.github.com'

export interface GitHubPublishFileOptions {
  token: string
  repositoryFullName: string
  branch: string
  path: string
  content: string
  message: string
  fetch?: Fetcher
}

export interface GitHubPublishFileResult {
  repositoryFullName: string
  branch: string
  path: string
  sha: string | null
  commitSha: string | null
  webUrl: string | null
  skipped: boolean
}

interface GitHubContentResponse {
  sha?: string
  type?: string
  content?: string
  encoding?: string
  html_url?: string
}

interface GitHubPutContentResponse {
  content?: {
    sha?: string
    html_url?: string
  } | null
  commit?: {
    sha?: string
  } | null
}

export async function publishGitHubFile(
  options: GitHubPublishFileOptions
): Promise<GitHubPublishFileResult> {
  const existingFile = await fetchExistingFile(options)
  if (existingFile && existingFile.content === options.content) {
    return {
      repositoryFullName: options.repositoryFullName,
      branch: options.branch,
      path: options.path,
      sha: existingFile.sha,
      commitSha: null,
      webUrl: existingFile.webUrl,
      skipped: true
    }
  }

  const response = await fetchJson<GitHubPutContentResponse>(
    contentsUrl(options.repositoryFullName, options.path),
    {
      method: 'PUT',
      headers: githubHeaders(options.token),
      body: JSON.stringify({
        message: options.message,
        content: Buffer.from(options.content, 'utf8').toString('base64'),
        branch: options.branch,
        ...(existingFile?.sha ? { sha: existingFile.sha } : {})
      })
    },
    options.fetch ? { fetch: options.fetch } : {}
  )

  return {
    repositoryFullName: options.repositoryFullName,
    branch: options.branch,
    path: options.path,
    sha: response.content?.sha ?? null,
    commitSha: response.commit?.sha ?? null,
    webUrl: response.content?.html_url ?? null,
    skipped: false
  }
}

interface ExistingGitHubFile {
  sha: string | null
  content: string | null
  webUrl: string | null
}

async function fetchExistingFile(
  options: GitHubPublishFileOptions
): Promise<ExistingGitHubFile | null> {
  try {
    const response = await fetchJson<GitHubContentResponse>(
      contentsUrl(options.repositoryFullName, options.path, options.branch),
      {
        headers: githubHeaders(options.token)
      },
      options.fetch ? { fetch: options.fetch } : {}
    )

    if (response.type && response.type !== 'file') {
      throw new Error(
        `github publish target is not a file: ${options.repositoryFullName}/${options.path}`
      )
    }

    return {
      sha: response.sha ?? null,
      content: decodeContent(response),
      webUrl: response.html_url ?? null
    }
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) return null
    throw error
  }
}

function decodeContent(response: GitHubContentResponse): string | null {
  if (response.encoding !== 'base64' || !response.content) return null
  return Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')
}

function contentsUrl(repositoryFullName: string, filePath: string, ref?: string): string {
  const [owner, repo] = repositoryFullName.split('/')
  if (!owner || !repo) {
    throw new Error(`invalid GitHub repository full name: ${repositoryFullName}`)
  }

  const encodedPath = filePath.split('/').map(encodeURIComponent).join('/')
  const url = new URL(
    `${BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`
  )
  if (ref) url.searchParams.set('ref', ref)
  return url.toString()
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'shiplog',
    'Content-Type': 'application/json'
  }
}
