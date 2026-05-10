import type { EventSource, PullRequestState } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface PullRequestRow extends AuditTimestampColumns {
  id: number
  account_id: number
  external_id: string
  repository_id: number
  number: number
  title: string | null
  web_url: string | null
  state: PullRequestState
  external_created_at: Date | string
  external_merged_at: Date | string | null
  external_closed_at: Date | string | null
  additions: number | null
  deletions: number | null
  changed_files: number | null
  commits_count: number | null
  source: EventSource
  captured_at: Date | string
}
