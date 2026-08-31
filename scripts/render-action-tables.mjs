#!/usr/bin/env node
// Renders the Inputs and Outputs tables in README.md from action.yml.
// Usage:
//   node scripts/render-action-tables.mjs          # rewrite README tables in place
//   node scripts/render-action-tables.mjs --check  # exit 1 if README tables drift from action.yml

import console from 'node:console';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = path.join(repoRoot, 'README.md');

const MARKERS = {
  inputs: ['<!-- inputs-table:start -->', '<!-- inputs-table:end -->'],
  outputs: ['<!-- outputs-table:start -->', '<!-- outputs-table:end -->'],
};

const HIDDEN_INPUTS = new Set(['integration-backend', 'postman-stack']);
const HIDDEN_OUTPUTS = new Set(['integration-backend']);

// Accepted values per input. GitHub Actions inputs are untyped strings, so
// enums and formats validated in action.yml (or forwarded to and validated
// by a sibling action) are not derivable from the manifest and live here
// instead.
const INPUT_OPTIONS = {
  'working-directory': 'Repo-relative directory path',
  'workspace-id': 'Any existing Postman workspace ID',
  'spec-id': 'Any existing Postman spec ID',
  'baseline-collection-id': 'Any existing Postman collection ID',
  'smoke-collection-id': 'Any existing Postman collection ID',
  'contract-collection-id': 'Any existing Postman collection ID',
  'onboarding-scope': '`full`, `spec-only`',
  'sync-examples': '`true`, `false`',
  'collection-sync-mode': '`refresh`, `version`',
  'spec-sync-mode': '`update`, `version`',
  'release-label': 'Any string',
  'monitor-id': 'Any existing Postman monitor ID',
  'mock-url': 'Any Postman mock server URL',
  'mock-visibility': '`public`, `private`',
  'mock-environment-enabled': '`true`, `false`',
  'monitor-cron': 'Any valid cron expression',
  'generate-ci-workflow': '`true`, `false`',
  'ci-workflow-path': 'Repo-relative file path',
  'ci-runner-os': '`linux`, `windows`',
  'project-name': 'Any string',
  'repo-url': 'Any repository URL',
  domain: 'Any string',
  'domain-code': 'Any string',
  'governance-group': 'Any governance workspace group name',
  'requester-email': 'Any email address',
  'workspace-admin-user-ids': 'Comma-separated Postman user IDs',
  'workspace-team-id': 'Numeric Postman sub-team (squad) ID',
  'spec-url': 'Any HTTPS URL',
  'spec-path': 'Repo-relative file path',
  'spec-files-json': 'JSON object string (schemaVersion 1 inventory)',
  'preserve-oas30-type-null': '`true`, `false`',
  'breaking-change-mode': '`off`, `pr-native`, `baseline-only`, `previous-spec`',
  'breaking-baseline-spec-path': 'Repo-relative file path',
  'breaking-rules-path': 'Repo-relative file path',
  'breaking-target-ref': 'Any git branch or ref',
  'breaking-summary-path': 'Any file path',
  'breaking-log-path': 'Any file path',
  'environments-json': 'JSON array string of environment slugs',
  'system-env-map-json': 'JSON object string mapping slug to system environment id',
  'environment-uids-json': 'JSON object string mapping slug to Postman environment UID',
  'governance-mapping-json': 'JSON object string mapping domain to governance group name',
  'env-runtime-urls-json': 'JSON object string mapping slug to runtime base URL',
  'postman-api-key': 'Any Postman API key (PMAK)',
  'postman-access-token': 'Any Postman access token',
  'insights-postman-api-key': 'Any human-user Postman API key (PMAK)',
  'insights-postman-access-token': 'Any human-user session access token',
  'credential-preflight': '`warn`, `enforce`',
  'branch-strategy': '`legacy`, `publish-gate`, `preview`',
  'canonical-branch': 'Any git branch name',
  channels: 'Comma-separated `pattern=CODE` pairs',
  'preview-ttl': 'Any positive integer (days)',
  'postman-team-id': 'Numeric Postman team ID',
  'postman-region': '`us`, `eu`',
  'postman-stack': '`prod`, `beta`',
  'github-token': 'Any GitHub token',
  'gh-fallback-token': 'Any GitHub token',
  'repo-write-mode': '`none`, `commit-only`, `commit-and-push`',
  'current-ref': 'Any git ref',
  'committer-name': 'Any string',
  'committer-email': 'Any email address',
  'flow-path': 'Repo-relative file path',
  'flow-mode': '`auto`, `curated`, `off`',
  'flow-allow-delete': '`true`, `false`',
  'persist-derived-flow': '`true`, `false`',
  'enable-insights': '`true`, `false`',
  'skip-built-in-tests': '`true`, `false`',
  'cluster-name': 'Any string',
  'org-mode': '`true`, `false`',
  'ssl-client-cert': 'Base64-encoded PEM certificate',
  'ssl-client-key': 'Base64-encoded PEM private key',
  'ssl-client-passphrase': 'Any string',
  'ssl-extra-ca-certs': 'Base64-encoded PEM certificate(s)',
};

function cell(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\|/g, '\\|')
    .trim();
}

export function renderInputsTable(manifest) {
  const rows = Object.entries(manifest.inputs).filter(([name]) => !HIDDEN_INPUTS.has(name)).map(([name, spec]) => {
    const required = spec.required ? 'yes' : 'no';
    const def = spec.default !== undefined && spec.default !== '' ? `\`${cell(spec.default)}\`` : '';
    const options = cell(INPUT_OPTIONS[name] ?? '');
    return `| \`${name}\` | ${cell(spec.description)} | ${options} | ${required} | ${def} |`;
  });
  return ['| Name | Description | Options | Required | Default |', '| --- | --- | --- | --- | --- |', ...rows].join('\n');
}

export function renderOutputsTable(manifest) {
  const rows = Object.entries(manifest.outputs).filter(([name]) => !HIDDEN_OUTPUTS.has(name)).map(
    ([name, spec]) => `| \`${name}\` | ${cell(spec.description)} |`
  );
  return ['| Name | Description |', '| --- | --- |', ...rows].join('\n');
}

function replaceBetween(content, [start, end], table) {
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`README.md is missing markers ${start} / ${end}`);
  }
  return content.slice(0, startIdx + start.length) + '\n' + table + '\n' + content.slice(endIdx);
}

export function renderReadme(readme, manifest) {
  const lineEnding = readme.includes('\r\n') ? '\r\n' : '\n';
  let next = replaceBetween(readme.replace(/\r\n/g, '\n'), MARKERS.inputs, renderInputsTable(manifest));
  next = replaceBetween(next, MARKERS.outputs, renderOutputsTable(manifest));
  return lineEnding === '\r\n' ? next.replace(/\n/g, '\r\n') : next;
}

function main() {
  const manifest = parse(readFileSync(path.join(repoRoot, 'action.yml'), 'utf8'));
  const readme = readFileSync(readmePath, 'utf8');
  const next = renderReadme(readme, manifest);
  if (process.argv.includes('--check')) {
    if (next !== readme) {
      console.error('README tables drift from action.yml. Run: npm run docs:tables');
      process.exit(1);
    }
    console.log('README tables match action.yml.');
    return;
  }
  if (next !== readme) {
    writeFileSync(readmePath, next);
    console.log('README tables updated.');
  } else {
    console.log('README tables already current.');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
