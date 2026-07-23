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
- Immutable release identity is derived from the repository `package.json` version at the tagged commit:
  exact `vX.Y.Z`, plus `vX.Y` when the patch component is `0`.
- The current consumer rolling channel for this composite is `v2`.
- The public release contract is the git tag and GitHub release. Do not treat `package.json` version fields as the authoritative public release identifier by themselves.

## Source of truth

Use each document for one purpose only:

| Document | Purpose |
| --- | --- |
| `README.md` in each action repo | User-facing usage, inputs, outputs, examples, and high-level version guidance |
| `RELEASE_POLICY.md` in this repo | Maintainer release rules, sequencing, compatibility guidance, and tag policy |

Do not duplicate full input and output tables across repositories. Link to the action-specific README instead.

## Tag policy

- Immutable release tags are version-derived (`vX.Y.Z`, and `vX.Y` only when patch is `0`).
  These tags are never rewritten or force-pushed.
- The moving `v2` tag is the current rolling consumer channel for this composite.
  Rolling aliases are deliberately movable and may be force-updated forward only;
  they must never regress to an older immutable version.
- Immutable release tags have a corresponding GitHub release with generated notes;
  a direct rolling-alias invocation is a successful no-op.

## Consumer guidance

- Use `@v2` in quick-start examples when the goal is a short marketplace install path.
- Recommend immutable tags such as `@v2.x.y` for reproducible production workflows.
- Treat `@v2` as a convenience channel; pin an immutable `@v2.x.y` tag or commit SHA when you need a reproducible reference.
- For security-sensitive environments, document that SHA pinning is the strongest option.

## Composite dependency policy

### Current rule

The composite action currently depends on:

- `postman-cs/postman-bootstrap-action@v2.10.8`
- `postman-cs/postman-repo-sync-action@v2.1.13`
- `postman-cs/postman-insights-onboarding-action@v2.1.6` when Insights is enabled

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

## Verification and live monitors

Pull requests and immutable releases run deterministic repository-local checks.
The composite release verifies immutable sibling pins before packaging. Its
release workflow classifies a tag before installing dependencies, validates and
packs in an unprivileged job, then publishes only checksummed staged artifacts in
the privileged job. Trusted envelope verification establishes artifact identity
and checksums before any packaged verifier code is extracted. npm publication
(or SRI identity verification on retry) precedes the GitHub Release; the rolling
`v2` alias advances only after that work and never regresses to an older
immutable version.

Live sandbox E2E is not a PR or publication gate. The `onboarding-e2e` harness
runs a nightly `full` monitor and receives asynchronous post-release `smoke`
monitor dispatches for covered actions. Monitor failures remain observable but do
not block merge, npm publication, GitHub Release creation, or rolling aliases.

## Compatibility matrix

This matrix describes the current release model.

| Composite reference used by consumers | Composite repository content | Lower-level dependency references | Result |
| --- | --- | --- | --- |
| `postman-api-onboarding-action@v2` | Rolling composite alias | Immutable sibling tags in the current composite content | Rolling composite channel with pinned siblings per composite revision |
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
7. Push the immutable release tag.
8. Confirm npm publication or matching SRI retry identity, then the matching
   GitHub release and rolling alias update.
9. Review asynchronous post-release monitor results when the action is covered.

## What changes the policy

Update this document whenever one of the following changes:

- The tag naming strategy changes.
- The composite action switches from floating aliases to immutable sibling pins.
- The release order changes because suite dependencies changed.
- A new action joins or leaves the suite.
- The README's compatibility guidance would otherwise become inaccurate.
