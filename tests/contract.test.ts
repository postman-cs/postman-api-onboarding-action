import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  if?: string;
  shell?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};

type ActionManifest = {
  name: string;
  description: string;
  runs: {
    using: string;
    steps: Step[];
  };
  inputs: Record<string, { description?: string; default?: string; required?: boolean }>;
  outputs: Record<string, { description?: string; value: string }>;
};

type WorkflowManifest = {
  jobs: {
    release: {
      steps: Step[];
    };
  };
};

const HIDDEN_INPUTS = new Set(['integration-backend', 'postman-stack']);
const HIDDEN_OUTPUTS = new Set(['integration-backend']);

function loadManifest(): ActionManifest {
  return parse(
    readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')
  ) as ActionManifest;
}

function loadPackageJson(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  ) as Record<string, unknown>;
}

function loadReadme(): string {
  return readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
}

function loadReleaseWorkflow(): WorkflowManifest {
  return parse(
    readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')
  ) as WorkflowManifest;
}

describe('postman-api-onboarding-action composite contract', () => {
  describe('Phase 1: Documentation & Metadata', () => {
    it('action.yml name matches the marketplace listing title', () => {
      const manifest = loadManifest();
      expect(manifest.name).toBe('Postman API Onboarding');
    });

    it('package.json name matches repository name', () => {
      const pkg = loadPackageJson();
      expect(pkg.name).toBe('@postman-cse/onboarding-api');
    });

    it('description carries the suite suffix, not beta', () => {
      const manifest = loadManifest();
      const pkg = loadPackageJson();
      expect(manifest.description).toContain('Part of the Postman API Onboarding suite');
      expect(manifest.description).not.toContain('beta');
      expect(String(pkg.description)).toContain('Postman API onboarding');
      expect(String(pkg.description)).not.toContain('customer preview');
      expect(String(pkg.description)).not.toContain('beta');
    });

    it('README does not contain beta references', () => {
      const readme = loadReadme();
      const lines = readme.split('\n');
      for (const line of lines) {
        if (line.trim().startsWith('```') || line.trim().startsWith('|')) continue;
        if (/\bbeta\b/i.test(line) && !/v?\d+\.\d+\.\d+-beta/i.test(line)) {
          expect.fail(`README contains beta reference: "${line.trim()}"`);
        }
      }
    });

    it('package.json version is a publishable semver release', () => {
      const pkg = loadPackageJson();
      expect(String(pkg.version)).toMatch(/^1\.\d+\.\d+$/);
      expect(String(pkg.version)).not.toMatch(/beta/);
    });

    it('publishes immutable release tags while skipping npm for the rolling alias', () => {
      const workflow = loadReleaseWorkflow();
      const steps = workflow.jobs.release.steps;
      const verifyStep = steps.find((step) => step.name === 'Verify release tag matches package version');
      const releaseStep = steps.find((step) => step.name === 'Publish GitHub release');
      const npmSetupStep = steps.find((step) => step.uses?.startsWith('actions/setup-node@') && step.with?.['registry-url']);
      const npmPackageStep = steps.find((step) => step.name === 'Check npm package version');
      const publishStep = steps.find((step) => step.name === 'Publish to npm');
      const attachStep = steps.find((step) => step.name === 'Attach npm tarball to release');
      const uploadStep = steps.find((step) => step.name === 'Upload tarball');

      expect(verifyStep?.id).toBe('release_tag');
      expect(verifyStep?.run).toContain('PUBLISH_TAGS=("$PKG_VERSION")');
      expect(verifyStep?.run).toContain('PUBLISH_TAGS+=("$MAJOR.$MINOR")');
      expect(verifyStep?.run).toContain('if [ "$TAG_VERSION" = "$MAJOR" ]; then');
      expect(verifyStep?.run).not.toContain('if [ "$TAG_VERSION" = "0" ]; then');
      expect(verifyStep?.run).toContain('or v$MAJOR');
      expect(verifyStep?.run).toContain('npm_publish=true');
      expect(verifyStep?.run).toContain('npm_publish=false');
      expect(verifyStep?.run).toContain('skipping npm publish');
      expect(verifyStep?.run).not.toContain('ALIAS_TAGS');
      expect(verifyStep?.run).not.toContain('publish_tag');
      expect(releaseStep?.if).toBeUndefined();
      expect(npmSetupStep?.if).toBe("steps.release_tag.outputs.npm_publish == 'true'");
      expect(npmPackageStep?.id).toBe('npm_package');
      expect(npmPackageStep?.run).toContain('npm view "$PKG_NAME@$PKG_VERSION" version');
      expect(publishStep?.if).toBe("steps.release_tag.outputs.npm_publish == 'true' && steps.npm_package.outputs.already_published != 'true'");
      expect(attachStep?.if).toBeUndefined();
      expect(uploadStep?.if).toBeUndefined();
    });

    it('README documents all inputs from action.yml', () => {
      const manifest = loadManifest();
      const readme = loadReadme();
      for (const inputName of Object.keys(manifest.inputs)) {
        if (HIDDEN_INPUTS.has(inputName)) continue;
        expect(readme).toContain(`\`${inputName}\``);
      }
    });

    it('README documents all outputs from action.yml', () => {
      const manifest = loadManifest();
      const readme = loadReadme();
      for (const outputName of Object.keys(manifest.outputs)) {
        if (HIDDEN_OUTPUTS.has(outputName)) continue;
        expect(readme).toContain(`\`${outputName}\``);
      }
    });
  });

  describe('Phase 2: Inputs, Outputs & Error Handling', () => {
    it('all inputs use kebab-case naming', () => {
      const manifest = loadManifest();
      for (const inputName of Object.keys(manifest.inputs)) {
        expect(inputName).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      }
    });

    it('all outputs use kebab-case naming', () => {
      const manifest = loadManifest();
      for (const outputName of Object.keys(manifest.outputs)) {
        expect(outputName).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
      }
    });

    it('has the complete expected input set', () => {
      const manifest = loadManifest();
      expect(Object.keys(manifest.inputs)).toEqual([
        'workspace-id',
        'spec-id',
        'baseline-collection-id',
        'smoke-collection-id',
        'contract-collection-id',
        'sync-examples',
        'collection-sync-mode',
        'spec-sync-mode',
        'release-label',
        'monitor-id',
        'mock-url',
        'monitor-cron',
        'generate-ci-workflow',
        'ci-workflow-path',
        'project-name',
        'domain',
        'domain-code',
        'governance-group',
        'requester-email',
        'workspace-admin-user-ids',
        'workspace-team-id',
        'spec-url',
        'spec-path',
        'breaking-change-mode',
        'breaking-baseline-spec-path',
        'breaking-rules-path',
        'breaking-target-ref',
        'breaking-summary-path',
        'breaking-log-path',
        'environments-json',
        'system-env-map-json',
        'environment-uids-json',
        'governance-mapping-json',
        'env-runtime-urls-json',
        'postman-api-key',
        'postman-access-token',
        'credential-preflight',
        'postman-team-id',
        'postman-region',
        'postman-stack',
        'github-token',
        'gh-fallback-token',
        'repo-write-mode',
        'current-ref',
        'committer-name',
        'committer-email',
        'enable-insights',
        'skip-built-in-tests',
        'cluster-name',
        'integration-backend',
        'org-mode',
        'ssl-client-cert',
        'ssl-client-key',
        'ssl-client-passphrase',
        'ssl-extra-ca-certs'
      ]);
    });

    it('postman-api-key is required because bootstrap depends on it', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['postman-api-key']?.required).toBe(true);
    });

    it('postman-team-id remains an optional explicit override', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['postman-team-id']).toBeDefined();
      expect(manifest.inputs['postman-team-id']?.required).toBe(false);
      expect(manifest.inputs['postman-team-id']?.description).toContain('Explicit');
    });

    it('project-name remains required and the spec source is one-of', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['project-name']?.required).toBe(true);
      expect(manifest.inputs['spec-url']?.required).toBe(false);
      expect(manifest.inputs['spec-path']?.required).toBe(false);
    });

    it('keeps integration-backend internal with no visible manifest default', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['integration-backend']?.default).toBeUndefined();
    });

    it('defaults enable-insights to false', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['enable-insights']?.default).toBe('false');
    });

    it('defaults skip-built-in-tests to false so existing callers see no behavior change', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['skip-built-in-tests']).toBeDefined();
      expect(manifest.inputs['skip-built-in-tests']?.required).toBe(false);
      expect(manifest.inputs['skip-built-in-tests']?.default).toBe('false');
    });

    it('has the complete expected output set', () => {
      const manifest = loadManifest();
      expect(Object.keys(manifest.outputs)).toEqual([
        'integration-backend',
        'workspace-id',
        'workspace-url',
        'spec-id',
        'collections-json',
        'breaking-change-status',
        'breaking-change-summary-json',
        'environment-uids-json',
        'mock-url',
        'monitor-id',
        'repo-sync-summary-json',
        'commit-sha',
        'bootstrap-outcome',
        'repo-sync-outcome',
        'insights-outcome',
        'insights-status',
        'insights-verification-token',
        'insights-application-id',
        'insights-discovered-service-id',
        'insights-discovered-service-name',
        'insights-collection-id'
      ]);
    });
  });

  describe('Phase 2: Step Wiring', () => {
    it('is a composite action with the expected step count', () => {
      const manifest = loadManifest();
      expect(manifest.runs.using).toBe('composite');
      // bootstrap, repo-sync, warn-no-api-key (D2 skip+warn), junit-runner,
      // junit-uploader, insights.
      expect(manifest.runs.steps).toHaveLength(7);
    });

    it('uses pinned bootstrap, repo-sync, junit-runner, junit-uploader, and insights actions', () => {
      const manifest = loadManifest();
      const steps = manifest.runs.steps;
      const validateStep = steps.find((step) => step.id === 'validate_postman_stack');
      const bootstrapStep = steps.find((step) => step.id === 'bootstrap');
      const repoSyncStep = steps.find((step) => step.id === 'repo_sync');
      const junitStep = steps.find((step) => step.id === 'run_tests_junit');
      const uploadStep = steps.find((step) => step.id === 'upload_junit_artifact');
      const insightsStep = steps.find((step) => step.id === 'insights_onboarding');

      expect(validateStep?.shell).toBe('bash');
      expect(bootstrapStep?.uses).toBe('postman-cs/postman-bootstrap-action@v1.2.4');
      expect(repoSyncStep?.uses).toBe('postman-cs/postman-repo-sync-action@v1.0.5');
      expect(junitStep?.shell).toBe('bash');
      expect(uploadStep?.uses).toBe('actions/upload-artifact@v7.0.1');
      expect(insightsStep?.uses).toBe('postman-cs/postman-insights-onboarding-action@v1.0.4');
      for (const step of [bootstrapStep, repoSyncStep, insightsStep]) {
        expect(step?.uses).not.toMatch(/@(main|v0)$/);
      }
    });

    it('validates the hidden postman-stack and public postman-region inputs before downstream actions run', () => {
      const manifest = loadManifest();
      const validateStep = manifest.runs.steps.find((step) => step.id === 'validate_postman_stack');

      expect(manifest.inputs['postman-stack']?.default).toBe('prod');
      expect(manifest.inputs['postman-region']?.default).toBe('us');
      expect(validateStep?.env?.POSTMAN_REGION).toBe('${{ inputs.postman-region }}');
      expect(validateStep?.env?.POSTMAN_STACK).toBe('${{ inputs.postman-stack }}');
      expect(validateStep?.run).toContain('prod|beta');
      expect(validateStep?.run).toContain('postman-stack must be one of: prod, beta');
      expect(validateStep?.run).toContain('us|eu');
      expect(validateStep?.run).toContain('postman-region must be one of: us, eu');
    });

    it('insights step is conditional on enable-insights', () => {
      const manifest = loadManifest();
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');
      expect(insightsStep?.if).toContain('enable-insights');
      expect(insightsStep?.if).toContain("'true'");
    });

    it('run_tests_junit and upload_junit_artifact are gated on skip-built-in-tests', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');
      const uploadStep = manifest.runs.steps.find((s) => s.id === 'upload_junit_artifact');
      expect(junitStep?.if).toContain('skip-built-in-tests');
      expect(junitStep?.if).toContain("'true'");
      expect(uploadStep?.if).toContain('skip-built-in-tests');
      expect(uploadStep?.if).toContain("'true'");
    });

    it('maps bootstrap outputs explicitly into repo-sync inputs', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((step) => step.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((step) => step.id === 'repo_sync');

      expect(bootstrapStep?.with?.['workspace-id']).toBe('${{ inputs.workspace-id }}');
      expect(bootstrapStep?.with?.['spec-id']).toBe('${{ inputs.spec-id }}');
      expect(bootstrapStep?.with?.['baseline-collection-id']).toBe(
        '${{ inputs.baseline-collection-id }}'
      );
      expect(bootstrapStep?.with?.['smoke-collection-id']).toBe(
        '${{ inputs.smoke-collection-id }}'
      );
      expect(bootstrapStep?.with?.['contract-collection-id']).toBe(
        '${{ inputs.contract-collection-id }}'
      );
      expect(bootstrapStep?.with?.['breaking-change-mode']).toBe(
        '${{ inputs.breaking-change-mode }}'
      );
      expect(bootstrapStep?.with?.['breaking-baseline-spec-path']).toBe(
        '${{ inputs.breaking-baseline-spec-path }}'
      );
      expect(bootstrapStep?.with?.['breaking-rules-path']).toBe(
        '${{ inputs.breaking-rules-path }}'
      );
      expect(bootstrapStep?.with?.['breaking-target-ref']).toBe(
        '${{ inputs.breaking-target-ref }}'
      );
      expect(bootstrapStep?.with?.['breaking-summary-path']).toBe(
        '${{ inputs.breaking-summary-path }}'
      );
      expect(bootstrapStep?.with?.['breaking-log-path']).toBe(
        '${{ inputs.breaking-log-path }}'
      );
      expect(repoSyncStep?.with?.['workspace-id']).toBe(
        '${{ steps.bootstrap.outputs.workspace-id }}'
      );
      expect(repoSyncStep?.with?.['baseline-collection-id']).toBe(
        '${{ steps.bootstrap.outputs.baseline-collection-id }}'
      );
      expect(repoSyncStep?.with?.['smoke-collection-id']).toBe(
        '${{ steps.bootstrap.outputs.smoke-collection-id }}'
      );
      expect(repoSyncStep?.with?.['contract-collection-id']).toBe(
        '${{ steps.bootstrap.outputs.contract-collection-id }}'
      );
      expect(repoSyncStep?.with?.['spec-id']).toBe(
        '${{ steps.bootstrap.outputs.spec-id }}'
      );
      expect(repoSyncStep?.with?.['spec-path']).toBe(
        '${{ inputs.spec-path }}'
      );
      expect(repoSyncStep?.with?.['releases-json']).toBeUndefined();
      expect(repoSyncStep?.with?.['generate-ci-workflow']).toBe(
        '${{ inputs.generate-ci-workflow }}'
      );
      expect(repoSyncStep?.with?.['ci-workflow-path']).toBe(
        '${{ inputs.ci-workflow-path }}'
      );
    });

    it('surfaces final outputs from phase steps', () => {
      const manifest = loadManifest();

      expect(manifest.outputs['workspace-id']?.value).toBe(
        '${{ steps.bootstrap.outputs.workspace-id }}'
      );
      expect(manifest.outputs['collections-json']?.value).toBe(
        '${{ steps.bootstrap.outputs.collections-json }}'
      );
      expect(manifest.outputs['breaking-change-status']?.value).toBe(
        '${{ steps.bootstrap.outputs.breaking-change-status }}'
      );
      expect(manifest.outputs['breaking-change-summary-json']?.value).toBe(
        '${{ steps.bootstrap.outputs.breaking-change-summary-json }}'
      );
      expect(manifest.outputs['environment-uids-json']?.value).toBe(
        '${{ steps.repo_sync.outputs.environment-uids-json }}'
      );
      expect(manifest.outputs['repo-sync-summary-json']?.value).toBe(
        '${{ steps.repo_sync.outputs.repo-sync-summary-json }}'
      );
      expect(manifest.outputs['commit-sha']?.value).toBe(
        '${{ steps.repo_sync.outputs.commit-sha }}'
      );
      expect(manifest.outputs['bootstrap-outcome']?.value).toBe(
        '${{ steps.bootstrap.outcome }}'
      );
      expect(manifest.outputs['repo-sync-outcome']?.value).toBe(
        '${{ steps.repo_sync.outcome }}'
      );
      expect(manifest.outputs['insights-outcome']?.value).toBe(
        '${{ steps.insights_onboarding.outcome }}'
      );
      expect(manifest.outputs['insights-status']?.value).toBe(
        '${{ steps.insights_onboarding.outputs.status }}'
      );
    });

    it('passes postman-team-id as POSTMAN_TEAM_ID env to all steps', () => {
      const manifest = loadManifest();
      for (const step of manifest.runs.steps) {
        expect(step.env?.POSTMAN_TEAM_ID).toBe('${{ inputs.postman-team-id }}');
      }
    });

    it('passes postman-api-key and postman-access-token to bootstrap and repo-sync', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');

      expect(bootstrapStep?.with?.['postman-api-key']).toBe('${{ inputs.postman-api-key }}');
      expect(bootstrapStep?.with?.['postman-access-token']).toBe('${{ inputs.postman-access-token }}');
      expect(repoSyncStep?.with?.['postman-api-key']).toBe('${{ inputs.postman-api-key }}');
      expect(repoSyncStep?.with?.['postman-access-token']).toBe('${{ inputs.postman-access-token }}');
    });

    it('credential-preflight defaults to warn and is optional', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['credential-preflight']?.required).toBe(false);
      expect(manifest.inputs['credential-preflight']?.default).toBe('warn');
    });

    it('validates credential-preflight as warn or enforce only before downstream actions run', () => {
      const manifest = loadManifest();
      const validateStep = manifest.runs.steps.find((step) => step.id === 'validate_postman_stack');

      expect(validateStep?.env?.CREDENTIAL_PREFLIGHT).toBe('${{ inputs.credential-preflight }}');
      expect(validateStep?.run).toContain('warn|enforce');
      expect(validateStep?.run).toContain('credential-preflight must be one of: warn, enforce');
      expect(validateStep?.run).not.toMatch(/\b(disabled|false|none|off|skip)\b/);
    });

    it('passes credential-preflight to bootstrap, repo-sync, and insights', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');

      expect(bootstrapStep?.with?.['credential-preflight']).toBe('${{ inputs.credential-preflight }}');
      expect(repoSyncStep?.with?.['credential-preflight']).toBe('${{ inputs.credential-preflight }}');
      expect(insightsStep?.with?.['credential-preflight']).toBe('${{ inputs.credential-preflight }}');
    });

    it('does not expose an iapub base URL knob on any child step', () => {
      const manifest = loadManifest();
      for (const stepId of ['bootstrap', 'repo_sync', 'insights_onboarding']) {
        const step = manifest.runs.steps.find((s) => s.id === stepId);
        expect(step?.with?.['iapub-base']).toBeUndefined();
      }
    });

    it('passes governance group and GitHub tokens to bootstrap', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');

      expect(bootstrapStep?.with?.['governance-group']).toBe('${{ inputs.governance-group }}');
      expect(bootstrapStep?.with?.['github-token']).toBe('${{ inputs.github-token }}');
      expect(bootstrapStep?.with?.['gh-fallback-token']).toBe('${{ inputs.gh-fallback-token }}');
    });

    it('passes integration-backend to bootstrap and repo-sync', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');

      expect(bootstrapStep?.with?.['integration-backend']).toBe('${{ inputs.integration-backend }}');
      expect(repoSyncStep?.with?.['integration-backend']).toBe('${{ inputs.integration-backend }}');
    });

    it('passes workspace-team-id to bootstrap but not to repo-sync or insights', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');

      expect(bootstrapStep?.with?.['workspace-team-id']).toBe(
        '${{ inputs.workspace-team-id }}'
      );
      expect(repoSyncStep?.with?.['workspace-team-id']).toBeUndefined();
      expect(insightsStep?.with?.['workspace-team-id']).toBeUndefined();
    });

    it('workspace-team-id input is optional with no default', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['workspace-team-id']).toBeDefined();
      expect(manifest.inputs['workspace-team-id']?.required).toBe(false);
      expect(manifest.inputs['workspace-team-id']?.default).toBeUndefined();
      expect(manifest.inputs['workspace-team-id']?.description).toContain('org-mode');
    });

    it('passes hidden postman-stack through to bootstrap', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');

      expect(bootstrapStep?.with?.['postman-region']).toBe('${{ inputs.postman-region }}');
      expect(bootstrapStep?.with?.['postman-stack']).toBe('${{ inputs.postman-stack }}');
      expect(bootstrapStep?.with?.['postman-api-base']).toBeUndefined();
      expect(bootstrapStep?.with?.['postman-bifrost-base']).toBeUndefined();
      expect(bootstrapStep?.with?.['postman-gateway-base']).toBeUndefined();
      expect(bootstrapStep?.with?.['postman-cli-install-url']).toBeUndefined();
    });

    it('passes hidden postman-stack through to repo-sync without explicit URL knobs', () => {
      const manifest = loadManifest();
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');

      expect(repoSyncStep?.with?.['postman-region']).toBe('${{ inputs.postman-region }}');
      expect(repoSyncStep?.with?.['postman-stack']).toBe('${{ inputs.postman-stack }}');
      expect(repoSyncStep?.with?.['postman-api-base']).toBeUndefined();
      expect(repoSyncStep?.with?.['postman-bifrost-base']).toBeUndefined();
      expect(repoSyncStep?.with?.['postman-cli-install-url']).toBeUndefined();
      expect(repoSyncStep?.with?.['postman-gateway-base']).toBeUndefined();
    });

    it('run_tests_junit installs the Postman CLI from postman-cli-install-url', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');

      expect(junitStep?.run).toContain('$POSTMAN_CLI_INSTALL_URL');
      // us is the CLI default and `--region us` is rejected by the Postman CLI, so the
      // login passes `--region eu` only for eu and omits the flag otherwise.
      expect(junitStep?.run).toContain('--region eu');
      expect(junitStep?.run).not.toContain('--region "$POSTMAN_REGION"');
      expect(junitStep?.run).not.toContain('--region us');
      expect(junitStep?.run).toContain('postman login --with-api-key "$POSTMAN_API_KEY" >/dev/null');
      expect(junitStep?.run).not.toContain('https://dl-cli.pstmn.io/install/unix.sh');
    });

    it('run_tests_junit routes install URL via env var, not shell interpolation', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');

      expect(junitStep?.env?.POSTMAN_CLI_INSTALL_URL).toBe(
        "${{ inputs.postman-stack == 'beta' && 'https://dl-cli.pstmn-beta.io/install/unix.sh' || 'https://dl-cli.pstmn.io/install/unix.sh' }}"
      );
      expect(junitStep?.run).toContain('$POSTMAN_CLI_INSTALL_URL');
      expect(junitStep?.run).not.toContain('"${{ inputs.postman-cli-install-url }}"');
    });

    it('run_tests_junit script remains valid Bash', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');

      expect(junitStep?.shell).toBe('bash');
      expect(junitStep?.run).toBeTruthy();
      expect(() => execFileSync('bash', ['-n'], { input: junitStep?.run })).not.toThrow();
    });

    it('run_tests_junit does not validate the install URL with an inline Bash regex', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');

      expect(junitStep?.run).not.toContain('=~');
      expect(junitStep?.run).not.toContain('postman-cli-install-url must be an https URL');
    });

    it('run_tests_junit checks jq before parsing JSON payloads', () => {
      const manifest = loadManifest();
      const junitStep = manifest.runs.steps.find((s) => s.id === 'run_tests_junit');

      expect(junitStep?.run).toContain('command -v jq');
      expect(junitStep?.run).toContain('jq is required');
      expect((junitStep?.run ?? '').indexOf('command -v jq')).toBeLessThan(
        (junitStep?.run ?? '').indexOf('SMOKE=')
      );
    });

    it('insights step receives workspace-id from bootstrap output', () => {
      const manifest = loadManifest();
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');

      expect(insightsStep?.with?.['workspace-id']).toBe(
        '${{ steps.bootstrap.outputs.workspace-id }}'
      );
    });

    it('insights step receives required downstream onboarding inputs', () => {
      const manifest = loadManifest();
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');

      expect(insightsStep?.with?.['environment-id']).toBe(
        '${{ fromJSON(steps.repo_sync.outputs.environment-uids-json)[fromJSON(inputs.environments-json)[0]] }}'
      );
      expect(insightsStep?.with?.['system-environment-id']).toBe(
        '${{ fromJSON(inputs.system-env-map-json)[fromJSON(inputs.environments-json)[0]] }}'
      );
      expect(insightsStep?.with?.['cluster-name']).toBe('${{ inputs.cluster-name }}');
      expect(insightsStep?.with?.['postman-team-id']).toBe('${{ inputs.postman-team-id }}');
      expect(insightsStep?.with?.['postman-region']).toBe('${{ inputs.postman-region }}');
      expect(insightsStep?.with?.['postman-stack']).toBe('${{ inputs.postman-stack }}');
    });

    it('insights step receives postman-stack without explicit URL knobs', () => {
      const manifest = loadManifest();
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');

      expect(insightsStep?.with?.['postman-region']).toBe('${{ inputs.postman-region }}');
      expect(insightsStep?.with?.['postman-stack']).toBe('${{ inputs.postman-stack }}');
      expect(insightsStep?.with?.['postman-api-base']).toBeUndefined();
      expect(insightsStep?.with?.['postman-bifrost-base']).toBeUndefined();
      expect(insightsStep?.with?.['postman-observability-base']).toBeUndefined();
    });
  });

  describe('Phase 3: Safe Defaults', () => {
    it('generate-ci-workflow defaults to true', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['generate-ci-workflow']?.default).toBe('true');
    });

    it('ci-workflow-path defaults to .github/workflows/ci.yml', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['ci-workflow-path']?.default).toBe('.github/workflows/ci.yml');
    });

    it('environments-json defaults to ["prod"]', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['environments-json']?.default).toBe('["prod"]');
    });

    it('breaking-change controls default to off with runner-temp reports', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['breaking-change-mode']?.default).toBe('off');
      expect(manifest.inputs['breaking-rules-path']?.default).toBe('changes-rules.yaml');
      expect(manifest.inputs['breaking-summary-path']?.default).toBe('');
      expect(manifest.inputs['breaking-log-path']?.default).toBe('');
    });

    it('repo-write-mode defaults to commit-and-push', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['repo-write-mode']?.default).toBe('commit-and-push');
    });

    it('committer-name defaults to Postman', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['committer-name']?.default).toBe('Postman');
    });

    it('committer-email defaults to support@postman.com', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['committer-email']?.default).toBe('support@postman.com');
    });

    it('JSON map inputs default to empty object', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['system-env-map-json']?.default).toBe('{}');
      expect(manifest.inputs['governance-mapping-json']?.default).toBe('{}');
      expect(manifest.inputs['env-runtime-urls-json']?.default).toBe('{}');
      expect(manifest.inputs['environment-uids-json']?.default).toBe('{}');
    });

    it('postman-stack and postman-region default to public production without explicit base URL inputs', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['postman-stack']?.default).toBe('prod');
      expect(manifest.inputs['postman-stack']?.required).toBe(false);
      expect(manifest.inputs['postman-region']?.default).toBe('us');
      expect(manifest.inputs['postman-region']?.required).toBe(false);
      expect(manifest.inputs['postman-api-base']).toBeUndefined();
      expect(manifest.inputs['postman-bifrost-base']).toBeUndefined();
      expect(manifest.inputs['postman-gateway-base']).toBeUndefined();
      expect(manifest.inputs['postman-cli-install-url']).toBeUndefined();
    });

    it('every input has a description', () => {
      const manifest = loadManifest();
      for (const [name, input] of Object.entries(manifest.inputs)) {
        expect(input.description, `input "${name}" missing description`).toBeTruthy();
      }
    });

    it('every output has a description', () => {
      const manifest = loadManifest();
      for (const [name, output] of Object.entries(manifest.outputs)) {
        expect(output.description, `output "${name}" missing description`).toBeTruthy();
      }
    });
  });

  describe('Phase 4: Structural Integrity', () => {
    it('tsconfig.json exists with strict mode enabled', () => {
      const tsconfig = JSON.parse(
        readFileSync(path.join(repoRoot, 'tsconfig.json'), 'utf8')
      ) as Record<string, unknown>;
      const compilerOptions = tsconfig.compilerOptions as Record<string, unknown>;
      expect(compilerOptions.strict).toBe(true);
    });

    it('package.json has typecheck script', () => {
      const pkg = loadPackageJson();
      const scripts = pkg.scripts as Record<string, string>;
      expect(scripts.typecheck).toBeDefined();
      expect(scripts.typecheck).toContain('tsc');
    });

    it('package.json has test script', () => {
      const pkg = loadPackageJson();
      const scripts = pkg.scripts as Record<string, string>;
      expect(scripts.test).toBeDefined();
      expect(scripts.test).toContain('vitest');
    });

    it('no step references a non-existent input', () => {
      const manifest = loadManifest();
      const inputNames = new Set(Object.keys(manifest.inputs));
      const inputRefPattern = /\$\{\{\s*inputs\.([a-z0-9-]+)\s*\}\}/g;

      for (const step of manifest.runs.steps) {
        const stepYaml = JSON.stringify(step);
        const matches = Array.from(stepYaml.matchAll(inputRefPattern));
        for (const match of matches) {
          expect(
            inputNames.has(match[1]),
            `Step "${step.id}" references non-existent input "${"$"}{match[1]}"`
          ).toBe(true);
        }
      }
    });

    it('no output references a non-existent step', () => {
      const manifest = loadManifest();
      const stepIds = new Set(manifest.runs.steps.map((s) => s.id).filter(Boolean));
      const stepRefPattern = /\$\{\{\s*steps\.([a-z_]+)\.outputs\./g;

      for (const [outputName, output] of Object.entries(manifest.outputs)) {
        const matches = Array.from(output.value.matchAll(stepRefPattern));
        for (const match of matches) {
          expect(
            stepIds.has(match[1]),
            `Output "${outputName}" references non-existent step "${"$"}{match[1]}"`
          ).toBe(true);
        }
      }
    });
  });
});
