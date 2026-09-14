import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

type Step = {
  id?: string;
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  'working-directory'?: string;
};

type Job = {
  needs?: string | string[];
  if?: string;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  strategy?: { 'max-parallel'?: number; matrix?: Record<string, string> };
  outputs?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  on: Record<string, unknown>;
  jobs: Record<string, Job>;
};

const repoRoot = path.resolve(__dirname, '..');
const examplePath = path.join(repoRoot, 'examples', 'monorepo-dispatcher.yml');
const exampleText = readFileSync(examplePath, 'utf8');
const workflow = parse(exampleText) as Workflow;
const detectJob = workflow.jobs.detect;
const detector = detectJob?.steps.find((step) => step.id === 'changes')?.run ?? '';
const resourceResolver =
  workflow.jobs.run?.steps.find(
    (step) => step.name === 'Resolve service Postman resource IDs',
  )?.run ?? '';
const resourceResolverRubyMatch = resourceResolver.match(
  /^ruby <<'RUBY'\r?\n([\s\S]*?)\r?\nRUBY\s*$/,
);
if (!resourceResolverRubyMatch) {
  throw new Error('Expected the resource resolver to contain one quoted Ruby heredoc');
}
const resourceResolverRuby = resourceResolverRubyMatch[1];
const temporaryRoots: string[] = [];

// Resolve the real git binary instead of trusting PATH: disposable fixtures
// must never execute operator shell shims. Mirrors the Windows Git Bash
// resolution used in contract.test.ts.
function gitBinary(): string {
  if (process.platform === 'win32') {
    const candidates = [
      process.env.GIT_INSTALL_ROOT && path.join(process.env.GIT_INSTALL_ROOT, 'bin', 'git.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Git', 'bin', 'git.exe'),
      'C:\\Program Files\\Git\\bin\\git.exe'
    ].filter((candidate): candidate is string => Boolean(candidate));
    const executable = candidates.find((candidate) => existsSync(candidate));
    if (!executable) throw new Error('Git is required for monorepo dispatcher fixture repos');
    return executable;
  }
  const posix = ['/usr/bin/git', '/usr/local/bin/git'].find((candidate) => existsSync(candidate));
  if (!posix) throw new Error('Git is required for monorepo dispatcher fixture repos');
  return posix;
}

const GIT_BIN = gitBinary();
const GIT_DIR_PATH = path.dirname(GIT_BIN);

// Hermetic git environment: ignore the host machine's global and system git
// config (hooks, signing, aliases), shell startup files that could redefine
// tools (BASH_ENV/ENV), and stray GIT_* overrides that would redirect fixture
// operations. Explicit per-call overrides still win. Still shells out to the
// real git binary.
const hermeticGitEnv: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: devNull,
  BASH_ENV: undefined,
  ENV: undefined,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_PREFIX: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: undefined,
  GIT_AUTHOR_EMAIL: undefined,
  GIT_COMMITTER_NAME: undefined,
  GIT_COMMITTER_EMAIL: undefined
};

function git(root: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(GIT_BIN, args, {
    cwd: root,
    env: { ...hermeticGitEnv, ...env },
    encoding: 'utf8',
  }).trim();
}

function createFixture(): { root: string; initial: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'monorepo-dispatcher-'));
  temporaryRoots.push(root);
  git(root, ['init', '--template=', '-b', 'main']);
  git(root, ['config', 'user.name', 'Fixture User']);
  git(root, ['config', 'user.email', 'fixture@example.com']);
  for (const service of ['orders', 'payments']) {
    mkdirSync(path.join(root, 'services', service, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'services', service, 'postman'), { recursive: true });
    mkdirSync(path.join(root, 'services', service, '.postman'), { recursive: true });
    writeFileSync(path.join(root, 'services', service, 'src', 'index.ts'), `export const name = '${service}';\n`);
    writeFileSync(path.join(root, 'services', service, 'openapi.yaml'), `openapi: 3.0.0\ninfo:\n  title: ${service}\n  version: 1.0.0\npaths: {}\n`);
    writeFileSync(path.join(root, 'services', service, 'postman', 'collection.yaml'), '$kind: collection\n');
    writeFileSync(path.join(root, 'services', service, '.postman', 'resources.yaml'), 'canonical: {}\n');
  }
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'test: seed services']);
  return { root, initial: git(root, ['rev-parse', 'HEAD']) };
}

function commit(root: string, message: string, committer?: { name: string; email: string }): string {
  git(root, ['add', '-A']);
  const env = committer
    ? {
        GIT_AUTHOR_NAME: committer.name,
        GIT_AUTHOR_EMAIL: committer.email,
        GIT_COMMITTER_NAME: committer.name,
        GIT_COMMITTER_EMAIL: committer.email,
      }
    : {};
  git(root, ['commit', '-m', message], env);
  return git(root, ['rev-parse', 'HEAD']);
}

function runDetector(
  root: string,
  environment: Partial<Record<'EVENT_NAME' | 'BEFORE_SHA' | 'HEAD_SHA' | 'BASE_REF' | 'DEFAULT_BRANCH', string>>,
): Record<string, string[]> {
  const outputPath = path.join(root, 'github-output.txt');
  const result = spawnSync('bash', ['--noprofile', '--norc', '-c', detector], {
    cwd: root,
    env: {
      ...hermeticGitEnv,
      // Put the real git first so the detector's git calls resolve to the
      // same binary as the fixture helper, not a PATH shim.
      PATH: `${GIT_DIR_PATH}${path.delimiter}${process.env.PATH ?? ''}`,
      EVENT_NAME: environment.EVENT_NAME ?? 'push',
      BEFORE_SHA: environment.BEFORE_SHA ?? '',
      HEAD_SHA: environment.HEAD_SHA ?? git(root, ['rev-parse', 'HEAD']),
      BASE_REF: environment.BASE_REF ?? '',
      DEFAULT_BRANCH: environment.DEFAULT_BRANCH ?? 'main',
      SYNC_COMMITTER_NAME: 'Postman',
      SYNC_COMMITTER_EMAIL: 'support@postman.com',
      GITHUB_OUTPUT: outputPath,
      RUNNER_TEMP: root,
    },
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  const outputs: Record<string, string[]> = {};
  for (const line of readFileSync(outputPath, 'utf8').trim().split('\n')) {
    const separator = line.indexOf('=');
    outputs[line.slice(0, separator)] = JSON.parse(line.slice(separator + 1)) as string[];
  }
  return outputs;
}

function runResourceResolver(resourcesYaml: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'monorepo-resource-resolver-'));
  temporaryRoots.push(root);
  mkdirSync(path.join(root, '.postman'), { recursive: true });
  writeFileSync(path.join(root, '.postman', 'resources.yaml'), resourcesYaml);
  const githubEnv = path.join(root, 'github-env.txt');
  writeFileSync(githubEnv, 'EXISTING=preserved\n');
  // Exercise the exact Ruby payload without an unnecessary Git Bash process.
  // Starting both shells for every table case is particularly expensive on
  // Windows and can obscure a resolver regression with harness startup delay.
  const result = spawnSync('ruby', ['-e', resourceResolverRuby], {
    cwd: root,
    env: { ...process.env, GITHUB_ENV: githubEnv },
    encoding: 'utf8',
  });
  return { result, githubEnv: readFileSync(githubEnv, 'utf8') };
}

afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true });
});

describe('monorepo dispatcher example', () => {
  it('declares full-history detection and guards empty matrices', () => {
    expect(Object.keys(workflow.on)).toEqual(
      expect.arrayContaining(['pull_request', 'push', 'workflow_dispatch']),
    );
    const checkout = detectJob.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(detectJob.outputs).toEqual({
      'changed-code': '${{ steps.changes.outputs.changed-code }}',
      'changed-collections': '${{ steps.changes.outputs.changed-collections }}',
    });
    expect(workflow.jobs.onboard.if).toContain("changed-code != '[]'");
    expect(workflow.jobs.run.if).toContain("changed-collections != '[]'");
  });

  it('serializes mutating onboarding while leaving collection runs parallel', () => {
    const onboard = workflow.jobs.onboard;
    const run = workflow.jobs.run;
    expect(onboard.strategy?.['max-parallel']).toBe(1);
    expect(onboard.concurrency).toEqual({
      group: 'postman-sync-${{ github.ref }}',
      'cancel-in-progress': false,
    });
    expect(run.strategy?.['max-parallel']).toBeUndefined();
    const action = onboard.steps.find((step) => step.uses?.includes('postman-api-onboarding-action'));
    expect(action?.uses).toBe('postman-cs/postman-api-onboarding-action@v3');
    expect(action?.with?.['working-directory']).toBe('services/${{ matrix.service }}');
    expect(action?.with?.['project-name']).toBe('${{ matrix.service }}');
    expect(action?.with?.['generate-ci-workflow']).toBe(false);
    expect(action?.with?.['postman-api-key']).toBe('${{ secrets.POSTMAN_API_KEY }}');
    expect(action?.with?.['postman-access-token']).toBeUndefined();
  });

  it('matches the loop backstop to the composite committer defaults', () => {
    const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8')) as {
      inputs: Record<string, { default?: string }>;
    };
    const changes = detectJob.steps.find((step) => step.id === 'changes');
    expect(changes?.env?.SYNC_COMMITTER_NAME).toBe(manifest.inputs['committer-name']?.default);
    expect(changes?.env?.SYNC_COMMITTER_EMAIL).toBe(manifest.inputs['committer-email']?.default);
    expect(detector).toContain('postman/*');
    expect(detector).toContain('.postman/*');
  });

  it('runs both tracked collections through the Postman CLI from service-local resources', () => {
    const run = workflow.jobs.run;
    const combined = run.steps.map((step) => step.run ?? '').join('\n');
    expect(combined).toContain("YAML.safe_load(File.read('.postman/resources.yaml'), aliases: false)");
    expect(combined).toContain('Postman resource IDs must be 1-256 safe ASCII identifier characters');
    expect(combined).toContain('postman login --with-api-key "$POSTMAN_API_KEY"');
    expect(combined).toContain('postman collection run "$uid"');
    expect(combined).toContain('run_collection Smoke "$POSTMAN_SMOKE_COLLECTION_UID"');
    expect(combined).toContain('run_collection Contract "$POSTMAN_CONTRACT_COLLECTION_UID"');
    expect(combined).toContain('::group::');
    expect(combined).toContain('::endgroup::');
    expect(combined).not.toContain('::group::${{ matrix.service }}');
    const collectionStep = run.steps.find((step) => step.name === 'Run service collections');
    expect(collectionStep?.env?.SERVICE_NAME).toBe('${{ matrix.service }}');
    expect(collectionStep?.run).toContain('::group::$SERVICE_NAME');
  });

  it('rejects service directory names that are unsafe to propagate through the matrix', () => {
    const { root, initial } = createFixture();
    const unsafeService = '$(touch pwned)';
    mkdirSync(path.join(root, 'services', unsafeService), { recursive: true });
    writeFileSync(path.join(root, 'services', unsafeService, 'openapi.yaml'), 'openapi: 3.1.0\n');
    const head = commit(root, 'test: add unsafe service name');
    const outputPath = path.join(root, 'github-output.txt');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', detector], {
      cwd: root,
      env: {
        ...hermeticGitEnv,
        // Same real-git-first PATH as runDetector: these cases must exercise
        // the validator, not an operator PATH shim.
        PATH: `${GIT_DIR_PATH}${path.delimiter}${process.env.PATH ?? ''}`,
        EVENT_NAME: 'push',
        BEFORE_SHA: initial,
        HEAD_SHA: head,
        BASE_REF: '',
        DEFAULT_BRANCH: 'main',
        SYNC_COMMITTER_NAME: 'Postman',
        SYNC_COMMITTER_EMAIL: 'support@postman.com',
        GITHUB_OUTPUT: outputPath,
        RUNNER_TEMP: root,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Unsupported service directory name');
    expect(existsSync(path.join(root, 'pwned'))).toBe(false);
  });

  it('routes workflow_dispatch service names through the same rejecting validator', () => {
    const { root } = createFixture();
    const unsafeService = '$(touch pwned)';
    mkdirSync(path.join(root, 'services', unsafeService), { recursive: true });
    const outputPath = path.join(root, 'github-output.txt');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', detector], {
      cwd: root,
      env: {
        ...hermeticGitEnv,
        // Same real-git-first PATH as runDetector: these cases must exercise
        // the validator, not an operator PATH shim.
        PATH: `${GIT_DIR_PATH}${path.delimiter}${process.env.PATH ?? ''}`,
        EVENT_NAME: 'workflow_dispatch',
        BEFORE_SHA: '',
        HEAD_SHA: git(root, ['rev-parse', 'HEAD']),
        BASE_REF: '',
        DEFAULT_BRANCH: 'main',
        SYNC_COMMITTER_NAME: 'Postman',
        SYNC_COMMITTER_EMAIL: 'support@postman.com',
        GITHUB_OUTPUT: outputPath,
        RUNNER_TEMP: root,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Unsupported service directory name');
    expect(existsSync(path.join(root, 'pwned'))).toBe(false);
  });

  it('rejects an oversized otherwise-safe service directory name', () => {
    const { root } = createFixture();
    const oversizedService = 'a'.repeat(101);
    mkdirSync(path.join(root, 'services', oversizedService), { recursive: true });
    const outputPath = path.join(root, 'github-output.txt');
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', detector], {
      cwd: root,
      env: {
        ...hermeticGitEnv,
        // Same real-git-first PATH as runDetector: these cases must exercise
        // the validator, not an operator PATH shim.
        PATH: `${GIT_DIR_PATH}${path.delimiter}${process.env.PATH ?? ''}`,
        EVENT_NAME: 'workflow_dispatch',
        BEFORE_SHA: '',
        HEAD_SHA: git(root, ['rev-parse', 'HEAD']),
        BASE_REF: '',
        DEFAULT_BRANCH: 'main',
        SYNC_COMMITTER_NAME: 'Postman',
        SYNC_COMMITTER_EMAIL: 'support@postman.com',
        GITHUB_OUTPUT: outputPath,
        RUNNER_TEMP: root,
      },
      encoding: 'utf8',
    });

    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('use 1-100');
  });

  it('dispatches every existing service deterministically', () => {
    const { root } = createFixture();
    expect(runDetector(root, { EVENT_NAME: 'workflow_dispatch' })).toEqual({
      'changed-code': ['orders', 'payments'],
      'changed-collections': ['orders', 'payments'],
    });
  });

  it.each([
    ['LF', '\n'],
    ['CR', '\r'],
    ['NUL', '\0'],
    ['workflow-command delimiter', '<<INJECTED'],
    ['space', ' '],
  ])('rejects an executable %s env-file injection before writing GITHUB_ENV', (_label, unsafeText) => {
    const resources = JSON.stringify({
      canonical: {
        collections: {
          '[Smoke] orders': `smoke${unsafeText}INJECTED=owned`,
          '[Contract] orders': 'contract',
        },
        environments: { prod: 'environment' },
      },
    });
    const { result, githubEnv } = runResourceResolver(resources);

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'Postman resource IDs must be 1-256 safe ASCII identifier characters',
    );
    expect(githubEnv).toBe('EXISTING=preserved\n');
    expect(githubEnv).not.toContain('INJECTED=owned');
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(257)],
    ['non-string', 42],
  ])('rejects an %s resource ID before writing GITHUB_ENV', (_label, unsafeId) => {
    const resources = JSON.stringify({
      canonical: {
        collections: {
          '[Smoke] orders': unsafeId,
          '[Contract] orders': '12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
        environments: { prod: '12345678-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' },
      },
    });
    const { result, githubEnv } = runResourceResolver(resources);

    expect(result.status).not.toBe(0);
    expect(githubEnv).toBe('EXISTING=preserved\n');
  });

  it('accepts owner-prefixed Postman UIDs and writes exactly three records', () => {
    const resources = JSON.stringify({
      canonical: {
        collections: {
          '[Smoke] orders': '12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          '[Contract] orders': '12345678-11111111-2222-3333-4444-555555555555',
        },
        environments: {
          'postman/environments/prod.postman_environment.json':
            '12345678-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
        },
      },
    });
    const { result, githubEnv } = runResourceResolver(resources);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(githubEnv.trim().split(/\r?\n/)).toEqual([
      'EXISTING=preserved',
      'POSTMAN_SMOKE_COLLECTION_UID=12345678-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      'POSTMAN_CONTRACT_COLLECTION_UID=12345678-11111111-2222-3333-4444-555555555555',
      'POSTMAN_ENVIRONMENT_UID=12345678-ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
    ]);
  });

  it('rejects an unsafe YAML object tag without mutating GITHUB_ENV', () => {
    const { result, githubEnv } = runResourceResolver(
      '--- !ruby/object:Object\ncanonical: {}\n',
    );

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toMatch(/DisallowedClass|unspecified class/);
    expect(githubEnv).toBe('EXISTING=preserved\n');
  });

  it('classifies code for onboarding and generated artifacts for run-only checks', () => {
    const { root, initial } = createFixture();
    writeFileSync(path.join(root, 'services', 'payments', 'src', 'index.ts'), 'export const changed = true;\n');
    writeFileSync(path.join(root, 'services', 'payments', 'postman', 'collection.yaml'), '$kind: changed\n');
    writeFileSync(path.join(root, 'services', 'orders', '.postman', 'resources.yaml'), 'canonical: {changed: true}\n');
    const head = commit(root, 'feat: change service and generated state');

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': ['payments'],
      'changed-collections': ['orders', 'payments'],
    });
  });

  it('uses the default-branch merge base for a new branch push', () => {
    const { root } = createFixture();
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(path.join(root, 'services', 'orders', 'src', 'index.ts'), 'export const branch = true;\n');
    const head = commit(root, 'feat: branch change');

    expect(
      runDetector(root, {
        BEFORE_SHA: '0000000000000000000000000000000000000000',
        HEAD_SHA: head,
        DEFAULT_BRANCH: 'main',
      }),
    ).toEqual({
      'changed-code': ['orders'],
      'changed-collections': ['orders'],
    });
  });

  it('uses the pull-request merge base', () => {
    const { root } = createFixture();
    git(root, ['checkout', '-b', 'feature']);
    writeFileSync(path.join(root, 'services', 'payments', 'openapi.yaml'), 'openapi: 3.1.0\n');
    const head = commit(root, 'feat: update pull request spec');

    expect(
      runDetector(root, { EVENT_NAME: 'pull_request', BASE_REF: 'main', HEAD_SHA: head }),
    ).toEqual({
      'changed-code': ['payments'],
      'changed-collections': ['payments'],
    });
  });

  it('suppresses onboarding for the generated committer but preserves collection checks', () => {
    const { root, initial } = createFixture();
    writeFileSync(path.join(root, 'services', 'payments', 'src', 'index.ts'), 'export const generated = true;\n');
    const head = commit(root, 'chore: generated sync', {
      name: 'Postman',
      email: 'support@postman.com',
    });

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': [],
      'changed-collections': ['payments'],
    });
  });

  it('omits deleted services instead of producing an invalid matrix', () => {
    const { root, initial } = createFixture();
    rmSync(path.join(root, 'services', 'orders'), { recursive: true, force: true });
    const head = commit(root, 'chore: remove orders service');

    expect(runDetector(root, { BEFORE_SHA: initial, HEAD_SHA: head })).toEqual({
      'changed-code': [],
      'changed-collections': [],
    });
  });
});
