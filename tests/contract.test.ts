import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  with?: Record<string, string>;
};

type ActionManifest = {
  runs: {
    using: string;
    steps: Step[];
  };
  inputs: Record<string, { default?: string; required?: boolean }>;
  outputs: Record<string, { value: string }>;
};

function loadManifest(): ActionManifest {
  return parse(
    readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')
  ) as ActionManifest;
}

describe('postman-api-onboarding-action composite contract', () => {
  it('is a composite action and defaults integration-backend to bifrost', () => {
    const manifest = loadManifest();

    expect(manifest.runs.using).toBe('composite');
    expect(manifest.inputs['integration-backend']?.default).toBe('bifrost');
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
      'github-token',
      'gh-fallback-token',
      'github-auth-mode',
      'repo-write-mode',
      'current-ref',
      'committer-name',
      'committer-email',
      'enable-insights',
      'integration-backend'
    ]);
  });

  it('uses the postman-cs bootstrap and repo-sync actions as steps', () => {
    const manifest = loadManifest();
    const steps = manifest.runs.steps;

    expect(steps).toHaveLength(3);
    expect(steps[0]?.id).toBe('bootstrap');
    expect(steps[0]?.uses).toBe('postman-cs/postman-bootstrap-action@v0');
    expect(steps[1]?.id).toBe('repo_sync');
    expect(steps[1]?.uses).toBe('postman-cs/postman-repo-sync-action@hammad/cli-monitor');
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
    expect(manifest.outputs['monitor-type']?.value).toBe(
      '${{ steps.repo_sync.outputs.monitor-type }}'
    );
  });
});
