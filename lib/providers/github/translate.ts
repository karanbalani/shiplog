import type { NewCommitRow, NewOrganizationRow, NewRepositoryRow } from '../../upserts.ts'
import type { VendorIdentity } from '../../types/index.ts'
import type {
  GitHubCommitNode,
  GitHubRepositoryNode,
  GitHubRepositoryOwner,
  GitHubRestRepository
} from './types.ts'

export function repositoryFromGraphQLNode(
  node: GitHubRepositoryNode,
  observedOn: string,
  organizationId: number | null = null
): NewRepositoryRow {
  return {
    provider: 'github',
    external_id: node.id,
    organization_id: organizationId,
    owner_login: node.owner.login,
    name: repositoryName(node.nameWithOwner),
    full_name: node.nameWithOwner,
    web_url: node.url ?? `https://github.com/${node.nameWithOwner}`,
    description: node.description ?? null,
    visibility: node.isPrivate ? 'private' : 'public',
    is_fork: node.isFork,
    is_archived: node.isArchived,
    primary_language: node.primaryLanguage?.name ?? null,
    default_branch: node.defaultBranchRef?.name ?? null,
    external_created_at: node.createdAt ?? null,
    external_pushed_at: node.pushedAt ?? null,
    first_seen_on: observedOn,
    last_seen_on: observedOn,
    redacted: false
  }
}

export function repositoryFromRestRepository(
  repository: GitHubRestRepository
): GitHubRepositoryNode {
  return {
    id: repository.node_id,
    nameWithOwner: repository.full_name,
    owner: {
      __typename: repository.owner.type === 'Organization' ? 'Organization' : 'User',
      id: repository.owner.node_id,
      login: repository.owner.login,
      avatarUrl: repository.owner.avatar_url ?? null
    },
    isPrivate: repository.private,
    isFork: repository.fork,
    isArchived: repository.archived ?? false,
    primaryLanguage: repository.language ? { name: repository.language } : null,
    stargazerCount: repository.stargazers_count ?? 0,
    forkCount: repository.forks_count ?? 0,
    createdAt: repository.created_at ?? undefined,
    pushedAt: repository.pushed_at ?? null,
    defaultBranchRef: repository.default_branch ? { name: repository.default_branch } : null,
    url: repository.html_url ?? `https://github.com/${repository.full_name}`,
    description: repository.description ?? null
  }
}

export function organizationFromRepositoryOwner(
  owner: GitHubRepositoryOwner,
  observedOn: string
): NewOrganizationRow | null {
  if (owner.__typename !== 'Organization') return null
  if (!owner.id) throw new Error(`github organization owner ${owner.login} is missing id`)

  return {
    provider: 'github',
    external_id: owner.id,
    external_login: owner.login,
    display_name: owner.name ?? null,
    description: owner.description ?? null,
    avatar_url: owner.avatarUrl ?? null,
    website_url: owner.websiteUrl ?? null,
    first_seen_on: observedOn,
    last_seen_on: observedOn
  }
}

export function commitFromGraphQLNode(
  node: GitHubCommitNode,
  identity: VendorIdentity,
  repositoryId: number,
  source: NewCommitRow['source']
): NewCommitRow {
  return {
    account_id: identity.accountId,
    repository_id: repositoryId,
    oid: node.oid,
    committed_on: node.committedDate.slice(0, 10),
    committed_at: node.committedDate,
    additions: node.additions,
    deletions: node.deletions,
    changed_files: node.changedFiles,
    message_headline: node.messageHeadline,
    is_co_authored: isCoAuthoredByIdentity(node, identity),
    source
  }
}

export function commitIncludesIdentity(node: GitHubCommitNode, identity: VendorIdentity): boolean {
  return (
    actorMatchesIdentity(node.author, identity) ||
    node.authors.nodes.some((actor) => actorMatchesIdentity(actor, identity))
  )
}

function isCoAuthoredByIdentity(node: GitHubCommitNode, identity: VendorIdentity): boolean {
  if (!commitIncludesIdentity(node, identity)) return false
  return !actorMatchesIdentity(node.author, identity)
}

function actorMatchesIdentity(
  actor: GitHubCommitNode['author'] | GitHubCommitNode['authors']['nodes'][number],
  identity: VendorIdentity
): boolean {
  const user = actor?.user
  if (!user) return false
  return user.id === identity.externalId || user.login === identity.externalLogin
}

export interface GitHubLanguageEdge {
  size: number
  node: { name: string }
}

export interface LanguageWeight {
  language: string
  bytes: number
  percentage: number
}

export function languagesFromGraphQLEdges(edges: GitHubLanguageEdge[]): LanguageWeight[] {
  const total = edges.reduce((sum, edge) => sum + edge.size, 0)
  if (total <= 0) return []

  return edges.map((edge) => ({
    language: edge.node.name,
    bytes: edge.size,
    percentage: Number((edge.size / total).toFixed(4))
  }))
}

function repositoryName(nameWithOwner: string): string | null {
  return nameWithOwner.split('/')[1] ?? null
}
