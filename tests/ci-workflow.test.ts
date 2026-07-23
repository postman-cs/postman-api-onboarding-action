import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ACTIONLINT_DOWNLOADER_COMMIT = '393031adb9afb225ee52ae2ccd7a5af5525e03e8';
const ACTIONLINT_VERSION = '1.7.11';
const ACTIONLINT_DOWNLOADER_URL = `https://raw.githubusercontent.com/rhysd/actionlint/${ACTIONLINT_DOWNLOADER_COMMIT}/scripts/download-actionlint.bash`;
const WINDOWS_CACHE_PIN = 'actions/cache@1bd1e32a3bdc45362d1e726936510720a7c30a57';

const ciWorkflowText = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/g, '\n');
const ciWorkflow = parse(ciWorkflowText) as {
  concurrency?: { group?: string; 'cancel-in-progress'?: string | boolean };
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
  if?: string;
};

type WorkflowJob = {
  name?: string;
  'runs-on'?: string;
  needs?: string | string[];
  steps?: WorkflowStep[];
};

/** Extract one top-level job block: `  <id>:` through the next job header or EOF. */
function jobText(source: string, jobId: string): string {
  const jobsBody = source.match(/^jobs:\n([\s\S]*)$/m)?.[1] ?? '';
  const header = `  ${jobId}:\n`;
  const start = jobsBody.indexOf(header);
  if (start < 0) return '';
  const rest = jobsBody.slice(start + header.length);
  const nextJob = rest.search(/^ {2}[a-zA-Z0-9_-]+:\n/m);
  return header + (nextJob < 0 ? rest : rest.slice(0, nextJob));
}

function namedStep(source: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`      - name: ${escapedName}\\n[\\s\\S]*?(?=\\n      - |\\n?$)`));
  return match?.[0] ?? '';
}

/** Ordered gate names launched via `run <name> ...` (excludes the `run()` helper definition). */
function linuxQueuedGates(runGates: string): string[] {
  return [...runGates.matchAll(/^\s+run ([a-zA-Z0-9_-]+)\s+/gm)].map((m) => m[1]!);
}

function findStep(job: WorkflowJob | undefined, name: string): WorkflowStep | undefined {
  return job?.steps?.find((step) => step.name === name);
}

const linux = jobText(ciWorkflowText, 'gate');
const windows = jobText(ciWorkflowText, 'windows');
const linuxJob = ciWorkflow.jobs?.gate;
const windowsJob = ciWorkflow.jobs?.windows;

describe('CI workflow contract', () => {
  it('supersedes only older pull-request runs', () => {
    expect(ciWorkflow.concurrency?.group).toBe(
      'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    );
    expect(ciWorkflow.concurrency?.['cancel-in-progress']).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it('keeps Linux full-history checkout and the exact bounded Linux gate set', () => {
    const checkout = linuxJob?.steps?.find((step) => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
    expect(linux).toContain('fetch-depth: 0');

    const runGates = namedStep(linux, 'Run gates');
    expect(runGates).toContain('MAX_PARALLEL_GATES=2');
    expect(runGates).toContain('while [ "${#pid[@]}" -ge "$MAX_PARALLEL_GATES" ]; do finish_one; done');
    expect(runGates).toContain('while [ "${#pid[@]}" -gt 0 ]; do finish_one; done');
    expect(runGates).toContain('wait -n -p finished_pid');

    expect(linuxQueuedGates(runGates)).toEqual([
      'lint',
      'typecheck',
      'test',
      'sibling-pins',
      'actionlint',
      'commitlint',
    ]);
    expect(runGates).toContain('run lint          npm run lint');
    expect(runGates).toContain('run typecheck     npm run typecheck');
    expect(runGates).toContain('run test          npm test');
    expect(runGates).toContain('run sibling-pins  node scripts/check-sibling-pins.mjs');
    expect(runGates).toContain('run actionlint    "$ACTIONLINT_BIN"');
    expect(runGates).toContain('if [ "${{ github.event_name }}" = "pull_request" ]; then');
    expect(runGates).toContain('run commitlint npx commitlint \\');
    expect(runGates).toContain('--from "${{ github.event.pull_request.base.sha }}"');
    expect(runGates).toContain('--to "${{ github.event.pull_request.head.sha }}"');
    expect(runGates).toContain('gate:$n=pass');
    expect(runGates).toContain('gate:$n=fail');
    expect(runGates).toContain('exit $fail');
  });

  it('pins actionlint 1.7.11 via the immutable downloader commit into $RUNNER_TEMP without Go', () => {
    const install = namedStep(linux, 'Install actionlint');
    const installStep = findStep(linuxJob, 'Install actionlint');
    expect(installStep?.run).toContain(ACTIONLINT_DOWNLOADER_URL);
    expect(installStep?.run).toContain(`) ${ACTIONLINT_VERSION} "$RUNNER_TEMP"`);
    expect(install).toContain(
      `bash <(curl -sSfL ${ACTIONLINT_DOWNLOADER_URL}) ${ACTIONLINT_VERSION} "$RUNNER_TEMP"`,
    );
    expect(install).toContain('ACTIONLINT_BIN=$RUNNER_TEMP/actionlint');
    expect(install).not.toMatch(/\/main\/scripts\/download-actionlint\.bash/);
    expect(ciWorkflowText).not.toContain('actions/setup-go');
    expect(ciWorkflowText).not.toContain('go install github.com/rhysd/actionlint');
    expect(ciWorkflowText).not.toMatch(/\bgo install\b/);
  });

  it('keeps Windows as an independent exact-cache node --run test lane without queue or Linux-owned gates', () => {
    expect(windowsJob?.name).toBe('Windows gate');
    expect(windowsJob?.['runs-on']).toBe('windows-latest');
    expect(windowsJob?.needs).toBeUndefined();
    expect(linuxJob?.needs).toBeUndefined();
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*needs:/m);
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);

    const setupNode = windowsJob?.steps?.find((step) => step.uses?.startsWith('actions/setup-node@'));
    expect(setupNode?.with?.['node-version']).toBe('24');
    expect(setupNode?.with).not.toHaveProperty('cache');
    expect(windows).not.toMatch(/^\s*cache:\s*npm\s*$/m);

    const cacheStep = windowsJob?.steps?.find((step) => step.uses?.startsWith('actions/cache@'));
    expect(cacheStep?.uses).toBe(WINDOWS_CACHE_PIN);
    expect(cacheStep?.id).toBe('windows-node-modules');
    expect(cacheStep?.with?.path).toBe('node_modules');
    expect(cacheStep?.with?.key).toBe("Windows/node-24/${{ hashFiles('package-lock.json') }}");
    expect(cacheStep?.with).not.toHaveProperty('restore-keys');
    expect(windows).toContain(`${WINDOWS_CACHE_PIN} # v4.2.0`);
    expect(windows).toContain('id: windows-node-modules');
    expect(windows).toContain('path: node_modules');
    expect(windows).toContain("key: Windows/node-24/${{ hashFiles('package-lock.json') }}");
    expect(windows).not.toContain('restore-keys');

    const install = findStep(windowsJob, 'Install dependencies');
    expect(install?.if).toBe("steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(install?.run).toBe('npm ci --prefer-offline --no-audit --no-fund');
    expect(windows).toContain("if: steps.windows-node-modules.outputs.cache-hit != 'true'");
    expect(windows).toContain('run: npm ci --prefer-offline --no-audit --no-fund');

    const testSteps = windowsJob?.steps?.filter((step) => step.run === 'node --run test') ?? [];
    expect(testSteps).toHaveLength(1);
    expect(testSteps[0]?.if).toBeUndefined();
    expect(windows).toMatch(/^\s*- run: node --run test\s*$/m);
    expect(windows).not.toContain('node --run test --');
    expect(windows).not.toContain("node --run test'");

    expect(windows).not.toContain('Run Windows gates');
    expect(windows).not.toContain('Start-Gate');
    expect(windows).not.toContain('Start-Job');
    expect(windows).not.toContain('MAX_PARALLEL_GATES');
    expect(windows).not.toContain('npm run lint');
    expect(windows).not.toContain('npm run typecheck');
    expect(windows).not.toContain('check-sibling-pins.mjs');
    expect(windows).not.toContain('actionlint');
    expect(windows).not.toContain('commitlint');
  });

  it('keeps imported release helpers free of Windows-incompatible shebangs', () => {
    for (const helper of ['check-release-alias.mjs', 'verify-release-artifacts.mjs']) {
      const source = readFileSync(join(process.cwd(), 'scripts', helper), 'utf8');
      expect(source, helper).not.toMatch(/^#!/u);
    }
  });
});
