# Credentials

## Obtaining `postman-api-key`

The `postman-api-key` is a [Postman API key](https://learning.postman.com/docs/reference/postman-api/authentication/) (PMAK) used for all standard Postman API operations: creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

For bootstrap and repo-sync CI operations, use a service-account PMAK. The same key can run the standard Postman API calls and mint the short-lived access token used by integration steps. See the [service accounts documentation](https://learning.postman.com/docs/administration/service-accounts/) for setup and assignment guidance. Insights is an exception: it requires separate human-user credentials described below.

To generate one:

1. Create or select a [Postman service account](https://learning.postman.com/docs/administration/service-accounts/) for the onboarding automation.
2. Generate a PMAK for that service account and copy the key (starts with `PMAK-`).
3. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** A personal user PMAK can still work for standard API operations, but service-account PMAKs are the supported CI credential because they can mint fresh access tokens at run time.

## Obtaining `postman-access-token`

The `postman-access-token` is required for onboarding operations that the standard PMAK API key cannot perform, specifically workspace-to-repo git sync, governance group assignment, and system environment associations. Without it, those integration steps are skipped during the onboarding pipeline.

Primary path: mint the token with [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) and feed its outputs into onboarding:

```yaml
- id: postman_token
  uses: postman-cs/postman-resolve-service-token-action@v2
  with:
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-region: us

- uses: postman-cs/postman-api-onboarding-action@v2
  with:
    project-name: core-payments
    spec-url: https://raw.githubusercontent.com/postman-cs/postman-api-onboarding-action/main/examples/core-payments-openapi.yaml
    postman-region: us
    postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
    postman-access-token: ${{ steps.postman_token.outputs.token }}
    postman-team-id: ${{ steps.postman_token.outputs.team-id }}
```

For [EU data residency](https://learning.postman.com/docs/administration/enterprise/about-eu-data-residency/), change both `postman-region` values to `eu`.

User/session access tokens from `postman login` are deprecated for CI. They expire, can belong to a different parent org than the PMAK, and should only be used as a legacy fallback while migrating to service accounts.

Legacy fallback:

1. **Log in via the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-auth/)**:
   ```bash
   postman login
   ```
   Complete the interactive sign-in.

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

> **Important:** The fallback token must come from the Postman CLI credential store populated by `postman login`. Do not paste copied cookies, DevTools values, or manually harvested session credentials into CI secrets.

> **Note:** `postman login --with-api-key` stores a PMAK, which is not the access token these APIs require.

## Team ID derivation

The service-token action emits `team-id` with the minted token. Pass it to `postman-team-id` only when a downstream org-mode integration call needs an explicit team header. When omitted, the lower-level actions can leave `x-entity-team-id` unset and let Postman resolve team context from the access token.

## Org-mode team headers

The underlying actions include the `x-entity-team-id` header on integration calls only when an explicit team override is supplied. For non-org-mode tokens, omit `postman-team-id` so the header stays unset.

The [roles and permissions](https://learning.postman.com/docs/administration/roles-and-permissions/) and [manage roles](https://learning.postman.com/docs/administration/managing-your-team/team-members/manage-roles/) docs are the source of truth for team and workspace assignment behavior.

## Credential preflight

`credential-preflight` defaults to `warn`, which logs when `postman-api-key` and `postman-access-token` resolve to different parent orgs. Set it to `enforce` to fail before workspace creation. The public values are `warn` and `enforce`; there is no opt-out mode.

## API key auto-creation

`postman-api-key` and `postman-access-token` are individually optional, but at least one is required. Access-token-only runs match the wrapped bootstrap/repo-sync contract: the composite fails in the first validation step when neither credential is present. Built-in Postman CLI smoke/contract tests still need a PMAK (they use `postman login --with-api-key`); without one the composite skips those tests with a warning. Repo sync can create or rotate a PMAK from `postman-access-token` when it encounters a clear auth failure.

## Insights credentials

When `enable-insights: true`, provide both `insights-postman-api-key` and `insights-postman-access-token`. They must be a human workspace-admin user's PMAK and session access token for the same identity. Store them as separate CI secrets, such as `POSTMAN_INSIGHTS_USER_API_KEY` and `POSTMAN_INSIGHTS_USER_ACCESS_TOKEN`.

Do not use `postman-resolve-service-token-action` outputs, a service-account PMAK, or the suite `postman-api-key` / `postman-access-token` for Insights. When Insights is disabled, both dedicated inputs may be empty.

For org-wide API key expiration, revocation, and exposed-key handling, see the [managing API keys](https://learning.postman.com/docs/administration/managing-your-team/managing-api-keys/) guide.
