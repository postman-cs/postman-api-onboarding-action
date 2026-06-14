# Enterprise adoption: protected-branch workflows

If your repository enforces branch protection rules requiring all changes through pull requests, use `repo-write-mode: commit-only` with a workflow that creates PRs programmatically. This ensures Postman artifacts go through your normal code review process instead of pushing directly to `main`.

How it works:

1. Create a temporary sync branch (e.g., `postman-sync/YYYYMMDD-HHmmss`). This branch is unprotected.
2. Run the action with `repo-write-mode: commit-only`. Artifacts are committed locally on the runner without being pushed.
3. If artifacts changed, push the sync branch and open a PR targeting `main`.
4. Your team reviews and merges the PR to apply the artifacts.

This pattern separates Postman provisioning (which succeeds independently) from git merge approval (which remains subject to your branch rules).

## Why this matters

Postman-side provisioning (workspace, spec, collections) completes independently of repository operations (git commit, branch protection, merge approval). The phase outcome outputs (`bootstrap-outcome`, `repo-sync-outcome`, `insights-outcome`) let you identify what succeeded and what requires attention:

- Bootstrap succeeds while repo-sync fails: the Postman workspace is ready; investigate repository permissions or branch protection issues.
- Both phases succeed with the repo merge pending: Postman artifacts are staged in a PR awaiting your team's review.
- Insights fails after sync succeeds: Postman and repository sync are complete; debug Insights cluster or agent issues separately.

This enables idempotent reruns: reuse existing Postman assets (workspace ID, collection IDs) when retrying failed repository operations without re-provisioning.

## Example

```yaml
name: Postman protected-branch onboarding

on:
  workflow_dispatch:

jobs:
  onboarding:
    runs-on: ubuntu-latest
    permissions:
      actions: write
      contents: write
      pull-requests: write
    steps:
      - uses: actions/checkout@v5
      - name: Create sync branch
        run: |
          BRANCH="postman-sync/$(date -u +%Y%m%d-%H%M%S)"
          git switch -c "$BRANCH"
          echo "SYNC_BRANCH=$BRANCH" >> "$GITHUB_ENV"
      - id: postman-token
        uses: postman-cs/postman-resolve-service-token-action@v1
        with:
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-region: us
      - id: onboard
        uses: postman-cs/postman-api-onboarding-action@v1
        with:
          project-name: core-payments
          spec-url: https://gist.githubusercontent.com/jaredboynton/a839de57db2c3c90b8f75906c56b00ee/raw/openapi.yaml
          postman-region: us
          repo-write-mode: commit-only
          postman-api-key: ${{ secrets.POSTMAN_API_KEY }}
          postman-access-token: ${{ steps.postman-token.outputs.token }}
          postman-team-id: ${{ steps.postman-token.outputs.team-id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - name: Open PR if artifacts changed
        if: steps.onboard.outputs.commit-sha != ''
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          git push origin "$SYNC_BRANCH"
          gh pr create \
            --base main \
            --head "$SYNC_BRANCH" \
            --title "chore: sync Postman artifacts" \
            --body "Automated Postman onboarding artifact sync."
```

For EU data residency, change both `postman-region` values to `eu`.
