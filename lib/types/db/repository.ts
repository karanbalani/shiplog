import type { Provider, Visibility } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface RepositoryRow extends AuditTimestampColumns {
  id: number
  provider: Provider
  external_id: string
  stable_key: string
  organization_id: number | null
  owner_login: string
  name: string | null
  full_name: string | null
  web_url: string | null
  description: string | null
  visibility: Visibility
  is_fork: boolean | null
  is_archived: boolean | null
  primary_language: string | null
  default_branch: string | null
  external_created_at: Date | string | null
  external_pushed_at: Date | string | null
  first_seen_on: Date | string
  last_seen_on: Date | string
  redacted: boolean
}
