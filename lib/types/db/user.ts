import type { AuditTimestampColumns } from './common.ts'

export interface UserRow extends AuditTimestampColumns {
  id: number
  display_name: string | null
}
