# Composite contract and output mapping

## Contract

- Default `integration-backend` is `bifrost`.
- Inputs are backend-neutral and kebab-case.
- Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
- Final outputs are surfaced from the two lower-level actions without exposing internal step mode controls.
- Collection artifacts are exported in the Postman Collection v3 multi-file YAML directory structure (produced during the repo-sync step).
- Workspace-to-repository linking supports both GitHub and GitLab (cloud and self-hosted) URLs via Bifrost.

## Output mapping

The composite action wires:

- `workspace-id`, `workspace-url`, `spec-id`, and `collections-json` from `bootstrap`.
- `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha` from `repo_sync`.
- Runner-level phase outcomes are exposed as `bootstrap-outcome`, `repo-sync-outcome`, and `insights-outcome` from step outcomes (`success`, `failure`, `cancelled`, or `skipped`).
- Existing-service passthrough inputs to `bootstrap`: `workspace-id`, `spec-id`, `baseline-collection-id`, `smoke-collection-id`, and `contract-collection-id`.
- Existing-repo passthrough inputs to `repo_sync`: `generate-ci-workflow`, `ci-workflow-path`, and `spec-path`.
- When `enable-insights: true`, the Insights onboarding step runs after repo sync using the workspace ID from bootstrap plus the first environment from `environments-json` for `environment-id` and `system-env-map-json` lookup.
- Insights domain outputs (`insights-status`, `insights-verification-token`, `insights-application-id`, `insights-discovered-service-id`, `insights-discovered-service-name`, `insights-collection-id`) are surfaced when `enable-insights: true`.
- `insights-status` remains the domain result from `steps.insights_onboarding.outputs.status`, while `insights-outcome` is the GitHub Actions step outcome for that phase.

See [action.yml](../action.yml) for exact step mappings.

## Phase outcome tracking

The composite action exposes runner-level outcome outputs for each phase so you can track partial success across bootstrap, repo sync, and optional Insights onboarding:

- `bootstrap-outcome`: Bootstrap phase outcome (`success`, `failure`, `cancelled`, or `skipped`)
- `repo-sync-outcome`: Repo sync phase outcome (`success`, `failure`, `cancelled`, or `skipped`)
- `insights-outcome`: Insights onboarding phase outcome (`success`, `failure`, `cancelled`, or `skipped`; skipped if `enable-insights: false`)

These are distinct from `insights-status`, which carries the domain result from the Insights action itself (e.g. `success`, `not-found`, `error`). See [protected-branch-workflows.md](protected-branch-workflows.md) for how phase outcomes support partial-success recovery in protected repos.

## Spec source resolution

Provide exactly one of `spec-url` (HTTPS URL) or `spec-path` (repo-relative path to a checked-out file). When reusing an existing `spec-id`, the bootstrap step still updates the Spec Hub asset from whichever source you pass.
