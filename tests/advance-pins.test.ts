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
  it('keeps every sibling ref immutable and extracts every release-tag pin', () => {
    const refs = [...actionManifest.matchAll(
      /uses:\s*postman-cs\/(postman-[a-z-]+-action)@([^\s]+)/g
    )].map((match) => ({ repo: match[1], ref: match[2] }));
    expect(refs.map(({ repo }) => repo).sort()).toEqual([
      'postman-bootstrap-action',
      'postman-insights-onboarding-action',
      'postman-repo-sync-action',
      'postman-smoke-flow-action'
    ]);
    for (const { ref } of refs) {
      expect(ref).toMatch(/^(?:v\d+\.\d+\.\d+|[0-9a-f]{40})$/);
    }

    const pins = extractPins(actionManifest);
    const repos = pins.map((pin) => pin.repo).sort();
    expect(repos).toEqual(
      refs.filter(({ ref }) => /^v\d+\.\d+\.\d+$/.test(ref)).map(({ repo }) => repo).sort()
    );
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

  it('validates moved pins with the sibling-pin gate and full tests before pushing', () => {
    const validate = advanceWorkflow.indexOf('node scripts/check-sibling-pins.mjs');
    const fullTests = advanceWorkflow.indexOf('npm test');
    const push = advanceWorkflow.indexOf('git push origin HEAD:main');
    expect(validate).toBeGreaterThan(-1);
    expect(fullTests).toBeGreaterThan(-1);
    expect(push).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(push);
    expect(fullTests).toBeLessThan(push);
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

  it('gates direct main push on a non-empty App token so GITHUB_TOKEN cannot land unreleased pins', () => {
    // APP_TOKEN is the raw App token without fallback to github.token
    expect(advanceWorkflow).toContain('APP_TOKEN: ${{ steps.app-token.outputs.token }}');
    expect(advanceWorkflow).not.toContain('APP_TOKEN: ${{ steps.app-token.outputs.token || github.token }}');
    // GH_TOKEN is github.token for the PR fallback only
    expect(advanceWorkflow).toContain('GH_TOKEN: ${{ github.token }}');
    expect(advanceWorkflow).not.toContain('GH_TOKEN: ${{ steps.app-token.outputs.token || github.token }}');
    // Direct main push is gated on APP_TOKEN being non-empty
    expect(advanceWorkflow).toContain('if [ -n "$APP_TOKEN" ]');
    expect(advanceWorkflow).toContain('git push origin HEAD:main');
    // The direct push precedes the PR fallback in script order
    expect(advanceWorkflow.indexOf('if [ -n "$APP_TOKEN" ]')).toBeGreaterThan(-1);
    expect(advanceWorkflow.indexOf('git push origin HEAD:main')).toBeGreaterThan(-1);
    expect(advanceWorkflow.indexOf('if [ -n "$APP_TOKEN" ]')).toBeLessThan(
      advanceWorkflow.indexOf('git push origin HEAD:main')
    );
    expect(advanceWorkflow.indexOf('git push origin HEAD:main')).toBeLessThan(
      advanceWorkflow.indexOf('gh pr create')
    );
    // Notice printed when App token is absent
    expect(advanceWorkflow).toContain('No App token minted');
  });

  it('reaches PR fallback instead of a direct main push when no App token is minted', () => {
    const noTokenNoticeIdx = advanceWorkflow.indexOf('No App token minted');
    const prFallbackIdx = advanceWorkflow.indexOf('gh pr create');
    expect(noTokenNoticeIdx).toBeGreaterThan(-1);
    expect(prFallbackIdx).toBeGreaterThan(-1);
    expect(noTokenNoticeIdx).toBeLessThan(prFallbackIdx);
    expect(advanceWorkflow).toContain('BRANCH="chore/advance-sibling-pins-');
    expect(advanceWorkflow).toContain('gh workflow run ci.yml');
    // The no-App path must NOT attempt a direct main push
    const noAppSection = advanceWorkflow.slice(noTokenNoticeIdx, prFallbackIdx);
    expect(noAppSection).not.toContain('git push origin HEAD:main');
  });

  it('falls back to PR when an App-backed direct push fails', () => {
    // The push failure notice precedes the PR fallback
    const pushFailNoticeIdx = advanceWorkflow.indexOf('App-backed push to main failed');
    const prFallbackIdx = advanceWorkflow.indexOf('gh pr create');
    expect(pushFailNoticeIdx).toBeGreaterThan(-1);
    expect(prFallbackIdx).toBeGreaterThan(-1);
    expect(pushFailNoticeIdx).toBeLessThan(prFallbackIdx);
  });
});
