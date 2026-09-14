import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
        GITHUB_WORKSPACE: repoRoot,
        WORKING_DIRECTORY: '',
        SPEC_PATH: '',
        POSTMAN_STACK: 'prod',
        POSTMAN_REGION: 'us',
        CREDENTIAL_PREFLIGHT: 'warn',
        REPO_WRITE_MODE: 'commit-and-push',
        POSTMAN_API_KEY: 'PMAK-test',
        POSTMAN_ACCESS_TOKEN: '',
        ENABLE_INSIGHTS: 'false',
        ONBOARDING_SCOPE: 'full',
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

  it('resolves a credential-free branch decision before guarded masking and validation', () => {
    const steps = loadManifest().runs.steps;
    expect(steps[0]?.id).toBe('branch_decision');
    expect(steps[0]?.env).toEqual({
      BRANCH_STRATEGY: '${{ inputs.branch-strategy }}',
      CANONICAL_BRANCH: '${{ inputs.canonical-branch }}',
      CHANNELS: '${{ inputs.channels }}'
    });
    expect(JSON.stringify(steps[0])).not.toMatch(/api-key|access-token|github-token|gh-fallback-token/i);
    expect(steps[1]?.id).toBe('mask_postman_credentials');
    expect(steps[1]?.if).toContain("tier != 'gated'");
    const validateStep = steps[2];
    expect(validateStep?.id).toBe('validate_postman_stack');
    expect(validateStep?.if).toContain("tier != 'gated'");
    expect(validateStep?.env?.REPO_WRITE_MODE).toBe('${{ inputs.repo-write-mode }}');
    expect(validateStep?.env?.WORKING_DIRECTORY).toBe('${{ inputs.working-directory }}');
    expect(validateStep?.env?.SPEC_PATH).toBe('${{ inputs.spec-path }}');
    expect(validateStep?.env?.POSTMAN_API_KEY).toContain("tier != 'gated'");
    expect(validateStep?.env?.POSTMAN_ACCESS_TOKEN).toContain("tier != 'gated'");
    expect(validateStep?.env?.ENABLE_INSIGHTS).toBe('${{ inputs.enable-insights }}');
    expect(validateStep?.env?.ONBOARDING_SCOPE).toBe('${{ inputs.onboarding-scope }}');
    expect(validateStep?.env?.INSIGHTS_POSTMAN_API_KEY).toContain("tier != 'gated'");
    expect(validateStep?.env?.INSIGHTS_POSTMAN_ACCESS_TOKEN).toContain("tier != 'gated'");
    expect(validateStep?.env?.BRANCH_TIER).toBe('${{ steps.branch_decision.outputs.tier }}');
    expect(steps.findIndex((step) => step.id === 'bootstrap')).toBeGreaterThan(0);
  });

  it.each([
    {
      label: 'Insights disabled without dedicated credentials',
      env: {
        ENABLE_INSIGHTS: 'false',
        ONBOARDING_SCOPE: 'full',
        INSIGHTS_POSTMAN_API_KEY: '',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: ''
      },
      status: 0
    },
    {
      label: 'Insights enabled with both dedicated credentials',
      env: {
        ENABLE_INSIGHTS: 'true',
        ONBOARDING_SCOPE: 'full',
        INSIGHTS_POSTMAN_API_KEY: 'PMAK-user',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: 'user-token'
      },
      status: 0
    },
    {
      label: 'Insights omitted during spec-only sync without dedicated credentials',
      env: {
        ENABLE_INSIGHTS: 'true',
        ONBOARDING_SCOPE: 'spec-only',
        INSIGHTS_POSTMAN_API_KEY: '',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: ''
      },
      status: 0
    },
    {
      label: 'Insights enabled without dedicated API key',
      env: {
        ENABLE_INSIGHTS: 'true',
        ONBOARDING_SCOPE: 'full',
        INSIGHTS_POSTMAN_API_KEY: '',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: 'user-token'
      },
      status: 1
    },
    {
      label: 'Insights enabled without dedicated access token',
      env: {
        ENABLE_INSIGHTS: 'true',
        ONBOARDING_SCOPE: 'full',
        INSIGHTS_POSTMAN_API_KEY: 'PMAK-user',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: ''
      },
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
  }, 20_000);

  it('accepts an existing working directory', () => {
    expect(runValidation({ WORKING_DIRECTORY: 'tests' }).status).toBe(0);
  }, 20_000);

  it('rejects a working directory that resolves outside GITHUB_WORKSPACE', () => {
    const result = runValidation({ WORKING_DIRECTORY: '..' });
    expect(result.status).toBe(1);
    expect(combinedOutput(result)).toContain('working-directory does not exist under GITHUB_WORKSPACE');
  }, 20_000);

  it('rejects an existing sibling whose path merely shares the workspace prefix', () => {
    const sibling = mkdtempSync(`${repoRoot}-evil-`);
    try {
      const result = runValidation({ WORKING_DIRECTORY: sibling });
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('working-directory does not exist under GITHUB_WORKSPACE');
      expect(combinedOutput(result)).not.toContain(sibling);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 20_000);

  it('accepts an existing repository-relative spec path', () => {
    expect(runValidation({ SPEC_PATH: 'action.yml' }).status).toBe(0);
  }, 20_000);

  it('rejects an existing spec path outside GITHUB_WORKSPACE', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'outside-spec-'));
    const outsideSpec = path.join(outside, 'openapi.yaml');
    writeFileSync(outsideSpec, 'openapi: 3.1.0\n');
    try {
      const result = runValidation({ SPEC_PATH: outsideSpec });
      expect(result.status).toBe(1);
      expect(combinedOutput(result)).toContain('spec-path does not name a file under GITHUB_WORKSPACE');
      expect(combinedOutput(result)).not.toContain(outsideSpec);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 20_000);

  it('rejects a missing working directory without reflecting the input', () => {
    const value = 'services/missing\n::error::forged-annotation';
    const result = runValidation({ WORKING_DIRECTORY: value });
    const output = combinedOutput(result);
    expect(result.status).toBe(1);
    expect(output).toContain('working-directory does not exist under GITHUB_WORKSPACE');
    expect(output).not.toContain(value);
    expect(output).not.toContain('forged-annotation');
    expect(errorAnnotations(output)).toHaveLength(1);
  }, 20_000);

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
  }, 20_000);

  it('permits a gated decision without onboarding credentials', () => {
    const result = runValidation({ BRANCH_TIER: 'gated', POSTMAN_API_KEY: '', POSTMAN_ACCESS_TOKEN: '' });
    expect(result.status).toBe(0);
  }, 20_000);

  it.each(['none', 'commit-only', 'commit-and-push'])('accepts valid repo-write-mode=%s', (mode) => {
    const result = runValidation({ REPO_WRITE_MODE: mode });
    expect(result.status).toBe(0);
  }, 20_000);

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
    },
    {
      envKey: 'ONBOARDING_SCOPE',
      value: 'specs-only',
      attempted: 'Attempted onboarding-scope validation failed',
      accepted: 'Accepted values: full, spec-only',
      remediation: 'Set the onboarding-scope input to one of those values'
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
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);
});

describe('child invocation order and credential forwarding', () => {
  it('masks every Postman credential only after an eligible branch decision', () => {
    const steps = loadManifest().runs.steps;
    const maskStep = steps.find((step) => step.id === 'mask_postman_credentials');
    expect(steps[0]?.id).toBe('branch_decision');
    expect(steps.indexOf(maskStep!)).toBe(1);
    expect(maskStep?.if).toContain("tier != 'gated'");
    expect(maskStep?.env).toEqual({
      POSTMAN_TEAM_ID: '${{ inputs.postman-team-id }}',
      POSTMAN_API_KEY: "${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-api-key || '' }}",
      POSTMAN_ACCESS_TOKEN: "${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-access-token || '' }}",
      INSIGHTS_POSTMAN_API_KEY:
        "${{ steps.branch_decision.outputs.tier != 'gated' && inputs.insights-postman-api-key || '' }}",
      INSIGHTS_POSTMAN_ACCESS_TOKEN:
        "${{ steps.branch_decision.outputs.tier != 'gated' && inputs.insights-postman-access-token || '' }}"
    });
    expect(maskStep?.run).toContain("value=${value//'%'/%25}");
    expect(maskStep?.run).toContain("value=${value//$'\\n'/%0A}");
    expect(maskStep?.run).toContain("printf '::add-mask::%s\\n' \"$value\"");

    const output = execFileSync('bash', ['--noprofile', '--norc', '-c', maskStep?.run ?? ''], {
      env: {
        PATH: process.env.PATH ?? '',
        POSTMAN_TEAM_ID: '',
        POSTMAN_API_KEY: 'primary%key\nnext',
        POSTMAN_ACCESS_TOKEN: 'primary-token',
        INSIGHTS_POSTMAN_API_KEY: 'insights-key',
        INSIGHTS_POSTMAN_ACCESS_TOKEN: 'insights-token'
      },
      encoding: 'utf8'
    });
    expect(output.trim().split('\n')).toEqual([
      '::add-mask::primary%25key%0Anext',
      '::add-mask::primary-token',
      '::add-mask::insights-key',
      '::add-mask::insights-token'
    ]);
  });

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
    expect(bootstrap?.if).toContain("tier != 'gated'");
    expect(bootstrap?.with?.['postman-api-key']).toBe("${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-api-key || '' }}");
    expect(bootstrap?.with?.['postman-access-token']).toBe("${{ steps.branch_decision.outputs.tier != 'gated' && inputs.postman-access-token || '' }}");
    expect(repoSync?.with?.['postman-api-key']).toContain("tier != 'gated'");
    expect(repoSync?.with?.['postman-access-token']).toContain("tier != 'gated'");
    expect(repoSync?.if).toContain("tier != 'gated'");
  });

  it('forwards only dedicated human-user credentials to Insights', () => {
    const insights = loadManifest().runs.steps.find((step) => step.id === 'insights_onboarding');
    expect(insights?.with?.['postman-api-key']).toContain('inputs.insights-postman-api-key');
    expect(insights?.with?.['postman-access-token']).toContain('inputs.insights-postman-access-token');
    expect(insights?.with?.['postman-api-key']).toContain("tier != 'gated'");
    expect(insights?.with?.['postman-access-token']).toContain("tier != 'gated'");
    expect(insights?.with?.['postman-api-key']).not.toBe('${{ inputs.postman-api-key }}');
    expect(insights?.with?.['postman-access-token']).not.toBe('${{ inputs.postman-access-token }}');
  });

  it('guards every credential-bearing or mutating inner step from the gated path', () => {
    const steps = loadManifest().runs.steps;
    const guardedStepIds = [
      'mask_postman_credentials',
      'validate_postman_stack',
      'bootstrap',
      'smoke_flow',
      'repo_sync',
      'warn_tests_skipped_no_api_key',
      'install_postman_cli_windows',
      'run_tests_junit',
      'upload_junit_artifact',
      'insights_onboarding'
    ];
    for (const id of guardedStepIds) {
      const step = steps.find((candidate) => candidate.id === id);
      expect(step, `${id} exists`).toBeTruthy();
      expect(step?.if, `${id} has a tier guard`).toContain("steps.branch_decision.outputs.tier != 'gated'");
    }

    const sensitiveInputNames = [
      'postman-api-key',
      'postman-access-token',
      'insights-postman-api-key',
      'insights-postman-access-token',
      'github-token',
      'gh-fallback-token'
    ];
    for (const step of steps.slice(1)) {
      for (const value of [...Object.values(step.env ?? {}), ...Object.values(step.with ?? {})]) {
        if (!sensitiveInputNames.some((name) => value.includes(`inputs.${name}`))) continue;
        expect(value, `${step.id ?? step.uses} conditionally empties a sensitive value`).toContain(
          "steps.branch_decision.outputs.tier != 'gated'"
        );
      }
    }
  });
});
