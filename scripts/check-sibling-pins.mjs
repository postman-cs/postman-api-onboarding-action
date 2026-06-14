#!/usr/bin/env node
/* global console, process */
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

function semverFromTag(tag) {
  const match = tag.match(/^v(1)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

function latestV1Tag(repo) {
  const remote = 'https://github.com/postman-cs/' + repo + '.git';
  const output = execFileSync('git', ['ls-remote', '--tags', remote, 'refs/tags/v1.*'], {
    encoding: 'utf8'
  });
  const tags = output
    .split('\n')
    .map((line) => line.trim().split('/').pop())
    .filter(Boolean)
    .map((tag) => ({ tag, semver: semverFromTag(tag) }))
    .filter((entry) => entry.semver);
  if (tags.length === 0) {
    throw new Error('No immutable v1 tags found for ' + repo);
  }
  tags.sort((left, right) => compareSemver(left.semver, right.semver));
  return tags.at(-1).tag;
}

const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));
const failures = [];

for (const { repo, stepId } of requiredPins) {
  const step = manifest.runs.steps.find((candidate) => candidate.id === stepId);
  const actual = step?.uses;
  const latest = latestV1Tag(repo);
  const expected = 'postman-cs/' + repo + '@' + latest;
  if (actual !== expected) {
    failures.push(stepId + ': expected ' + expected + ', found ' + (actual || '<missing>'));
  }
}

if (failures.length > 0) {
  console.error('Composite sibling pins are stale:');
  for (const failure of failures) {
    console.error('- ' + failure);
  }
  process.exit(1);
}

console.log('Composite sibling pins match the latest immutable v1 tags.');
