import type { AuditTimestampColumns } from './common.ts'

export interface ProfileSnapshotRow extends AuditTimestampColumns {
  id: number
  account_id: number
  captured_on: Date | string
  followers_count: number | null
  following_count: number | null
  public_repos_count: number | null
}
