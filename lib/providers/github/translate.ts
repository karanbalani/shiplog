import type { CommitRow, RepositoryRow } from '../../types/index.ts'
import type { GitHubCommitNode, GitHubRepositoryNode } from './types.ts'

export function repositoryFromGraphQLNode(
  node: GitHubRepositoryNode,
  observedOn: string
): NewRepositoryRow {
  return {
    provider: 'github',
    external_id: node.id,
    organization_id: null,
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

export function commitFromGraphQLNode(
  node: GitHubCommitNode,
  accountId: number,
  repositoryId: number,
  source: CommitRow['source']
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

export type NewRepositoryRow = Omit<
  RepositoryRow,
  'id' | 'stable_key' | 'created_at' | 'updated_at'
>

export type NewCommitRow = Omit<CommitRow, 'id' | 'created_at' | 'updated_at' | 'captured_at'>

function repositoryName(nameWithOwner: string): string | null {
  return nameWithOwner.split('/')[1] ?? null
}
