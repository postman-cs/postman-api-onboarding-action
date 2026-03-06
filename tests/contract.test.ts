import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  ACTION_CONTRACT,
  DEFAULT_INTEGRATION_BACKEND,
  ORCHESTRATION_PHASES,
} from '../src/contracts';
import { buildActionPlan } from '../src/index';

const repoRoot = path.resolve(__dirname, '..');

describe('public beta contract', () => {
  it('defines the onboarding action as the primary external entrypoint', () => {
    expect(ACTION_CONTRACT.name).toBe('postman-api-onboarding-action');
    expect(ACTION_CONTRACT.entrypoint).toBe('postman-api-onboarding-action');
    expect(DEFAULT_INTEGRATION_BACKEND).toBe('bifrost');
    expect(ORCHESTRATION_PHASES).toEqual(['bootstrap', 'repo-sync']);
  });

  it('uses the agreed kebab-case inputs and outputs in action.yml', () => {
    const actionManifest = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');

    expect(actionManifest).toContain('project-name:');
    expect(actionManifest).toContain('spec-url:');
    expect(actionManifest).toContain('environments-json:');
    expect(actionManifest).toContain('governance-mapping-json:');
    expect(actionManifest).toContain('repo-write-mode:');
    expect(actionManifest).toContain('integration-backend:');
    expect(actionManifest).toContain('workspace-id:');
    expect(actionManifest).toContain('workspace-url:');
    expect(actionManifest).toContain('spec-id:');
    expect(actionManifest).toContain('environment-uids-json:');
    expect(actionManifest).toContain('commit-sha:');
    expect(actionManifest).toContain('orchestration-summary:');
  });

  it('builds a minimal orchestration plan over bootstrap and repo sync', () => {
    const plan = buildActionPlan({
      'project-name': 'core-payments',
      'domain-code': 'AF',
      'spec-url': 'https://example.com/openapi.yaml',
      'postman-api-key': 'pmak-test',
    });

    expect(plan.name).toBe('postman-api-onboarding-action');
    expect(plan.integrationBackend).toBe('bifrost');
    expect(plan.phases).toEqual([
      { name: 'bootstrap', enabled: true },
      { name: 'repo-sync', enabled: true },
    ]);
    expect(plan.outputs).toEqual({
      'integration-backend': 'bifrost',
      'workspace-id': '',
      'workspace-url': '',
      'spec-id': '',
      'collections-json': JSON.stringify({
        baseline: '',
        smoke: '',
        contract: '',
      }),
      'environment-uids-json': '{}',
      'mock-url': '',
      'monitor-id': '',
      'repo-sync-summary-json': JSON.stringify({
        repoWriteMode: 'commit-and-push',
        environmentsJson: '["prod"]',
        workspaceName: '[AF] core-payments',
      }),
      'commit-sha': '',
      'orchestration-summary': 'bootstrap -> repo-sync via bifrost',
    });
  });

  it('keeps the agreed partner-facing input and output contract', () => {
    expect(Object.keys(ACTION_CONTRACT.inputs)).toEqual([
      'project-name',
      'domain',
      'domain-code',
      'requester-email',
      'spec-url',
      'environments-json',
      'system-env-map-json',
      'governance-mapping-json',
      'postman-api-key',
      'postman-access-token',
      'github-token',
      'gh-fallback-token',
      'github-auth-mode',
      'repo-write-mode',
      'integration-backend',
    ]);
    expect(Object.keys(ACTION_CONTRACT.outputs)).toEqual([
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
      'orchestration-summary',
    ]);
  });
});
