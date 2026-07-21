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
    return `| \`${name}\` | ${cell(spec.description)} | ${required} | ${def} |`;
  });
  return ['| Name | Description | Required | Default |', '| --- | --- | --- | --- |', ...rows].join('\n');
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
