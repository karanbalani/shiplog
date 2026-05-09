-- migrate:up
CREATE VIEW v_language_activity AS
SELECT
  d.account_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  )::int AS YEAR,
  r.primary_language AS language,
  SUM(d.commits) AS commits,
  SUM(d.lines_added) AS lines_added,
  SUM(d.lines_deleted) AS lines_deleted
FROM
  daily_repository_activity d
  JOIN repositories r ON r.id = d.repository_id
WHERE
  r.primary_language IS NOT NULL
GROUP BY
  d.account_id,
  EXTRACT(
    YEAR
    FROM
      d.activity_on
  ),
  r.primary_language;

-- migrate:down
DROP VIEW v_language_activity;
