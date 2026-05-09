export type Provider = 'github' | 'gitlab' | 'bitbucket' | 'gitea'

export type EventSource = 'live' | 'self_backfill' | 'external_import'
export type RollupSource = 'live_rollup' | 'self_backfill' | 'external_import'

export type Visibility = 'public' | 'private' | 'unknown'
export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED'
export type IssueState = 'OPEN' | 'CLOSED'
export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING'
