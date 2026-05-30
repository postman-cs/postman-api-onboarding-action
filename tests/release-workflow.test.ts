import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

function npmRegistrySetupStep(): string {
  const match = releaseWorkflow.match(/ {6}- uses: actions\/setup-node@v5\n[\s\S]*?registry-url: 'https:\/\/registry\.npmjs\.org'\n/);
  return match?.[0] ?? '';
}

describe('release workflow publishing contract', () => {
  it('keeps v0 as the only rolling alias and v0.x as a zero-patch publish tag', () => {
    expect(releaseWorkflow).toContain('PUBLISH_TAGS=("$PKG_VERSION")');
    expect(releaseWorkflow).toContain('PUBLISH_TAGS+=("$MAJOR.$MINOR")');
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ]; then');
    expect(releaseWorkflow).toContain('echo "npm_publish=true" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('echo "npm_publish=false" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('skipping npm publish');
    expect(releaseWorkflow).not.toContain('ALIAS_TAGS');
    expect(releaseWorkflow).not.toContain('publish_tag');
  });

  it('keeps GitHub release artifacts while making npm publication idempotent', () => {
    expect(namedStep('Publish GitHub release')).not.toMatch(/\n\s+if:/);
    expect(npmRegistrySetupStep()).toContain("if: steps.release_tag.outputs.npm_publish == 'true'");
    expect(namedStep('Check npm package version')).toContain('id: npm_package');
    expect(namedStep('Check npm package version')).toContain('npm view "$PKG_NAME@$PKG_VERSION" version');
    expect(namedStep('Check npm package version')).toContain('already_published=true');
    expect(namedStep('Publish to npm')).toContain("if: steps.release_tag.outputs.npm_publish == 'true' && steps.npm_package.outputs.already_published != 'true'");
    expect(namedStep('Attach npm tarball to release')).not.toMatch(/\n\s+if:/);
    expect(namedStep('Upload tarball')).not.toMatch(/\n\s+if:/);
  });
});
