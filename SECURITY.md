# Security Policy

## Supported Versions

Only the latest `v1.x.y` release (tracked by the rolling `v1` alias) receives security fixes. Older tags remain published for reproducibility and are never retroactively modified.

## Credential Handling

This composite action accepts credentials and forwards them to the lower-level onboarding actions it chains.

| Credential | Purpose | Guidance |
| --- | --- | --- |
| `postman-api-key` | Standard Postman API operations, including workspace, spec, collection, environment, mock, and monitor management. | Store it as a GitHub secret. Never echo it in caller workflow steps. |
| `postman-access-token` | Governance and workspace linking for bootstrap and repo sync. | Prefer `postman-resolve-service-token-action` and pass its `token` output into this action. |
| `insights-postman-api-key` | Human-user PMAK for optional Insights linking. | Required with `insights-postman-access-token` only when `enable-insights: true`; store as a separate secret and never substitute the suite service-account key. |
| `insights-postman-access-token` | Human-user session access token for optional Insights linking. | Required with `insights-postman-api-key` only when `enable-insights: true`; store as a separate secret and never use a minted service token. |
| `postman-team-id` | Explicit team context for org-mode integration calls. | Prefer `postman-resolve-service-token-action` and pass its `team-id` output into this action. |
| `postman-region` | Data residency region for Postman API and Postman CLI calls. | Use `us` or `eu`; keep the same region on service-token and onboarding steps. |

Service-token minting remains the primary CI path for bootstrap and repo sync. Insights is the exception: it requires a dedicated human-user PMAK and session access token for the same workspace-admin identity. Do not reuse copied web-session credentials for suite operations.

## Reporting a Vulnerability

Please do not open a public issue for security reports.

- Preferred: use GitHub private vulnerability reporting on this repository (Security tab, "Report a vulnerability").
- Alternative: email [security@postman.com](mailto:security@postman.com) and mention the repository name.

You should receive an acknowledgement within five business days. Please include reproduction steps, the action version tag or SHA, the Postman region, and any relevant redacted workflow logs.

## Scope Notes

- This action handles Postman API keys and access tokens. Both are masked in logs by the action itself; never echo them in your own workflow steps.
- This composite action chains sibling actions. If the issue appears only when the composite action wires those steps together, report it here. If it is isolated to a lower-level action, mention that action in the report.
- Reports about secrets exposed in your own workflow configuration are out of scope for a code fix. Rotate the credential in Postman immediately.
