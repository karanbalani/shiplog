-- migrate:up
CREATE VIEW v_user_yearly_activity AS
SELECT
  a.user_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  )::int AS YEAR,
  SUM(d.commits) AS commits,
  SUM(d.lines_added) AS lines_added,
  SUM(d.lines_deleted) AS lines_deleted,
  SUM(d.prs_opened) AS prs_opened,
  SUM(d.prs_merged) AS prs_merged,
  SUM(d.pr_reviews_total) AS pr_reviews_total,
  SUM(d.issues_opened) AS issues_opened
FROM
  daily_repository_activity d
  JOIN accounts a ON a.id = d.account_id
GROUP BY
  a.user_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  );

-- migrate:down
DROP VIEW v_user_yearly_activity;
