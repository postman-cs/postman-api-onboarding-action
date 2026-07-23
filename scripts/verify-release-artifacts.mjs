/* global console, process */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SHA256_HEX = /^[a-f0-9]{64}$/;
const REQUIRED_FIELDS = ['repository', 'commit_sha', 'tag', 'package_name', 'package_version'];

/**
 * @param {string | Buffer} fileOrBytes
 * @returns {string}
 */
export function sha256(fileOrBytes) {
  const bytes = typeof fileOrBytes === 'string' ? readFileSync(fileOrBytes) : fileOrBytes;
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * @param {string | Buffer} fileOrBytes
 * @returns {string}
 */
export function computeNpmSri(fileOrBytes) {
  const bytes = typeof fileOrBytes === 'string' ? readFileSync(fileOrBytes) : fileOrBytes;
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * @param {string} expected
 * @param {string} actual
 */
export function assertNpmSriMatch(expected, actual) {
  if (String(expected ?? '').trim() !== String(actual ?? '').trim()) {
    throw new Error('Published npm integrity differs from staged tarball');
  }
}

/**
 * @param {string} tag
 * @param {string} packageVersion
 */
export function validateTagVersion(tag, packageVersion) {
  if (typeof tag !== 'string' || typeof packageVersion !== 'string') {
    throw new Error('tag and package version must be strings');
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageVersion)) {
    throw new Error(`invalid package version ${packageVersion}`);
  }
  const [major, minor, patch] = packageVersion.split('.');
  const allowed = [`v${packageVersion}`];
  if (patch === '0') allowed.push(`v${major}.${minor}`);
  if (!allowed.includes(tag)) {
    throw new Error(`tag ${tag} does not match package version ${packageVersion}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`manifest ${label} must be a non-empty string`);
  }
}

/**
 * @param {unknown} manifest
 * @param {{ repository: string, commitSha: string, tag: string }} expected
 */
export function validateManifest(manifest, expected) {
  if (!manifest || typeof manifest !== 'object') throw new Error('unsupported manifest schema');
  const body = /** @type {Record<string, unknown>} */ (manifest);
  if (body.schema_version !== 1) throw new Error('unsupported manifest schema');
  for (const key of REQUIRED_FIELDS) assertNonEmptyString(body[key], key);
  for (const [key, value] of Object.entries({
    repository: expected.repository,
    commit_sha: expected.commitSha,
    tag: expected.tag
  })) {
    if (body[key] !== value) throw new Error(`${key} does not match this release`);
  }
  if (!Array.isArray(body.artifacts) || body.artifacts.length !== 1) {
    throw new Error('manifest artifact allowlist is invalid');
  }
  const artifact = /** @type {Record<string, unknown>} */ (body.artifacts[0] ?? {});
  if (artifact.path !== 'release.tgz' || typeof artifact.sha256 !== 'string' || !SHA256_HEX.test(artifact.sha256)) {
    throw new Error('manifest artifact is invalid');
  }
  return body;
}

/**
 * @param {string} tarball
 * @returns {{ name: string, version: string }}
 */
function packageJson(tarball) {
  return JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
}

/**
 * @param {string} directory
 * @param {{ repository: string, commitSha: string, tag: string }} expected
 */
export function verifyReleaseArtifacts(directory, expected) {
  const manifestPath = path.join(directory, 'release-manifest.json');
  if (!existsSync(manifestPath)) throw new Error('Release artifact verification failed: missing release-manifest.json');
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), expected);
  } catch (error) {
    throw new Error(`Release artifact verification failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  const artifact = /** @type {{ path: string, sha256: string }} */ (/** @type {unknown[]} */ (manifest.artifacts)[0]);
  const tarball = path.join(directory, artifact.path);
  if (!existsSync(tarball)) {
    throw new Error(`Release artifact verification failed: missing artifact ${artifact.path}`);
  }
  if (sha256(tarball) !== artifact.sha256) {
    throw new Error(`Release artifact verification failed: checksum mismatch for ${artifact.path}`);
  }
  const pkg = packageJson(tarball);
  if (pkg.name !== manifest.package_name) {
    throw new Error('Release artifact verification failed: package name does not match manifest');
  }
  if (pkg.version !== manifest.package_version) {
    throw new Error('Release artifact verification failed: package version does not match manifest');
  }
  try {
    validateTagVersion(expected.tag, pkg.version);
  } catch (error) {
    throw new Error(`Release artifact verification failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error
    });
  }
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const directory = path.resolve(process.argv[2] ?? '.');
    verifyReleaseArtifacts(directory, {
      repository: process.env.GITHUB_REPOSITORY ?? '',
      commitSha: process.env.GITHUB_SHA ?? '',
      tag: process.env.GITHUB_REF_NAME ?? ''
    });
    console.log('Release artifacts match the manifest and invocation identity.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
