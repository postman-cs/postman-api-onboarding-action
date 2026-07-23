# Deferring the built-in test run

Set `skip-built-in-tests: true` when the caller workflow needs a hook between onboarding and the smoke/contract test run. The action will still bootstrap the workspace, sync the repo, materialize environments, register the mock and monitor, and (optionally) chain Insights. It just won't execute the smoke/contract collections or upload their JUnit artifact. The caller is then responsible for running the tests after whatever post-onboarding setup is required.

Common patterns that need this:

- **Bearer-token / OAuth / Auth0 / Okta / Cognito JWT**: tests require an env variable like `{{bearerToken}}` that has to be minted at run time (often per stage, often short-lived). The caller mints the token, injects it into the active environment, then runs tests.
- **mTLS / custom-CA bootstrap**: tests require client certs or CA bundles that have to be materialized onto the runner before the Postman CLI can reach the service under test.
- **Vault-hydrated secrets**: tests reference secrets that live in HashiCorp Vault, AWS Secrets Manager, Doppler, etc., and must be pulled into the env at run time.
- **Dynamic environment enrichment**: tests require values that are only knowable post-deploy (deployed image tag, ephemeral hostname, feature-flag state, etc.).

Caller pattern when `skip-built-in-tests: true`:

```yaml
- id: onboard
  uses: postman-cs/postman-api-onboarding-action@v2
  with:
    # ...standard inputs...
    skip-built-in-tests: 'true'

- name: Inject post-onboarding setup
  # ...mint token / hydrate secrets / fetch certs / etc.,
  # then PUT updates to the relevant Postman environments
  # via the API...

- name: Run smoke and contract collections with JUnit output
  shell: bash
  env:
    POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
    COLLECTIONS_JSON: ${{ steps.onboard.outputs.collections-json }}
    ENVIRONMENT_UIDS_JSON: ${{ steps.onboard.outputs.environment-uids-json }}
  run: |
    # postman collection run "$SMOKE"    --reporters cli,junit ...
    # postman collection run "$CONTRACT" --reporters cli,junit ...

- uses: actions/upload-artifact@v6
  if: always()
  with:
    name: postman-test-results
    path: ${{ runner.temp }}/postman-junit/*.xml
    if-no-files-found: ignore
```

The `collections-json`, `environment-uids-json`, and `workspace-id` outputs of the onboarding step expose everything a caller needs to reproduce the built-in test run on the caller's own terms.

`skip-built-in-tests` defaults to `false`, so existing callers continue to get the built-in smoke/contract run and JUnit artifact upload with no change.
