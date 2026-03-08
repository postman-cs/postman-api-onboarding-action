# postman-api-onboarding-action

Public beta composite GitHub Action that orchestrates Postman onboarding by chaining:

- `postman-cs/postman-bootstrap-action@v0`
- `postman-cs/postman-repo-sync-action@v0`

This is the primary partner-facing entrypoint for the beta suite.

For existing services, the composite action can target an existing workspace/spec/collection set and can suppress or redirect generated CI workflow output for repos that already have their own pipeline layout.

## Contract

- Default `integration-backend` is `bifrost`.
- Inputs are backend-neutral and kebab-case.
- Bootstrap outputs are explicitly mapped into repo-sync inputs in `action.yml`.
- Final outputs are surfaced from the two lower-level actions without exposing internal step mode controls.

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

Even when reusing an existing `spec-id`, the composite action still requires `spec-url` because the bootstrap step updates the existing Spec Hub asset from that source of truth.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `workspace-id` | | Reuse an existing Postman workspace through the bootstrap step. |
| `spec-id` | | Update an existing Postman spec instead of creating a new one. |
| `baseline-collection-id` | | Reuse an existing baseline collection. |
| `smoke-collection-id` | | Reuse an existing smoke collection. |
| `contract-collection-id` | | Reuse an existing contract collection. |
| `generate-ci-workflow` | `true` | Pass through to repo sync; set `false` for repos that already manage CI. |
| `ci-workflow-path` | `.github/workflows/ci.yml` | Pass through to repo sync to redirect generated workflow output. |
| `project-name` | | Service name used across bootstrap and repo sync. |
| `domain` | | Business domain used for governance assignment. |
| `domain-code` | | Short prefix used in workspace naming. |
| `requester-email` | | Optional workspace invite target. |
| `workspace-admin-user-ids` | | Optional comma-separated workspace admin IDs. |
| `spec-url` | | Required registry-backed OpenAPI document URL. |
| `environments-json` | `["prod"]` | Environment slugs to materialize downstream. |
| `system-env-map-json` | `{}` | Map of environment slug to system environment ID. |
| `governance-mapping-json` | `{}` | Map of domain to governance group name. |
| `env-runtime-urls-json` | `{}` | Map of environment slug to runtime base URL. |
| `postman-api-key` | | Required for bootstrap and repo sync Postman operations. |
| `postman-access-token` | | Enables governance assignment and Bifrost integration work. |
| `github-token` | | Enables repository variable persistence and generated commits. |
| `gh-fallback-token` | | Optional fallback token for workflow and variable APIs. |
| `github-auth-mode` | `github_token_first` | GitHub auth mode for repository APIs. |
| `repo-write-mode` | `commit-and-push` | Repo mutation mode passed to repo sync. |
| `current-ref` | | Optional explicit ref override for detached checkouts. |
| `committer-name` | `Postman FDE` | Commit author name for generated sync commits. |
| `committer-email` | `fde@postman.com` | Commit author email for generated sync commits. |
| `integration-backend` | `bifrost` | Current public beta backend. |

### Obtaining `postman-api-key`

The `postman-api-key` is a Postman API key (PMAK) used for all standard Postman API operations — creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

**To generate one:**

1. Open the Postman desktop app or web UI.
2. Go to **Settings** (gear icon) → **Account Settings** → **API Keys**.
3. Click **Generate API Key**, give it a label, and copy the key (starts with `PMAK-`).
4. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** The PMAK is a long-lived key tied to your Postman account. It does not require periodic renewal like the `postman-access-token`.

### Obtaining `postman-access-token` (Beta)

> **⚠️ Beta limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA.

The `postman-access-token` is a Postman session token (`x-access-token`) required for internal API operations that the standard PMAK API key cannot perform — specifically workspace ↔ repo git sync (Bifrost), governance group assignment, and system environment associations. Without it, those steps are silently skipped during the onboarding pipeline.

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

> **Note:** `postman login --with-api-key` stores a PMAK — **not** the session token these APIs require. You must use the interactive browser login.

## Output Mapping

The composite action wires:

- `workspace-id`, `workspace-url`, `spec-id`, and `collections-json` from `bootstrap`.
- `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha` from `repo_sync`.
- Existing-service passthrough inputs to `bootstrap`: `workspace-id`, `spec-id`, `baseline-collection-id`, `smoke-collection-id`, and `contract-collection-id`.
- Existing-repo passthrough inputs to `repo_sync`: `generate-ci-workflow` and `ci-workflow-path`.

See [action.yml](/Users/jaredboynton/__devlocal/postman-api-onboarding-action/action.yml) for exact step mappings.

## Local Development

```bash
npm install
npm test
```

## Beta Release Strategy

- Beta channel tags use `v0.x.y`.
- Consumers can pin immutable tags such as `v0.2.0` for reproducibility.
- Moving tag `v0` is used only as the rolling beta channel.

## REST Migration Seam

This composite interface is backend-neutral and only passes stable inputs and outputs between bootstrap and repo-sync. `integration-backend` defaults to `bifrost` now, and future REST migration should occur inside the lower-level actions without changing this composite contract.

Migration details are documented in [REST_MIGRATION_SEAM.md](/Users/jaredboynton/__devlocal/postman-api-onboarding-action/REST_MIGRATION_SEAM.md).
