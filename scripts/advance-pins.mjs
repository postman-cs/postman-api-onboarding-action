#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareSemver, parseLsRemoteLines, resolveTagCommit } from './check-release-alias.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB_OWNER = 'postman-cs';
const MAX_GITHUB_RESPONSE_BYTES = 2 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 30_000;

// Every file that carries an immutable sibling pin literal. action.yml is the
// source of truth; the rest mirror it and are normalized on every run so docs
// and contract tests can never drift from the manifest.
export const PIN_FILES = [
  'action.yml',
  '.github/workflows/release.yml',
  'scripts/verify-e2e-release.test.mjs',
  'tests/contract.test.ts',
  'tests/release-workflow.test.ts',
  'RELEASE_POLICY.md',
  'README.md'
];
export const PINNED_SIBLING_REPOSITORIES = Object.freeze([
  'postman-bootstrap-action',
  'postman-insights-onboarding-action',
  'postman-repo-sync-action',
  'postman-smoke-flow-action'
]);
export const EXPECTED_SIBLING_PACKAGE_NAMES = Object.freeze({
  'postman-bootstrap-action': '@postman-cs/onboarding-bootstrap',
  'postman-insights-onboarding-action': '@postman-cs/onboarding-insights',
  'postman-repo-sync-action': '@postman-cs/onboarding-repo-sync',
  'postman-smoke-flow-action': '@postman-cs/onboarding-smoke-flow'
});

const PINNED_SIBLING_SET = new Set(PINNED_SIBLING_REPOSITORIES);
const USES_PIN = /uses:\s*postman-cs\/(postman-[a-z-]+-action)@(v\d+\.\d+\.\d+)/g;
const IMMUTABLE_FULL = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function trustedAssetApiUrl(repo, value) {
  return typeof value === 'string' && new RegExp(
    `^https://api\\.github\\.com/repos/${GITHUB_OWNER}/${repo}/releases/assets/[1-9][0-9]*$`
  ).test(value);
}

/**
 * Extract the immutable sibling pins from the composite manifest.
 * The repository allowlist is deliberately closed so a manifest edit cannot
 * make scheduled automation contact or select an unreviewed sibling.
 * @param {string} actionYamlText
 * @returns {Array<{ repo: string, tag: string, major: number }>}
 */
export function extractPins(actionYamlText) {
  /** @type {Map<string, { repo: string, tag: string, major: number }>} */
  const pins = new Map();
  for (const match of String(actionYamlText).matchAll(USES_PIN)) {
    const [, repo, tag] = match;
    if (!PINNED_SIBLING_SET.has(repo)) {
      throw new Error(`unexpected sibling repository in action.yml: ${repo}`);
    }
    const parts = tag.match(IMMUTABLE_FULL);
    if (!parts) continue;
    const existing = pins.get(repo);
    if (existing && existing.tag !== tag) {
      throw new Error(`conflicting pins for ${repo}: ${existing.tag} vs ${tag}`);
    }
    pins.set(repo, { repo, tag, major: Number(parts[1]) });
  }
  const missing = PINNED_SIBLING_REPOSITORIES.filter((repo) => !pins.has(repo));
  if (missing.length > 0) {
    throw new Error(`action.yml is missing required immutable sibling pins: ${missing.join(', ')}`);
  }
  return [...pins.values()];
}

/**
 * Resolve one promoted immutable full tag from the rolling major alias.
 * Newer immutable tags that do not match the alias are intentionally ignored:
 * publication alone is not promotion evidence.
 * @param {{ repo: string, major: number, lsRemoteText: string }} input
 * @returns {{ repo: string, tag: string, commit: string }}
 */
export function selectPromotedImmutable({ repo, major, lsRemoteText }) {
  if (!PINNED_SIBLING_SET.has(repo)) throw new Error(`unexpected sibling repository: ${repo}`);
  if (!Number.isSafeInteger(major) || major <= 0) throw new Error(`invalid recorded major for ${repo}`);
  const tags = parseLsRemoteLines(lsRemoteText);
  const alias = `v${major}`;
  const aliasCommit = resolveTagCommit(tags, alias);
  if (!aliasCommit || !SHA1.test(aliasCommit)) {
    throw new Error(`${repo}: promoted rolling alias ${alias} is missing or malformed`);
  }

  const matches = [];
  for (const name of tags.keys()) {
    const version = name.match(IMMUTABLE_FULL);
    if (!version || Number(version[1]) !== major) continue;
    if (resolveTagCommit(tags, name) === aliasCommit) matches.push(name);
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new Error(
      `${repo}: rolling alias ${alias} must resolve to exactly one immutable v${major}.x.y tag; found ${unique.length}`
    );
  }
  return { repo, tag: unique[0], commit: aliasCommit };
}

/**
 * Validate the GitHub Release and its immutable release-manifest asset against
 * the promoted tag/commit selected from Git refs.
 * @param {{
 *   repo: string,
 *   promoted: { tag: string, commit: string },
 *   release: Record<string, unknown>,
 *   manifest: Record<string, unknown>,
 *   manifestDigest: string
 * }} input
 * @returns {{ repo: string, tag: string, commit: string, releaseId: number, artifactDigest: string }}
 */
export function validateReleaseIdentity({ repo, promoted, release, manifest, manifestDigest }) {
  if (!PINNED_SIBLING_SET.has(repo)) throw new Error(`unexpected sibling repository: ${repo}`);
  if (!IMMUTABLE_FULL.test(promoted?.tag ?? '') || !SHA1.test(promoted?.commit ?? '')) {
    throw new Error(`${repo}: promoted tag identity is malformed`);
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    throw new Error(`${repo}@${promoted.tag}: GitHub Release response is malformed`);
  }
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== promoted.tag ||
    release.draft !== false ||
    release.prerelease !== false
  ) {
    throw new Error(`${repo}@${promoted.tag}: GitHub Release identity does not match the promoted tag`);
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const manifestAssets = assets.filter((asset) => asset?.name === 'release-manifest.json');
  const tarballAssets = assets.filter((asset) => asset?.name === 'release.tgz');
  if (manifestAssets.length !== 1 || tarballAssets.length !== 1) {
    throw new Error(`${repo}@${promoted.tag}: release must contain exactly one manifest and release.tgz asset`);
  }
  for (const asset of [...manifestAssets, ...tarballAssets]) {
    if (
      asset.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0 ||
      !trustedAssetApiUrl(repo, asset.url) ||
      typeof asset.digest !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    ) {
      throw new Error(`${repo}@${promoted.tag}: required release asset identity is incomplete`);
    }
  }
  const manifestAsset = manifestAssets[0];
  const tarballAsset = tarballAssets[0];
  if (!SHA256.test(manifestDigest ?? '') || manifestAsset.digest !== `sha256:${manifestDigest}`) {
    throw new Error(`${repo}@${promoted.tag}: downloaded release manifest digest does not match its asset identity`);
  }

  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${repo}@${promoted.tag}: release manifest is malformed`);
  }
  const expectedRepository = `${GITHUB_OWNER}/${repo}`;
  if (
    manifest.schema_version !== 1 ||
    manifest.repository !== expectedRepository ||
    manifest.tag !== promoted.tag ||
    manifest.commit_sha !== promoted.commit ||
    manifest.package_version !== promoted.tag.slice(1) ||
    manifest.package_name !== EXPECTED_SIBLING_PACKAGE_NAMES[repo]
  ) {
    throw new Error(`${repo}@${promoted.tag}: release manifest identity does not match the promoted ref`);
  }

  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const paths = new Set();
  for (const artifact of artifacts) {
    if (
      !artifact ||
      typeof artifact !== 'object' ||
      typeof artifact.path !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(artifact.path) ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256.test(artifact.sha256) ||
      paths.has(artifact.path)
    ) {
      throw new Error(`${repo}@${promoted.tag}: release manifest artifact identity is malformed`);
    }
    paths.add(artifact.path);
  }
  const releaseTarball = artifacts.find((artifact) => artifact.path === 'release.tgz');
  if (!releaseTarball) {
    throw new Error(`${repo}@${promoted.tag}: release manifest does not identify release.tgz`);
  }
  if (tarballAsset.digest !== `sha256:${releaseTarball.sha256}`) {
    throw new Error(`${repo}@${promoted.tag}: release.tgz manifest digest does not match its asset identity`);
  }
  return {
    repo,
    tag: promoted.tag,
    commit: promoted.commit,
    releaseId: release.id,
    artifactDigest: releaseTarball.sha256
  };
}

/**
 * Decide which pins move, holding each inside its recorded major and refusing
 * to regress a pin that is unexpectedly ahead of the promoted alias.
 * @param {Array<{ repo: string, tag: string, major: number }>} pins
 * @param {Map<string, { repo: string, tag: string, commit: string, releaseId: number, artifactDigest: string }>} promotedByRepo
 * @returns {Array<{ repo: string, from: string, to: string, commit: string, artifactDigest: string }>}
 */
export function planAdvance(pins, promotedByRepo) {
  const plan = [];
  for (const { repo, tag, major } of pins) {
    const promoted = promotedByRepo.get(repo);
    if (!promoted) throw new Error(`${repo}: verified promoted release identity is missing`);
    const parts = promoted.tag.match(IMMUTABLE_FULL);
    if (!parts || Number(parts[1]) !== major) {
      throw new Error(`${repo}: promoted tag ${promoted.tag} crossed recorded major v${major}`);
    }
    const order = compareSemver(promoted.tag, tag);
    if (order < 0) {
      throw new Error(`${repo}: current pin ${tag} is ahead of promoted alias target ${promoted.tag}`);
    }
    if (order > 0) {
      plan.push({
        repo,
        from: tag,
        to: promoted.tag,
        commit: promoted.commit,
        artifactDigest: promoted.artifactDigest
      });
    }
  }
  return plan;
}

/**
 * Rewrite every immutable pin literal for a repo to the target tag. Rolling
 * aliases like `@v2` and `@vX.Y` forms are left untouched.
 * @param {string} text
 * @param {string} repo
 * @param {string} to
 * @returns {string}
 */
export function rewritePinLiterals(text, repo, to) {
  const actionLiteral = new RegExp(`postman-cs/${repo}@v\\d+\\.\\d+\\.\\d+`, 'g');
  const peerMapLiteral = new RegExp(
    `(["']postman-cs/${repo}["']\\s*:\\s*["'])v\\d+\\.\\d+\\.\\d+(["'])`,
    'g'
  );
  return text
    .replace(actionLiteral, `postman-cs/${repo}@${to}`)
    .replace(peerMapLiteral, `$1${to}$2`);
}

function lsRemoteTags(repo, major) {
  const remote = `https://github.com/${GITHUB_OWNER}/${repo}.git`;
  return execFileSync(
    'git',
    [
      'ls-remote',
      '--tags',
      remote,
      `refs/tags/v${major}`,
      `refs/tags/v${major}^{}`,
      `refs/tags/v${major}.*`,
      `refs/tags/v${major}.*^{}`
    ],
    { encoding: 'utf8', maxBuffer: MAX_GITHUB_RESPONSE_BYTES, timeout: NETWORK_TIMEOUT_MS }
  );
}

function githubApiJson(endpoint) {
  const text = execFileSync('gh', ['api', endpoint], {
    encoding: 'utf8',
    maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
    timeout: NETWORK_TIMEOUT_MS
  });
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub API returned unreadable JSON for ${endpoint}`);
  }
}

function fetchReleaseEnvelope(repo, tag) {
  const release = githubApiJson(`repos/${GITHUB_OWNER}/${repo}/releases/tags/${tag}`);
  const manifestAssets = Array.isArray(release?.assets)
    ? release.assets.filter((asset) => asset?.name === 'release-manifest.json')
    : [];
  if (manifestAssets.length !== 1) {
    throw new Error(`${repo}@${tag}: GitHub Release does not expose exactly one release-manifest.json asset`);
  }
  const assetUrl = manifestAssets[0]?.url;
  if (!trustedAssetApiUrl(repo, assetUrl)) {
    throw new Error(`${repo}@${tag}: release manifest asset URL is not a trusted GitHub API URL`);
  }
  const bytes = execFileSync('gh', ['api', '-H', 'Accept: application/octet-stream', assetUrl], {
    maxBuffer: MAX_GITHUB_RESPONSE_BYTES,
    timeout: NETWORK_TIMEOUT_MS
  });
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${repo}@${tag}: release-manifest.json is unreadable`);
  }
  const manifestDigest = createHash('sha256').update(bytes).digest('hex');
  return { release, manifest, manifestDigest };
}

function main() {
  const check = process.argv.includes('--check');
  const dryRun = check || process.argv.includes('--dry-run');
  const manifestText = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
  const pins = extractPins(manifestText);
  const promotedByRepo = new Map();
  for (const pin of pins) {
    const promoted = selectPromotedImmutable({
      repo: pin.repo,
      major: pin.major,
      lsRemoteText: lsRemoteTags(pin.repo, pin.major)
    });
    const envelope = fetchReleaseEnvelope(pin.repo, promoted.tag);
    const verified = validateReleaseIdentity({
      repo: pin.repo,
      promoted,
      release: envelope.release,
      manifest: envelope.manifest,
      manifestDigest: envelope.manifestDigest
    });
    const confirmed = selectPromotedImmutable({
      repo: pin.repo,
      major: pin.major,
      lsRemoteText: lsRemoteTags(pin.repo, pin.major)
    });
    if (confirmed.tag !== promoted.tag || confirmed.commit !== promoted.commit) {
      throw new Error(`${pin.repo}: promoted alias changed while its release identity was being verified`);
    }
    promotedByRepo.set(pin.repo, verified);
  }

  const plan = planAdvance(pins, promotedByRepo);
  if (check && plan.length > 0) {
    throw new Error(
      `sibling pins do not match verified promoted releases: ${plan.map(({ repo, from, to }) => `${repo} ${from} -> ${to}`).join(', ')}`
    );
  }
  const targets = new Map(pins.map(({ repo, tag }) => [repo, tag]));
  for (const { repo, to } of plan) targets.set(repo, to);

  for (const { repo, from, to, commit, artifactDigest } of plan) {
    console.log(
      `advance ${repo}: ${from} -> ${to} (commit ${commit.slice(0, 12)}, release.tgz sha256 ${artifactDigest.slice(0, 12)}...)`
    );
  }
  if (plan.length === 0) {
    console.log('All sibling pins already match their verified promoted rolling aliases.');
  }

  let wroteNormalization = false;
  for (const file of PIN_FILES) {
    const filePath = path.join(repoRoot, file);
    const before = readFileSync(filePath, 'utf8');
    let after = before;
    for (const [repo, to] of targets) {
      after = rewritePinLiterals(after, repo, to);
    }
    if (after === before) continue;
    if (check) throw new Error(`${file} contains stale sibling pin literals`);
    if (plan.length === 0) wroteNormalization = true;
    if (dryRun) {
      console.log(`would update ${file}`);
    } else {
      writeFileSync(filePath, after);
      console.log(`updated ${file}`);
    }
  }
  if (wroteNormalization) {
    console.log('Normalized stale pin literals to the pins recorded in action.yml.');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
