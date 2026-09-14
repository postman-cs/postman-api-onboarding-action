#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL, URLSearchParams } from 'node:url';
import { TextDecoder } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import process from 'node:process';

export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_INITIAL_POLL_MS = 5_000;
export const DEFAULT_MAX_POLL_MS = 30_000;
export const RELEASE_EVIDENCE_MAX_BYTES = 32 * 1024;
export const RESULT_ARCHIVE_MAX_BYTES = 256 * 1024;
export const REDACTED_TOKEN_MARKER = '[REDACTED]';

const E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
const E2E_WORKFLOW = 'e2e.yml';
const RELEASE_REPOSITORY = 'postman-cs/postman-api-onboarding-action';
const RELEASE_ACTION = 'postman-api-onboarding-action';
const COMPOSITE_REPOSITORY = 'postman-cs/postman-api-onboarding-action';
const INSIGHTS_REPOSITORY = 'postman-cs/postman-insights-onboarding-action';
const ACTION_REPOSITORIES = Object.freeze([
  COMPOSITE_REPOSITORY,
  'postman-cs/postman-repo-sync-action',
  INSIGHTS_REPOSITORY,
  'postman-cs/postman-bootstrap-action',
  'postman-cs/postman-resolve-service-token-action',
  'postman-cs/postman-smoke-flow-action'
]);
const PEER_REPOSITORIES = Object.freeze(
  ACTION_REPOSITORIES.filter((repository) => repository !== RELEASE_REPOSITORY)
);
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ACTION_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const PROVIDER_TAG = /^e2e-provider-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/;
const RUN_ID = /^[1-9]\d{0,19}$/;
const CORRELATION_ID = /^[A-Za-z0-9_.-]{1,200}$/;
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const TOP_LEVEL_RESULT_KEYS = Object.freeze([
  'manifestDigest',
  'outcome',
  'provider',
  'release',
  'run',
  'schemaVersion',
  'suite'
]);

export class ReleaseVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseVerificationError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new ReleaseVerificationError(code, message, details);
}

function plain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!plain(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function canonicalJsonStringify(value) {
  return `${JSON.stringify(sorted(value))}\n`;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function redactTokenOccurrences(text, token) {
  const source = text == null ? '' : String(text);
  return token ? source.split(token).join(REDACTED_TOKEN_MARKER) : source;
}

function requireNonEmpty(value, name) {
  const normalized = value?.trim();
  if (!normalized) fail('blocked', `${name} is required`);
  return normalized;
}

function parsePositiveInteger(value, fallback, name) {
  if (value == null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail('blocked', `${name} must be a positive integer`);
  return parsed;
}

function strictUtf8(bytes, code, message) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) fail(code, message);
    return text;
  } catch (error) {
    if (error instanceof ReleaseVerificationError) throw error;
    return fail(code, message);
  }
}

function parseCanonicalJson(bytes, maxBytes, code, label) {
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0 || buffer.length > maxBytes) {
    fail(code, `${label} must contain 1..${maxBytes} bytes`);
  }
  const text = strictUtf8(buffer, code, `${label} must be valid UTF-8 without a BOM`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return fail(code, `${label} must be valid JSON`);
  }
  if (canonicalJsonStringify(value) !== text) {
    fail(code, `${label} must be canonical JSON with no duplicate or unordered keys`);
  }
  return value;
}

export function parsePeerTags(raw) {
  const text = requireNonEmpty(raw, 'E2E_GATE_PEER_TAGS');
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return fail('blocked', 'E2E_GATE_PEER_TAGS must be canonical JSON');
  }
  if (!exactKeys(value, [...PEER_REPOSITORIES].sort())) {
    fail('blocked', 'E2E_GATE_PEER_TAGS must contain the exact five-repository peer census');
  }
  for (const repository of PEER_REPOSITORIES) {
    if (!ACTION_TAG.test(value[repository])) {
      fail('blocked', `E2E_GATE_PEER_TAGS has a non-immutable tag for ${repository}`);
    }
  }
  if (canonicalJsonStringify(value).trimEnd() !== text) {
    fail('blocked', 'E2E_GATE_PEER_TAGS must use canonical key ordering');
  }
  return value;
}

export function buildCorrelationId({ repository, runId, runAttempt, refName, manifestDigest }) {
  if (!SHA256.test(manifestDigest)) fail('blocked', 'release manifest digest must be lowercase sha256');
  return `${repository}-${runId}-${runAttempt}-${refName}-${manifestDigest.slice(0, 16)}`.replace(
    /[^A-Za-z0-9_.-]+/g,
    '-'
  );
}

export function expectedRunTitle({ action, refName, correlationId }) {
  return `release monitor ${action}@${refName} ${correlationId}`;
}

export function buildDispatchInputs({
  action,
  refName,
  correlationId,
  suite,
  manifestBytes,
  manifestDigest
}) {
  if (
    action !== RELEASE_ACTION ||
    !ACTION_TAG.test(refName) ||
    !CORRELATION_ID.test(correlationId) ||
    suite !== 'full'
  ) {
    fail('blocked', 'release dispatch tuple is invalid');
  }
  if (!SHA256.test(manifestDigest)) fail('blocked', 'release manifest digest must be lowercase sha256');
  const bytes = Buffer.from(manifestBytes);
  if (bytes.length === 0 || bytes.length > RELEASE_EVIDENCE_MAX_BYTES) {
    fail('blocked', 'release manifest bytes are outside the provider limit');
  }
  return {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    release_manifest_base64: bytes.toString('base64'),
    release_manifest_sha256: manifestDigest,
    suite
  };
}

export function buildDispatchPayload(input) {
  if (!PROVIDER_TAG.test(input.providerTag)) fail('blocked', 'provider workflow ref must be immutable');
  return {
    ref: input.providerTag,
    return_run_details: true,
    inputs: buildDispatchInputs(input)
  };
}

export function buildDispatchUrl(targetRepository, workflow) {
  if (targetRepository !== E2E_REPOSITORY || workflow !== E2E_WORKFLOW) {
    fail('blocked', 'E2E target must be the fixed provider repository and workflow');
  }
  const [owner, repo] = targetRepository.split('/');
  return `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
}

function githubHeaders(token, accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION
  };
}

async function readBoundedResponse(response, maxBytes, code, operation) {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength != null && contentLength !== '') {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maxBytes) {
      fail(code, `${operation} response exceeds ${maxBytes} bytes`);
    }
  }
  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        fail(code, `${operation} response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const chunk = Buffer.from(await response.arrayBuffer());
    if (chunk.length > maxBytes) fail(code, `${operation} response exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  } else if (typeof response.text === 'function') {
    const chunk = Buffer.from(await response.text(), 'utf8');
    if (chunk.length > maxBytes) fail(code, `${operation} response exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function responseDetail(response, token) {
  try {
    const body = await readBoundedResponse(response, 16 * 1024, 'verifier_unavailable', 'GitHub error');
    return redactTokenOccurrences(
      strictUtf8(body, 'verifier_unavailable', 'GitHub error was not UTF-8'),
      token
    ).slice(0, 300);
  } catch {
    return '<response body unavailable>';
  }
}

async function githubJson({ url, token, fetchImpl, signal, operation }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token),
      redirect: 'error',
      signal
    });
  } catch (error) {
    const message = redactTokenOccurrences(error instanceof Error ? error.message : String(error), token);
    throw new ReleaseVerificationError('verifier_unavailable', `${operation} failed: ${message}`);
  }
  if (!response.ok) {
    const detail = await responseDetail(response, token);
    fail('verifier_unavailable', `${operation} failed with HTTP ${response.status}: ${detail}`);
  }
  const bytes = await readBoundedResponse(response, 1024 * 1024, 'verifier_unavailable', operation);
  try {
    return JSON.parse(strictUtf8(bytes, 'verifier_unavailable', `${operation} returned invalid UTF-8`));
  } catch (error) {
    if (error instanceof ReleaseVerificationError) throw error;
    return fail('verifier_unavailable', `${operation} returned invalid JSON`);
  }
}

async function githubBytes({
  url,
  token,
  fetchImpl,
  signal,
  maxBytes,
  operation,
  accept,
  redirect = 'error'
}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: githubHeaders(token, accept),
      redirect,
      signal
    });
  } catch (error) {
    const message = redactTokenOccurrences(error instanceof Error ? error.message : String(error), token);
    throw new ReleaseVerificationError('verifier_unavailable', `${operation} failed: ${message}`);
  }
  if (!response.ok) {
    const detail = await responseDetail(response, token);
    fail('verifier_unavailable', `${operation} failed with HTTP ${response.status}: ${detail}`);
  }
  return readBoundedResponse(response, maxBytes, 'verifier_unavailable', operation);
}

function repositoryApiPath(repository) {
  const [owner, repo] = repository.split('/');
  if (!PATH_SEGMENT.test(owner ?? '') || !PATH_SEGMENT.test(repo ?? '')) {
    fail('blocked', `invalid fixed repository ${repository}`);
  }
  return `repos/${owner}/${repo}`;
}

export async function resolveImmutableTagCommit({
  repository,
  tag,
  providerSourceDigest,
  token,
  fetchImpl,
  signal
}) {
  const expectedPattern = repository === E2E_REPOSITORY ? PROVIDER_TAG : ACTION_TAG;
  if (!ACTION_REPOSITORIES.includes(repository) && repository !== E2E_REPOSITORY) {
    fail('blocked', `repository is outside the release closure: ${repository}`);
  }
  if (!expectedPattern.test(tag)) fail('blocked', `tag is not immutable for ${repository}`);
  if (repository === E2E_REPOSITORY && !SHA256.test(providerSourceDigest ?? '')) {
    fail('blocked', 'pinned provider source-manifest digest is invalid');
  }
  const expectedRef = `refs/tags/${tag}`;
  const ref = await githubJson({
    url: `https://api.github.com/${repositoryApiPath(repository)}/git/ref/tags/${encodeURIComponent(tag)}`,
    token,
    fetchImpl,
    signal,
    operation: `${repository}@${tag} ref lookup`
  });
  if (
    ref?.ref !== expectedRef ||
    !plain(ref.object) ||
    !SHA.test(String(ref.object.sha ?? '')) ||
    (ref.object.type !== 'tag' && ref.object.type !== 'commit')
  ) {
    fail('verifier_unavailable', `${repository}@${tag} did not resolve to a valid Git ref`);
  }
  if (repository === E2E_REPOSITORY && ref.object.type !== 'tag') {
    fail('correlation_mismatch', 'immutable provider tag must be an annotated tag');
  }
  let object = ref.object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth += 1) {
    const annotated = await githubJson({
      url: `https://api.github.com/${repositoryApiPath(repository)}/git/tags/${object.sha}`,
      token,
      fetchImpl,
      signal,
      operation: `${repository}@${tag} annotated tag lookup`
    });
    if (
      (depth === 0 && annotated?.tag !== tag) ||
      !plain(annotated?.object) ||
      !SHA.test(String(annotated.object.sha ?? '')) ||
      (annotated.object.type !== 'tag' && annotated.object.type !== 'commit')
    ) {
      fail('verifier_unavailable', `${repository}@${tag} annotated tag is invalid`);
    }
    if (
      repository === E2E_REPOSITORY &&
      depth === 0 &&
      annotated.message !==
        `E2E provider ${tag}\n\ne2e-provider-source-manifest-sha256:${providerSourceDigest}`
    ) {
      fail('correlation_mismatch', 'immutable provider annotation digest does not match its pin');
    }
    object = annotated.object;
  }
  if (object.type !== 'commit' || !SHA.test(object.sha)) {
    fail('verifier_unavailable', `${repository}@${tag} tag chain did not terminate in a commit`);
  }
  return object.sha;
}

export async function digestRepositoryFile({
  repository,
  commit,
  file,
  token,
  fetchImpl,
  signal
}) {
  if (
    !ACTION_REPOSITORIES.includes(repository) ||
    !SHA.test(commit) ||
    !['action.yml', 'dist/cli.cjs'].includes(file)
  ) {
    fail('blocked', 'invalid release-closure file request');
  }
  const encodedPath = file.split('/').map(encodeURIComponent).join('/');
  const bytes = await githubBytes({
    url: `https://api.github.com/${repositoryApiPath(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(commit)}`,
    token,
    fetchImpl,
    signal,
    maxBytes: file === 'action.yml' ? 2 * 1024 * 1024 : 64 * 1024 * 1024,
    operation: `${repository}@${commit}:${file} read`,
    accept: 'application/vnd.github.raw+json'
  });
  return sha256(bytes);
}

export async function buildReleaseEvidenceManifest(config, dependencies = {}) {
  if (
    config.repository !== RELEASE_REPOSITORY ||
    config.action !== RELEASE_ACTION ||
    config.suite !== 'full' ||
    !ACTION_TAG.test(config.refName) ||
    !SHA.test(config.releaseCommit) ||
    !SHA256.test(config.sourceDigest) ||
    !PROVIDER_TAG.test(config.providerTag) ||
    !SHA.test(config.providerCommit) ||
    !SHA256.test(config.providerSourceDigest)
  ) {
    fail('blocked', 'release evidence configuration is invalid');
  }
  const resolveTag = dependencies.resolveTagCommit ?? resolveImmutableTagCommit;
  const digestFile = dependencies.digestRepositoryFile ?? digestRepositoryFile;
  const request = (extra) => ({
    ...extra,
    token: config.token,
    fetchImpl: dependencies.fetchImpl ?? globalThis.fetch,
    signal: dependencies.abortSignal ?? globalThis.AbortSignal.timeout(config.dispatchTimeoutMs)
  });
  const actualProviderCommit = await resolveTag(
    request({
      repository: E2E_REPOSITORY,
      tag: config.providerTag,
      providerSourceDigest: config.providerSourceDigest
    })
  );
  if (actualProviderCommit !== config.providerCommit) {
    fail('correlation_mismatch', 'immutable provider tag does not resolve to the pinned provider commit');
  }
  const actions = {};
  for (const repository of ACTION_REPOSITORIES) {
    const tag = repository === RELEASE_REPOSITORY ? config.refName : config.peerTags[repository];
    const commit = await resolveTag(request({ repository, tag }));
    if (repository === RELEASE_REPOSITORY && commit !== config.releaseCommit) {
      fail('correlation_mismatch', 'release tag does not resolve to the release workflow commit');
    }
    const digestKind =
      repository === COMPOSITE_REPOSITORY || repository === INSIGHTS_REPOSITORY
        ? 'action-definition-sha256'
        : 'cli-bundle-sha256';
    const digest = await digestFile(
      request({
        repository,
        commit,
        file: digestKind === 'action-definition-sha256' ? 'action.yml' : 'dist/cli.cjs'
      })
    );
    if (!SHA256.test(digest)) fail('verifier_unavailable', `invalid digest for ${repository}`);
    actions[repository] = {
      commit,
      digest,
      digestKind,
      role: repository === COMPOSITE_REPOSITORY ? 'composite' : 'peer',
      tag
    };
  }
  const manifest = {
    actions,
    provider: {
      commit: config.providerCommit,
      repository: E2E_REPOSITORY,
      tag: config.providerTag
    },
    release: {
      artifactDigest: config.sourceDigest,
      commit: config.releaseCommit,
      kind: 'composite',
      repository: RELEASE_REPOSITORY,
      tag: config.refName
    },
    schemaVersion: 1,
    suite: 'full'
  };
  const bytes = Buffer.from(canonicalJsonStringify(manifest), 'utf8');
  if (bytes.length > RELEASE_EVIDENCE_MAX_BYTES) {
    fail('blocked', 'release evidence manifest exceeds provider limit');
  }
  return { bytes, digest: sha256(bytes), manifest };
}

export function parseDispatchRunDetails(status, text) {
  const bodyText = String(text ?? '').trim();
  if (status === 204 && bodyText === '') return null;
  if (!bodyText) return null;
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return fail('dispatch_error', 'workflow dispatch returned invalid JSON');
  }
  const id = body?.workflow_run_id;
  const runUrl = body?.run_url;
  const htmlUrl = body?.html_url;
  if ((typeof id !== 'number' && typeof id !== 'string') || !RUN_ID.test(String(id))) {
    fail('dispatch_error', 'workflow dispatch response omitted a valid workflow_run_id');
  }
  if (
    (runUrl !== undefined && typeof runUrl !== 'string') ||
    (htmlUrl !== undefined && typeof htmlUrl !== 'string')
  ) {
    fail('dispatch_error', 'workflow dispatch response has invalid URLs');
  }
  return {
    workflowRunId: String(id),
    runApiUrl: typeof runUrl === 'string' && runUrl ? runUrl : undefined,
    runUrl: typeof htmlUrl === 'string' && htmlUrl ? htmlUrl : undefined
  };
}

function runCreatedAt(run) {
  const parsed = Date.parse(String(run?.created_at ?? ''));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function workflowPathMatches(path, workflow, providerTag) {
  if (typeof path !== 'string') return false;
  const [base, ref, ...extra] = path.split('@');
  if (extra.length > 0 || (base !== `.github/workflows/${workflow}` && base !== workflow)) return false;
  return ref === undefined || ref === `refs/tags/${providerTag}`;
}

export function validateRunIdentity(run, expected) {
  if (!plain(run)) fail('correlation_mismatch', 'workflow run payload is missing');
  const mismatches = [];
  if (!RUN_ID.test(String(run.id ?? '')) || String(run.id ?? '') !== String(expected.runId ?? run.id ?? '')) {
    mismatches.push('run id');
  }
  if (run.event !== 'workflow_dispatch') mismatches.push('event');
  if (run.head_branch !== expected.providerTag) mismatches.push('provider tag ref');
  if (run.head_sha !== expected.providerCommit) mismatches.push('provider commit');
  if (run.repository?.full_name !== expected.targetRepository) mismatches.push('repository');
  if (run.display_title !== expected.runTitle) mismatches.push('action/ref/correlation title');
  if (!workflowPathMatches(run.path, expected.workflow, expected.providerTag)) mismatches.push('workflow path');
  if (!Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) !== expected.runAttempt) {
    mismatches.push('run attempt');
  }
  const createdAt = runCreatedAt(run);
  if (!Number.isFinite(createdAt) || createdAt < expected.notBeforeMs) mismatches.push('created_at');
  if (mismatches.length > 0) {
    fail(
      'correlation_mismatch',
      `downstream run correlation mismatch: ${mismatches.join(', ')}`,
      { runId: run.id == null ? undefined : String(run.id) }
    );
  }
  return run;
}

export function electCorrelatedRun(runs, expected) {
  if (!Array.isArray(runs)) fail('verifier_unavailable', 'workflow run lookup omitted workflow_runs');
  const matches = runs
    .filter((run) => {
      try {
        validateRunIdentity(run, expected);
        return true;
      } catch (error) {
        if (error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch') return false;
        throw error;
      }
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  if (matches.length > 1) {
    fail('correlation_mismatch', `multiple downstream runs matched exact correlation ${expected.correlationId}`);
  }
  return matches[0] ?? null;
}

export function classifyTerminalRun(run) {
  if (run?.status !== 'completed') {
    if (PENDING_STATUSES.has(String(run?.status ?? ''))) return { terminal: false };
    fail(
      'blocked',
      `downstream verifier returned unsupported status ${String(run?.status ?? '<missing>')}`,
      { runId: run?.id == null ? undefined : String(run.id) }
    );
  }
  const conclusion = String(run.conclusion ?? '');
  if (['success', 'failure', 'cancelled', 'timed_out'].includes(conclusion)) {
    return { terminal: true, outcome: conclusion };
  }
  return { terminal: true, outcome: 'blocked' };
}

export function computeBackoffMs(attempt, initialMs, maxMs) {
  return Math.min(initialMs * 2 ** Math.max(0, attempt), maxMs);
}

export function resolveConfig(env = process.env) {
  const token = requireNonEmpty(env.E2E_DISPATCH_TOKEN, 'E2E_DISPATCH_TOKEN');
  if ((env.E2E_GATE_MODE?.trim() || 'enforce') !== 'enforce') {
    fail('blocked', 'E2E release verification is fail-closed and supports only enforce mode');
  }
  const repository = requireNonEmpty(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY');
  const refName = requireNonEmpty(env.E2E_GATE_REF || env.GITHUB_REF_NAME, 'E2E_GATE_REF');
  const sourceDigest = requireNonEmpty(env.E2E_GATE_SOURCE_DIGEST, 'E2E_GATE_SOURCE_DIGEST');
  const releaseCommit = requireNonEmpty(
    env.E2E_GATE_RELEASE_COMMIT || env.GITHUB_SHA,
    'E2E_GATE_RELEASE_COMMIT'
  );
  const action = env.E2E_GATE_ACTION?.trim() || repository.split('/').at(-1);
  const providerTag = requireNonEmpty(env.E2E_GATE_PROVIDER_TAG, 'E2E_GATE_PROVIDER_TAG');
  const providerCommit = requireNonEmpty(env.E2E_GATE_PROVIDER_COMMIT, 'E2E_GATE_PROVIDER_COMMIT');
  const providerSourceDigest = requireNonEmpty(
    env.E2E_GATE_PROVIDER_SOURCE_DIGEST,
    'E2E_GATE_PROVIDER_SOURCE_DIGEST'
  );
  const suite = env.E2E_GATE_SUITE?.trim() || 'full';
  if (env.E2E_GATE_REPOSITORY !== undefined || env.E2E_GATE_WORKFLOW !== undefined) {
    fail('blocked', 'fixed provider repository and workflow do not accept environment overrides');
  }
  const targetRepository = E2E_REPOSITORY;
  const workflow = E2E_WORKFLOW;
  const requestedCorrelationId = env.E2E_GATE_CORRELATION_ID?.trim() || '';
  const runId = requireNonEmpty(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID');
  const runAttempt = requireNonEmpty(env.GITHUB_RUN_ATTEMPT, 'GITHUB_RUN_ATTEMPT');
  buildDispatchUrl(targetRepository, workflow);
  if (
    repository !== RELEASE_REPOSITORY ||
    action !== RELEASE_ACTION ||
    suite !== 'full' ||
    !ACTION_TAG.test(refName) ||
    !SHA256.test(sourceDigest) ||
    !SHA.test(releaseCommit) ||
    !PROVIDER_TAG.test(providerTag) ||
    !SHA.test(providerCommit) ||
    !SHA256.test(providerSourceDigest) ||
    (requestedCorrelationId !== '' && !CORRELATION_ID.test(requestedCorrelationId)) ||
    !RUN_ID.test(runId) ||
    !RUN_ID.test(runAttempt) ||
    !Number.isSafeInteger(Number(runAttempt))
  ) {
    fail('blocked', 'release/provider identity inputs are invalid');
  }
  return {
    token,
    repository,
    refName,
    sourceDigest,
    releaseCommit,
    action,
    targetRepository,
    workflow,
    providerTag,
    providerCommit,
    providerSourceDigest,
    peerTags: parsePeerTags(env.E2E_GATE_PEER_TAGS),
    suite,
    requestedCorrelationId,
    runId,
    runAttempt,
    dispatchTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_DISPATCH_TIMEOUT_MS,
      DEFAULT_DISPATCH_TIMEOUT_MS,
      'E2E_GATE_DISPATCH_TIMEOUT_MS'
    ),
    lookupTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_LOOKUP_TIMEOUT_MS,
      DEFAULT_LOOKUP_TIMEOUT_MS,
      'E2E_GATE_LOOKUP_TIMEOUT_MS'
    ),
    verificationTimeoutMs: parsePositiveInteger(
      env.E2E_GATE_VERIFICATION_TIMEOUT_MS,
      DEFAULT_VERIFICATION_TIMEOUT_MS,
      'E2E_GATE_VERIFICATION_TIMEOUT_MS'
    ),
    initialPollMs: parsePositiveInteger(
      env.E2E_GATE_INITIAL_POLL_MS,
      DEFAULT_INITIAL_POLL_MS,
      'E2E_GATE_INITIAL_POLL_MS'
    ),
    maxPollMs: parsePositiveInteger(
      env.E2E_GATE_MAX_POLL_MS,
      DEFAULT_MAX_POLL_MS,
      'E2E_GATE_MAX_POLL_MS'
    )
  };
}

async function dispatchWorkflow(config, evidence, fetchImpl, startedAtMs) {
  const url = buildDispatchUrl(config.targetRepository, config.workflow);
  const payload = buildDispatchPayload({
    providerTag: config.providerTag,
    action: config.action,
    refName: config.refName,
    correlationId: config.correlationId,
    suite: config.suite,
    manifestBytes: evidence.bytes,
    manifestDigest: evidence.digest
  });
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...githubHeaders(config.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(config.dispatchTimeoutMs)
    });
  } catch (error) {
    const message = redactTokenOccurrences(
      error instanceof Error ? error.message : String(error),
      config.token
    );
    throw new ReleaseVerificationError('dispatch_error', `workflow dispatch failed: ${message}`);
  }
  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403 ? 'dispatch_auth_error' : 'dispatch_error';
    const detail = await responseDetail(response, config.token);
    fail(code, `workflow dispatch failed with HTTP ${response.status}: ${detail}`);
  }
  const text = strictUtf8(
    await readBoundedResponse(response, 1024 * 1024, 'dispatch_error', 'workflow dispatch'),
    'dispatch_error',
    'workflow dispatch returned invalid UTF-8'
  );
  return { details: parseDispatchRunDetails(response.status, text), payload, startedAtMs, url };
}

async function fetchExactRun(config, runId, dependencies) {
  const [owner, repo] = config.targetRepository.split('/');
  return githubJson({
    url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}`,
    token: config.token,
    fetchImpl: dependencies.fetchImpl,
    signal: globalThis.AbortSignal.timeout(config.dispatchTimeoutMs),
    operation: `exact workflow run ${runId} read`
  });
}

async function lookupCorrelatedRun(config, expected, dependencies) {
  const deadline = dependencies.now() + config.lookupTimeoutMs;
  let attempt = 0;
  while (dependencies.now() <= deadline) {
    const [owner, repo] = config.targetRepository.split('/');
    const query = new URLSearchParams({
      event: 'workflow_dispatch',
      created: `>=${new Date(expected.notBeforeMs).toISOString()}`,
      per_page: '100'
    });
    const body = await githubJson({
      url: `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(config.workflow)}/runs?${query}`,
      token: config.token,
      fetchImpl: dependencies.fetchImpl,
      signal: globalThis.AbortSignal.timeout(config.dispatchTimeoutMs),
      operation: 'correlated workflow run lookup'
    });
    const run = electCorrelatedRun(body?.workflow_runs, expected);
    if (run) return run;
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) break;
    await dependencies.sleep(Math.min(delay, remaining));
  }
  fail(
    'verifier_unavailable',
    `no downstream run matched exact correlation ${config.correlationId} before lookup timeout`
  );
}

export async function waitForRunIdentity({ config, runId, expected, fetchRun, now, sleep }) {
  const deadline = now() + config.lookupTimeoutMs;
  let attempt = 0;
  let lastHydrationMismatch;
  while (now() <= deadline) {
    try {
      return validateRunIdentity(await fetchRun(runId), { ...expected, runId });
    } catch (error) {
      const hydrating =
        error instanceof ReleaseVerificationError &&
        error.code === 'correlation_mismatch' &&
        /(?:action\/ref\/correlation title|provider tag ref|run attempt)/.test(error.message);
      if (!hydrating) throw error;
      lastHydrationMismatch = error;
    }
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
  }
  throw (
    lastHydrationMismatch ??
    new ReleaseVerificationError(
      'correlation_mismatch',
      `downstream run ${runId} identity did not hydrate before lookup timeout`,
      { runId: String(runId) }
    )
  );
}

export async function waitForTerminalRun({ config, runId, expected, fetchRun, now, sleep }) {
  const deadline = now() + config.verificationTimeoutMs;
  let attempt = 0;
  while (now() <= deadline) {
    const run = validateRunIdentity(await fetchRun(runId), { ...expected, runId });
    const classified = classifyTerminalRun(run);
    if (classified.terminal) {
      if (classified.outcome === 'success') return run;
      fail(classified.outcome, `downstream verifier ${runId} concluded ${classified.outcome}`, {
        runId: String(runId),
        runUrl: run.html_url
      });
    }
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
  }
  fail('verification_timeout', `downstream verifier ${runId} did not complete before timeout`, {
    runId: String(runId)
  });
}

function assertArtifactIdentity(artifact, expected) {
  return (
    plain(artifact) &&
    String(artifact.name ?? '') === expected.name &&
    artifact.expired === false &&
    RUN_ID.test(String(artifact.id ?? '')) &&
    Number.isSafeInteger(artifact.size_in_bytes) &&
    artifact.size_in_bytes > 0 &&
    artifact.size_in_bytes <= RESULT_ARCHIVE_MAX_BYTES &&
    String(artifact.workflow_run?.id ?? '') === expected.runId &&
    artifact.workflow_run?.head_sha === expected.providerCommit &&
    artifact.workflow_run?.head_branch === expected.providerTag
  );
}

async function lookupTerminalArtifact(config, expected, dependencies) {
  const deadline = dependencies.now() + config.lookupTimeoutMs;
  let attempt = 0;
  while (dependencies.now() <= deadline) {
    const [owner, repo] = config.targetRepository.split('/');
    const body = await githubJson({
      url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${expected.runId}/artifacts?per_page=100`,
      token: config.token,
      fetchImpl: dependencies.fetchImpl,
      signal: globalThis.AbortSignal.timeout(config.dispatchTimeoutMs),
      operation: `terminal result artifact lookup for run ${expected.runId}`
    });
    if (
      !Array.isArray(body?.artifacts) ||
      !Number.isSafeInteger(body?.total_count) ||
      body.total_count !== body.artifacts.length ||
      body.total_count > 100
    ) {
      fail('verifier_unavailable', 'terminal artifact response was incomplete or invalid');
    }
    const named = body.artifacts.filter((artifact) => artifact?.name === expected.name);
    if (named.length > 1) fail('correlation_mismatch', 'multiple exact terminal result artifacts were returned');
    if (named.length === 1) {
      if (!assertArtifactIdentity(named[0], expected)) {
        fail('correlation_mismatch', 'terminal result artifact identity is invalid');
      }
      return named[0];
    }
    const delay = computeBackoffMs(attempt, config.initialPollMs, config.maxPollMs);
    attempt += 1;
    const remaining = deadline - dependencies.now();
    if (remaining <= 0) break;
    await dependencies.sleep(Math.min(delay, remaining));
  }
  fail('verifier_unavailable', 'exact terminal result artifact was not available before timeout');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function parseSingleFileZip(archive, expectedName) {
  const bytes = Buffer.from(archive);
  if (
    bytes.length < 22 ||
    bytes.length > RESULT_ARCHIVE_MAX_BYTES ||
    !PATH_SEGMENT.test(expectedName)
  ) {
    fail('artifact_invalid', 'terminal result ZIP size or filename is invalid');
  }
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      const commentLength = bytes.readUInt16LE(offset + 20);
      if (offset + 22 + commentLength === bytes.length) {
        eocd = offset;
        break;
      }
    }
  }
  if (
    eocd < 0 ||
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== 1 ||
    bytes.readUInt16LE(eocd + 10) !== 1
  ) {
    fail('artifact_invalid', 'terminal result ZIP must contain exactly one non-ZIP64 entry');
  }
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    centralOffset + centralSize !== eocd ||
    centralOffset + 46 > eocd ||
    bytes.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    fail('artifact_invalid', 'terminal result ZIP central directory is invalid');
  }
  const madeBy = bytes.readUInt16LE(centralOffset + 4);
  const flags = bytes.readUInt16LE(centralOffset + 8);
  const method = bytes.readUInt16LE(centralOffset + 10);
  const expectedCrc = bytes.readUInt32LE(centralOffset + 16);
  const compressedSize = bytes.readUInt32LE(centralOffset + 20);
  const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
  const nameLength = bytes.readUInt16LE(centralOffset + 28);
  const extraLength = bytes.readUInt16LE(centralOffset + 30);
  const commentLength = bytes.readUInt16LE(centralOffset + 32);
  const diskStart = bytes.readUInt16LE(centralOffset + 34);
  const externalAttributes = bytes.readUInt32LE(centralOffset + 38);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);
  const centralEnd = centralOffset + 46 + nameLength + extraLength + commentLength;
  const name = bytes.subarray(centralOffset + 46, centralOffset + 46 + nameLength).toString('utf8');
  const unixMode = madeBy >>> 8 === 3 ? externalAttributes >>> 16 : 0;
  if (
    centralEnd !== eocd ||
    name !== expectedName ||
    diskStart !== 0 ||
    compressedSize === 0xffffffff ||
    uncompressedSize === 0xffffffff ||
    uncompressedSize === 0 ||
    uncompressedSize > RELEASE_EVIDENCE_MAX_BYTES ||
    ![0, 8].includes(method) ||
    (flags & ~0x080e) !== 0 ||
    (flags & 0x0001) !== 0 ||
    (unixMode !== 0 && (unixMode & 0o170000) !== 0o100000) ||
    localOffset + 30 > centralOffset ||
    bytes.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    fail('artifact_invalid', 'terminal result ZIP entry metadata is invalid');
  }
  const localFlags = bytes.readUInt16LE(localOffset + 6);
  const localMethod = bytes.readUInt16LE(localOffset + 8);
  const localCrc = bytes.readUInt32LE(localOffset + 14);
  const localCompressedSize = bytes.readUInt32LE(localOffset + 18);
  const localUncompressedSize = bytes.readUInt32LE(localOffset + 22);
  const localNameLength = bytes.readUInt16LE(localOffset + 26);
  const localExtraLength = bytes.readUInt16LE(localOffset + 28);
  const localNameStart = localOffset + 30;
  const dataStart = localNameStart + localNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  const localName = bytes.subarray(localNameStart, localNameStart + localNameLength).toString('utf8');
  if (
    localFlags !== flags ||
    localMethod !== method ||
    localName !== expectedName ||
    dataEnd > centralOffset ||
    ((flags & 0x0008) === 0 &&
      (localCrc !== expectedCrc ||
        localCompressedSize !== compressedSize ||
        localUncompressedSize !== uncompressedSize))
  ) {
    fail('artifact_invalid', 'terminal result ZIP local entry is invalid');
  }
  const descriptor = bytes.subarray(dataEnd, centralOffset);
  if ((flags & 0x0008) !== 0) {
    const signed = descriptor.length === 16 && descriptor.readUInt32LE(0) === 0x08074b50;
    const base = signed ? 4 : 0;
    if (
      (!signed && descriptor.length !== 12) ||
      descriptor.readUInt32LE(base) !== expectedCrc ||
      descriptor.readUInt32LE(base + 4) !== compressedSize ||
      descriptor.readUInt32LE(base + 8) !== uncompressedSize
    ) {
      fail('artifact_invalid', 'terminal result ZIP data descriptor is invalid');
    }
  } else if (descriptor.length !== 0) {
    fail('artifact_invalid', 'terminal result ZIP has unexpected bytes before its central directory');
  }
  let result;
  try {
    result =
      method === 0
        ? Buffer.from(bytes.subarray(dataStart, dataEnd))
        : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
            maxOutputLength: RELEASE_EVIDENCE_MAX_BYTES + 1
          });
  } catch {
    return fail('artifact_invalid', 'terminal result ZIP decompression failed');
  }
  if (result.length !== uncompressedSize || crc32(result) !== expectedCrc) {
    fail('artifact_invalid', 'terminal result ZIP checksum or length is invalid');
  }
  return result;
}

export function validateReleaseEvidenceResult(bytes, expected) {
  const value = parseCanonicalJson(
    bytes,
    RELEASE_EVIDENCE_MAX_BYTES,
    'artifact_invalid',
    'terminal release result'
  );
  if (
    !exactKeys(value, TOP_LEVEL_RESULT_KEYS) ||
    value.schemaVersion !== 1 ||
    value.outcome !== 'success' ||
    value.manifestDigest !== expected.manifestDigest ||
    value.suite !== expected.manifest.suite ||
    !exactKeys(value.provider, ['commit', 'repository', 'tag']) ||
    !exactKeys(value.release, ['artifactDigest', 'commit', 'kind', 'repository', 'tag']) ||
    !exactKeys(value.run, ['attempt', 'id']) ||
    !RUN_ID.test(String(value.run.id ?? '')) ||
    !Number.isSafeInteger(value.run.attempt) ||
    value.run.attempt < 1 ||
    value.run.id !== expected.runId ||
    value.run.attempt !== expected.runAttempt ||
    canonicalJsonStringify(value.provider) !== canonicalJsonStringify(expected.manifest.provider) ||
    canonicalJsonStringify(value.release) !== canonicalJsonStringify(expected.manifest.release)
  ) {
    fail(
      'artifact_invalid',
      'terminal release result does not match the dispatched closed manifest and run'
    );
  }
  return value;
}

async function downloadAndValidateResult(config, evidence, terminal, dependencies) {
  const runId = String(terminal.id);
  const runAttempt = Number(terminal.run_attempt);
  const name = `e2e-release-result-${runId}-${runAttempt}`;
  const artifact = await lookupTerminalArtifact(
    config,
    {
      name,
      providerCommit: config.providerCommit,
      providerTag: config.providerTag,
      runId
    },
    dependencies
  );
  const [owner, repo] = config.targetRepository.split('/');
  const archive = await githubBytes({
    url: `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${artifact.id}/zip`,
    token: config.token,
    fetchImpl: dependencies.fetchImpl,
    signal: globalThis.AbortSignal.timeout(config.dispatchTimeoutMs),
    maxBytes: RESULT_ARCHIVE_MAX_BYTES,
    operation: `terminal result artifact ${artifact.id} download`,
    accept: 'application/vnd.github+json',
    redirect: 'follow'
  });
  const resultBytes = parseSingleFileZip(archive, 'e2e-release-result.json');
  return validateReleaseEvidenceResult(resultBytes, {
    manifest: evidence.manifest,
    manifestDigest: evidence.digest,
    runAttempt,
    runId
  });
}

export async function verifyCorrelatedRelease(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ??
    ((ms) => new Promise((resolve) => globalThis.setTimeout(resolve, ms)));
  const log = dependencies.log ?? globalThis.console.log.bind(globalThis.console);
  const evidence = dependencies.buildEvidence
    ? await dependencies.buildEvidence(config)
    : await buildReleaseEvidenceManifest(config, { ...dependencies, fetchImpl });
  if (
    !plain(evidence.manifest) ||
    !Buffer.isBuffer(evidence.bytes) ||
    !SHA256.test(evidence.digest) ||
    sha256(evidence.bytes) !== evidence.digest ||
    canonicalJsonStringify(evidence.manifest) !== evidence.bytes.toString('utf8')
  ) {
    fail('blocked', 'constructed release evidence is internally inconsistent');
  }
  const correlationId =
    config.requestedCorrelationId ||
    buildCorrelationId({
      repository: config.repository,
      runId: config.runId,
      runAttempt: config.runAttempt,
      refName: config.refName,
      manifestDigest: evidence.digest
    });
  const active = { ...config, correlationId };
  const startedAtMs = now();
  const notBeforeMs = startedAtMs - 2_000;
  log(
    `::notice::Dispatching immutable-provider E2E verifier action=${active.action} ref=${active.refName} provider=${active.providerTag}@${active.providerCommit} manifest=${evidence.digest} correlation=${correlationId}`
  );
  const dispatched = await dispatchWorkflow(active, evidence, fetchImpl, startedAtMs);
  const expected = {
    workflow: active.workflow,
    providerTag: active.providerTag,
    providerCommit: active.providerCommit,
    targetRepository: active.targetRepository,
    runTitle: expectedRunTitle(active),
    correlationId,
    notBeforeMs,
    runAttempt: 1
  };
  let initialRun;
  if (dispatched.details) {
    initialRun = await waitForRunIdentity({
      config: active,
      runId: dispatched.details.workflowRunId,
      expected,
      fetchRun: async (id) => fetchExactRun(active, id, { fetchImpl }),
      now,
      sleep
    });
  } else {
    initialRun = await lookupCorrelatedRun(active, expected, { fetchImpl, now, sleep });
  }
  const runId = String(initialRun.id);
  const terminal = await waitForTerminalRun({
    config: active,
    runId,
    expected,
    fetchRun: async (id) => fetchExactRun(active, id, { fetchImpl }),
    now,
    sleep
  });
  await downloadAndValidateResult(active, evidence, terminal, { fetchImpl, now, sleep });
  const runUrl = terminal.html_url ?? dispatched.details?.runUrl;
  log(`::notice::Exact closed release evidence succeeded: ${runUrl ?? runId}`);
  return {
    outcome: 'success',
    correlationId,
    manifestDigest: evidence.digest,
    providerCommit: active.providerCommit,
    providerTag: active.providerTag,
    workflowRunId: runId,
    runUrl
  };
}

function appendOutput(path, key, value) {
  if (!path) return;
  appendFileSync(path, `${key}=${String(value ?? '')}\n`, 'utf8');
}

function appendSummary(path, result) {
  if (!path) return;
  const lines = [
    '## Immutable-provider release verification',
    '',
    `- **Outcome:** \`${result.outcome}\``,
    `- **Manifest:** \`${result.manifestDigest ?? 'unavailable'}\``,
    `- **Provider:** \`${result.providerTag ?? 'unavailable'}@${result.providerCommit ?? 'unavailable'}\``,
    `- **Correlation:** \`${result.correlationId ?? 'unavailable'}\``,
    `- **Workflow run:** ${result.runUrl ?? result.workflowRunId ?? '_unavailable_'}`,
    ''
  ];
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

function writeResult(env, result) {
  appendOutput(env.GITHUB_OUTPUT, 'e2e_outcome', result.outcome);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_correlation_id', result.correlationId);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_manifest_sha256', result.manifestDigest);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_provider_commit', result.providerCommit);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_provider_tag', result.providerTag);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_workflow_run_id', result.workflowRunId);
  appendOutput(env.GITHUB_OUTPUT, 'e2e_run_url', result.runUrl);
  appendSummary(env.GITHUB_STEP_SUMMARY, result);
}

export async function runReleaseVerificationCli(env = process.env, dependencies = {}) {
  let config;
  try {
    config = resolveConfig(env);
    const result = await verifyCorrelatedRelease(config, dependencies);
    writeResult(env, result);
    return { exitCode: 0, result };
  } catch (error) {
    const classified =
      error instanceof ReleaseVerificationError
        ? error
        : new ReleaseVerificationError(
            'verifier_unavailable',
            error instanceof Error ? error.message : String(error)
          );
    const result = {
      outcome: classified.code,
      correlationId: config?.requestedCorrelationId,
      providerCommit: config?.providerCommit,
      providerTag: config?.providerTag,
      workflowRunId: classified.details?.runId,
      runUrl: classified.details?.runUrl
    };
    writeResult(env, result);
    const safeMessage = redactTokenOccurrences(classified.message, env.E2E_DISPATCH_TOKEN);
    (dependencies.error ?? globalThis.console.error)(
      `::error::Closed E2E verification outcome=${classified.code}: ${safeMessage}`
    );
    return { exitCode: 1, result };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) {
    globalThis.console.log(
      'Usage: node scripts/verify-e2e-release.mjs\n' +
        'Requires a pinned provider tag/commit, canonical five-peer tag map, release tag/commit/artifact digest, and GitHub run identity.'
    );
  } else {
    const execution = await runReleaseVerificationCli();
    process.exitCode = execution.exitCode;
  }
}
