export interface GitHubRepositoryNode {
  id: string
  nameWithOwner: string
  owner: { login: string }
  isPrivate: boolean
  isFork: boolean
  isArchived: boolean
  primaryLanguage: { name: string } | null
  stargazerCount?: number
  forkCount?: number
  createdAt?: string
  pushedAt?: string | null
  defaultBranchRef: { name: string } | null
  url?: string
  description?: string | null
}

export interface GitHubContributionByRepository {
  repository: GitHubRepositoryNode
  contributions: { totalCount: number }
}

export interface GitHubContributionsCollection {
  totalCommitContributions: number
  totalIssueContributions: number
  totalPullRequestContributions: number
  totalPullRequestReviewContributions: number
  restrictedContributionsCount: number
  commitContributionsByRepository: GitHubContributionByRepository[]
  pullRequestContributionsByRepository: GitHubContributionByRepository[]
  pullRequestReviewContributionsByRepository: GitHubContributionByRepository[]
  issueContributionsByRepository: GitHubContributionByRepository[]
}

export interface GitHubCommitNode {
  oid: string
  committedDate: string
  additions: number
  deletions: number
  changedFiles: number
  messageHeadline: string
}

export interface GitHubCommitHistory {
  totalCount: number
  pageInfo: {
    hasNextPage: boolean
    endCursor: string | null
  }
  nodes: GitHubCommitNode[]
}

export interface GitHubSearchPullRequestItem {
  node_id: string
  number: number
  title: string
  html_url: string
  state: 'open' | 'closed'
  created_at: string
  closed_at: string | null
  pull_request?: {
    merged_at: string | null
  }
}

export interface GitHubSearchResult<T> {
  total_count: number
  items: T[]
}

export interface GitHubReviewItem {
  node_id: string
  user: { login: string } | null
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
  submitted_at: string | null
}

export interface GitHubUserCore {
  id: string
  login: string
  name: string | null
  url: string
  createdAt: string
}
