export interface UserYearlyActivityRow {
  user_id: number
  year: number
  commits: number
  lines_added: number | null
  lines_deleted: number | null
  prs_opened: number
  prs_merged: number
  pr_reviews_total: number
  issues_opened: number
}
