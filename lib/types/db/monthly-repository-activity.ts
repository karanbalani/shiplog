export interface MonthlyRepositoryActivityRow {
  account_id: number
  month_start: Date | string
  repository_id: number
  commits: number
  lines_added: number | null
  lines_deleted: number | null
  files_changed: number | null
  prs_opened: number
  prs_merged: number
  prs_closed_unmerged: number
  pr_reviews_total: number
  pr_reviews_approved: number | null
  pr_reviews_changes_requested: number | null
  pr_reviews_commented: number | null
  issues_opened: number
  issues_closed: number
}
