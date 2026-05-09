import type { Provider } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface OrganizationRow extends AuditTimestampColumns {
  id: number
  provider: Provider
  external_id: string
  external_login: string
  display_name: string | null
  description: string | null
  avatar_url: string | null
  website_url: string | null
  first_seen_on: Date | string
  last_seen_on: Date | string
}
