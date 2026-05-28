import { fetchJson, type Fetcher } from '../lib/http.ts'

type IdentityKind =
  | 'user'
  | 'organization'
  | 'organization-pat-token'
  | 'repository'
  | 'publish-target'
const BASE_URL = 'https://api.github.com'

export interface IdentityRunOptions {
  fetch?: Fetcher
  token?: string
  write?: (text: string) => void
}

interface GitHubRestIdentity {
  node_id: string
  login: string
  html_url: string
}

interface GitHubRestRepository {
  node_id: string
  full_name: string
  html_url: string
}

export async function run(
  argv = process.argv.slice(2),
  options: IdentityRunOptions = {}
): Promise<void> {
  const { provider, kind, slug } = parseArgs(argv)
  if (provider !== 'github') throw new Error(`unsupported provider in v1: ${provider}`)

  const snippet = await snippetForGitHub(kind, slug, {
    fetch: options.fetch,
    token: options.token ?? process.env.GH_RO_CLASSIC_TOKEN
  })
  const write = options.write ?? process.stdout.write.bind(process.stdout)
  write(`${JSON.stringify(snippet, null, 2)}\n`)
}

function parseArgs(argv: string[]): { provider: string; kind: IdentityKind; slug: string } {
  const [provider, maybeKind, maybeSlug] = argv
  if (!provider || !maybeKind) {
    throw new Error(usage())
  }

  if (!maybeSlug) {
    return { provider, kind: 'user', slug: maybeKind }
  }

  return { provider, kind: parseKind(maybeKind), slug: maybeSlug }
}

function parseKind(value: string): IdentityKind {
  if (value === 'user' || value === 'account' || value === 'identity') return 'user'
  if (value === 'org' || value === 'organization') return 'organization'
  if (value === 'org-pat-token' || value === 'organization-pat-token') {
    return 'organization-pat-token'
  }
  if (value === 'repo' || value === 'repository') return 'repository'
  if (value === 'publish' || value === 'publish-target' || value === 'target') {
    return 'publish-target'
  }
  throw new Error(`unsupported identity kind: ${value}\n${usage()}`)
}

async function snippetForGitHub(
  kind: IdentityKind,
  slug: string,
  options: Pick<IdentityRunOptions, 'fetch' | 'token'>
): Promise<unknown> {
  if (kind === 'user') {
    const user = await fetchGitHubUser(slug, options)
    return {
      provider: 'github',
      accountId: user.node_id,
      tokenEnv: 'GH_RO_CLASSIC_TOKEN',
      organizationPatTokens: [],
      ignore: {
        organizations: [],
        repositories: []
      }
    }
  }

  if (kind === 'organization') {
    const organization = await fetchGitHubOrganization(slug, options)
    return organization.node_id
  }

  if (kind === 'organization-pat-token') {
    const organization = await fetchGitHubOrganization(slug, options)
    return {
      organizationId: organization.node_id,
      tokenEnv: `GH_RO_${organization.login.toUpperCase().replaceAll('-', '_')}_TOKEN`
    }
  }

  if (kind === 'repository') {
    const repository = await fetchGitHubRepository(slug, options)
    return repository.node_id
  }

  const repository = await fetchGitHubRepository(slug, options)
  return {
    provider: 'github',
    repositoryId: repository.node_id,
    branch: 'main',
    path: 'README.md',
    tokenEnv: 'GH_RW_REPO_TOKEN'
  }
}

async function fetchGitHubUser(
  login: string,
  options: Pick<IdentityRunOptions, 'fetch' | 'token'>
): Promise<GitHubRestIdentity> {
  return fetchGitHubRest<GitHubRestIdentity>(`/users/${encodeURIComponent(login)}`, options)
}

async function fetchGitHubOrganization(
  login: string,
  options: Pick<IdentityRunOptions, 'fetch' | 'token'>
): Promise<GitHubRestIdentity> {
  return fetchGitHubRest<GitHubRestIdentity>(`/orgs/${encodeURIComponent(login)}`, options)
}

async function fetchGitHubRepository(
  fullName: string,
  options: Pick<IdentityRunOptions, 'fetch' | 'token'>
): Promise<GitHubRestRepository> {
  const [owner, repo] = fullName.split('/')
  if (!owner || !repo) throw new Error(`invalid GitHub repository full name: ${fullName}`)

  return fetchGitHubRest<GitHubRestRepository>(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    options
  )
}

async function fetchGitHubRest<T>(
  path: string,
  options: Pick<IdentityRunOptions, 'fetch' | 'token'>
): Promise<T> {
  return fetchJson<T>(
    `${BASE_URL}${path}`,
    {
      headers: githubHeaders(options.token)
    },
    options.fetch ? { fetch: options.fetch } : {}
  )
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'shiplog'
  }
}

function usage(): string {
  return [
    'Usage:',
    '  bun run identity github <username>',
    '  bun run identity github user <username>',
    '  bun run identity github organization <org-login>',
    '  bun run identity github organization-pat-token <org-login>',
    '  bun run identity github repository <owner/repo>',
    '  bun run identity github publish-target <owner/repo>'
  ].join('\n')
}

if (import.meta.main) {
  run().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
}
