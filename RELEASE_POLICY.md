# Release Policy

This document governs how the Postman GitHub Actions open-alpha suite is released and documented.

It applies to these repositories:

- [`postman-cs/postman-bootstrap-action`](https://github.com/postman-cs/postman-bootstrap-action)
- [`postman-cs/postman-repo-sync-action`](https://github.com/postman-cs/postman-repo-sync-action)
- [`postman-cs/postman-insights-onboarding-action`](https://github.com/postman-cs/postman-insights-onboarding-action)
- [`postman-cs/postman-api-onboarding-action`](https://github.com/postman-cs/postman-api-onboarding-action)

## Goals

- Keep each action independently releasable.
- Keep suite-level guidance in one place without duplicating per-action API details.
- Prevent composite releases from drifting away from the lower-level actions they depend on.
- Make consumer version guidance explicit during open alpha.

## Current state

- Each repository owns its own CI workflow and its own `v*` tag-triggered GitHub release workflow.
- The composite action currently references sibling actions through floating `@v0` aliases in `action.yml`.
- Released composite tags such as `v0.4`, `v0.4.1`, and `v0.5` also resolve sibling actions through `@v0` aliases.
- During the current open-alpha period, the public release contract is the git tag and GitHub release. Do not treat `package.json` version fields as the authoritative public release identifier.

## Source of truth

Use each document for one purpose only:

| Document | Purpose |
| --- | --- |
| `README.md` in each action repo | User-facing usage, inputs, outputs, examples, and high-level version guidance |
| `RELEASE_POLICY.md` in this repo | Maintainer release rules, sequencing, compatibility guidance, and tag policy |
| `REST_MIGRATION_SEAM.md` in this repo | Backend-neutral contract boundaries for the composite action |

Do not duplicate full input and output tables across repositories. Link to the action-specific README instead.

## Tag policy

- Immutable release tags use the public `v0.x` or `v0.x.y` pattern.
- The moving `v0` tag is the rolling open-alpha channel.
- Never rewrite or force-push an existing release tag.
- Every public tag should have a corresponding GitHub release with generated notes.

## Consumer guidance

- Recommend immutable tags such as `@v0.5` in examples and onboarding docs.
- Treat `@v0` as a convenience channel, not as a reproducible reference.
- For security-sensitive environments, document that SHA pinning is the strongest option.

## Composite dependency policy

### Current open-alpha rule

The composite action currently depends on:

- `postman-cs/postman-bootstrap-action@v0`
- `postman-cs/postman-repo-sync-action@v0`
- `postman-cs/postman-insights-onboarding-action@v0` when Insights is enabled

Because these are floating aliases, a consumer who pins `postman-api-onboarding-action@v0.5` still gets the latest sibling `v0` targets at runtime.

Until the composite action moves to immutable internal pins, maintainers must treat composite releases as coordinated suite releases.

### Target policy before GA

Before GA, change the composite action to reference immutable sibling tags inside `action.yml`. After that change:

- Every composite release must record the exact sibling tags it uses.
- Any change to a pinned sibling version requires a new composite release.
- The compatibility matrix in this document and the README must be updated in the same change.

## Release order

Release from the bottom up:

1. Release `postman-bootstrap-action` if it changed.
2. Release `postman-repo-sync-action` if it changed.
3. Release `postman-insights-onboarding-action` if it changed.
4. Verify the published tags, CI status, and GitHub releases for every changed lower-level action.
5. Review `postman-api-onboarding-action`:
   - If the composite still uses floating `@v0` aliases, verify that the latest lower-level `v0` targets are the intended ones.
   - If the composite has moved to immutable sibling pins, update `action.yml` to the exact release tags you want to bundle.
6. Update `README.md`, this file, and any compatibility notes affected by the release.
7. Release `postman-api-onboarding-action` last.

## Compatibility matrix

This matrix describes the current open-alpha release model.

| Composite reference used by consumers | Composite repository content | Lower-level dependency references | Result |
| --- | --- | --- | --- |
| `postman-api-onboarding-action@v0` | Rolling | Rolling `@v0` aliases | Fully rolling suite channel |
| `postman-api-onboarding-action@v0.5` | Immutable composite repo tag | Rolling `@v0` aliases | Partially reproducible |
| Future immutable composite release | Immutable composite repo tag | Immutable sibling tags | Fully reproducible |

## Maintainer release checklist

Before pushing a new release tag:

1. Confirm the working tree is clean.
2. Run the repository's CI-equivalent checks locally when practical.
3. Confirm the README examples still reflect the recommended consumer tag.
4. Confirm `README.md` and `RELEASE_POLICY.md` still match the actual composite wiring.
5. If lower-level actions changed behavior, verify whether the composite repo needs a coordinated release.
6. Push the immutable release tag.
7. Confirm that the matching GitHub release was published with generated notes.

## What changes the policy

Update this document whenever one of the following changes:

- The tag naming strategy changes.
- The composite action switches from floating aliases to immutable internal pins.
- The release order changes because suite dependencies changed.
- A new action joins or leaves the suite.
- The README's compatibility guidance would otherwise become inaccurate.
