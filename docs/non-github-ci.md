# Non-GitHub CI usage

On GitHub Actions, use the composite action as documented in the [README](../README.md). The CLI entry points are for GitLab CI, Bitbucket Pipelines, Azure DevOps, and other CI systems.

Install the CLIs globally:

```bash
npm install -g @postman-cse/onboarding-bootstrap @postman-cse/onboarding-repo-sync @postman-cse/onboarding-resolve-service-token
```

For CI jobs that need governance, workspace linking, or system environment association, mint a service-account access token before bootstrap:

```bash
POSTMAN_REGION="${POSTMAN_REGION:-us}"

postman-resolve-service-token \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-region "$POSTMAN_REGION" \
  > postman-token.json

POSTMAN_ACCESS_TOKEN=$(jq -r '.token' postman-token.json)
POSTMAN_TEAM_ID=$(jq -r '.["team-id"]' postman-token.json)
```

Use `POSTMAN_REGION=eu` for EU data residency and pass the same region to every Postman CLI in the pipeline.

Run bootstrap first and save its JSON output:

```bash
postman-bootstrap \
  --project-name "my-api" \
  --spec-url "https://gist.githubusercontent.com/jaredboynton/a839de57db2c3c90b8f75906c56b00ee/raw/openapi.yaml" \
  --postman-api-key "$POSTMAN_API_KEY" \
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --postman-team-id "$POSTMAN_TEAM_ID" \
  --postman-region "$POSTMAN_REGION" \
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
  --postman-access-token "$POSTMAN_ACCESS_TOKEN" \
  --postman-team-id "$POSTMAN_TEAM_ID" \
  --postman-region "$POSTMAN_REGION" \
  --result-json ./sync-result.json
```

Both CLIs support `--dotenv-path` for shell-friendly KEY=VALUE output that can be sourced with `source ./bootstrap.env`.

For Insights linking outside GitHub Actions, install `@postman-cse/onboarding-insights` and run `postman-insights-onboard` after the service has been discovered by Insights. See [postman-insights-onboarding-action/docs/cli.md](https://github.com/postman-cs/postman-insights-onboarding-action/blob/main/docs/cli.md) for the required service, workspace, and environment inputs.
