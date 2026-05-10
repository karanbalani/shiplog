import type { EventSource } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface DailyUserSummaryRow extends AuditTimestampColumns {
  account_id: number
  activity_on: Date | string
  total_commit_contributions: number | null
  total_pull_request_contributions: number | null
  total_pull_request_review_contributions: number | null
  total_issue_contributions: number | null
  restricted_contributions_count: number | null
  source: EventSource
  captured_at: Date | string
}
