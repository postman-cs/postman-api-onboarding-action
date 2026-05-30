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
  it('treats rolling aliases as release tags but not npm publish tags', () => {
    expect(releaseWorkflow).toContain('ALIAS_TAGS=("$MAJOR")');
    expect(releaseWorkflow).toContain('ALIAS_TAGS+=("$MAJOR.$MINOR")');
    expect(releaseWorkflow).toContain('echo "npm_publish=true" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('echo "npm_publish=false" >> "$GITHUB_OUTPUT"');
    expect(releaseWorkflow).toContain('skipping npm publish');
    expect(releaseWorkflow).not.toContain('PUBLISH_TAGS');
    expect(releaseWorkflow).not.toContain('publish_tag');
  });

  it('keeps GitHub release artifacts for aliases while gating only npm publication', () => {
    expect(namedStep('Publish GitHub release')).not.toMatch(/\n\s+if:/);
    expect(npmRegistrySetupStep()).toContain("if: steps.release_tag.outputs.npm_publish == 'true'");
    expect(namedStep('Publish to npm')).toContain("if: steps.release_tag.outputs.npm_publish == 'true'");
    expect(namedStep('Attach npm tarball to release')).not.toMatch(/\n\s+if:/);
    expect(namedStep('Upload tarball')).not.toMatch(/\n\s+if:/);
  });
});
