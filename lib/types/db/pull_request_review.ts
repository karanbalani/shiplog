import type { EventSource, ReviewState } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface PullRequestReviewRow extends AuditTimestampColumns {
  id: number
  account_id: number
  external_id: string
  pull_request_id: number | null
  repository_id: number
  state: ReviewState
  submitted_at: Date | string
  submitted_on: Date | string
  source: EventSource
  captured_at: Date | string
}
