-- migrate:up
CREATE VIEW v_organization_activity AS
SELECT
  d.account_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  )::int AS YEAR,
  r.organization_id,
  SUM(d.commits) AS commits,
  SUM(d.lines_added) AS lines_added,
  SUM(d.lines_deleted) AS lines_deleted,
  SUM(d.prs_opened) AS prs_opened,
  SUM(d.prs_merged) AS prs_merged,
  SUM(d.pr_reviews_total) AS pr_reviews_total,
  COUNT(DISTINCT r.id) AS active_repositories
FROM
  daily_repository_activity d
  JOIN repositories r ON r.id = d.repository_id
WHERE
  r.organization_id IS NOT NULL
GROUP BY
  d.account_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  ),
  r.organization_id;

-- migrate:down
DROP VIEW v_organization_activity;
