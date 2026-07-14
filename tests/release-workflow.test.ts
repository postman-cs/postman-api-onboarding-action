import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n  [a-zA-Z0-9_-]+:|\\n?$)`));
  return match?.[0] ?? '';
}

function npmRegistrySetupStep(): string {
  return releaseWorkflow
    .match(/ {6}- uses: actions\/setup-node@v\d+\n(?: {8}[^\n]+\n| {10}[^\n]+\n)*/g)
    ?.find((step) => step.includes("registry-url: 'https://registry.npmjs.org'") && step.includes("if: steps.release_tag.outputs.npm_publish == 'true'")) ?? '';
}

describe('release workflow publishing contract', () => {
  it('verifies composite sibling pins before publishing', () => {
    expect(namedStep('Verify composite sibling pins')).toContain('node scripts/check-sibling-pins.mjs');
    expect(releaseWorkflow.indexOf('npm test')).toBeLessThan(releaseWorkflow.indexOf('node scripts/check-sibling-pins.mjs'));
    expect(releaseWorkflow.indexOf('node scripts/check-sibling-pins.mjs')).toBeLessThan(
      releaseWorkflow.indexOf('Verify release tag matches package version')
    );
  });

  it('keeps v1 as the only rolling alias and v1.x as a zero-patch publish tag', () => {
    expect(releaseWorkflow).toContain('PUBLISH_TAGS=("$PKG_VERSION")');
    expect(releaseWorkflow).toContain('PUBLISH_TAGS+=("$MAJOR.$MINOR")');
    expect(releaseWorkflow).toContain('if [ "$TAG_VERSION" = "$MAJOR" ]; then');
    expect(releaseWorkflow).not.toContain('if [ "$TAG_VERSION" = "0" ]; then');
    expect(releaseWorkflow).toContain('or v$MAJOR');
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

  it('advances the rolling major alias after an immutable release publishes', () => {
    expect(releaseWorkflow).toContain('advance-major-alias:');
    expect(releaseWorkflow).toContain("needs: release");
    expect(releaseWorkflow).toContain("if: ${{ needs.release.outputs.npm_publish == 'true' }}");
    expect(namedStep('Force-move rolling major alias tag')).toContain('git tag -fa "$MAJOR"');
    expect(namedStep('Force-move rolling major alias tag')).toContain('git push origin "$MAJOR" --force');
  });
});
