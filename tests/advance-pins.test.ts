/**
 * Sibling pin auto-advance contract.
 *
 * Pins the invariants that keep the pin-advance path safe: an advance never
 * crosses the recorded major, never touches rolling aliases, and the
 * advance-pins workflow validates the moved pins with the sibling-pin gate
 * and the full test suite before anything is pushed or a PR is opened.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIN_FILES,
  extractPins,
  latestImmutableForMajor,
  planAdvance,
  rewritePinLiterals
} from '../scripts/advance-pins.mjs';

const repoRoot = process.cwd();
const advanceWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/advance-pins.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const actionManifest = readFileSync(join(repoRoot, 'action.yml'), 'utf8');
const contractTests = readFileSync(join(repoRoot, 'tests/contract.test.ts'), 'utf8');

describe('pin extraction', () => {
  it('extracts every immutable sibling pin from the real manifest', () => {
    const pins = extractPins(actionManifest);
    const repos = pins.map((pin) => pin.repo).sort();
    expect(repos).toEqual([
      'postman-bootstrap-action',
      'postman-insights-onboarding-action',
      'postman-repo-sync-action',
      'postman-smoke-flow-action'
    ]);
    for (const pin of pins) {
      expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(pin.major).toBe(Number(pin.tag.slice(1).split('.')[0]));
    }
  });

  it('rejects conflicting pins for the same sibling', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      'uses: postman-cs/postman-bootstrap-action@v2.13.8'
    ].join('\n');
    expect(() => extractPins(text)).toThrow(/conflicting pins/);
  });
});

describe('advance planning', () => {
  const tags = ['v1.9.9', 'v2.13.8', 'v2.14.0', 'v3.0.0', 'v2.14', 'v2', 'not-a-tag'];

  it('selects the newest immutable tag of the recorded major only', () => {
    expect(latestImmutableForMajor(tags, 2)).toBe('v2.14.0');
    expect(latestImmutableForMajor(tags, 3)).toBe('v3.0.0');
    expect(latestImmutableForMajor(tags, 4)).toBeNull();
  });

  it('advances within the major and never across it', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.13.8', major: 2 }];
    const plan = planAdvance(pins, new Map([['postman-bootstrap-action', tags]]));
    expect(plan).toEqual([{ repo: 'postman-bootstrap-action', from: 'v2.13.8', to: 'v2.14.0' }]);
  });

  it('plans nothing when the pin is already newest in its major', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.14.0', major: 2 }];
    expect(planAdvance(pins, new Map([['postman-bootstrap-action', tags]]))).toEqual([]);
  });
});

describe('pin literal rewriting', () => {
  it('rewrites every immutable literal but leaves rolling aliases alone', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      '`postman-cs/postman-bootstrap-action@v2.13.7`',
      'postman-cs/postman-bootstrap-action@v2',
      'postman-cs/postman-repo-sync-action@v2.6.8'
    ].join('\n');
    const result = rewritePinLiterals(text, 'postman-bootstrap-action', 'v2.13.8');
    expect(result).toContain('uses: postman-cs/postman-bootstrap-action@v2.13.8');
    expect(result).toContain('`postman-cs/postman-bootstrap-action@v2.13.8`');
    expect(result).toContain('postman-cs/postman-bootstrap-action@v2\n');
    expect(result).toContain('postman-cs/postman-repo-sync-action@v2.6.8');
  });
});

describe('advance-pins workflow', () => {
  it('listens for sibling release dispatches with a cron backstop and manual trigger', () => {
    expect(advanceWorkflow).toContain('repository_dispatch');
    expect(advanceWorkflow).toContain('sibling-release');
    expect(advanceWorkflow).toContain('schedule:');
    expect(advanceWorkflow).toContain('workflow_dispatch');
  });

  it('validates moved pins with the sibling-pin gate and full tests before opening a PR', () => {
    const validate = advanceWorkflow.indexOf('node scripts/check-sibling-pins.mjs');
    const fullTests = advanceWorkflow.indexOf('npm test');
    const branchPush = advanceWorkflow.indexOf('git push origin "HEAD:refs/heads/${BRANCH}"');
    const prCreate = advanceWorkflow.indexOf('gh pr create');
    expect(validate).toBeGreaterThan(-1);
    expect(fullTests).toBeGreaterThan(-1);
    expect(branchPush).toBeGreaterThan(-1);
    expect(prCreate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(branchPush);
    expect(fullTests).toBeLessThan(branchPush);
    expect(branchPush).toBeLessThan(prCreate);
  });
  it('commits with a conventional fix scope so Auto Release cuts a patch', () => {
    expect(advanceWorkflow).toContain('fix(deps): advance sibling pins');
  });

  it('keeps current real sibling refs in updater-owned contract tests', () => {
    expect(PIN_FILES).toContain('tests/contract.test.ts');
    const pins = extractPins(actionManifest);
    for (const { repo, tag } of pins) {
      expect(contractTests).toContain(`postman-cs/${repo}@${tag}`);
    }
  });

  it('contains no default-branch push path at all', () => {
    expect(advanceWorkflow).not.toMatch(/git push\s+\S+\s+HEAD:main/);
    expect(advanceWorkflow).not.toMatch(/git push[^\n]*\bmain\b/);
    for (const line of advanceWorkflow.split('\n')) {
      if (!line.includes('git push')) continue;
      expect(line, 'every git push targets a non-default branch ref').toContain(
        'HEAD:refs/heads/${BRANCH}'
      );
    }
  });

  it('always lands a pin advance through a branch push plus pull request', () => {
    expect(advanceWorkflow).toContain('BRANCH="chore/advance-sibling-pins-');
    expect(advanceWorkflow).toContain('git push origin "HEAD:refs/heads/${BRANCH}"');
    expect(advanceWorkflow).toContain('gh pr create');
    expect(advanceWorkflow).toContain('--base main');
    expect(advanceWorkflow).toContain('gh workflow run ci.yml');
    // No conditional gate can route the advance around the pull request.
    expect(advanceWorkflow).not.toContain('if [ -n "$APP_TOKEN" ]');
    expect(advanceWorkflow).not.toContain('No App token minted');
    expect(advanceWorkflow).not.toContain('App-backed push to main failed');
  });

  it('keeps write credentials scoped to the branch push and pull request', () => {
    expect(advanceWorkflow).toContain('pull-requests: write');
    expect(advanceWorkflow).toContain(
      'GH_TOKEN: ${{ steps.app-token.outputs.token || github.token }}'
    );
    expect(advanceWorkflow).not.toContain('APP_TOKEN:');
  });
});
