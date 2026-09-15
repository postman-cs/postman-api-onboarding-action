#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compareSemver, parseLsRemoteLines } from './check-release-alias.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Every file that carries an immutable sibling pin literal. action.yml is the
// source of truth; the rest mirror it and are normalized on every run so docs
// and contract tests can never drift from the manifest.
export const PIN_FILES = ['action.yml', 'tests/contract.test.ts', 'RELEASE_POLICY.md', 'README.md'];

const USES_PIN = /uses:\s*postman-cs\/(postman-[a-z-]+-action)@(v\d+\.\d+\.\d+)/g;
const IMMUTABLE_FULL = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * Extract the immutable sibling pins from the composite manifest.
 * The recorded major of each pin is the major of the pinned tag itself, so an
 * advance can never cross a major boundary: majors move only through a
 * reviewed commit, per RELEASE_POLICY.md.
 * @param {string} actionYamlText
 * @returns {Array<{ repo: string, tag: string, major: number }>}
 */
export function extractPins(actionYamlText) {
  /** @type {Map<string, { repo: string, tag: string, major: number }>} */
  const pins = new Map();
  for (const match of String(actionYamlText).matchAll(USES_PIN)) {
    const [, repo, tag] = match;
    const parts = tag.match(IMMUTABLE_FULL);
    if (!parts) continue;
    const existing = pins.get(repo);
    if (existing && existing.tag !== tag) {
      throw new Error(`conflicting pins for ${repo}: ${existing.tag} vs ${tag}`);
    }
    pins.set(repo, { repo, tag, major: Number(parts[1]) });
  }
  return [...pins.values()];
}

/**
 * Pick the newest immutable vX.Y.Z tag of the given major.
 * @param {Iterable<string>} tagNames
 * @param {number} major
 * @returns {string | null}
 */
export function latestImmutableForMajor(tagNames, major) {
  let latest = null;
  for (const name of tagNames) {
    const parts = name.match(IMMUTABLE_FULL);
    if (!parts || Number(parts[1]) !== major) continue;
    if (latest === null || compareSemver(name, latest) > 0) latest = name;
  }
  return latest;
}

/**
 * Decide which pins move, holding each inside its recorded major.
 * @param {Array<{ repo: string, tag: string, major: number }>} pins
 * @param {Map<string, Iterable<string>>} tagsByRepo
 * @returns {Array<{ repo: string, from: string, to: string }>}
 */
export function planAdvance(pins, tagsByRepo) {
  const plan = [];
  for (const { repo, tag, major } of pins) {
    const latest = latestImmutableForMajor(tagsByRepo.get(repo) ?? [], major);
    if (latest && compareSemver(latest, tag) > 0) {
      plan.push({ repo, from: tag, to: latest });
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
  const literal = new RegExp(`postman-cs/${repo}@v\\d+\\.\\d+\\.\\d+`, 'g');
  return text.replace(literal, `postman-cs/${repo}@${to}`);
}

function lsRemoteTags(repo) {
  const remote = `https://github.com/postman-cs/${repo}.git`;
  const output = execFileSync('git', ['ls-remote', '--tags', remote], { encoding: 'utf8' });
  return [...parseLsRemoteLines(output).keys()];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const manifest = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
  const pins = extractPins(manifest);
  if (pins.length === 0) {
    console.error('No immutable sibling pins found in action.yml');
    process.exit(1);
  }

  const tagsByRepo = new Map(pins.map(({ repo }) => [repo, lsRemoteTags(repo)]));
  const plan = planAdvance(pins, tagsByRepo);
  const targets = new Map(pins.map(({ repo, tag }) => [repo, tag]));
  for (const { repo, to } of plan) targets.set(repo, to);

  for (const { repo, from, to } of plan) {
    console.log(`advance ${repo}: ${from} -> ${to}`);
  }
  if (plan.length === 0) console.log('All sibling pins are already at the newest tag of their majors.');

  let wroteNormalization = false;
  for (const file of PIN_FILES) {
    const filePath = path.join(repoRoot, file);
    const before = readFileSync(filePath, 'utf8');
    let after = before;
    for (const [repo, to] of targets) {
      after = rewritePinLiterals(after, repo, to);
    }
    if (after === before) continue;
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
