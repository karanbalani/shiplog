-- migrate:up
CREATE VIEW v_monthly_repository_activity AS
SELECT
  account_id,
  (
    EXTRACT(
      YEAR
      FROM
        activity_on
    )::text || '-' || EXTRACT(
      MONTH
      FROM
        activity_on
    )::text || '-01'
  )::date AS month_start,
  repository_id,
  SUM(commits) AS commits,
  SUM(lines_added) AS lines_added,
  SUM(lines_deleted) AS lines_deleted,
  SUM(files_changed) AS files_changed,
  SUM(prs_opened) AS prs_opened,
  SUM(prs_merged) AS prs_merged,
  SUM(prs_closed_unmerged) AS prs_closed_unmerged,
  SUM(pr_reviews_total) AS pr_reviews_total,
  SUM(pr_reviews_approved) AS pr_reviews_approved,
  SUM(pr_reviews_changes_requested) AS pr_reviews_changes_requested,
  SUM(pr_reviews_commented) AS pr_reviews_commented,
  SUM(issues_opened) AS issues_opened,
  SUM(issues_closed) AS issues_closed
FROM
  daily_repository_activity
GROUP BY
  account_id,
  (
    EXTRACT(
      YEAR
      FROM
        activity_on
    )::text || '-' || EXTRACT(
      MONTH
      FROM
        activity_on
    )::text || '-01'
  )::date,
  repository_id;

-- migrate:down
DROP VIEW v_monthly_repository_activity;
