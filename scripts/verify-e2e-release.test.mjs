import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  ReleaseVerificationError,
  buildCorrelationId,
  buildDispatchInputs,
  buildDispatchPayload,
  buildReleaseEvidenceManifest,
  canonicalJsonStringify,
  classifyTerminalRun,
  electCorrelatedRun,
  parseDispatchRunDetails,
  parsePeerTags,
  parseSingleFileZip,
  resolveConfig,
  resolveImmutableTagCommit,
  runReleaseVerificationCli,
  validateReleaseEvidenceResult,
  validateRunIdentity,
  verifyCorrelatedRelease,
  waitForRunIdentity,
  waitForTerminalRun
} from './verify-e2e-release.mjs';

const RELEASE_SHA = 'a'.repeat(40);
const PROVIDER_SHA = 'b'.repeat(40);
const SOURCE_DIGEST = 'c'.repeat(64);
const PROVIDER_SOURCE_DIGEST = 'd'.repeat(64);
const PROVIDER_TAG = 'e2e-provider-v1.2.0';
const RELEASE_TAG = 'v9.9.9';
const PEER_TAGS = {
  'postman-cs/postman-repo-sync-action': 'v2.11.1',
  'postman-cs/postman-insights-onboarding-action': 'v2.5.2',
  'postman-cs/postman-bootstrap-action': 'v2.22.0',
  'postman-cs/postman-resolve-service-token-action': 'v2.2.4',
  'postman-cs/postman-smoke-flow-action': 'v3.7.5'
};
const PEER_TAGS_JSON = canonicalJsonStringify(PEER_TAGS).trimEnd();
const NOW = Date.parse('2026-08-29T04:00:00.000Z');

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
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

function storedZip(name, data, { unixMode = 0o100644 } = {}) {
  const filename = Buffer.from(name);
  const content = Buffer.from(data);
  const checksum = crc32(content);
  const local = Buffer.alloc(30 + filename.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30);
  content.copy(local, 30 + filename.length);

  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((unixMode << 16) >>> 0, 38);
  filename.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

function response(body, { status = 200 } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(bytes.length) },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

function jsonResponse(value, options) {
  return response(JSON.stringify(value), options);
}

function baseConfig() {
  return {
    token: 'test-token',
    repository: 'postman-cs/postman-api-onboarding-action',
    refName: RELEASE_TAG,
    sourceDigest: SOURCE_DIGEST,
    releaseCommit: RELEASE_SHA,
    action: 'postman-api-onboarding-action',
    targetRepository: 'postman-cs/postman-actions-e2e',
    workflow: 'e2e.yml',
    providerTag: PROVIDER_TAG,
    providerCommit: PROVIDER_SHA,
    providerSourceDigest: PROVIDER_SOURCE_DIGEST,
    peerTags: PEER_TAGS,
    suite: 'full',
    requestedCorrelationId: '',
    runId: '42',
    runAttempt: '1',
    dispatchTimeoutMs: 1000,
    lookupTimeoutMs: 1000,
    verificationTimeoutMs: 1000,
    initialPollMs: 1,
    maxPollMs: 2
  };
}

async function evidenceFixture() {
  return buildReleaseEvidenceManifest(baseConfig(), {
    resolveTagCommit: async ({ repository }) => {
      if (repository === 'postman-cs/postman-actions-e2e') return PROVIDER_SHA;
      if (repository === 'postman-cs/postman-api-onboarding-action') return RELEASE_SHA;
      return sha256(repository).slice(0, 40);
    },
    digestRepositoryFile: async ({ repository, file }) => sha256(`${repository}:${file}`)
  });
}

function terminalResult(evidence, overrides = {}) {
  return {
    manifestDigest: evidence.digest,
    outcome: 'success',
    provider: evidence.manifest.provider,
    release: evidence.manifest.release,
    run: { attempt: 1, id: '77' },
    schemaVersion: 1,
    suite: 'full',
    ...overrides
  };
}

const CORRELATION = 'postman-cs-postman-api-onboarding-action-42-1-v9.9.9-deadbeefdeadbeef';
const RUN_TITLE = `release monitor postman-api-onboarding-action@${RELEASE_TAG} ${CORRELATION}`;
const EXPECTED = {
  workflow: 'e2e.yml',
  providerTag: PROVIDER_TAG,
  providerCommit: PROVIDER_SHA,
  targetRepository: 'postman-cs/postman-actions-e2e',
  runTitle: RUN_TITLE,
  correlationId: CORRELATION,
  notBeforeMs: NOW,
  runAttempt: 1
};

function run(overrides = {}) {
  return {
    id: 77,
    event: 'workflow_dispatch',
    head_branch: PROVIDER_TAG,
    head_sha: PROVIDER_SHA,
    repository: { full_name: 'postman-cs/postman-actions-e2e' },
    display_title: RUN_TITLE,
    path: `.github/workflows/e2e.yml@refs/tags/${PROVIDER_TAG}`,
    run_attempt: 1,
    created_at: '2026-08-29T04:00:01.000Z',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.test/postman-cs/postman-actions-e2e/actions/runs/77',
    ...overrides
  };
}

test('peer map is an exact canonical five-repository immutable-tag census', () => {
  assert.deepEqual(parsePeerTags(PEER_TAGS_JSON), PEER_TAGS);
  assert.throws(
    () => parsePeerTags(JSON.stringify(Object.fromEntries(Object.entries(PEER_TAGS).reverse()))),
    /canonical key ordering/
  );
  assert.throws(
    () => parsePeerTags(canonicalJsonStringify({ ...PEER_TAGS, extra: 'v1.0.0' }).trimEnd()),
    /exact five-repository/
  );
  assert.throws(
    () =>
      parsePeerTags(
        canonicalJsonStringify({
          ...PEER_TAGS,
          'postman-cs/postman-smoke-flow-action': 'main'
        }).trimEnd()
      ),
    /non-immutable/
  );
});

test('closed manifest binds the provider, release artifact, and exact six-action closure', async () => {
  const resolved = [];
  const digested = [];
  const evidence = await buildReleaseEvidenceManifest(baseConfig(), {
    resolveTagCommit: async ({ repository, tag }) => {
      resolved.push([repository, tag]);
      if (repository === 'postman-cs/postman-actions-e2e') return PROVIDER_SHA;
      if (repository === 'postman-cs/postman-api-onboarding-action') return RELEASE_SHA;
      return sha256(repository).slice(0, 40);
    },
    digestRepositoryFile: async ({ repository, file }) => {
      digested.push([repository, file]);
      return sha256(`${repository}:${file}`);
    }
  });
  assert.equal(resolved.length, 7);
  assert.equal(digested.length, 6);
  assert.equal(Object.keys(evidence.manifest.actions).length, 6);
  assert.deepEqual(evidence.manifest.provider, {
    commit: PROVIDER_SHA,
    repository: 'postman-cs/postman-actions-e2e',
    tag: PROVIDER_TAG
  });
  assert.deepEqual(evidence.manifest.release, {
    artifactDigest: SOURCE_DIGEST,
    commit: RELEASE_SHA,
    kind: 'composite',
    repository: 'postman-cs/postman-api-onboarding-action',
    tag: RELEASE_TAG
  });
  assert.equal(
    evidence.manifest.actions['postman-cs/postman-api-onboarding-action'].role,
    'composite'
  );
  assert.equal(
    evidence.manifest.actions['postman-cs/postman-repo-sync-action'].role,
    'peer'
  );
  assert.deepEqual(
    Object.values(evidence.manifest.actions).map(({ role }) => role).sort(),
    ['composite', 'peer', 'peer', 'peer', 'peer', 'peer']
  );
  assert.equal(
    evidence.manifest.actions['postman-cs/postman-insights-onboarding-action'].digestKind,
    'action-definition-sha256'
  );
  assert.equal(
    evidence.manifest.actions['postman-cs/postman-api-onboarding-action'].digestKind,
    'action-definition-sha256'
  );
  assert.equal(evidence.bytes.toString(), canonicalJsonStringify(evidence.manifest));
  assert.equal(evidence.digest, sha256(evidence.bytes));
});

test('manifest construction fails when provider or release tags do not resolve to pinned commits', async () => {
  const common = {
    digestRepositoryFile: async () => 'd'.repeat(64)
  };
  await assert.rejects(
    () =>
      buildReleaseEvidenceManifest(baseConfig(), {
        ...common,
        resolveTagCommit: async ({ repository }) =>
          repository === 'postman-cs/postman-actions-e2e' ? 'f'.repeat(40) : RELEASE_SHA
      }),
    /provider tag does not resolve/
  );
  await assert.rejects(
    () =>
      buildReleaseEvidenceManifest(baseConfig(), {
        ...common,
        resolveTagCommit: async ({ repository }) =>
          repository === 'postman-cs/postman-actions-e2e' ? PROVIDER_SHA : 'f'.repeat(40)
      }),
    /release tag does not resolve/
  );
});

test('annotated provider tags are peeled to their exact commit', async () => {
  const tagObject = 'e'.repeat(40);
  const seen = [];
  const commit = await resolveImmutableTagCommit({
    repository: 'postman-cs/postman-actions-e2e',
    tag: PROVIDER_TAG,
    providerSourceDigest: PROVIDER_SOURCE_DIGEST,
    token: 'test-token',
    signal: globalThis.AbortSignal.timeout(1000),
    fetchImpl: async (url) => {
      seen.push(url);
      if (url.endsWith(`/git/ref/tags/${PROVIDER_TAG}`)) {
        return jsonResponse({
          ref: `refs/tags/${PROVIDER_TAG}`,
          object: { type: 'tag', sha: tagObject }
        });
      }
      return jsonResponse({
        tag: PROVIDER_TAG,
        message: `E2E provider ${PROVIDER_TAG}\n\ne2e-provider-source-manifest-sha256:${PROVIDER_SOURCE_DIGEST}`,
        object: { type: 'commit', sha: PROVIDER_SHA }
      });
    }
  });
  assert.equal(commit, PROVIDER_SHA);
  assert.equal(seen.length, 2);
});

test('dispatch sends only the closed manifest protocol at the immutable provider tag', async () => {
  const evidence = await evidenceFixture();
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-api-onboarding-action',
    runId: '42',
    runAttempt: '1',
    refName: RELEASE_TAG,
    manifestDigest: evidence.digest
  });
  const inputs = buildDispatchInputs({
    action: 'postman-api-onboarding-action',
    refName: RELEASE_TAG,
    correlationId,
    suite: 'full',
    manifestBytes: evidence.bytes,
    manifestDigest: evidence.digest
  });
  assert.deepEqual(Object.keys(inputs).sort(), [
    'action',
    'gate_correlation_id',
    'ref',
    'release_manifest_base64',
    'release_manifest_sha256',
    'suite'
  ]);
  assert.deepEqual(
    buildDispatchPayload({
      providerTag: PROVIDER_TAG,
      action: 'postman-api-onboarding-action',
      refName: RELEASE_TAG,
      correlationId,
      suite: 'full',
      manifestBytes: evidence.bytes,
      manifestDigest: evidence.digest
    }),
    { ref: PROVIDER_TAG, return_run_details: true, inputs }
  );
  assert.equal(Buffer.from(inputs.release_manifest_base64, 'base64').toString(), evidence.bytes.toString());
});

test('dispatch response parsing captures an exact run id and supports the 204 fallback', () => {
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

test('run correlation binds provider tag, commit, repository, attempt, title, and workflow', () => {
  assert.equal(validateRunIdentity(run(), { ...EXPECTED, runId: '77' }).id, 77);
  for (const mismatch of [
    run({ head_branch: 'main' }),
    run({ head_sha: 'e'.repeat(40) }),
    run({ repository: { full_name: 'postman-cs/other' } }),
    run({ run_attempt: 2 }),
    run({ display_title: RUN_TITLE.replace(RELEASE_TAG, 'v9.9.8') }),
    run({ path: '.github/workflows/other.yml' }),
    run({ id: 88 })
  ]) {
    assert.throws(
      () => validateRunIdentity(mismatch, { ...EXPECTED, runId: '77' }),
      (error) => error instanceof ReleaseVerificationError && error.code === 'correlation_mismatch'
    );
  }
  assert.equal(electCorrelatedRun([run()], EXPECTED)?.id, 77);
  assert.equal(electCorrelatedRun([run({ head_sha: 'e'.repeat(40) })], EXPECTED), null);
  assert.throws(() => electCorrelatedRun([run(), run({ id: 78 })], EXPECTED), /multiple downstream/);
});

test('run-name hydration is bounded while terminal polling preserves exact identity', async () => {
  let clock = NOW;
  let reads = 0;
  const hydrated = await waitForRunIdentity({
    config: { lookupTimeoutMs: 20, initialPollMs: 4, maxPollMs: 4 },
    runId: '77',
    expected: EXPECTED,
    fetchRun: async () => {
      reads += 1;
      return run({ display_title: reads === 1 ? 'e2e (live sandbox)' : RUN_TITLE });
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms || 1;
    }
  });
  assert.equal(hydrated.id, 77);
  assert.equal(reads, 2);

  clock = NOW;
  await assert.rejects(
    () =>
      waitForTerminalRun({
        config: { verificationTimeoutMs: 10, initialPollMs: 4, maxPollMs: 4 },
        runId: '77',
        expected: EXPECTED,
        fetchRun: async () => run({ status: 'in_progress', conclusion: null }),
        now: () => clock,
        sleep: async (ms) => {
          clock += ms || 1;
        }
      }),
    (error) => error instanceof ReleaseVerificationError && error.code === 'verification_timeout'
  );
});

test('terminal conclusions distinguish all release decisions', () => {
  assert.deepEqual(classifyTerminalRun(run({ status: 'in_progress', conclusion: null })), {
    terminal: false
  });
  for (const outcome of ['success', 'failure', 'cancelled', 'timed_out']) {
    assert.deepEqual(classifyTerminalRun(run({ conclusion: outcome })), {
      terminal: true,
      outcome
    });
  }
  assert.deepEqual(classifyTerminalRun(run({ conclusion: 'skipped' })), {
    terminal: true,
    outcome: 'blocked'
  });
});

test('terminal artifact ZIP requires one exact regular bounded entry with valid CRC', () => {
  const content = Buffer.from('proof\n');
  const archive = storedZip('e2e-release-result.json', content);
  assert.deepEqual(parseSingleFileZip(archive, 'e2e-release-result.json'), content);
  assert.throws(() => parseSingleFileZip(archive, 'other.json'), /entry metadata is invalid/);
  const corrupt = Buffer.from(archive);
  corrupt[55] ^= 1;
  assert.throws(() => parseSingleFileZip(corrupt, 'e2e-release-result.json'), /checksum/);
  for (const unixMode of [0o040755, 0o060600, 0o120777]) {
    assert.throws(
      () =>
        parseSingleFileZip(
          storedZip('e2e-release-result.json', content, { unixMode }),
          'e2e-release-result.json'
        ),
      /entry metadata is invalid/
    );
  }
});

test('terminal result is canonical and exactly binds manifest, provider, release artifact, and run', async () => {
  const evidence = await evidenceFixture();
  const result = terminalResult(evidence);
  const bytes = Buffer.from(canonicalJsonStringify(result));
  assert.deepEqual(
    validateReleaseEvidenceResult(bytes, {
      manifest: evidence.manifest,
      manifestDigest: evidence.digest,
      runId: '77',
      runAttempt: 1
    }),
    result
  );
  for (const mismatch of [
    { outcome: 'failure' },
    { manifestDigest: 'f'.repeat(64) },
    { provider: { ...result.provider, commit: 'f'.repeat(40) } },
    { release: { ...result.release, artifactDigest: 'f'.repeat(64) } },
    { run: { attempt: 2, id: '77' } }
  ]) {
    assert.throws(
      () =>
        validateReleaseEvidenceResult(
          Buffer.from(canonicalJsonStringify({ ...result, ...mismatch })),
          {
            manifest: evidence.manifest,
            manifestDigest: evidence.digest,
            runId: '77',
            runAttempt: 1
          }
        ),
      /does not match/
    );
  }
  assert.throws(
    () =>
      validateReleaseEvidenceResult(Buffer.from(JSON.stringify(result)), {
        manifest: evidence.manifest,
        manifestDigest: evidence.digest,
        runId: '77',
        runAttempt: 1
      }),
    /canonical JSON/
  );
});

test('complete verifier requires the exact terminal artifact after a successful run', async () => {
  const evidence = await evidenceFixture();
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-api-onboarding-action',
    runId: '42',
    runAttempt: '1',
    refName: RELEASE_TAG,
    manifestDigest: evidence.digest
  });
  const title = `release monitor postman-api-onboarding-action@${RELEASE_TAG} ${correlationId}`;
  const exactRun = run({ display_title: title });
  const resultBytes = Buffer.from(canonicalJsonStringify(terminalResult(evidence)));
  const archive = storedZip('e2e-release-result.json', resultBytes);
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === 'POST') {
      const payload = JSON.parse(options.body);
      assert.equal(payload.ref, PROVIDER_TAG);
      assert.equal(payload.inputs.release_manifest_sha256, evidence.digest);
      assert.equal(
        Buffer.from(payload.inputs.release_manifest_base64, 'base64').toString(),
        evidence.bytes.toString()
      );
      return jsonResponse({ workflow_run_id: 77 });
    }
    if (url.includes('/actions/runs/77/artifacts?')) {
      return jsonResponse({
        total_count: 1,
        artifacts: [
          {
            id: 91,
            name: 'e2e-release-result-77-1',
            expired: false,
            size_in_bytes: archive.length,
            workflow_run: {
              id: 77,
              head_branch: PROVIDER_TAG,
              head_sha: PROVIDER_SHA
            }
          }
        ]
      });
    }
    if (url.endsWith('/actions/artifacts/91/zip')) return response(archive);
    if (url.endsWith('/actions/runs/77')) return jsonResponse(exactRun);
    throw new Error(`unexpected request: ${url}`);
  };
  const result = await verifyCorrelatedRelease(baseConfig(), {
    buildEvidence: async () => evidence,
    fetchImpl,
    now: () => NOW,
    sleep: async () => {},
    log() {}
  });
  assert.equal(result.outcome, 'success');
  assert.equal(result.manifestDigest, evidence.digest);
  assert.ok(requests.some(({ url }) => url.endsWith('/actions/artifacts/91/zip')));
});

test('terminal artifact lookup rejects an incomplete artifact census', async () => {
  const evidence = await evidenceFixture();
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-api-onboarding-action',
    runId: '42',
    runAttempt: '1',
    refName: RELEASE_TAG,
    manifestDigest: evidence.digest
  });
  const exactRun = run({
    display_title: `release monitor postman-api-onboarding-action@${RELEASE_TAG} ${correlationId}`
  });
  const archive = storedZip(
    'e2e-release-result.json',
    Buffer.from(canonicalJsonStringify(terminalResult(evidence)))
  );
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') return jsonResponse({ workflow_run_id: 77 });
    if (url.endsWith('/actions/runs/77')) return jsonResponse(exactRun);
    if (url.includes('/actions/runs/77/artifacts?')) {
      return jsonResponse({
        total_count: 2,
        artifacts: [
          {
            id: 91,
            name: 'e2e-release-result-77-1',
            expired: false,
            size_in_bytes: archive.length,
            workflow_run: { id: 77, head_branch: PROVIDER_TAG, head_sha: PROVIDER_SHA }
          }
        ]
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.rejects(
    () =>
      verifyCorrelatedRelease(baseConfig(), {
        buildEvidence: async () => evidence,
        fetchImpl,
        now: () => NOW,
        sleep: async () => {},
        log() {}
      }),
    /artifact response was incomplete or invalid/
  );
});

test('successful workflow conclusion without an exact terminal artifact fails closed', async () => {
  const evidence = await evidenceFixture();
  const correlationId = buildCorrelationId({
    repository: 'postman-cs/postman-api-onboarding-action',
    runId: '42',
    runAttempt: '1',
    refName: RELEASE_TAG,
    manifestDigest: evidence.digest
  });
  const exactRun = run({
    display_title: `release monitor postman-api-onboarding-action@${RELEASE_TAG} ${correlationId}`
  });
  let clock = NOW;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') return jsonResponse({ workflow_run_id: 77 });
    if (url.includes('/actions/runs/77/artifacts?')) {
      clock += 1001;
      return jsonResponse({ total_count: 0, artifacts: [] });
    }
    if (url.endsWith('/actions/runs/77')) return jsonResponse(exactRun);
    throw new Error(`unexpected request: ${url}`);
  };
  await assert.rejects(
    () =>
      verifyCorrelatedRelease(baseConfig(), {
        buildEvidence: async () => evidence,
        fetchImpl,
        now: () => clock,
        sleep: async () => {},
        log() {}
      }),
    /exact terminal result artifact/
  );
});

test('release configuration has no report-only or mutable-provider escape hatch', () => {
  const env = {
    E2E_DISPATCH_TOKEN: 'test-token',
    E2E_GATE_ACTION: 'postman-api-onboarding-action',
    E2E_GATE_REF: RELEASE_TAG,
    E2E_GATE_RELEASE_COMMIT: RELEASE_SHA,
    E2E_GATE_SOURCE_DIGEST: SOURCE_DIGEST,
    E2E_GATE_PROVIDER_TAG: PROVIDER_TAG,
    E2E_GATE_PROVIDER_COMMIT: PROVIDER_SHA,
    E2E_GATE_PROVIDER_SOURCE_DIGEST: PROVIDER_SOURCE_DIGEST,
    E2E_GATE_PEER_TAGS: PEER_TAGS_JSON,
    E2E_GATE_SUITE: 'full',
    GITHUB_REPOSITORY: 'postman-cs/postman-api-onboarding-action',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1'
  };
  assert.equal(resolveConfig(env).providerTag, PROVIDER_TAG);
  assert.throws(() => resolveConfig({ ...env, E2E_GATE_MODE: 'report-only' }), /fail-closed/);
  assert.throws(() => resolveConfig({ ...env, E2E_GATE_PROVIDER_TAG: 'main' }), /identity inputs/);
  assert.throws(() => resolveConfig({ ...env, E2E_GATE_SUITE: 'smoke' }), /identity inputs/);
  assert.throws(
    () =>
      resolveConfig({
        ...env,
        E2E_GATE_REPOSITORY: 'postman-cs/postman-actions-e2e'
      }),
    /do not accept environment overrides/
  );
  assert.throws(
    () => resolveConfig({ ...env, E2E_GATE_WORKFLOW: 'e2e.yml' }),
    /do not accept environment overrides/
  );
});

test('CLI redacts dispatch credentials and always fails a dispatch auth error', async () => {
  const env = {
    E2E_DISPATCH_TOKEN: 'test-token',
    E2E_GATE_ACTION: 'postman-api-onboarding-action',
    E2E_GATE_REF: RELEASE_TAG,
    E2E_GATE_RELEASE_COMMIT: RELEASE_SHA,
    E2E_GATE_SOURCE_DIGEST: SOURCE_DIGEST,
    E2E_GATE_PROVIDER_TAG: PROVIDER_TAG,
    E2E_GATE_PROVIDER_COMMIT: PROVIDER_SHA,
    E2E_GATE_PROVIDER_SOURCE_DIGEST: PROVIDER_SOURCE_DIGEST,
    E2E_GATE_PEER_TAGS: PEER_TAGS_JSON,
    E2E_GATE_SUITE: 'full',
    GITHUB_REPOSITORY: 'postman-cs/postman-api-onboarding-action',
    GITHUB_RUN_ID: '42',
    GITHUB_RUN_ATTEMPT: '1'
  };
  const errors = [];
  const execution = await runReleaseVerificationCli(env, {
    buildEvidence: evidenceFixture,
    fetchImpl: async () => response('denied test-token', { status: 403 }),
    log() {},
    error: (line) => errors.push(line)
  });
  assert.equal(execution.exitCode, 1);
  assert.equal(execution.result.outcome, 'dispatch_auth_error');
  assert.ok(errors.every((line) => !line.includes('test-token')));
  assert.ok(errors.some((line) => line.includes('[REDACTED]')));
});
