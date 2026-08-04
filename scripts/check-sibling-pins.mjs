#!/usr/bin/env node
/* global console, fetch, process */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Siblings are pinned to reviewed immutable tags of the major recorded here.
// Majors diverge across the suite (smoke-flow shipped v3 while the other
// siblings remain on v2), so each expected major is committed beside its pin.
// Release eligibility must depend only on committed content, not on a mutable
// "latest tag" query that can change after the composite commit is reviewed.
export const REQUIRED_PINS = [
  { repo: 'postman-bootstrap-action', stepId: 'bootstrap', major: 2 },
  { repo: 'postman-repo-sync-action', stepId: 'repo_sync', major: 2 },
  { repo: 'postman-smoke-flow-action', stepId: 'smoke_flow', major: 3 },
  { repo: 'postman-insights-onboarding-action', stepId: 'insights_onboarding', major: 2 }
];

/** Source files asserted against the exact immutable tags in action.yml. */
export const SOURCE_CONTRACTS = {
  'postman-bootstrap-action': ['src/index.ts'],
  'postman-repo-sync-action': ['src/index.ts', 'src/lib/repo/branch-decision.ts']
};

export const COLLECTIONS_JSON_KEYS = ['baseline', 'contract', 'smoke'];
export const BRANCH_DECISION_REQUIRED = ['tier', 'strategy', 'identity', 'reason'];
export const BRANCH_DECISION_OPTIONAL = ['canonicalBranch', 'channel'];
export const REPO_SYNC_SUMMARY_KEYS = [
  'commitSha',
  'environmentCount',
  'environmentSyncStatus',
  'mockEnvironmentStatus',
  'mockEnvironmentUid',
  'mockAuthRequired',
  'mockUrl',
  'mockVisibility',
  'monitorId',
  'pushed',
  'resolvedCurrentRef',
  'workspaceLinkStatus'
];
export const REPO_SYNC_SUMMARY_GATED_KEYS = ['status', 'reason'];

/** Upper bound for git ls-remote and raw.githubusercontent.com fetches in main(). */
export const SIBLING_PIN_NETWORK_TIMEOUT_MS = 30_000;

/**
 * @param {string} repo
 * @param {string} tag
 * @param {string} filePath
 * @returns {string}
 */
export function pinnedRawFileUrl(repo, tag, filePath) {
  return `https://raw.githubusercontent.com/postman-cs/${repo}/${tag}/${filePath}`;
}

/**
 * @param {number} [timeoutMs]
 * @returns {{ encoding: 'utf8', timeout: number }}
 */
export function gitTagExistsExecOptions(timeoutMs = SIBLING_PIN_NETWORK_TIMEOUT_MS) {
  return { encoding: 'utf8', timeout: timeoutMs };
}

/**
 * @param {number} [timeoutMs]
 * @returns {{ signal: AbortSignal }}
 */
export function pinnedFileFetchInit(timeoutMs = SIBLING_PIN_NETWORK_TIMEOUT_MS) {
  return { signal: globalThis.AbortSignal.timeout(timeoutMs) };
}

/**
 * @param {string} tag
 * @param {number} major
 * @returns {number[] | undefined}
 */
export function semverForMajor(tag, major) {
  const match = tag.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts[0] === major ? parts : undefined;
}

/**
 * @param {string} site
 * @param {string} text
 * @param {Array<{ step: string, output: string, site: string }>} edges
 * @param {Set<string>} seen
 */
function recordEdges(site, text, edges, seen) {
  for (const match of String(text ?? '').matchAll(/steps\.([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)/g)) {
    const key = `${match[1]}.${match[2]}@${site}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ step: match[1], output: match[2], site });
  }
}

/**
 * Every steps.<id>.outputs.<name> reference in the composite with its consuming site.
 * @param {{ outputs?: Record<string, { value?: string }>, runs?: { steps?: Array<{ id?: string, if?: string, with?: Record<string, string>, env?: Record<string, string>, run?: string }> } }} manifest
 * @returns {Array<{ step: string, output: string, site: string }>}
 */
export function collectStepOutputEdges(manifest) {
  /** @type {Array<{ step: string, output: string, site: string }>} */
  const edges = [];
  const seen = new Set();
  for (const [name, output] of Object.entries(manifest.outputs ?? {})) {
    recordEdges(`outputs.${name}`, output?.value ?? '', edges, seen);
  }
  for (const step of manifest.runs?.steps ?? []) {
    const site = `step ${step.id ?? '(anonymous)'}`;
    recordEdges(`${site} if`, step.if ?? '', edges, seen);
    for (const [key, value] of Object.entries(step.with ?? {})) {
      recordEdges(`${site} with.${key}`, value, edges, seen);
    }
    for (const [key, value] of Object.entries(step.env ?? {})) {
      recordEdges(`${site} env.${key}`, value, edges, seen);
    }
    recordEdges(`${site} run`, step.run ?? '', edges, seen);
  }
  return edges;
}

/**
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string}
 */
function diagLabel({ repo, tag, file }) {
  const base = `${repo}@${tag}`;
  return file ? `${base} ${file}` : base;
}

/**
 * @param {object} args
 * @param {string} args.stepId
 * @param {string} args.repo
 * @param {string} args.tag
 * @param {Iterable<string>} args.withKeys
 * @param {Iterable<string>} args.declaredInputs
 * @returns {string[]}
 */
export function validateForwardedWithKeys({ stepId, repo, tag, withKeys, declaredInputs }) {
  const declared = new Set(declaredInputs);
  /** @type {string[]} */
  const failures = [];
  for (const key of withKeys) {
    if (!declared.has(key)) {
      failures.push(
        `${stepId}: forwards with-key \`${key}\` but ${diagLabel({ repo, tag })} declares no such input`
      );
    }
  }
  return failures;
}

/**
 * @param {object} args
 * @param {Array<{ step: string, output: string, site: string }>} args.edges
 * @param {string} args.stepId
 * @param {string} args.repo
 * @param {string} args.tag
 * @param {Iterable<string>} args.declaredOutputs
 * @returns {string[]}
 */
export function validateReferencedOutputs({ edges, stepId, repo, tag, declaredOutputs }) {
  const declared = new Set(declaredOutputs);
  /** @type {string[]} */
  const failures = [];
  for (const edge of edges) {
    if (edge.step !== stepId) continue;
    if (!declared.has(edge.output)) {
      failures.push(
        `${edge.site} references ${edge.step}.outputs.${edge.output}, not declared by ${diagLabel({
          repo,
          tag,
          file: 'action.yml'
        })}`
      );
    }
  }
  return failures;
}

/**
 * @param {string} source
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string[]}
 */
export function validateCollectionsJsonShape(source, diag) {
  const label = diagLabel({ file: 'src/index.ts', ...diag });
  const sites = [...source.matchAll(/'collections-json'\]?\s*[:=]\s*JSON\.stringify\(\{([^}]*)\}/g)];
  if (sites.length < 3) {
    return [`${label}: expected >=3 collections-json serialization sites, found ${sites.length}`];
  }
  /** @type {string[]} */
  const failures = [];
  const expected = [...COLLECTIONS_JSON_KEYS].sort().join(',');
  for (const [index, site] of sites.entries()) {
    const keys = [...site[1].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((match) => match[1]).sort();
    if (keys.join(',') !== expected) {
      failures.push(
        `${label}: collections-json site ${index + 1} emits {${keys.join(', ')}} instead of {${expected.replace(/,/g, ', ')}}`
      );
    }
  }
  return failures;
}

/**
 * @param {string} source
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string[]}
 */
export function validateBranchDecisionInterface(source, diag) {
  const label = diagLabel({ file: 'src/lib/repo/branch-decision.ts', ...diag });
  const block = source.match(/export interface BranchDecision \{([\s\S]*?)\n\}/);
  if (!block) {
    return [`${label}: BranchDecision interface not found`];
  }
  const declared = [...block[1].matchAll(/^\s*([A-Za-z0-9_]+)\??:/gm)].map((match) => match[1]).sort();
  const expected = [...BRANCH_DECISION_REQUIRED, ...BRANCH_DECISION_OPTIONAL].sort();
  if (declared.join(',') !== expected.join(',')) {
    return [
      `${label}: BranchDecision declares {${declared.join(', ')}} instead of {${expected.join(', ')}}`
    ];
  }
  return [];
}

/**
 * @param {string} source
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string[]}
 */
export function validateEnvironmentUidsEmit(source, diag) {
  const label = diagLabel({ file: 'src/index.ts', ...diag });
  /** @type {string[]} */
  const failures = [];
  if (!source.includes("setOutput('environment-uids-json', JSON.stringify(envUids))")) {
    failures.push(`${label}: missing environment-uids-json setOutput(JSON.stringify(envUids)) emit`);
  }
  if (!source.includes("parseJsonMap(getInput('environment-uids-json', env) || '{}')")) {
    failures.push(`${label}: missing environment-uids-json parseJsonMap consumer`);
  }
  return failures;
}

/**
 * @param {string} source
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string[]}
 */
export function validateRepoSyncSummaryKeys(source, diag) {
  const label = diagLabel({ file: 'src/index.ts', ...diag });
  const summary = source.match(/function createRepoSummary\([\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\);/);
  if (!summary) {
    return [`${label}: createRepoSummary JSON.stringify shape not found`];
  }
  const keys = [...summary[1].matchAll(/^\s*([A-Za-z0-9_]+)\s*(?:[,:]|$)/gm)].map((match) => match[1]).sort();
  const expected = [...REPO_SYNC_SUMMARY_KEYS].sort();
  if (keys.join(',') !== expected.join(',')) {
    return [
      `${label}: createRepoSummary emits {${keys.join(', ')}} instead of {${expected.join(', ')}}`
    ];
  }
  return [];
}

/**
 * @param {string} source
 * @param {{ repo: string, tag: string, file?: string }} diag
 * @returns {string[]}
 */
export function validateGatedSkipSummaryKeys(source, diag) {
  const label = diagLabel({ file: 'src/index.ts', ...diag });
  const gated = source.match(/outputs\['repo-sync-summary-json'\] = JSON\.stringify\(\{([\s\S]*?)\}\);/);
  if (!gated) {
    return [`${label}: gated-skip repo-sync-summary-json shape not found`];
  }
  /** @type {string[]} */
  const failures = [];
  if (!gated[1].includes("status: 'skipped-branch-gate'")) {
    failures.push(`${label}: gated-skip summary missing status: 'skipped-branch-gate'`);
  }
  if (!gated[1].includes('reason: decision.reason')) {
    failures.push(`${label}: gated-skip summary missing reason: decision.reason`);
  }
  const keys = [...gated[1].matchAll(/([A-Za-z0-9_]+)\s*:/g)].map((match) => match[1]).sort();
  const expected = [...REPO_SYNC_SUMMARY_GATED_KEYS].sort();
  if (keys.join(',') !== expected.join(',')) {
    failures.push(
      `${label}: gated-skip summary emits {${keys.join(', ')}} instead of {${expected.join(', ')}}`
    );
  }
  return failures;
}

/**
 * Validate golden source shapes for Bootstrap and Repo Sync pinned tags.
 * @param {object} args
 * @param {string} args.repo
 * @param {string} args.tag
 * @param {Record<string, string>} args.sources
 * @returns {string[]}
 */
export function validatePinnedSourceShapes({ repo, tag, sources }) {
  const diag = { repo, tag };
  if (repo === 'postman-bootstrap-action') {
    const source = sources['src/index.ts'];
    if (typeof source !== 'string') {
      return [`${diagLabel({ ...diag, file: 'src/index.ts' })}: source content was not supplied`];
    }
    return validateCollectionsJsonShape(source, diag);
  }
  if (repo === 'postman-repo-sync-action') {
    /** @type {string[]} */
    const failures = [];
    const index = sources['src/index.ts'];
    const branchDecision = sources['src/lib/repo/branch-decision.ts'];
    if (typeof index !== 'string') {
      failures.push(`${diagLabel({ ...diag, file: 'src/index.ts' })}: source content was not supplied`);
    } else {
      failures.push(
        ...validateEnvironmentUidsEmit(index, diag),
        ...validateRepoSyncSummaryKeys(index, diag),
        ...validateGatedSkipSummaryKeys(index, diag)
      );
    }
    if (typeof branchDecision !== 'string') {
      failures.push(
        `${diagLabel({ ...diag, file: 'src/lib/repo/branch-decision.ts' })}: source content was not supplied`
      );
    } else {
      failures.push(...validateBranchDecisionInterface(branchDecision, diag));
    }
    return failures;
  }
  return [];
}

/**
 * Pure contract validation over already-fetched sibling content.
 *
 * @param {object} args
 * @param {string} args.compositeYmlText
 * @param {Record<string, {
 *   tag?: string,
 *   actionYmlText?: string,
 *   sources?: Record<string, string>,
 *   tagExists?: boolean,
 *   fetchError?: string
 * }>} args.siblings keyed by repo name
 * @returns {string[]}
 */
export function validateSiblingPinContracts({ compositeYmlText, siblings }) {
  const manifest = parse(compositeYmlText);
  const edges = collectStepOutputEdges(manifest);
  /** @type {string[]} */
  const failures = [];

  for (const { repo, stepId, major } of REQUIRED_PINS) {
    const step = (manifest.runs?.steps ?? []).find((candidate) => candidate.id === stepId);
    const actual = step?.uses;
    const prefix = `postman-cs/${repo}@`;
    const tag =
      typeof actual === 'string' && actual.startsWith(prefix) ? actual.slice(prefix.length) : '';
    if (!semverForMajor(tag, major)) {
      failures.push(`${stepId}: expected an immutable v${major} tag, found ${actual || '<missing>'}`);
      continue;
    }

    const sibling = siblings[repo] ?? {};
    if (sibling.tagExists === false) {
      failures.push(`${stepId}: pinned tag ${tag} does not exist in postman-cs/${repo}`);
      continue;
    }
    if (typeof sibling.fetchError === 'string' && sibling.fetchError.length > 0) {
      failures.push(sibling.fetchError);
      continue;
    }
    if (typeof sibling.actionYmlText !== 'string') {
      failures.push(`${diagLabel({ repo, tag, file: 'action.yml' })}: action.yml content was not supplied`);
      continue;
    }

    const siblingManifest = parse(sibling.actionYmlText);
    failures.push(
      ...validateForwardedWithKeys({
        stepId,
        repo,
        tag,
        withKeys: Object.keys(step?.with ?? {}),
        declaredInputs: Object.keys(siblingManifest.inputs ?? {})
      }),
      ...validateReferencedOutputs({
        edges,
        stepId,
        repo,
        tag,
        declaredOutputs: Object.keys(siblingManifest.outputs ?? {})
      }),
      ...validatePinnedSourceShapes({
        repo,
        tag,
        sources: sibling.sources ?? {}
      })
    );
  }

  return failures;
}

/**
 * @param {string} repo
 * @param {string} tag
 * @returns {boolean}
 */
function tagExists(repo, tag) {
  const remote = `https://github.com/postman-cs/${repo}.git`;
  const output = execFileSync(
    'git',
    ['ls-remote', '--tags', remote, `refs/tags/${tag}`],
    gitTagExistsExecOptions()
  );
  return output.trim().length > 0;
}

/**
 * @param {string} repo
 * @param {string} tag
 * @param {string} filePath
 * @returns {Promise<string>}
 */
async function fetchPinnedFile(repo, tag, filePath) {
  const url = pinnedRawFileUrl(repo, tag, filePath);
  const response = await fetch(url, pinnedFileFetchInit());
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }
  return response.text();
}

async function main() {
  const compositeYmlText = readFileSync(path.join(repoRoot, 'action.yml'), 'utf8');
  const manifest = parse(compositeYmlText);
  /** @type {Record<string, {
   *   tag: string,
   *   actionYmlText?: string,
   *   sources?: Record<string, string>,
   *   tagExists?: boolean,
   *   fetchError?: string
   * }>} */
  const siblings = {};

  for (const { repo, stepId, major } of REQUIRED_PINS) {
    const step = (manifest.runs?.steps ?? []).find((candidate) => candidate.id === stepId);
    const actual = step?.uses;
    const prefix = `postman-cs/${repo}@`;
    const tag =
      typeof actual === 'string' && actual.startsWith(prefix) ? actual.slice(prefix.length) : '';
    // Leave malformed pins absent so validateSiblingPinContracts owns the diagnostic.
    if (!semverForMajor(tag, major)) continue;

    if (!tagExists(repo, tag)) {
      siblings[repo] = { tag, tagExists: false };
      continue;
    }

    try {
      const actionYmlText = await fetchPinnedFile(repo, tag, 'action.yml');
      /** @type {Record<string, string>} */
      const sources = {};
      for (const filePath of SOURCE_CONTRACTS[repo] ?? []) {
        sources[filePath] = await fetchPinnedFile(repo, tag, filePath);
      }
      siblings[repo] = { tag, actionYmlText, sources, tagExists: true };
    } catch (error) {
      siblings[repo] = {
        tag,
        tagExists: true,
        fetchError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  const failures = validateSiblingPinContracts({ compositeYmlText, siblings });

  if (failures.length > 0) {
    console.error('Composite sibling pins are invalid:');
    for (const failure of failures) {
      console.error('- ' + failure);
    }
    process.exit(1);
  }

  console.log(
    'Composite sibling pins are existing immutable tags of their recorded majors; every forwarded with-key and referenced producer output is declared; Bootstrap and Repo Sync golden payload shapes match the pinned sources.'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
