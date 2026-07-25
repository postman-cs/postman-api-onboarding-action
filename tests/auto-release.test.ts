/**
 * Automatic release-cut contract.
 *
 * Pins the invariants whose absence burned immutable tags before gates ran:
 * a burnt version number must be skipped rather than reused, and the tag must
 * be the last side effect after the release commit passes every gate.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as releaseCut from '../scripts/release-cut.mjs';

const parseConventionalBump = releaseCut.parseConventionalBump as (m: string[]) => string | null;
const applyBump = releaseCut.applyBump as (v: string, b: string) => string;
const selectNextVersion = releaseCut.selectNextVersion as (input: {
  current: string;
  bump: string;
  takenTags: string[];
}) => { version: string; skipped: string[] };

const repoRoot = process.cwd();
const autoReleaseWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/auto-release.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const releaseCutSource = readFileSync(join(repoRoot, 'scripts/release-cut.mjs'), 'utf8');
const prePushHook = readFileSync(join(repoRoot, '.githooks/pre-push'), 'utf8');

describe('release version selection', () => {
  it('skips a burnt version instead of reusing it', () => {
    const plan = selectNextVersion({
      current: '2.1.7',
      bump: 'patch',
      takenTags: ['v2.1.7', 'v2.1.8']
    });
    expect(plan.version).toBe('2.1.9');
    expect(plan.skipped).toContain('2.1.8');
  });

  it('never returns a version that is already tagged', () => {
    const taken = ['v2.1.0', 'v2.1.1', 'v2.1.2', 'v2.1.3'];
    const plan = selectNextVersion({ current: '2.1.0', bump: 'patch', takenTags: taken });
    expect(taken).not.toContain(`v${plan.version}`);
    expect(plan.version).toBe('2.1.4');
  });

  it('maps conventional commits onto semver bumps', () => {
    expect(parseConventionalBump(['feat: add input'])).toBe('minor');
    expect(parseConventionalBump(['fix: correct wiring'])).toBe('patch');
    expect(parseConventionalBump(['feat!: drop legacy input'])).toBe('major');
    expect(parseConventionalBump(['refactor: x\n\nBREAKING CHANGE: removed'])).toBe('major');
    expect(parseConventionalBump(['feat: a', 'fix: b'])).toBe('minor');
    expect(applyBump('2.1.8', 'minor')).toBe('2.2.0');
  });

  it('does not cut a release for release-plumbing commits alone', () => {
    expect(parseConventionalBump(['chore(release): v2.1.8'])).toBeNull();
    expect(parseConventionalBump(['ci: retune gate queue', 'test: add case'])).toBeNull();
    expect(parseConventionalBump([])).toBeNull();
  });
});

describe('release-cut ordering contract', () => {
  it('creates the tag only after the release commit is verified', () => {
    const tagIndex = releaseCutSource.indexOf("'tag', '-a'");
    const commitIndex = releaseCutSource.indexOf("'commit', '-m'");
    const verifyAfterCommit = releaseCutSource.indexOf('const releaseCommit');
    expect(tagIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeGreaterThan(-1);
    expect(commitIndex).toBeLessThan(verifyAfterCommit);
    expect(verifyAfterCommit).toBeLessThan(tagIndex);
  });

  it('reads every sha in-process rather than through shell variables', () => {
    expect(releaseCutSource).not.toContain('PREPARE_SHA');
    expect(releaseCutSource).toContain("git(['rev-parse', 'HEAD'])");
  });

  it('runs the composite gate set before committing and stages only release manifests', () => {
    expect(releaseCutSource).toContain('runReleaseGates');
    const gates = releaseCutSource.indexOf('runReleaseGates()');
    const commit = releaseCutSource.indexOf("'commit', '-m'");
    const tag = releaseCutSource.indexOf("'tag', '-a'");
    expect(gates).toBeGreaterThan(-1);
    expect(gates).toBeLessThan(commit);
    expect(commit).toBeLessThan(tag);
    expect(releaseCutSource).toContain("'package.json', 'package-lock.json'");
    expect(releaseCutSource).not.toContain('validation/evidence');
    expect(releaseCutSource).not.toContain('dist/');
  });
});

describe('auto-release workflow', () => {
  it('cuts from main pushes instead of hand-pushed tags', () => {
    expect(autoReleaseWorkflow).toContain('branches: [main]');
    expect(autoReleaseWorkflow).not.toMatch(/on:\n\s+push:\n\s+tags:/);
  });

  it('fetches full history and tags so burnt versions are visible', () => {
    expect(autoReleaseWorkflow).toContain('fetch-depth: 0');
    expect(autoReleaseWorkflow).toContain('fetch-tags: true');
  });

  it('plans before it cuts and cuts before it pushes', () => {
    const plan = autoReleaseWorkflow.indexOf('name: Plan release');
    const cut = autoReleaseWorkflow.indexOf('name: Cut release');
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    expect(plan).toBeGreaterThan(-1);
    expect(plan).toBeLessThan(cut);
    expect(cut).toBeLessThan(push);
  });

  it('pushes only the tag, never a commit onto protected main', () => {
    expect(autoReleaseWorkflow).toContain('git push origin "refs/tags/v${VERSION}"');
    expect(autoReleaseWorkflow).not.toContain('HEAD:${GITHUB_REF_NAME}');
  });

  it('starts release.yml explicitly after the tag push', () => {
    const push = autoReleaseWorkflow.indexOf('name: Push release tag');
    const dispatch = autoReleaseWorkflow.indexOf('gh workflow run release.yml');
    expect(dispatch).toBeGreaterThan(push);
  });

  it('never cancels a cut in flight', () => {
    expect(autoReleaseWorkflow).toContain('cancel-in-progress: false');
  });

  it('writes its plan outside the worktree so the cut sees a clean tree', () => {
    expect(autoReleaseWorkflow).not.toMatch(/tee plan\.json/);
    expect(autoReleaseWorkflow).toContain('PLAN_FILE: ${{ runner.temp }}/plan.json');
  });

  it('does not carry receipt backport machinery', () => {
    expect(autoReleaseWorkflow).not.toContain('multifile-spec-sync');
    expect(autoReleaseWorkflow).not.toContain('gh pr create');
    expect(autoReleaseWorkflow).not.toContain('pull-requests: write');
  });
});

describe('pre-push tag guard', () => {
  it('rejects hand-pushed immutable release tags but exempts CI and rolling aliases', () => {
    expect(prePushHook).toContain('refs/tags/v[0-9]*.[0-9]*');
    expect(prePushHook).toContain('GITHUB_ACTIONS');
    expect(prePushHook).not.toContain('refs/tags/v[0-9]$');
  });
});
