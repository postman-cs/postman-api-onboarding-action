# Credentials

## Obtaining `postman-api-key`

The `postman-api-key` is a Postman API key (PMAK) used for all standard Postman API operations: creating workspaces, uploading specs, generating collections, exporting artifacts, and managing environments.

To generate one:

1. Open the Postman desktop app or web UI.
2. Go to **Settings** (gear icon) > **Account Settings** > **API Keys**.
3. Click **Generate API Key**, give it a label, and copy the key (starts with `PMAK-`).
4. Set it as a GitHub secret:
   ```bash
   gh secret set POSTMAN_API_KEY --repo <owner>/<repo>
   ```

> **Note:** The PMAK is a long-lived key tied to your Postman account. It does not require periodic renewal like the `postman-access-token`.

## Obtaining `postman-access-token` (Customer Preview)

> **Customer Preview limitation:** The `postman-access-token` input requires a manually-extracted session token. There is currently no public API to exchange a Postman API key (PMAK) for an access token programmatically. This manual step will be eliminated before GA. The [postman-resolve-service-token-action](https://github.com/postman-cs/postman-resolve-service-token-action) can mint this token from a service-account PMAK; see the README Examples.

The `postman-access-token` is a Postman session token (`x-access-token`) required for internal API operations that the standard PMAK API key cannot perform, specifically workspace-to-repo git sync (Bifrost), governance group assignment, and system environment associations. Without it, those steps are silently skipped during the onboarding pipeline.

To obtain and configure the token:

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

> **Note:** `postman login --with-api-key` stores a PMAK, which is not the session token these APIs require. You must use the interactive browser login.

## Team ID derivation

Pass `postman-team-id` only when a downstream org-mode Bifrost call needs an explicit team header. When omitted, the lower-level actions can leave `x-entity-team-id` unset and let Bifrost resolve team context from the access token.

## Org-mode Bifrost headers

The underlying actions include the `x-entity-team-id` header on Bifrost proxy calls only when an explicit team override is supplied. For non-org-mode tokens, omit `postman-team-id` so the header stays unset.

## API key auto-creation

`postman-repo-sync-action` and `postman-insights-onboarding-action` can create or rotate a PMAK from `postman-access-token` when they encounter a clear auth failure, but this composite still requires `postman-api-key` up front because `postman-bootstrap-action` cannot start without it.
