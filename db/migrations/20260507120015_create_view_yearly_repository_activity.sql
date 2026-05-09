-- migrate:up
CREATE VIEW v_yearly_repository_activity AS
SELECT
  account_id,
  (
    EXTRACT(
      YEAR
      FROM
        activity_on
    )::text || '-01-01'
  )::date AS year_start,
  EXTRACT(
    YEAR
    FROM
      activity_on
  )::int AS YEAR,
  repository_id,
  SUM(commits) AS commits,
  SUM(lines_added) AS lines_added,
  SUM(lines_deleted) AS lines_deleted,
  SUM(prs_opened) AS prs_opened,
  SUM(prs_merged) AS prs_merged,
  SUM(pr_reviews_total) AS pr_reviews_total,
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
    )::text || '-01-01'
  )::date,
  EXTRACT(
    YEAR
    FROM
      activity_on
  ),
  repository_id;

-- migrate:down
DROP VIEW v_yearly_repository_activity;
