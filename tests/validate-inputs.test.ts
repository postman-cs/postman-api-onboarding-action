import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

type Step = {
  id?: string;
  run?: string;
  env?: Record<string, string>;
  uses?: string;
  with?: Record<string, string>;
};

type ActionManifest = {
  inputs: Record<string, { description?: string; default?: string; required?: boolean }>;
  runs: { steps: Step[] };
};

function loadManifest(): ActionManifest {
  return parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as ActionManifest;
}

function validationScript(): string {
  const step = loadManifest().runs.steps.find((candidate) => candidate.id === 'validate_postman_stack');
  if (!step?.run) {
    throw new Error('validate_postman_stack step is missing a run script');
  }
  return step.run;
}

function runValidation(env: Record<string, string>): { status: number; stderr: string; stdout: string } {
  try {
    const stdout = execFileSync('bash', ['-c', validationScript()], {
      env: {
        PATH: process.env.PATH ?? '',
        POSTMAN_STACK: 'prod',
        POSTMAN_REGION: 'us',
        CREDENTIAL_PREFLIGHT: 'warn',
        REPO_WRITE_MODE: 'commit-and-push',
        POSTMAN_API_KEY: 'PMAK-test',
        POSTMAN_ACCESS_TOKEN: '',
        ...env
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const failure = error as { status?: number; stderr?: string; stdout?: string };
    return {
      status: typeof failure.status === 'number' ? failure.status : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    };
  }
}

describe('composite first-step input validation', () => {
  it('declares postman-api-key and postman-access-token individually optional', () => {
    const manifest = loadManifest();
    expect(manifest.inputs['postman-api-key']?.required).toBe(false);
    expect(manifest.inputs['postman-access-token']?.required).toBe(false);
  });

  it('keeps the documented repo-write-mode default when the input is absent from the manifest contract', () => {
    const manifest = loadManifest();
    expect(manifest.inputs['repo-write-mode']?.required).toBe(false);
    expect(manifest.inputs['repo-write-mode']?.default).toBe('commit-and-push');
  });

  it('wires credential and repo-write-mode env into the first validation step before any child', () => {
    const steps = loadManifest().runs.steps;
    const validateStep = steps[0];
    expect(validateStep?.id).toBe('validate_postman_stack');
    expect(validateStep?.env?.REPO_WRITE_MODE).toBe('${{ inputs.repo-write-mode }}');
    expect(validateStep?.env?.POSTMAN_API_KEY).toBe('${{ inputs.postman-api-key }}');
    expect(validateStep?.env?.POSTMAN_ACCESS_TOKEN).toBe('${{ inputs.postman-access-token }}');
    expect(steps.findIndex((step) => step.id === 'bootstrap')).toBeGreaterThan(0);
  });

  it.each([
    { label: 'PMAK-only', env: { POSTMAN_API_KEY: 'PMAK-only', POSTMAN_ACCESS_TOKEN: '' }, status: 0 },
    { label: 'token-only', env: { POSTMAN_API_KEY: '', POSTMAN_ACCESS_TOKEN: 'token-only' }, status: 0 },
    {
      label: 'both',
      env: { POSTMAN_API_KEY: 'PMAK-both', POSTMAN_ACCESS_TOKEN: 'token-both' },
      status: 0
    },
    { label: 'neither', env: { POSTMAN_API_KEY: '', POSTMAN_ACCESS_TOKEN: '' }, status: 1 }
  ])('credential matrix: $label', ({ env, status }) => {
    const result = runValidation(env);
    expect(result.status).toBe(status);
    if (status !== 0) {
      expect(`${result.stdout}${result.stderr}`).toContain(
        'One of postman-api-key or postman-access-token is required'
      );
    }
  });

  it.each(['none', 'commit-only', 'commit-and-push'])('accepts valid repo-write-mode=%s', (mode) => {
    const result = runValidation({ REPO_WRITE_MODE: mode });
    expect(result.status).toBe(0);
  });

  it.each(['push-only', 'commit', 'invalid', ''])('rejects invalid repo-write-mode=%s before children run', (mode) => {
    const result = runValidation({ REPO_WRITE_MODE: mode });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'repo-write-mode must be one of: none, commit-only, commit-and-push'
    );
  });
});

describe('child invocation order and credential forwarding', () => {
  it('invokes bootstrap, repo-sync, and insights exactly once in that order', () => {
    const steps = loadManifest().runs.steps;
    const childIds = steps
      .map((step) => step.id)
      .filter((id): id is string => id === 'bootstrap' || id === 'repo_sync' || id === 'insights_onboarding');

    expect(childIds).toEqual(['bootstrap', 'repo_sync', 'insights_onboarding']);
    expect(steps.filter((step) => step.id === 'bootstrap')).toHaveLength(1);
    expect(steps.filter((step) => step.id === 'repo_sync')).toHaveLength(1);
    expect(steps.filter((step) => step.id === 'insights_onboarding')).toHaveLength(1);
  });

  it('forwards both credentials completely to bootstrap, repo-sync, and insights', () => {
    const steps = loadManifest().runs.steps;
    for (const stepId of ['bootstrap', 'repo_sync', 'insights_onboarding'] as const) {
      const step = steps.find((candidate) => candidate.id === stepId);
      expect(step?.with?.['postman-api-key'], `${stepId} postman-api-key`).toBe(
        '${{ inputs.postman-api-key }}'
      );
      expect(step?.with?.['postman-access-token'], `${stepId} postman-access-token`).toBe(
        '${{ inputs.postman-access-token }}'
      );
    }
  });
});
