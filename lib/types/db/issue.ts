import type { EventSource, IssueState } from '../domain/enums.ts'
import type { AuditTimestampColumns } from './common.ts'

export interface IssueRow extends AuditTimestampColumns {
  id: number
  account_id: number
  external_id: string
  repository_id: number
  number: number
  title: string | null
  web_url: string | null
  state: IssueState
  external_created_at: Date | string
  external_closed_at: Date | string | null
  source: EventSource
  captured_at: Date | string
}
