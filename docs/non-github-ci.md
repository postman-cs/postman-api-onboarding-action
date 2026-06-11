# Non-GitHub CI usage

On GitHub Actions, use the composite action as documented in the [README](../README.md). The CLI entry points are for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

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

The Insights onboarding CLI is not yet available for non-GitHub CI. See the [postman-insights-onboarding-action](https://github.com/postman-cs/postman-insights-onboarding-action) repo for updates.
