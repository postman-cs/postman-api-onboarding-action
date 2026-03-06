# REST Migration Seam

This beta suite uses `integration-backend=bifrost` by default, but callers should not need to change their workflow syntax when the backend moves to REST.

## Contract Invariants

These must stay stable across backend migration:

- Composite entrypoint: `postman-cs/postman-api-onboarding-action@v0`
- Input names and meanings in [action.yml](/Users/jaredboynton/__devlocal/postman-api-onboarding-action/action.yml)
- Output names and meanings in [action.yml](/Users/jaredboynton/__devlocal/postman-api-onboarding-action/action.yml)
- Bootstrap-to-repo-sync handoff fields:
  - `workspace-id`
  - `baseline-collection-id`
  - `smoke-collection-id`
  - `contract-collection-id`

## Implementation Boundaries

Backend replacement must be internal to:

- `postman-cs/postman-bootstrap-action@v0`
- `postman-cs/postman-repo-sync-action@v0`

The composite action should continue passing the same `with:` keys and surfacing the same outputs.

## Migration Plan

1. Add REST implementation behind `integration-backend=rest` in lower-level actions.
2. Keep `bifrost` and `rest` parity tests for shared inputs and outputs.
3. Switch composite default only after parity validation passes.
4. Keep existing `v0.x.y` tags immutable; publish default changes in a new immutable tag.
