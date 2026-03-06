# postman-api-onboarding-action

Public beta composite GitHub Action that orchestrates Postman onboarding by chaining:

- `postman-cs/postman-bootstrap-action@v0`
- `postman-cs/postman-repo-sync-action@v0`

This is the primary partner-facing entrypoint for the beta suite.

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
```

## Output Mapping

The composite action wires:

- `workspace-id`, `workspace-url`, `spec-id`, and `collections-json` from `bootstrap`.
- `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha` from `repo_sync`.

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
