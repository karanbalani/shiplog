import type { AuditTimestampColumns } from './common.ts'

export type PrivateRepositoryProbeStatus = 'running' | 'matched' | 'no_match'

export interface PrivateRepositoryProbeStateRow extends AuditTimestampColumns {
  id: number
  account_id: number
  repository_external_id: string
  backfill_through_on: Date | string
  status: PrivateRepositoryProbeStatus
  commit_year: number | null
  commit_cursor: string | null
  completed_commit_years: string
  matched_at: Date | string | null
  completed_at: Date | string | null
  last_error: string | null
}
