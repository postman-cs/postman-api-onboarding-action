# postman-api-onboarding-action

Public beta JavaScript GitHub Action scaffold for orchestrating Postman API onboarding through bootstrap and repo sync phases.

## Beta Contract

- Primary external entrypoint: `postman-api-onboarding-action`
- Integration backend default: `bifrost`
- Orchestration phases: `bootstrap`, `repo-sync`
- Partner-facing inputs include `project-name`, `spec-url`, `environments-json`, `system-env-map-json`, `governance-mapping-json`, `postman-api-key`, `postman-access-token`, `github-token`, `gh-fallback-token`, `github-auth-mode`, and `repo-write-mode`
- End-to-end outputs include `workspace-id`, `workspace-url`, `spec-id`, `collections-json`, `environment-uids-json`, `mock-url`, `monitor-id`, `repo-sync-summary-json`, and `commit-sha`
- Docker, AWS deploy, cleanup, and shared-infra workflow concerns stay out of this public beta action contract

## Development

```bash
npm install
npm test
```
