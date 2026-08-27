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
- The current consumer rolling channel for this composite is `v3`.
- Every v3 release keeps `branch-strategy` defaulted to `legacy`; the
  `publish-gate` default flip remains deferred/opt-in rather than shipped.
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
- The moving `v3` tag is the current rolling consumer channel for this composite.
  Rolling aliases are deliberately movable and may be force-updated forward only;
  they must never regress to an older immutable version.
- Immutable release tags have a corresponding GitHub release with generated notes;
  a direct rolling-alias invocation is a successful no-op.

## Consumer guidance

- Use `@v3` in quick-start examples when the goal is a short marketplace install path.
- Recommend immutable tags such as `@v3.x.y` for reproducible production workflows.
- Treat `@v3` as a convenience channel; pin an immutable `@v3.x.y` tag or commit SHA when you need a reproducible reference.
- For security-sensitive environments, document that SHA pinning is the strongest option.

## Composite dependency policy

### Branch-aware v3 contract

The v3 composite exposes `branch-strategy`, `canonical-branch`, `channels`, and
`preview-ttl`, resolves one `POSTMAN_BRANCH_DECISION` before every child, and
surfaces `sync-status` and `spec-version-url`. Gated bootstrap receives empty
credentials; repo-sync and Insights are skipped. There are no public migration knobs.

The branch-aware v3 contract and bottom-up v3 child releases are shipped. This
composite pins those released immutable child tags on the v3 channel, and the
rolling `v3` alias advances after release checks pass. `branch-strategy`
remains defaulted to `legacy`; consumers opt in to `publish-gate`. Never
rewrite an immutable tag or force-push.

### Current rule

The composite action currently depends on:

- `postman-cs/postman-bootstrap-action@v2.21.2`
- `postman-cs/postman-repo-sync-action@v2.10.2`
- `postman-cs/postman-smoke-flow-action@v3.7.3` when `flow-path` or `flow-mode` is set
- `postman-cs/postman-insights-onboarding-action@v2.5.1` when Insights is enabled

Because these are immutable sibling pins, a consumer who pins `postman-api-onboarding-action` to an immutable tag gets a reproducible lower-level action set at runtime.

### Automatic pin advance

`.github/workflows/advance-pins.yml` keeps these pins at the newest released
tag of each pin's recorded major. It runs on a `sibling-release` repository
dispatch from sibling Release runs, on a daily cron backstop, and on manual
dispatch. `scripts/advance-pins.mjs` rewrites every pin literal (manifest,
contract tests, README, this file), then the workflow validates the result with
`scripts/check-sibling-pins.mjs` and the full test suite before pushing to
`main`, where Auto Release cuts the composite release. Majors never advance
automatically; crossing a major stays a reviewed change. The push authenticates
as the `postman-suite-pin-bot` GitHub App (org-owned, installed on the suite
repos), which mints a one-hour installation token per run. The direct
`HEAD:main` push attempts only when that App token is minted and non-empty, so
a `GITHUB_TOKEN` push that would silently bypass Auto Release cannot land
unreleased on `main`. When the App token is absent or the direct push fails, the
workflow falls back to a ready-to-review pull request opened with `github.token`.

### Composite release rule

The composite action references immutable sibling tags inside `action.yml`. Therefore:

- Every composite release must record the exact sibling tags it uses.
- Any change to a pinned sibling version requires a new composite release.
- The compatibility matrix in this document and the README must be updated in the same change.
- The release workflow must run `scripts/check-sibling-pins.mjs` so every
  committed sibling ref is an existing immutable tag and every forwarded input
  remains declared by that exact sibling release.

## Release order

Release from the bottom up:

1. Release `postman-bootstrap-action` if it changed.
2. Release `postman-repo-sync-action` if it changed.
3. Release `postman-smoke-flow-action` if it changed.
4. Release `postman-insights-onboarding-action` if it changed.
5. Verify the published tags, CI status, and GitHub releases for every changed lower-level action.
6. Review `postman-api-onboarding-action`:
   - Update `action.yml` to the exact lower-level release tags you want to bundle.
7. Update `README.md`, this file, and any compatibility notes affected by the release.
8. Release `postman-api-onboarding-action` last.

## Release checks

Releases are cut automatically. Merging to `main` runs `.github/workflows/auto-release.yml`,
which derives the next version from the conventional-commit history, then runs
`scripts/release-cut.mjs`: bump manifests, run the gate set, commit, and tag.

The tag is created only after the exact bytes of the release commit pass every
gate, so a failed cut leaves no tag and burns no version number. The next merge
retries on a fresh version, skipping any already-tagged one.

Before planning another cut, auto-release reconciles the latest immutable tag
when its GitHub release is missing or its rolling alias has not advanced. It
does not duplicate an active release run, and a successful release completion
resumes planning.

Do not push `vX.Y.Z` tags by hand. The pre-push hook refuses them, because a
hand-pushed tag becomes a public identifier before any gate has run against it.

To see what the next merge would cut:

```sh
git fetch origin --tags
node scripts/release-cut.mjs --plan
```

## Verification and live monitors

Pull requests and immutable releases run deterministic repository-local checks.
The composite release verifies immutable sibling pins before packaging. Its
release workflow classifies a tag before installing dependencies, validates and
packs in an unprivileged job, then publishes only checksummed staged artifacts in
the privileged job. Trusted envelope verification establishes artifact identity
and checksums before any packaged verifier code is extracted. The GitHub Release
precedes the best-effort npm publication attempt, so tags and GitHub Releases
remain authoritative when npm access is unavailable. npm publication is
OIDC-only. A successful npm publish still receives hard SRI identity
verification; failed attempts warn and require rerunning the immutable release
after trusted publishing is restored. That publication remains separate from
live verification.

Live sandbox E2E is not a PR or immutable-publication gate. The `onboarding-e2e`
harness runs a nightly `full` monitor. After an immutable release publishes, the
release workflow requires an exact correlated terminal success before advancing
the rolling `v3` alias. A manual `report-only` selection is the only explicit
override; enforcement is the default. Verification fails closed with
`E2E_COMPOSITE_USES_UNAVAILABLE` when a released composite `uses:` path is
unavailable rather than claiming constituent-action coverage for the composite.

### Release E2E dispatch token

The release workflow's `verify-release-e2e` job mints a short-lived GitHub App
installation token (one hour) via `actions/create-github-app-token`, scoped to
`postman-cs` on `postman-actions-e2e`. This token carries the App installation
permissions **Actions: write** and **Contents: read** on that repository and is
fed to the E2E verifier as `E2E_DISPATCH_TOKEN` so the verifier can dispatch and
observe the release-gated workflow run.

> **Operator prerequisite:** the `postman-suite-pin-bot` GitHub App must be
> installed on `postman-cs/postman-actions-e2e` with at least **Actions: write**
> and **Contents: read** permissions. The composite release workflow does not
> create or provision this installation itself; an operator must install the App
> and grant those permissions before a correlated E2E gate can dispatch and
> observe a run. If the App token cannot be minted or is empty, verification
> fails closed — the verifier never falls back to an ambient or default token.

## Compatibility matrix

This matrix describes the current release model.

| Composite reference used by consumers | Composite repository content | Lower-level dependency references | Result |
| --- | --- | --- | --- |
| `postman-api-onboarding-action@v3` | Rolling composite alias | Immutable sibling tags in the current composite content | Rolling composite channel with pinned siblings per composite revision |
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
7. Merge to `main` and let auto-release cut the immutable tag after gates pass.
8. Confirm npm publication or matching SRI retry identity and the matching
   GitHub release.
9. Confirm exact correlated E2E terminal success before the rolling alias moves,
   or record the explicit manual `report-only` override and blocker.

## What changes the policy

Update this document whenever one of the following changes:

- The tag naming strategy changes.
- The composite action switches from floating aliases to immutable sibling pins.
- The release order changes because suite dependencies changed.
- A new action joins or leaves the suite.
- The README's compatibility guidance would otherwise become inaccurate.
