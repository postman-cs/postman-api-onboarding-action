import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ACTIONLINT_DOWNLOADER_COMMIT = '393031adb9afb225ee52ae2ccd7a5af5525e03e8';
const ACTIONLINT_VERSION = '1.7.11';
const ACTIONLINT_DOWNLOADER_URL = `https://raw.githubusercontent.com/rhysd/actionlint/${ACTIONLINT_DOWNLOADER_COMMIT}/scripts/download-actionlint.bash`;

const ciWorkflowText = readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
const ciWorkflow = parse(ciWorkflowText) as {
  concurrency?: { group?: string; 'cancel-in-progress'?: string | boolean };
  jobs?: Record<string, WorkflowJob>;
};

type WorkflowStep = {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
  shell?: string;
};

type WorkflowJob = {
  name?: string;
  'runs-on'?: string;
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

/** Exact Windows `Run Windows gates` PowerShell body under `run: |`, with YAML indent stripped. */
function extractWindowsRunGatesBody(source: string): string {
  const windows = jobText(source, 'windows');
  const match = windows.match(
    /^ {6}- name: Run Windows gates\n {8}shell: pwsh\n {8}run: \|\n([\s\S]*)$/m,
  );
  if (!match?.[1]) {
    throw new Error('Windows Run Windows gates pwsh body not found');
  }
  return match[1]
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
    .join('\n');
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

  it('keeps the required Windows job with exact four gates, cap two, and native exit fail-through', () => {
    expect(windowsJob?.name).toBe('Windows gate');
    expect(windowsJob?.['runs-on']).toBe('windows-latest');
    expect(windows).toContain('runs-on: windows-latest');
    expect(windows).not.toMatch(/^\s*fetch-depth:\s*/m);

    const runGates = namedStep(windows, 'Run Windows gates');
    expect(runGates).toContain('shell: pwsh');
    expect(runGates).toContain('$MAX_PARALLEL_GATES = 2');
    expect(runGates).toContain('while ($jobs.Count -ge $MAX_PARALLEL_GATES) { Complete-One }');
    expect(runGates).toContain('while ($jobs.Count -gt 0) { Complete-One }');
    expect(runGates).toContain('Start-Job');
    expect(runGates).toContain('function Start-Gate($name, $executable, $gateArgs)');
    expect(runGates).toContain('& $executable @gateArgs');
    expect(runGates).toContain('if ($LASTEXITCODE -ne 0) { throw "gate failed with exit code $LASTEXITCODE" }');
    expect(runGates).not.toContain('Invoke-Expression');

    expect(runGates).toContain("Start-Gate lint npm @('run', 'lint')");
    expect(runGates).toContain("Start-Gate test npm @('test')");
    expect(runGates).toContain("Start-Gate typecheck npm @('run', 'typecheck')");
    expect(runGates).toContain("Start-Gate sibling-pins node @('scripts/check-sibling-pins.mjs')");
    expect(runGates.match(/Start-Gate [a-zA-Z0-9_-]+ /g) ?? []).toHaveLength(4);

    expect(runGates).toContain("foreach ($name in @('lint', 'test', 'typecheck', 'sibling-pins'))");
    expect(runGates).toContain("if ($results[$name] -eq 'Completed') { Write-Output \"gate:$name=pass\" } else { Write-Output \"gate:$name=fail\"; $failed = $true }");
    expect(runGates).toContain('if ($failed) { exit 1 }');
    expect(runGates).not.toContain('actionlint');
    expect(runGates).not.toContain('commitlint');
  });

  it(
    'executes the Windows gate runner and fails aggregate status when a native gate exits nonzero',
    () => {
      const script = extractWindowsRunGatesBody(ciWorkflowText);
      expect(script).toContain('& $executable @gateArgs');
      expect(script).toContain('if ($LASTEXITCODE -ne 0) { throw "gate failed with exit code $LASTEXITCODE" }');
      expect(script).not.toContain('Invoke-Expression');

      const mutated = script
        .replace(/^[ \t]*Start-Gate lint .+\n/mu, '')
        .replace(/Start-Gate test .+/u, "Start-Gate test node @('-e', 'process.exit(7)')")
        .replace(/^[ \t]*Start-Gate typecheck .+\n/mu, '')
        .replace(/^[ \t]*Start-Gate sibling-pins .+\n/mu, '')
        .replace(
          /foreach \(\$name in @\('lint', 'test', 'typecheck', 'sibling-pins'\)\)/u,
          "foreach ($name in @('test'))",
        );

      expect(mutated).toContain("Start-Gate test node @('-e', 'process.exit(7)')");
      expect(mutated).toContain("foreach ($name in @('test'))");
      expect(mutated).not.toContain("Start-Gate test npm @('test')");
      expect(mutated).not.toMatch(/^[ \t]*Start-Gate lint /mu);
      expect(mutated).not.toMatch(/^[ \t]*Start-Gate typecheck /mu);
      expect(mutated).not.toMatch(/^[ \t]*Start-Gate sibling-pins /mu);
      expect(mutated.match(/^[ \t]*Start-Gate /gmu) ?? []).toHaveLength(1);

      const probe = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
      const probeError = probe.error as NodeJS.ErrnoException | undefined;
      if (probeError?.code === 'ENOENT') {
        return;
      }
      expect(probeError, `${probe.stderr ?? ''}`).toBeUndefined();

      const fixture = mkdtempSync(join(tmpdir(), 'api-ci-windows-gates-'));
      try {
        writeFileSync(join(fixture, 'run-gates.ps1'), `${mutated}\n`);
        const result = spawnSync('pwsh', ['-NoProfile', '-File', 'run-gates.ps1'], {
          cwd: fixture,
          encoding: 'utf8',
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;

        expect(result.status, output).not.toBe(0);
        expect(output).toContain('gate:test=fail');
        expect(output).not.toContain('gate:lint=');
        expect(output).not.toContain('gate:typecheck=');
        expect(output).not.toContain('gate:sibling-pins=');
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
