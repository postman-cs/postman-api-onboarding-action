#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL, URLSearchParams } from 'node:url';

export const GITHUB_API_VERSION = '2022-11-28';
export const DEFAULT_E2E_REPOSITORY = 'postman-cs/postman-actions-e2e';
export const DEFAULT_E2E_WORKFLOW = 'e2e.yml';
export const DEFAULT_E2E_WORKFLOW_REF = 'main';
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;
export const DEFAULT_LOOKUP_TIMEOUT_MS = 120_000;
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 45 * 60 * 1000;
export const DEFAULT_INITIAL_POLL_MS = 2_000;
export const DEFAULT_MAX_POLL_MS = 30_000;
export const SUPPORTED_SUITES = new Set(['smoke', 'full', 'branch-aware']);

const TERMINAL_OUTCOMES = new Map([
  ['success', 'success'],
  ['failure', 'failure'],
  ['cancelled', 'cancelled'],
  ['timed_out', 'timed_out']
]);
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export class ReleaseVerificationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ReleaseVerificationError';
    this.code = code;
    this.details = details;
  }
}

function requireEnv(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new ReleaseVerificationError('blocked', `Missing required environment variable ${name}`);
  return value;
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ReleaseVerificationError('blocked', `${name} must be a positive integer`);
  }
  return parsed;
}

function sanitize(value, fallback) {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96);
  return cleaned || fallback;
}

function redact(message, secrets = []) {
  let safe = String(message ?? '');
  for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join('[REDACTED]');
  return safe;
}

function apiHeaders(token) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION
  };
}

export function buildCorrelationId({ repository, runId, runAttempt, refName, sourceDigest }) {
  const repositoryName = repository.split('/').at(-1) ?? repository;
  return [
    sanitize(repositoryName, 'release'),
    sanitize(runId, 'run'),
    sanitize(runAttempt, 'attempt'),
    sanitize(refName, 'ref'),
    sourceDigest.slice(0, 16)
  ].join('-');
}

export function expectedRunTitle({ action, refName, correlationId }) {
  return `release monitor ${action}@${refName} ${correlationId}`;
}

export function buildDispatchInputs({
  action,
  refName,
  correlationId,
  suite,
  registryRevision,
  contractScenarios
}) {
  const inputs = {
    action,
    ref: refName,
    gate_correlation_id: correlationId,
    suite
  };
  if (registryRevision) inputs.registry_revision = registryRevision;
  if (contractScenarios) inputs.contract_scenarios = contractScenarios;
  return inputs;
}

export function buildDispatchPayload(config) {
  return {
    ref: config.workflowRef,
    return_run_details: true,
    inputs: buildDispatchInputs(config)
  };
}

export function parseDispatchRunDetails(status, body) {
  if (status === 204 || !body.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ReleaseVerificationError('dispatch_error', 'Verifier dispatch returned unreadable run details');
  }
  const workflowRunId = parsed.workflow_run_id ?? parsed.workflow_run?.id ?? parsed.run_id ?? parsed.id;
  if (workflowRunId === undefined || workflowRunId === null) {
    throw new ReleaseVerificationError('dispatch_error', 'Verifier dispatch response omitted workflow run ID');
  }
  return {
    workflowRunId: String(workflowRunId),
    runApiUrl: parsed.workflow_run?.url ?? parsed.run_url ?? parsed.url ?? null,
    runUrl: parsed.workflow_run?.html_url ?? parsed.html_url ?? null
  };
}

function workflowPathMatches(path, workflow) {
  if (typeof path !== 'string') return false;
  return path.split('@', 1)[0].endsWith(`/${workflow}`) || path.split('@', 1)[0] === workflow;
}

function runMatches(run, expected) {
  if (!run || typeof run !== 'object') return false;
  if (run.event !== 'workflow_dispatch') return false;
  if (run.head_branch !== expected.workflowRef) return false;
  if (run.display_title !== expected.runTitle) return false;
  if (!workflowPathMatches(run.path, expected.workflow)) return false;
  const createdAt = Date.parse(run.created_at ?? '');
  return Number.isFinite(createdAt) && createdAt >= expected.notBeforeMs;
}

export function electCorrelatedRun(runs, expected) {
  const matches = runs.filter((candidate) => runMatches(candidate, expected));
  if (matches.length > 1) {
    throw new ReleaseVerificationError(
      'correlation_mismatch',
      `Correlation ${expected.correlationId} matched multiple workflow runs`,
      { runIds: matches.map((run) => String(run.id)) }
    );
  }
  return matches[0] ?? null;
}

export function validateRunIdentity(run, expected) {
  const createdAt = Date.parse(run?.created_at ?? '');
  const mismatch = [];
  if (!run || typeof run !== 'object') mismatch.push('missing run');
  if (expected.runId && String(run?.id) !== String(expected.runId)) mismatch.push('run id');
  if (run?.event !== 'workflow_dispatch') mismatch.push('event');
  if (run?.head_branch !== expected.workflowRef) mismatch.push('workflow ref');
  if (run?.display_title !== expected.runTitle) mismatch.push('action/ref/correlation/digest');
  if (!workflowPathMatches(run?.path, expected.workflow)) mismatch.push('workflow path');
  if (!Number.isFinite(createdAt) || createdAt < expected.notBeforeMs) mismatch.push('dispatch time');
  if (mismatch.length > 0) {
    throw new ReleaseVerificationError(
      'correlation_mismatch',
      `Workflow run does not match exact release correlation: ${mismatch.join(', ')}`,
      { runId: run?.id ? String(run.id) : null, mismatch }
    );
  }
  return run;
}

export function classifyTerminalRun(run) {
  if (run.status !== 'completed') {
    if (PENDING_STATUSES.has(String(run.status ?? ''))) return { terminal: false };
    throw new ReleaseVerificationError('blocked', `Verifier returned unsupported status ${String(run.status ?? '<missing>')}`);
  }
  const conclusion = run.conclusion ?? 'unknown';
  return {
    terminal: true,
    outcome: TERMINAL_OUTCOMES.get(conclusion) ?? 'blocked'
  };
}

export function shouldFailRelease(mode, outcome) {
  return (mode ?? 'enforce') !== 'report-only' && outcome !== 'success';
}

export function assertCompositeUsesCapability(workflowText) {
  const hasActionInput = /inputs\.action\s*==\s*['"]postman-api-onboarding-action['"]/.test(workflowText);
  const hasCheckout = /repository:\s*postman-cs\/postman-api-onboarding-action\b/.test(workflowText);
  const hasUses = /uses:\s*(?:\.\/postman-api-onboarding-action|postman-cs\/postman-api-onboarding-action@\$\{\{\s*inputs\.ref\s*\}\})/.test(workflowText);
  const hasExactRef = /inputs\.action\s*==\s*['"]postman-api-onboarding-action['"]\s*&&\s*inputs\.ref/.test(workflowText);
  const hasSandboxGuard =
    workflowText.includes('POSTMAN_E2E_API_KEY_NON_ORG_MODE is required for composite smoke.') &&
    workflowText.includes("postman-team-id: '10490519'") &&
    workflowText.includes('repo-write-mode: none');
  const hasReporterDependency = /needs:\s*\[failure-injection, plan, monitor, composite-smoke\]/.test(workflowText);
  if (
    !hasActionInput ||
    (!hasCheckout && !hasUses) ||
    !hasUses ||
    !hasExactRef ||
    !hasSandboxGuard ||
    !hasReporterDependency
  ) {
    throw new ReleaseVerificationError(
      'blocked',
      'E2E_COMPOSITE_USES_UNAVAILABLE: verifier lacks exact-ref native composite execution, sandbox guards, or reporter evidence'
    );
  }
}

async function responseText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function fetchWithDeadline(fetchImpl, url, options, timeoutMs, code, secrets) {
  try {
    return await fetchImpl(url, { ...options, signal: globalThis.AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : error, secrets);
    throw new ReleaseVerificationError(code, `Request failed: ${message}`);
  }
}

async function fetchJson({ fetchImpl, url, token, timeoutMs, code, method = 'GET', body }) {
  const response = await fetchWithDeadline(
    fetchImpl,
    url,
    {
      method,
      headers: apiHeaders(token),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    },
    timeoutMs,
    code,
    [token]
  );
  const text = await responseText(response);
  if (!response.ok) {
    const failureCode =
      code !== 'blocked' && (response.status === 401 || response.status === 403)
        ? `${code.replace(/_error$/, '')}_auth_error`
        : code;
    throw new ReleaseVerificationError(
      failureCode,
      `GitHub API returned HTTP ${response.status}: ${redact(text.slice(0, 500), [token])}`,
      { status: response.status }
    );
  }
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseVerificationError(code, 'GitHub API returned unreadable JSON');
  }
}

async function assertCompositeCapability(config, fetchImpl) {
  const [owner, repo] = config.e2eRepository.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/.github/workflows/${config.e2eWorkflow}?ref=${encodeURIComponent(config.workflowRef)}`;
  const payload = await fetchJson({
    fetchImpl,
    url,
    token: config.token,
    timeoutMs: config.dispatchTimeoutMs,
    code: 'blocked'
  });
  if (typeof payload?.content !== 'string') {
    throw new ReleaseVerificationError('blocked', 'Unable to inspect E2E workflow capability');
  }
  const text = Buffer.from(payload.content, payload.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  assertCompositeUsesCapability(text);
}

async function dispatchWorkflow(config, fetchImpl) {
  const [owner, repo] = config.e2eRepository.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(config.e2eWorkflow)}/dispatches`;
  const response = await fetchWithDeadline(
    fetchImpl,
    url,
    { method: 'POST', headers: apiHeaders(config.token), body: JSON.stringify(buildDispatchPayload(config)) },
    config.dispatchTimeoutMs,
    'dispatch_error',
    [config.token]
  );
  const body = await responseText(response);
  if (!response.ok) {
    const code = response.status === 401 || response.status === 403 ? 'dispatch_auth_error' : 'dispatch_error';
    throw new ReleaseVerificationError(
      code,
      `Verifier dispatch returned HTTP ${response.status}: ${redact(body.slice(0, 500), [config.token])}`,
      { status: response.status }
    );
  }
  return parseDispatchRunDetails(response.status, body);
}

async function fetchRun(config, fetchImpl, runId) {
  const [owner, repo] = config.e2eRepository.split('/');
  return fetchJson({
    fetchImpl,
    url: `https://api.github.com/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}`,
    token: config.token,
    timeoutMs: config.dispatchTimeoutMs,
    code: 'blocked'
  });
}

async function listCandidateRuns(config, fetchImpl, createdDate) {
  const [owner, repo] = config.e2eRepository.split('/');
  const query = new URLSearchParams({
    branch: config.workflowRef,
    event: 'workflow_dispatch',
    created: `>=${createdDate}`,
    per_page: '100'
  });
  const payload = await fetchJson({
    fetchImpl,
    url: `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(config.e2eWorkflow)}/runs?${query}`,
    token: config.token,
    timeoutMs: config.dispatchTimeoutMs,
    code: 'blocked'
  });
  if (!Array.isArray(payload?.workflow_runs)) {
    throw new ReleaseVerificationError('blocked', 'Verifier run listing omitted workflow_runs');
  }
  return payload.workflow_runs;
}

export async function lookupCorrelatedRun({ config, expected, fetchImpl, now = Date.now, sleep }) {
  const deadline = now() + config.lookupTimeoutMs;
  const createdDate = new Date(expected.notBeforeMs).toISOString().slice(0, 10);
  let delayMs = config.initialPollMs;
  while (now() <= deadline) {
    const elected = electCorrelatedRun(await listCandidateRuns(config, fetchImpl, createdDate), expected);
    if (elected) return elected;
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(config.maxPollMs, delayMs * 2);
  }
  throw new ReleaseVerificationError('blocked', `No exact workflow run appeared for correlation ${expected.correlationId}`);
}

function isPendingRunTitle(error) {
  const mismatch = error instanceof ReleaseVerificationError ? error.details?.mismatch : null;
  return (
    error?.code === 'correlation_mismatch' &&
    Array.isArray(mismatch) &&
    mismatch.length === 1 &&
    mismatch[0] === 'action/ref/correlation/digest'
  );
}

export async function waitForExactRunIdentity({ config, runId, expected, fetchRun: getRun, now = Date.now, sleep }) {
  const deadline = now() + config.lookupTimeoutMs;
  let delayMs = config.initialPollMs;
  let titleError;
  while (now() <= deadline) {
    try {
      return validateRunIdentity(await getRun(runId), { ...expected, runId });
    } catch (error) {
      if (!isPendingRunTitle(error)) throw error;
      titleError = error;
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(config.maxPollMs, delayMs * 2);
  }
  throw titleError;
}

export async function waitForTerminalRun({ config, runId, expected, fetchRun: getRun, now = Date.now, sleep }) {
  const deadline = now() + config.verificationTimeoutMs;
  let delayMs = config.initialPollMs;
  while (now() <= deadline) {
    const run = validateRunIdentity(await getRun(runId), { ...expected, runId });
    const terminal = classifyTerminalRun(run);
    if (terminal.terminal) return { ...terminal, run };
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delayMs, remaining));
    delayMs = Math.min(config.maxPollMs, delayMs * 2);
  }
  throw new ReleaseVerificationError('verification_timeout', `Timed out waiting for exact workflow run ${runId}`);
}

function parseConfig(env) {
  const token = requireEnv(env, 'E2E_DISPATCH_TOKEN');
  const action = requireEnv(env, 'E2E_GATE_ACTION');
  const refName = requireEnv(env, 'E2E_GATE_REF');
  const sourceDigest = requireEnv(env, 'E2E_GATE_SOURCE_DIGEST').toLowerCase();
  const suite = (env.E2E_GATE_SUITE || 'full').trim();
  const mode = (env.E2E_GATE_MODE || 'enforce').trim();
  const e2eRepository = (env.E2E_REPOSITORY || DEFAULT_E2E_REPOSITORY).trim();
  const e2eWorkflow = (env.E2E_WORKFLOW || DEFAULT_E2E_WORKFLOW).trim();
  const workflowRef = (env.E2E_WORKFLOW_REF || DEFAULT_E2E_WORKFLOW_REF).trim();
  const repository = requireEnv(env, 'GITHUB_REPOSITORY');
  const runId = requireEnv(env, 'GITHUB_RUN_ID');
  const runAttempt = env.GITHUB_RUN_ATTEMPT?.trim() || '1';
  if (!SUPPORTED_SUITES.has(suite)) throw new ReleaseVerificationError('blocked', `Unsupported E2E suite ${suite}`);
  if (!['enforce', 'report-only'].includes(mode)) throw new ReleaseVerificationError('blocked', `Unsupported E2E_GATE_MODE ${mode}`);
  if (!/^[a-f0-9]{64}$/.test(sourceDigest)) throw new ReleaseVerificationError('blocked', 'E2E_GATE_SOURCE_DIGEST must be a lowercase SHA-256 digest');
  if (!/^[\w.-]+\/[\w.-]+$/.test(e2eRepository)) throw new ReleaseVerificationError('blocked', 'E2E_REPOSITORY must be owner/repository');
  const correlationId = buildCorrelationId({ repository, runId, runAttempt, refName, sourceDigest });
  return {
    token,
    action,
    refName,
    sourceDigest,
    suite,
    mode,
    e2eRepository,
    e2eWorkflow,
    workflowRef,
    repository,
    runId,
    runAttempt,
    correlationId,
    registryRevision: env.E2E_GATE_REGISTRY_REVISION?.trim() || '',
    contractScenarios: env.E2E_GATE_CONTRACT_SCENARIOS?.trim() || '',
    dispatchTimeoutMs: parsePositiveInteger(env.E2E_DISPATCH_TIMEOUT_MS, DEFAULT_DISPATCH_TIMEOUT_MS, 'E2E_DISPATCH_TIMEOUT_MS'),
    lookupTimeoutMs: parsePositiveInteger(env.E2E_LOOKUP_TIMEOUT_MS, DEFAULT_LOOKUP_TIMEOUT_MS, 'E2E_LOOKUP_TIMEOUT_MS'),
    verificationTimeoutMs: parsePositiveInteger(env.E2E_VERIFICATION_TIMEOUT_MS, DEFAULT_VERIFICATION_TIMEOUT_MS, 'E2E_VERIFICATION_TIMEOUT_MS'),
    initialPollMs: parsePositiveInteger(env.E2E_INITIAL_POLL_MS, DEFAULT_INITIAL_POLL_MS, 'E2E_INITIAL_POLL_MS'),
    maxPollMs: parsePositiveInteger(env.E2E_MAX_POLL_MS, DEFAULT_MAX_POLL_MS, 'E2E_MAX_POLL_MS')
  };
}

async function appendOutputs(outputPath, values) {
  if (!outputPath) return;
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value)}\n`)
    .join('');
  if (lines) await appendFile(outputPath, lines, 'utf8');
}

function sleepMs(ms) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

function errorResult(error, config) {
  const code = error instanceof ReleaseVerificationError ? error.code : 'blocked';
  return {
    outcome: code,
    correlationId: config?.correlationId ?? null,
    workflowRunId: error?.details?.runId ?? null,
    runUrl: null,
    message: error instanceof Error ? error.message : String(error)
  };
}

export async function runReleaseVerificationCli(env = process.env, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const log = dependencies.log ?? globalThis.console.log;
  const errorLog = dependencies.error ?? globalThis.console.error;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? sleepMs;
  let config;
  try {
    config = parseConfig(env);
    const expected = {
      workflow: config.e2eWorkflow,
      workflowRef: config.workflowRef,
      runTitle: expectedRunTitle(config),
      correlationId: config.correlationId,
      notBeforeMs: now() - 5_000
    };
    await assertCompositeCapability(config, fetchImpl);
    const dispatchDetails = await dispatchWorkflow(config, fetchImpl);
    let run;
    if (dispatchDetails?.workflowRunId) {
      run = await waitForExactRunIdentity({
        config,
        runId: dispatchDetails.workflowRunId,
        expected,
        fetchRun: (id) => fetchRun(config, fetchImpl, id),
        now,
        sleep
      });
    } else {
      run = await lookupCorrelatedRun({ config, expected, fetchImpl, now, sleep });
    }
    const workflowRunId = String(run.id);
    const runUrl = dispatchDetails?.runUrl ?? run.html_url ?? null;
    const terminal = await waitForTerminalRun({
      config,
      runId: workflowRunId,
      expected,
      fetchRun: (id) => fetchRun(config, fetchImpl, id),
      now,
      sleep
    });
    const result = {
      outcome: terminal.outcome,
      correlationId: config.correlationId,
      workflowRunId,
      runUrl: terminal.run.html_url ?? runUrl,
      message: `Verifier run ${workflowRunId} completed with ${terminal.run.conclusion}`
    };
    await appendOutputs(env.GITHUB_OUTPUT, {
      e2e_outcome: result.outcome,
      e2e_correlation_id: result.correlationId,
      e2e_workflow_run_id: result.workflowRunId,
      e2e_run_url: result.runUrl
    });
    if (shouldFailRelease(config.mode, result.outcome)) {
      errorLog(`::error::Correlated E2E verification failed (${result.outcome}): ${result.message}`);
      return { exitCode: 1, result };
    }
    if (config.mode === 'report-only' && result.outcome !== 'success') {
      log(`::warning::REPORT-ONLY: correlated E2E verification produced ${result.outcome}; rolling alias may advance by explicit operator choice`);
    } else {
      log(`Correlated E2E verification succeeded: ${result.runUrl ?? result.workflowRunId}`);
    }
    return { exitCode: 0, result };
  } catch (error) {
    const result = errorResult(error, config);
    const secrets = [config?.token, env.E2E_DISPATCH_TOKEN];
    result.message = redact(result.message, secrets);
    await appendOutputs(env.GITHUB_OUTPUT, {
      e2e_outcome: result.outcome,
      e2e_correlation_id: result.correlationId,
      e2e_workflow_run_id: result.workflowRunId,
      e2e_run_url: result.runUrl
    });
    if (config?.mode === 'report-only') {
      log(`::warning::REPORT-ONLY: correlated E2E verification produced ${result.outcome}: ${result.message}`);
      return { exitCode: 0, result };
    }
    errorLog(`::error::Correlated E2E verification failed (${result.outcome}): ${result.message}`);
    return { exitCode: 1, result };
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  if (process.argv.includes('--help')) {
    globalThis.console.log(
      'Usage: node scripts/verify-e2e-release.mjs\n' +
        'Requires E2E_DISPATCH_TOKEN, E2E_GATE_ACTION, E2E_GATE_REF, E2E_GATE_SOURCE_DIGEST, GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_RUN_ATTEMPT.'
    );
  } else {
    const { exitCode } = await runReleaseVerificationCli();
    process.exitCode = exitCode;
  }
}
