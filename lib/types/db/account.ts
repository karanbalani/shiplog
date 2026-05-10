import type { Provider } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface AccountRow extends AuditTimestampColumns {
  id: number
  user_id: number
  provider: Provider
  external_login: string
  external_id: string
  external_url: string | null
  external_created_at: Date | string
  first_seen_on: Date | string
  backfill_completed_at: Date | string | null
  last_successful_collect_on: Date | string | null
  captured_at: Date | string
}
