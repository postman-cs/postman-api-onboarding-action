# Support

Use this repository for issues with the composite Postman API Onboarding action: workflow wiring, input and output behavior, phase outcomes, marketplace documentation, and the end-to-end GitHub Actions path.

## Where to Get Help

| Need | Where to go |
| --- | --- |
| Bug, documentation issue, or feature request for the composite action | Open a GitHub issue in this repository. |
| Security vulnerability or suspected secret exposure in action behavior | Follow [SECURITY.md](SECURITY.md). Do not open a public issue. |
| General Postman product support | Use your normal Postman support channel. |
| Lower-level action failure outside the composite path | File in the specific action repository, or file here if the failure only happens through this composite action. |

## Before Opening an Issue

Include the details that let maintainers reproduce the workflow without exposing secrets:

- Action reference used, such as `postman-cs/postman-api-onboarding-action@v2` or an immutable `v2.x.y` tag.
- Whether the workflow used `postman-resolve-service-token-action` for `postman-access-token` and `postman-team-id`.
- `postman-region` and whether `org-mode` was enabled.
- Redacted workflow YAML for the failing steps.
- Phase outputs when available: `bootstrap-outcome`, `repo-sync-outcome`, and `insights-outcome`.
- Redacted logs around the first failure.

Never paste Postman API keys, access tokens, service-token outputs, GitHub tokens, cookies, or private OpenAPI documents into issues.

## Version Guidance

Use `@v2` for the shortest marketplace install path. Use an immutable `@v2.x.y` tag or a commit SHA when reproducibility matters. See [RELEASE_POLICY.md](RELEASE_POLICY.md) for release sequencing and tag policy.
