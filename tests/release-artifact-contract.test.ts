import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import {
  assertNpmSriMatch,
  computeNpmSri,
  sha256,
  validateTagVersion,
  verifyReleaseArtifacts
} from '../scripts/verify-release-artifacts.mjs';

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
  if (!executable) throw new Error('Git Bash is required to execute release envelope scripts on Windows');
  return executable;
}

function npmCliPath(npmExecPath: string | undefined): string {
  if (!npmExecPath) throw new Error('npm_execpath is required to create release fixtures');
  return npmExecPath;
}

type WorkflowStep = {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

const releaseWorkflowText = readFileSync(join(process.cwd(), '.github/workflows/release.yml'), 'utf8');
const releaseWorkflow = parse(releaseWorkflowText) as {
  jobs: Record<string, WorkflowJob>;
};

const cleanupRoots: string[] = [];
const packedByVersion = new Map<string, string>();
let npmPackCount = 0;

const TRAP_VERIFIER = `import { writeFileSync } from 'node:fs';
if (process.env.OIDC_MARKER) {
  writeFileSync(process.env.OIDC_MARKER, 'package-code-executed');
}
`;

function track(directory: string): string {
  cleanupRoots.push(directory);
  return directory;
}

function ensurePacked(packageVersion: string): string {
  const cached = packedByVersion.get(packageVersion);
  if (cached) return cached;
  const root = track(mkdtempSync(join(tmpdir(), `release-pack-${packageVersion}-`)));
  const source = join(root, 'src');
  mkdirSync(join(source, 'scripts'), { recursive: true });
  writeFileSync(
    join(source, 'package.json'),
    `${JSON.stringify({
      name: '@postman-cse/onboarding-api',
      version: packageVersion,
      files: ['scripts/verify-release-artifacts.mjs']
    }, null, 2)}\n`
  );
  writeFileSync(join(source, 'scripts/verify-release-artifacts.mjs'), TRAP_VERIFIER);
  execFileSync(process.execPath, [npmCliPath(process.env.npm_execpath), 'pack', '--pack-destination', root], {
    cwd: source,
    stdio: 'ignore'
  });
  npmPackCount += 1;
  const packed = readdirSync(root).find((name) => name.endsWith('.tgz'));
  if (!packed) throw new Error(`npm pack did not produce a tarball for ${packageVersion}`);
  const releaseTarball = join(root, 'release.tgz');
  renameSync(join(root, packed), releaseTarball);
  packedByVersion.set(packageVersion, releaseTarball);
  return releaseTarball;
}

function caseFixture(options?: { packageVersion?: string; tag?: string }): string {
  const packageVersion = options?.packageVersion ?? '2.1.2';
  const tag = options?.tag ?? `v${packageVersion}`;
  const directory = track(mkdtempSync(join(tmpdir(), 'release-artifact-case-')));
  const releaseTarball = join(directory, 'release.tgz');
  cpSync(ensurePacked(packageVersion), releaseTarball);
  writeFileSync(
    join(directory, 'release-manifest.json'),
    JSON.stringify({
      schema_version: 1,
      repository: 'postman-cs/postman-api-onboarding-action',
      commit_sha: 'a'.repeat(40),
      tag,
      package_name: '@postman-cse/onboarding-api',
      package_version: packageVersion,
      artifacts: [{ path: 'release.tgz', sha256: sha256(releaseTarball) }]
    })
  );
  return directory;
}

function expected(tag = 'v2.1.2') {
  return {
    repository: 'postman-cs/postman-api-onboarding-action',
    commitSha: 'a'.repeat(40),
    tag
  };
}

function stepByName(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((entry) => entry.name === name);
  if (!step) throw new Error(`missing step ${name}`);
  return step;
}

beforeAll(() => {
  ensurePacked('2.1.2');
  ensurePacked('2.2.0');
  expect(npmPackCount).toBe(2);
});

afterAll(() => {
  for (const directory of cleanupRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('release workflow artifact handoff', () => {
  it('executes npm through its JavaScript CLI without a platform shell shim', () => {
    expect(npmCliPath('/npm/bin/npm-cli.js')).toBe('/npm/bin/npm-cli.js');
    expect(() => npmCliPath(undefined)).toThrow(/npm_execpath/);
  });

  it('parses verify-package and publish permissions, allowlist, and artifact handoff', () => {
    const verify = releaseWorkflow.jobs['verify-package'];
    const publish = releaseWorkflow.jobs.publish;
    expect(verify?.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(verify)).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);

    const upload = verify?.steps?.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.name).toBe('release-artifacts-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    const uploadPaths = String(upload?.with?.path ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    expect(uploadPaths).toEqual(['release.tgz', 'release-manifest.json']);

    expect(publish?.permissions).toEqual({ contents: 'write', 'id-token': 'write' });
    const setupNode = publish?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with).toBeTruthy();
    expect(setupNode?.with).not.toHaveProperty('cache');
    const download = publish?.steps?.find((step) => step.uses?.startsWith('actions/download-artifact@'));
    expect(download?.with?.name).toBe(upload?.with?.name);
    expect(JSON.stringify(publish)).not.toContain('actions/checkout');
    expect(JSON.stringify(publish)).not.toContain('npm ci');
    expect(JSON.stringify(publish)).not.toContain('npm run build');
    expect(JSON.stringify(publish)).not.toContain('"npm test"');
    expect(JSON.stringify(publish)).not.toMatch(/npm pack(?:\\s|$|")/);
    expect(JSON.stringify(publish)).not.toContain('package/scripts/verify-release-artifacts.mjs');
    const tokenSteps = (publish?.steps ?? []).filter((step) => JSON.stringify(step).includes('NODE_AUTH_TOKEN'));
    expect(tokenSteps).toHaveLength(1);
    expect(tokenSteps[0]?.name).toBe('Publish or verify npm package');
    expect(tokenSteps[0]?.env?.NODE_AUTH_TOKEN).toBe('${{ secrets.NPM_TOKEN }}');
  });

  it('executes the trusted inline verifier on a real tarball without running package code under OIDC env', () => {
    const publish = releaseWorkflow.jobs.publish;
    const envelope = stepByName(publish, 'Verify release artifact envelope');
    expect(envelope.run).toBeTruthy();
    expect(envelope.run).toContain("execFileSync('tar', ['-xOf', tarballPath, 'package/package.json']");
    expect(envelope.run).not.toContain('package/scripts/verify-release-artifacts.mjs');
    expect(envelope.run).not.toContain('NODE_AUTH_TOKEN');

    const directory = track(mkdtempSync(join(tmpdir(), 'release-envelope-')));
    mkdirSync(join(directory, 'release'), { recursive: true });
    const tarballPath = join(directory, 'release', 'release.tgz');
    cpSync(ensurePacked('2.1.2'), tarballPath);
    const trapMember = execFileSync('tar', ['-xOf', tarballPath, 'package/scripts/verify-release-artifacts.mjs'], {
      encoding: 'utf8'
    });
    expect(trapMember).toContain('OIDC_MARKER');
    writeFileSync(
      join(directory, 'release', 'release-manifest.json'),
      JSON.stringify({
        schema_version: 1,
        repository: 'postman-cs/postman-api-onboarding-action',
        commit_sha: 'a'.repeat(40),
        tag: 'v2.1.2',
        package_name: '@postman-cse/onboarding-api',
        package_version: '2.1.2',
        artifacts: [{ path: 'release.tgz', sha256: sha256(tarballPath) }]
      })
    );
    const marker = join(directory, 'oidc-marker');
    const scriptPath = join(directory, 'envelope.sh');
    writeFileSync(scriptPath, String(envelope.run));
    const env = {
      ...process.env,
      GITHUB_REPOSITORY: 'postman-cs/postman-api-onboarding-action',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_REF_NAME: 'v2.1.2',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://example.invalid/oidc',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc-token',
      OIDC_MARKER: marker
    };
    const ok = spawnSync(bashExecutable(), [bashPath(scriptPath)], { cwd: directory, encoding: 'utf8', env });
    expect(ok.status, ok.stderr || ok.stdout).toBe(0);
    expect(existsSync(marker)).toBe(false);

    writeFileSync(tarballPath, Buffer.from(`tampered-${createHash('sha256').update('x').digest('hex')}`));
    const bad = spawnSync(bashExecutable(), [bashPath(scriptPath)], { cwd: directory, encoding: 'utf8', env });
    expect(bad.status).not.toBe(0);
    expect(`${bad.stdout}${bad.stderr}`).toMatch(/checksum mismatch|does not match/i);
    expect(existsSync(marker)).toBe(false);
  });
});

describe('release artifact verifier', () => {
  it('accepts a manifest bound to the expected package and release identity', () => {
    const directory = caseFixture();
    expect(() => verifyReleaseArtifacts(directory, expected())).not.toThrow();
  });

  it.each([
    ['repository', { repository: 'wrong/repo', commitSha: 'a'.repeat(40), tag: 'v2.1.2' }],
    ['commitSha', { repository: 'postman-cs/postman-api-onboarding-action', commitSha: 'b'.repeat(40), tag: 'v2.1.2' }],
    ['tag', { repository: 'postman-cs/postman-api-onboarding-action', commitSha: 'a'.repeat(40), tag: 'v2.1.1' }]
  ] as const)('rejects a mismatched %s', (_label, next) => {
    const directory = caseFixture();
    expect(() => verifyReleaseArtifacts(directory, next)).toThrow();
  });

  it('rejects a mismatched package name', () => {
    const directory = caseFixture();
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.package_name = '@postman-cse/wrong';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/package name/);
  });

  it('rejects a mismatched package version', () => {
    const directory = caseFixture();
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.package_version = '9.9.9';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/package version/);
  });

  it('rejects a checksum mismatch', () => {
    const directory = caseFixture();
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.artifacts[0].sha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/checksum/);
  });

  it('rejects malformed and uppercase checksums', () => {
    const directory = caseFixture();
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const digest = manifest.artifacts[0].sha256 as string;
    manifest.artifacts[0].sha256 = digest.toUpperCase();
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/artifact is invalid/);
    manifest.artifacts[0].sha256 = 'not-a-digest';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/artifact is invalid/);
  });

  it('rejects missing and extra manifest artifacts', () => {
    const directory = caseFixture();
    const manifestPath = join(directory, 'release-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const digest = manifest.artifacts[0].sha256 as string;
    manifest.artifacts = [];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/allowlist/);
    manifest.artifacts = [
      { path: 'release.tgz', sha256: digest },
      { path: 'extra.tgz', sha256: digest }
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyReleaseArtifacts(directory, expected())).toThrow(/allowlist/);
  });

  it('accepts a zero-patch minor tag and rejects non-zero-patch minor tags', () => {
    expect(() => validateTagVersion('v2.2', '2.2.0')).not.toThrow();
    expect(() => validateTagVersion('v2.1', '2.1.2')).toThrow(/does not match/);
    const directory = caseFixture({ packageVersion: '2.2.0', tag: 'v2.2' });
    expect(() => verifyReleaseArtifacts(directory, expected('v2.2'))).not.toThrow();
  });

  it('rejects an npm SRI identity mismatch', () => {
    const directory = caseFixture();
    const actual = computeNpmSri(join(directory, 'release.tgz'));
    expect(() => assertNpmSriMatch(actual, actual)).not.toThrow();
    expect(() => assertNpmSriMatch(actual, 'sha512-wrong')).toThrow(/integrity differs/);
  });

  it('packs each required version at most once', () => {
    expect(npmPackCount).toBeLessThanOrEqual(2);
    expect(packedByVersion.has('2.1.2')).toBe(true);
    expect(packedByVersion.has('2.2.0')).toBe(true);
  });
});
