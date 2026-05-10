import type { RollupSource } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface DailyRepositoryActivityRow extends AuditTimestampColumns {
  account_id: number
  activity_on: Date | string
  repository_id: number
  commits: number
  lines_added: number | null
  lines_deleted: number | null
  files_changed: number | null
  prs_opened: number
  prs_merged: number
  prs_closed_unmerged: number
  pr_reviews_total: number
  pr_reviews_approved: number | null
  pr_reviews_changes_requested: number | null
  pr_reviews_commented: number | null
  issues_opened: number
  issues_closed: number
  source: RollupSource
  captured_at: Date | string
}
