export interface YearlyRepositoryActivityRow {
  account_id: number
  year_start: Date | string
  year: number
  repository_id: number
  commits: number
  lines_added: number | null
  lines_deleted: number | null
  prs_opened: number
  prs_merged: number
  pr_reviews_total: number
  issues_opened: number
  issues_closed: number
}
