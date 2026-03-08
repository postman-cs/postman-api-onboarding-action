# Implementation Plan - Existing Service Support (Idempotency & Safe Sync)

## 1. 🔍 Analysis & Context
*   **Objective:** Modify the beta action suite to be idempotent and non-destructive so it can be installed on existing repositories and/or existing Postman workspaces without clobbering existing CI pipelines or creating duplicate Postman assets.
*   **Affected Files:**
    *   `../../postman-bootstrap-action/action.yml`
    *   `../../postman-bootstrap-action/src/index.ts`
    *   `../../postman-bootstrap-action/src/lib/postman/postman-assets-client.ts`
    *   `../../postman-repo-sync-action/action.yml`
    *   `../../postman-repo-sync-action/src/index.ts`
    *   `../action.yml`
*   **Key Dependencies:** Postman API (needs support for `PUT /specs/{specId}`), GitHub Actions Toolkit.
*   **Risks/Unknowns:** 
    *   Updating existing collections via API might be complex compared to generating new ones. Skipping generation if they already exist is safer for a V1.
    *   If a user provides a `workspace-id` but lacks permissions, the API calls will fail. Error handling must clearly indicate missing permissions on existing assets.

## 2. 📋 Checklist
- [ ] Step 1: Update `postman-bootstrap-action` to support existing Workspace IDs.
- [ ] Step 2: Update `postman-bootstrap-action` to support existing Spec and Collection UIDs.
- [ ] Step 3: Update `postman-repo-sync-action` to make CI workflow generation non-destructive.
- [ ] Step 4: Expose new inputs in `postman-api-onboarding-action`.
- [ ] Verification

## 3. 📝 Step-by-Step Implementation Details

### Step 1: Update `postman-bootstrap-action` to support existing Workspace IDs
*   **Goal:** Allow users to provide an existing workspace ID (or read it from GitHub variables) to prevent duplicate workspace creation.
*   **Action:**
    *   Modify `../../postman-bootstrap-action/action.yml`: Add `workspace-id` as an optional input.
    *   Modify `../../postman-bootstrap-action/src/index.ts`: 
        *   In `readActionInputs()`, read `workspace-id`. If not provided, attempt to read the `POSTMAN_WORKSPACE_ID` environment/repository variable via `dependencies.github?.getRepositoryVariable(...)`.
        *   In `runBootstrap()`, wrap the `createWorkspace` call:
            ```typescript
            let workspaceId = inputs.workspaceId;
            if (!workspaceId) {
              const workspace = await runGroup(dependencies.core, 'Create Postman Workspace', async () => ...);
              workspaceId = workspace.id;
            } else {
              dependencies.core.info(`Using existing workspace: ${workspaceId}`);
            }
            outputs['workspace-id'] = workspaceId;
            ```
*   **Verification:** Run the action twice; the second run should use the existing workspace instead of creating a new one.

### Step 2: Update `postman-bootstrap-action` to support existing Spec and Collection UIDs
*   **Goal:** Prevent spawning duplicate specs and collections on subsequent runs.
*   **Action:**
    *   Modify `../../postman-bootstrap-action/action.yml`: Add optional inputs `spec-id`, `baseline-collection-id`, `smoke-collection-id`, `contract-collection-id`.
    *   Modify `../../postman-bootstrap-action/src/lib/postman/postman-assets-client.ts`: Add `updateSpec(specId, content)` using `PUT /specs/{specId}`.
    *   Modify `../../postman-bootstrap-action/src/index.ts`:
        *   Read existing IDs from inputs or GitHub repository variables.
        *   If `spec-id` exists, call `updateSpec` instead of `uploadSpec`.
        *   If collection IDs exist, **skip** `generateCollection` to avoid creating duplicate `[Baseline]`, `[Smoke]`, `[Contract]` collections on every run.
*   **Verification:** Run the action twice; verify no duplicate specs or collections are created in the Postman workspace.

### Step 3: Update `postman-repo-sync-action` to make CI workflow generation non-destructive
*   **Goal:** Prevent the action from blindly overwriting `.github/workflows/ci.yml` in existing repositories.
*   **Action:**
    *   Modify `../../postman-repo-sync-action/action.yml`: Add inputs `generate-ci-workflow` (boolean, default: `true`) and `ci-workflow-path` (string, default: `.github/workflows/ci.yml`).
    *   Modify `../../postman-repo-sync-action/src/index.ts`:
        *   In `readActionInputs()`, parse these new inputs.
        *   In `commitAndPushGeneratedFiles()`, check `inputs.generateCiWorkflow`.
        *   If true, write to `inputs.ciWorkflowPath` instead of hardcoding `.github/workflows/ci.yml`.
*   **Verification:** Run the action with `generate-ci-workflow: false` and verify no CI file is written. Run with `ci-workflow-path: .github/workflows/postman.yml` and verify the file is written to the correct path.

### Step 4: Expose new inputs in `postman-api-onboarding-action`
*   **Goal:** Pass the new idempotency and safety flags through the composite entrypoint.
*   **Action:**
    *   Modify `../action.yml`:
        *   Add `workspace-id`, `spec-id`, `baseline-collection-id`, `smoke-collection-id`, `contract-collection-id`, `generate-ci-workflow`, and `ci-workflow-path` as optional inputs.
        *   Map these new inputs in the `with:` blocks for both the `bootstrap` and `repo_sync` steps.
*   **Verification:** Ensure a caller can pass `workspace-id` to the composite action and have it propagate to both underlying actions.

## 4. 🧪 Testing Strategy
*   **Unit Tests:** 
    *   Update `bootstrap-action.test.ts` to assert that `createWorkspace` and `generateCollection` are NOT called when IDs are provided.
    *   Update `repo-sync-action.test.ts` to assert that `writeFileSync` is skipped or targets the correct path based on `generate-ci-workflow` and `ci-workflow-path`.
*   **Integration Tests:** Run the onboarding composite action twice on a disposable repository. The first run provisions assets. The second run should detect the existing repository variables and update the assets idempotently without creating duplicates or breaking the CI file.
*   **Manual Verification:** Run the action against an existing service repository containing a pre-existing `.github/workflows/ci.yml` file, passing `ci-workflow-path: .github/workflows/postman-sync.yml`. Verify the original CI file is untouched.

## 5. ✅ Success Criteria
*   The action can be run multiple times on the same repository without creating duplicate Workspaces, Specs, or Collections.
*   Existing repositories do not have their `.github/workflows/ci.yml` forcibly overwritten unless configured to do so.
*   Users can explicitly pass a `workspace-id` to onboard an existing GitHub repository to an existing Postman Workspace.