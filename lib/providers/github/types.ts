export interface GitHubRepositoryOwner {
  __typename?: string
  id?: string
  login: string
  name?: string | null
  description?: string | null
  avatarUrl?: string | null
  websiteUrl?: string | null
}

export interface GitHubRepositoryNode {
  id: string
  nameWithOwner: string
  owner: GitHubRepositoryOwner
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

export interface GitHubRestRepository {
  node_id: string
  name: string
  full_name: string
  private: boolean
  fork: boolean
  archived?: boolean
  language: string | null
  stargazers_count?: number
  forks_count?: number
  created_at?: string | null
  pushed_at?: string | null
  default_branch?: string | null
  html_url?: string
  description?: string | null
  owner: {
    login: string
    node_id?: string
    type?: string
    avatar_url?: string | null
  }
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
  author: GitHubCommitActor | null
  authors: {
    nodes: GitHubCommitActor[]
  }
}

export interface GitHubCommitActor {
  name: string | null
  email: string | null
  user: {
    id: string
    login: string
  } | null
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
