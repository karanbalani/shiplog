import type { AuditTimestampColumns } from './common.ts'

export type RepositoryBackfillStatus =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'skipped_permanent'
  | 'failed_permanent'
  | 'blocked_auth'

export interface RepositoryBackfillStateRow extends AuditTimestampColumns {
  id: number
  account_id: number
  repository_id: number
  backfill_through_on: Date | string
  status: RepositoryBackfillStatus
  completed_steps: string
  completed_at: Date | string | null
  last_error: string | null
}
