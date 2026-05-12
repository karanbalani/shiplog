import type { EventSource } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface CommitRow extends AuditTimestampColumns {
  id: number
  account_id: number
  oid: string
  repository_id: number
  committed_on: Date | string
  committed_at: Date | string
  additions: number | null
  deletions: number | null
  changed_files: number | null
  message_headline: string | null
  is_co_authored: boolean
  source: EventSource
  captured_at: Date | string
}
