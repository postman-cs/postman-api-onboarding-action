import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const templatePath = path.resolve(
  process.cwd(),
  'templates/azure-devops/windows-onboarding.yml'
);

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
    expect(source).not.toContain('@latest');
    expect(source).toMatch(/onboarding-resolve-service-token@\$\{\{ parameters\.resolveVersion \}\}/);
    expect(source).toMatch(/onboarding-bootstrap@\$\{\{ parameters\.bootstrapVersion \}\}/);
    expect(source).toMatch(/onboarding-smoke-flow@\$\{\{ parameters\.smokeFlowVersion \}\}/);
    expect(source).toMatch(/onboarding-repo-sync@\$\{\{ parameters\.repoSyncVersion \}\}/);
    expect(source).toMatch(/onboarding-insights@\$\{\{ parameters\.insightsVersion \}\}/);
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
  });
});
