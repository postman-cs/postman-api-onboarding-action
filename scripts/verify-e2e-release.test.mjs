import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  ReleaseVerificationError,
  assertCompositeUsesCapability,
  buildCorrelationId,
  buildDispatchInputs,
  buildDispatchPayload,
  classifyTerminalRun,
  electCorrelatedRun,
  parseDispatchRunDetails,
  runReleaseVerificationCli,
  shouldFailRelease,
  validateRunIdentity,
  waitForExactRunIdentity,
  waitForTerminalRun
} from './verify-e2e-release.mjs';

const DIGEST = 'a'.repeat(64);
const CORRELATION = 'postman-api-onboarding-action-42-1-v3.2.1-aaaaaaaaaaaaaaaa';
const RUN_TITLE = `release monitor postman-api-onboarding-action@v3.2.1 ${CORRELATION}`;
const EXPECTED = {
  workflow: 'e2e.yml',
  workflowRef: 'main',
  runTitle: RUN_TITLE,
  correlationId: CORRELATION,
  notBeforeMs: Date.parse('2026-08-03T12:00:00.000Z')
};

function run(overrides = {}) {
  return {
    id: 77,
    event: 'workflow_dispatch',
    head_branch: 'main',
    display_title: RUN_TITLE,
    path: '.github/workflows/e2e.yml@refs/heads/main',
    created_at: '2026-08-03T12:00:01.000Z',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.test/postman-cs/postman-actions-e2e/actions/runs/77',
    ...overrides
  };
}

test('dispatch response parsing captures the exact workflow run and supports fallback', () => {
  assert.deepEqual(
    parseDispatchRunDetails(
      200,
      JSON.stringify({
        workflow_run_id: 77,
        run_url: 'https://api.github.test/runs/77',
        html_url: 'https://github.test/runs/77'
      })
    ),
    {
      workflowRunId: '77',
      runApiUrl: 'https://api.github.test/runs/77',
      runUrl: 'https://github.test/runs/77'
    }
  );
  assert.equal(parseDispatchRunDetails(204, ''), null);
  assert.throws(
    () => parseDispatchRunDetails(200, JSON.stringify({ run_url: 'https://api.github.test/runs/77' })),
    (error) => error instanceof ReleaseVerificationError && error.code === 'dispatch_error'
  );
});

test('dispatch pins exact action/ref/correlation/suite and registry scenario metadata', () => {
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-api-onboarding-action',
    runId: '42',
    runAttempt: '1',
    refName: 'v3.2.1',
    sourceDigest: DIGEST
  });
  assert.equal(correlationId, CORRELATION);
  const inputs = buildDispatchInputs({
    action: 'postman-api-onboarding-action',
    refName: 'v3.2.1',
    correlationId,
    suite: 'full',
    registryRevision: 'b'.repeat(64),
    contractScenarios: '["composite.real-uses-all-protocols"]'
  });
  assert.deepEqual(inputs, {
    action: 'postman-api-onboarding-action',
    ref: 'v3.2.1',
    gate_correlation_id: correlationId,
    suite: 'full',
    registry_revision: 'b'.repeat(64),
    contract_scenarios: '["composite.real-uses-all-protocols"]'
  });
  assert.deepEqual(
    buildDispatchPayload({
      workflowRef: 'main',
      action: 'postman-api-onboarding-action',
      refName: 'v3.2.1',
      correlationId,
      suite: 'full'
    }),
    {
      ref: 'main',
      return_run_details: true,
      inputs: {
        action: 'postman-api-onboarding-action',
        ref: 'v3.2.1',
        gate_correlation_id: correlationId,
        suite: 'full'
      }
    }
  );
});

test('fallback elects one exact correlated run and refuses ambiguity or unrelated runs', () => {
  const unrelated = [
    run({ id: 1, display_title: `release monitor postman-api-onboarding-action@v3.2.0 ${CORRELATION}` }),
    run({ id: 2, event: 'schedule' }),
    run({ id: 3, head_branch: 'other' }),
    run({ id: 4, created_at: '2026-08-03T11:59:00.000Z' })
  ];
  assert.equal(electCorrelatedRun([...unrelated, run()], EXPECTED)?.id, 77);
  assert.equal(electCorrelatedRun(unrelated, EXPECTED), null);
  assert.throws(
    () => electCorrelatedRun([run({ id: 77 }), run({ id: 78 })], EXPECTED),
    (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
  );
});

test('run identity rejects ref, action, correlation, digest, and run-id mismatches', () => {
  assert.equal(validateRunIdentity(run(), { ...EXPECTED, runId: '77' }).id, 77);
  for (const mismatch of [
    run({ head_branch: 'release' }),
    run({ display_title: RUN_TITLE.replace('v3.2.1', 'v3.2.0') }),
    run({ display_title: RUN_TITLE.replace('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb') }),
    run({ path: undefined }),
    run({ id: 88 })
  ]) {
    assert.throws(
      () => validateRunIdentity(mismatch, { ...EXPECTED, runId: '77' }),
      (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
    );
  }
});

test('exact dispatch waits for run-name propagation but rejects stable identity mismatches', async () => {
  let clock = 0;
  let calls = 0;
  const exact = await waitForExactRunIdentity({
    config: { lookupTimeoutMs: 10, initialPollMs: 2, maxPollMs: 4 },
    runId: '77',
    expected: EXPECTED,
    fetchRun: async () => {
      calls += 1;
      return calls === 1
        ? run({ display_title: 'e2e (live sandbox)', status: 'queued', conclusion: null })
        : run({ status: 'queued', conclusion: null });
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    }
  });
  assert.equal(exact.id, 77);
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    () =>
      waitForExactRunIdentity({
        config: { lookupTimeoutMs: 10, initialPollMs: 2, maxPollMs: 4 },
        runId: '77',
        expected: EXPECTED,
        fetchRun: async () => {
          calls += 1;
          return run({ head_branch: 'release' });
        },
        now: () => 0,
        sleep: async () => {}
      }),
    (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
  );
  assert.equal(calls, 1);
});

test('exact dispatch bounds run-name propagation waits', async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForExactRunIdentity({
        config: { lookupTimeoutMs: 5, initialPollMs: 2, maxPollMs: 2 },
        runId: '77',
        expected: EXPECTED,
        fetchRun: async () => run({ display_title: 'e2e (live sandbox)' }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
        }
      }),
    (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
  );
});

test('terminal conclusions distinguish success, failure, cancelled, timed out, and blocked', () => {
  assert.deepEqual(classifyTerminalRun(run({ status: 'in_progress', conclusion: null })), { terminal: false });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'success' })), { terminal: true, outcome: 'success' });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'failure' })), { terminal: true, outcome: 'failure' });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'cancelled' })), { terminal: true, outcome: 'cancelled' });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'timed_out' })), { terminal: true, outcome: 'timed_out' });
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'skipped' })), { terminal: true, outcome: 'blocked' });
  assert.throws(
    () => classifyTerminalRun(run({ status: 'mystery', conclusion: null })),
    (error) => error instanceof ReleaseVerificationError && error.code === 'blocked'
  );
});

test('exact-run polling is bounded and reports verification_timeout', async () => {
  let clock = 0;
  await assert.rejects(
    () =>
      waitForTerminalRun({
        config: { verificationTimeoutMs: 10, initialPollMs: 4, maxPollMs: 4 },
        runId: '77',
        expected: { ...EXPECTED, notBeforeMs: 0 },
        fetchRun: async () =>
          run({
            created_at: '1970-01-01T00:00:00.001Z',
            status: 'in_progress',
            conclusion: null
          }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms || 1;
        }
      }),
    (error) => error instanceof ReleaseVerificationError && error.code === 'verification_timeout'
  );
});

test('real released composite uses capability is mandatory and report-only is explicit', () => {
  assert.throws(
    () => assertCompositeUsesCapability('name: e2e\n'),
    (error) =>
      error instanceof ReleaseVerificationError &&
      error.code === 'blocked' &&
      /E2E_COMPOSITE_USES_UNAVAILABLE/.test(error.message)
  );
  assert.doesNotThrow(() =>
    assertCompositeUsesCapability(`
if: inputs.action == 'postman-api-onboarding-action'
repository: postman-cs/postman-api-onboarding-action
ref: \${{ inputs.action == 'postman-api-onboarding-action' && inputs.ref }}
uses: ./postman-api-onboarding-action
postman-team-id: '10490519'
repo-write-mode: none
echo "::error::POSTMAN_E2E_API_KEY_NON_ORG_MODE is required for composite smoke."
needs: [failure-injection, plan, monitor, composite-smoke]
`)
  );
  assert.equal(shouldFailRelease(undefined, 'failure'), true);
  assert.equal(shouldFailRelease('enforce', 'blocked'), true);
  assert.equal(shouldFailRelease('enforce', 'success'), false);
  assert.equal(shouldFailRelease('report-only', 'failure'), false);
});

test('CLI distinguishes dispatch auth errors and report-only is the only green override', async () => {
  const env = {
    E2E_DISPATCH_TOKEN: 'test-token',
    E2E_GATE_ACTION: 'postman-api-onboarding-action',
    E2E_GATE_REF: 'v3.2.1',
    E2E_GATE_SOURCE_DIGEST: DIGEST,
    E2E_GATE_SUITE: 'full',
    GITHUB_REPOSITORY: 'postman-cs/postman-api-onboarding-action',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1'
  };
  const workflow = Buffer.from(`
if: inputs.action == 'postman-api-onboarding-action'
repository: postman-cs/postman-api-onboarding-action
ref: \${{ inputs.action == 'postman-api-onboarding-action' && inputs.ref }}
uses: ./postman-api-onboarding-action
postman-team-id: '10490519'
repo-write-mode: none
echo "::error::POSTMAN_E2E_API_KEY_NON_ORG_MODE is required for composite smoke."
needs: [failure-injection, plan, monitor, composite-smoke]
`).toString('base64');
  const makeFetch = () => {
    let call = 0;
    return async () => {
      call += 1;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ encoding: 'base64', content: workflow }) };
      }
      return { ok: false, status: 403, text: async () => 'denied test-token' };
    };
  };
  const enforced = await runReleaseVerificationCli(env, { fetchImpl: makeFetch(), log() {}, error() {} });
  assert.equal(enforced.exitCode, 1);
  assert.equal(enforced.result.outcome, 'dispatch_auth_error');

  const warnings = [];
  const reportOnly = await runReleaseVerificationCli(
    { ...env, E2E_GATE_MODE: 'report-only' },
    { fetchImpl: makeFetch(), log: (line) => warnings.push(line), error() {} }
  );
  assert.equal(reportOnly.exitCode, 0);
  assert.equal(reportOnly.result.outcome, 'dispatch_auth_error');
  assert.ok(warnings.some((line) => line.includes('REPORT-ONLY')));
  assert.ok(warnings.every((line) => !line.includes('test-token')));
});

test('CLI fails closed with the named blocker before dispatch when real composite uses is absent', async () => {
  let calls = 0;
  const result = await runReleaseVerificationCli(
    {
      E2E_DISPATCH_TOKEN: 'test-token',
      E2E_GATE_ACTION: 'postman-api-onboarding-action',
      E2E_GATE_REF: 'v3.2.1',
      E2E_GATE_SOURCE_DIGEST: DIGEST,
      GITHUB_REPOSITORY: 'postman-cs/postman-api-onboarding-action',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1'
    },
    {
      fetchImpl: async () => {
        calls += 1;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              encoding: 'base64',
              content: Buffer.from('name: e2e\n').toString('base64')
            })
        };
      },
      log() {},
      error() {}
    }
  );
  assert.equal(result.exitCode, 1);
  assert.equal(result.result.outcome, 'blocked');
  assert.match(result.result.message, /E2E_COMPOSITE_USES_UNAVAILABLE/);
  assert.equal(calls, 1);
});
