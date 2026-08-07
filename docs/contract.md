# Composite contract and output mapping

## Contract

- The integration backend is selected by the action defaults.
- Inputs are backend-neutral and kebab-case.
- Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
- Final outputs are surfaced from bootstrap, repo-sync, optional smoke-flow, and optional Insights onboarding without exposing internal step mode controls.
- Collection artifacts are exported in the Postman Collection v3 multi-file YAML directory structure (produced during the repo-sync step).
- Workspace-to-repository linking supports both GitHub and GitLab (cloud and self-hosted) URLs.
- `credential-preflight` accepts `warn` and `enforce` only; there is no public opt-out mode.

## Output mapping

The composite action wires:

- `workspace-id`, `workspace-url`, `spec-id`, and `collections-json` from `bootstrap`.
- `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha` from `repo_sync`.
- Runner-level phase outcomes are exposed as `bootstrap-outcome`, `repo-sync-outcome`, `smoke-flow-outcome`, and `insights-outcome` from step outcomes (`success`, `failure`, `cancelled`, or `skipped`).
- Existing-service passthrough inputs to `bootstrap`: `workspace-id`, `spec-id`, `baseline-collection-id`, `smoke-collection-id`, and `contract-collection-id`.
- Existing-repo passthrough inputs to `repo_sync`: `generate-ci-workflow`, `ci-workflow-path`, and `spec-path`.
- When `flow-path` or `flow-mode` is set, the smoke-flow step runs before repo sync, forwarding `workspace-id`, `spec-id`, and `smoke-collection-id` from bootstrap to reshape the canonical Smoke collection: from the `flow.yaml` manifest at the effective flow path when one exists, otherwise derived deterministically from `spec-path` under `flow-mode: auto` and persisted to that path (create-only, governed by `persist-derived-flow`). Repo sync commits the persisted manifest with the `postman/` tree and, because flow-enabled runs blank the prebuilt reuse manifest, exports the post-reshape Smoke collection. `flow-apply-status`, `flow-apply-summary-json`, and `derived-flow-path` surface its domain result.
- When `enable-insights: true` and `onboarding-scope: full`, the Insights onboarding step runs after repo sync using the workspace ID from bootstrap plus the first environment from `environments-json` for `environment-id` and `system-env-map-json` lookup. It is skipped during spec-only onboarding because that path intentionally does not create the required environment.
- Insights domain outputs (`insights-status`, `insights-verification-token`, `insights-application-id`, `insights-discovered-service-id`, `insights-discovered-service-name`, `insights-collection-id`) are surfaced when Insights runs.
- `insights-status` remains the domain result from `steps.insights_onboarding.outputs.status`, while `insights-outcome` is the GitHub Actions step outcome for that phase.

See [action.yml](../action.yml) for exact step mappings.

## Phase outcome tracking

The composite action exposes runner-level outcome outputs for each phase so you can track partial success across bootstrap, repo sync, optional smoke-flow, and optional Insights onboarding:

- `bootstrap-outcome`: Bootstrap phase outcome (`success`, `failure`, `cancelled`, or `skipped`)
- `repo-sync-outcome`: Repo sync phase outcome (`success`, `failure`, `cancelled`, or `skipped`)
- `smoke-flow-outcome`: Smoke-flow phase outcome (`success`, `failure`, `cancelled`, or `skipped`; skipped if neither `flow-path` nor `flow-mode` is set)
- `insights-outcome`: Insights onboarding phase outcome (`success`, `failure`, `cancelled`, or `skipped`; skipped if `enable-insights: false` or `onboarding-scope: spec-only`)

These are distinct from `insights-status`, which carries the domain result from the Insights action itself (e.g. `success`, `not-found`, `error`). See [protected-branch-workflows.md](protected-branch-workflows.md) for how phase outcomes support partial-success recovery in protected repos.

## Spec source resolution

Provide exactly one of `spec-url` (HTTPS URL) or `spec-path` (repo-relative path to a checked-out file). When reusing an existing `spec-id`, the bootstrap step still updates the Spec Hub asset from whichever source you pass.
