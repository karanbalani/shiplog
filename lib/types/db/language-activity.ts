export interface LanguageActivityRow {
  account_id: number
  year: number
  language: string
  commits: number
  lines_added: number | null
  lines_deleted: number | null
}
