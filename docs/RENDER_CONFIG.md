# Render Config

Target repositories can define their README rendering in `.shiplog/render.json`:

```text
target-profile-repo/
  .shiplog/
    render.json
  README.md
```

During `bun run publish`, shiplog renders each configured publish target independently. In GitHub Actions, the `publish` workflow runs one matrix job per target with `fail-fast` disabled, so one broken target does not stop the other target jobs. If a target repository has `.shiplog/render.json`, shiplog uses it. If the file is missing, shiplog uses the fallback config bundled in this repository at `.shiplog/render.json`. If the file exists but is invalid, that target job fails so the broken custom config can be fixed.

Every rendered README gets this footer automatically:

```md
<sub>Powered by my own activity database via [shiplog](https://shiplog.karanbalani.tech).</sub>
```

## Shape

```json
{
  "version": 1,
  "queries": {
    "repositories": {
      "mode": "many",
      "sql": "SELECT r.full_name, r.web_url, SUM(d.commits)::int AS commits FROM daily_repository_activity d JOIN repositories r ON r.id = d.repository_id GROUP BY r.id, r.full_name, r.web_url ORDER BY commits DESC LIMIT 10"
    }
  },
  "markdown": [
    {
      "type": "heading",
      "level": 1,
      "text": "Hi, I'm {{ profile.displayName }}"
    },
    {
      "type": "table",
      "query": "repositories",
      "columns": [
        { "label": "Repository", "value": "[{{ full_name }}]({{ web_url }})" },
        { "label": "Commits", "value": "{{ commits }}" }
      ]
    }
  ]
}
```

## Queries

`queries` is a map of query names to SQL.

- `mode: "one"` exposes the first row as an object, for example `{{ summary.commits }}`.
- `mode: "many"` exposes all rows as an array for `table` and `list` blocks.

Shiplog does not inject built-in SQL parameters. Write normal Postgres SQL against the Shiplog database tables. For dates, use Postgres expressions such as `CURRENT_DATE - INTERVAL '30 days'`. For account filtering, query the `accounts` table directly.

Queries must be read-only. They must start with `SELECT` or `WITH`, contain one statement, and cannot include writable SQL keywords such as `INSERT`, `UPDATE`, `DELETE`, `ALTER`, `DROP`, or `CREATE`.

Examples:

```sql
-- All tracked accounts
SELECT id, provider, external_login, external_id
FROM accounts
ORDER BY provider, external_login;
```

```sql
-- Activity for one account
SELECT COALESCE(SUM(d.commits), 0)::int AS commits
FROM daily_repository_activity d
WHERE d.account_id = (
  SELECT id
  FROM accounts
  WHERE provider = 'github'
    AND external_login = 'octocat'
);
```

```sql
-- Recent public repository activity
SELECT r.full_name, r.web_url, COALESCE(SUM(d.commits), 0)::int AS commits
FROM daily_repository_activity d
JOIN repositories r ON r.id = d.repository_id
WHERE d.activity_on >= CURRENT_DATE - INTERVAL '365 days'
  AND r.visibility = 'public'
  AND r.redacted = false
GROUP BY r.id, r.full_name, r.web_url
ORDER BY commits DESC
LIMIT 10;
```

## Blocks

`heading`:

```json
{ "type": "heading", "level": 2, "text": "Projects" }
```

`paragraph`:

```json
{ "type": "paragraph", "text": "I shipped {{ summary.commits }} commits." }
```

`table`:

```json
{
  "type": "table",
  "query": "repositories",
  "columns": [
    { "label": "Repository", "value": "[{{ full_name }}]({{ web_url }})" },
    { "label": "Commits", "value": "{{ commits }}" }
  ]
}
```

`list`:

```json
{
  "type": "list",
  "query": "accounts",
  "value": "[{{ provider }}/{{ external_login }}]({{ external_url }})"
}
```

`rawMarkdown`:

```json
{ "type": "rawMarkdown", "content": "<!-- any markdown or HTML -->" }
```

`divider`:

```json
{ "type": "divider" }
```

## Full Example

```json
{
  "version": 1,
  "queries": {
    "summary": {
      "mode": "one",
      "sql": "SELECT COALESCE(SUM(commits), 0)::int AS commits, COALESCE(SUM(prs_opened), 0)::int AS pull_requests FROM daily_repository_activity"
    },
    "repositories": {
      "mode": "many",
      "sql": "SELECT r.full_name, r.web_url, COALESCE(SUM(d.commits), 0)::int AS commits FROM daily_repository_activity d JOIN repositories r ON r.id = d.repository_id WHERE d.activity_on >= CURRENT_DATE - INTERVAL '365 days' AND r.visibility = 'public' AND r.redacted = false GROUP BY r.id, r.full_name, r.web_url ORDER BY commits DESC LIMIT 10"
    },
    "languages": {
      "mode": "many",
      "sql": "SELECT r.primary_language AS language, COALESCE(SUM(d.commits), 0)::int AS commits FROM daily_repository_activity d JOIN repositories r ON r.id = d.repository_id WHERE d.activity_on >= CURRENT_DATE - INTERVAL '365 days' AND r.primary_language IS NOT NULL GROUP BY r.primary_language ORDER BY commits DESC LIMIT 8"
    }
  },
  "markdown": [
    { "type": "heading", "level": 1, "text": "Hi, I'm {{ profile.displayName }}" },
    {
      "type": "paragraph",
      "text": "I have shipped {{ summary.commits }} commits and opened {{ summary.pull_requests }} PRs."
    },
    { "type": "heading", "level": 2, "text": "Projects" },
    {
      "type": "table",
      "query": "repositories",
      "columns": [
        { "label": "Repository", "value": "[{{ full_name }}]({{ web_url }})" },
        { "label": "Commits", "value": "{{ commits }}" }
      ]
    },
    { "type": "heading", "level": 2, "text": "Languages" },
    {
      "type": "list",
      "query": "languages",
      "value": "{{ language }} - {{ commits }} commits"
    }
  ]
}
```
