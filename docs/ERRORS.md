# Workflow error codes

Shiplog GitHub Actions summaries use stable error codes so a run can explain a failure without exposing tokens, connection strings, raw HTTP responses, stack traces, or private repository names. A GitHub diagnostic may identify the affected configuration by its validated token environment-variable name and show whether it was a warning or error; it never includes the token value. Open the failed step for the final safe log message, then use the matching remediation below.

Recovered conditions appear as warnings. A warning does not turn the job red and does not roll back valid activity. Failures remain failures; writing the summary is always best-effort and never changes a job's result.

## `SHIPLOG-CONFIG-001` — Invalid or missing Shiplog configuration

<a id="shiplog-config-001"></a>

Shiplog could not load a valid configuration for this run.

- Check that the repository variable `SHIPLOG_CONFIG_BASE64` exists and is valid base64.
- Decode it locally and validate `shiplog.config.json` against `schemas/shiplog.config.schema.json`.
- Correct account IDs, token environment names, ignore lists, or publish targets, then rerun.

Data effect: collection or publishing did not start, and no progress checkpoint was advanced.

## `SHIPLOG-SECRET-001` — Required repository secret is missing

<a id="shiplog-secret-001"></a>

A required Actions secret was absent or empty.

- Open the failed export or database setup step to identify the missing secret name.
- Add that exact name under the repository's Actions secrets.
- Rerun the workflow. Never paste the secret value into logs or an issue.

Data effect: the affected operation did not start, and no progress checkpoint was advanced.

## `SHIPLOG-GITHUB-AUTH-001` — GitHub rejected a configured token

<a id="shiplog-github-auth-001"></a>

A GitHub token was expired, revoked, malformed, or lacked access to the requested scope.

- Replace or reauthorize the affected token.
- Use the summary's `Token env` context to identify the exact Actions secret name. Never paste its value into logs or an issue.
- Confirm that it can read the configured account, organization, and repositories.
- Save it under the same Actions secret name and rerun.

An optional organization-token rejection is warning-only. During historical backfill, an isolated rejection inside one private-repository request is also warning-only when an immediate account check confirms the primary token still works; Shiplog preserves the repository cursor and defers that repository. A primary token rejected during account validation remains a failure.

Data effect: activity requiring that token was not collected. Successfully committed work from other scopes remains intact.

## `SHIPLOG-GITHUB-STATS-001` — Optional commit statistics were unavailable

<a id="shiplog-github-stats-001"></a>

GitHub could not calculate additions, deletions, or changed-file statistics for one or more commits. This can happen for unusually large diffs or temporary GitHub service failures.

- No immediate action is required.
- Core commit identity, authorship, repository, date, and message are still collected.
- Recent dates retry automatically during freshness's rolling lookback.
- For an older contribution-visible commit, dispatch `integrity` with `operation=repair` and the affected `repair_date`, or use `repair_from` and `repair_to` for a range, after GitHub recovers.
- Deep-only or private historical commits omitted from GitHub's contribution groups are not automatically re-queried after their core backfill checkpoint. Their optional metrics may remain `null`; intentionally reopening backfill state is an advanced manual recovery, not a routine requirement.

Data effect: core activity and its checkpoint were preserved. Existing known statistics are retained; unavailable new values are stored as `null`, never as zero.

## `SHIPLOG-GITHUB-RATE-001` — GitHub API rate limit was reached

<a id="shiplog-github-rate-001"></a>

The active GitHub token had no remaining API capacity for the operation.

- Wait until GitHub reports that the limit has reset, then rerun.
- Avoid overlapping collection and history runs for the same installation.
- If this repeats, use an appropriate token with sufficient API capacity.

Data effect: the current scope stopped before its checkpoint advanced. Previously saved activity remains intact.

## `SHIPLOG-DB-CONNECTION-001` — Database was unavailable

<a id="shiplog-db-connection-001"></a>

Shiplog could not establish a usable Postgres connection.

- Verify the `DATABASE_CONNECTION_STRING` Actions secret without printing it.
- Check database availability, network access rules, and provider status.
- Rerun after connectivity is restored.

Data effect: no new activity was saved and no progress checkpoint was advanced.

## `SHIPLOG-DB-MIGRATION-001` — Database migration failed

<a id="shiplog-db-migration-001"></a>

The database schema could not be brought to the version required by the checked-out Shiplog revision.

- Inspect the migration step for the migration filename and safe database error.
- Resolve schema drift, database permissions, or an interrupted prior migration.
- Run migrations successfully before collecting or publishing.

Data effect: collection or publishing did not start. Existing activity and checkpoints are not intentionally changed by the summary layer.

## `SHIPLOG-MAINTENANCE-001` — Maintenance operation failed

<a id="shiplog-maintenance-001"></a>

A queued repair, drift check, or housekeeping operation did not complete.

- Open the named maintenance step and resolve its documented prerequisite.
- Rerun the same workflow; unfinished queued work remains retryable.
- Do not reset successful or unrelated maintenance tasks.

Data effect: successfully committed activity and checkpoints remain intact.

## `SHIPLOG-PUBLISH-001` — Publishing failed

<a id="shiplog-publish-001"></a>

Shiplog could not build a publish target or update its rendered README.

- Validate the configured publish target and write-token secret.
- Confirm repository access and branch protection rules permit the update.
- Rerun publish after correcting the target-specific problem.

Data effect: collected database activity is unchanged. The target README may continue to show the previous render.

## `SHIPLOG-UNKNOWN-001` — Unexpected workflow failure

<a id="shiplog-unknown-001"></a>

The workflow failed in a way Shiplog could not classify safely.

- Open the named failed step and use its final safe error message for diagnosis.
- Retry once if the failure is clearly transient.
- If it repeats, report the workflow name, stable error code, run URL, and failed step. Do not include secrets or raw private-repository data.

Data effect: assume the current operation did not reach its next checkpoint. Previously committed data remains intact.

## Diagnostic file format

Commands can append a diagnostic to the path in `SHIPLOG_DIAGNOSTICS_PATH`. When that variable is absent, Shiplog uses `$RUNNER_TEMP/shiplog-diagnostics.jsonl`. Each line contains only a version, stable code, severity, stable step ID, recovery flag, and timestamp. The diagnostic API deliberately does not accept free-form errors or resource names.

The final `if: always()` summary step reads this file and GitHub's step conclusions. If an earlier step failed before it could record a code, Shiplog selects the safest code from the failed step ID and falls back to `SHIPLOG-UNKNOWN-001`.

GitHub cannot write a job summary when a workflow is invalid and never starts, no runner is assigned, or a hard cancellation terminates the runner before the final step. Those platform-level cases must be diagnosed from the run banner or workflow validation error.
