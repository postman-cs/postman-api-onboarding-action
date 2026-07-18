# Release Policy

This document governs how the Postman API Onboarding GitHub Actions suite is released and documented.

It applies to these repositories:

- [`postman-cs/postman-resolve-service-token-action`](https://github.com/postman-cs/postman-resolve-service-token-action)
- [`postman-cs/postman-bootstrap-action`](https://github.com/postman-cs/postman-bootstrap-action)
- [`postman-cs/postman-repo-sync-action`](https://github.com/postman-cs/postman-repo-sync-action)
- [`postman-cs/postman-smoke-flow-action`](https://github.com/postman-cs/postman-smoke-flow-action)
- [`postman-cs/postman-insights-onboarding-action`](https://github.com/postman-cs/postman-insights-onboarding-action)
- [`postman-cs/postman-aws-spec-discovery-action`](https://github.com/postman-cs/postman-aws-spec-discovery-action)
- [`postman-cs/postman-api-onboarding-action`](https://github.com/postman-cs/postman-api-onboarding-action)

## Goals

- Keep each action independently releasable.
- Keep suite-level guidance in one place without duplicating per-action API details.
- Prevent composite releases from drifting away from the lower-level actions they depend on.
- Make consumer version guidance explicit for marketplace and direct GitHub Action usage.

## Current state

- Each repository owns its own CI workflow and its own `v*` tag-triggered GitHub release workflow.
- The composite action references sibling actions through immutable release tags in `action.yml`.
- The public release contract is the git tag and GitHub release. Do not treat `package.json` version fields as the authoritative public release identifier.

## Source of truth

Use each document for one purpose only:

| Document | Purpose |
| --- | --- |
| `README.md` in each action repo | User-facing usage, inputs, outputs, examples, and high-level version guidance |
| `RELEASE_POLICY.md` in this repo | Maintainer release rules, sequencing, compatibility guidance, and tag policy |

Do not duplicate full input and output tables across repositories. Link to the action-specific README instead.

## Tag policy

- Immutable release tags use the public `v1.x.y` pattern.
- The moving `v1` tag is the rolling release channel.
- Never rewrite or force-push an existing release tag.
- Every public tag should have a corresponding GitHub release with generated notes.

## Consumer guidance

- Use `@v1` in quick-start examples when the goal is a short marketplace install path.
- Recommend immutable tags such as `@v1.x.y` for reproducible production workflows.
- Treat `@v1` as a convenience channel; pin an immutable `@v1.x.y` tag or commit SHA when you need a reproducible reference.
- For security-sensitive environments, document that SHA pinning is the strongest option.

## Composite dependency policy

### Current rule

The composite action currently depends on:

- `postman-cs/postman-bootstrap-action@v2.9.4`
- `postman-cs/postman-repo-sync-action@v2.1.5`
- `postman-cs/postman-insights-onboarding-action@v2.1.2` when Insights is enabled

Because these are immutable sibling pins, a consumer who pins `postman-api-onboarding-action` to an immutable tag gets a reproducible lower-level action set at runtime.

### Composite release rule

The composite action references immutable sibling tags inside `action.yml`. Therefore:

- Every composite release must record the exact sibling tags it uses.
- Any change to a pinned sibling version requires a new composite release.
- The compatibility matrix in this document and the README must be updated in the same change.
- The release workflow must run `scripts/check-sibling-pins.mjs` so the composite cannot ship stale sibling refs.

## Release order

Release from the bottom up:

1. Release `postman-bootstrap-action` if it changed.
2. Release `postman-repo-sync-action` if it changed.
3. Release `postman-insights-onboarding-action` if it changed.
4. Verify the published tags, CI status, and GitHub releases for every changed lower-level action.
5. Review `postman-api-onboarding-action`:
   - Update `action.yml` to the exact lower-level release tags you want to bundle.
6. Update `README.md`, this file, and any compatibility notes affected by the release.
7. Release `postman-api-onboarding-action` last.

## Live E2E Release Gate

Phase 1 of the live release gate covers only the actions currently exercised by
`postman-cs/postman-actions-e2e` as released CLI artifacts:

- `postman-resolve-service-token-action`
- `postman-bootstrap-action`
- `postman-repo-sync-action`
- `postman-smoke-flow-action`

For those repos, pull requests targeting `main` must pass the central live e2e
gate before approval or merge. The PR workflow dispatches
`postman-cs/postman-actions-e2e` with the PR head SHA pinned for the changed
action and waits for the correlated run to succeed. Branches must live in the
target repository so GitHub can provide the central e2e dispatch secret; forked
PRs cannot satisfy the required merge gate until moved to an in-repo branch.

For those repos, immutable publishing tags must pass the central live e2e gate
before any GitHub release, npm package, or release tarball is published. The
release workflow validates locally, dispatches the central e2e workflow with the
exact action tag pinned, waits for the correlated workflow run to conclude
successfully, and only then publishes. The release log must include the e2e run
URL, correlation id, and conclusion.

The rolling `v1` alias validates locally but skips npm publish
and the live e2e gate.

The composite action, Insights onboarding, and AWS spec discovery are not
directly live-e2e-gated in Phase 1. Do not describe releases in those repos as
live-e2e-gated until the harness adds real coverage for the released artifact and
the repo's release workflow blocks on that gate.

## Compatibility matrix

This matrix describes the current release model.

| Composite reference used by consumers | Composite repository content | Lower-level dependency references | Result |
| --- | --- | --- | --- |
| `postman-api-onboarding-action@v1` | Rolling composite alias | Immutable sibling tags in the current composite content | Rolling composite channel with pinned siblings per composite revision |
| Immutable composite release | Immutable composite repo tag | Immutable sibling tags | Fully reproducible |

## Marketplace documentation surface

Every composite release should keep these public docs aligned:

- `README.md`: canonical suite entrypoint, happy-path workflow, scenario navigation, generated input and output tables, and version guidance.
- `SUPPORT.md`: where users file bugs, support requests, and troubleshooting details.
- `SECURITY.md`: vulnerability reporting and credential-handling expectations.
- `RELEASE_POLICY.md`: maintainer release sequencing, tag policy, and compatibility guidance.

## Maintainer release checklist

Before pushing a new release tag:

1. Confirm the working tree is clean.
2. Run the repository's CI-equivalent checks locally when practical.
3. Confirm the README examples still reflect the recommended consumer tag.
4. Confirm `README.md` and `RELEASE_POLICY.md` still match the actual composite wiring.
5. Confirm `SUPPORT.md` and `SECURITY.md` still match the current support and vulnerability-reporting paths.
6. If lower-level actions changed behavior, verify whether the composite repo needs a coordinated release.
7. For a live-e2e-gated repo, confirm `E2E_DISPATCH_TOKEN` is configured and the
   release workflow records a successful central e2e run before publish.
8. Push the immutable release tag.
9. Confirm that the matching GitHub release was published with generated notes.

## What changes the policy

Update this document whenever one of the following changes:

- The tag naming strategy changes.
- The composite action switches from floating aliases to immutable sibling pins.
- The release order changes because suite dependencies changed.
- A new action joins or leaves the suite.
- The README's compatibility guidance would otherwise become inaccurate.
