#!/usr/bin/env node
/* global process */
/**
 * Automatic release cut.
 *
 * Owns the entire release transition in ONE node process: derive the next
 * version, bump manifests, run the declared gate set, commit, and only then
 * create the tag.
 *
 * Two invariants this file exists to enforce:
 *
 * 1. Every git sha is read in-process via `git rev-parse`. No sha is ever
 *    routed through a shell variable.
 * 2. The tag is the LAST side effect, created only after the exact bytes of
 *    the release commit pass validation. A failed cut leaves no tag behind.
 *
 * Already-taken tags are treated as burnt and skipped, so a previously failed
 * version number is never reused (release tags are immutable by policy).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');
const LOCK_PATH = path.join(REPO_ROOT, 'package-lock.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_ONLY = new Set(['package.json', 'package-lock.json']);

/** Conventional-commit subjects that carry no shippable behavior on their own. */
const NON_SHIPPING_TYPES = new Set(['chore', 'ci', 'build', 'test', 'style']);

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', options.quiet ? 'ignore' : 'pipe']
  }).trim();
}

function run(command, args) {
  execFileSync(command, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'inherit' });
}

/**
 * Classify a conventional-commit body into a semver bump.
 * @param {string[]} messages full commit messages (subject + body)
 * @returns {'major'|'minor'|'patch'|null} null when nothing shippable landed
 */
export function parseConventionalBump(messages) {
  const entries = (Array.isArray(messages) ? messages : []).filter(
    (message) => typeof message === 'string' && message.trim()
  );
  if (entries.length === 0) return null;

  let bump = null;
  const rank = { patch: 1, minor: 2, major: 3 };
  const raise = (next) => {
    if (!bump || rank[next] > rank[bump]) bump = next;
  };

  for (const message of entries) {
    const subject = message.split('\n', 1)[0];
    const header = /^([a-zA-Z]+)(\([^)]*\))?(!)?:/.exec(subject);
    const type = header ? header[1].toLowerCase() : '';
    const breaking = Boolean(header && header[3]) || /^BREAKING[ -]CHANGE:/m.test(message);

    if (breaking) {
      raise('major');
      continue;
    }
    if (type === 'feat') {
      raise('minor');
      continue;
    }
    if (header && NON_SHIPPING_TYPES.has(type)) continue;
    // fix, perf, refactor, revert, docs, and untyped commits all ship as a patch.
    raise('patch');
  }
  return bump;
}

/**
 * @param {string} version
 * @param {'major'|'minor'|'patch'} bump
 */
export function applyBump(version, bump) {
  const parsed = SEMVER.exec(String(version || ''));
  if (!parsed) throw new Error(`current version ${version} is not plain semver`);
  const [major, minor, patch] = parsed.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unsupported bump ${bump}`);
}

/**
 * Pick the next free version. Any tag that already exists is burnt: release
 * tags are immutable, so a previously failed cut is skipped rather than
 * reused, which is what lets a failed release heal on the next merge.
 *
 * @param {{current: string, bump: 'major'|'minor'|'patch', takenTags: Iterable<string>}} input
 */
export function selectNextVersion({ current, bump, takenTags }) {
  const taken = new Set(Array.from(takenTags || [], (tag) => String(tag).replace(/^v/, '')));
  let candidate = applyBump(current, bump);
  const skipped = [];
  while (taken.has(candidate)) {
    skipped.push(candidate);
    candidate = applyBump(candidate, 'patch');
    if (skipped.length > 256) throw new Error('exhausted patch space searching for a free release version');
  }
  return { version: candidate, skipped };
}

/**
 * Set the version in package.json and package-lock.json without reformatting
 * either file.
 * @param {string} version
 */
export function writeVersion(version) {
  if (!SEMVER.test(version)) throw new Error(`refusing to write non-semver version ${version}`);

  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  pkg.version = version;
  writeFileSync(PKG_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  const lock = JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`);
}

/** Run the composite gate set declared by package.json and ci.yml. */
export function runReleaseGates() {
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'lint']);
  run('npm', ['test']);
  run('node', ['scripts/check-sibling-pins.mjs']);
  const actionlint = process.env.ACTIONLINT_BIN;
  if (actionlint) run(actionlint, []);
}

function assertCleanTree() {
  const dirty = git(['status', '--porcelain']);
  if (dirty) throw new Error(`refusing to cut a release from a dirty tree:\n${dirty}`);
}

function allTags() {
  const local = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
  let remote;
  try {
    remote = git(['ls-remote', '--tags', 'origin'])
      .split('\n')
      .map((line) => line.split('\t')[1] || '')
      .map((ref) => ref.replace('refs/tags/', '').replace(/\^\{\}$/, ''))
      .filter((tag) => tag.startsWith('v'));
  } catch {
    throw new Error('could not list remote tags; refusing to cut a release blind to burnt versions');
  }
  return new Set([...local, ...remote]);
}

function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const raw = git(['log', range, '--no-merges', '--format=%B%x00']);
  return raw.split('\u0000').map((entry) => entry.trim()).filter(Boolean);
}

function latestReleaseTag(taken) {
  const versions = Array.from(taken)
    .map((tag) => tag.replace(/^v/, ''))
    .filter((version) => SEMVER.test(version))
    .sort((a, b) => {
      const left = a.split('.').map(Number);
      const right = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (left[i] !== right[i]) return left[i] - right[i];
      }
      return 0;
    });
  const newest = versions[versions.length - 1];
  return newest ? `v${newest}` : null;
}

/**
 * Decide whether a release is due and which version it takes.
 * Pure enough to run in --plan mode on any checkout.
 */
export function planRelease() {
  const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'));
  const taken = allTags();
  const previous = latestReleaseTag(taken);
  const messages = commitsSince(previous);
  const bump = parseConventionalBump(messages);

  if (!bump) {
    return { release: false, reason: 'no shippable commits since the last release tag', previous };
  }

  const base = previous ? previous.replace(/^v/, '') : pkg.version;
  const { version, skipped } = selectNextVersion({ current: base, bump, takenTags: taken });
  return { release: true, previous, bump, version, skipped, commits: messages.length };
}

function executeRelease(plan) {
  assertCleanTree();

  writeVersion(plan.version);
  runReleaseGates();

  run('git', ['add', 'package.json', 'package-lock.json']);
  const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  const offenders = staged.filter((file) => !RELEASE_ONLY.has(file));
  if (offenders.length > 0) {
    throw new Error(`release commit touched non-release paths: ${offenders.join(', ')}`);
  }

  run('git', ['commit', '-m', `chore(release): v${plan.version}`]);

  const releaseCommit = git(['rev-parse', 'HEAD']);
  const committedVersion = JSON.parse(git(['show', `${releaseCommit}:package.json`])).version;
  if (committedVersion !== plan.version) {
    throw new Error(`committed version ${committedVersion} does not match planned ${plan.version}`);
  }

  run('git', ['tag', '-a', `v${plan.version}`, '-m', `v${plan.version}`, releaseCommit]);
  return { version: plan.version, releaseCommit };
}

function main() {
  const mode = process.argv[2] || '--plan';
  if (!['--plan', '--execute'].includes(mode)) {
    throw new Error('Usage: node scripts/release-cut.mjs --plan|--execute');
  }

  const plan = planRelease();
  if (!plan.release) {
    process.stdout.write(`${JSON.stringify({ ...plan, mode }, null, 2)}\n`);
    return;
  }

  if (mode === '--plan') {
    process.stdout.write(`${JSON.stringify({ ...plan, mode }, null, 2)}\n`);
    return;
  }

  const result = executeRelease(plan);
  process.stdout.write(`${JSON.stringify({ ...plan, ...result, mode }, null, 2)}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
