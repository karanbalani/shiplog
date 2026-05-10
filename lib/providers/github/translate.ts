import type { NewCommitRow, NewOrganizationRow, NewRepositoryRow } from '../../upserts.ts'
import type { GitHubCommitNode, GitHubRepositoryNode, GitHubRepositoryOwner } from './types.ts'

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
  accountId: number,
  repositoryId: number,
  source: NewCommitRow['source']
): NewCommitRow {
  return {
    account_id: accountId,
    repository_id: repositoryId,
    oid: node.oid,
    committed_on: node.committedDate.slice(0, 10),
    committed_at: node.committedDate,
    additions: node.additions,
    deletions: node.deletions,
    changed_files: node.changedFiles,
    message_headline: node.messageHeadline,
    source
  }
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
