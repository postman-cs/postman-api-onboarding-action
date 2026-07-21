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
});
