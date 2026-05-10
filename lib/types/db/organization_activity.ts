export interface OrganizationActivityRow {
  account_id: number
  year: number
  organization_id: number
  commits: number
  lines_added: number | null
  lines_deleted: number | null
  prs_opened: number
  prs_merged: number
  pr_reviews_total: number
  active_repositories: number
}
