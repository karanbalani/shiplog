import type { AuditTimestampColumns } from './common.ts'

export type MaintenanceTaskType = 'repair_range'
export type MaintenanceTaskStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'succeeded'
  | 'failed_permanent'

export interface MaintenanceTaskRow extends AuditTimestampColumns {
  id: number
  account_id: number
  task_type: MaintenanceTaskType
  status: MaintenanceTaskStatus
  priority: number
  target_from_on: Date | string
  target_to_on: Date | string
  reason: string | null
  attempts: number
  max_attempts: number
  next_run_at: Date | string
  locked_at: Date | string | null
  started_at: Date | string | null
  completed_at: Date | string | null
  last_error: string | null
}
