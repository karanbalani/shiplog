import type { Visibility } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface RepositorySnapshotRow extends AuditTimestampColumns {
  id: number
  repository_id: number
  captured_on: Date | string
  star_count: number | null
  fork_count: number | null
  is_archived: boolean | null
  visibility: Visibility | null
}
