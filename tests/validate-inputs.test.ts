import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..');

type Step = {
  id?: string;
  if?: string;
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
        ENABLE_INSIGHTS: 'false',
        INSIGHTS_POSTMAN_API_KEY: '',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: '',
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

function combinedOutput(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}${result.stderr}`;
}

function errorAnnotations(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('::error::'));
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

  it('resolves branch decision first, then validates before any child', () => {
    const steps = loadManifest().runs.steps;
    expect(steps[0]?.id).toBe('branch_decision');
    const validateStep = steps[1];
    expect(validateStep?.id).toBe('validate_postman_stack');
    expect(validateStep?.env?.REPO_WRITE_MODE).toBe('${{ inputs.repo-write-mode }}');
    expect(validateStep?.env?.POSTMAN_API_KEY).toBe('${{ inputs.postman-api-key }}');
    expect(validateStep?.env?.POSTMAN_ACCESS_TOKEN).toBe('${{ inputs.postman-access-token }}');
    expect(validateStep?.env?.ENABLE_INSIGHTS).toBe('${{ inputs.enable-insights }}');
    expect(validateStep?.env?.INSIGHTS_POSTMAN_API_KEY).toBe('${{ inputs.insights-postman-api-key }}');
    expect(validateStep?.env?.INSIGHTS_POSTMAN_ACCESS_TOKEN).toBe('${{ inputs.insights-postman-access-token }}');
    expect(validateStep?.env?.BRANCH_TIER).toBe('${{ steps.branch_decision.outputs.tier }}');
    expect(steps.findIndex((step) => step.id === 'bootstrap')).toBeGreaterThan(0);
  });

  it.each([
    {
      label: 'Insights disabled without dedicated credentials',
      env: { ENABLE_INSIGHTS: 'false', INSIGHTS_POSTMAN_API_KEY: '', INSIGHTS_POSTMAN_ACCESS_TOKEN: '' },
      status: 0
    },
    {
      label: 'Insights enabled with both dedicated credentials',
      env: { ENABLE_INSIGHTS: 'true', INSIGHTS_POSTMAN_API_KEY: 'PMAK-user', INSIGHTS_POSTMAN_ACCESS_TOKEN: 'user-token' },
      status: 0
    },
    {
      label: 'Insights enabled without dedicated API key',
      env: { ENABLE_INSIGHTS: 'true', INSIGHTS_POSTMAN_API_KEY: '', INSIGHTS_POSTMAN_ACCESS_TOKEN: 'user-token' },
      status: 1
    },
    {
      label: 'Insights enabled without dedicated access token',
      env: { ENABLE_INSIGHTS: 'true', INSIGHTS_POSTMAN_API_KEY: 'PMAK-user', INSIGHTS_POSTMAN_ACCESS_TOKEN: '' },
      status: 1
    }
  ])('$label validates dedicated Insights credentials before children run', ({ env, status }) => {
    const result = runValidation(env);
    expect(result.status).toBe(status);
    if (status !== 0) {
      const output = combinedOutput(result);
      expect(output).toContain('Attempted Insights credential validation failed');
      expect(output).toContain('both insights-postman-api-key and insights-postman-access-token are required');
    }
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
      const output = combinedOutput(result);
      expect(output).toContain('Attempted onboarding credential validation failed');
      expect(output).toContain('neither postman-api-key nor postman-access-token was supplied');
      expect(output).toContain('Provide one of those inputs and rerun');
    }
  });

  it('permits a gated decision without onboarding credentials', () => {
    const result = runValidation({ BRANCH_TIER: 'gated', POSTMAN_API_KEY: '', POSTMAN_ACCESS_TOKEN: '' });
    expect(result.status).toBe(0);
  });

  it.each(['none', 'commit-only', 'commit-and-push'])('accepts valid repo-write-mode=%s', (mode) => {
    const result = runValidation({ REPO_WRITE_MODE: mode });
    expect(result.status).toBe(0);
  });

  it.each([
    {
      envKey: 'POSTMAN_STACK',
      value: 'staging',
      attempted: 'Attempted postman-stack validation failed',
      accepted: 'Accepted values: prod, beta',
      remediation: 'Set the postman-stack input to one of those values'
    },
    {
      envKey: 'POSTMAN_REGION',
      value: 'apac',
      attempted: 'Attempted postman-region validation failed',
      accepted: 'Accepted values: us, eu',
      remediation: 'Set the postman-region input to one of those values'
    },
    {
      envKey: 'CREDENTIAL_PREFLIGHT',
      value: 'disabled',
      attempted: 'Attempted credential-preflight validation failed',
      accepted: 'Accepted values: warn, enforce',
      remediation: 'Set the credential-preflight input to one of those values'
    },
    {
      envKey: 'REPO_WRITE_MODE',
      value: 'push-only',
      attempted: 'Attempted repo-write-mode validation failed',
      accepted: 'Accepted values: none, commit-only, commit-and-push',
      remediation: 'Set the repo-write-mode input to one of those values'
    }
  ])('rejects invalid $envKey with actionable context and no value interpolation', ({
    envKey,
    value,
    attempted,
    accepted,
    remediation
  }) => {
    const result = runValidation({ [envKey]: value });
    const output = combinedOutput(result);
    expect(result.status).toBe(1);
    expect(output).toContain(attempted);
    expect(output).toContain('the provided value is unsupported');
    expect(output).toContain(accepted);
    expect(output).toContain(remediation);
    expect(output).not.toContain(value);
    expect(errorAnnotations(output)).toHaveLength(1);
  });

  it.each(['push-only', 'commit', 'invalid', ''])('rejects invalid repo-write-mode=%s before children run', (mode) => {
    const result = runValidation({ REPO_WRITE_MODE: mode });
    expect(result.status).toBe(1);
    const output = combinedOutput(result);
    expect(output).toContain('Attempted repo-write-mode validation failed');
    expect(output).toContain('Accepted values: none, commit-only, commit-and-push');
    expect(output).toContain('Set the repo-write-mode input to one of those values');
    // Rejected values that are substrings of accepted tokens (e.g. "commit") cannot
    // be asserted absent; for distinct tokens, prove the raw value is not echoed.
    if (mode !== '' && !'none, commit-only, commit-and-push'.includes(mode)) {
      expect(output).not.toContain(`got: ${mode}`);
      expect(output).not.toContain(mode);
    }
  });

  it('rejects newline/workflow-command-shaped invalid values without forging annotations', () => {
    const forgedPayload = 'evil\n::error::forged-annotation\n%0A::warning::injected';
    const result = runValidation({ POSTMAN_STACK: forgedPayload });
    const output = combinedOutput(result);
    expect(result.status).toBe(1);
    expect(output).toContain('Attempted postman-stack validation failed');
    expect(output).toContain('Accepted values: prod, beta');
    expect(output).toContain('Set the postman-stack input to one of those values');
    expect(output).not.toContain(forgedPayload);
    expect(output).not.toContain('::error::forged-annotation');
    expect(output).not.toContain('::warning::injected');
    expect(output).not.toContain('evil');
    expect(errorAnnotations(output)).toHaveLength(1);
    expect(errorAnnotations(output)[0]?.includes('\n')).toBe(false);
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

  it('forwards canonical credentials and omits them from gated bootstrap', () => {
    const steps = loadManifest().runs.steps;
    const bootstrap = steps.find((candidate) => candidate.id === 'bootstrap');
    const repoSync = steps.find((candidate) => candidate.id === 'repo_sync');
    expect(bootstrap?.with?.['postman-api-key']).toBe("${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-api-key || '' }}");
    expect(bootstrap?.with?.['postman-access-token']).toBe("${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-access-token || '' }}");
    expect(repoSync?.with?.['postman-api-key']).toBe('${{ inputs.postman-api-key }}');
    expect(repoSync?.with?.['postman-access-token']).toBe('${{ inputs.postman-access-token }}');
    expect(repoSync?.if).toContain("tier != 'gated'");
  });

  it('forwards only dedicated human-user credentials to Insights', () => {
    const insights = loadManifest().runs.steps.find((step) => step.id === 'insights_onboarding');
    expect(insights?.with?.['postman-api-key']).toBe('${{ inputs.insights-postman-api-key }}');
    expect(insights?.with?.['postman-access-token']).toBe('${{ inputs.insights-postman-access-token }}');
    expect(insights?.with?.['postman-api-key']).not.toBe('${{ inputs.postman-api-key }}');
    expect(insights?.with?.['postman-access-token']).not.toBe('${{ inputs.postman-access-token }}');
  });
});
