# postman-api-onboarding-action

Public open-alpha composite GitHub Action that orchestrates Postman onboarding by chaining:

- `postman-cs/postman-bootstrap-action@v0`
- `postman-cs/postman-repo-sync-action@v0`
- `postman-cs/postman-insights-onboarding-action@v0` (optional, when `enable-insights: true`)

This is the primary partner-facing entrypoint for the open-alpha suite.

For existing services, the composite action can target an existing workspace/spec/collection set and can suppress or redirect generated CI workflow output for repos that already have their own pipeline layout.

## Contract

- Default `integration-backend` is `bifrost`.
- Inputs are backend-neutral and kebab-case.
- Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
- Final outputs are surfaced from the two lower-level actions without exposing internal step mode controls.
- Collection artifacts are exported in the Postman Collection v3 multi-file YAML directory structure (produced during the repo-sync step).
- Workspace-to-repository linking supports both GitHub and GitLab (cloud and self-hosted) URLs via Bifrost.

## Usage

```yaml
jobs:
  onboarding:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-api-onboarding-action@v0
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
          # enable-insights: true  # Chain Insights onboarding after bootstrap and repo sync
          # cluster-name: my-cluster

  onboarding-existing:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
      variables: write
    steps:
      - uses: actions/checkout@v4
      - uses: postman-cs/postman-api-onboarding-action@v0
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

## Non-GitHub CI Usage

On GitHub Actions, continue using the composite action as documented above. The CLI entry points are for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

Install both CLIs globally:

```bash
npm install -g postman-bootstrap-action postman-repo-sync-action
```

Run bootstrap first and save its JSON output:

```bash
postman-bootstrap \
  --project-name "my-api" \
  --spec-url "https://registry.example.com/specs/my-api/openapi.yaml" \
  --postman-api-key "$POSTMAN_API_KEY" \
  --result-json ./bootstrap-result.json
```

Extract the outputs you need from the JSON:

```bash
WORKSPACE_ID=$(jq -r '.["workspace-id"]' bootstrap-result.json)
SMOKE_COLLECTION_ID=$(jq -r '.["smoke-collection-id"]' bootstrap-result.json)
CONTRACT_COLLECTION_ID=$(jq -r '.["contract-collection-id"]' bootstrap-result.json)
BASELINE_COLLECTION_ID=$(jq -r '.["baseline-collection-id"]' bootstrap-result.json)
```

Run repo-sync with those values:

```bash
postman-repo-sync \
  --project-name "my-api" \
  --workspace-id "$WORKSPACE_ID" \
  --baseline-collection-id "$BASELINE_COLLECTION_ID" \
  --smoke-collection-id "$SMOKE_COLLECTION_ID" \
  --contract-collection-id "$CONTRACT_COLLECTION_ID" \
  --postman-api-key "$POSTMAN_API_KEY" \
  --result-json ./sync-result.json
```

Both CLIs support `--dotenv-path` for shell-friendly KEY=VALUE output that can be sourced with `source ./bootstrap.env`.

The Insights onboarding CLI is not yet available for non-GitHub CI. See the `postman-insights-onboarding-action` repo for updates.

Even when reusing an existing `spec-id`, the composite action still requires `spec-url` because the bootstrap step updates the existing Spec Hub asset from that source of truth.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `workspace-id` | | Reuse an existing Postman workspace through the bootstrap step. |
| `spec-id` | | Update an existing Postman spec instead of creating a new one. |
| `baseline-collection-id` | | Reuse an existing baseline collection. |
| `smoke-collection-id` | | Reuse an existing smoke collection. |
| `contract-collection-id` | | Reuse an existing contract collection. |
| `sync-examples` | `true` | Whether linked spec/collection relations should enable example syncing during cloud linkage. |
| `collection-sync-mode` | `refresh` | Collection lifecycle policy. `refresh` regenerates from latest spec (default), `reuse` keeps existing, `version` creates release-scoped collections. |
| `spec-sync-mode` | `update` | Spec lifecycle policy. `update` keeps canonical spec current, `version` creates release-scoped spec. |
| `release-label` | | Optional release label for versioned specs and collections. Derived from git tag/branch when omitted. |
| `monitor-id` | | Existing smoke monitor ID. When set, the action validates and reuses this monitor instead of creating a new one. |
| `mock-url` | | Existing mock server URL. When set, the action validates and reuses this mock instead of creating a new one. |
| `monitor-cron` | `""` | Cron expression for monitor scheduling (e.g. `0 */6 * * *`). When empty, the monitor is created in a disabled state. |
| `generate-ci-workflow` | `true` | Pass through to repo sync; set `false` for repos that already manage CI. |
| `ci-workflow-path` | `.github/workflows/ci.yml` | Pass through to repo sync to redirect generated workflow output. |
| `project-name` | | Service name used across bootstrap and repo sync. |
| `domain` | | Business domain used for governance assignment. |
| `domain-code` | | Short prefix used in workspace naming. |
| `requester-email` | | Optional workspace invite target. |
| `workspace-admin-user-ids` | | Optional comma-separated workspace admin IDs. |
| `workspace-team-id` | | Numeric sub-team ID for org-mode workspace creation. |
| `spec-url` | | Required registry-backed OpenAPI document URL. |
| `spec-path` | | Optional repo-root-relative path to the local spec file used for repo metadata generation. |
| `environments-json` | `["prod"]` | Environment slugs to materialize downstream. |
| `system-env-map-json` | `{}` | Map of environment slug to system environment ID. |
| `governance-mapping-json` | `{}` | Map of domain to governance group name. |
| `env-runtime-urls-json` | `{}` | Map of environment slug to runtime base URL. |
| `postman-api-key` | | Required Postman API key for the bootstrap and sync phases. The composite always runs `postman-bootstrap-action`, which still requires a PMAK. |
| `postman-access-token` | | Enables governance assignment, Bifrost integration, and API key generation fallback. |
| `postman-team-id` | | Explicit Postman team ID override for org-mode Bifrost calls. Passed to the downstream actions when provided. |
| `github-token` | | Enables generated commits, workflow writes, and optional secret persistence in repo sync. |
| `gh-fallback-token` | | Optional fallback token for workflow and commit APIs. |
| `repo-write-mode` | `commit-and-push` | Repo mutation mode passed to repo sync. |
| `current-ref` | | Optional explicit ref override for detached checkouts. |
| `committer-name` | `Postman CSE` | Commit author name for generated sync commits. |
| `committer-email` | `help@postman.com` | Commit author email for generated sync commits. |
| `enable-insights` | `false` | When `true`, chains `postman-cs/postman-insights-onboarding-action@v0` after bootstrap and repo sync. |
| `cluster-name` | | Optional Insights cluster name passed to the downstream Insights onboarding step. |
| `integration-backend` | `bifrost` | Current public open-alpha backend. |
| `org-mode` | `false` | When `true`, includes `x-entity-team-id` header in Bifrost proxy calls. Non-org teams must omit this header. |
| `ssl-client-cert` | | Base64-encoded PEM client certificate for mTLS. Passed through to repo-sync for CI workflow SSL support. |
| `ssl-client-key` | | Base64-encoded PEM client private key. Passed through to repo-sync. |
| `ssl-client-passphrase` | | Passphrase for encrypted private key. Passed through to repo-sync. |
| `ssl-extra-ca-certs` | | Base64-encoded PEM additional CA certificates. Passed through to repo-sync. |

### Team ID derivation

Pass `postman-team-id` only when a downstream org-mode Bifrost call needs an explicit team header. When omitted, the lower-level actions can leave `x-entity-team-id` unset and let Bifrost resolve team context from the access token.

### API key auto-creation

`postman-repo-sync-action` and `postman-insights-onboarding-action` can create or rotate a PMAK from `postman-access-token` when they encounter a clear auth failure, but this composite still requires `postman-api-key` up front because `postman-bootstrap-action` cannot start without it.

### Org-mode Bifrost headers

The underlying actions include the `x-entity-team-id` header on Bifrost proxy calls only when an explicit team override is supplied. For non-org-mode tokens, omit `postman-team-id` so the header stays unset.

### Obtaining `postman-api-key`

The `postman-api-key` is a Postman API key (PMAK) used for all standard Postman API operations -- creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

**To generate one:**

1. Open the Postman desktop app or web UI.
2. Go to **Settings** (gear icon) > **Account Settings** > **API Keys**.
3. Click **Generate API Key**, give it a label, and copy the key (starts with `PMAK-`).
4. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** The PMAK is a long-lived key tied to your Postman account. It does not require periodic renewal like the `postman-access-token`.

### Obtaining `postman-access-token` (Open Alpha)

> **Open-alpha limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

The `postman-access-token` is a Postman session token (`x-access-token`) required for internal API operations that the standard PMAK API key cannot perform -- specifically workspace-to-repo git sync (Bifrost), governance group assignment, and system environment associations. Without it, those steps are silently skipped during the onboarding pipeline.

**To obtain and configure the token:**

1. **Log in via the Postman CLI** (requires a browser):
   ```bash
   postman login
   ```
   This opens a browser window for Postman's PKCE OAuth flow. Complete the sign-in.

2. **Extract the access token** from the CLI credential store:
   ```bash
   cat ~/.postman/postmanrc | jq -r '.login._profiles[].accessToken'
   ```

3. **Set it as a GitHub secret** on your repository or organization:
   ```bash
   # Repository-level secret
   gh secret set POSTMAN_ACCESS_TOKEN --repo <owner>/<repo>

   # Organization-level secret (recommended for multi-repo use)
   gh secret set POSTMAN_ACCESS_TOKEN --org <org> --visibility selected --repos <repo1>,<repo2>
   ```
   Paste the token value when prompted.

> **Important:** This token is session-scoped and will expire. When it does, operations that depend on it (workspace linking, governance, system environment associations) will silently degrade. You will need to repeat the login and secret update process. There is no automated refresh mechanism.

> **Note:** `postman login --with-api-key` stores a PMAK -- **not** the session token these APIs require. You must use the interactive browser login.

## Output Mapping

The composite action wires:

- `workspace-id`, `workspace-url`, `spec-id`, and `collections-json` from `bootstrap`.
- `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha` from `repo_sync`.
- Existing-service passthrough inputs to `bootstrap`: `workspace-id`, `spec-id`, `baseline-collection-id`, `smoke-collection-id`, and `contract-collection-id`.
- Existing-repo passthrough inputs to `repo_sync`: `generate-ci-workflow`, `ci-workflow-path`, and `spec-path`.
- When `enable-insights: true`, the Insights onboarding step runs after repo sync using the workspace ID from bootstrap plus the first environment from `environments-json` for `environment-id` and `system-env-map-json` lookup.
- Insights outputs (`insights-status`, `insights-verification-token`, `insights-application-id`, `insights-discovered-service-id`, `insights-discovered-service-name`, `insights-collection-id`) are surfaced when `enable-insights: true`.

See [action.yml](action.yml) for exact step mappings.

## Local Development

```bash
npm install
npm test
```

## Open-Alpha Release Strategy

- Open-alpha channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling open-alpha channel.

## REST Migration Seam

This composite interface is backend-neutral and only passes stable inputs and outputs between bootstrap and repo-sync. `integration-backend` defaults to `bifrost` now, and future REST migration should occur inside the lower-level actions without changing this composite contract.

Migration details are documented in [REST_MIGRATION_SEAM.md](REST_MIGRATION_SEAM.md).
