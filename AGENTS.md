# postman-api-onboarding-action

Composite GitHub Action -- primary partner-facing entrypoint. Chains bootstrap -> repo-sync -> (optional) insights. Contains NO runtime TypeScript; only `action.yml` wiring, tests, and type definitions.

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
npm run lint
node scripts/check-sibling-pins.mjs
```

## Key Inputs

- `project-name` (required), `spec-url` (required)
- `workspace-id`, `spec-id`, `*-collection-id` -- for existing service reruns
- `postman-access-token` (primary asset credential; every wrapped-action asset op runs through access-token gateway), `postman-api-key` (mints/re-mints access token and authenticates Postman CLI logins). Individually optional; at least one is required.
- `enable-insights` -- chains insights onboarding step
- `generate-ci-workflow`, `ci-workflow-path` -- controls CI generation in target repo

## Gotchas

- Sibling action refs are pinned; update them deliberately during coordinated releases
- Do not advance sibling immutable release pins from this composite; never log credentials from inputs
- `spec-url` is always required, even when reusing existing `spec-id` (bootstrap updates from source)
- `POSTMAN_TEAM_ID` env var is passed via `env:` block, not as input
- `package.json` version is NOT release identifier -- git tags are

## CI

`.github/workflows/ci.yml` runs one `gate` job. One runner queues at most two of
lint, typecheck, test, sibling-pins, commitlint, and actionlint. Every check
prints a `::group::` result even when another check fails.

See workspace monorepo CI doc for shared rationale.

## Releases

Tags are an **output** of passing run, never input. Never push release tag by hand; `.githooks/pre-push` rejects it.

- `.github/workflows/auto-release.yml` runs on every push to `main` and drives `scripts/release-cut.mjs`.
- `node scripts/release-cut.mjs --plan` reports pending cut (fetch tags first). `--execute` bumps `package.json`/`package-lock.json`, runs typecheck/lint/test/sibling-pins/actionlint, commits, then tags last.
- Version comes from highest tag ever cut, not `package.json`. Existing tags are burnt and skipped, so failed cut never reuses or rewinds version.
- Conventional-commit type picks bump; `chore`/`ci`/`build`/`test`/`style` alone cut nothing.
- release commit lives only on tag; `main` keeps advancing through pull requests.
- `RELEASE_POLICY.md` holds full contract.
