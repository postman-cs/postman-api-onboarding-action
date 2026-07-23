import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
const releasePolicy = readFileSync(join(process.cwd(), 'RELEASE_POLICY.md'), 'utf8');

function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n  [a-zA-Z0-9_-]+:|\\n?$)`));
  return match?.[0] ?? '';
}

function classifierScript(): string {
  const match = releaseWorkflow.match(/ {6}- name: Classify release tag\n(?:.*\n)*? {8}run: \|\n([\s\S]*?)(?=\n\n {2}[a-z]|\n {2}[a-z])/);
  expect(match?.[1]).toBeTruthy();
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function runClassifier(options: { ref: string; refName: string; packageVersion: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'release-classify-'));
  const output = join(directory, 'github-output');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: options.packageVersion }));
  writeFileSync(output, '');
  writeFileSync(join(directory, 'classify.sh'), classifierScript());
  const result = spawnSync('bash', [join(directory, 'classify.sh')], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_REF: options.ref,
      GITHUB_REF_NAME: options.refName,
      GITHUB_OUTPUT: output
    }
  });
  const githubOutput = readFileSync(output, 'utf8');
  rmSync(directory, { recursive: true, force: true });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, githubOutput };
}

function runGatesBody(): string {
  const step = namedStep('Run gates');
  const match = step.match(/ {8}run: \|\n([\s\S]*)$/);
  expect(match?.[1]).toBeTruthy();
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

function launchedGates(body: string): Array<{ name: string; command: string }> {
  return [...body.matchAll(/^run (\S+) (.+)$/gm)].map((match) => ({
    name: match[1] ?? '',
    command: match[2] ?? ''
  }));
}

describe('release workflow publishing contract', () => {
  it('keeps existing classifier forms and executes immutable, alias, invalid, mismatched, and zero-patch cases', () => {
    expect(releaseWorkflow).toContain('IMMUTABLE=("v$PKG_VERSION")');
    expect(releaseWorkflow).toContain('IMMUTABLE+=("v$MAJOR.$MINOR")');
    expect(releaseWorkflow).toContain('elif [ "$GITHUB_REF_NAME" = "v$MAJOR" ]; then');
    expect(releaseWorkflow).toContain("echo 'release_kind=immutable'");
    expect(releaseWorkflow).toContain("echo 'release_kind=alias'");
    expect(releaseWorkflow).toContain("echo 'npm_publish=true'");
    expect(releaseWorkflow).toContain("echo 'npm_publish=false'");
    expect(releaseWorkflow).toContain('npm_publish: ${{ steps.release_tag.outputs.npm_publish }}');
    expect(releaseWorkflow).toContain('no release work will run');
    expect(releaseWorkflow).not.toContain('ALIAS_TAGS');
    expect(releaseWorkflow).not.toContain('publish_tag');
    expect(releaseWorkflow).not.toContain('needs.classify.outputs.npm_publish');

    const immutable = runClassifier({ ref: 'refs/tags/v2.1.2', refName: 'v2.1.2', packageVersion: '2.1.2' });
    expect(immutable.status).toBe(0);
    expect(immutable.githubOutput).toContain('release_kind=immutable');
    expect(immutable.githubOutput).toContain('npm_publish=true');

    const alias = runClassifier({ ref: 'refs/tags/v2', refName: 'v2', packageVersion: '2.1.2' });
    expect(alias.status).toBe(0);
    expect(alias.githubOutput).toContain('release_kind=alias');
    expect(alias.githubOutput).toContain('npm_publish=false');
    expect(`${alias.stdout}${alias.stderr}`).toMatch(/rolling alias|no release work will run/i);

    const branch = runClassifier({ ref: 'refs/heads/main', refName: 'main', packageVersion: '2.1.2' });
    expect(branch.status).not.toBe(0);
    expect(`${branch.stdout}${branch.stderr}`).toContain('::error::');
    expect(branch.githubOutput).not.toContain('release_kind=');
    expect(branch.githubOutput).not.toContain('npm_publish=');

    const mismatched = runClassifier({ ref: 'refs/tags/v2.1.1', refName: 'v2.1.1', packageVersion: '2.1.2' });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.githubOutput).not.toContain('release_kind=');
    expect(mismatched.githubOutput).not.toContain('npm_publish=');

    const zeroPatch = runClassifier({ ref: 'refs/tags/v2.2', refName: 'v2.2', packageVersion: '2.2.0' });
    expect(zeroPatch.status).toBe(0);
    expect(zeroPatch.githubOutput).toContain('release_kind=immutable');
    expect(zeroPatch.githubOutput).toContain('npm_publish=true');
  });

  it('classifies before dependency installation and guards every downstream job on immutable', () => {
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    for (const name of ['verify-package', 'publish', 'advance-major-alias']) {
      const body = job(name);
      expect(body).toContain('needs:');
      expect(body).toContain("if: needs.classify.outputs.release_kind == 'immutable'");
      expect(body).not.toContain('npm_publish');
    }
    expect(job('verify-package')).toContain('needs: classify');
    expect(job('publish')).toContain('needs: [classify, verify-package]');
    expect(job('advance-major-alias')).toContain('needs: [classify, publish]');
  });

  it('verifies composite sibling pins before packaging', () => {
    expect(releaseWorkflow).toContain('node scripts/check-sibling-pins.mjs');
    expect(releaseWorkflow.indexOf('npm ci')).toBeLessThan(releaseWorkflow.indexOf('node scripts/check-sibling-pins.mjs'));
    expect(releaseWorkflow.indexOf('node scripts/check-sibling-pins.mjs')).toBeLessThan(releaseWorkflow.indexOf('npm pack'));
  });

  it('queues exactly the five composite gates with MAX_PARALLEL_GATES=2 and failure aggregation', () => {
    const body = runGatesBody();
    expect(launchedGates(body)).toEqual([
      { name: 'lint', command: 'npm run lint' },
      { name: 'typecheck', command: 'npm run typecheck' },
      { name: 'test', command: 'npm test' },
      { name: 'sibling-pins', command: 'node scripts/check-sibling-pins.mjs' },
      { name: 'actionlint', command: '"$ACTIONLINT_BIN"' }
    ]);
    expect(body).toContain('MAX_PARALLEL_GATES=2');
    expect(body).toContain('wait -n');
    expect(body).toContain('gate:$n=pass');
    expect(body).toContain('gate:$n=fail');
    expect(body).toContain('exit $fail');
    expect(body).not.toMatch(/\bbundle\b/);
    expect(body).not.toMatch(/\bbuild\b/);
    expect(body).not.toContain('verify:dist');
    expect(body).not.toContain('check:dist');
    expect(body).not.toContain('rm -rf dist');
    expect(body).not.toContain('npm run dist');

    const verify = job('verify-package');
    expect(verify).toContain('contents: read');
    expect(verify).toContain('fetch-depth: 1');
    expect(verify).toContain(
      'https://raw.githubusercontent.com/rhysd/actionlint/393031adb9afb225ee52ae2ccd7a5af5525e03e8/scripts/download-actionlint.bash) 1.7.11 "$RUNNER_TEMP"'
    );
    expect(verify).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(verify).toContain('node scripts/verify-release-artifacts.mjs .');
    expect(verify).toContain('if-no-files-found: error');
    expect(verify).toContain('release-artifacts-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(verify).not.toContain('actions/setup-go');
    expect(verify).not.toContain('go install github.com/rhysd/actionlint');
    expect(releaseWorkflow).not.toContain('rhysd/actionlint/main/scripts/download-actionlint.bash');
  });

  it('uses artifact-only publish with trusted envelope verification before any tarball code', () => {
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run build');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/npm pack(?:\s|$)/);
    expect(publish).toContain('name: Verify release artifact envelope');
    expect(publish).toContain('name: Verify package identity from staged artifacts');
    const envelope = namedStep('Verify release artifact envelope');
    const identity = namedStep('Verify package identity from staged artifacts');
    const npm = namedStep('Publish or verify npm package');
    expect(envelope).toContain("artifact.path !== 'release.tgz'");
    expect(envelope).toContain('/^[a-f0-9]{64}$/');
    expect(envelope).not.toContain('tar -xOf');
    expect(envelope).not.toContain('NPM_TOKEN');
    expect(envelope).not.toContain('NODE_AUTH_TOKEN');
    expect(identity).toContain('tar -xOf release/release.tgz package/scripts/verify-release-artifacts.mjs');
    expect(identity).not.toContain('NPM_TOKEN');
    expect(identity).not.toContain('NODE_AUTH_TOKEN');
    expect(npm).toContain('NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');
    expect(publish.indexOf('Verify release artifact envelope')).toBeLessThan(
      publish.indexOf('tar -xOf release/release.tgz package/scripts/verify-release-artifacts.mjs')
    );
    expect(publish.indexOf('tar -xOf release/release.tgz package/scripts/verify-release-artifacts.mjs')).toBeLessThan(
      publish.indexOf('NODE_AUTH_TOKEN')
    );
  });

  it('publishes or verifies npm before GitHub Release and attaches staged artifacts', () => {
    const publish = job('publish');
    const npmPublish = publish.indexOf('npm publish ./release/release.tgz --provenance --access public');
    const githubRelease = publish.indexOf('softprops/action-gh-release');
    expect(npmPublish).toBeGreaterThanOrEqual(0);
    expect(githubRelease).toBeGreaterThanOrEqual(0);
    expect(npmPublish).toBeLessThan(githubRelease);
    expect(publish).toContain('Published npm integrity differs from staged tarball');
    expect(publish).toContain('release/release.tgz');
    expect(publish).toContain('release/release-manifest.json');
    expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('compares the rolling alias with check-release-alias before push', () => {
    const alias = namedStep('Advance rolling major alias');
    expect(alias).toContain('git ls-remote --tags origin');
    expect(alias).toContain('node scripts/check-release-alias.mjs');
    expect(alias).toContain('STATUS=$?');
    expect(alias).toContain('[ "$STATUS" -eq 10 ]');
    expect(alias).toContain('Keeping newer $MAJOR alias at v$CURRENT');
    expect(alias).toContain('git push origin "$MAJOR" --force');
    expect(alias.indexOf('check-release-alias.mjs')).toBeLessThan(alias.indexOf('git tag -fa'));
    expect(alias.indexOf('check-release-alias.mjs')).toBeLessThan(alias.indexOf('git push origin "$MAJOR" --force'));
    expect(alias).not.toContain('fetch-depth: 0');
    expect(job('advance-major-alias')).toContain('fetch-depth: 1');
  });

  it('documents live E2E as an asynchronous monitor and the current v2 release policy', () => {
    expect(releasePolicy).toContain('nightly `full` monitor');
    expect(releasePolicy).toContain('asynchronous post-release `smoke`');
    expect(releasePolicy).toContain('not a PR or publication gate');
    expect(releasePolicy).toContain('v2');
    expect(releasePolicy).toContain('rolling');
    expect(releasePolicy).not.toMatch(/\bv1\b/);
  });
});
