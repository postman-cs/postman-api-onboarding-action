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

// Siblings are pinned to reviewed immutable tags of the composite's own major.
// Release eligibility must depend only on committed pins, not on a mutable
// "latest tag" query that can change after the composite commit is reviewed.
const compositeVersion = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;
const compositeMajor = Number(String(compositeVersion).split('.')[0]);

function semverForMajor(tag, major) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts[0] === major ? parts : undefined;
}

function tagExists(repo, tag) {
  const remote = 'https://github.com/postman-cs/' + repo + '.git';
  const output = execFileSync('git', ['ls-remote', '--tags', remote, 'refs/tags/' + tag], {
    encoding: 'utf8'
  });
  return output.trim().length > 0;
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
  const prefix = 'postman-cs/' + repo + '@';
  const tag = typeof actual === 'string' && actual.startsWith(prefix)
    ? actual.slice(prefix.length)
    : '';
  if (!semverForMajor(tag, compositeMajor)) {
    failures.push(stepId + ': expected an immutable v' + compositeMajor + ' tag, found ' + (actual || '<missing>'));
    continue;
  }
  if (!tagExists(repo, tag)) {
    failures.push(stepId + ': pinned tag ' + tag + ' does not exist in postman-cs/' + repo);
    continue;
  }
  const siblingInputs = await fetchSiblingInputs(repo, tag);
  for (const key of Object.keys(step?.with ?? {})) {
    if (!siblingInputs.has(key)) {
      failures.push(stepId + ': forwards with-key `' + key + '` but ' + repo + '@' + tag + ' declares no such input');
    }
  }
}

if (failures.length > 0) {
  console.error('Composite sibling pins are invalid:');
  for (const failure of failures) {
    console.error('- ' + failure);
  }
  process.exit(1);
}

console.log('Composite sibling pins are existing immutable v' + compositeMajor + ' tags and every forwarded with-key is a declared sibling input.');
