# Postman API Onboarding

[![CI](https://github.com/postman-cs/postman-api-onboarding-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-api-onboarding-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-api-onboarding-action?sort=semver)](https://github.com/postman-cs/postman-api-onboarding-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-api)](https://www.npmjs.com/package/@postman-cse/onboarding-api) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/postman-cs/postman-api-onboarding-action/badge)](https://scorecard.dev/viewer/?uri=github.com/postman-cs/postman-api-onboarding-action)

One-step Postman onboarding for an API repo: a single composite action that bootstraps a workspace from your OpenAPI spec, syncs generated artifacts back to the repository, and optionally links Postman Insights.

## Usage

```yaml
jobs:
  onboarding:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
    steps:
      - uses: actions/checkout@v5
      - uses: postman-cs/postman-api-onboarding-action@v1
        with:
          project-name: core-payments
          spec-url: https://example.com/openapi.yaml
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

That run creates (or reuses) a Postman workspace, uploads the spec, generates baseline/smoke/contract collections, materializes environments, registers a mock and monitor, commits exported artifacts to the repo, and runs the smoke and contract collections with JUnit output. See [docs/credentials.md](docs/credentials.md) for how to obtain `postman-api-key` and the optional `postman-access-token` that unlocks governance assignment and workspace-to-repo git linking.

## Examples

### Basic onboarding with governance and environments

```yaml
- uses: actions/checkout@v5
- uses: postman-cs/postman-api-onboarding-action@v1
  with:
    project-name: core-payments
    domain: core-banking
    domain-code: AF
    requester-email: owner@example.com
    workspace-admin-user-ids: 101,102
    spec-url: https://example.com/openapi.yaml
    environments-json: '["prod","stage"]'
    system-env-map-json: '{"prod":"uuid-prod","stage":"uuid-stage"}'
    governance-mapping-json: '{"core-banking":"Core Banking"}'
    env-runtime-urls-json: '{"prod":"https://api.example.com"}'
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    gh-fallback-token: ${{ secrets.GH_FALLBACK_TOKEN }}
```

### Rerunning against an existing service

Target an existing workspace/spec/collection set and suppress generated CI workflow output for repos that already have their own pipeline layout. `spec-url` (or `spec-path`) is still required because the bootstrap step updates the Spec Hub asset from source on every run.

```yaml
- uses: actions/checkout@v5
- uses: postman-cs/postman-api-onboarding-action@v1
  with:
    project-name: core-payments
    workspace-id: ws-123
    spec-id: spec-123
    baseline-collection-id: col-baseline
    smoke-collection-id: col-smoke
    contract-collection-id: col-contract
    spec-url: https://example.com/openapi.yaml
    generate-ci-workflow: false
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
```

### Protected-branch repos: commit-only plus PR

For repositories whose branch protection requires all changes to land through pull requests, run the action with `repo-write-mode: commit-only` on a temporary sync branch, then push the branch and open a PR when `commit-sha` is non-empty. Postman provisioning succeeds independently of merge approval, and the phase outcome outputs (`bootstrap-outcome`, `repo-sync-outcome`, `insights-outcome`) tell you which half needs attention on partial failure.

```yaml
- id: onboard
  uses: postman-cs/postman-api-onboarding-action@v1
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    repo-write-mode: commit-only
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The full pattern, including sync-branch creation and programmatic PR opening, is in [docs/protected-branch-workflows.md](docs/protected-branch-workflows.md).

### Enabling Insights

When `enable-insights: true`, the action chains `postman-cs/postman-insights-onboarding-action@v1` after bootstrap and repo sync, using the workspace from bootstrap plus the first environment from `environments-json`.

```yaml
- uses: actions/checkout@v5
- uses: postman-cs/postman-api-onboarding-action@v1
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    enable-insights: true
    cluster-name: my-cluster
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ secrets.POSTMAN_ACCESS_TOKEN }}
```

### Chaining with resolve-service-token

Instead of manually extracting a session token, mint the access token and resolve the team ID with [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) and feed its outputs into onboarding:

```yaml
- uses: actions/checkout@v5
- id: token
  uses: postman-cs/postman-resolve-service-token-action@v1
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
- uses: postman-cs/postman-api-onboarding-action@v1
  with:
    project-name: core-payments
    spec-url: https://example.com/openapi.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.token.outputs.token }}
    postman-team-id: ${{ steps.token.outputs.team-id }}
```

### Deferring the built-in test run

Set `skip-built-in-tests: 'true'` when the caller workflow must perform post-onboarding setup (bearer-token minting, mTLS bootstrap, vault-hydrated secrets, dynamic env enrichment) before the smoke and contract suites can authenticate, then run the collections itself using the `collections-json` and `environment-uids-json` outputs. The full caller pattern is in [docs/deferred-tests.md](docs/deferred-tests.md).

## Inputs

<!-- inputs-table:start -->
| Name | Description | Required | Default |
| --- | --- | --- | --- |
| `workspace-id` | Existing Postman workspace ID. | no |  |
| `spec-id` | Existing Postman spec ID. | no |  |
| `baseline-collection-id` | Existing baseline collection ID. | no |  |
| `smoke-collection-id` | Existing smoke collection ID. | no |  |
| `contract-collection-id` | Existing contract collection ID. | no |  |
| `sync-examples` | Whether linked spec/collection relations should enable example syncing. | no | `true` |
| `collection-sync-mode` | Collection lifecycle policy (refresh or version). Default refresh ensures tracked collections stay in sync with the spec. | no | `refresh` |
| `spec-sync-mode` | Spec lifecycle policy (update or version). | no | `update` |
| `release-label` | Optional release label for versioned specs and collections. When omitted during versioned sync, derived from GitHub tag or branch metadata. | no |  |
| `monitor-id` | Existing smoke monitor ID. When set, the action validates and reuses this monitor instead of creating a new one. | no |  |
| `mock-url` | Existing mock server URL. When set, the action validates and reuses this mock instead of creating a new one. | no |  |
| `monitor-cron` | Cron expression for monitor scheduling (e.g. '0 */6 * * *'). When empty, the monitor is created disabled and triggered to run once per workflow invocation (and once on every subsequent run). | no |  |
| `generate-ci-workflow` | Whether to generate the CI workflow file. | no | `true` |
| `ci-workflow-path` | Path to write the generated CI workflow file. | no | `.github/workflows/ci.yml` |
| `project-name` | Service project name used across bootstrap and repo sync phases. | yes |  |
| `domain` | Business domain used for governance assignment. | no |  |
| `domain-code` | Short domain code used in workspace naming. | no |  |
| `governance-group` | Postman governance workspace group name. Overrides the postman-governance-group repository custom property and domain mapping. | no |  |
| `requester-email` | Requester email used for workspace membership. | no |  |
| `workspace-admin-user-ids` | Comma-separated workspace admin user ids. | no |  |
| `workspace-team-id` | Numeric sub-team ID for org-mode workspace creation. Required by the Postman API when the PMAK's team is scoped under an organization. | no |  |
| `spec-url` | HTTPS URL to the OpenAPI document to bootstrap. Provide either spec-url or spec-path. | no |  |
| `spec-path` | Repo-root-relative path to the local spec file. Used for repo metadata generation and, when spec-url is not provided, as the spec source for bootstrap (read directly from the checked-out workspace). | no |  |
| `environments-json` | JSON array of environment slugs to materialize. | no | `["prod"]` |
| `system-env-map-json` | JSON map of environment slug to system environment id. | no | `{}` |
| `environment-uids-json` | JSON map of environment slug to existing Postman environment UID. When provided, repo-sync reuses these environments instead of creating new ones. | no | `{}` |
| `governance-mapping-json` | JSON map of business domain to governance group name. | no | `{}` |
| `env-runtime-urls-json` | JSON map of environment slug to runtime base URL. | no | `{}` |
| `postman-api-key` | Postman API key used for bootstrap and sync operations. | yes |  |
| `postman-access-token` | Postman access token used for Bifrost and governance integration. | no |  |
| `credential-preflight` | Credential identity preflight policy forwarded to bootstrap, repo sync, and insights. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created; off skips the identity probes entirely (the reactive error guidance still applies). | no | `warn` |
| `postman-team-id` | Explicit Postman team ID override for org-mode Bifrost calls. | no |  |
| `postman-stack` | Postman stack profile. | no | `prod` |
| `github-token` | GitHub token used for repo variables and generated commits. | no |  |
| `gh-fallback-token` | Fallback GitHub token for variable and workflow-file APIs. | no |  |
| `repo-write-mode` | Repo mutation mode for generated assets and workflow files. | no | `commit-and-push` |
| `current-ref` | Explicit ref override for detached checkout push semantics. | no |  |
| `committer-name` | Commit author name for generated sync commits. | no | `Postman CSE` |
| `committer-email` | Commit author email for generated sync commits. | no | `help@postman.com` |
| `enable-insights` | Whether to enable Postman Insights. | no | `false` |
| `skip-built-in-tests` | When 'true', skip the built-in smoke and contract Postman CLI test run and JUnit artifact upload that normally happen inside this action. Set this to 'true' when the caller workflow needs to perform additional post-onboarding setup (e.g. bearer-token injection, mTLS bootstrap, vault-hydrated secrets, dynamic env enrichment) before the smoke and contract suites can authenticate successfully, and will run the tests itself afterward. Default 'false' preserves existing behavior for all current callers. | no | `false` |
| `cluster-name` | Insights cluster name passed to the downstream Insights onboarding step. | no |  |
| `integration-backend` | Integration backend used to coordinate onboarding phases. | no | `bifrost` |
| `org-mode` | Whether the Postman team uses org-mode. When true, x-entity-team-id header is included in Bifrost proxy calls. Non-org teams must omit this header. | no | `false` |
| `ssl-client-cert` | Base64-encoded PEM client certificate for mTLS. Passed through to repo-sync for CI workflow generation. | no |  |
| `ssl-client-key` | Base64-encoded PEM client private key. Passed through to repo-sync. | no |  |
| `ssl-client-passphrase` | Passphrase for encrypted private key. Passed through to repo-sync. | no |  |
| `ssl-extra-ca-certs` | Base64-encoded PEM additional CA certificates. Passed through to repo-sync. | no |  |
<!-- inputs-table:end -->

Tables are generated from `action.yml` by `npm run docs:tables`.

## Outputs

<!-- outputs-table:start -->
| Name | Description |
| --- | --- |
| `integration-backend` | Resolved integration backend for the onboarding run. |
| `workspace-id` | Postman workspace ID. |
| `workspace-url` | Postman workspace URL. |
| `spec-id` | Uploaded Postman spec ID. |
| `collections-json` | JSON summary of generated collections. |
| `environment-uids-json` | JSON map of environment slug to Postman environment uid. |
| `mock-url` | Mock server URL. |
| `monitor-id` | Smoke monitor ID. |
| `repo-sync-summary-json` | JSON summary of repo materialization and workspace sync planning. |
| `commit-sha` | Commit SHA produced by repo-write-mode. |
| `bootstrap-outcome` | GitHub Actions runner outcome for the bootstrap step. |
| `repo-sync-outcome` | GitHub Actions runner outcome for the repo sync step. |
| `insights-outcome` | GitHub Actions runner outcome for the Insights onboarding step. |
| `insights-status` | Insights onboarding status (success, not-found, error, or empty if insights disabled). |
| `insights-verification-token` | Team verification token for Insights DaemonSet configuration. |
| `insights-application-id` | Insights application binding ID. |
| `insights-discovered-service-id` | Discovered service ID from Insights agent. |
| `insights-discovered-service-name` | Discovered service name from Insights agent. |
| `insights-collection-id` | Insights API Catalog collection ID. |
<!-- outputs-table:end -->

## How it works

This is a composite action, the primary partner-facing entrypoint of the Postman onboarding suite. It chains three sibling actions in order:

1. **Bootstrap** (`postman-cs/postman-bootstrap-action`) creates or reuses the workspace, uploads the spec, and generates baseline, smoke, and contract collections.
2. **Repo sync** (`postman-cs/postman-repo-sync-action`) exports collection artifacts into the repository (Postman Collection v3 multi-file YAML), materializes environments, registers the mock server and smoke monitor, and optionally generates a CI workflow. Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
3. **Insights** (`postman-cs/postman-insights-onboarding-action`, only when `enable-insights: true`) links discovered services to the workspace.

Between repo sync and Insights, the action runs the generated smoke and contract collections with the Postman CLI and uploads JUnit results as a workflow artifact (skippable via `skip-built-in-tests`). Inputs are backend-neutral and kebab-case; the default `integration-backend` is `bifrost`. Full contract details, output mapping, and phase outcome semantics are in [docs/contract.md](docs/contract.md).

Running outside GitHub Actions (GitLab CI, Bitbucket Pipelines, Azure DevOps)? The bootstrap and repo-sync CLIs cover that: see [docs/non-github-ci.md](docs/non-github-ci.md).

Releases use immutable `v1.x.y` tags with `v1` as the rolling customer preview channel; pin an immutable tag for reproducibility. See [RELEASE_POLICY.md](RELEASE_POLICY.md).

## Resources

- Sibling actions in the onboarding suite:
  - [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action): mints the service-account access token and resolves the team ID
  - [postman-bootstrap-action](https://github.com/postman-cs/postman-bootstrap-action): workspace, spec upload, collection generation
  - [postman-repo-sync-action](https://github.com/postman-cs/postman-repo-sync-action): artifact export, environments, mocks, monitors, CI templates
  - [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action): Insights-to-workspace linking
  - [postman-smoke-flow-action](https://github.com/postman-cs/postman-smoke-flow-action): applies a curated flow.yaml to the canonical Smoke collection
  - [postman-aws-spec-discovery-action](https://github.com/postman-cs/postman-aws-spec-discovery-action): AWS API and spec discovery
- npm package: [@postman-cse/onboarding-api](https://www.npmjs.com/package/@postman-cse/onboarding-api)
- Docs in this repo: [credentials](docs/credentials.md), [contract and output mapping](docs/contract.md), [protected-branch workflows](docs/protected-branch-workflows.md), [deferred tests](docs/deferred-tests.md), [non-GitHub CI](docs/non-github-ci.md)
- Postman references: [Postman API](https://learning.postman.com/docs/developer/postman-api/intro-api/), [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-overview/), [Postman Insights](https://learning.postman.com/docs/insights/insights-overview/)

## License

[MIT](LICENSE)
