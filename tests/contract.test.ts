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

function loadRestMigrationSeam(): string {
  return readFileSync(path.join(repoRoot, 'REST_MIGRATION_SEAM.md'), 'utf8');
}

describe('postman-api-onboarding-action composite contract', () => {
  describe('Phase 1: Documentation & Metadata', () => {
    it('action.yml name matches repository name', () => {
      const manifest = loadManifest();
      expect(manifest.name).toBe('postman-api-onboarding-action');
    });

    it('package.json name matches repository name', () => {
      const pkg = loadPackageJson();
      expect(pkg.name).toBe('postman-api-onboarding-action');
    });

    it('description references open-alpha, not beta', () => {
      const manifest = loadManifest();
      const pkg = loadPackageJson();
      expect(manifest.description).toContain('open-alpha');
      expect(manifest.description).not.toContain('beta');
      expect(String(pkg.description)).toContain('open-alpha');
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

    it('REST_MIGRATION_SEAM.md references open-alpha, not beta', () => {
      const seam = loadRestMigrationSeam();
      expect(seam).toContain('open-alpha');
      expect(seam).not.toMatch(/\bbeta\b/i);
    });

    it('package.json version uses alpha pre-release tag', () => {
      const pkg = loadPackageJson();
      expect(String(pkg.version)).toMatch(/alpha/);
      expect(String(pkg.version)).not.toMatch(/beta/);
    });

    it('README documents all inputs from action.yml', () => {
      const manifest = loadManifest();
      const readme = loadReadme();
      for (const inputName of Object.keys(manifest.inputs)) {
        expect(readme).toContain(`\`${inputName}\``);
      }
    });

    it('README documents all outputs from action.yml', () => {
      const manifest = loadManifest();
      const readme = loadReadme();
      for (const outputName of Object.keys(manifest.outputs)) {
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
        'monitor-id',
        'mock-url',
        'monitor-cron',
        'generate-ci-workflow',
        'ci-workflow-path',
        'project-name',
        'domain',
        'domain-code',
        'requester-email',
        'workspace-admin-user-ids',
        'spec-url',
        'environments-json',
        'system-env-map-json',
        'governance-mapping-json',
        'env-runtime-urls-json',
        'postman-api-key',
        'postman-access-token',
        'postman-team-id',
        'github-token',
        'gh-fallback-token',
        'github-auth-mode',
        'repo-write-mode',
        'current-ref',
        'committer-name',
        'committer-email',
        'enable-insights',
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

    it('project-name and spec-url remain required', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['project-name']?.required).toBe(true);
      expect(manifest.inputs['spec-url']?.required).toBe(true);
    });

    it('defaults integration-backend to bifrost', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['integration-backend']?.default).toBe('bifrost');
    });

    it('defaults enable-insights to false', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['enable-insights']?.default).toBe('false');
    });

    it('has the complete expected output set', () => {
      const manifest = loadManifest();
      expect(Object.keys(manifest.outputs)).toEqual([
        'integration-backend',
        'workspace-id',
        'workspace-url',
        'spec-id',
        'collections-json',
        'environment-uids-json',
        'mock-url',
        'monitor-id',
        'repo-sync-summary-json',
        'commit-sha',
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
    it('is a composite action with three steps', () => {
      const manifest = loadManifest();
      expect(manifest.runs.using).toBe('composite');
      expect(manifest.runs.steps).toHaveLength(3);
    });

    it('uses the postman-cs bootstrap, repo-sync, and insights actions', () => {
      const manifest = loadManifest();
      const steps = manifest.runs.steps;

      expect(steps[0]?.id).toBe('bootstrap');
      expect(steps[0]?.uses).toBe('postman-cs/postman-bootstrap-action@v0');
      expect(steps[1]?.id).toBe('repo_sync');
      expect(steps[1]?.uses).toBe('postman-cs/postman-repo-sync-action@v0');
      expect(steps[2]?.id).toBe('insights_onboarding');
      expect(steps[2]?.uses).toBe('postman-cs/postman-insights-onboarding-action@v0');
    });

    it('insights step is conditional on enable-insights', () => {
      const manifest = loadManifest();
      const insightsStep = manifest.runs.steps.find((s) => s.id === 'insights_onboarding');
      expect(insightsStep?.if).toContain('enable-insights');
      expect(insightsStep?.if).toContain("'true'");
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
      expect(repoSyncStep?.with?.['generate-ci-workflow']).toBe(
        '${{ inputs.generate-ci-workflow }}'
      );
      expect(repoSyncStep?.with?.['ci-workflow-path']).toBe(
        '${{ inputs.ci-workflow-path }}'
      );
    });

    it('surfaces final outputs from bootstrap and repo-sync steps', () => {
      const manifest = loadManifest();

      expect(manifest.outputs['workspace-id']?.value).toBe(
        '${{ steps.bootstrap.outputs.workspace-id }}'
      );
      expect(manifest.outputs['collections-json']?.value).toBe(
        '${{ steps.bootstrap.outputs.collections-json }}'
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

    it('passes integration-backend to bootstrap and repo-sync', () => {
      const manifest = loadManifest();
      const bootstrapStep = manifest.runs.steps.find((s) => s.id === 'bootstrap');
      const repoSyncStep = manifest.runs.steps.find((s) => s.id === 'repo_sync');

      expect(bootstrapStep?.with?.['integration-backend']).toBe('${{ inputs.integration-backend }}');
      expect(repoSyncStep?.with?.['integration-backend']).toBe('${{ inputs.integration-backend }}');
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

    it('repo-write-mode defaults to commit-and-push', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['repo-write-mode']?.default).toBe('commit-and-push');
    });

    it('github-auth-mode defaults to github_token_first', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['github-auth-mode']?.default).toBe('github_token_first');
    });

    it('committer-name defaults to Postman CSE', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['committer-name']?.default).toBe('Postman CSE');
    });

    it('committer-email defaults to help@postman.com', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['committer-email']?.default).toBe('help@postman.com');
    });

    it('JSON map inputs default to empty object', () => {
      const manifest = loadManifest();
      expect(manifest.inputs['system-env-map-json']?.default).toBe('{}');
      expect(manifest.inputs['governance-mapping-json']?.default).toBe('{}');
      expect(manifest.inputs['env-runtime-urls-json']?.default).toBe('{}');
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
            `Step "${step.id}" references non-existent input "${match[1]}"`
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
            `Output "${outputName}" references non-existent step "${match[1]}"`
          ).toBe(true);
        }
      }
    });
  });
});
