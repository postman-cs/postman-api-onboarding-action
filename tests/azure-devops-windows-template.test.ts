import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const templatePath = path.resolve(
  process.cwd(),
  'templates/azure-devops/windows-onboarding.yml'
);

const versionEnvironment = {
  RESOLVE_VERSION: '2.0.9',
  BOOTSTRAP_VERSION: '2.17.1',
  SMOKE_FLOW_VERSION: '2.1.10',
  REPO_SYNC_VERSION: '2.8.9',
  INSIGHTS_VERSION: '2.2.1'
};

function installStep(): { pwsh: string; env: Record<string, string> } {
  const template = parse(readFileSync(templatePath, 'utf8'));
  return template.jobs[0].steps.find(
    (step: { displayName?: string }) => step.displayName === 'Install pinned Postman onboarding CLIs'
  );
}

function runVersionValidation(overrides: Partial<typeof versionEnvironment> = {}) {
  const script = installStep().pwsh;
  const npmStart = script.indexOf('$packages = @(');
  if (npmStart < 0) throw new Error('version-validation prefix not found');
  return spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script.slice(0, npmStart)], {
    env: { ...process.env, ...versionEnvironment, ...overrides },
    encoding: 'utf8'
  });
}

describe('Azure DevOps Windows onboarding template', () => {
  it('orchestrates the existing CLIs on a native Windows job', () => {
    const source = readFileSync(templatePath, 'utf8');
    const template = parse(source);
    const job = template.jobs[0];
    const renderedScripts = job.steps
      .map((step: { pwsh?: string }) => step.pwsh || '')
      .join('\n');

    expect(job.pool.vmImage).toBe('windows-latest');
    expect(job.steps[0]).toMatchObject({ checkout: 'self', persistCredentials: true });
    expect(renderedScripts).toContain('postman-resolve-service-token');
    expect(renderedScripts).toContain('postman-bootstrap');
    expect(renderedScripts).toContain('postman-smoke-flow');
    expect(renderedScripts).toContain('postman-repo-sync');
    expect(renderedScripts).toContain('postman-insights-onboard');
    expect(renderedScripts).toContain('ConvertFrom-Json');
    expect(renderedScripts).toContain('issecret=true');
    expect(renderedScripts).toContain("'--ci-runner-os', 'windows'");
    expect(renderedScripts).toContain("'--mock-environment-enabled', $env:ENABLE_MOCK_ENVIRONMENT");
    expect(renderedScripts).toContain("'--mock-visibility', $env:MOCK_VISIBILITY");
    expect(renderedScripts).toContain('POSTMAN_MOCK_ENVIRONMENT_UID');
    expect(source).not.toMatch(/\bjq\b|\bsource\b|curl\s.*\|\s*sh|shell:\s*bash/);

    const tokenStep = job.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Resolve Postman service token'
    );
    expect(tokenStep.pwsh).toContain('$output = & postman-resolve-service-token');
    expect(tokenStep.pwsh).toContain('$result = $output | ConvertFrom-Json');
    expect(tokenStep.pwsh).not.toContain('--result-json');
  });

  it('pins every installed onboarding package instead of resolving latest', () => {
    const source = readFileSync(templatePath, 'utf8');
    const install = installStep();
    expect(source).not.toContain('@latest');
    expect(install.pwsh).toContain('onboarding-resolve-service-token@$env:RESOLVE_VERSION');
    expect(install.pwsh).toContain('onboarding-bootstrap@$env:BOOTSTRAP_VERSION');
    expect(install.pwsh).toContain('onboarding-smoke-flow@$env:SMOKE_FLOW_VERSION');
    expect(install.pwsh).toContain('onboarding-repo-sync@$env:REPO_SYNC_VERSION');
    expect(install.pwsh).toContain('onboarding-insights@$env:INSIGHTS_VERSION');
    expect(install.pwsh).not.toContain('${{ parameters.');
    expect(install.env).toEqual({
      RESOLVE_VERSION: '${{ parameters.resolveVersion }}',
      BOOTSTRAP_VERSION: '${{ parameters.bootstrapVersion }}',
      SMOKE_FLOW_VERSION: '${{ parameters.smokeFlowVersion }}',
      REPO_SYNC_VERSION: '${{ parameters.repoSyncVersion }}',
      INSIGHTS_VERSION: '${{ parameters.insightsVersion }}'
    });
  });

  // One pwsh spawn per case: a cold PowerShell start on a loaded runner is
  // 2-3s, so two sequential spawns inside one 5s budget were a flaky timeout.
  it.each([
    ['stable', {}],
    ['prerelease', { BOOTSTRAP_VERSION: '2.22.0-rc.1+build.7' }]
  ] as const)('accepts exact %s SemVer values before npm is invoked', (_label, overrides) => {
    expect(runVersionValidation(overrides).status).toBe(0);
  });

  it.each([
    ['RESOLVE_VERSION', "1.2.3'; Write-Output pwn; '"],
    ['BOOTSTRAP_VERSION', '^2.17.1'],
    ['SMOKE_FLOW_VERSION', 'latest'],
    ['REPO_SYNC_VERSION', 'https://example.invalid/pwn.tgz'],
    ['INSIGHTS_VERSION', 'github:attacker/pwn'],
    ['RESOLVE_VERSION', 'file:C:/pwn'],
    ['BOOTSTRAP_VERSION', '2.17.1 '],
    ['SMOKE_FLOW_VERSION', ' 2.1.10'],
    ['REPO_SYNC_VERSION', '02.8.9'],
    ['INSIGHTS_VERSION', '2.2']
  ] as const)('rejects non-exact npm version spec %s=%s before npm', (name, value) => {
    const result = runVersionValidation({ [name]: value });
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('Invalid exact SemVer');
    expect(output).not.toContain(value);
  });

  it('defaults bootstrapVersion to the pinned immutable 2.17.1', () => {
    const template = parse(readFileSync(templatePath, 'utf8'));
    const param = template.parameters.find(
      (p: { name: string }) => p.name === 'bootstrapVersion'
    );
    expect(param).toBeDefined();
    expect(param.type).toBe('string');
    expect(param.default).toBe('2.17.1');
  });

  it('declares a workspaceTeamId parameter with an empty default', () => {
    const template = parse(readFileSync(templatePath, 'utf8'));
    const param = template.parameters.find(
      (p: { name: string }) => p.name === 'workspaceTeamId'
    );
    expect(param).toBeDefined();
    expect(param.type).toBe('string');
    expect(param.default).toBe('');
  });

  it('forwards --workspace-team-id to bootstrap only when the value is non-empty', () => {
    const source = readFileSync(templatePath, 'utf8');
    const template = parse(source);
    const job = template.jobs[0];
    const bootstrapStep = job.steps.find(
      (step: { displayName?: string }) => step.displayName === 'Bootstrap Postman assets'
    );

    // The append is guarded by the same IsNullOrWhiteSpace conditional style
    // used for specPath/specUrl, so an empty value never forwards the flag.
    expect(bootstrapStep.pwsh).toMatch(
      /if\s*\(\s*-not\s*\[string\]::IsNullOrWhiteSpace\(\$env:WORKSPACE_TEAM_ID\)\s*\)\s*\{\s*\n\s*\$arguments\s*\+=\s*@\('--workspace-team-id',\s*\$env:WORKSPACE_TEAM_ID\)/
    );

    // The value is sourced exclusively from the workspaceTeamId parameter via
    // its own env var, never from POSTMAN_TEAM_ID.
    expect(bootstrapStep.env.WORKSPACE_TEAM_ID).toBe(
      '${{ parameters.workspaceTeamId }}'
    );
    expect(bootstrapStep.pwsh).not.toMatch(
      /--workspace-team-id',\s*\$env:POSTMAN_TEAM_ID/
    );

    // The pinned bootstrap CLI default tracks the released bootstrap version.
    const bootstrapParam = template.parameters.find(
      (p: { name: string }) => p.name === 'bootstrapVersion'
    );
    expect(bootstrapParam.default).toBe('2.17.1');
  });
});
