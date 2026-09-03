/**
 * Sibling pin auto-advance contract.
 *
 * Pins the invariants that keep the pin-advance path safe: an advance selects
 * only the exact immutable release at the rolling alias commit, verifies its
 * GitHub Release manifest, never crosses the recorded major, and runs every
 * gate before a topic branch or pull request is created.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_SIBLING_PACKAGE_NAMES,
  PIN_FILES,
  PINNED_SIBLING_REPOSITORIES,
  extractPins,
  planAdvance,
  rewritePinLiterals,
  selectPromotedImmutable,
  validateReleaseIdentity
} from '../scripts/advance-pins.mjs';

const repoRoot = process.cwd();
const advanceWorkflow = readFileSync(
  join(repoRoot, '.github/workflows/advance-pins.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const actionManifest = readFileSync(join(repoRoot, 'action.yml'), 'utf8');
const contractTests = readFileSync(join(repoRoot, 'tests/contract.test.ts'), 'utf8');
const selectorSource = readFileSync(join(repoRoot, 'scripts/advance-pins.mjs'), 'utf8');

const oldCommit = 'a'.repeat(40);
const promotedCommit = 'b'.repeat(40);
const unpromotedCommit = 'c'.repeat(40);
const releaseTgzDigest = 'd'.repeat(64);
const manifestAssetDigest = 'e'.repeat(64);

function annotatedTag(name: string, commit: string, object = 'e'.repeat(40)): string {
  return [
    `${object}\trefs/tags/${name}`,
    `${commit}\trefs/tags/${name}^{}`
  ].join('\n');
}

function promotedRefs(extras: string[] = []): string {
  return [
    annotatedTag('v2', promotedCommit, '1'.repeat(40)),
    annotatedTag('v2.13.8', oldCommit, '2'.repeat(40)),
    annotatedTag('v2.14.0', promotedCommit, '3'.repeat(40)),
    annotatedTag('v2.15.0', unpromotedCommit, '4'.repeat(40)),
    ...extras
  ].join('\n');
}

function releaseEnvelope(overrides: {
  release?: Record<string, unknown>;
  manifest?: Record<string, unknown>;
  manifestDigest?: string;
} = {}) {
  const release = {
    id: 42,
    tag_name: 'v2.14.0',
    draft: false,
    prerelease: false,
    assets: [
      {
        name: 'release-manifest.json',
        state: 'uploaded',
        size: 512,
        digest: `sha256:${manifestAssetDigest}`,
        url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/1'
      },
      {
        name: 'release.tgz',
        state: 'uploaded',
        size: 4096,
        digest: `sha256:${releaseTgzDigest}`,
        url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/2'
      }
    ],
    ...overrides.release
  };
  const manifest = {
    schema_version: 1,
    repository: 'postman-cs/postman-bootstrap-action',
    commit_sha: promotedCommit,
    tag: 'v2.14.0',
    package_name: '@postman-cs/onboarding-bootstrap',
    package_version: '2.14.0',
    artifacts: [{ path: 'release.tgz', sha256: releaseTgzDigest }],
    ...overrides.manifest
  };
  return { release, manifest, manifestDigest: overrides.manifestDigest ?? manifestAssetDigest };
}

function verifiedPromotion(tag = 'v2.14.0') {
  return {
    repo: 'postman-bootstrap-action',
    tag,
    commit: promotedCommit,
    releaseId: 42,
    artifactDigest: releaseTgzDigest
  };
}

describe('pin extraction', () => {
  it('extracts exactly the closed immutable sibling allowlist from the real manifest', () => {
    const pins = extractPins(actionManifest);
    const repos = pins.map((pin) => pin.repo).sort();
    expect(repos).toEqual([...PINNED_SIBLING_REPOSITORIES].sort());
    for (const pin of pins) {
      expect(pin.tag).toMatch(/^v\d+\.\d+\.\d+$/);
      expect(pin.major).toBe(Number(pin.tag.slice(1).split('.')[0]));
    }
    expect(Object.keys(EXPECTED_SIBLING_PACKAGE_NAMES).sort()).toEqual(
      [...PINNED_SIBLING_REPOSITORIES].sort()
    );
  });

  it('rejects conflicting pins for the same sibling', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      'uses: postman-cs/postman-bootstrap-action@v2.13.8'
    ].join('\n');
    expect(() => extractPins(text)).toThrow(/conflicting pins/);
  });

  it('rejects missing and unexpected sibling repositories', () => {
    expect(() =>
      extractPins(
        actionManifest.replace(
          /uses: postman-cs\/postman-bootstrap-action@v\d+\.\d+\.\d+/,
          ''
        )
      )
    ).toThrow(/missing required immutable sibling pins/);
    expect(() =>
      extractPins(`${actionManifest}\nuses: postman-cs/postman-unreviewed-action@v2.1.0`)
    ).toThrow(/unexpected sibling repository/);
  });
});

describe('promoted alias selection', () => {
  it('selects only the immutable tag at the rolling alias commit', () => {
    expect(
      selectPromotedImmutable({
        repo: 'postman-bootstrap-action',
        major: 2,
        lsRemoteText: promotedRefs()
      })
    ).toEqual({
      repo: 'postman-bootstrap-action',
      tag: 'v2.14.0',
      commit: promotedCommit
    });
  });

  it('ignores a newer immutable tag that the rolling alias has not promoted', () => {
    const selected = selectPromotedImmutable({
      repo: 'postman-bootstrap-action',
      major: 2,
      lsRemoteText: promotedRefs()
    });
    expect(selected.tag).toBe('v2.14.0');
    expect(selected.tag).not.toBe('v2.15.0');
  });

  it.each([
    {
      label: 'missing alias',
      refs: annotatedTag('v2.14.0', promotedCommit)
    },
    {
      label: 'alias without an immutable target',
      refs: annotatedTag('v2', promotedCommit)
    },
    {
      label: 'ambiguous immutable targets',
      refs: promotedRefs([annotatedTag('v2.14.1', promotedCommit, '5'.repeat(40))])
    },
    {
      label: 'only a cross-major target',
      refs: [annotatedTag('v2', promotedCommit), annotatedTag('v3.0.0', promotedCommit)].join('\n')
    }
  ])('fails closed for $label', ({ refs }) => {
    expect(() =>
      selectPromotedImmutable({
        repo: 'postman-bootstrap-action',
        major: 2,
        lsRemoteText: refs
      })
    ).toThrow();
  });
});

describe('GitHub Release identity', () => {
  it('binds the promoted tag and commit to the release manifest and tarball digest', () => {
    const { release, manifest, manifestDigest } = releaseEnvelope();
    expect(
      validateReleaseIdentity({
        repo: 'postman-bootstrap-action',
        promoted: { tag: 'v2.14.0', commit: promotedCommit },
        release,
        manifest,
        manifestDigest
      })
    ).toEqual(verifiedPromotion());
  });

  it.each([
    {
      label: 'wrong release tag',
      envelope: releaseEnvelope({ release: { tag_name: 'v2.15.0' } })
    },
    {
      label: 'draft release',
      envelope: releaseEnvelope({ release: { draft: true } })
    },
    {
      label: 'prerelease',
      envelope: releaseEnvelope({ release: { prerelease: true } })
    },
    {
      label: 'missing manifest asset',
      envelope: releaseEnvelope({
        release: {
          assets: [
            {
              name: 'release.tgz',
              state: 'uploaded',
              size: 4096,
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/2'
            }
          ]
        }
      })
    },
    {
      label: 'wrong manifest repository',
      envelope: releaseEnvelope({ manifest: { repository: 'attacker/repository' } })
    },
    {
      label: 'wrong sibling package name',
      envelope: releaseEnvelope({ manifest: { package_name: '@postman-cs/onboarding-repo-sync' } })
    },
    {
      label: 'wrong manifest commit',
      envelope: releaseEnvelope({ manifest: { commit_sha: unpromotedCommit } })
    },
    {
      label: 'wrong manifest tag',
      envelope: releaseEnvelope({ manifest: { tag: 'v2.15.0' } })
    },
    {
      label: 'invalid tarball digest',
      envelope: releaseEnvelope({
        manifest: { artifacts: [{ path: 'release.tgz', sha256: 'not-a-digest' }] }
      })
    },
    {
      label: 'duplicate artifact path',
      envelope: releaseEnvelope({
        manifest: {
          artifacts: [
            { path: 'release.tgz', sha256: releaseTgzDigest },
            { path: 'release.tgz', sha256: 'f'.repeat(64) }
          ]
        }
      })
    },
    {
      label: 'missing manifest asset digest',
      envelope: releaseEnvelope({
        release: {
          assets: [
            {
              name: 'release-manifest.json',
              state: 'uploaded',
              size: 512,
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/1'
            },
            {
              name: 'release.tgz',
              state: 'uploaded',
              size: 4096,
              digest: `sha256:${releaseTgzDigest}`,
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/2'
            }
          ]
        }
      })
    },
    {
      label: 'malformed tarball asset digest',
      envelope: releaseEnvelope({
        release: {
          assets: [
            {
              name: 'release-manifest.json',
              state: 'uploaded',
              size: 512,
              digest: `sha256:${manifestAssetDigest}`,
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/1'
            },
            {
              name: 'release.tgz',
              state: 'uploaded',
              size: 4096,
              digest: 'sha256:not-a-digest',
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/2'
            }
          ]
        }
      })
    },
    {
      label: 'downloaded manifest digest mismatch',
      envelope: releaseEnvelope({ manifestDigest: 'f'.repeat(64) })
    },
    {
      label: 'tarball manifest and asset digest mismatch',
      envelope: releaseEnvelope({
        manifest: { artifacts: [{ path: 'release.tgz', sha256: 'f'.repeat(64) }] }
      })
    },
    {
      label: 'untrusted tarball asset API URL',
      envelope: releaseEnvelope({
        release: {
          assets: [
            {
              name: 'release-manifest.json',
              state: 'uploaded',
              size: 512,
              digest: `sha256:${manifestAssetDigest}`,
              url: 'https://api.github.com/repos/postman-cs/postman-bootstrap-action/releases/assets/1'
            },
            {
              name: 'release.tgz',
              state: 'uploaded',
              size: 4096,
              digest: `sha256:${releaseTgzDigest}`,
              url: 'https://attacker.example/releases/assets/2'
            }
          ]
        }
      })
    }
  ])('rejects $label', ({ envelope }) => {
    expect(() =>
      validateReleaseIdentity({
        repo: 'postman-bootstrap-action',
        promoted: { tag: 'v2.14.0', commit: promotedCommit },
        release: envelope.release,
        manifest: envelope.manifest,
        manifestDigest: envelope.manifestDigest
      })
    ).toThrow();
  });
});

describe('advance planning', () => {
  it('advances within the major to the verified promoted release only', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.13.8', major: 2 }];
    const promoted = verifiedPromotion();
    const plan = planAdvance(pins, new Map([[promoted.repo, promoted]]));
    expect(plan).toEqual([
      {
        repo: 'postman-bootstrap-action',
        from: 'v2.13.8',
        to: 'v2.14.0',
        commit: promotedCommit,
        artifactDigest: releaseTgzDigest
      }
    ]);
  });

  it('plans nothing when the pin already equals the promoted release', () => {
    const pins = [{ repo: 'postman-bootstrap-action', tag: 'v2.14.0', major: 2 }];
    const promoted = verifiedPromotion();
    expect(planAdvance(pins, new Map([[promoted.repo, promoted]]))).toEqual([]);
  });

  it('fails closed for missing evidence, a cross-major target, or an attempted regression', () => {
    const pin = { repo: 'postman-bootstrap-action', tag: 'v2.14.0', major: 2 };
    expect(() => planAdvance([pin], new Map())).toThrow(/identity is missing/);
    const crossMajor = verifiedPromotion('v3.0.0');
    expect(() => planAdvance([pin], new Map([[crossMajor.repo, crossMajor]]))).toThrow(
      /crossed recorded major/
    );
    const older = verifiedPromotion('v2.13.8');
    expect(() => planAdvance([pin], new Map([[older.repo, older]]))).toThrow(/ahead of promoted/);
  });
});

describe('pin literal rewriting', () => {
  it('rewrites every immutable literal but leaves rolling aliases alone', () => {
    const text = [
      'uses: postman-cs/postman-bootstrap-action@v2.13.7',
      '`postman-cs/postman-bootstrap-action@v2.13.7`',
      'E2E_GATE_PEER_TAGS: \'{"postman-cs/postman-bootstrap-action":"v2.13.7"}\'',
      "'postman-cs/postman-bootstrap-action': 'v2.13.7'",
      'postman-cs/postman-bootstrap-action@v2',
      'postman-cs/postman-repo-sync-action@v2.6.8'
    ].join('\n');
    const result = rewritePinLiterals(text, 'postman-bootstrap-action', 'v2.13.8');
    expect(result).toContain('uses: postman-cs/postman-bootstrap-action@v2.13.8');
    expect(result).toContain('`postman-cs/postman-bootstrap-action@v2.13.8`');
    expect(result).toContain(
      'E2E_GATE_PEER_TAGS: \'{"postman-cs/postman-bootstrap-action":"v2.13.8"}\''
    );
    expect(result).toContain("'postman-cs/postman-bootstrap-action': 'v2.13.8'");
    expect(result).toContain('postman-cs/postman-bootstrap-action@v2\n');
    expect(result).toContain('postman-cs/postman-repo-sync-action@v2.6.8');
  });
});

describe('advance-pins workflow', () => {
  it('routes sibling notification, cron, and manual triggers through one selector', () => {
    expect(advanceWorkflow).toContain('repository_dispatch');
    expect(advanceWorkflow).toContain('sibling-release');
    expect(advanceWorkflow).toContain('schedule:');
    expect(advanceWorkflow).toContain('workflow_dispatch');
    expect(advanceWorkflow.match(/node scripts\/advance-pins\.mjs/g)).toHaveLength(2);
    expect(advanceWorkflow).toContain('node scripts/advance-pins.mjs --check');
    expect(advanceWorkflow).not.toContain('github.event.client_payload');
  });

  it('verifies promoted refs and GitHub Release identity before writing pin files', () => {
    const selection = selectorSource.indexOf('const promoted = selectPromotedImmutable({');
    const release = selectorSource.indexOf('fetchReleaseEnvelope(pin.repo, promoted.tag)', selection);
    const planning = selectorSource.indexOf('const plan = planAdvance(pins, promotedByRepo)', release);
    const write = selectorSource.indexOf('writeFileSync(filePath, after)', planning);
    expect(selection).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(selection);
    expect(planning).toBeGreaterThan(release);
    expect(write).toBeGreaterThan(planning);
    expect(selectorSource).toContain("execFileSync('gh', ['api'");
    expect(selectorSource).not.toContain('latestImmutableForMajor');
  });

  it('fails closed and keeps sibling reads separate from composite writes', () => {
    const readMintStart = advanceWorkflow.indexOf('name: Mint sibling release read token');
    const writeMintStart = advanceWorkflow.indexOf('name: Mint composite write token');
    const checkoutStart = advanceWorkflow.indexOf('- uses: actions/checkout@v7');
    const fullTests = advanceWorkflow.indexOf('npm test');
    const commitStart = advanceWorkflow.indexOf('name: Commit and open pull request');
    expect(readMintStart).toBeGreaterThan(-1);
    expect(checkoutStart).toBeGreaterThan(readMintStart);
    expect(writeMintStart).toBeGreaterThan(fullTests);
    expect(commitStart).toBeGreaterThan(writeMintStart);

    const readMint = advanceWorkflow.slice(readMintStart, checkoutStart);
    const writeMint = advanceWorkflow.slice(writeMintStart, commitStart);
    expect(readMint).not.toContain('continue-on-error');
    expect(writeMint).not.toContain('continue-on-error');
    for (const repo of PINNED_SIBLING_REPOSITORIES) {
      expect(readMint).toContain(`            ${repo}`);
      expect(writeMint).not.toContain(repo);
    }
    expect(
      readMint
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => PINNED_SIBLING_REPOSITORIES.includes(line))
    ).toEqual([...PINNED_SIBLING_REPOSITORIES]);
    expect(readMint).not.toContain('postman-api-onboarding-action');
    expect(readMint).toContain('permission-contents: read');
    expect(readMint).not.toContain('permission-contents: write');
    expect(readMint).not.toContain('permission-pull-requests:');
    expect(readMint).not.toContain('permission-actions:');
    expect(readMint).not.toContain('permission-workflows:');
    expect(writeMint).toContain('repositories: postman-api-onboarding-action');
    expect(writeMint).toContain('permission-contents: write');
    expect(writeMint).toContain('permission-pull-requests: write');
    expect(writeMint).toContain('permission-actions: write');
    expect(writeMint).toContain('permission-workflows: write');
    expect(writeMint).toContain("if: steps.advance.outputs.changed == 'true'");

    expect(advanceWorkflow).toContain('token: ${{ github.token }}');
    expect(advanceWorkflow).toContain('persist-credentials: false');
    expect(advanceWorkflow).toContain(
      'GH_TOKEN: ${{ steps.sibling-read-token.outputs.token }}'
    );
    expect(advanceWorkflow).toContain(
      'GH_TOKEN: ${{ steps.composite-write-token.outputs.token }}'
    );
    expect(advanceWorkflow).not.toContain('|| github.token');
  });

  it('validates moved pins with the sibling-pin gate and full tests before opening a PR', () => {
    const validate = advanceWorkflow.indexOf('node scripts/check-sibling-pins.mjs');
    const promotionCheck = advanceWorkflow.indexOf('node scripts/advance-pins.mjs --check');
    const fullTests = advanceWorkflow.indexOf('npm test');
    const branchPush = advanceWorkflow.indexOf('git push origin "HEAD:refs/heads/${BRANCH}"');
    const prCreate = advanceWorkflow.indexOf('gh pr create');
    expect(validate).toBeGreaterThan(-1);
    expect(promotionCheck).toBeGreaterThan(-1);
    expect(fullTests).toBeGreaterThan(-1);
    expect(branchPush).toBeGreaterThan(-1);
    expect(prCreate).toBeGreaterThan(-1);
    expect(promotionCheck).toBeLessThan(validate);
    expect(validate).toBeLessThan(branchPush);
    expect(fullTests).toBeLessThan(branchPush);
    expect(branchPush).toBeLessThan(prCreate);
  });
  it('commits with a conventional fix scope so Auto Release cuts a patch', () => {
    expect(advanceWorkflow).toContain('fix(deps): advance sibling pins');
  });

  it('keeps current real sibling refs in updater-owned contract tests', () => {
    expect(PIN_FILES).toEqual([
      'action.yml',
      '.github/workflows/release.yml',
      'scripts/verify-e2e-release.test.mjs',
      'tests/contract.test.ts',
      'tests/release-workflow.test.ts',
      'RELEASE_POLICY.md',
      'README.md'
    ]);
    const stagedFiles = advanceWorkflow.match(/git add \\\n([\s\S]*?)\n\s+git commit/)?.[1] ?? '';
    for (const file of PIN_FILES) expect(stagedFiles).toContain(file);
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

  it('uses read credentials for selection and exposes write credentials only during PR publication', () => {
    const advanceStart = advanceWorkflow.indexOf('name: Advance pins');
    const validateStart = advanceWorkflow.indexOf('name: Validate advanced pins');
    const writeMintStart = advanceWorkflow.indexOf('name: Mint composite write token');
    const commitStart = advanceWorkflow.indexOf('name: Commit and open pull request');
    const advanceStep = advanceWorkflow.slice(advanceStart, validateStart);
    const validateStep = advanceWorkflow.slice(validateStart, writeMintStart);
    const commitStep = advanceWorkflow.slice(commitStart);
    expect(advanceStep).toContain('GH_TOKEN: ${{ steps.sibling-read-token.outputs.token }}');
    expect(validateStep).toContain('GH_TOKEN: ${{ steps.sibling-read-token.outputs.token }}');
    expect(commitStep).toContain('GH_TOKEN: ${{ steps.composite-write-token.outputs.token }}');
    expect(commitStep).toContain('gh auth setup-git');
    expect(advanceStep).not.toContain('composite-write-token');
    expect(validateStep).not.toContain('composite-write-token');
    expect(commitStep).not.toContain('sibling-read-token');

    const jobPermissions = advanceWorkflow.slice(
      advanceWorkflow.indexOf('  advance:'),
      advanceWorkflow.indexOf('    steps:')
    );
    expect(jobPermissions).toContain('contents: read');
    expect(jobPermissions).not.toContain('contents: write');
    expect(jobPermissions).not.toContain('pull-requests: write');
    expect(jobPermissions).not.toContain('actions: write');
    expect(advanceWorkflow).not.toContain('APP_TOKEN:');
  });
});
