# Deferring the built-in test run

Set `skip-built-in-tests: true` when the caller workflow needs a hook between onboarding and the smoke/contract test run. The action will still bootstrap the workspace, sync the repo, materialize environments, register the mock and monitor, and (optionally) chain Insights. It just won't execute the smoke/contract collections or upload their JUnit artifact. The caller is then responsible for running the tests after whatever post-onboarding setup is required.

Common patterns that need this:

- **Bearer-token / OAuth / Auth0 / Okta / Cognito JWT**: tests require an env variable like `{{bearerToken}}` that has to be minted at run time (often per stage, often short-lived). The caller mints the token, injects it into the active environment, then runs tests.
- **mTLS / custom-CA bootstrap**: tests require client certs or CA bundles that have to be materialized onto the runner before the Postman CLI can reach the service under test.
- **Vault-hydrated secrets**: tests reference secrets that live in HashiCorp Vault, AWS Secrets Manager, Doppler, etc., and must be pulled into the env at run time.
- **Dynamic environment enrichment**: tests require values that are only knowable post-deploy (deployed image tag, ephemeral hostname, feature-flag state, etc.).

Add these steps to an Ubuntu job after checkout. Replace the project and spec path with your service's values, and insert your authentication or environment setup between onboarding and the test step. Keep `POSTMAN_REGION` aligned with the onboarding input. The runner needs `jq` (included on GitHub-hosted Ubuntu runners).

```yaml
- id: onboard
  uses: postman-cs/postman-api-onboarding-action@v3
  with:
    project-name: payments
    spec-path: openapi.yaml
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    repo-write-mode: none
    generate-ci-workflow: 'false'
    skip-built-in-tests: 'true'

# Insert your service-specific authentication or environment setup here.

- name: Run smoke and contract collections with JUnit output
  shell: bash
  env:
    POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    POSTMAN_REGION: us
    COLLECTIONS_JSON: ${{ steps.onboard.outputs.collections-json }}
    ENVIRONMENT_UIDS_JSON: ${{ steps.onboard.outputs.environment-uids-json }}
  run: |
    set -euo pipefail
    mkdir -p "$RUNNER_TEMP/postman-junit"
    if ! command -v postman >/dev/null 2>&1; then
      curl -fsSL https://dl-cli.pstmn.io/install/unix.sh | sh
      export PATH="$HOME/.postman/cli:$PATH"
    fi
    if [ "$POSTMAN_REGION" = "eu" ]; then
      postman login --with-api-key "$POSTMAN_API_KEY" --region eu >/dev/null
    else
      postman login --with-api-key "$POSTMAN_API_KEY" >/dev/null
    fi
    SMOKE=$(printf '%s' "$COLLECTIONS_JSON" | jq -r '.smoke // empty')
    CONTRACT=$(printf '%s' "$COLLECTIONS_JSON" | jq -r '.contract // empty')
    ENV_UID=$(printf '%s' "$ENVIRONMENT_UIDS_JSON" | jq -r 'to_entries | (.[0].value // empty)')
    if [ -n "$ENV_UID" ]; then ENV_FLAG=(-e "$ENV_UID"); else ENV_FLAG=(); fi
    if [ -n "$SMOKE" ]; then
      postman collection run "$SMOKE" "${ENV_FLAG[@]}" \
        --reporters cli,junit \
        --reporter-junit-export "$RUNNER_TEMP/postman-junit/smoke.xml"
    fi
    if [ -n "$CONTRACT" ]; then
      postman collection run "$CONTRACT" "${ENV_FLAG[@]}" \
        --reporters cli,junit \
        --reporter-junit-export "$RUNNER_TEMP/postman-junit/contract.xml"
    fi

- uses: actions/upload-artifact@v7.0.1
  if: always()
  with:
    name: postman-test-results
    path: ${{ runner.temp }}/postman-junit/*.xml
    if-no-files-found: ignore
```

This example provisions Postman assets but does not commit repository changes or generate another CI workflow. The runner uses the first environment in `environment-uids-json`, matching the built-in selection; choose a specific environment instead if your pipeline requires one.

Unlike the built-in warning-only run, this step fails on login, parsing, or collection errors and stops before running the next collection. `if: always()` still uploads any JUnit files already written. A PMAK is required for non-interactive Postman CLI login. With `postman-stack: beta`, use `https://dl-cli.pstmn-beta.io/install/unix.sh` for installation.

`skip-built-in-tests` defaults to `false`, so existing callers continue to get the built-in smoke/contract run and JUnit artifact upload with no change.
