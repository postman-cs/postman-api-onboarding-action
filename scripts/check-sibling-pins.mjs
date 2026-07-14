#!/usr/bin/env node
/* global console, fetch, process */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredPins = [
  { repo: 'postman-bootstrap-action', stepId: 'bootstrap' },
  { repo: 'postman-repo-sync-action', stepId: 'repo_sync' },
  { repo: 'postman-insights-onboarding-action', stepId: 'insights_onboarding' }
];

// Siblings are pinned to the latest immutable tag of the composite's own major
// version, so the pins advance in lockstep with the suite release train.
const compositeVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const compositeMajor = Number(String(compositeVersion).split('.')[0]);

function semverForMajor(tag, major) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts[0] === major ? parts : undefined;
}

function compareSemver(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function latestTag(repo, major) {
  const remote = 'https://github.com/postman-cs/' + repo + '.git';
  const output = execFileSync('git', ['ls-remote', '--tags', remote, 'refs/tags/v' + major + '.*'], {
    encoding: 'utf8'
  });
  const tags = output
    .split('\n')
    .map((line) => line.trim().split('/').pop())
    .filter(Boolean)
    .map((tag) => ({ tag, semver: semverForMajor(tag, major) }))
    .filter((entry) => entry.semver);
  if (tags.length === 0) {
    throw new Error('No immutable v' + major + ' tags found for ' + repo);
  }
  tags.sort((left, right) => compareSemver(left.semver, right.semver));
  return tags.at(-1).tag;
}

const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));
const failures = [];

// P3 composite wiring lint (.plans/e2e-suite-tuneup.md): beyond pin freshness,
// assert every `with:` key the composite forwards exists as a declared input on
// the pinned sibling's manifest, so an input rename in a sibling cannot ship a
// silently-dropped forward.
async function fetchSiblingInputs(repo, tag) {
  const url = 'https://raw.githubusercontent.com/postman-cs/' + repo + '/' + tag + '/action.yml';
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch ' + url + ': HTTP ' + response.status);
  }
  const sibling = parse(await response.text());
  return new Set(Object.keys(sibling.inputs ?? {}));
}

for (const { repo, stepId } of requiredPins) {
  const step = manifest.runs.steps.find((candidate) => candidate.id === stepId);
  const actual = step?.uses;
  const latest = latestTag(repo, compositeMajor);
  const expected = 'postman-cs/' + repo + '@' + latest;
  if (actual !== expected) {
    failures.push(stepId + ': expected ' + expected + ', found ' + (actual || '<missing>'));
    continue;
  }
  const siblingInputs = await fetchSiblingInputs(repo, latest);
  for (const key of Object.keys(step?.with ?? {})) {
    if (!siblingInputs.has(key)) {
      failures.push(stepId + ': forwards with-key `' + key + '` but ' + repo + '@' + latest + ' declares no such input');
    }
  }
}

if (failures.length > 0) {
  console.error('Composite sibling pins are stale:');
  for (const failure of failures) {
    console.error('- ' + failure);
  }
  process.exit(1);
}

console.log('Composite sibling pins match the latest immutable v' + compositeMajor + ' tags and every forwarded with-key is a declared sibling input.');