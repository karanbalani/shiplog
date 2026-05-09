import type { AuditTimestampColumns } from './common.ts'

export interface OrganizationMembershipRow extends AuditTimestampColumns {
  account_id: number
  organization_id: number
  observed_on: Date | string
  role: string | null
}
