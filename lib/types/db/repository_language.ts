import type { AuditTimestampColumns } from './common.ts'

export interface RepositoryLanguageRow extends AuditTimestampColumns {
  id: number
  repository_id: number
  captured_on: Date | string
  language: string
  bytes: number
  percentage: number | string
}
