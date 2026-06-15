# postman-api-onboarding-action

Composite GitHub Action -- the primary partner-facing entrypoint. Chains bootstrap -> repo-sync -> (optional) insights. Contains NO runtime TypeScript; only `action.yml` wiring, tests, and type definitions.

## How It Works

`action.yml` uses `runs: composite` to call sibling actions at immutable release tags:
1. `postman-bootstrap-action` -- creates workspace, uploads spec, generates collections
2. `postman-repo-sync-action` -- exports artifacts to repo, creates envs/mocks/monitors
3. `postman-insights-onboarding-action` -- (when `enable-insights: true`) links discovered services

Outputs from bootstrap are wired into repo-sync inputs in `action.yml`. Final outputs are surfaced from both lower-level actions.

## Structure

```
action.yml              # Composite step definitions and I/O wiring
tests/contract.test.ts  # Validates action.yml inputs/outputs match contract
RELEASE_POLICY.md       # Suite-wide release rules, tag policy, ordering
```

## Commands

```bash
npm ci          # Install (no build step -- composite action)
npm test        # vitest -- validates action.yml contract
npm run typecheck
```

## Key Inputs

- `project-name` (required), `spec-url` (required)
- `workspace-id`, `spec-id`, `*-collection-id` -- for existing service reruns
- `postman-api-key` (required), `postman-access-token` (for Bifrost/governance)
- `enable-insights` -- chains insights onboarding step
- `generate-ci-workflow`, `ci-workflow-path` -- controls CI generation in target repo

## Gotchas

- Sibling action refs are pinned; update them deliberately during coordinated releases
- `spec-url` is always required, even when reusing an existing `spec-id` (bootstrap updates from source)
- `POSTMAN_TEAM_ID` env var is passed via `env:` block, not as an input
- `package.json` version is NOT the release identifier -- git tags are
