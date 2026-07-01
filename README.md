# Postman API Onboarding

[![CI](https://github.com/postman-cs/postman-api-onboarding-action/actions/workflows/ci.yml/badge.svg)](https://github.com/postman-cs/postman-api-onboarding-action/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/postman-cs/postman-api-onboarding-action?sort=semver)](https://github.com/postman-cs/postman-api-onboarding-action/releases) [![npm](https://img.shields.io/npm/v/%40postman-cse%2Fonboarding-api)](https://www.npmjs.com/package/@postman-cse/onboarding-api) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Canonical entrypoint for the Postman API Onboarding suite. Use this composite action when a GitHub repository needs the full onboarding path: workspace bootstrap, OpenAPI upload, collection generation, repository artifact sync, built-in smoke and contract runs, and optional Postman Insights linking.

## Quick start

This workflow is the happy path for a new API repository. It mints a service-account access token and team ID with [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action), then feeds those outputs into this composite action. The OpenAPI fixture is public, so the workflow is paste-runnable after `POSTMAN_API_KEY` is configured.

```yaml
name: Postman API onboarding

on:
  workflow_dispatch:

jobs:
  onboarding:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
    steps:
      - uses: actions/checkout@v5

      - id: postman-token
        uses: postman-cs/postman-resolve-service-token-action@v2
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us

      - id: onboard
        uses: postman-cs/postman-api-onboarding-action@v2
        with:
          project-name: core-payments
          spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
          postman-region: us
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman-token.outputs.token }}
          postman-team-id: ${{ steps.postman-token.outputs.team-id }}
          github-token: ${{ github.token }}
```

That run creates or reuses a [Postman workspace](https://learning.postman.com/docs/collaborating-in-postman/using-workspaces/overview/), uploads the spec, generates baseline, smoke, and contract collections, materializes [environments](https://learning.postman.com/docs/use/send-requests/variables/managing-environments/), registers a [mock server](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/) and [monitor](https://learning.postman.com/docs/monitoring-your-api/intro-monitors/), commits exported artifacts to the repository, and runs the smoke and contract collections with JUnit output.

Use `postman-region: eu` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/). Keep the same region on the service-token step and the composite action.

## Which action should I use?

| Scenario | Start with | Why |
| --- | --- | --- |
| Full GitHub onboarding from an OpenAPI spec | [Postman API Onboarding](https://github.com/postman-cs/postman-api-onboarding-action) | Canonical suite entrypoint. Chains bootstrap, repo sync, tests, and optional Insights. |
| Mint an access token and resolve team ID | [Postman Onboarding: Service Token](https://github.com/postman-cs/postman-resolve-service-token-action) | Primary credential path for this composite action. Run it before onboarding. |
| Discover an OpenAPI spec from AWS | [Postman Onboarding: AWS Spec Discovery](https://github.com/postman-cs/postman-aws-spec-discovery-action) | Produces a spec URL or artifact that can feed this composite action. |
| Provision only the Postman workspace and collections | [Postman Onboarding: Workspace Bootstrap](https://github.com/postman-cs/postman-bootstrap-action) | Lower-level action for custom pipelines that do not want repo sync. |
| Apply a curated Smoke flow | [Postman Onboarding: Smoke Flow](https://github.com/postman-cs/postman-smoke-flow-action) | Standalone flow update for the canonical Smoke collection. |
| Sync generated artifacts without the composite wrapper | [Postman Onboarding: Repo Sync](https://github.com/postman-cs/postman-repo-sync-action) | Lower-level artifact, environment, mock, monitor, and CI workflow sync. |
| Link an existing workspace to Insights | [Postman Onboarding: Insights Linking](https://github.com/postman-cs/postman-insights-onboarding-action) | Lower-level Insights service-to-workspace binding. |

## Scenario guide

- [Quick start](#quick-start): new GitHub API repository with service-token credential resolution.
- [Governance and environments](#governance-and-environments): workspace ownership, governance groups, environments, and runtime URLs.
- [Existing service refresh](#existing-service-refresh): reuse known Postman asset IDs while updating the spec and generated artifacts.
- [Protected branches](#protected-branch-repos-commit-only-plus-pr): create a sync commit for a pull request instead of pushing directly.
- [Insights linking](#insights-linking): connect discovered services to the onboarded workspace.
- [AWS spec discovery](#aws-spec-discovery): discover the spec first, then feed the result into this composite action.
- [Deferred tests](#deferred-tests): skip the built-in Postman CLI run when the caller workflow must enrich auth first.
- [Support](SUPPORT.md), [security](SECURITY.md), and [release policy](RELEASE_POLICY.md): marketplace support, vulnerability reporting, and version guidance.

## Credentials and region

| Need | Inputs | Recommended source |
| --- | --- | --- |
| Postman asset operations | `postman-access-token`, `postman-team-id` | Run `postman-resolve-service-token-action` before this action and pass `steps.<id>.outputs.token` plus `steps.<id>.outputs.team-id`. This is the primary credential: every asset operation in the wrapped actions (workspace, spec, collection, environment, mock, monitor, tagging, identity) runs through the access-token gateway. |
| Token minting and Postman CLI | `postman-api-key` | Store a [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) as `POSTMAN_API_KEY`. The wrapped actions use it to mint and re-mint the access token and to authenticate the Postman CLI logins (bootstrap spec lint, repo-sync generated-CI collection run). |
| Legacy access-token fallback | `postman-access-token` | Read the access token from the [Postman CLI credential store](https://learning.postman.com/docs/postman-cli/postman-cli-auth/) populated by `postman login` only when the service-token action cannot be used. Do not use copied web-session credentials in shared workflows. |
| Data residency | `postman-region` | Use `us` by default or `eu` for [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/). Set the same region on service-token and onboarding steps. |
| Repository writes | `github-token`, `gh-fallback-token` | Use `GITHUB_TOKEN` for normal commits and variables. Add a fallback token only when workflow-file APIs require it. |
| Credential identity checks | `credential-preflight` | Use `warn` for advisory checks or `enforce` to fail before workspace creation when credentials resolve to different parent orgs. |

See [docs/credentials.md](docs/credentials.md) for detailed credential setup.

### Authentication matrix

| Credential or permission | Where it appears | Required for | Source and permissions | Expiration behavior |
| --- | --- | --- | --- | --- |
| Service-account PMAK | `POSTMAN_API_KEY`, or `POSTMAN_SERVICE_ACCOUNT_API_KEY` in AWS examples | Access-token minting and the Postman CLI logins inside the wrapped actions (bootstrap spec lint, repo-sync generated-CI collection run) | GitHub secret backed by a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) API key | Long-lived until rotated in Postman and updated in CI |
| Generated access token | `steps.postman-token.outputs.token`, passed as `postman-access-token` | Every Postman asset operation in the wrapped actions, routed through the access-token gateway (workspace, spec, collection, environment, mock, monitor, tagging, identity) | Minted by `postman-resolve-service-token-action` from the service-account PMAK | Fresh per workflow run; avoid storing unless a scheduled refresh workflow intentionally writes `POSTMAN_ACCESS_TOKEN` |
| Team ID | `steps.postman-token.outputs.team-id`, passed as `postman-team-id`; direct bootstrap workflows may use `workspace-team-id` | Org-mode integration headers and sub-team workspace creation | Emitted by `postman-resolve-service-token-action`, or stored as a repository/org variable when the sub-team is fixed | Not a secret and does not expire, but update it if the target Postman team changes |
| GitHub token | `github-token`, `gh-fallback-token`, or `${{ github.token }}` | Artifact commits, repository variables, generated workflow files, and optional secret writes | `GITHUB_TOKEN` needs `contents: write`; generated workflow updates need `actions: write`; repository secret writes need a PAT or GitHub App token with secrets write permission | `GITHUB_TOKEN` is job-scoped; PAT/App token lifetime follows its issuer policy |
| AWS OIDC | `permissions: id-token: write` plus `aws-actions/configure-aws-credentials` | AWS Spec Discovery before onboarding | GitHub OIDC role assumption with least-privilege read permissions for API Gateway, AppSync, EventBridge, Lambda, or the providers you enable | Temporary AWS credentials for the job; no static AWS key is stored |

Keep service-token, onboarding, and downstream actions on the same `postman-region`. Use `credential-preflight: enforce` when a workflow supplies both a PMAK and access token and must fail before creating assets if they resolve to different parent orgs.

## Examples

The examples below include credential resolution when they need `postman-access-token` or `postman-team-id`.

### Governance and environments

```yaml
- uses: actions/checkout@v5
- id: postman-token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    domain: core-banking
    domain-code: AF
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    environments-json: '["prod","stage"]'
    governance-mapping-json: '{"core-banking":"Core Banking"}'
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-token.outputs.token }}
    postman-team-id: ${{ steps.postman-token.outputs.team-id }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    gh-fallback-token: ${{ secrets.GH_FALLBACK_TOKEN }}
```

### Existing service refresh

Target an existing workspace/spec/collection set and suppress generated CI workflow output for repos that already have their own pipeline layout. `spec-url` (or `spec-path`) is still required because the bootstrap step updates the Spec Hub asset from source on every run.

```yaml
- uses: actions/checkout@v5
- id: postman-token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    workspace-id: ws-123
    spec-id: spec-123
    baseline-collection-id: col-baseline
    smoke-collection-id: col-smoke
    contract-collection-id: col-contract
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    generate-ci-workflow: false
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-token.outputs.token }}
    postman-team-id: ${{ steps.postman-token.outputs.team-id }}
```

### Protected-branch repos: commit-only plus PR

For repositories whose branch protection requires all changes to land through pull requests, run the action with `repo-write-mode: commit-only` on a temporary sync branch, then push the branch and open a PR when `commit-sha` is non-empty. Postman provisioning succeeds independently of merge approval, and the phase outcome outputs (`bootstrap-outcome`, `repo-sync-outcome`, `insights-outcome`) tell you which half needs attention on partial failure.

```yaml
- id: onboard
  uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    repo-write-mode: commit-only
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

The full pattern, including sync-branch creation and programmatic PR opening, is in [docs/protected-branch-workflows.md](docs/protected-branch-workflows.md).

### Insights linking

When `enable-insights: true`, the action chains `postman-cs/postman-insights-onboarding-action@v2` after bootstrap and repo sync, using the workspace from bootstrap plus the first environment from `environments-json`.

```yaml
- uses: actions/checkout@v5
- id: postman-token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    enable-insights: true
    cluster-name: my-cluster
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-token.outputs.token }}
    postman-team-id: ${{ steps.postman-token.outputs.team-id }}
```

### AWS spec discovery

Run AWS spec discovery before this composite action when the OpenAPI document should come from API Gateway or another AWS source. Feed the exported spec path into `spec-path`.

```yaml
- uses: actions/checkout@v5
- id: postman-token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- id: discover-spec
  uses: postman-cs/postman-aws-spec-discovery-action@v2
  with:
    aws-region: us-east-1
- uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    spec-path: ${{ steps.discover-spec.outputs.spec-path }}
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman-token.outputs.token }}
    postman-team-id: ${{ steps.postman-token.outputs.team-id }}
```

### Deferred tests

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
| `breaking-change-mode` | OpenAPI breaking-change comparison mode passed through to bootstrap (off, pr-native, baseline-only, or previous-spec). | no | `off` |
| `breaking-baseline-spec-path` | Repo-root-relative baseline OpenAPI spec path used by bootstrap baseline-only mode and pr-native fallback. | no |  |
| `breaking-rules-path` | Repo-root-relative openapi-changes rules file passed through to bootstrap. Missing files are ignored. | no | `changes-rules.yaml` |
| `breaking-target-ref` | Optional target branch or git ref override for bootstrap pr-native breaking-change comparisons. | no |  |
| `breaking-summary-path` | Optional markdown breaking-change report path. Defaults to a bootstrap runner-temp file. | no |  |
| `breaking-log-path` | Optional raw breaking-change log path. Defaults to a bootstrap runner-temp file. | no |  |
| `environments-json` | JSON array of environment slugs to materialize. | no | `["prod"]` |
| `system-env-map-json` | JSON map of environment slug to system environment id. | no | `{}` |
| `environment-uids-json` | JSON map of environment slug to existing Postman environment UID. When provided, repo-sync reuses these environments instead of creating new ones. | no | `{}` |
| `governance-mapping-json` | JSON map of business domain to governance group name. | no | `{}` |
| `env-runtime-urls-json` | JSON map of environment slug to runtime base URL. | no | `{}` |
| `postman-api-key` | Postman API key (PMAK). Threaded to the wrapped actions to mint and re-mint the access token and to authenticate the Postman CLI logins (bootstrap spec lint, repo-sync generated-CI collection run). | yes |  |
| `postman-access-token` | Postman access token (x-access-token). Primary credential threaded to the wrapped actions; every Postman asset operation runs through the access-token gateway. Mint it with postman-resolve-service-token-action. | no |  |
| `credential-preflight` | Credential identity preflight policy forwarded to bootstrap, repo sync, and insights. warn (default) logs a note and continues when postman-api-key and postman-access-token resolve to different parent orgs; enforce fails the run on that condition before any workspace is created. | no | `warn` |
| `postman-team-id` | Explicit Postman team ID override for org-mode integration calls. | no |  |
| `postman-region` | Postman data residency region for public API and Postman CLI calls. One of us or eu. | no | `us` |
| `github-token` | GitHub token used for repo variables and generated commits. | no |  |
| `gh-fallback-token` | Fallback GitHub token for variable and workflow-file APIs. | no |  |
| `repo-write-mode` | Repo mutation mode for generated assets and workflow files. | no | `commit-and-push` |
| `current-ref` | Explicit ref override for detached checkout push semantics. | no |  |
| `committer-name` | Commit author name for generated sync commits. | no | `Postman` |
| `committer-email` | Commit author email for generated sync commits. | no | `support@postman.com` |
| `enable-insights` | Whether to enable Postman Insights. | no | `false` |
| `skip-built-in-tests` | When 'true', skip the built-in smoke and contract Postman CLI test run and JUnit artifact upload that normally happen inside this action. Set this to 'true' when the caller workflow needs to perform additional post-onboarding setup (e.g. bearer-token injection, mTLS bootstrap, vault-hydrated secrets, dynamic env enrichment) before the smoke and contract suites can authenticate successfully, and will run the tests itself afterward. Default 'false' preserves existing behavior for all current callers. | no | `false` |
| `cluster-name` | Insights cluster name passed to the downstream Insights onboarding step. | no |  |
| `org-mode` | Whether the Postman team uses org-mode. When true, x-entity-team-id is included on integration calls. Non-org teams must omit this header. | no | `false` |
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
| `workspace-id` | Postman workspace ID. |
| `workspace-url` | Postman workspace URL. |
| `spec-id` | Uploaded Postman spec ID. |
| `collections-json` | JSON summary of generated collections. |
| `breaking-change-status` | OpenAPI breaking-change check status from bootstrap. |
| `breaking-change-summary-json` | JSON summary of the OpenAPI breaking-change check from bootstrap. |
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

1. **Bootstrap** (`postman-cs/postman-bootstrap-action`) creates or reuses the workspace, uploads the spec to [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/), and [generates](https://learning.postman.com/docs/design-apis/specifications/generate-collections/) baseline, smoke, and contract collections.
2. **Repo sync** (`postman-cs/postman-repo-sync-action`) exports [Postman Collection v3](https://learning.postman.com/docs/use/use-collections/collections-schemas/) multi-file YAML artifacts into the repository, materializes environments, registers the mock server and smoke monitor, and optionally generates a CI workflow. Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
3. **Insights** (`postman-cs/postman-insights-onboarding-action`, only when `enable-insights: true`) links [Postman Insights](https://learning.postman.com/docs/insights/overview/) discovered services to the workspace.

Between repo sync and Insights, the action runs the generated smoke and contract collections with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-collections/) and uploads [JUnit results](https://learning.postman.com/docs/postman-cli/postman-cli-reporters/) as a workflow artifact (skippable via `skip-built-in-tests`). Inputs are backend-neutral and kebab-case. Full contract details, output mapping, and phase outcome semantics are in [docs/contract.md](docs/contract.md).

Running outside GitHub Actions (GitLab CI, Bitbucket Pipelines, Azure DevOps)? The bootstrap and repo-sync CLIs cover that: see [docs/non-github-ci.md](docs/non-github-ci.md).

Releases use immutable `v1.x.y` tags with `v1` as the rolling release channel; pin an immutable tag for reproducibility. See [RELEASE_POLICY.md](RELEASE_POLICY.md).

## Resources

- npm package: [@postman-cse/onboarding-api](https://www.npmjs.com/package/@postman-cse/onboarding-api)
- Docs in this repo: [credentials](docs/credentials.md), [contract and output mapping](docs/contract.md), [protected-branch workflows](docs/protected-branch-workflows.md), [deferred tests](docs/deferred-tests.md), [non-GitHub CI](docs/non-github-ci.md)
- Marketplace docs: [support](SUPPORT.md), [security](SECURITY.md), [release policy](RELEASE_POLICY.md)
- Postman API and auth references: [Postman API](https://learning.postman.com/docs/reference/postman-api/intro-api/), [API authentication](https://learning.postman.com/docs/reference/postman-api/authentication/), [service accounts](https://learning.postman.com/docs/administration/service-accounts/), [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/)
- Postman workspace resources: [workspaces](https://learning.postman.com/docs/collaborating-in-postman/using-workspaces/overview/), [Spec Hub](https://learning.postman.com/docs/design-apis/specifications/overview/), [import a specification](https://learning.postman.com/docs/design-apis/specifications/import-a-specification/), [generate collections](https://learning.postman.com/docs/design-apis/specifications/generate-collections/), [collections](https://learning.postman.com/docs/use/use-collections/overview/), [environments](https://learning.postman.com/docs/use/send-requests/variables/managing-environments/), [mock servers](https://learning.postman.com/docs/design-apis/mock-apis/set-up-mock-servers/), [monitors](https://learning.postman.com/docs/monitoring-your-api/intro-monitors/)
- Postman CI and governance references: [Postman CLI collection runs](https://learning.postman.com/docs/postman-cli/postman-cli-collections/), [CLI reporters](https://learning.postman.com/docs/postman-cli/postman-cli-reporters/), [API governance rules](https://learning.postman.com/docs/api-governance/configurable-rules/configuring-api-governance-rules/), [Postman Insights](https://learning.postman.com/docs/insights/overview/)


## Telemetry

This composite action emits no telemetry of its own. The wired
child actions (workspace bootstrap, repo sync, and Insights onboarding) each send
a single non-identifying usage event when they complete, so the Postman team can
measure onboarding adoption across CI systems. See each child action README for
the exact event contents and the privacy basis. The `events.pm-cse.dev`
endpoint is operated by the Postman Customer Success Engineering team, and
Postman, Inc. processes the events only to measure onboarding adoption in
aggregate.

The kill switch and endpoint override are inherited by every child without extra
configuration. Set one of the following at the workflow or job level and it
reaches all child action processes:

```sh
POSTMAN_ACTIONS_TELEMETRY=off
# or the cross-tool standard
DO_NOT_TRACK=1
```

`POSTMAN_ACTIONS_TELEMETRY_ENDPOINT` is inherited the same way: events go to
`https://events.pm-cse.dev/v1/events` unless you set this variable to a collector
URL you operate at the workflow or job level.

Step-level inputs on the child steps do not strip workflow or job environment, so
no per-child configuration is needed to opt out.

## License

[MIT](LICENSE)
