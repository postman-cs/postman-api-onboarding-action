import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const releaseWorkflow = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8').replace(/\r\n/g, '\n');
const releasePolicy = readFileSync(join(process.cwd(), 'RELEASE_POLICY.md'), 'utf8').replace(/\r\n/g, '\n');
const actionDefinition = readFileSync(join(process.cwd(), 'action.yml'), 'utf8').replace(/\r\n/g, '\n');

/** Convert a native path into a Git Bash-safe absolute path on Windows. */
function bashPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  return filePath.replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`).replace(/\\/g, '/');
}

function bashExecutable(): string {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.GIT_INSTALL_ROOT && join(process.env.GIT_INSTALL_ROOT, 'bin', 'bash.exe'),
    process.env.ProgramFiles && join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error('Git Bash is required to execute classifier scripts on Windows');
  return executable;
}

/** Minimal env for bash→node classifier runs; keeps Windows process bootstrap vars. */
function classifierEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '',
    Path: process.env.Path ?? process.env.PATH ?? '',
    PATHEXT: process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD',
    SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? '',
    SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? '',
    COMSPEC: process.env.COMSPEC ?? process.env.ComSpec ?? '',
    ComSpec: process.env.ComSpec ?? process.env.COMSPEC ?? '',
    ...overrides
  };
  return env;
}

function job(name: string): string {
  return releaseWorkflow.match(new RegExp(`  ${name}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:|$)`))?.[0] ?? '';
}

function namedStep(name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = releaseWorkflow.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n  [a-zA-Z0-9_-]+:|\\n?$)`));
  return match?.[0] ?? '';
}

let cachedClassifierScript: string | undefined;

function classifierScript(): string {
  if (cachedClassifierScript !== undefined) return cachedClassifierScript;
  const match = releaseWorkflow.match(/ {6}- name: Classify release tag\n(?:.*\n)*? {8}run: \|\n([\s\S]*?)(?=\n\n {2}[a-z]|\n {2}[a-z])/);
  expect(match?.[1]).toBeTruthy();
  cachedClassifierScript = (match?.[1] ?? '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
  return cachedClassifierScript;
}

function runClassifier(options: { ref: string; refName: string; packageVersion: string }) {
  const directory = mkdtempSync(join(tmpdir(), 'release-classify-'));
  const output = join(directory, 'github-output');
  const scriptPath = join(directory, 'classify.sh');
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: options.packageVersion }));
  writeFileSync(output, '');
  writeFileSync(scriptPath, classifierScript());
  // Lean env + bash-safe paths: avoid huge process.env copies while keeping Windows node bootstrap.
  const result = spawnSync(bashExecutable(), [bashPath(scriptPath)], {
    cwd: directory,
    encoding: 'utf8',
    env: classifierEnv({
      GITHUB_REF: options.ref,
      GITHUB_REF_NAME: options.refName,
      GITHUB_OUTPUT: bashPath(output)
    })
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

function namedStepRunBody(name: string): string {
  const step = namedStep(name);
  const match = step.match(/ {8}run: \|\n([\s\S]*)$/);
  expect(match?.[1]).toBeTruthy();
  return (match?.[1] ?? '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
}

describe('Windows-portable classifier harness', () => {
  it('converts drive-letter paths for Git Bash and keeps Windows node bootstrap vars', () => {
    const windowsNative = 'C:\\Users\\runner\\AppData\\Local\\Temp\\out';
    const gitBashPath = windowsNative
      .replace(/^([A-Za-z]):[\\/]/, (_, drive: string) => `/${drive.toLowerCase()}/`)
      .replace(/\\/g, '/');
    expect(gitBashPath).toBe('/c/Users/runner/AppData/Local/Temp/out');
    if (process.platform === 'win32') {
      expect(bashPath(windowsNative)).toBe(gitBashPath);
    } else {
      expect(bashPath('/tmp/out')).toBe('/tmp/out');
    }
    const env = classifierEnv({ GITHUB_OUTPUT: '/tmp/out', GITHUB_REF_NAME: 'v2.1.2' });
    expect(env.PATH || env.Path).toBeTruthy();
    expect(env).toHaveProperty('SYSTEMROOT');
    expect(env).toHaveProperty('SystemRoot');
    expect(env).toHaveProperty('PATHEXT');
    expect(env.GITHUB_OUTPUT).toBe('/tmp/out');
    expect(env.GITHUB_REF_NAME).toBe('v2.1.2');
    // Lean copy: do not ship the full parent process environment into bash→node.
    expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length);
  });
});

describe('release workflow publishing contract', () => {
  it('keeps existing classifier forms for immutable, alias, and npm_publish outputs', () => {
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
  });

  it.each([
    {
      label: 'immutable',
      ref: 'refs/tags/v2.1.2',
      refName: 'v2.1.2',
      packageVersion: '2.1.2',
      status: 0,
      githubOutput: ['release_kind=immutable', 'npm_publish=true'],
      diagIncludes: [] as string[],
      diagExcludesOutput: [] as string[]
    },
    {
      label: 'alias',
      ref: 'refs/tags/v2',
      refName: 'v2',
      packageVersion: '2.1.2',
      status: 0,
      githubOutput: ['release_kind=alias', 'npm_publish=false'],
      diagIncludes: ['rolling alias|no release work will run'],
      diagExcludesOutput: [] as string[]
    },
    {
      label: 'non-tag branch',
      ref: 'refs/heads/main',
      refName: 'main',
      packageVersion: '2.1.2',
      status: 1,
      githubOutput: [],
      diagIncludes: ['::error::', 'refs/heads/main', 'v2.1.2', 'v2'],
      diagExcludesOutput: ['release_kind=', 'npm_publish=']
    },
    {
      label: 'mismatched tag',
      ref: 'refs/tags/v2.1.1',
      refName: 'v2.1.1',
      packageVersion: '2.1.2',
      status: 1,
      githubOutput: [],
      diagIncludes: ['::error::', 'refs/tags/v2.1.1', 'v2.1.2', 'v2'],
      diagExcludesOutput: ['release_kind=', 'npm_publish=']
    },
    {
      label: 'zero-patch minor',
      ref: 'refs/tags/v2.2',
      refName: 'v2.2',
      packageVersion: '2.2.0',
      status: 0,
      githubOutput: ['release_kind=immutable', 'npm_publish=true'],
      diagIncludes: [] as string[],
      diagExcludesOutput: [] as string[]
    }
  ])('executes classifier for $label', (testcase) => {
    const result = runClassifier({
      ref: testcase.ref,
      refName: testcase.refName,
      packageVersion: testcase.packageVersion
    });
    if (testcase.status === 0) {
      expect(result.status).toBe(0);
    } else {
      expect(result.status).not.toBe(0);
    }
    for (const fragment of testcase.githubOutput) {
      expect(result.githubOutput).toContain(fragment);
    }
    for (const fragment of testcase.diagExcludesOutput) {
      expect(result.githubOutput).not.toContain(fragment);
    }
    const diag = `${result.stdout}${result.stderr}`;
    for (const fragment of testcase.diagIncludes) {
      if (fragment.includes('|')) {
        expect(diag).toMatch(new RegExp(fragment, 'i'));
      } else {
        expect(diag).toContain(fragment);
      }
    }
  }, 20_000);

  it('classifies before dependency installation and guards release work on immutable', () => {
    expect(releaseWorkflow.indexOf('Classify release tag')).toBeLessThan(releaseWorkflow.indexOf('npm ci'));
    for (const name of ['verify-package', 'publish']) {
      const body = job(name);
      expect(body).toContain('needs:');
      expect(body).toContain("if: needs.classify.outputs.release_kind == 'immutable'");
      expect(body).not.toContain('npm_publish');
    }
    expect(job('verify-package')).toContain('needs: classify');
    expect(job('publish')).toContain('needs: [classify, verify-package]');
    expect(job('verify-release-e2e')).toContain('needs: [classify, verify-package, publish]');
    expect(job('advance-major-alias')).toContain('needs: [classify, publish, verify-release-e2e]');
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
    expect(releaseWorkflow).not.toContain('rhysd/actionlint/main/scripts/download-actionlint.bash');
    expect(releaseWorkflow).not.toContain('actions/setup-go');
    expect(releaseWorkflow).not.toContain('go install github.com/rhysd/actionlint');
    expect(releaseWorkflow).not.toContain('go install');
  });

  it('uses one trusted inline publish verifier before OIDC publication without executing package code', () => {
    const publish = job('publish');
    expect(publish).toMatch(/permissions:\n\s+contents: write\n\s+id-token: write/);
    expect(publish).not.toContain('actions/checkout');
    expect(publish).not.toContain('cache:');
    expect(publish).not.toContain('npm ci');
    expect(publish).not.toContain('npm run build');
    expect(publish).not.toContain('npm test');
    expect(publish).not.toMatch(/npm pack(?:\s|$)/);
    expect(publish).toContain('name: Verify release artifact envelope');
    expect(publish).not.toContain('Verify package identity from staged artifacts');
    expect(publish).not.toContain('package/scripts/verify-release-artifacts.mjs');
    expect(publish).not.toContain('RUNNER_TEMP/verify-release-artifacts.mjs');
    expect(publish).not.toContain('$RUNNER_TEMP/verify-release-artifacts.mjs');
    const envelope = namedStep('Verify release artifact envelope');
    const npm = namedStep('Publish npm package');
    expect(envelope).toContain("artifact.path !== 'release.tgz'");
    expect(envelope).toContain('/^[a-f0-9]{64}$/');
    expect(envelope).toContain("execFileSync('tar', ['-xOf', tarballPath, 'package/package.json']");
    expect(envelope).not.toContain('package/scripts/verify-release-artifacts.mjs');
    expect(envelope).not.toContain('NPM_TOKEN');
    expect(envelope).not.toContain('NODE_AUTH_TOKEN');
    expect(npm).not.toContain('NODE_AUTH_TOKEN');
    expect(publish.indexOf('Verify release artifact envelope')).toBeLessThan(publish.indexOf('Publish npm package'));
    expect(publish.indexOf("execFileSync('tar', ['-xOf', tarballPath, 'package/package.json']")).toBeLessThan(
      publish.indexOf('Publish npm package')
    );
  });

  it('publishes the GitHub Release before the best-effort npm attempt and attaches staged artifacts', () => {
    const publish = job('publish');
    const npmPublish = publish.indexOf('npm publish ./release/release.tgz --provenance --access public');
    const githubRelease = publish.indexOf('softprops/action-gh-release');
    expect(npmPublish).toBeGreaterThanOrEqual(0);
    expect(githubRelease).toBeGreaterThanOrEqual(0);
    expect(githubRelease).toBeLessThan(npmPublish);
    expect(publish).toContain('Published npm integrity differs from staged tarball');
    expect(publish).toContain('id: npm-publish');
    expect(publish).toContain('continue-on-error: true');
    expect(publish).toContain('published: ${{ steps.npm-publish.outputs.published }}');
    expect(publish).toContain("if: steps.npm-publish.outputs.published == 'true'");
    expect(publish).toContain("if: steps.npm-publish.outputs.published != 'true'");
    expect(publish).toContain('rerun this release after trusted publishing is restored');
    expect(publish).toContain('release/release.tgz');
    expect(publish).toContain('release/release-manifest.json');
    expect(releaseWorkflow).toContain('group: release-${{ github.repository }}');
    expect(releaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('compares the rolling alias with check-release-alias before push', () => {
    const alias = namedStep('Advance rolling major alias without regression');
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

  it('uses a repository-scoped App token to advance the rolling alias', () => {
    const aliasJob = job('advance-major-alias');
    const mintStep = namedStep('Mint rolling alias App token');

    expect(aliasJob).toMatch(/permissions:\n\s+contents: read/);
    expect(mintStep).toContain(
      'uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'
    );
    expect(mintStep).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(mintStep).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(mintStep).toContain('owner: postman-cs');
    expect(mintStep).toContain('repositories: postman-api-onboarding-action');
    expect(mintStep).toContain('permission-contents: write');
    expect(mintStep).toContain('permission-workflows: write');
    expect(aliasJob).toContain('token: ${{ steps.alias-token.outputs.token }}');
    expect(aliasJob).not.toContain('token: ${{ github.token }}');
  });

  it('requires exact closed immutable-provider composite evidence before the rolling alias', () => {
    const verifier = job('verify-release-e2e');
    expect(verifier).not.toContain('continue-on-error');
    expect(verifier).toContain('E2E_GATE_MODE: enforce');
    expect(verifier).toContain('E2E_GATE_ACTION: postman-api-onboarding-action');
    expect(verifier).toContain('E2E_GATE_SUITE: full');
    expect(verifier).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(verifier).toContain('E2E_GATE_RELEASE_COMMIT: ${{ github.sha }}');
    expect(verifier).toContain('E2E_GATE_SOURCE_DIGEST: ${{ needs.verify-package.outputs.release_tgz_sha256 }}');
    expect(verifier).toContain('E2E_GATE_PROVIDER_TAG: e2e-provider-v1.2.0');
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_COMMIT: 53c5d10093b7dafb165d3caafbe3f1d70dec687d'
    );
    expect(verifier).toContain(
      'E2E_GATE_PROVIDER_SOURCE_DIGEST: 8c7ee211fccd2869f3901fcbc5ed154d6dea8e3d0d7d2e5312f6c0b57b4f6b78'
    );
    expect(verifier).toContain(
      'E2E_GATE_PEER_TAGS: \'{"postman-cs/postman-bootstrap-action":"v2.22.0","postman-cs/postman-insights-onboarding-action":"v2.5.2","postman-cs/postman-repo-sync-action":"v2.11.1","postman-cs/postman-resolve-service-token-action":"v2.2.4","postman-cs/postman-smoke-flow-action":"v3.7.5"}\''
    );
    expect(verifier).not.toContain('E2E_GATE_WORKFLOW_REF: main');
    expect(verifier).not.toContain('E2E_GATE_REGISTRY_REVISION');
    expect(verifier).not.toContain('E2E_GATE_CONTRACT_SCENARIOS');
    expect(verifier).toContain(
      'manifest_sha256: ${{ steps.verifier.outputs.e2e_manifest_sha256 }}'
    );
    expect(verifier).toContain(
      'provider_commit: ${{ steps.verifier.outputs.e2e_provider_commit }}'
    );
    expect(verifier).toContain('provider_tag: ${{ steps.verifier.outputs.e2e_provider_tag }}');
    expect(verifier).toContain('node scripts/verify-e2e-release.mjs');
    expect(job('verify-package')).toContain(
      'release_tgz_sha256: ${{ steps.package-artifact.outputs.release_tgz_sha256 }}'
    );
    expect(job('advance-major-alias')).toContain("needs.verify-release-e2e.result == 'success'");
    expect(job('advance-major-alias')).toContain("needs.verify-release-e2e.outputs.outcome == 'success'");
    const alias = job('advance-major-alias');
    expect(alias).toContain(
      'VERIFIED_E2E_MANIFEST_SHA256: ${{ needs.verify-release-e2e.outputs.manifest_sha256 }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_COMMIT: ${{ needs.verify-release-e2e.outputs.provider_commit }}'
    );
    expect(alias).toContain(
      'VERIFIED_E2E_PROVIDER_TAG: ${{ needs.verify-release-e2e.outputs.provider_tag }}'
    );
    expect(alias).toContain('[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]');
    expect(alias).toContain("[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]");
    expect(alias).toContain(
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]"
    );
    expect(alias).toContain(
      'git ls-remote --exit-code --tags origin "$RELEASE_TAG_REF" "${RELEASE_TAG_REF}^{}"'
    );
    expect(alias).toContain('[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]');
    for (const validation of [
      '[[ "$VERIFIED_E2E_MANIFEST_SHA256" =~ ^[0-9a-f]{64}$ ]]',
      "[ \"$VERIFIED_E2E_PROVIDER_TAG\" = 'e2e-provider-v1.2.0' ]",
      "[ \"$VERIFIED_E2E_PROVIDER_COMMIT\" = '53c5d10093b7dafb165d3caafbe3f1d70dec687d' ]",
      '[ "$REMOTE_RELEASE_COMMIT" = "$GITHUB_SHA" ]'
    ]) {
      expect(alias.indexOf(validation)).toBeLessThan(alias.indexOf('git tag -fa "$MAJOR"'));
      expect(alias.indexOf(validation)).toBeLessThan(
        alias.indexOf('git push origin "$MAJOR" --force')
      );
    }
    expect(releaseWorkflow).not.toContain('e2e_verification_mode');
    expect(releaseWorkflow).not.toContain('report-only');
  });

  it('keeps the closed-manifest peer census aligned with every immutable composite child pin', () => {
    const verifier = job('verify-release-e2e');
    const encodedPeers = verifier.match(/E2E_GATE_PEER_TAGS: '([^'\n]+)'/)?.[1];
    expect(encodedPeers).toBeTruthy();
    const peers = JSON.parse(encodedPeers ?? '{}') as Record<string, string>;
    expect(Object.keys(peers).sort()).toEqual([
      'postman-cs/postman-bootstrap-action',
      'postman-cs/postman-insights-onboarding-action',
      'postman-cs/postman-repo-sync-action',
      'postman-cs/postman-resolve-service-token-action',
      'postman-cs/postman-smoke-flow-action'
    ]);
    const childPins = Object.fromEntries(
      [...actionDefinition.matchAll(/uses:\s+(postman-cs\/postman-[a-z-]+-action)@(v\d+\.\d+\.\d+)/g)].map(
        (match) => [match[1], match[2]]
      )
    );
    expect(Object.keys(childPins).sort()).toEqual([
      'postman-cs/postman-bootstrap-action',
      'postman-cs/postman-insights-onboarding-action',
      'postman-cs/postman-repo-sync-action',
      'postman-cs/postman-smoke-flow-action'
    ]);
    for (const [repository, tag] of Object.entries(childPins)) {
      expect(peers[repository]).toBe(tag);
    }
  });

  it('mints a target-scoped App token for E2E dispatch instead of consuming a long-lived PAT secret', () => {
    // The mint step uses the SHA-pinned create-github-app-token with suite App secrets
    expect(releaseWorkflow).toContain(
      'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'
    );
    expect(releaseWorkflow).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(releaseWorkflow).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(releaseWorkflow).toContain('owner: postman-cs');
    expect(releaseWorkflow).toContain('repositories: postman-actions-e2e');

    const mintStep = namedStep('Mint composite release E2E dispatch App token');
    expect(mintStep).toBeTruthy();
    expect(mintStep).toContain(
      'uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1'
    );
    expect(mintStep).toContain('app-id: ${{ secrets.SUITE_PIN_BOT_APP_ID }}');
    expect(mintStep).toContain('private-key: ${{ secrets.SUITE_PIN_BOT_PRIVATE_KEY }}');
    expect(mintStep).toContain('owner: postman-cs');
    expect(mintStep).toContain('repositories: postman-actions-e2e');
    // The mint step must NOT have continue-on-error so a mint failure is surfaced
    expect(mintStep).not.toContain('continue-on-error');

    // The minted token feeds the verifier as E2E_DISPATCH_TOKEN, not a long-lived PAT
    const verifier = job('verify-release-e2e');
    expect(verifier).toContain(
      'E2E_DISPATCH_TOKEN: ${{ steps.e2e-dispatch-token.outputs.token }}'
    );
    expect(releaseWorkflow).not.toContain('secrets.E2E_DISPATCH_TOKEN');

    // Mint step immediately precedes the verifier in source order
    const mintIdx = releaseWorkflow.indexOf('Mint composite release E2E dispatch App token');
    const verifierIdx = releaseWorkflow.indexOf('Require real released-composite E2E');
    expect(mintIdx).toBeGreaterThan(-1);
    expect(verifierIdx).toBeGreaterThan(-1);
    expect(mintIdx).toBeLessThan(verifierIdx);

    // Verifier remains fail-closed: exact capability/correlation enforcement unchanged
    expect(verifier).not.toContain('continue-on-error');
    expect(verifier).toContain('E2E_GATE_MODE: enforce');
    expect(verifier).toContain('E2E_GATE_ACTION: postman-api-onboarding-action');
    expect(verifier).toContain('E2E_GATE_SUITE: full');
    expect(verifier).toContain('E2E_GATE_REF: ${{ github.ref_name }}');
    expect(verifier).toContain('E2E_GATE_SOURCE_DIGEST: ${{ needs.verify-package.outputs.release_tgz_sha256 }}');
    expect(verifier).toContain('node scripts/verify-e2e-release.mjs');
  });

  it('documents publication independence and correlated alias verification in the current v3 release policy', () => {
    expect(releasePolicy).toContain('nightly `full` monitor');
    expect(releasePolicy).toContain('not a PR or immutable-publication gate');
    expect(releasePolicy).toContain('canonical closed manifest');
    expect(releasePolicy).toContain('all six suite repositories');
    expect(releasePolicy).toContain('terminal result artifact');
    expect(releasePolicy).toContain("release workflow's `GITHUB_SHA`");
    expect(releasePolicy).toContain('v3');
    expect(releasePolicy).toContain('rolling');
    expect(releasePolicy).not.toMatch(/\bv1\b/);
  });
});

interface AliasShellResult {
  status: number;
  output: string;
  mutations: string[];
}

function executeAliasShell(overrides: Record<string, string> = {}): AliasShellResult {
  const tmpDir = mkdtempSync(join(tmpdir(), 'composite-release-alias-'));
  const scriptPath = join(tmpDir, 'alias.sh');
  const mutationPrefix = '__ALIAS_GIT_MUTATION__:';
  const gitShim = `git() {
case "\${1:-}" in
  ls-remote)
    if [ "\${2:-}" = '--exit-code' ] && [ "$#" -eq 6 ]; then
      printf '%s\\trefs/tags/%s\\n' "$GIT_STUB_RELEASE_TAG_OBJECT" "$GITHUB_REF_NAME"
      printf '%s\\trefs/tags/%s^{}\\n' "$GIT_STUB_RELEASE_COMMIT" "$GITHUB_REF_NAME"
    elif [ "\${2:-}" = '--tags' ] && [ "$#" -eq 6 ]; then
      return 0
    else
      printf 'unexpected git ls-remote call: %s\\n' "$*" >&2
      return 90
    fi
    ;;
  config) ;;
  tag|push) printf '${mutationPrefix}%s\\n' "$*" ;;
  *) printf 'unexpected git call: %s\\n' "$*" >&2; return 90 ;;
esac
}
`;
  // Git Bash prepends its own /mingw64/bin/git ahead of Windows PATH entries,
  // so only a shell function deterministically intercepts every git call.
  writeFileSync(
    scriptPath,
    `${gitShim}\n${namedStepRunBody('Advance rolling major alias without regression')}`
  );
  try {
    const result = spawnSync(bashExecutable(), [bashPath(scriptPath)], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: classifierEnv({
        BASH_ENV: '',
        ENV: '',
        GITHUB_REF_NAME: 'v9.9.9',
        GITHUB_SHA: 'a'.repeat(40),
        GIT_STUB_RELEASE_COMMIT: 'a'.repeat(40),
        GIT_STUB_RELEASE_TAG_OBJECT: '1'.repeat(40),
        VERIFIED_E2E_MANIFEST_SHA256: 'c'.repeat(64),
        VERIFIED_E2E_PROVIDER_COMMIT: '53c5d10093b7dafb165d3caafbe3f1d70dec687d',
        VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v1.2.0',
        ...overrides
      })
    });
    const mutations = (result.stdout ?? '')
      .split('\n')
      .filter((line) => line.startsWith(mutationPrefix))
      .map((line) => line.slice(mutationPrefix.length).trim());
    return {
      status: result.status ?? -1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      mutations
    };
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe('release alias evidence shell', () => {
  it('mutates the alias only after exact manifest, provider, and release-tag checks pass', () => {
    const result = executeAliasShell();
    expect(result.status).toBe(0);
    expect(result.mutations).toHaveLength(2);
    expect(result.mutations[0]).toMatch(/^tag -fa v\d+ /);
    expect(result.mutations[1]).toMatch(/^push origin v\d+ --force$/);
  });

  it.each([
    ['missing manifest', { VERIFIED_E2E_MANIFEST_SHA256: '' }, 'manifest digest'],
    ['non-lowercase manifest', { VERIFIED_E2E_MANIFEST_SHA256: 'C'.repeat(64) }, 'manifest digest'],
    ['provider tag mismatch', { VERIFIED_E2E_PROVIDER_TAG: 'e2e-provider-v9.9.9' }, 'provider tag mismatch'],
    ['provider commit mismatch', { VERIFIED_E2E_PROVIDER_COMMIT: 'f'.repeat(40) }, 'provider commit mismatch'],
    ['moved release tag', { GIT_STUB_RELEASE_COMMIT: 'e'.repeat(40) }, 'immutable release tag moved']
  ])('fails closed on %s before any alias mutation', (_name, overrides, message) => {
    const result = executeAliasShell(overrides);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(message);
    expect(result.mutations).toEqual([]);
  });
});
